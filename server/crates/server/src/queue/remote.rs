//! Remote workers: read grants for `inputUrl` and the chunked, resumable upload of an output.
use super::{WorkerAuth, store};
use crate::{config::random_hex, http::AppError, state::AppState, sync::MutexExt};
use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use fliks_engine_core::api::{
    HEADER_ATTEMPT, HEADER_UPLOAD_COMPLETE, HEADER_UPLOAD_OFFSET, HEADER_WORKER_ID, JobError,
    JobErrorClass, ResolveMediaId, ResolvePurpose, ResolveRequest, ResolveResponse, UploadAck,
};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use tokio::{fs::OpenOptions, io::AsyncWriteExt, sync::Mutex};

const GRANT_PREFIX: &str = "fkj_";
/// What the engine may cache of an answer, bounded by the lease.
const MAX_TTL_S: f64 = 60.0;

/// The read right of one lease on one file; it ends with the lease.
#[derive(Clone)]
pub struct Grant {
    pub job: i64,
    pub attempt: i32,
    pub file: i32,
}

/// Bytes received for one attempt, hashed as they arrive.
pub struct Upload {
    len: u64,
    hasher: Sha256,
    /// Whether a file left by an earlier process was folded in (once, at first use).
    loaded: bool,
}

impl Upload {
    async fn load(&mut self, path: &Path) {
        if !self.loaded {
            self.loaded = true;
            if let Ok((len, hasher)) = hash_file(path).await {
                (self.len, self.hasher) = (len, hasher);
            }
        }
    }
}

impl super::Shared {
    pub fn mint(&self, job: i64, attempt: i32, file: i32) -> String {
        let token = format!("{GRANT_PREFIX}{}", random_hex(24));
        self.grants
            .lock_clean()
            .insert(token.clone(), Grant { job, attempt, file });
        token
    }

    fn grant(&self, token: &str) -> Option<Grant> {
        self.grants.lock_clean().get(token).cloned()
    }

    fn upload(&self, job: i64, attempt: i32) -> Arc<Mutex<Upload>> {
        let mut g = self.uploads.lock_clean();
        if let Some((a, u)) = g.get(&job)
            && *a == attempt
        {
            return u.clone();
        }
        let fresh = Arc::new(Mutex::new(Upload {
            len: 0,
            hasher: Sha256::new(),
            loaded: false,
        }));
        g.insert(job, (attempt, fresh.clone()));
        fresh
    }
}

/// The resolver's answer for a job grant; `None` when the credential is not one.
pub async fn grant_answer(
    st: &AppState,
    req: &ResolveRequest,
) -> Result<Option<ResolveResponse>, AppError> {
    let Some(token) = crate::engine::resolve::credential_token(&req.credential)
        .filter(|t| t.starts_with(GRANT_PREFIX))
    else {
        return Ok(None);
    };
    let deny = ResolveResponse {
        allow: false,
        path: None,
        owner_id: None,
        format: None,
        ttl_s: Some(MAX_TTL_S),
        parts: vec![],
    };
    let Some(g) = st.queue.grant(&token) else {
        return Ok(Some(deny));
    };
    if req.purpose != ResolvePurpose::Download
        || req.media_id != ResolveMediaId::File(g.file as u32)
    {
        return Ok(Some(deny));
    }
    let remaining: Option<f64> = sqlx::query_scalar(
        r#"SELECT extract(epoch FROM "leaseUntil" - now())::float8 FROM jobs
           WHERE id = $1 AND attempt = $2 AND state = 'leased'"#,
    )
    .bind(g.job)
    .bind(g.attempt)
    .fetch_optional(&st.db)
    .await?
    .flatten();
    let Some(remaining) = remaining.filter(|r| *r > 0.0) else {
        return Ok(Some(deny));
    };
    let Some(path) = crate::engine::resolve::library_path(st, g.file).await? else {
        return Ok(Some(deny));
    };
    Ok(Some(ResolveResponse {
        allow: true,
        path: Some(path.to_string_lossy().into_owned()),
        owner_id: Some("worker".into()),
        ttl_s: Some(remaining.min(MAX_TTL_S)),
        ..deny
    }))
}

/// Ends the grants and upload state of leases that are over, and tells the engine to forget them.
pub async fn sweep(st: &AppState) {
    let grants: Vec<(String, Grant)> = st
        .queue
        .grants
        .lock_clean()
        .iter()
        .map(|(t, g)| (t.clone(), g.clone()))
        .collect();
    for (token, g) in grants {
        if leased(st, g.job, g.attempt).await != Some(true) {
            st.queue.grants.lock_clean().remove(&token);
            st.engine.revoke_credential(&token).await;
        }
    }
    let held: Vec<(i64, i32)> = st
        .queue
        .uploads
        .lock_clean()
        .iter()
        .map(|(id, (a, _))| (*id, *a))
        .collect();
    for (id, attempt) in held {
        if leased(st, id, attempt).await == Some(false) {
            st.queue.uploads.lock_clean().remove(&id);
        }
    }
}

/// `None` on a database error: nothing is dropped on a doubt.
async fn leased(st: &AppState, job: i64, attempt: i32) -> Option<bool> {
    sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM jobs WHERE id = $1 AND attempt = $2 AND state = 'leased')"#,
    )
    .bind(job)
    .bind(attempt)
    .fetch_one(&st.db)
    .await
    .ok()
}

fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name)?.to_str().ok()
}

fn bad(m: &str) -> AppError {
    AppError::bad_request(m)
}

async fn hash_file(path: &Path) -> std::io::Result<(u64, Sha256)> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path).await?;
    let (mut len, mut hasher) = (0u64, Sha256::new());
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            return Ok((len, hasher));
        }
        hasher.update(&buf[..n]);
        len += n as u64;
    }
}

fn ack(len: u64) -> Json<UploadAck> {
    Json(UploadAck {
        received_bytes: len as f64,
    })
}

/// `PUT /engine/jobs/{id}/output`: one chunk at `Upload-Offset`, which must equal the length held.
#[utoipa::path(put, path = "/engine/jobs/{id}/output", responses((status = 200), (status = 409)))]
pub async fn put_output(
    State(st): State<AppState>,
    WorkerAuth(who): WorkerAuth,
    crate::http::validate::PathParams(id): crate::http::validate::PathParams<i64>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let parse = |name: &str| header(&headers, name).and_then(|v| v.parse::<u64>().ok());
    let offset = parse(HEADER_UPLOAD_OFFSET).ok_or_else(|| bad("Upload-Offset is required"))?;
    let attempt = parse(HEADER_ATTEMPT).ok_or_else(|| bad("X-Fliks-Attempt is required"))? as i32;
    let worker =
        header(&headers, HEADER_WORKER_ID).ok_or_else(|| bad("X-Fliks-Worker-Id is required"))?;
    let complete = header(&headers, HEADER_UPLOAD_COMPLETE) == Some("?1");
    let conflict = || AppError::bare(StatusCode::CONFLICT);
    let key = who.owner_key(worker);
    let staged: Option<String> = sqlx::query_scalar(
        r#"SELECT "stagedPath" FROM jobs WHERE id = $1 AND "workerId" = $2 AND attempt = $3
             AND state = 'leased' AND kind = 'optimize'"#,
    )
    .bind(id)
    .bind(&key)
    .bind(attempt)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(conflict)?;
    let staged = staged.ok_or_else(|| AppError::internal("remote job without a staging path"))?;
    let path = Path::new(&staged);
    let slot = st.queue.upload(id, attempt);
    let mut up = slot.lock().await;
    up.load(path).await;
    if offset != up.len {
        return Ok((StatusCode::CONFLICT, ack(up.len)).into_response());
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|e| AppError::internal(format!("{}: {e}", path.display())))?;
    f.write_all(&body)
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    if complete {
        f.sync_all()
            .await
            .map_err(|e| AppError::internal(e.to_string()))?;
    }
    up.hasher.update(&body);
    up.len += body.len() as u64;
    Ok(ack(up.len).into_response())
}

/// The error of a remote output that does not match what the worker reported, or is missing.
pub async fn output_error(
    st: &AppState,
    id: i64,
    attempt: i32,
    size: i64,
    sha: &str,
) -> Option<JobError> {
    let net = |m: String| JobError {
        class: JobErrorClass::Network,
        message: m,
        stderr_tail: None,
    };
    let slot = st.queue.upload(id, attempt);
    let mut up = slot.lock().await;
    let path = store::staged_of(&st.db, id).await.ok().flatten()?;
    up.load(Path::new(&path)).await;
    let got: String = up
        .hasher
        .clone()
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    (up.len as i64 != size || !got.eq_ignore_ascii_case(sha)).then(|| {
        net(format!(
            "the uploaded output holds {} bytes (sha256 {got}), the worker reported {size}",
            up.len
        ))
    })
}

//! Separation on optimization workers: leasing, eligibility and the commit of a worker's stems
//! (`docs/spec/karaoke.md` rules 16-17, `library-optimize-workers.md`).
use super::{flag, run, store, verified_providers};
use crate::{
    events::SseEvent,
    http::AppError,
    queue::{self, Principal, Worker, enqueue::snapshot, store as jobs, watch},
    state::AppState,
};
use axum::Json;
use fliks_engine_core::api::{
    JobError, JobErrorClass, JobPriority, JobResultRequest, ModelKind, STEM_NAMES,
};
use serde_json::{Value, json};

pub use crate::queue::remote::upload_path;

/// Whether a registered worker takes `Separate` jobs: a token worker whose engine has the feature and
/// an accepted provider, unless its last job failed on the model.
pub fn eligible_now(
    w: &Worker,
    blocked: bool,
    enabled_background: bool,
    background_cpu: bool,
    verified: &[String],
) -> bool {
    let has = |f: &str| w.features.iter().any(|x| x == f);
    enabled_background
        && matches!(w.principal, Principal::Token(_))
        && !blocked
        && has("karaoke-separate")
        && (background_cpu || verified.iter().any(|p| has(&format!("onnx-{p}"))))
}

pub async fn eligible(st: &AppState, key: &str, w: &Worker) -> bool {
    if !matches!(w.principal, Principal::Token(_))
        || !w.features.iter().any(|f| f == "karaoke-separate")
    {
        return false;
    }
    let enabled =
        flag(st, "karaoke.enabled", false).await && flag(st, "karaoke.background", true).await;
    eligible_now(
        w,
        st.queue.karaoke_blocked(key),
        enabled,
        flag(st, "karaoke.background_cpu", false).await,
        &verified_providers(st).await,
    )
}

/// Live workers that take `Separate` jobs now.
pub async fn eligible_workers(st: &AppState) -> usize {
    let mut n = 0;
    for (key, w, _) in st.queue.workers() {
        n += usize::from(eligible(st, &key, &w).await);
    }
    n
}

/// `(model id, version)` of the main engine's installed separation model, the one stems must come from.
pub async fn current_model(st: &AppState) -> Option<(String, String)> {
    let models = st.engine.models().await.ok()?;
    let sep = run::installed_model(&models.models, ModelKind::Separation)?;
    Some((sep.id.clone(), sep.version.clone()))
}

pub fn profile_of(model: &(String, String)) -> String {
    format!("karaoke:{}:{}", model.0, model.1)
}

/// Queues the separation of a track's first file; `false` when a job of that file is already active.
pub async fn enqueue(st: &AppState, item: i32) -> Result<bool, String> {
    let t = run::track(st, item).await?;
    let info = t.info.clone().ok_or("the file was not probed")?;
    let sep = current_model(st)
        .await
        .ok_or("no separation model is installed")?;
    let snap = snapshot(t.path.clone())
        .await
        .ok_or("the file is not readable")?;
    let payload = json!({
        "info": info,
        "model": sep.0,
        "modelVersion": sep.1,
        "providers": verified_providers(st).await,
    });
    let job: Option<i64> = sqlx::query_scalar(
        r#"INSERT INTO jobs (kind, "mediaFileId", payload, "profileHash", priority, "inPath", "inSize",
             "inMtimeMs", "inDev", "inIno")
           VALUES ('separate', $1, $2, $3, -1, $4, $5, $6, $7, $8)
           ON CONFLICT ("mediaFileId") WHERE "mediaFileId" IS NOT NULL
             AND state IN ('queued', 'leased', 'staged', 'committing') DO NOTHING
           RETURNING id"#,
    )
    .bind(t.file)
    .bind(payload)
    .bind(profile_of(&sep))
    .bind(&snap.path)
    .bind(snap.size)
    .bind(snap.mtime_ms)
    .bind(snap.dev)
    .bind(snap.ino)
    .fetch_optional(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    if job.is_some() {
        watch::changed();
        st.queue.wake.notify_waiters();
    }
    Ok(job.is_some())
}

fn error(class: JobErrorClass, message: impl Into<String>) -> JobError {
    JobError {
        class,
        message: message.into(),
        stderr_tail: None,
    }
}

fn db(e: sqlx::Error) -> AppError {
    e.into()
}

/// The first track item of a file, the one a stem set belongs to.
async fn item_of(st: &AppState, file: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar(
        r#"SELECT "itemId" FROM item_parts WHERE "mediaFileId" = $1 ORDER BY version LIMIT 1"#,
    )
    .bind(file)
    .fetch_optional(&st.db)
    .await
}

/// The result of a leased `Separate`: a failure is routed by its class, stems are verified, stored and
/// the job row deleted (it never enters `staged`).
pub async fn result(
    st: &AppState,
    key: &str,
    id: i64,
    req: JobResultRequest,
) -> Result<Json<Value>, AppError> {
    let current = current_model(st).await;
    result_for(st, key, id, req, current.as_ref()).await
}

/// [`result`] against a known main-engine model (`None`: unknown, every job counts as current).
pub async fn result_for(
    st: &AppState,
    key: &str,
    id: i64,
    req: JobResultRequest,
    current: Option<&(String, String)>,
) -> Result<Json<Value>, AppError> {
    let attempt = req.attempt as i32;
    let conflict = || AppError::bare(axum::http::StatusCode::CONFLICT);
    let file: Option<i32> = sqlx::query_scalar(
        r#"SELECT "mediaFileId" FROM jobs
           WHERE id = $1 AND "workerId" = $2 AND attempt = $3 AND state = 'leased'"#,
    )
    .bind(id)
    .bind(key)
    .bind(attempt)
    .fetch_optional(&st.db)
    .await
    .map_err(db)?
    .ok_or_else(conflict)?;
    let e = match (req.ok, req.error, req.separate) {
        (false, Some(e), _) => e,
        (false, None, _) => error(JobErrorClass::Engine, "failed without an error"),
        (true, _, None) => error(JobErrorClass::Engine, "separate result without stems"),
        (true, _, Some(out)) => match verify(st, id, attempt, &out).await {
            Some(e) => e,
            None => return commit(st, key, (id, attempt), file, out, current).await,
        },
    };
    if e.class == JobErrorClass::Model && !is_current(st, id, current).await {
        // The job names a version the main engine no longer has: no worker can serve it.
        drop_job(st, key, id, attempt).await.map_err(db)?;
        st.queue.wake.notify_waiters();
        return Ok(Json(json!({})));
    }
    if jobs::fail(&st.db, id, key, attempt, &e).await.map_err(db)? == jobs::Settled::Stale {
        return Err(conflict());
    }
    if e.class == JobErrorClass::Model {
        st.queue.block_karaoke(key);
    }
    after_failure(st, id, file).await;
    Ok(Json(json!({})))
}

/// Whether the job's model version is the main engine's installed one.
async fn is_current(st: &AppState, id: i64, current: Option<&(String, String)>) -> bool {
    let Some(cur) = current else {
        return true;
    };
    let hash: Option<String> =
        sqlx::query_scalar(r#"SELECT "profileHash" FROM jobs WHERE id = $1"#)
            .bind(id)
            .fetch_optional(&st.db)
            .await
            .ok()
            .flatten();
    hash.is_none_or(|h| h == profile_of(cur))
}

/// Deletes the leased job (fenced) and its uploads; whether the fence held.
async fn drop_job(st: &AppState, key: &str, id: i64, attempt: i32) -> sqlx::Result<bool> {
    let n = sqlx::query(
        r#"DELETE FROM jobs WHERE id = $1 AND "workerId" = $2 AND attempt = $3 AND state = 'leased'"#,
    )
    .bind(id)
    .bind(key)
    .bind(attempt)
    .execute(&st.db)
    .await?
    .rows_affected();
    for name in STEM_NAMES {
        let _ = tokio::fs::remove_file(upload_path(id, attempt, name)).await;
    }
    crate::queue::remote::sweep(st).await;
    watch::changed();
    Ok(n > 0)
}

/// A job that landed `failed` leaves its item out of the pass for this profile, and until a restart after a local failure.
async fn after_failure(st: &AppState, id: i64, file: Option<i32>) {
    crate::queue::remote::sweep(st).await;
    st.queue.wake.notify_waiters();
    let failed: Option<String> = sqlx::query_scalar("SELECT state FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_optional(&st.db)
        .await
        .ok()
        .flatten();
    if failed.as_deref() == Some("failed")
        && let Some(file) = file
        && let Ok(Some(item)) = item_of(st, file).await
    {
        st.karaoke
            .failed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(item);
    }
}

/// Each of the three stems must match its upload (size and SHA-256).
async fn verify(
    st: &AppState,
    id: i64,
    attempt: i32,
    out: &fliks_engine_core::api::SeparateOutput,
) -> Option<JobError> {
    for name in STEM_NAMES {
        let Some(stem) = out.stems.iter().find(|s| s.name == name) else {
            return Some(error(
                JobErrorClass::Network,
                format!("the {name} stem is missing"),
            ));
        };
        let path = upload_path(id, attempt, name);
        let e = queue::remote::output_error(
            st,
            (id, attempt, name),
            &path.to_string_lossy(),
            stem.size as i64,
            &stem.sha256,
        )
        .await;
        if e.is_some() {
            return e;
        }
    }
    None
}

async fn commit(
    st: &AppState,
    key: &str,
    (id, attempt): (i64, i32),
    file: Option<i32>,
    out: fliks_engine_core::api::SeparateOutput,
    current: Option<&(String, String)>,
) -> Result<Json<Value>, AppError> {
    let conflict = || AppError::bare(axum::http::StatusCode::CONFLICT);
    let item = match file {
        Some(f) => item_of(st, f).await.map_err(db)?.map(|i| (f, i)),
        None => None,
    };
    // Stems of another version than the main engine's would be invalidated at once.
    let wanted = current.is_none_or(|m| *m == (out.model.clone(), out.model_version.clone()));
    let _separating = item
        .filter(|_| wanted)
        .map(|(f, _)| super::Separating::new(&st.karaoke, f));
    let moved = match item {
        Some((f, _)) if wanted => match move_stems(st, f, id, attempt, &out).await {
            Ok(m) => m,
            Err(e) => {
                let e = error(JobErrorClass::Io, e);
                if jobs::fail(&st.db, id, key, attempt, &e).await.map_err(db)?
                    == jobs::Settled::Stale
                {
                    return Err(conflict());
                }
                after_failure(st, id, file).await;
                return Ok(Json(json!({})));
            }
        },
        _ => vec![],
    };
    let mut tx = st.db.begin().await.map_err(db)?;
    let mut old = vec![];
    let mut stored = Ok(());
    for (to, n) in &moved {
        match store::put_in(&mut tx, &n.as_new(to)).await {
            Ok(o) => old.extend(o),
            Err(e) => {
                stored = Err(e);
                break;
            }
        }
    }
    let held = match stored {
        Ok(()) => sqlx::query(
            r#"DELETE FROM jobs WHERE id = $1 AND "workerId" = $2 AND attempt = $3 AND state = 'leased'"#,
        )
        .bind(id)
        .bind(key)
        .bind(attempt)
        .execute(&mut *tx)
        .await
        .map(|r| r.rows_affected() > 0),
        Err(e) => Err(e),
    };
    let committed = match held {
        Ok(true) => tx.commit().await.map(|()| true),
        other => other,
    };
    if !matches!(committed, Ok(true)) {
        for (to, _) in &moved {
            let _ = tokio::fs::remove_file(to).await;
        }
        for name in STEM_NAMES {
            let _ = tokio::fs::remove_file(upload_path(id, attempt, name)).await;
        }
        return Err(committed.map_err(db).err().unwrap_or_else(conflict));
    }
    for o in old {
        let _ = tokio::fs::remove_file(o).await;
    }
    if out.provider == "cpu" && !flag(st, "karaoke.background_cpu", false).await {
        st.queue.block_karaoke(key);
    }
    for name in STEM_NAMES {
        let _ = tokio::fs::remove_file(upload_path(id, attempt, name)).await;
    }
    crate::queue::remote::sweep(st).await;
    watch::changed();
    run::evict(st).await;
    st.karaoke.kick.notify_one();
    queue::emit_managers(st, SseEvent::OptimizeQueueChanged {}).await;
    if let Some((_, item)) = item.filter(|_| wanted) {
        let opts = run::Opts {
            align: true,
            melody: true,
            force: false,
        };
        if matches!(
            run::start(st, item, opts, JobPriority::Low, None).await,
            run::Start::Idle
        ) {
            run::announce_ready(st, item).await;
        }
    }
    Ok(Json(json!({})))
}

/// One stem moved next to the others of its file, to be recorded.
pub struct Moved {
    kind: &'static str,
    size: i64,
    model: String,
    model_version: String,
    provider: String,
    duration_ms: i32,
    file: i32,
}

impl Moved {
    fn as_new<'a>(&'a self, path: &'a str) -> store::New<'a> {
        store::New {
            file: self.file,
            kind: self.kind,
            model: &self.model,
            model_version: &self.model_version,
            provider: &self.provider,
            path,
            size: self.size,
            duration_ms: self.duration_ms,
        }
    }
}

/// Moves the uploads next to the stems of the file, unless the stems are already valid (nothing moves).
async fn move_stems(
    st: &AppState,
    file: i32,
    id: i64,
    attempt: i32,
    out: &fliks_engine_core::api::SeparateOutput,
) -> Result<Vec<(String, Moved)>, String> {
    if store::valid(&st.db, file, &out.model, &out.model_version)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(vec![]);
    }
    let dir = store::file_dir(file);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let tag = crate::config::random_hex(4);
    let mut moved: Vec<(String, Moved)> = vec![];
    for name in STEM_NAMES {
        let stem = out
            .stems
            .iter()
            .find(|s| s.name == name)
            .ok_or("stem missing")?;
        let to = dir.join(format!("{name}-{tag}.opus"));
        if let Err(e) = tokio::fs::rename(upload_path(id, attempt, name), &to).await {
            for (p, _) in &moved {
                let _ = tokio::fs::remove_file(p).await;
            }
            return Err(e.to_string());
        }
        moved.push((
            to.to_string_lossy().into_owned(),
            Moved {
                kind: name,
                size: stem.size as i64,
                model: out.model.clone(),
                model_version: out.model_version.clone(),
                provider: out.provider.clone(),
                duration_ms: (out.duration_seconds * 1000.0).round() as i32,
                file,
            },
        ));
    }
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker(principal: Principal, features: &[&str]) -> Worker {
        Worker {
            principal,
            engine_version: "1".into(),
            devices: vec![],
            features: features.iter().map(|f| (*f).to_owned()).collect(),
        }
    }

    #[test]
    fn eligibility_needs_a_token_worker_the_feature_and_an_accepted_provider() {
        let tok = || Principal::Token(1);
        let verified = ["cuda".to_owned()];
        let ok = |w: &Worker, blocked, bg, cpu| eligible_now(w, blocked, bg, cpu, &verified);
        let gpu = worker(tok(), &["karaoke-separate", "onnx-cuda"]);
        assert!(ok(&gpu, false, true, false));
        assert!(!ok(&gpu, true, true, false), "blocked");
        assert!(!ok(&gpu, false, false, false), "background off");
        assert!(!ok(
            &worker(Principal::Local, &["karaoke-separate", "onnx-cuda"]),
            false,
            true,
            false
        ));
        assert!(
            !ok(&worker(tok(), &["onnx-cuda"]), false, true, false),
            "no feature"
        );
        let cpu_only = worker(tok(), &["karaoke-separate", "onnx-cpu"]);
        assert!(!ok(&cpu_only, false, true, false));
        assert!(
            ok(&cpu_only, false, true, true),
            "background_cpu accepts it"
        );
    }
}

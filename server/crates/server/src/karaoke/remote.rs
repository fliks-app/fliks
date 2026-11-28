//! Separation on optimization workers: eligibility and the commit of their stems (`karaoke.md` rules 16-17).
use super::{run, store, verified_providers};
use crate::{
    events::SseEvent,
    http::AppError,
    queue::{self, Principal, Worker, enqueue::snapshot, store as jobs, watch},
    settings,
    state::AppState,
};
use axum::Json;
use fliks_engine_core::api::{
    JobError, JobErrorClass, JobPriority, JobResultRequest, ModelKind, STEM_NAMES,
};
use serde_json::{Value, json};

pub use crate::queue::remote::upload_path;

/// A token worker with the feature and an accepted provider takes `Separate`, unless it failed on the model.
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
    let enabled = settings::flag(&st.db, "karaoke.enabled", false).await
        && settings::flag(&st.db, "karaoke.background", true).await;
    eligible_now(
        w,
        st.queue.karaoke_blocked(key),
        enabled,
        settings::flag(&st.db, "karaoke.background_cpu", false).await,
        &verified_providers(st).await,
    )
}

/// The file's `separate` job a worker holds, or one waiting while a worker could take it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkerJob {
    pub leased: bool,
    /// The worker's percent, 0 to 100, once it reported one.
    pub progress: Option<f64>,
}

pub async fn worker_job(st: &AppState, file: i32) -> sqlx::Result<Option<WorkerJob>> {
    let job: Option<(String, Option<f32>)> = sqlx::query_as(
        r#"SELECT state, progress FROM jobs WHERE "mediaFileId" = $1 AND kind = 'separate'
             AND state IN ('queued', 'leased') ORDER BY state = 'leased' DESC LIMIT 1"#,
    )
    .bind(file)
    .fetch_optional(&st.db)
    .await?;
    Ok(match job {
        Some((state, p)) if state == "leased" => Some(WorkerJob {
            leased: true,
            progress: p.filter(|p| *p > 0.0).map(|p| f64::from(p) * 100.0),
        }),
        Some(_) if eligible_workers(st).await > 0 => Some(WorkerJob {
            leased: false,
            progress: None,
        }),
        _ => None,
    })
}

/// A worker's heartbeat on a `separate` job: the track's viewers see its progress.
pub async fn heartbeat(st: &AppState, id: i64, progress: f64) {
    let file: Option<i32> = sqlx::query_scalar(
        r#"SELECT "mediaFileId" FROM jobs WHERE id = $1 AND kind = 'separate' AND state = 'leased'"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten();
    if let Some(f) = file
        && let Ok(Some(item)) = store::track_of(&st.db, f).await
    {
        run::announce_worker(st, item, progress.clamp(0.0, 1.0) * 100.0).await;
    }
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
    let models = super::engine_models(st).await.ok()?;
    let sep = run::installed_model(&models.models, ModelKind::Separation)?;
    Some((sep.id.clone(), sep.version.clone()))
}

pub fn profile_of(model: &(String, String)) -> String {
    format!("karaoke:{}:{}", model.0, model.1)
}

/// Queues the separation of a track's file; `false` when its stems are valid or a job of it is active.
pub async fn enqueue(st: &AppState, item: i32) -> Result<bool, String> {
    let t = run::track(st, item).await?;
    let info = t.info.clone().ok_or("the file was not probed")?;
    let sep = current_model(st)
        .await
        .ok_or("no separation model is installed")?;
    if store::valid(&st.db, t.file, &sep.0, &sep.1)
        .await
        .map_err(|e| e.to_string())?
    {
        return Ok(false);
    }
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

/// A leased `Separate` ends: a failure goes by its class, stems are verified and kept, the job deleted.
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
    after_failure(st).await;
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

/// A job that landed `failed` stays: `unprepared` leaves its track out for this model.
async fn after_failure(st: &AppState) {
    crate::queue::remote::sweep(st).await;
    st.queue.wake.notify_waiters();
}

/// Each stem the host keeps must match its upload (size and SHA-256); a `guide` upload is ignored.
async fn verify(
    st: &AppState,
    id: i64,
    attempt: i32,
    out: &fliks_engine_core::api::SeparateOutput,
) -> Option<JobError> {
    for name in store::KINDS {
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
        Some(f) => store::track_of(&st.db, f)
            .await
            .map_err(db)?
            .map(|i| (f, i)),
        None => None,
    };
    // Stems of another version than the main engine's would be separated again at once.
    let wanted = current.is_none_or(|m| *m == (out.model.clone(), out.model_version.clone()));
    if item.is_none() || !wanted {
        tracing::info!(
            job = id,
            ?file,
            wanted,
            "karaoke worker stems discarded: no current track or model"
        );
    }
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
                after_failure(st).await;
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
    if out.provider == "cpu" && !settings::flag(&st.db, "karaoke.background_cpu", false).await {
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
        match run::start(st, item, opts, JobPriority::Low, None).await {
            run::Start::Idle => run::announce_ready(st, item).await,
            run::Start::Refused(r) => {
                tracing::warn!(
                    "karaoke lyrics of item #{item} not started after a worker commit: {r:?}"
                );
                run::announce_ready(st, item).await;
            }
            run::Start::Started(_) => {}
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

/// Moves the uploads of the missing kinds next to the stems of the file (none when they are valid).
async fn move_stems(
    st: &AppState,
    file: i32,
    id: i64,
    attempt: i32,
    out: &fliks_engine_core::api::SeparateOutput,
) -> Result<Vec<(String, Moved)>, String> {
    let missing = store::missing(&st.db, file, Some((&out.model, &out.model_version)))
        .await
        .map_err(|e| e.to_string())?;
    if missing.is_empty() {
        return Ok(vec![]);
    }
    let dir = store::file_dir(file);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let tag = crate::config::random_hex(4);
    let mut moved: Vec<(String, Moved)> = vec![];
    for name in missing {
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

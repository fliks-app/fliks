//! `/engine/workers/hello` and `/engine/jobs/*` (`PROTOCOL.md`, "Worker protocol").
use super::{Principal, Worker, WorkerAuth, settings, store, tokens};
use crate::{
    events::SseEvent,
    http::{
        AppError,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{post, put},
};
use fliks_engine_core::api::{
    JobHeartbeatRequest, JobHeartbeatResponse, JobResultRequest, LeaseRequest, LeasedJob,
    PathMapping, UPLOAD_CHUNK_BYTES, WorkerHello, WorkerHelloResponse, WorkerSettings,
    apply_path_mappings,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::Instant;

pub fn worker_router() -> Router<AppState> {
    Router::new()
        .route("/engine/workers/hello", post(hello))
        .route("/engine/jobs/lease", post(lease))
        .route("/engine/jobs/{id}/heartbeat", post(heartbeat))
        .route("/engine/jobs/{id}/result", post(result))
        .route(
            "/engine/jobs/{id}/output",
            put(super::remote::put_output).layer(DefaultBodyLimit::max(
                UPLOAD_CHUNK_BYTES as usize + 64 * 1024,
            )),
        )
}

/// The codecs a device encodes in hardware and in software (`lib*` encoders).
pub(super) fn codec_split(encoders: &[String]) -> (Vec<String>, Vec<String>) {
    let (sw, hw): (Vec<String>, Vec<String>) = encoders
        .iter()
        .cloned()
        .partition(|e| e.to_lowercase().starts_with("lib"));
    (codecs_of(&hw), codecs_of(&sw))
}

/// The video codecs an encoder list can produce, as the codec names a plan carries.
pub(super) fn codecs_of(encoders: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for e in encoders {
        let e = e.to_lowercase();
        let codec = if e.contains("av1") {
            "av1"
        } else if e.contains("hevc") || e.contains("265") {
            "hevc"
        } else if e.contains("264") || e.contains("avc") {
            "h264"
        } else {
            continue;
        };
        if !out.iter().any(|c| c == codec) {
            out.push(codec.to_owned());
        }
    }
    out
}

fn db(e: sqlx::Error) -> AppError {
    e.into()
}

fn conflict() -> AppError {
    AppError::bare(StatusCode::CONFLICT)
}

#[utoipa::path(post, path = "/engine/workers/hello", responses((status = 200)))]
pub async fn hello(
    State(st): State<AppState>,
    WorkerAuth(who): WorkerAuth,
    ValidJson(body): ValidJson<WorkerHello>,
) -> Result<Json<WorkerHelloResponse>, AppError> {
    let key = who.owner_key(&body.instance_id);
    let held: Vec<(i64, i32)> = body
        .jobs
        .iter()
        .map(|j| (i64::from(j.id), j.attempt as i32))
        .collect();
    let abandon = store::hello(&st.db, &key, &held).await.map_err(db)?;
    if let Principal::Token(id) = who {
        tokens::touch(&st.db, id).await.map_err(db)?;
    }
    st.queue.register(
        key,
        Worker {
            principal: who,
            engine_version: body.engine_version,
            devices: body.devices,
        },
    );
    st.queue.wake.notify_waiters();
    let conf = settings::load(&st.db).await.map_err(db)?;
    Ok(Json(WorkerHelloResponse {
        settings: WorkerSettings {
            lease_s: store::LEASE_S,
            heartbeat_s: store::HEARTBEAT_S,
            long_poll_s: store::LONG_POLL_S,
            upload_chunk_bytes: UPLOAD_CHUNK_BYTES,
            cpu_weight: Some(conf.cpu_weight),
            gpu_playback_before_pause: Some(conf.gpu_playback_before_pause),
        },
        abandon: abandon
            .into_iter()
            .filter_map(|i| u32::try_from(i).ok())
            .collect(),
    }))
}

/// How a worker reaches the files of a lease.
enum Reach {
    /// By path, translated by the mappings of its token (none for the local engine).
    Path(Vec<PathMapping>),
    /// Over HTTP: the main engine's data plane at this base, and an upload for the output.
    Http(String),
}

fn leased(t: store::Taken, reach: &Reach, token: Option<String>) -> Result<LeasedJob, AppError> {
    let tag = if t.kind == "verify" {
        "Verify"
    } else {
        "Optimize"
    };
    let mut payload = t.payload;
    let map = |p: String| match reach {
        Reach::Path(m) if !m.is_empty() => apply_path_mappings(m, &p),
        _ => p,
    };
    if let Reach::Path(m) = reach
        && !m.is_empty()
        && let Some(Value::Array(subs)) = payload.pointer_mut("/plan/extraSubtitles")
    {
        for x in subs {
            if let Some(Value::String(p)) = x.get_mut("path") {
                *p = apply_path_mappings(m, p);
            }
        }
    }
    let kind = serde_json::from_value(json!({ "type": tag, "payload": payload }))
        .map_err(|e| AppError::internal(format!("job {} payload: {e}", t.id)))?;
    let (input_path, staged_path, input_url) = match reach {
        Reach::Path(_) => (t.in_path.map(&map), t.staged_path.map(&map), None),
        Reach::Http(base) => (
            None,
            None,
            t.media_file_id
                .map(|f| format!("{}/api/stream/{f}?download=1", base.trim_end_matches('/'))),
        ),
    };
    Ok(LeasedJob {
        id: t.id as u32,
        attempt: t.attempt as u32,
        lease_s: store::LEASE_S,
        kind,
        input_path,
        staged_path,
        input_url,
        input_token: token,
    })
}

/// Long-poll: 200 with a job, or 204 after `LONG_POLL_S`.
#[utoipa::path(post, path = "/engine/jobs/lease", responses((status = 200), (status = 204)))]
pub async fn lease(
    State(st): State<AppState>,
    WorkerAuth(who): WorkerAuth,
    ValidJson(req): ValidJson<LeaseRequest>,
) -> Result<Response, AppError> {
    let key = who.owner_key(&req.worker_id);
    let Some(worker) = st.queue.worker(&key) else {
        return Err(AppError::not_found("unknown worker: send hello first"));
    };
    let Some(device) = worker.devices.iter().find(|d| d.id == req.device_id) else {
        return Err(AppError::not_found("unknown device"));
    };
    let deadline = Instant::now() + Duration::from_secs(u64::from(store::LONG_POLL_S));
    let reach = match who {
        Principal::Local => Reach::Path(vec![]),
        Principal::Token(id) => {
            let a = tokens::access(&st.db, id).await.map_err(db)?;
            if a.shared {
                Reach::Path(a.mappings)
            } else {
                // A worker without the library reads over the main engine's public data plane.
                let base = crate::auth::oidc::db::public_url(&st.db)
                    .await
                    .map_err(db)?;
                Reach::Http(base.unwrap_or_default())
            }
        }
    };
    let local = matches!(reach, Reach::Path(_));
    let serving = !matches!(&reach, Reach::Http(b) if b.is_empty());
    loop {
        let mut woken = std::pin::pin!(st.queue.wake.notified());
        woken.as_mut().enable();
        let conf = settings::load(&st.db).await.map_err(db)?;
        if serving && !conf.paused && conf.open_now() {
            let (hw, sw) = codec_split(&device.encoders);
            let anywhere = st.queue.hardware_codecs();
            let fallback: Vec<String> = sw
                .iter()
                .filter(|c| !anywhere.contains(c))
                .cloned()
                .collect();
            let want = store::Want {
                key: &key,
                device: &device.id,
                hw: &hw,
                sw: &sw,
                fallback: &fallback,
                max_jobs: conf.max_jobs(&device.id, device.max_jobs),
                local,
            };
            if let Some(t) = store::take(&st.db, &want).await.map_err(db)? {
                if let Some(old) = t.old_staged.clone() {
                    super::cleanup::remove_staged(t.id, old).await;
                }
                let token = match (&reach, t.media_file_id) {
                    (Reach::Http(_), Some(f)) => Some(st.queue.mint(t.id, t.attempt, f)),
                    _ => None,
                };
                return Ok(Json(leased(t, &reach, token)?).into_response());
            }
        }
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(10));
        let _ = tokio::time::timeout(wait, woken).await;
        if Instant::now() >= deadline {
            return Ok(StatusCode::NO_CONTENT.into_response());
        }
    }
}

#[utoipa::path(post, path = "/engine/jobs/{id}/heartbeat", responses((status = 200), (status = 409)))]
pub async fn heartbeat(
    State(st): State<AppState>,
    WorkerAuth(who): WorkerAuth,
    PathParams(id): PathParams<i64>,
    ValidJson(req): ValidJson<JobHeartbeatRequest>,
) -> Result<Json<JobHeartbeatResponse>, AppError> {
    let key = who.owner_key(&req.worker_id);
    let beat = store::heartbeat(
        &st.db,
        id,
        &key,
        req.attempt as i32,
        req.progress,
        req.paused,
    )
    .await
    .map_err(db)?;
    let Some(beat) = beat else {
        super::remote::sweep(&st).await;
        return Err(conflict());
    };
    super::emit_managers(
        &st,
        SseEvent::OptimizeJobProgress {
            job_id: id,
            progress: req.progress.into(),
            paused: req.paused,
        },
    )
    .await;
    Ok(Json(JobHeartbeatResponse {
        lease_until: beat.lease_until.timestamp_millis() as f64,
        cancel: beat.cancel,
    }))
}

#[utoipa::path(post, path = "/engine/jobs/{id}/result", responses((status = 200), (status = 409)))]
pub async fn result(
    State(st): State<AppState>,
    WorkerAuth(who): WorkerAuth,
    PathParams(id): PathParams<i64>,
    ValidJson(req): ValidJson<JobResultRequest>,
) -> Result<Json<Value>, AppError> {
    let key = who.owner_key(&req.worker_id);
    let attempt = req.attempt as i32;
    let out_size = req.out_size as i64;
    let mut meta = serde_json::Map::new();
    for (k, v) in [
        ("level", json!(req.level)),
        ("copyReason", json!(req.copy_reason)),
        ("cpuFallback", json!(req.cpu_fallback)),
    ] {
        if !v.is_null() {
            meta.insert(k.into(), v);
        }
    }
    if req.ok && req.nothing_to_do {
        let r = store::skip_nothing(&st.db, id, &key, attempt, Value::Object(meta))
            .await
            .map_err(db)?;
        return match r {
            store::Settled::Stale => Err(conflict()),
            store::Settled::Done => {
                super::emit_managers(&st, crate::events::SseEvent::OptimizeQueueChanged {}).await;
                Ok(Json(json!({})))
            }
        };
    }
    let failure = match (req.ok, req.error) {
        (false, Some(e)) => Some(e),
        (false, None) => Some(missing("failed without an error")),
        (true, _) => output_error(&st, who, id, attempt, &req.out_sha256, out_size).await?,
    };
    let settled = match failure {
        Some(e) => store::fail(&st.db, id, &key, attempt, &e).await,
        None => {
            let mut info = req
                .out_info
                .as_ref()
                .and_then(|i| serde_json::to_value(i).ok());
            // The result is the output's probe; what the encode did rides along as extra keys.
            if let Some(Value::Object(o)) = info.as_mut() {
                o.extend(meta);
            }
            store::succeed(
                &st.db,
                id,
                &key,
                attempt,
                out_size,
                req.out_sha256.as_deref(),
                info,
            )
            .await
        }
    }
    .map_err(db)?;
    match settled {
        store::Settled::Stale => {
            super::remote::sweep(&st).await;
            Err(conflict())
        }
        store::Settled::Done => {
            super::remote::sweep(&st).await;
            st.queue.wake.notify_waiters();
            Ok(Json(json!({})))
        }
    }
}

fn missing(message: &str) -> fliks_engine_core::api::JobError {
    fliks_engine_core::api::JobError {
        class: fliks_engine_core::api::JobErrorClass::Engine,
        message: message.to_owned(),
        stderr_tail: None,
    }
}

/// An optimize result needs its output: a path-reading worker's staged file must match the size it
/// reports, a remote worker's upload its size and SHA-256.
async fn output_error(
    st: &AppState,
    who: Principal,
    id: i64,
    attempt: i32,
    sha: &Option<String>,
    size: i64,
) -> Result<Option<fliks_engine_core::api::JobError>, AppError> {
    let kind: Option<String> = sqlx::query_scalar("SELECT kind FROM jobs WHERE id = $1")
        .bind(id)
        .fetch_optional(&st.db)
        .await
        .map_err(db)?;
    if kind.as_deref() != Some("optimize") {
        return Ok(None);
    }
    let Some(sha) = sha.as_deref().filter(|_| size > 0) else {
        return Ok(Some(missing("optimize result without an output")));
    };
    let by_path = match who {
        Principal::Local => true,
        Principal::Token(t) => tokens::access(&st.db, t).await.map_err(db)?.shared,
    };
    if !by_path {
        return Ok(super::remote::output_error(st, id, attempt, size, sha).await);
    }
    let Some(path) = store::staged_of(&st.db, id).await.map_err(db)? else {
        return Ok(None);
    };
    let on_disk = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len() as i64)
        .ok();
    Ok(
        (on_disk != Some(size)).then(|| fliks_engine_core::api::JobError {
            class: fliks_engine_core::api::JobErrorClass::Network,
            message: format!("staged output holds {on_disk:?} bytes, the worker reported {size}"),
            stderr_tail: None,
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::codecs_of;

    #[test]
    fn encoders_map_to_plan_codecs() {
        let e = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            codecs_of(&e(&["libx265", "hevc_nvenc", "libx264"])),
            ["hevc", "h264"]
        );
        assert_eq!(codecs_of(&e(&["libsvtav1", "av1_qsv"])), ["av1"]);
        assert!(codecs_of(&e(&["aac"])).is_empty());
    }
}

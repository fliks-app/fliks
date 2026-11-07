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
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::post,
};
use fliks_engine_core::api::{
    JobHeartbeatRequest, JobHeartbeatResponse, JobResultRequest, LeaseRequest, LeasedJob,
    UPLOAD_CHUNK_BYTES, WorkerHello, WorkerHelloResponse, WorkerSettings,
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

fn leased(t: store::Taken) -> Result<LeasedJob, AppError> {
    let tag = if t.kind == "verify" {
        "Verify"
    } else {
        "Optimize"
    };
    let kind = serde_json::from_value(json!({ "type": tag, "payload": t.payload }))
        .map_err(|e| AppError::internal(format!("job {} payload: {e}", t.id)))?;
    Ok(LeasedJob {
        id: t.id as u32,
        attempt: t.attempt as u32,
        lease_s: store::LEASE_S,
        kind,
        input_path: t.in_path,
        staged_path: t.staged_path,
        input_url: None,
        input_token: None,
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
    // ponytail: a remote worker reads the library over `inputUrl`, which W1 wires; until then it gets no job.
    let local = who == Principal::Local;
    loop {
        let mut woken = std::pin::pin!(st.queue.wake.notified());
        woken.as_mut().enable();
        let conf = settings::load(&st.db).await.map_err(db)?;
        if local && !conf.paused && conf.open_now() {
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
                return Ok(Json(leased(t)?).into_response());
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
    .map_err(db)?
    .ok_or_else(conflict)?;
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
    let failure = match (req.ok, req.error) {
        (false, Some(e)) => Some(e),
        (false, None) => Some(missing("failed without an error")),
        (true, _) => local_output_error(&st, who, id, &req.out_sha256, out_size).await?,
    };
    let settled = match failure {
        Some(e) => store::fail(&st.db, id, &key, attempt, &e).await,
        None => {
            let info = req
                .out_info
                .as_ref()
                .and_then(|i| serde_json::to_value(i).ok());
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
        store::Settled::Stale => Err(conflict()),
        store::Settled::Done => {
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

/// An optimize result needs its output: a local worker's staged file must match the size it reports.
async fn local_output_error(
    st: &AppState,
    who: Principal,
    id: i64,
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
    if sha.is_none() || size <= 0 {
        return Ok(Some(missing("optimize result without an output")));
    }
    if who != Principal::Local {
        return Ok(None);
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

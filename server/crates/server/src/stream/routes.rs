//! `info/*`, `:id/edl` and the session stop (spec rules 25-30).
use super::{edl, engine_err, file::resolve_file, qoe::qoe_session_ended};
use crate::{
    events::SseEvent,
    http::{AppError, auth::StreamAuthed, validate::PathParams},
    presence::parse_source_fps,
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use fliks_domain::{
    acl::{Action, Subject},
    edl::EdlRange,
};
use fliks_engine_core::{api::QualityEstimate, jsnum};
use serde_json::{Value, json};

#[utoipa::path(get, path = "/api/stream/info/qualities/{mediaFileId}", responses((status = 200)))]
pub async fn qualities(
    State(st): State<AppState>,
    StreamAuthed(a): StreamAuthed,
    PathParams(id): PathParams<i64>,
) -> Result<Json<Vec<QualityEstimate>>, AppError> {
    let file = resolve_file(&st, Some(&a), id).await?;
    let sizes = st
        .engine
        .estimate_sizes(file.info.as_ref(), file.size as f64)
        .await
        .map_err(engine_err)?;
    Ok(Json(sizes))
}

#[utoipa::path(get, path = "/api/stream/info/hw-accel", responses((status = 200)))]
pub async fn hw_accel(State(st): State<AppState>, _a: StreamAuthed) -> Json<Value> {
    Json(json!({"hwAccel": st.stream.hardware.hw_accel()}))
}

#[utoipa::path(get, path = "/api/stream/info/tonemap-algos", responses((status = 200)))]
pub async fn tonemap_algos(State(st): State<AppState>, _a: StreamAuthed) -> Json<Value> {
    Json(json!({"available": st.stream.hardware.tonemap_algos()}))
}

/// `+(x).toFixed(1)`.
fn one_decimal(x: f64) -> f64 {
    jsnum::to_fixed(x, 1).parse().unwrap_or(x)
}

#[utoipa::path(get, path = "/api/stream/info/effective-settings", responses((status = 200)))]
pub async fn effective_settings(
    State(st): State<AppState>,
    _a: StreamAuthed,
) -> Result<Json<Value>, AppError> {
    let ss = crate::engine::load_streaming(&st.db).await?;
    let auto = std::thread::available_parallelism()
        .map_or(1, usize::from)
        .saturating_sub(1)
        .max(1);
    Ok(Json(json!({
        "tonemapAlgo": ss.tonemap_algo,
        "gpuRenderNode": ss.gpu_render_node,
        "tonemapCurve": ss.tonemap_curve,
        "cacheMaxGb": one_decimal(ss.cache_max_bytes.unwrap_or_default() / 1024f64.powi(3)),
        "cacheTtlHours": one_decimal(ss.cache_ttl_ms.unwrap_or_default() / 3_600_000.0),
        "ffmpegSlots": ss.ffmpeg_slots,
        "ffmpegSlotsAuto": auto,
        "pauseCapability": st.stream.hardware.pause_capability(),
    })))
}

#[utoipa::path(get, path = "/api/stream/info/gpus", responses((status = 200)))]
pub async fn gpus(State(st): State<AppState>, _a: StreamAuthed) -> Json<Value> {
    let (gpus, default_node) = st.stream.hardware.gpus();
    let gpus: Vec<Value> = gpus
        .into_iter()
        .map(|g| json!({"renderNode": g.render_node, "label": g.name, "kind": "unknown"}))
        .collect();
    Json(json!({"gpus": gpus, "defaultNode": default_node}))
}

/// Sidecar ranges on the container timeline (the direct-play clock), for original-file downloads.
#[utoipa::path(get, path = "/api/stream/{mediaFileId}/edl", responses((status = 200)))]
pub async fn edl(
    State(st): State<AppState>,
    StreamAuthed(a): StreamAuthed,
    PathParams(id): PathParams<i64>,
) -> Result<Json<Value>, AppError> {
    let file = resolve_file(&st, Some(&a), id).await?;
    let ranges: Vec<EdlRange> = if a.user.edl_enabled {
        let fps = file
            .info
            .as_ref()
            .and_then(|i| i.video.first())
            .and_then(|v| v.frame_rate.as_deref())
            .and_then(parse_source_fps);
        edl::read(&st, &file.absolute, fps)
            .await
            .unwrap_or_default()
    } else {
        vec![]
    };
    Ok(Json(json!({"ranges": ranges})))
}

/// Explicit stop from the client: ends the presence and the engine session; 204 for an unknown sid.
#[utoipa::path(delete, path = "/api/stream/sessions/{sessionId}", responses((status = 204)))]
pub async fn delete_session(
    State(st): State<AppState>,
    StreamAuthed(a): StreamAuthed,
    Path(sid): Path<String>,
) -> Result<StatusCode, AppError> {
    let live = st.presence.peek(&sid);
    let owner = match &live {
        Some(l) => l.user_id,
        None => engine_owner(&st, &sid).await,
    };
    // Sids travel in HLS URLs: a stop must not be ownership-blind.
    if let Some(owner) = owner
        && owner != a.user.id
        && !a.perms.can(Action::Manage, &Subject::Settings)
    {
        tracing::warn!(
            "Refused: user {} tried to stop session {sid} owned by user {owner}",
            a.user.id
        );
        return Err(AppError::forbidden("Not your session"));
    }
    if let Some(uid) = live.as_ref().and_then(|l| l.user_id) {
        let live = live.as_ref().expect("checked");
        match st.hub.target_id_for(live.sse_connection_id.as_deref()) {
            Some(target_id) => st
                .hub
                .emit_to_user(uid, SseEvent::RemoteStopped { target_id }),
            None => tracing::debug!("stop {sid}: no live target, no stop announced"),
        }
        st.hub.emit_to_user(uid, SseEvent::RemoteTargetsChanged {});
    }
    if let Some(stopped) = st.presence.stop(&sid) {
        qoe_session_ended(&st, &stopped);
    }
    if st.engine.runtime()
        && let Err(e) = st.engine.delete_session(&sid, None).await
    {
        tracing::warn!("engine session {sid} not deleted: {e}");
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The owner of a session the host has no presence for but the engine still holds.
async fn engine_owner(st: &AppState, sid: &str) -> Option<i32> {
    if !st.engine.runtime() {
        return None;
    }
    let snap = st.engine.get_session(sid).await.ok().flatten()?;
    snap.owner_id?.parse().ok()
}

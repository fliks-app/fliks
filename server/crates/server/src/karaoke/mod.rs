//! Karaoke core (`docs/spec/karaoke.md`): models, stems, preparation and the background pass.
mod background;
pub mod run;
pub mod store;

use crate::{
    engine::EngineError,
    events::SseEvent,
    http::{
        AppError,
        auth::{Authed, FileBoundAuthed},
        validate::{PathParams, ValidJson},
    },
    settings::setting_value,
    state::AppState,
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use fliks_domain::acl::{Action, Subject};
use fliks_engine_core::api::{JobPriority, ModelKind};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, atomic::AtomicBool},
};
use tokio::sync::{Notify, Semaphore};
use tower::ServiceExt;
use tower_http::services::ServeFile;

pub use background::spawn;

/// Tracks prepared at once (rule 13).
const SLOTS: usize = 2;
const DEFAULT_BUDGET_MB: i64 = 4096;
const MIN_BUDGET_MB: i64 = 256;
const DEFAULT_VERIFIED: [&str; 1] = ["coreml"];
const GPU_PROVIDERS: [&str; 3] = ["cuda", "migraphx", "coreml"];

/// In-memory state of the runs and of the background pass.
pub struct Shared {
    pub(crate) runs: Mutex<HashMap<i32, run::RunState>>,
    pub(crate) slots: Semaphore,
    /// Set when a `Separate` ran on the CPU: the pass rests until the next adoption or settings change.
    pub(crate) stopped: AtomicBool,
    /// Tracks the pass failed on, left alone until the process restarts.
    pub(crate) failed: Mutex<HashSet<i32>>,
    pub(crate) wake: Notify,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            runs: Mutex::default(),
            slots: Semaphore::new(SLOTS),
            stopped: AtomicBool::new(false),
            failed: Mutex::default(),
            wake: Notify::new(),
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/karaoke/status", get(status))
        .route("/api/karaoke/models", get(models))
        .route("/api/karaoke/models/{id}/download", post(download))
        .route(
            "/api/karaoke/models/{id}",
            axum::routing::delete(delete_model),
        )
        .route(
            "/api/items/{itemId}/karaoke",
            get(item_state).post(prepare).delete(remove),
        )
        .route("/api/media-files/{mediaFileId}/stems/{kind}", get(stem))
}

pub(crate) async fn flag(st: &AppState, key: &str, default: bool) -> bool {
    match setting_value(&st.db, key).await.ok().flatten().as_deref() {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

pub(crate) async fn budget_bytes(st: &AppState) -> i64 {
    let mb = setting_value(&st.db, "karaoke.disk_budget_mb")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_BUDGET_MB);
    mb.max(MIN_BUDGET_MB) << 20
}

pub(crate) async fn verified_providers(st: &AppState) -> Vec<String> {
    setting_value(&st.db, "karaoke.verified_providers")
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_else(|| DEFAULT_VERIFIED.map(str::to_owned).to_vec())
}

/// The verified GPU provider the engine lists, if any (rule 16); OpenVINO is never one.
pub fn gpu_provider(features: &[String], verified: &[String]) -> Option<String> {
    GPU_PROVIDERS
        .iter()
        .filter(|p| verified.iter().any(|v| v == *p))
        .find(|p| features.iter().any(|f| *f == format!("onnx-{p}")))
        .map(|p| (*p).to_owned())
}

pub(crate) struct Caps {
    pub separate: bool,
    pub align: bool,
    pub melody: bool,
}

/// What the engine can run now: the feature and the installed default model of each kind.
pub(crate) async fn caps(st: &AppState) -> Caps {
    let features = st.engine.engine_features();
    let has = |f: &str| features.iter().any(|x| x == f);
    let models = match has("models") {
        true => st.engine.models().await.ok(),
        false => None,
    };
    let ready = |feature: &str, kind: ModelKind| {
        has(feature)
            && models
                .as_ref()
                .is_some_and(|m| run::installed_default(&m.models, kind).is_some())
    };
    Caps {
        separate: ready("karaoke-separate", ModelKind::Separation),
        align: ready("karaoke-align", ModelKind::Alignment),
        melody: ready("karaoke-melody", ModelKind::Melody),
    }
}

fn engine_err(e: EngineError) -> AppError {
    match e {
        EngineError::NotRunning => {
            AppError::with_message(StatusCode::SERVICE_UNAVAILABLE, e.to_string())
        }
        EngineError::Http { status, .. } if (400..500).contains(&status) => AppError::plain(
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
            e.to_string(),
        ),
        e => {
            tracing::warn!("karaoke engine call failed: {e}");
            AppError::plain(StatusCode::BAD_GATEWAY, "The engine call failed")
        }
    }
}

fn manage_settings(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::Settings)
}

#[utoipa::path(get, path = "/api/karaoke/status", responses((status = 200)))]
pub async fn status(State(st): State<AppState>, _a: Authed) -> Json<Value> {
    let enabled = flag(&st, "karaoke.enabled", false).await;
    let c = caps(&st).await;
    let features = st.engine.engine_features();
    let gpu = gpu_provider(&features, &verified_providers(&st).await).is_some();
    Json(json!({
        "enabled": enabled,
        "separate": c.separate,
        "align": c.align,
        "melody": c.melody,
        "ready": enabled && c.separate,
        "gpu": gpu,
        "background": background::allowed(&st).await,
    }))
}

#[utoipa::path(get, path = "/api/karaoke/models", responses((status = 200), (status = 503)))]
pub async fn models(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    manage_settings(&a)?;
    let m = st.engine.models().await.map_err(engine_err)?;
    Ok(Json(
        serde_json::to_value(m).map_err(|e| AppError::internal(e.to_string()))?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DownloadDto {
    accept_licence: bool,
}

#[utoipa::path(post, path = "/api/karaoke/models/{id}/download", responses((status = 200), (status = 202), (status = 400), (status = 404)))]
pub async fn download(
    State(st): State<AppState>,
    a: Authed,
    Path(id): Path<String>,
    ValidJson(dto): ValidJson<DownloadDto>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    manage_settings(&a)?;
    if !dto.accept_licence {
        return Err(AppError::bad_request(vec![
            "acceptLicence must be true".to_owned(),
        ]));
    }
    let m = st.engine.download_model(&id).await.map_err(engine_err)?;
    let body = serde_json::to_value(m).map_err(|e| AppError::internal(e.to_string()))?;
    Ok((StatusCode::ACCEPTED, Json(body)))
}

#[utoipa::path(delete, path = "/api/karaoke/models/{id}", responses((status = 204), (status = 404)))]
pub async fn delete_model(
    State(st): State<AppState>,
    a: Authed,
    Path(id): Path<String>,
) -> Result<StatusCode, AppError> {
    manage_settings(&a)?;
    st.engine.delete_model(&id).await.map_err(engine_err)?;
    store::invalidate_model(&st.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Rule 8.
async fn state_of(st: &AppState, item: i32) -> Result<Value, AppError> {
    let file: Option<i32> = sqlx::query_scalar(
        r#"SELECT "mediaFileId" FROM item_parts WHERE "itemId" = $1 ORDER BY version LIMIT 1"#,
    )
    .bind(item)
    .fetch_optional(&st.db)
    .await?;
    let rows = match file {
        Some(f) => store::rows(&st.db, f).await?,
        None => vec![],
    };
    let mut stems = serde_json::Map::new();
    for r in &rows {
        stems.insert(
            r.kind.clone(),
            json!({"size": r.size, "durationMs": r.duration_ms}),
        );
    }
    let ready = store::KINDS.iter().all(|k| stems.contains_key(*k));
    let run = st
        .karaoke
        .runs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&item)
        .cloned();
    let lyrics = crate::lyrics::store::list(&st.db, item).await?;
    let melody = run::melody_target(st, item)
        .await?
        .is_some_and(|r| run::has_pitch(&r.doc.0));
    let mut out = json!({
        "state": run.as_ref().map_or(if ready { "ready" } else { "none" }, |r| r.state),
        "stems": stems,
        "lyrics": lyrics.iter().any(|r| r.source == "generated"),
        "melody": melody,
    });
    if let Some(f) = file {
        out["fileId"] = json!(f);
    }
    if let Some(r) = run {
        if let Some(s) = r.stage {
            out["stage"] = json!(s);
        }
        if let Some(p) = r.progress {
            out["progress"] = json!(p);
        }
        if let Some(e) = r.error {
            out["error"] = json!(e);
        }
    }
    Ok(out)
}

#[utoipa::path(get, path = "/api/items/{itemId}/karaoke", responses((status = 200), (status = 404)))]
pub async fn item_state(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    crate::music::assert_track(&st, &a, item).await?;
    Ok(Json(state_of(&st, item).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareDto {
    align: Option<bool>,
    melody: Option<bool>,
}

#[utoipa::path(post, path = "/api/items/{itemId}/karaoke", responses((status = 200), (status = 202), (status = 409), (status = 503)))]
pub async fn prepare(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
    ValidJson(dto): ValidJson<PrepareDto>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Read, Subject::Media)?;
    crate::music::assert_track(&st, &a, item).await?;
    if !flag(&st, "karaoke.enabled", false).await {
        return Err(AppError::conflict("karaoke_disabled"));
    }
    if !caps(&st).await.separate {
        return Err(AppError::with_message(
            StatusCode::SERVICE_UNAVAILABLE,
            "karaoke_unavailable",
        ));
    }
    let opts = run::Opts {
        align: dto.align.unwrap_or(true),
        melody: dto.melody.unwrap_or(true),
    };
    let started = run::start(&st, item, opts, JobPriority::Normal).is_some();
    let status = if started {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(state_of(&st, item).await?)))
}

#[utoipa::path(delete, path = "/api/items/{itemId}/karaoke", responses((status = 204), (status = 404)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(item): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Update, Subject::Media)?;
    crate::music::assert_track(&st, &a, item).await?;
    let files: Vec<i32> =
        sqlx::query_scalar(r#"SELECT "mediaFileId" FROM item_parts WHERE "itemId" = $1"#)
            .bind(item)
            .fetch_all(&st.db)
            .await?;
    store::invalidate_files(&st.db, &files).await?;
    sqlx::query(r#"DELETE FROM lyrics WHERE "itemId" = $1 AND source = 'generated'"#)
        .bind(item)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Rule 20.
#[utoipa::path(get, path = "/api/media-files/{mediaFileId}/stems/{kind}", responses((status = 200), (status = 206), (status = 404)))]
pub async fn stem(
    State(st): State<AppState>,
    auth: FileBoundAuthed,
    Path((file, kind)): Path<(i32, String)>,
    req: Request,
) -> Result<Response, AppError> {
    let FileBoundAuthed { auth, bound_file } = auth;
    if bound_file.is_some_and(|b| i64::from(b) != i64::from(file)) {
        return Err(AppError::bare(StatusCode::UNAUTHORIZED));
    }
    auth.require(Action::Read, Subject::Media)?;
    let not_found = || AppError::not_found("Stem not found");
    if !store::KINDS.contains(&kind.as_str()) {
        return Err(not_found());
    }
    let item: i32 = sqlx::query_scalar(
        r#"SELECT ip."itemId" FROM item_parts ip JOIN track_details td ON td."itemId" = ip."itemId"
           WHERE ip."mediaFileId" = $1 LIMIT 1"#,
    )
    .bind(file)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(not_found)?;
    crate::music::assert_track(&st, &auth, item).await?;
    let from_start = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|r| r.starts_with("bytes=0-"));
    let path = store::serve(&st.db, file, &kind, from_start)
        .await?
        .ok_or_else(not_found)?;
    let mime = "audio/ogg".parse().expect("mime");
    let mut res = ServeFile::new_with_mime(&path, &mime)
        .oneshot(req)
        .await
        .map_or_else(|e| match e {}, |r| r.map(Body::new));
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=0"),
    );
    Ok(res)
}

pub(crate) fn emit_model(st: &AppState, model: Value) {
    st.hub.emit(SseEvent::KaraokeModelChanged { model });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn only_a_verified_gpu_provider_the_engine_lists_counts() {
        let feats = s(&["onnx", "onnx-cuda", "onnx-openvino", "onnx-coreml"]);
        assert_eq!(gpu_provider(&feats, &s(&["coreml"])), Some("coreml".into()));
        assert_eq!(gpu_provider(&feats, &s(&["migraphx"])), None);
        assert_eq!(gpu_provider(&feats, &s(&["openvino"])), None);
        assert_eq!(gpu_provider(&s(&["onnx"]), &s(&["cuda"])), None);
    }
}

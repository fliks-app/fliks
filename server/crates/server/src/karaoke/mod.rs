//! Karaoke core (`docs/spec/karaoke.md`): models, stems, preparation and the background pass.
pub mod aligner;
mod background;
pub mod cdg;
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
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicUsize},
    },
};
use tokio::sync::{Notify, Semaphore};
use tower::ServiceExt;
use tower_http::services::ServeFile;

pub use background::spawn;

/// Tracks prepared at once (rule 13).
const SLOTS: usize = 2;
const DEFAULT_BUDGET_MB: i64 = 4096;
const MIN_BUDGET_MB: i64 = 256;
const DEFAULT_VERIFIED: [&str; 4] = ["coreml", "cuda", "migraphx", "directml"];
/// The engine's provider names, in its order (`PROVIDERS` of the engine's karaoke module).
const GPU_PROVIDERS: [&str; 10] = [
    "cuda",
    "nvtensorrtrtx",
    "amdgpu",
    "migraphx",
    "coreml",
    "openvino",
    "qnn",
    "vitisai",
    "webgpu",
    "directml",
];

/// In-memory state of the runs and of the background pass.
pub struct Shared {
    pub(crate) runs: Mutex<HashMap<i32, run::RunState>>,
    pub(crate) slots: Semaphore,
    /// Set when a `Separate` ran on the CPU: the pass rests until the next adoption or settings change.
    pub(crate) stopped: AtomicBool,
    /// Tracks the pass failed on, left alone until the process restarts.
    pub(crate) failed: Mutex<HashSet<i32>>,
    pub(crate) wake: Notify,
    /// A re-alignment is running (rule 41).
    pub(crate) realigning: AtomicBool,
    /// Tracks of the running re-alignment, and how many are finished.
    pub(crate) realign_total: AtomicUsize,
    pub(crate) realign_done: AtomicUsize,
    pub(crate) realign_results: Mutex<HashMap<i32, aligner::RealignResult>>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            runs: Mutex::default(),
            slots: Semaphore::new(SLOTS),
            stopped: AtomicBool::new(false),
            failed: Mutex::default(),
            wake: Notify::new(),
            realigning: AtomicBool::new(false),
            realign_total: AtomicUsize::new(0),
            realign_done: AtomicUsize::new(0),
            realign_results: Mutex::default(),
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/karaoke/status", get(status))
        .route("/api/karaoke/models", get(models))
        .route("/api/karaoke/models/{id}/download", post(download))
        .route("/api/karaoke/models/{id}/verify", post(verify_model))
        .route(
            "/api/karaoke/models/orphans/{name}",
            axum::routing::delete(delete_model_orphan),
        )
        .route(
            "/api/karaoke/models/{id}",
            axum::routing::delete(delete_model),
        )
        .route("/api/karaoke/languages", get(aligner::languages))
        .route(
            "/api/karaoke/realign",
            get(aligner::realign_count).post(aligner::realign),
        )
        .route("/api/karaoke/realign/items", get(aligner::realign_items))
        .route(
            "/api/items/{itemId}/karaoke",
            get(item_state).post(prepare).delete(remove),
        )
        .route("/api/media-files/{mediaFileId}/stems/{kind}", get(stem))
        .route("/api/media-files/{mediaFileId}/cdg", get(cdg_file))
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

/// The verified GPU provider the engine lists, if any (rule 16).
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
                .is_some_and(|m| run::installed_model(&m.models, kind).is_some())
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
    #[serde(default)]
    accept_licence: bool,
}

/// A clear licence needs no acceptance; an unknown id is left to the engine's 404.
fn licence_accepted(
    models: &[fliks_engine_core::api::ModelInfo],
    id: &str,
    accepted: bool,
) -> bool {
    accepted
        || models
            .iter()
            .find(|m| m.id == id)
            .is_none_or(|m| m.licence.clear)
}

#[utoipa::path(post, path = "/api/karaoke/models/{id}/download", responses((status = 200), (status = 202), (status = 400), (status = 404)))]
pub async fn download(
    State(st): State<AppState>,
    a: Authed,
    Path(id): Path<String>,
    ValidJson(dto): ValidJson<DownloadDto>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    manage_settings(&a)?;
    let models = st.engine.models().await.map_err(engine_err)?.models;
    if !licence_accepted(&models, &id, dto.accept_licence) {
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

#[utoipa::path(post, path = "/api/karaoke/models/{id}/verify", responses((status = 202), (status = 404), (status = 409)))]
pub async fn verify_model(
    State(st): State<AppState>,
    a: Authed,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<fliks_engine_core::api::ModelInfo>), AppError> {
    manage_settings(&a)?;
    let m = st.engine.verify_model(&id).await.map_err(engine_err)?;
    Ok((StatusCode::ACCEPTED, Json(m)))
}

#[utoipa::path(delete, path = "/api/karaoke/models/orphans/{name}", responses((status = 204), (status = 404)))]
pub async fn delete_model_orphan(
    State(st): State<AppState>,
    a: Authed,
    Path(name): Path<String>,
) -> Result<StatusCode, AppError> {
    manage_settings(&a)?;
    st.engine
        .delete_model_orphan(&name)
        .await
        .map_err(engine_err)?;
    Ok(StatusCode::NO_CONTENT)
}

/// A failure as sent: the engine's `message` goes to users who manage settings only (rule 8).
fn failure_json(f: &run::Failure, detail: bool) -> Value {
    let mut v = json!(f);
    if let Some(o) = v.as_object_mut().filter(|_| !detail) {
        o.remove("message");
    }
    v
}

/// Rule 8.
async fn state_of(st: &AppState, a: &Authed, item: i32) -> Result<Value, AppError> {
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
            json!({"size": r.size, "durationMs": r.duration_ms, "contentType": mime_of(&r.path)}),
        );
    }
    let imported = |k: &str| {
        rows.iter()
            .any(|r| r.kind == k && r.provider == store::IMPORT)
    };
    let ready = store::KINDS.iter().all(|k| stems.contains_key(*k))
        || (imported("vocals") && imported("instrumental"));
    let detail = a.user.is_admin || a.perms.can(Action::Manage, &Subject::Settings);
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
    let cdg = match file {
        Some(f) => match crate::ingest::post_import::file_path(st, f).await? {
            Some((p, _)) => cdg::sidecar(&p).await.is_some(),
            None => false,
        },
        None => false,
    };
    let mut out = json!({
        "state": run.as_ref().map_or(if ready { "ready" } else { "none" }, |r| r.state),
        "cdg": cdg,
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
            out["error"] = failure_json(&e, detail);
        }
        if let Some(e) = r.lyrics_error {
            out["lyricsError"] = failure_json(&e, detail);
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
    Ok(Json(state_of(&st, &a, item).await?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PrepareDto {
    align: Option<bool>,
    melody: Option<bool>,
}

#[utoipa::path(post, path = "/api/items/{itemId}/karaoke", responses((status = 200), (status = 202), (status = 409), (status = 429), (status = 503)))]
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
        realign: false,
    };
    let priority = if a.perms.can(Action::Update, &Subject::Media) {
        JobPriority::Normal
    } else {
        JobPriority::Low
    };
    let status = match run::start(&st, item, opts, priority, Some(a.user.id)).await {
        run::Start::Started(_) => StatusCode::ACCEPTED,
        run::Start::Idle => StatusCode::OK,
        run::Start::Refused(run::Refusal::Busy) => {
            return Err(AppError::with_message(
                StatusCode::TOO_MANY_REQUESTS,
                "karaoke_busy",
            ));
        }
        run::Start::Refused(run::Refusal::Full) => {
            return Err(AppError::with_message(
                StatusCode::SERVICE_UNAVAILABLE,
                "karaoke_storage_full",
            ));
        }
    };
    Ok((status, Json(state_of(&st, &a, item).await?)))
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
    {
        let mut runs = st.karaoke.runs.lock().unwrap_or_else(|e| e.into_inner());
        if runs.get(&item).is_some_and(|r| !r.active()) {
            runs.remove(&item);
        }
    }
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
    let mime = mime_of(&path).parse().expect("mime");
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

/// Rule 32: the `.cdg` of the track of `file`, served whole like a stem (same credentials).
#[utoipa::path(get, path = "/api/media-files/{mediaFileId}/cdg", responses((status = 200), (status = 206), (status = 404)))]
pub async fn cdg_file(
    State(st): State<AppState>,
    auth: FileBoundAuthed,
    Path(file): Path<i32>,
    req: Request,
) -> Result<Response, AppError> {
    let FileBoundAuthed { auth, bound_file } = auth;
    if bound_file.is_some_and(|b| i64::from(b) != i64::from(file)) {
        return Err(AppError::bare(StatusCode::UNAUTHORIZED));
    }
    auth.require(Action::Read, Subject::Media)?;
    let not_found = || AppError::not_found("Graphics not found");
    let item: i32 = sqlx::query_scalar(
        r#"SELECT ip."itemId" FROM item_parts ip JOIN track_details td ON td."itemId" = ip."itemId"
           WHERE ip."mediaFileId" = $1 LIMIT 1"#,
    )
    .bind(file)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(not_found)?;
    crate::music::assert_track(&st, &auth, item).await?;
    let (audio, _) = crate::ingest::post_import::file_path(&st, file)
        .await?
        .ok_or_else(not_found)?;
    let path = cdg::sidecar(&audio).await.ok_or_else(not_found)?;
    let mime = "application/octet-stream".parse().expect("mime");
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

/// The type of a stem file: Ogg Opus from a run, whatever an UltraStar import named.
fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().map(str::to_lowercase).as_deref() {
        Some("mp3") => "audio/mpeg",
        Some("m4a" | "aac") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        _ => "audio/ogg",
    }
}

/// Model events carry the engine's error strings: settings managers only.
pub(crate) async fn emit_model(st: &AppState, model: Value) {
    crate::queue::emit_managers(st, SseEvent::KaraokeModelChanged { model }).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn only_a_verified_gpu_provider_the_engine_lists_counts() {
        let feats = s(&["onnx", "onnx-cuda", "onnx-openvino", "onnx-coreml"]);
        assert_eq!(gpu_provider(&feats, &s(&["coreml"])), Some("coreml".into()));
        assert_eq!(gpu_provider(&feats, &s(&["migraphx"])), None);
        assert_eq!(
            gpu_provider(&feats, &s(&["openvino"])),
            Some("openvino".into())
        );
        assert_eq!(gpu_provider(&feats, &s(&["directml"])), None);
        assert_eq!(gpu_provider(&s(&["onnx"]), &s(&["cuda"])), None);
    }

    #[test]
    fn a_failure_is_a_code_with_params_and_the_message_stays_with_managers() {
        let low = run::Failure::LyricsNotFoundInVocals {
            matched: 26,
            min: 30,
        };
        assert_eq!(
            failure_json(&low, false),
            json!({"code": "lyrics_not_found_in_vocals", "matched": 26, "min": 30})
        );
        let other = run::Failure::from("engine said no");
        assert_eq!(
            failure_json(&other, true),
            json!({"code": "failed", "message": "engine said no"})
        );
        assert_eq!(failure_json(&other, false), json!({"code": "failed"}));
    }

    fn run(user: Option<i32>, state: &'static str) -> run::RunState {
        run::RunState {
            state,
            stage: None,
            progress: None,
            error: None,
            lyrics_error: None,
            user,
            viewers: Arc::from([]),
        }
    }

    #[test]
    fn a_caller_holds_two_runs_and_a_second_request_for_a_track_joins() {
        let mut runs = HashMap::from([(1, run(Some(7), "queued")), (2, run(Some(7), "running"))]);
        assert_eq!(run::admit(&runs, 3, Some(7)), run::Admit::Busy);
        assert_eq!(run::admit(&runs, 3, Some(8)), run::Admit::Go);
        assert_eq!(run::admit(&runs, 3, None), run::Admit::Go);
        assert_eq!(run::admit(&runs, 1, Some(7)), run::Admit::Join);
        assert_eq!(run::admit(&runs, 1, Some(8)), run::Admit::Join);
        runs.insert(2, run(Some(7), "failed"));
        assert_eq!(run::admit(&runs, 3, Some(7)), run::Admit::Go);
    }

    fn model(
        id: &str,
        kind: &str,
        default: bool,
        state: &str,
    ) -> fliks_engine_core::api::ModelInfo {
        serde_json::from_value(json!({
            "id": id, "kind": kind, "name": id, "version": "1", "default": default, "state": state,
            "licence": {"name": "l", "text": "t", "clear": true}, "files": [], "downloadedBytes": 0,
            "languages": [], "homepage": "", "sizeBytes": 0, "diskBytes": 0, "outdated": false,
            "verifying": false
        }))
        .unwrap()
    }

    #[test]
    fn only_an_unclear_licence_needs_acceptance() {
        let mut unclear = model("u", "alignment", false, "absent");
        unclear.licence.clear = false;
        let models = [model("c", "alignment", false, "absent"), unclear];
        assert!(licence_accepted(&models, "c", false));
        assert!(licence_accepted(&models, "gone", false));
        assert!(!licence_accepted(&models, "u", false));
        assert!(licence_accepted(&models, "u", true));
    }

    #[test]
    fn a_job_names_the_installed_default_else_any_installed_model_of_the_kind() {
        let pick = |m: &[fliks_engine_core::api::ModelInfo]| {
            run::installed_model(m, ModelKind::Alignment).map(|m| m.id.clone())
        };
        let base = model("base", "alignment", false, "installed");
        let small = model("small", "alignment", true, "absent");
        let other = model("sep", "separation", true, "installed");
        assert_eq!(
            pick(&[small.clone(), base.clone(), other.clone()]).as_deref(),
            Some("base")
        );
        let small = model("small", "alignment", true, "installed");
        assert_eq!(
            pick(&[base, small, other.clone()]).as_deref(),
            Some("small")
        );
        assert_eq!(pick(&[other]), None);
    }
}

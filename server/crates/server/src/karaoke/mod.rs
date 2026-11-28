//! Karaoke core (`docs/spec/karaoke.md`): models, stems, preparation and the background pass.
pub mod aligner;
mod background;
pub mod cdg;
pub mod remote;
pub mod run;
pub mod store;

use crate::sync::MutexExt;
use crate::{
    engine::EngineError,
    events::SseEvent,
    http::{
        AppError,
        auth::{Authed, FileBoundAuthed},
        validate::{PathParams, ValidJson},
    },
    settings,
    state::AppState,
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, Query, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use fliks_domain::acl::{Action, Subject};
use fliks_engine_core::api::{JobPriority, ModelKind, ModelsResponse};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize},
    },
};
use tokio::sync::{Notify, Semaphore};
use tower::ServiceExt;
use tower_http::services::ServeFile;

pub use background::{drop_stale_separations, spawn};

/// Prepares the next programme tracks of a party whose karaoke display is open (rule 37).
pub fn upcoming(st: &AppState, party: i32) {
    if st.relay.has_display(party) {
        let st = st.clone();
        tokio::spawn(async move { background::prepare_upcoming(&st, party).await });
    }
}

/// Tracks prepared at once (rule 13); runs nobody asked for (the pass, the programme) share one.
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
    pub(crate) unattended: Semaphore,
    /// Set when a `Separate` ran on the CPU: the pass rests until the next adoption or settings change.
    pub(crate) stopped: AtomicBool,
    /// Files whose `Separate` is writing its folder: the sweep leaves them alone.
    pub(crate) separating: Mutex<HashSet<i32>>,
    /// Tracks the pass found nothing to do on or failed on for a passing reason, until its next wake.
    pub(crate) skipped: Mutex<HashSet<i32>>,
    /// The engine's models with the generation they were read at; dropped on each model event.
    models: Mutex<(u64, Option<Arc<ModelsResponse>>)>,
    /// The upcoming programme rows each party with an open karaoke display had prepared last.
    pub(crate) upcoming: Mutex<HashMap<i32, Vec<i32>>>,
    pub(crate) wake: Notify,
    /// A karaoke-capable worker connected: the pass runs, `stopped` stays as it is.
    pub(crate) kick: Notify,
    /// A re-alignment is running (rule 41).
    pub(crate) realigning: AtomicBool,
    /// Tracks of the running re-alignment, and how many are finished.
    pub(crate) realign_total: AtomicUsize,
    pub(crate) realign_done: AtomicUsize,
    pub(crate) realign_results: Mutex<HashMap<i32, aligner::RealignResult>>,
}

/// The engine's models, cached until the next model event or adoption: the engine stats every file.
pub(crate) async fn engine_models(st: &AppState) -> Result<Arc<ModelsResponse>, EngineError> {
    let at = {
        let m = st.karaoke.models.lock_clean();
        if let Some(cached) = &m.1 {
            return Ok(cached.clone());
        }
        m.0
    };
    let fresh = Arc::new(st.engine.models().await?);
    let mut m = st.karaoke.models.lock_clean();
    if m.0 == at {
        m.1 = Some(fresh.clone());
    }
    Ok(fresh)
}

pub(crate) fn forget_models(st: &AppState) {
    let mut m = st.karaoke.models.lock_clean();
    m.0 += 1;
    m.1 = None;
}

/// Keeps a file out of the sweep until dropped.
pub(crate) struct Separating(Arc<Shared>, i32);

impl Separating {
    pub(crate) fn new(shared: &Arc<Shared>, file: i32) -> Self {
        shared.separating.lock_clean().insert(file);
        Self(shared.clone(), file)
    }
}

impl Drop for Separating {
    fn drop(&mut self) {
        self.0.separating.lock_clean().remove(&self.1);
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            runs: Mutex::default(),
            slots: Semaphore::new(SLOTS),
            unattended: Semaphore::new(1),
            stopped: AtomicBool::new(false),
            separating: Mutex::default(),
            skipped: Mutex::default(),
            models: Mutex::default(),
            upcoming: Mutex::default(),
            wake: Notify::new(),
            kick: Notify::new(),
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
        .route(
            "/api/media-files/{mediaFileId}/stems/{kind}/pcm",
            get(stem_pcm),
        )
        .route("/api/media-files/{mediaFileId}/cdg", get(cdg_file))
}

pub(crate) async fn budget_bytes(st: &AppState) -> i64 {
    let mb = settings::text(&st.db, "karaoke.disk_budget_mb")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_BUDGET_MB);
    mb.clamp(MIN_BUDGET_MB, i64::MAX >> 20) << 20
}

pub(crate) async fn verified_providers(st: &AppState) -> Vec<String> {
    settings::text(&st.db, "karaoke.verified_providers")
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str::<Vec<String>>(&v).ok())
        .unwrap_or_else(|| DEFAULT_VERIFIED.map(str::to_owned).to_vec())
}

/// Rule 7: the karaoke settings a malformed value would silently replace by their default.
pub(crate) fn validate_setting(key: &str, value: &str) -> Result<(), String> {
    let int = |min: i64, max: i64| {
        value
            .trim()
            .parse::<i64>()
            .ok()
            .filter(|n| (min..=max).contains(n))
            .map(drop)
            .ok_or_else(|| format!("{key} must be an integer from {min} to {max}"))
    };
    match key {
        "karaoke.disk_budget_mb" => int(MIN_BUDGET_MB, i64::MAX >> 20),
        "karaoke.queue_cap" => int(1, 20),
        "karaoke.verified_providers" => serde_json::from_str::<Vec<String>>(value)
            .ok()
            .filter(|v| v.iter().all(|p| GPU_PROVIDERS.contains(&p.as_str())))
            .map(drop)
            .ok_or_else(|| {
                format!(
                    "{key} must be a JSON array of: {}",
                    GPU_PROVIDERS.join(", ")
                )
            }),
        _ => Ok(()),
    }
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
        true => engine_models(st).await.ok(),
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
    let enabled = settings::flag(&st.db, "karaoke.enabled", false).await;
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
        "pitchShift": features.iter().any(|f| f == "pitch-shift"),
        "background": background::allowed(&st).await,
        "workers": remote::eligible_workers(&st).await,
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
    forget_models(&st);
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
    forget_models(&st);
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
    forget_models(&st);
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
fn failure_json(f: &Value, detail: bool) -> Value {
    let mut v = f.clone();
    if let Some(o) = v.as_object_mut().filter(|_| !detail) {
        o.remove("message");
    }
    v
}

/// A live run decides, then the stems, then a worker's job, then the recorded failure.
fn derive_state(
    run: Option<&run::RunState>,
    ready: bool,
    worker: Option<remote::WorkerJob>,
    failed: bool,
) -> &'static str {
    match (run, worker) {
        (Some(r), _) => r.state,
        _ if ready => "ready",
        (_, Some(w)) if w.leased => "running",
        (_, Some(_)) => "queued",
        _ if failed => "failed",
        _ => "none",
    }
}

/// Rule 8.
async fn state_of(st: &AppState, a: &Authed, item: i32) -> Result<Value, AppError> {
    let file = store::track_file(&st.db, item).await?;
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
    let ready = store::KINDS.iter().all(|k| stems.contains_key(*k));
    let detail = a.user.is_admin || a.perms.can(Action::Manage, &Subject::Settings);
    let run = st.karaoke.runs.lock_clean().get(&item).cloned();
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
    let worker = match file {
        Some(f) => remote::worker_job(st, f).await?,
        None => None,
    };
    let recorded = store::failure(&st.db, item).await?;
    let error = recorded.as_ref().and_then(|f| f.error.clone());
    let state = derive_state(run.as_ref(), ready, worker, error.is_some());
    let mut out = json!({
        "state": state,
        "cdg": cdg,
        "stems": stems,
        "lyrics": lyrics.iter().any(|r| r.source == "generated"),
        "melody": melody,
    });
    if let Some(f) = file {
        out["fileId"] = json!(f);
    }
    let (stage, progress) = match (&run, worker) {
        (Some(r), _) => (r.stage, r.progress),
        (None, Some(w)) if w.leased && !ready => (Some("separate"), w.progress),
        _ => (None, None),
    };
    if let Some(s) = stage {
        out["stage"] = json!(s);
    }
    if let Some(p) = progress {
        out["progress"] = json!(p);
    }
    if let Some(e) = error.filter(|_| state == "failed") {
        out["error"] = failure_json(&e, detail);
    }
    if let Some(e) = recorded.and_then(|f| f.lyrics_error) {
        out["lyricsError"] = failure_json(&e, detail);
    }
    Ok(out)
}

/// Sets `karaoke` on each track of an album detail: its running job, `ready` when its stems exist, else null.
pub(crate) async fn tag_tracks(st: &AppState, album: &mut Value) -> sqlx::Result<()> {
    let ids: Vec<i32> = album["tracks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["itemId"].as_i64().map(|i| i as i32))
        .collect();
    let ready: HashSet<i32> = store::ready_tracks(&st.db, &ids)
        .await?
        .into_iter()
        .collect();
    tag(album, &st.karaoke.runs.lock_clean(), &ready);
    Ok(())
}

fn tag(album: &mut Value, runs: &HashMap<i32, run::RunState>, ready: &HashSet<i32>) {
    for t in album["tracks"].as_array_mut().into_iter().flatten() {
        let id = t["itemId"].as_i64().map(|i| i as i32);
        t["karaoke"] = match id.and_then(|i| runs.get(&i)) {
            Some(r) => json!({"state": r.state, "stage": r.stage, "progress": r.progress}),
            None if id.is_some_and(|i| ready.contains(&i)) => {
                json!({"state": "ready", "stage": null, "progress": null})
            }
            None => Value::Null,
        };
    }
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
    /// Redo the asked steps on a prepared track (never `Separate`).
    #[serde(default)]
    force: bool,
}

/// A refusal of the karaoke routes: the code as `message`, its translation key as `key`.
pub(crate) fn refusal(status: StatusCode, code: &str) -> AppError {
    let key = format!("karaoke.error.{}", code.trim_start_matches("karaoke_"));
    AppError::with_message(status, code).keyed(&key, json!({}))
}

pub(crate) fn disabled() -> AppError {
    refusal(StatusCode::CONFLICT, "karaoke_disabled")
}

pub(crate) fn unavailable() -> AppError {
    refusal(StatusCode::SERVICE_UNAVAILABLE, "karaoke_unavailable")
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
    if dto.force {
        a.require(Action::Update, Subject::Media)?;
    }
    if !settings::flag(&st.db, "karaoke.enabled", false).await {
        return Err(disabled());
    }
    let opts = run::Opts {
        align: dto.align.unwrap_or(true),
        melody: dto.melody.unwrap_or(true),
        force: dto.force,
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
            return Err(refusal(StatusCode::TOO_MANY_REQUESTS, "karaoke_busy"));
        }
        run::Start::Refused(run::Refusal::Full) => {
            return Err(refusal(
                StatusCode::SERVICE_UNAVAILABLE,
                "karaoke_storage_full",
            ));
        }
        run::Start::Refused(run::Refusal::Unavailable) => return Err(unavailable()),
    };
    if let Some(f) = store::track_file(&st.db, item).await? {
        store::touch(&st.db, f).await?;
    }
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
    run::cancel(&st, item).await;
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
    store::forget_failure(&st.db, item).await?;
    st.karaoke.skipped.lock_clean().remove(&item);
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
    let path = stem_path(&st, auth, file, &kind).await?;
    Ok(serve_whole(&path, mime_of(&path), req).await)
}

#[derive(Deserialize)]
pub struct PcmQuery {
    from: Option<f64>,
    to: Option<f64>,
}

/// Rule 20a.
#[utoipa::path(get, path = "/api/media-files/{mediaFileId}/stems/{kind}/pcm", responses((status = 200), (status = 206), (status = 404)))]
pub async fn stem_pcm(
    State(st): State<AppState>,
    auth: FileBoundAuthed,
    Path((file, kind)): Path<(i32, String)>,
    Query(q): Query<PcmQuery>,
) -> Result<Response, AppError> {
    let path = stem_path(&st, auth, file, &kind).await?;
    let pcm = crate::pcm::rendition(&st, file, std::path::Path::new(&path)).await?;
    crate::pcm::serve(&pcm, q.from.unwrap_or(0.0), q.to).await
}

/// The credential and track checks of rule 20 for `file`; `not_found` names what is missing.
async fn check_track_file(
    st: &AppState,
    auth: FileBoundAuthed,
    file: i32,
    not_found: fn() -> AppError,
) -> Result<(), AppError> {
    let FileBoundAuthed { auth, bound_file } = auth;
    if bound_file.is_some_and(|b| i64::from(b) != i64::from(file)) {
        return Err(AppError::bare(StatusCode::UNAUTHORIZED));
    }
    auth.require(Action::Read, Subject::Media)?;
    let item: i32 = sqlx::query_scalar(
        r#"SELECT ip."itemId" FROM item_parts ip JOIN track_details td ON td."itemId" = ip."itemId"
           WHERE ip."mediaFileId" = $1 LIMIT 1"#,
    )
    .bind(file)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(not_found)?;
    crate::music::assert_track(st, &auth, item).await
}

/// The stem file of `kind` for `file`, after the checks of rule 20.
async fn stem_path(
    st: &AppState,
    auth: FileBoundAuthed,
    file: i32,
    kind: &str,
) -> Result<String, AppError> {
    let not_found = || AppError::not_found("Stem not found");
    if !store::KINDS.contains(&kind) {
        return Err(not_found());
    }
    check_track_file(st, auth, file, not_found).await?;
    store::serve(&st.db, file, kind)
        .await?
        .ok_or_else(not_found)
}

/// A whole file with byte ranges, never cached by the browser across sessions.
async fn serve_whole(path: &str, mime: &str, req: Request) -> Response {
    let mime = mime.parse().expect("mime");
    let mut res = ServeFile::new_with_mime(path, &mime)
        .oneshot(req)
        .await
        .map_or_else(|e| match e {}, |r| r.map(Body::new));
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=0"),
    );
    res
}

/// Rule 32: the `.cdg` of the track of `file`, served whole like a stem (same credentials).
#[utoipa::path(get, path = "/api/media-files/{mediaFileId}/cdg", responses((status = 200), (status = 206), (status = 404)))]
pub async fn cdg_file(
    State(st): State<AppState>,
    auth: FileBoundAuthed,
    Path(file): Path<i32>,
    req: Request,
) -> Result<Response, AppError> {
    let not_found = || AppError::not_found("Graphics not found");
    check_track_file(&st, auth, file, not_found).await?;
    let (audio, _) = crate::ingest::post_import::file_path(&st, file)
        .await?
        .ok_or_else(not_found)?;
    let path = cdg::sidecar(&audio).await.ok_or_else(not_found)?;
    Ok(serve_whole(&path.to_string_lossy(), "application/octet-stream", req).await)
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
    fn karaoke_settings_are_refused_when_malformed() {
        assert!(validate_setting("karaoke.disk_budget_mb", "100").is_err());
        assert!(validate_setting("karaoke.disk_budget_mb", "4096").is_ok());
        assert!(validate_setting("karaoke.queue_cap", "21").is_err());
        assert!(validate_setting("karaoke.verified_providers", r#"["cuda","gpu"]"#).is_err());
        assert!(validate_setting("karaoke.verified_providers", r#"["cuda"]"#).is_ok());
        assert!(validate_setting("karaoke.verified_providers", "cuda").is_err());
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
        let low = json!(run::Failure::LyricsNotFoundInVocals {
            matched: 12,
            min: 17,
        });
        assert_eq!(
            failure_json(&low, false),
            json!({"code": "lyrics_not_found_in_vocals", "matched": 12, "min": 17})
        );
        let other = json!(run::Failure::from("engine said no"));
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
            user,
            viewers: Arc::from([]),
            cancelled: Arc::default(),
            job: None,
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
        runs.remove(&2);
        assert_eq!(run::admit(&runs, 3, Some(7)), run::Admit::Go);
    }

    #[test]
    fn an_album_detail_tags_each_track_with_its_job_ready_or_null() {
        let mut running = run(None, "running");
        running.progress = Some(0.4);
        running.stage = Some("align");
        let runs = HashMap::from([(1, run(None, "queued")), (2, running)]);
        let mut album =
            json!({"tracks": [{"itemId": 1}, {"itemId": 2}, {"itemId": 3}, {"itemId": 4}]});
        tag(&mut album, &runs, &HashSet::from([2, 3]));
        let tag = |i: usize| album["tracks"][i]["karaoke"].clone();
        assert_eq!(
            tag(0),
            json!({"state": "queued", "stage": null, "progress": null})
        );
        assert_eq!(
            tag(1),
            json!({"state": "running", "stage": "align", "progress": 0.4})
        );
        assert_eq!(
            tag(2),
            json!({"state": "ready", "stage": null, "progress": null})
        );
        assert_eq!(tag(3), Value::Null);
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

#[cfg(test)]
mod state_tests {
    use super::*;

    fn run(state: &'static str) -> run::RunState {
        run::RunState {
            state,
            stage: None,
            progress: None,
            user: None,
            viewers: Vec::new().into(),
            cancelled: Arc::default(),
            job: None,
        }
    }

    #[test]
    fn a_live_run_decides_then_the_stems_then_a_worker_then_the_recorded_failure() {
        let leased = Some(remote::WorkerJob {
            leased: true,
            progress: Some(40.0),
        });
        let waiting = Some(remote::WorkerJob {
            leased: false,
            progress: None,
        });
        let cases = [
            (Some("running"), true, None, false, "running"),
            (Some("queued"), false, waiting, true, "queued"),
            (None, true, leased, true, "ready"),
            (None, false, leased, true, "running"),
            (None, false, waiting, true, "queued"),
            (None, false, None, true, "failed"),
            (None, false, None, false, "none"),
        ];
        for (r, ready, worker, failed, want) in cases {
            let r = r.map(run);
            assert_eq!(derive_state(r.as_ref(), ready, worker, failed), want);
        }
    }
}

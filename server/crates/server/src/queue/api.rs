//! `/api/optimize/*`: queueing, job list and controls, worker tokens and the global settings.
use super::{enqueue, settings, store, tokens};
use crate::{
    http::{
        AppError,
        auth::Authed,
        json::iso_ms,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Subject};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

pub fn router() -> Router<AppState> {
    super::worker_router()
        .route("/api/optimize/jobs", get(list_jobs).post(enqueue))
        .route("/api/optimize/jobs/{id}/retry", post(retry))
        .route("/api/optimize/jobs/{id}/cancel", post(cancel))
        .route(
            "/api/optimize/settings",
            get(get_settings).put(put_settings),
        )
        .route("/api/optimize/workers", get(list_workers))
        .route(
            "/api/optimize/workers/tokens",
            get(list_tokens).post(create_token),
        )
        .route("/api/optimize/workers/tokens/{id}", delete(revoke_token))
}

fn db(e: sqlx::Error) -> AppError {
    e.into()
}

fn manage_jobs(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::Library)
}

fn manage_settings(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::Settings)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnqueueDto {
    media_file_ids: Vec<i32>,
    /// "Force re-encode".
    #[serde(default)]
    force: bool,
    #[serde(default)]
    priority: i32,
}

/// Queue, "Optimize…" and "Force re-encode" (`force`).
#[utoipa::path(post, path = "/api/optimize/jobs", responses((status = 201)))]
pub async fn enqueue(
    State(st): State<AppState>,
    authed: Authed,
    ValidJson(dto): ValidJson<EnqueueDto>,
) -> Result<(StatusCode, Json<Vec<enqueue::Queued>>), AppError> {
    manage_jobs(&authed)?;
    if dto.media_file_ids.is_empty() || dto.media_file_ids.len() > 500 {
        return Err(AppError::bad_request("mediaFileIds must hold 1 to 500 ids"));
    }
    let out = enqueue::queue_files(&st, &dto.media_file_ids, dto.force, dto.priority)
        .await
        .map_err(db)?;
    Ok((StatusCode::CREATED, Json(out)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListQuery {
    state: Option<String>,
    limit: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRow {
    id: i64,
    kind: String,
    media_file_id: Option<i32>,
    state: String,
    priority: i32,
    attempt: i32,
    failures: i32,
    progress: f32,
    paused: bool,
    worker_id: Option<String>,
    device_id: Option<String>,
    error: Option<Value>,
    in_path: Option<String>,
    in_size: Option<i64>,
    out_size: Option<i64>,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    updated_at: DateTime<Utc>,
}

#[utoipa::path(get, path = "/api/optimize/jobs", responses((status = 200)))]
pub async fn list_jobs(
    State(st): State<AppState>,
    authed: Authed,
    Query(q): Query<ListQuery>,
) -> Result<Json<Vec<JobRow>>, AppError> {
    manage_jobs(&authed)?;
    let rows = sqlx::query(
        r#"SELECT id, kind, "mediaFileId", state, priority, attempt, failures, progress, paused, "workerId",
             "deviceId", error, "inPath", "inSize", "outSize", "createdAt", "updatedAt" FROM jobs
           WHERE ($1::text IS NULL OR state = $1) ORDER BY id DESC LIMIT $2"#,
    )
    .bind(q.state)
    .bind(q.limit.unwrap_or(100).clamp(1, 500))
    .fetch_all(&st.db)
    .await
    .map_err(db)?;
    Ok(Json(
        rows.iter()
            .map(|r| JobRow {
                id: r.get("id"),
                kind: r.get("kind"),
                media_file_id: r.get("mediaFileId"),
                state: r.get("state"),
                priority: r.get("priority"),
                attempt: r.get("attempt"),
                failures: r.get("failures"),
                progress: r.get("progress"),
                paused: r.get("paused"),
                worker_id: r.get("workerId"),
                device_id: r.get("deviceId"),
                error: r.get("error"),
                in_path: r.get("inPath"),
                in_size: r.get("inSize"),
                out_size: r.get("outSize"),
                created_at: r.get("createdAt"),
                updated_at: r.get("updatedAt"),
            })
            .collect(),
    ))
}

#[utoipa::path(post, path = "/api/optimize/jobs/{id}/retry", responses((status = 200), (status = 409)))]
pub async fn retry(
    State(st): State<AppState>,
    authed: Authed,
    PathParams(id): PathParams<i64>,
) -> Result<Json<Value>, AppError> {
    manage_jobs(&authed)?;
    match enqueue::retry(&st, id).await.map_err(db)? {
        Some(()) => Ok(Json(json!({}))),
        None => Err(AppError::conflict(
            "only a failed or skipped job without another active job can be retried",
        )),
    }
}

#[utoipa::path(post, path = "/api/optimize/jobs/{id}/cancel", responses((status = 200), (status = 409)))]
pub async fn cancel(
    State(st): State<AppState>,
    authed: Authed,
    PathParams(id): PathParams<i64>,
) -> Result<Json<Value>, AppError> {
    manage_jobs(&authed)?;
    if store::cancel(&st.db, id).await.map_err(db)? {
        Ok(Json(json!({})))
    } else {
        Err(AppError::conflict("the job is finished or being committed"))
    }
}

#[utoipa::path(get, path = "/api/optimize/settings", responses((status = 200)))]
pub async fn get_settings(
    State(st): State<AppState>,
    authed: Authed,
) -> Result<Json<settings::Settings>, AppError> {
    manage_settings(&authed)?;
    Ok(Json(settings::load(&st.db).await.map_err(db)?))
}

#[utoipa::path(put, path = "/api/optimize/settings", responses((status = 200)))]
pub async fn put_settings(
    State(st): State<AppState>,
    authed: Authed,
    ValidJson(body): ValidJson<settings::Settings>,
) -> Result<Json<settings::Settings>, AppError> {
    manage_settings(&authed)?;
    body.check().map_err(AppError::bad_request)?;
    settings::save(&st.db, &body).await.map_err(db)?;
    crate::settings::notify_changed(&st, &[settings::KEY.to_owned()], None).await;
    st.queue.wake.notify_waiters();
    Ok(Json(body))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRow {
    instance: String,
    engine_version: String,
    token_id: Option<i32>,
    devices: Vec<fliks_engine_core::api::WorkerDevice>,
}

/// The instances that said hello since the server started.
#[utoipa::path(get, path = "/api/optimize/workers", responses((status = 200)))]
pub async fn list_workers(
    State(st): State<AppState>,
    authed: Authed,
) -> Result<Json<Vec<WorkerRow>>, AppError> {
    manage_settings(&authed)?;
    Ok(Json(
        st.queue
            .workers()
            .into_iter()
            .map(|(key, w)| WorkerRow {
                instance: key,
                engine_version: w.engine_version,
                token_id: match w.principal {
                    super::Principal::Token(id) => Some(id),
                    super::Principal::Local => None,
                },
                devices: w.devices,
            })
            .collect(),
    ))
}

#[utoipa::path(get, path = "/api/optimize/workers/tokens", responses((status = 200)))]
pub async fn list_tokens(
    State(st): State<AppState>,
    authed: Authed,
) -> Result<Json<Vec<tokens::WorkerToken>>, AppError> {
    manage_settings(&authed)?;
    Ok(Json(tokens::list(&st.db).await.map_err(db)?))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenDto {
    name: String,
}

/// The plaintext token, shown once.
#[derive(Serialize)]
pub struct Issued {
    #[serde(flatten)]
    row: tokens::WorkerToken,
    token: String,
}

#[utoipa::path(post, path = "/api/optimize/workers/tokens", responses((status = 201)))]
pub async fn create_token(
    State(st): State<AppState>,
    authed: Authed,
    ValidJson(dto): ValidJson<TokenDto>,
) -> Result<(StatusCode, Json<Issued>), AppError> {
    manage_settings(&authed)?;
    let name = dto.name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err(AppError::bad_request("name must hold 1 to 80 characters"));
    }
    let (row, token) = tokens::create(&st.db, name).await.map_err(db)?;
    Ok((StatusCode::CREATED, Json(Issued { row, token })))
}

/// Revokes the token and puts the leases of its workers back in the queue.
#[utoipa::path(delete, path = "/api/optimize/workers/tokens/{id}", responses((status = 204), (status = 404)))]
pub async fn revoke_token(
    State(st): State<AppState>,
    authed: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    manage_settings(&authed)?;
    if !tokens::revoke(&st.db, id).await.map_err(db)? {
        return Err(AppError::not_found("Not Found"));
    }
    store::release_token(&st.db, id).await.map_err(db)?;
    st.queue.wake.notify_waiters();
    Ok(StatusCode::NO_CONTENT)
}

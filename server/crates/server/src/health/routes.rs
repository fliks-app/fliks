//! `GET /api/system/checks` and `POST /api/system/checks/run`.
use super::{CHECKED, db, run};
use crate::{
    http::{AppError, auth::Authed},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use fliks_domain::acl::{Action, Subject};
use serde_json::{Value, json};
use std::sync::atomic::Ordering;

async fn body(st: &AppState) -> Result<Value, AppError> {
    let ms = CHECKED.load(Ordering::Relaxed);
    let at = chrono::DateTime::from_timestamp_millis(ms).map(fliks_domain::js::iso);
    Ok(json!({ "checkedAt": at, "checks": db::list(&st.db).await? }))
}

#[utoipa::path(get, path = "/api/system/checks", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(body(&st).await?))
}

#[utoipa::path(post, path = "/api/system/checks/run", responses((status = 201)))]
pub async fn run_now(
    State(st): State<AppState>,
    a: Authed,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    run(&st).await?;
    Ok((StatusCode::CREATED, Json(body(&st).await?)))
}

pub fn api() -> Router<AppState> {
    Router::new()
        .route("/api/system/checks", get(list))
        .route("/api/system/checks/run", post(run_now))
}

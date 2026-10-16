use super::service;
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use serde_json::Value;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/persons/search", get(search))
        .route("/api/persons/{id}", get(detail))
        .route("/api/persons/{id}/provider-credits", get(provider_credits))
}

type Res = Result<Json<Value>, AppError>;

#[utoipa::path(get, path = "/api/persons/search", responses((status = 200)))]
pub async fn search(
    State(st): State<AppState>,
    _a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Res {
    let mut qs = q.iter().filter(|(k, _)| k == "q");
    let q = match (qs.next(), qs.next()) {
        (_, Some(_)) => return Err(AppError::bad_request(vec!["q must be a string"])),
        (Some((_, v)), None) => v.trim(),
        _ => "",
    };
    Ok(Json(Value::Array(service::search(&st.db, q).await?)))
}

#[utoipa::path(get, path = "/api/persons/{id}", responses((status = 200)))]
pub async fn detail(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    Ok(Json(service::detail(&st, &a, id?.0).await?))
}

#[utoipa::path(get, path = "/api/persons/{id}/provider-credits", responses((status = 200)))]
pub async fn provider_credits(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    Ok(Json(service::provider_credits(&st, &a, id?.0).await?))
}

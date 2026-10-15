use axum::{Json, Router, routing::get};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Serialize, ToSchema)]
pub struct Liveness {
    ok: bool,
}

/// Unauthenticated; the only route a container healthcheck can call before credentials exist.
#[utoipa::path(get, path = "/api/system/liveness", responses((status = 200, body = Liveness)))]
pub async fn liveness() -> Json<Liveness> {
    Json(Liveness { ok: true })
}

pub fn router() -> Router {
    Router::new().route("/api/system/liveness", get(liveness))
}

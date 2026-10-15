//! Roles domain (`docs/spec/roles.md`).
mod db;
mod grants;
mod routes;

use crate::state::AppState;
use axum::{Router, routing::get};

pub use db::seed;
pub use routes::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/roles", get(routes::list).post(routes::create))
        .route("/api/roles/permissions", get(routes::permissions))
        .route(
            "/api/roles/{id}",
            get(routes::get).put(routes::update).delete(routes::remove),
        )
}

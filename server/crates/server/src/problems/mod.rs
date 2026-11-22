//! `/api/problems/*`, `POST /api/media/{id}/problems` and the auto-resolve of fixed reports (`docs/spec/problems.md`).
mod db;
pub(crate) mod flow;
mod resolve;
mod routes;

use crate::state::AppState;
use axum::{
    Router,
    routing::{delete, get, post},
};

pub use db::insert_system as open_system;
pub use resolve::{auto_resolve, reconcile, spawn};
pub use routes::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/media/{id}/problems", post(routes::create))
        .route("/api/problems", get(routes::list))
        .route(
            "/api/problems/{id}",
            get(routes::get_one).delete(routes::remove),
        )
        .route("/api/problems/{id}/resolve", post(routes::resolve))
        .route("/api/problems/{id}/close", post(routes::close))
        .route("/api/problems/{id}/reopen", post(routes::reopen))
        .route(
            "/api/problems/{id}/comments",
            get(routes::comments_list).post(routes::comment_create),
        )
        .route(
            "/api/problems/comments/{commentId}",
            delete(routes::comment_remove),
        )
}

//! `/api/notifications/*`, the senders and the Nest dispatch bridge (`docs/spec/notifications.md`).
mod db;
mod routes;
mod send;

use crate::state::AppState;
use axum::{
    Router,
    routing::{get, post},
};

pub use routes::*;
pub use send::dispatch;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/notifications", get(routes::list).post(routes::create))
        .route("/api/notifications/events", get(routes::events))
        .route(
            "/api/notifications/{id}",
            get(routes::get_one)
                .put(routes::update)
                .delete(routes::remove),
        )
        .route("/api/notifications/{id}/test", post(routes::test))
        .route(
            "/internal/notifications/dispatch",
            post(routes::internal_dispatch),
        )
}

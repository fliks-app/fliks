//! `/api/notifications/*` and the senders (`docs/spec/notifications.md`).
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

/// A notification payload from an object literal: `payload!({"title": t})`.
macro_rules! payload {
    ({ $($t:tt)* }) => {
        match ::serde_json::json!({ $($t)* }) {
            ::serde_json::Value::Object(m) => m,
            _ => unreachable!("an object literal"),
        }
    };
}
pub(crate) use payload;

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
}

//! `/api/settings/*` (`docs/spec/settings.md`): flat KV store over `app_settings`, secrets redacted (F5).
mod db;
mod routes;
mod secrets;

use crate::state::AppState;
use axum::{Router, routing::get};

pub use db::value as setting_value;
pub use routes::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/settings", get(routes::list).put(routes::put_bulk))
        .route(
            "/api/settings/{key}",
            get(routes::get_one).put(routes::put_one),
        )
}

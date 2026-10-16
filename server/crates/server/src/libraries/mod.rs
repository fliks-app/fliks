//! `/api/libraries/*` (`docs/spec/libraries.md`): library CRUD, per-user access and the library ACL helpers.
mod acl;
mod db;
mod path;
mod routes;

use crate::state::AppState;
use axum::{Router, routing::get};

pub use acl::{accessible_library_ids, assert_media_accessible};
pub use db::paths_visible;
pub use routes::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/libraries", get(routes::list).post(routes::create))
        .route("/api/libraries/mine", get(routes::mine))
        .route(
            "/api/libraries/{id}",
            get(routes::get_one).patch(routes::update),
        )
        .route(
            "/api/libraries/{id}/access",
            get(routes::access_get).put(routes::access_put),
        )
}

//! `/api/libraries/*` (`docs/spec/libraries.md`): library CRUD, per-user access and the library ACL helpers.
pub mod acl;
mod db;
pub mod folders;
mod path;
mod routes;

use crate::state::AppState;
use axum::{
    Router,
    routing::{get, patch, post},
};

pub use acl::{accessible_library_ids, assert_media_accessible, media_not_found};
pub use db::{Folder, paths_visible};
pub use folders::assert_in_library as assert_folder_in_library;
pub use path::{disk, sanitize as sanitize_path, warn_overlapping_folders};
pub use routes::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/libraries", get(routes::list).post(routes::create))
        .route("/api/libraries/mine", get(routes::mine))
        .route(
            "/api/libraries/{id}",
            get(routes::get_one)
                .patch(routes::update)
                .delete(crate::media::write::remove_library),
        )
        .route("/api/libraries/{id}/folders", post(folders::add))
        .route(
            "/api/libraries/{id}/folders/{folderId}",
            patch(folders::patch).delete(folders::remove),
        )
        .route(
            "/api/libraries/{id}/access",
            get(routes::access_get).put(routes::access_put),
        )
}

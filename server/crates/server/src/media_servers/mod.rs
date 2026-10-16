//! Emby media servers (`docs/spec/media-servers.md`).
mod db;
mod dispatch;
mod emby;
mod import;
mod routes;

use crate::state::AppState;
use axum::{Router, routing::get, routing::post};
use utoipa::OpenApi;

pub use dispatch::{dispatch, dispatch_detached};

/// The routes of this domain, merged into the API document by `app::openapi`.
#[derive(OpenApi)]
#[openapi(paths(
    routes::types,
    routes::create,
    routes::list,
    routes::get_one,
    routes::update,
    routes::remove,
    routes::test,
    routes::import_watch_history
))]
pub struct Doc;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/media-servers/types", get(routes::types))
        .route("/api/media-servers", get(routes::list).post(routes::create))
        .route(
            "/api/media-servers/{id}",
            get(routes::get_one)
                .put(routes::update)
                .delete(routes::remove),
        )
        .route("/api/media-servers/{id}/test", post(routes::test))
        .route(
            "/api/media-servers/{id}/import-watch-history",
            post(routes::import_watch_history),
        )
}

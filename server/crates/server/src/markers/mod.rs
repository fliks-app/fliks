//! `/api/markers/*` (`docs/spec/markers.md`): marker CRUD and intro / outro detection orchestration.
mod db;
mod detect;
mod routes;
#[cfg(test)]
mod tests;

use crate::state::AppState;
use axum::{
    Router,
    routing::{get, post, put},
};
use utoipa::OpenApi;

pub use db::ScanSeason;
pub use detect::{auto_detect_missing, list_seasons_for_scan, run_detection_inline};

/// The routes of this domain, merged into the API document by `app::openapi`.
#[derive(OpenApi)]
#[openapi(paths(
    routes::list_episode,
    routes::list_season,
    routes::detect_season,
    routes::detect_all,
    routes::create,
    routes::update,
    routes::remove
))]
pub struct Doc;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/markers/episode/{episodeId}",
            get(routes::list_episode),
        )
        .route("/api/markers/season/{seasonId}", get(routes::list_season))
        .route(
            "/api/markers/season/{seasonId}/detect",
            post(routes::detect_season),
        )
        .route(
            "/api/markers/series/{mediaId}/detect-all",
            post(routes::detect_all),
        )
        .route("/api/markers", post(routes::create))
        .route(
            "/api/markers/{id}",
            put(routes::update).delete(routes::remove),
        )
}

//! Library optimization, server side (`docs/spec/optimize.md`): profiles, the difference between
//! a profile and a file, codec choice, candidate selection and the preview.
pub mod codec;
pub mod diff;
pub mod languages;
pub mod profile;
mod routes;
pub mod select;

use crate::state::AppState;
use axum::{
    Router,
    routing::{get, post},
};

pub use routes::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/optimize/presets", get(routes::presets))
        .route(
            "/api/optimize/profiles",
            get(routes::list).post(routes::create),
        )
        .route(
            "/api/optimize/profiles/{id}",
            get(routes::get_one)
                .put(routes::update)
                .delete(routes::remove),
        )
        .route("/api/libraries/{id}/optimize/preview", get(routes::preview))
        .route(
            "/api/libraries/{id}/optimize/preview/file",
            post(routes::preview_file),
        )
        .route("/api/libraries/{id}/optimize/summary", get(routes::summary))
}

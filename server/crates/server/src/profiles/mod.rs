//! `/api/profiles/*`, `/api/custom-formats/*`, `/api/quality-definitions/*` (`docs/spec/profiles.md`).
mod db;
mod dto;
mod helpers;
mod routes;

use crate::state::AppState;
use axum::{
    Router,
    routing::{get, post},
};

pub use db::seed_quality_definitions;
pub use helpers::*;
pub use routes::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/profiles/quality",
            get(routes::quality_list).post(routes::quality_create),
        )
        .route(
            "/api/profiles/quality/{id}",
            get(routes::quality_get)
                .put(routes::quality_update)
                .delete(routes::quality_delete),
        )
        .route(
            "/api/profiles/language-definitions",
            get(routes::language_definitions),
        )
        .route(
            "/api/profiles/language",
            get(routes::language_list).post(routes::language_create),
        )
        .route(
            "/api/profiles/language/{id}",
            get(routes::language_get)
                .put(routes::language_update)
                .delete(routes::language_delete),
        )
        .route(
            "/api/custom-formats",
            get(routes::format_list).post(routes::format_create),
        )
        .route("/api/custom-formats/test", post(routes::format_test))
        .route(
            "/api/custom-formats/{id}",
            get(routes::format_get)
                .put(routes::format_update)
                .delete(routes::format_delete),
        )
        .route(
            "/api/quality-definitions",
            get(routes::definitions_list).put(routes::definitions_update),
        )
        .route(
            "/api/quality-definitions/reset",
            post(routes::definitions_reset),
        )
}

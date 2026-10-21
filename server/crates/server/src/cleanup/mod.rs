//! Library cleanup rules (`docs/spec/cleanup.md`): `/api/cleanup/*`, the `MediaCleanup` job.
mod db;
mod dto;
mod job;
mod routes;
mod rules;
#[cfg(test)]
mod tests;

use crate::state::AppState;
use axum::{
    Router,
    routing::{get, post},
};

pub use db::{delete_at, scoped_delete_at};
pub use job::run;
pub use routes::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/cleanup/rules",
            get(routes::rule_list).post(routes::rule_create),
        )
        .route("/api/cleanup/rules/import", post(routes::rule_import))
        .route("/api/cleanup/rules/{id}/export", get(routes::rule_export))
        .route(
            "/api/cleanup/rules/{id}",
            get(routes::rule_get)
                .put(routes::rule_update)
                .delete(routes::rule_remove),
        )
        .route(
            "/api/cleanup/rules/{id}/preview",
            post(routes::rule_preview),
        )
        .route("/api/cleanup/candidates", get(routes::candidate_list))
        .route("/api/cleanup/candidates/bulk", post(routes::candidate_bulk))
        .route(
            "/api/cleanup/recommendations",
            get(routes::recommendation_list),
        )
        .route(
            "/api/cleanup/candidates/{mediaId}/delete-now",
            post(routes::candidate_delete_now),
        )
        .route(
            "/api/cleanup/exclusions/{mediaId}",
            post(routes::exclusion_add).delete(routes::exclusion_remove),
        )
        .route("/api/media/leaving-soon", get(routes::leaving_soon))
}

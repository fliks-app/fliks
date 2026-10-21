//! `/api/requests/*`, `/api/auto-approval-rules/*` and the request lifecycle (`docs/spec/requests.md`).
mod db;
pub(crate) mod dto;
mod flow;
mod lifecycle;
mod routes;
mod rules;
pub mod services;
#[cfg(test)]
mod tests;

use crate::state::AppState;
use axum::{
    Router,
    routing::{get, post},
};

pub use lifecycle::{Lifecycle, MediaRef, spawn, spawn_reconcile};
pub use routes::*;
pub use rules::{
    __path_rule_create, __path_rule_get, __path_rule_list, __path_rule_remove, __path_rule_update,
    rule_create, rule_get, rule_list, rule_remove, rule_update,
};

/// A failure of a service owned by another module, with the HTTP status it answers.
#[derive(Debug, Clone)]
pub struct PortError {
    pub status: u16,
    pub message: String,
}

/// The TMDB facts auto-approval reads (rule 29).
#[derive(Debug, Clone, Default)]
pub struct TitleFacts {
    pub genre_ids: Vec<i32>,
    pub year: Option<i32>,
    pub season_count: Option<i32>,
}

/// The local `/api/images/request/<key>/...` paths of a title's art (rule 16).
#[derive(Debug, Clone, Default)]
pub struct Art {
    pub poster: Option<String>,
    pub fanart: Option<String>,
}

/// What `importFromTmdb` is asked for (rule 24); `seasons` scopes the monitoring of a series.
#[derive(Debug, Clone)]
pub struct ImportSpec {
    pub media_type: String,
    pub tmdb_id: i32,
    pub quality_profile_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub library_id: Option<i32>,
    pub seasons: Option<Vec<i64>>,
}

/// The media a delete request removed: its title, the folder to purge when it has one, and the media
/// lock that stays held until that folder is gone.
pub struct Removed {
    pub title: String,
    pub disk_path: Option<String>,
    pub lock: tokio::sync::OwnedMutexGuard<()>,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/requests", get(routes::list).post(routes::create))
        .route("/api/requests/title-state", get(routes::title_state))
        .route(
            "/api/requests/{id}",
            get(routes::get_one)
                .patch(routes::update)
                .delete(routes::remove),
        )
        .route("/api/requests/{id}/approve", post(routes::approve))
        .route("/api/requests/{id}/decline", post(routes::decline))
        .route(
            "/api/requests/{id}/comments",
            get(routes::comments_list).post(routes::comment_create),
        )
        .route(
            "/api/requests/comments/{commentId}",
            axum::routing::delete(routes::comment_remove),
        )
        .route(
            "/api/auto-approval-rules",
            get(rules::rule_list).post(rules::rule_create),
        )
        .route(
            "/api/auto-approval-rules/{id}",
            get(rules::rule_get)
                .put(rules::rule_update)
                .delete(rules::rule_remove),
        )
}

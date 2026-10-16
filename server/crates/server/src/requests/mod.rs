//! `/api/requests/*`, `/api/auto-approval-rules/*` and the request lifecycle (`docs/spec/requests.md`).
mod db;
mod dto;
mod flow;
mod lifecycle;
mod routes;
mod rules;
#[cfg(test)]
mod tests;

use crate::state::AppState;
use axum::{
    Router,
    routing::{get, post},
};
use serde_json::{Map, Value};
use std::{future::Future, pin::Pin};

pub use lifecycle::{Lifecycle, MediaRef, spawn};
pub use routes::*;
pub use rules::{
    __path_rule_create, __path_rule_get, __path_rule_list, __path_rule_remove, __path_rule_update,
    rule_create, rule_get, rule_list, rule_remove, rule_update,
};

pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A failure of a service owned by another milestone, with the HTTP status Nest answered.
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

/// The media a delete request removed: its title and the folder to purge, when it has one.
#[derive(Debug, Clone)]
pub struct Removed {
    pub title: String,
    pub disk_path: Option<String>,
}

/// What the request flows need from the S5 services that are not in this module: TMDB and the
/// image store, `importFromTmdb`, `MediaService.remove` and the notifications.
pub trait Ports: Send + Sync {
    /// TMDB details of a title; an error fails the auto-approval criteria that need them closed.
    fn title_facts<'a>(
        &'a self,
        media_type: &'a str,
        tmdb_id: i32,
    ) -> Fut<'a, Result<TitleFacts, String>>;
    /// Stores the art of a title (`request/<mediaType>-<tmdbId>`) unless already stored; best effort.
    fn request_art<'a>(&'a self, media_type: &'a str, tmdb_id: i32)
    -> Fut<'a, Result<Art, String>>;
    /// `resolveImportTarget`: 400 when the title has no library to land in.
    fn assert_import_target<'a>(
        &'a self,
        media_type: &'a str,
        library_id: Option<i32>,
    ) -> Fut<'a, Result<(), PortError>>;
    /// `importFromTmdb` (it calls `Lifecycle::on_media_imported` itself); answers the media id.
    fn import_from_tmdb(
        &self,
        spec: ImportSpec,
        added_by: Option<i32>,
    ) -> Fut<'_, Result<i32, PortError>>;
    /// `MediaService.remove` (it calls `Lifecycle::on_media_removed` itself).
    fn remove_media(&self, media_id: i32) -> Fut<'_, Result<Removed, PortError>>;
    fn delete_media_folder<'a>(&'a self, path: &'a str) -> Fut<'a, Result<(), String>>;
    /// `NotificationsService.dispatch`: fire and forget.
    fn notify(&self, event: &'static str, payload: Map<String, Value>);
}

/// Until the S5 integration wires the real services: TMDB is not configured.
pub struct Unwired;

impl Ports for Unwired {
    fn title_facts<'a>(&'a self, _: &'a str, _: i32) -> Fut<'a, Result<TitleFacts, String>> {
        Box::pin(async { Err("TMDB API key is not configured".into()) })
    }
    fn request_art<'a>(&'a self, _: &'a str, _: i32) -> Fut<'a, Result<Art, String>> {
        Box::pin(async { Err("TMDB API key is not configured".into()) })
    }
    fn assert_import_target<'a>(
        &'a self,
        _: &'a str,
        _: Option<i32>,
    ) -> Fut<'a, Result<(), PortError>> {
        Box::pin(async { Ok(()) })
    }
    fn import_from_tmdb(&self, _: ImportSpec, _: Option<i32>) -> Fut<'_, Result<i32, PortError>> {
        Box::pin(async {
            Err(PortError {
                status: 400,
                message: "TMDB API key is not configured".into(),
            })
        })
    }
    fn remove_media(&self, _: i32) -> Fut<'_, Result<Removed, PortError>> {
        Box::pin(async {
            Err(PortError {
                status: 503,
                message: "Media removal is not available".into(),
            })
        })
    }
    fn delete_media_folder<'a>(&'a self, _: &'a str) -> Fut<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn notify(&self, _: &'static str, _: Map<String, Value>) {}
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

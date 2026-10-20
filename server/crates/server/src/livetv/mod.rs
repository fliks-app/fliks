//! Live TV (`docs/spec/livetv-*.md`): sources and their sync, the guide, channel access and the session
//! control plane over the engine's `/v1/live`.
pub mod access;
pub mod channels;
mod dto;
mod feed;
pub mod guide;
mod guide_reads;
pub mod jobs;
mod lineup;
mod logos;
mod model;
mod net;
mod playlist_file;
pub mod session;
pub mod sources;
pub mod sync;
#[cfg(test)]
mod tests;

use crate::{
    http::{AppError, auth::Authed},
    state::AppState,
};
use axum::{
    Router,
    routing::{delete, get, patch, post, put},
};

pub(crate) fn admin(a: &Authed) -> Result<(), AppError> {
    a.require(
        fliks_domain::acl::Action::Manage,
        fliks_domain::acl::Subject::Settings,
    )
}

/// Process-wide live TV state: the access mutex and the viewers and holds.
#[derive(Default)]
pub struct Shared {
    pub access: access::Access,
    pub live: session::Live,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/livetv/status", get(channels::status))
        .route("/api/livetv/channels", get(channels::list))
        .route("/api/livetv/channels/on-now", get(guide::on_now))
        .route("/api/livetv/channels/{id}/logo", get(channels::logo))
        .route("/api/livetv/channels/{id}/prefs", put(channels::set_prefs))
        .route("/api/livetv/channels/{id}/play", post(session::play))
        .route("/api/livetv/sessions/{sessionId}", delete(session::leave))
        .route(
            "/api/livetv/sessions/{sessionId}/state",
            put(session::heartbeat),
        )
        .route("/api/livetv/guide", get(guide::window))
        .route("/api/livetv/programs/{id}", get(guide::program))
        .route("/api/livetv/search", get(guide::search))
        .route(
            "/api/livetv/admin/sources",
            get(sources::list).post(sources::create),
        )
        .route("/api/livetv/admin/sources/test", post(sources::test))
        .route(
            "/api/livetv/admin/sources/playlist",
            post(sources::upload).layer(sources::upload_limit()),
        )
        .route(
            "/api/livetv/admin/sources/{id}",
            patch(sources::update).delete(sources::remove),
        )
        .route(
            "/api/livetv/admin/sources/{id}/sync",
            post(sources::sync_route),
        )
        .route("/api/livetv/admin/channels", get(channels::admin_list))
        .route(
            "/api/livetv/admin/channels/bulk",
            patch(channels::bulk_update),
        )
        .route("/api/livetv/admin/channels/merge", post(channels::merge))
        .route(
            "/api/livetv/admin/channels/{id}",
            patch(channels::update_channel),
        )
        .route(
            "/api/livetv/admin/guide-sources",
            get(guide::list).post(guide::create),
        )
        .route(
            "/api/livetv/admin/guide-sources/{id}",
            patch(guide::update).delete(guide::remove),
        )
        .route(
            "/api/livetv/admin/guide-sources/{id}/sync",
            post(guide::sync_route),
        )
        .route(
            "/api/livetv/admin/guide/match-report",
            get(guide::match_report),
        )
        .route(
            "/api/livetv/admin/access/restricted-groups",
            get(access::restricted_groups).put(access::set_restricted_groups),
        )
        .route("/api/livetv/admin/access/users", get(access::users))
        .route(
            "/api/livetv/admin/access/users/{userId}",
            get(access::grants).put(access::set_grants),
        )
}

/// The engine events consumer, subscribed before the engine starts.
pub fn spawn(st: &AppState) {
    session::spawn(st);
}

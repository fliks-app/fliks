//! `/api/playlists/*` (`docs/spec/playlists.md`): playlists, items, members, saves, and the
//! auto-remove of watched items.
mod access;
mod items;
mod routes;
mod view;

use crate::state::AppState;
use axum::{
    Router,
    routing::{delete, get, post, put},
};
use sqlx::PgPool;

pub use access::{Role, assert_role};
pub use items::*;
pub use routes::*;
pub use view::visible_for_owner;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/playlists", get(routes::list).post(routes::create))
        .route(
            "/api/playlists/{id}",
            get(routes::get_one)
                .patch(routes::update)
                .delete(routes::remove),
        )
        .route(
            "/api/playlists/{id}/items",
            get(items::items).post(items::add_item),
        )
        .route("/api/playlists/{id}/items/order", put(items::reorder))
        .route(
            "/api/playlists/{id}/items/by-media/{mediaId}",
            delete(items::remove_by_media),
        )
        .route(
            "/api/playlists/{id}/items/{itemId}",
            delete(items::remove_item),
        )
        .route(
            "/api/playlists/{id}/members",
            get(routes::members).post(routes::add_member),
        )
        .route(
            "/api/playlists/{id}/members/{userId}",
            delete(routes::remove_member),
        )
        .route(
            "/api/playlists/{id}/save",
            post(routes::save).delete(routes::unsave),
        )
}

/// Drops the finished items from the user's own auto-remove playlists.
/// A failure is logged, never returned: it must not break recording the watch.
pub async fn remove_watched_from_auto_playlists(db: &PgPool, user: i32, items: &[i32]) {
    if items.is_empty() {
        return;
    }
    let done = sqlx::query!(
        r#"DELETE FROM playlist_items
           WHERE "playlistId" IN (SELECT id FROM playlists WHERE "ownerId" = $1 AND "autoRemoveWatched")
             AND "itemId" = ANY($2)"#,
        user,
        items
    )
    .execute(db)
    .await;
    if let Err(e) = done {
        tracing::warn!(user, error = %e, "playlist auto-remove failed");
    }
}

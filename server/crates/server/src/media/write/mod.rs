//! `/api/media` write routes and `DELETE /api/libraries/:id` (`docs/spec/media-write.md`).
mod comic_edit;
mod companions;
mod delete;
mod import;
mod metadata;
mod relocate;
mod tasks;
mod update;

pub use comic_edit::*;
pub use companions::*;
pub use delete::*;
pub use import::*;
pub use metadata::*;
pub use relocate::*;
pub use tasks::*;
pub use update::*;

use super::hydrate;
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    libraries::{accessible_library_ids, assert_media_accessible, paths_visible},
    state::AppState,
};
use axum::{
    Router,
    routing::{delete as del, get, patch, post, put},
};
use fliks_domain::acl::{Action, Subject};
use serde_json::Value;
use sqlx::PgPool;

pub fn routes(r: Router<AppState>) -> Router<AppState> {
    r.route("/api/media", post(create))
        .route("/api/media/import/tmdb", post(import_tmdb))
        .route("/api/media/import", post(import_media))
        .route("/api/media/bulk", patch(bulk))
        .route("/api/media/seasons/{seasonId}", patch(patch_season))
        .route("/api/media/episodes/{episodeId}", patch(patch_episode))
        .route("/api/media/{id}", put(update).delete(remove))
        .route("/api/media/{id}/files/{fileId}", del(remove_file))
        .route("/api/media/{id}/library", patch(patch_library))
        .route("/api/media/{id}/move", post(move_media))
        .route("/api/media/{id}/profiles", patch(patch_profiles))
        .route("/api/media/{id}/grab-best", post(grab_best))
        .route("/api/media/{id}/identify", post(identify))
        .route("/api/media/{id}/music/candidates", get(album_candidates))
        .route("/api/media/{id}/refresh", post(refresh))
        .route(
            "/api/media/{id}/episodes/{episodeId}/refresh",
            post(refresh_episode),
        )
        .route("/api/media/{id}/rescan", post(rescan))
        .route("/api/media/{id}/comic", patch(patch_volume))
        .route("/api/comics/issues/{itemId}", patch(patch_issue))
        .route("/api/media/{id}/analyze", post(analyze))
        .route(
            "/api/media/{id}/files/{fileId}/companions",
            get(companions_list).delete(companions_delete),
        )
        .route(
            "/api/media/{id}/files/{fileId}/companions/download",
            get(companions_download),
        )
        .route(
            "/api/media/{id}/files/{fileId}/companions/edl",
            post(companions_edl),
        )
}

/// Guards before pipes: 403, then the id's 400, then the per-media gate's 404.
async fn gate(
    st: &AppState,
    a: &Authed,
    action: Action,
    id: Result<PathParams<i32>, AppError>,
) -> Result<i32, AppError> {
    a.require(action, Subject::Media)?;
    let PathParams(id) = id?;
    let libs = accessible_library_ids(&st.db, a).await?;
    assert_media_accessible(&st.db, id, &libs).await?;
    Ok(id)
}

/// `ME` (rule 4): the eager relations only, relation ids `null` when unset.
pub async fn entity(db: &PgPool, id: i32, see_paths: bool) -> Result<Option<Value>, sqlx::Error> {
    let Some(mut v) = hydrate::items(db, &[id], see_paths).await?.pop() else {
        return Ok(None);
    };
    let meta = sqlx::query_scalar!(r#"SELECT media_details_json($1) AS "m: Value""#, id)
        .fetch_one(db)
        .await?;
    if let Some(o) = v.as_object_mut() {
        for k in ["files", "sizeOnDisk", "episodeStats"] {
            o.remove(k);
        }
        o.insert("metadata".into(), meta.unwrap_or(Value::Null));
    }
    Ok(Some(v))
}

pub async fn entity_or_404(st: &AppState, a: &Authed, id: i32) -> Result<Value, AppError> {
    entity(&st.db, id, paths_visible(&a.perms))
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))
}

pub async fn detail_or_404(st: &AppState, a: &Authed, id: i32) -> Result<Value, AppError> {
    hydrate::detail(&st.db, id, paths_visible(&a.perms))
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))
}

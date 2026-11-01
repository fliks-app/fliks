//! Playlist views: counts and posters under the viewer's library ACL, the list and the profile listing.
use super::access::{Playlist, PlaylistView, Role, assert_role};
use crate::{http::AppError, http::auth::Authed, libraries::accessible_library_ids};
use sqlx::PgPool;
use std::collections::HashMap;

type Stats = HashMap<i32, (i32, Vec<String>)>;

/// `itemCount` and up to 4 distinct posters per playlist (rule 12); empty inputs give no stats.
async fn stats(db: &PgPool, ids: &[i32], accessible: &[i32]) -> sqlx::Result<Stats> {
    if ids.is_empty() || accessible.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query!(
        r#"SELECT c."playlistId" AS "playlist_id!",
                  c.count AS "count!",
                  COALESCE(p.posters, ARRAY[]::text[]) AS "posters!"
           FROM (
             SELECT pi."playlistId" AS "playlistId", COUNT(*)::int AS count
             FROM playlist_items pi
             JOIN items it ON it.id = pi."itemId"
             JOIN media m ON m.id = it."mediaId"
             WHERE pi."playlistId" = ANY($1)
               AND m."libraryId" = ANY($2)
             GROUP BY pi."playlistId"
           ) c
           LEFT JOIN (
             SELECT "playlistId", (ARRAY_AGG(poster ORDER BY minpos))[1:4] AS posters
             FROM (
               SELECT pi."playlistId" AS "playlistId",
                      m."posterUrl"   AS poster,
                      MIN(pi."position") AS minpos
               FROM playlist_items pi
               JOIN items it ON it.id = pi."itemId"
               JOIN media m ON m.id = it."mediaId"
               WHERE pi."playlistId" = ANY($1)
                 AND m."libraryId" = ANY($2)
                 AND m."posterUrl" IS NOT NULL
               GROUP BY pi."playlistId", m."posterUrl"
             ) d
             GROUP BY "playlistId"
           ) p ON p."playlistId" = c."playlistId""#,
        ids,
        accessible
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.playlist_id, (r.count, r.posters)))
        .collect())
}

/// `findOneForUser`: the view with the caller's role, saved flag and ACL stats.
pub async fn view_for(db: &PgPool, a: &Authed, id: i32) -> Result<PlaylistView, AppError> {
    let (playlist, role) = assert_role(db, a.user.id, id, Role::Viewer).await?;
    let accessible = accessible_library_ids(db, a).await?;
    let mut stats = stats(db, &[id], &accessible).await?;
    let saved = role != Role::Owner
        && sqlx::query_scalar!(
            r#"SELECT EXISTS (SELECT 1 FROM playlist_saves WHERE "userId" = $1 AND "playlistId" = $2) AS "e!""#,
            a.user.id,
            id
        )
        .fetch_one(db)
        .await?;
    Ok(PlaylistView::new(playlist, role, saved, stats.remove(&id)))
}

fn by_name(views: &mut [PlaylistView]) {
    views.sort_by(|a, b| a.name().cmp(b.name()).then(a.id().cmp(&b.id())));
}

/// Owned, shared and saved playlists, once each with that precedence (rule 9); a saved one the
/// caller cannot read is dropped.
pub async fn list_for(db: &PgPool, a: &Authed) -> Result<Vec<PlaylistView>, AppError> {
    let me = a.user.id;
    let rows = sqlx::query!(
        r#"SELECT DISTINCT ON (p.id)
                  p.id, p."createdAt" AS created_at, p."updatedAt" AS updated_at, p.name,
                  p."ownerId" AS owner_id, p."autoRemoveWatched" AS auto_remove_watched,
                  p."autoDownload" AS auto_download, p."autoPlay" AS auto_play,
                  p.visibility::text AS "visibility!", p."coverImageUrl" AS cover_image_url,
                  x.role AS "role!", x.saved AS "saved!"
           FROM (
             SELECT id, 'owner' AS role, false AS saved, 1 AS prec FROM playlists WHERE "ownerId" = $1
             UNION ALL
             SELECT "playlistId", role::text, false, 2 FROM playlist_shares WHERE "userId" = $1
             UNION ALL
             SELECT sv."playlistId", 'viewer', true, 3
             FROM playlist_saves sv JOIN playlists sp ON sp.id = sv."playlistId"
             WHERE sv."userId" = $1 AND (
               sp.visibility = 'public'
               OR (sp.visibility = 'followers' AND EXISTS (
                     SELECT 1 FROM user_follows f
                     WHERE f."followerId" = $1 AND f."followingId" = sp."ownerId" AND f.status = 'accepted'))
               OR EXISTS (SELECT 1 FROM playlist_shares s2 WHERE s2."playlistId" = sp.id AND s2."userId" = $1))
           ) x JOIN playlists p ON p.id = x.id
           ORDER BY p.id, x.prec"#,
        me
    )
    .fetch_all(db)
    .await?;
    let ids: Vec<i32> = rows.iter().map(|r| r.id).collect();
    let mut stats = stats(db, &ids, &accessible_library_ids(db, a).await?).await?;
    let mut views: Vec<PlaylistView> = rows
        .into_iter()
        .map(|r| {
            let role = match r.role.as_str() {
                "owner" => Role::Owner,
                s => Role::parse(s),
            };
            let p = Playlist {
                id: r.id,
                created_at: r.created_at,
                updated_at: r.updated_at,
                name: r.name,
                owner_id: r.owner_id,
                auto_remove_watched: r.auto_remove_watched,
                auto_download: r.auto_download,
                auto_play: r.auto_play,
                visibility: r.visibility,
                cover_image_url: r.cover_image_url,
            };
            PlaylistView::new(p, role, r.saved, stats.remove(&r.id))
        })
        .collect();
    by_name(&mut views);
    Ok(views)
}

/// The owner's public (and, for a follower, followers-only) playlists as the viewer sees them (rule 18).
pub async fn visible_for_owner(
    db: &PgPool,
    owner: i32,
    viewer_libraries: &[i32],
    include_followers: bool,
) -> sqlx::Result<Vec<PlaylistView>> {
    let visibilities: &[&str] = if include_followers {
        &["public", "followers"]
    } else {
        &["public"]
    };
    let playlists = sqlx::query_as!(
        Playlist,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, "ownerId" AS owner_id,
                  "autoRemoveWatched" AS auto_remove_watched, "autoDownload" AS auto_download,
                  "autoPlay" AS auto_play, visibility::text AS "visibility!",
                  "coverImageUrl" AS cover_image_url
           FROM playlists WHERE "ownerId" = $1 AND visibility::text = ANY($2)"#,
        owner,
        visibilities as &[&str]
    )
    .fetch_all(db)
    .await?;
    let ids: Vec<i32> = playlists.iter().map(|p| p.id).collect();
    let mut stats = stats(db, &ids, viewer_libraries).await?;
    let mut views: Vec<PlaylistView> = playlists
        .into_iter()
        .map(|p| {
            let s = stats.remove(&p.id);
            PlaylistView::new(p, Role::Viewer, false, s)
        })
        .collect();
    by_name(&mut views);
    Ok(views)
}

//! Playlist items: list, add, remove and reorder (`docs/spec/playlists.md` rules 13-15, 28-35).
use super::access::{Role, assert_role, not_found};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::{accessible_library_ids, paths_visible},
    media::external_ids,
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use fliks_domain::media::kind::MediaKind;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgConnection, types::Json as Jsonb};
use std::collections::HashSet;

const DUPLICATE: &str = "errors.media_already_in_playlist";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddDto {
    episode_id: Option<i32>,
    season_id: Option<i32>,
    media_id: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReorderDto {
    item_ids: Vec<i32>,
}

/// `to_jsonb` renders timestamptz with an offset; the API wants `YYYY-MM-DDTHH:MM:SS.mmmZ`.
fn iso_times(v: &mut Value) {
    let Some(o) = v.as_object_mut() else { return };
    for k in [
        "createdAt",
        "updatedAt",
        "metadataRefreshedAt",
        "markersScannedAt",
    ] {
        let parsed = o
            .get(k)
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok());
        if let Some(t) = parsed {
            o.insert(
                k.into(),
                fliks_domain::js::iso(t.with_timezone(&Utc)).into(),
            );
        }
    }
}

/// `path.join(base, rest)` for the `Media.path` getter.
fn node_join(base: &str, rest: &str) -> String {
    let abs = base.starts_with('/');
    let mut parts: Vec<&str> = vec![];
    for seg in base.split('/').chain(rest.split('/')) {
        match seg {
            "" | "." => {}
            ".." if parts.last().is_some_and(|p| *p != "..") => {
                parts.pop();
            }
            ".." if abs => {}
            s => parts.push(s),
        }
    }
    let joined = parts.join("/");
    match (abs, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".into(),
        _ => joined,
    }
}

struct Joined {
    media: Value,
    library: Value,
    quality: Option<Value>,
    language: Option<Value>,
    metadata: Option<Value>,
}

/// The `Media` entity with its eager relations, absolute paths dropped.
fn media_json(j: Joined, paths: bool) -> Value {
    let (mut media, mut library) = (j.media, j.library);
    iso_times(&mut media);
    iso_times(&mut library);
    let lib_path = library["path"]
        .as_str()
        .filter(|p| !p.is_empty())
        .map(String::from);
    let path = lib_path.map(
        |lp| match media["folderName"].as_str().filter(|f| !f.is_empty()) {
            Some(f) => node_join(&lp, f),
            None => lp,
        },
    );
    if !paths && let Some(l) = library.as_object_mut() {
        l.remove("path");
    }
    let rel = |v: Option<Value>| {
        v.map(|mut v| {
            iso_times(&mut v);
            v
        })
        .unwrap_or(Value::Null)
    };
    let metadata = j.metadata.map(|mut m| {
        iso_times(&mut m);
        for k in ["budget", "revenue"] {
            if let Some(n) = m.get(k).filter(|n| n.is_number()).map(Value::to_string) {
                m[k] = n.into();
            }
        }
        m
    });
    let o = media.as_object_mut().expect("media is an object");
    o.insert("library".into(), library);
    o.insert("qualityProfile".into(), rel(j.quality));
    o.insert("languageProfile".into(), rel(j.language));
    o.insert("metadata".into(), metadata.unwrap_or(Value::Null));
    if paths {
        o.insert("path".into(), path.into());
    }
    media
}

fn progress(completed: Option<bool>, position: Option<f64>, duration: Option<f64>) -> (i64, bool) {
    match (completed, position, duration) {
        (None, ..) => (0, false),
        (Some(true), ..) => (100, true),
        (_, Some(p), Some(d)) if d > 0.0 => ((p / d * 100.0).round().min(100.0) as i64, false),
        _ => (0, false),
    }
}

#[utoipa::path(get, path = "/api/playlists/{id}/items", responses((status = 200)))]
pub async fn items(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<Json<Vec<Value>>, AppError> {
    assert_role(&st.db, a.user.id, id, Role::Viewer).await?;
    let accessible = accessible_library_ids(&st.db, &a).await?;
    let paths = paths_visible(&a.perms);
    let rows = sqlx::query!(
        r#"SELECT pi.id AS item_id, pi.position, pi."addedById" AS added_by_id,
                  (to_jsonb(m) - 'searchVector') || jsonb_build_object(
                    'tmdbId', ids.tmdb, 'imdbId', ids.imdb, 'tvdbId', ids.tvdb,
                    'tmdbCollectionId', coll.tmdb_id, 'tmdbCollectionName', coll.name,
                    'releaseDate', dates.release_date, 'inCinemas', dates.cinema_date,
                    'digitalRelease', dates.digital_date, 'physicalRelease', dates.physical_date,
                    'qualityProfileId', w."qualityProfileId", 'minimumAvailability', w."minimumAvailability") AS "media!: Jsonb<Value>",
                  to_jsonb(l) AS "library!: Jsonb<Value>",
                  to_jsonb(q) - 'family' AS "quality: Jsonb<Value>",
                  to_jsonb(lp) AS "language: Jsonb<Value>",
                  COALESCE(to_jsonb(md) - 'mediaId' - 'kind',
                    (to_jsonb(sd) - 'mediaId' - 'kind') || jsonb_build_object('budget', NULL, 'revenue', NULL))
                    AS "metadata: Jsonb<Value>",
                  CASE WHEN e."groupId" IS NOT NULL THEN jsonb_build_object(
                    'id', e.id, 'createdAt', e."createdAt", 'updatedAt', e."updatedAt",
                    'episodeNumber', e."number", 'endEpisodeNumber', e."endNumber", 'title', e.title,
                    'overview', e.overview, 'airDate', e."airDate", 'runtime', e.runtime,
                    'monitored', e.monitored, 'hasFile', EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id), 'stillUrl', e."stillUrl",
                    'markersScannedAt', e."markersScannedAt", 'seasonId', e."groupId") END AS "episode: Jsonb<Value>",
                  CASE WHEN s.id IS NOT NULL THEN jsonb_build_object(
                    'id', s.id, 'createdAt', s."createdAt", 'updatedAt', s."updatedAt",
                    'seasonNumber', s."number", 'monitored', s.monitored,
                    'preferredProvider', s."preferredProvider", 'mediaId', s."mediaId",
                    'posterUrl', s."posterUrl", 'overview', s.overview, 'airDate', s."airDate") END AS "season: Jsonb<Value>",
                  ps.completed AS "completed?", ps."positionSeconds" AS "position_seconds?",
                  ps."durationSeconds" AS duration_seconds
           FROM playlist_items pi
           JOIN items e ON e.id = pi."itemId"
           JOIN media m ON m.id = e."mediaId"
           JOIN libraries l ON l.id = m."libraryId" AND l.id = ANY($2)
           LEFT JOIN LATERAL (SELECT max(value) FILTER (WHERE provider = $4)::int AS tmdb,
             max(value) FILTER (WHERE provider = $5)::int AS tvdb,
             max(value) FILTER (WHERE provider = $6) AS imdb
           FROM media_external_ids WHERE "mediaId" = m.id) ids ON true
           LEFT JOIN LATERAL (SELECT max(date) FILTER (WHERE kind = 'cinema') AS cinema_date,
                        max(date) FILTER (WHERE kind = 'digital') AS digital_date,
                        max(date) FILTER (WHERE kind = 'physical') AS physical_date,
                        max(date) FILTER (WHERE kind = 'release') AS release_date
                      FROM media_release_dates WHERE "mediaId" = m.id) dates ON true
           LEFT JOIN wants w ON w."mediaId" = m.id AND w.family = 'video'
           LEFT JOIN quality_profiles q ON q.id = w."qualityProfileId"
           LEFT JOIN language_profiles lp ON lp.id = m."languageProfileId"
           LEFT JOIN movie_details md ON md."mediaId" = m.id
           LEFT JOIN series_details sd ON sd."mediaId" = m.id
           LEFT JOIN LATERAL (SELECT c.id AS cid, x.value::int AS tmdb_id, NULLIF(c.name, '') AS name
             FROM collection_entries e JOIN collections c ON c.id = e."collectionId"
             JOIN collection_external_ids x ON x."collectionId" = c.id AND x.provider = 'tmdb'
             WHERE e."mediaId" = m.id ORDER BY c.id LIMIT 1) coll ON true
           LEFT JOIN item_groups s ON s.id = e."groupId"
           LEFT JOIN playback_states ps ON ps."userId" = $3 AND ps."itemId" = pi."itemId"
           WHERE pi."playlistId" = $1
           ORDER BY pi.position, pi.id"#,
        id,
        &accessible,
        a.user.id,
        external_ids::TMDB,
        external_ids::TVDB,
        external_ids::IMDB
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| {
                let (percent, watched) =
                    progress(r.completed, r.position_seconds, r.duration_seconds);
                let episode = r.episode.map(|Jsonb(mut e)| {
                    iso_times(&mut e);
                    let mut season = r.season.map(|s| s.0).unwrap_or(Value::Null);
                    iso_times(&mut season);
                    e["season"] = season;
                    e
                });
                let media = media_json(
                    Joined {
                        media: r.media.0,
                        library: r.library.0,
                        quality: r.quality.map(|j| j.0),
                        language: r.language.map(|j| j.0),
                        metadata: r.metadata.map(|j| j.0),
                    },
                    paths,
                );
                json!({
                    "itemId": r.item_id, "position": r.position, "addedById": r.added_by_id,
                    "media": media, "episode": episode,
                    "progressPercent": percent, "watched": watched,
                })
            })
            .collect(),
    ))
}

async fn assert_series(c: &mut PgConnection, id: i32, accessible: &[i32]) -> Result<(), AppError> {
    let ok = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM media WHERE id = $1 AND type = ANY($3) AND "libraryId" = ANY($2)) AS "e!""#,
        id,
        accessible,
        &MediaKind::seasonal_names() as &[&str]
    )
    .fetch_one(c)
    .await?;
    ok.then_some(())
        .ok_or_else(|| AppError::not_found(format!("Series #{id} not found")))
}

/// The items to insert and whether the add is a season/series expansion (rule 29).
async fn resolve(
    c: &mut PgConnection,
    dto: &AddDto,
    accessible: &[i32],
) -> Result<(Vec<i32>, bool), AppError> {
    if let Some(episode) = dto.episode_id {
        let series = sqlx::query_scalar!(
            r#"SELECT s."mediaId" AS "media_id!" FROM items e JOIN item_groups s ON s.id = e."groupId"
           WHERE e.id = $1 AND s."mediaId" IS NOT NULL"#,
            episode
        )
        .fetch_optional(&mut *c)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Episode #{episode} not found")))?;
        assert_series(c, series, accessible).await?;
        return Ok((vec![episode], false));
    }
    if let Some(season) = dto.season_id {
        let eps = sqlx::query!(
            r#"SELECT e.id, s."mediaId" AS "media_id!" FROM items e JOIN item_groups s ON s.id = e."groupId"
               WHERE s.id = $1 AND s."mediaId" IS NOT NULL ORDER BY e."number", e.id"#,
            season
        )
        .fetch_all(&mut *c)
        .await?;
        let Some(first) = eps.first() else {
            return Ok((vec![], true));
        };
        assert_series(c, first.media_id, accessible).await?;
        return Ok((eps.iter().map(|e| e.id).collect(), true));
    }
    let Some(media) = dto.media_id else {
        return Err(AppError::bad_request("errors.playlist_add_target_required"));
    };
    let kind = sqlx::query_scalar!(
        r#"SELECT type AS "kind!" FROM media WHERE id = $1 AND "libraryId" = ANY($2)"#,
        media,
        accessible
    )
    .fetch_optional(&mut *c)
    .await?
    .ok_or_else(|| AppError::not_found(format!("Media #{media} not found")))?;
    if !crate::db::kind(&kind)?.has_seasons() {
        let item = sqlx::query_scalar!(r#"SELECT item_of($1, NULL) AS "item""#, media)
            .fetch_one(&mut *c)
            .await?
            .ok_or_else(|| AppError::not_found(format!("Media #{media} not found")))?;
        return Ok((vec![item], false));
    }
    let eps = sqlx::query_scalar!(
        r#"SELECT e.id FROM items e JOIN item_groups s ON s.id = e."groupId"
           WHERE s."mediaId" = $1 ORDER BY s."number", e."number", e.id"#,
        media
    )
    .fetch_all(&mut *c)
    .await?;
    Ok((eps, true))
}

async fn lock(c: &mut PgConnection, id: i32) -> Result<(), AppError> {
    sqlx::query!("SELECT id FROM playlists WHERE id = $1 FOR UPDATE", id)
        .fetch_optional(c)
        .await?
        .map(drop)
        .ok_or_else(|| not_found(id))
}

async fn touch(c: &mut PgConnection, id: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE playlists SET "updatedAt" = now() WHERE id = $1"#,
        id
    )
    .execute(c)
    .await
    .map(drop)
}

#[utoipa::path(post, path = "/api/playlists/{id}/items", responses((status = 201)))]
pub async fn add_item(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(dto): ValidJson<AddDto>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    assert_role(&st.db, a.user.id, id, Role::Editor).await?;
    let accessible = accessible_library_ids(&st.db, &a).await?;
    let mut tx = st.db.begin().await?;
    lock(&mut tx, id).await?;
    let (targets, bulk) = resolve(&mut tx, &dto, &accessible).await?;
    let added = |n: usize| Ok((StatusCode::CREATED, Json(json!({"added": n}))));
    if targets.is_empty() {
        return added(0);
    }
    let present: HashSet<i32> = sqlx::query_scalar!(
        r#"SELECT "itemId" FROM playlist_items WHERE "playlistId" = $1"#,
        id
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();
    let fresh: Vec<i32> = targets
        .into_iter()
        .filter(|t| !present.contains(t))
        .collect();
    if fresh.is_empty() {
        return if bulk {
            added(0)
        } else {
            Err(AppError::bad_request(DUPLICATE))
        };
    }
    sqlx::query!(
        r#"INSERT INTO playlist_items ("playlistId", "itemId", "addedById", position)
           SELECT $1, t.i, $2,
                  (COALESCE((SELECT MAX(position) + 1 FROM playlist_items WHERE "playlistId" = $1), 0) + t.n - 1)::int
           FROM unnest($3::int[]) WITH ORDINALITY AS t(i, n)"#,
        id,
        a.user.id,
        &fresh
    )
    .execute(&mut *tx)
    .await?;
    touch(&mut tx, id).await?;
    tx.commit().await?;
    added(fresh.len())
}

#[utoipa::path(delete, path = "/api/playlists/{id}/items/{itemId}", responses((status = 200)))]
pub async fn remove_item(
    State(st): State<AppState>,
    a: Authed,
    PathParams((id, item)): PathParams<(i32, i32)>,
) -> Result<(), AppError> {
    assert_role(&st.db, a.user.id, id, Role::Editor).await?;
    let mut tx = st.db.begin().await?;
    let gone = sqlx::query!(
        r#"DELETE FROM playlist_items WHERE id = $2 AND "playlistId" = $1"#,
        id,
        item
    )
    .execute(&mut *tx)
    .await?;
    if gone.rows_affected() == 0 {
        return Err(AppError::not_found(format!(
            "Playlist item #{item} not found"
        )));
    }
    touch(&mut tx, id).await?;
    tx.commit().await?;
    Ok(())
}

#[utoipa::path(delete, path = "/api/playlists/{id}/items/by-media/{mediaId}", responses((status = 200)))]
pub async fn remove_by_media(
    State(st): State<AppState>,
    a: Authed,
    PathParams((id, media)): PathParams<(i32, i32)>,
) -> Result<Json<Value>, AppError> {
    assert_role(&st.db, a.user.id, id, Role::Editor).await?;
    let mut tx = st.db.begin().await?;
    let removed = sqlx::query!(
        r#"DELETE FROM playlist_items
           WHERE "playlistId" = $1 AND "itemId" IN (SELECT id FROM items WHERE "mediaId" = $2)"#,
        id,
        media
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if removed > 0 {
        touch(&mut tx, id).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"removed": removed})))
}

#[utoipa::path(put, path = "/api/playlists/{id}/items/order", responses((status = 200)))]
pub async fn reorder(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(dto): ValidJson<ReorderDto>,
) -> Result<(), AppError> {
    assert_role(&st.db, a.user.id, id, Role::Editor).await?;
    let mut tx = st.db.begin().await?;
    lock(&mut tx, id).await?;
    let current: HashSet<i32> = sqlx::query_scalar!(
        r#"SELECT id FROM playlist_items WHERE "playlistId" = $1"#,
        id
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .collect();
    let wanted: HashSet<i32> = dto.item_ids.iter().copied().collect();
    if wanted.len() != dto.item_ids.len() || wanted != current {
        return Err(AppError::bad_request(
            "itemIds must list every item in the playlist exactly once",
        ));
    }
    sqlx::query!(
        r#"UPDATE playlist_items pi SET position = (t.n - 1)::int
           FROM unnest($1::int[]) WITH ORDINALITY AS t(id, n) WHERE pi.id = t.id"#,
        &dto.item_ids
    )
    .execute(&mut *tx)
    .await?;
    touch(&mut tx, id).await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_rounds_half_up_and_caps() {
        assert_eq!(progress(None, None, None), (0, false));
        assert_eq!(progress(Some(true), Some(1.0), Some(100.0)), (100, true));
        assert_eq!(progress(Some(false), Some(1.0), Some(8.0)), (13, false));
        assert_eq!(
            progress(Some(false), Some(500.0), Some(100.0)),
            (100, false)
        );
        assert_eq!(progress(Some(false), Some(5.0), Some(0.0)), (0, false));
    }

    #[test]
    fn node_join_normalises_like_path_join() {
        assert_eq!(node_join("/a/b", "c (2020)"), "/a/b/c (2020)");
        assert_eq!(node_join("/a/b/", "../c"), "/a/c");
        assert_eq!(node_join("/a", "../../c"), "/c");
    }
}

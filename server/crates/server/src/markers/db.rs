//! Queries of `docs/spec/markers.md` (SQL section).
use crate::{events::Num, http::json::iso_ms};
use chrono::{DateTime, Utc};
use fliks_domain::media::kind::MediaKind;
use serde::{Serialize, Serializer};
use serde_json::Value;
use sqlx::PgPool;

fn num<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    Num(*v).serialize(s)
}

/// `Marker` of the contract; whole numbers print as integers, like JSON.stringify.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub r#type: String,
    #[serde(serialize_with = "num")]
    pub start_seconds: f64,
    #[serde(serialize_with = "num")]
    pub end_seconds: f64,
    #[serde(serialize_with = "num")]
    pub confidence: f64,
    pub manual: bool,
    pub episode_id: Option<i32>,
}

pub async fn for_episode(db: &PgPool, episode: i32) -> sqlx::Result<Vec<Marker>> {
    sqlx::query_as!(
        Marker,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, kind AS "type!",
                  "startSeconds" AS start_seconds, "endSeconds" AS end_seconds, confidence,
                  manual, "itemId" AS episode_id
           FROM item_markers WHERE "itemId" = $1 AND kind <> 'chapter'
           ORDER BY "startSeconds", id"#,
        episode
    )
    .fetch_all(db)
    .await
}

pub async fn for_season(db: &PgPool, season: i32) -> sqlx::Result<Vec<Marker>> {
    sqlx::query_as!(
        Marker,
        r#"SELECT m.id, m."createdAt" AS created_at, m."updatedAt" AS updated_at, m.kind AS "type!",
                  m."startSeconds" AS start_seconds, m."endSeconds" AS end_seconds, m.confidence,
                  m.manual, m."itemId" AS episode_id
           FROM item_markers m JOIN items e ON e.id = m."itemId"
           WHERE e."groupId" = $1 AND m.kind <> 'chapter'
           ORDER BY m."itemId", m."startSeconds", m.id"#,
        season
    )
    .fetch_all(db)
    .await
}

pub async fn find(db: &PgPool, id: i32) -> sqlx::Result<Option<Marker>> {
    sqlx::query_as!(
        Marker,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, kind AS "type!",
                  "startSeconds" AS start_seconds, "endSeconds" AS end_seconds, confidence,
                  manual, "itemId" AS episode_id
           FROM item_markers WHERE id = $1 AND kind <> 'chapter'"#,
        id
    )
    .fetch_optional(db)
    .await
}

/// `Some(libraryId)` (itself possibly NULL) when the episode exists.
pub async fn episode_library(db: &PgPool, episode: i32) -> sqlx::Result<Option<Option<i32>>> {
    let row = sqlx::query_scalar!(
        r#"SELECT m."libraryId" FROM items e
           JOIN item_groups s ON s.id = e."groupId" JOIN media m ON m.id = s."mediaId"
           WHERE e.id = $1"#,
        episode
    )
    .fetch_optional(db)
    .await?;
    Ok(row)
}

pub async fn season_library(db: &PgPool, season: i32) -> sqlx::Result<Option<Option<i32>>> {
    let row = sqlx::query_scalar!(
        r#"SELECT m."libraryId" FROM item_groups s JOIN media m ON m.id = s."mediaId" WHERE s.id = $1"#,
        season
    )
    .fetch_optional(db)
    .await?;
    Ok(row)
}

pub async fn episode_exists(db: &PgPool, episode: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar!(
        r#"SELECT id FROM items WHERE id = $1 AND "groupId" IS NOT NULL"#,
        episode
    )
    .fetch_optional(db)
    .await
    .map(|r| r.is_some())
}

/// A manual marker replaces the `(item, kind)` one in one statement.
pub async fn upsert_manual(
    db: &PgPool,
    episode: i32,
    kind: &str,
    start: f64,
    end: f64,
) -> sqlx::Result<Marker> {
    let id = sqlx::query_scalar!(
        r#"INSERT INTO item_markers ("itemId", kind, "startSeconds", "endSeconds", confidence, manual)
           VALUES ($1, $2, $3, $4, 1, true)
           ON CONFLICT ("itemId", kind) WHERE kind <> 'chapter' DO UPDATE SET "startSeconds" = EXCLUDED."startSeconds",
             "endSeconds" = EXCLUDED."endSeconds", confidence = 1, manual = true
           RETURNING id"#,
        episode,
        kind,
        start,
        end
    )
    .fetch_one(db)
    .await?;
    Ok(find(db, id).await?.expect("marker just written"))
}

pub async fn set_range(db: &PgPool, id: i32, start: f64, end: f64) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE item_markers SET "startSeconds" = $2, "endSeconds" = $3, manual = true, confidence = 1
           WHERE id = $1 AND kind <> 'chapter'"#,
        id,
        start,
        end
    )
    .execute(db)
    .await
    .map(drop)
}

pub async fn delete(db: &PgPool, id: i32) -> sqlx::Result<bool> {
    sqlx::query!(
        "DELETE FROM item_markers WHERE id = $1 AND kind <> 'chapter'",
        id
    )
    .execute(db)
    .await
    .map(|r| r.rows_affected() > 0)
}

pub struct SeasonInfo {
    pub media_id: i32,
    pub season_number: i32,
    pub media_title: String,
}

pub async fn season_info(db: &PgPool, season: i32) -> sqlx::Result<Option<SeasonInfo>> {
    let Some(r) = sqlx::query!(
        r#"SELECT s."mediaId" AS media_id, s."number" AS season_number, m.title AS "title?"
           FROM item_groups s LEFT JOIN media m ON m.id = s."mediaId"
           WHERE s.id = $1"#,
        season
    )
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    let media_id = r.media_id;
    Ok(Some(SeasonInfo {
        media_id,
        season_number: r.season_number,
        media_title: r.title.unwrap_or_else(|| format!("media #{media_id}")),
    }))
}

pub async fn season_numbers(db: &PgPool, media: i32) -> sqlx::Result<Vec<(i32, i32)>> {
    let rows = sqlx::query!(
        r#"SELECT id, "number" AS season_number FROM item_groups WHERE "mediaId" = $1
           ORDER BY "number", id"#,
        media
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.id, r.season_number)).collect())
}

pub async fn media_exists(db: &PgPool, media: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar!("SELECT id FROM media WHERE id = $1", media)
        .fetch_optional(db)
        .await
        .map(|r| r.is_some())
}

#[derive(Debug, PartialEq)]
pub struct ScanSeason {
    pub id: i32,
    pub media_id: i32,
    pub season_number: i32,
    pub media_title: String,
    pub kind: MediaKind,
}

pub async fn seasons_for_scan(
    db: &PgPool,
    only_missing: bool,
    media: Option<i32>,
) -> sqlx::Result<Vec<ScanSeason>> {
    let rows = sqlx::query!(
        r#"SELECT s.id, s."mediaId" AS "media_id!", s."number" AS season_number, m.title AS "title!", m.type AS "kind!"
           FROM item_groups s JOIN media m ON m.id = s."mediaId"
           WHERE s."number" > 0
             AND ($1::int IS NULL OR s."mediaId" = $1)
             AND (NOT $2 OR EXISTS (SELECT 1 FROM items e WHERE e."groupId" = s.id
                                    AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
                                    AND e."markersScannedAt" IS NULL))
           ORDER BY m.title ASC, s."number" ASC, s.id ASC"#,
        media,
        only_missing
    )
    .fetch_all(db)
    .await?;
    rows.into_iter()
        .map(|r| {
            Ok(ScanSeason {
                id: r.id,
                media_id: r.media_id,
                season_number: r.season_number,
                media_title: r.title,
                kind: crate::db::kind(&r.kind)?,
            })
        })
        .collect()
}

pub struct EpisodeFile {
    pub episode_id: i32,
    pub episode_number: i32,
    pub file_id: Option<i32>,
    pub folder_path: Option<String>,
    pub relative_path: Option<String>,
    pub info: Option<Value>,
}

/// Episodes of the season with a file, by episode number; each with its highest-id file.
pub async fn episodes_with_files(db: &PgPool, season: i32) -> sqlx::Result<Vec<EpisodeFile>> {
    let rows = sqlx::query!(
        r#"SELECT "id!", "number!", "file_id?", "folder?", "rel?", "info?" FROM (
             SELECT DISTINCT ON (e.id) e.id AS "id!", e."number" AS "number!", f.id AS "file_id?",
                    lf.path AS "folder?", f."relativePath" AS "rel?", f."streamInfo" AS "info?"
             FROM items e JOIN media_file_items fi ON fi."episodeId" = e.id
             JOIN media_files f ON f.id = fi."mediaFileId"
             JOIN library_folders lf ON lf.id = f."folderId"
             WHERE e."groupId" = $1 ORDER BY e.id, f.id DESC) x
           ORDER BY "number!", "id!""#,
        season
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| EpisodeFile {
            episode_id: r.id,
            episode_number: r.number,
            file_id: r.file_id,
            folder_path: r.folder,
            relative_path: r.rel,
            info: r.info,
        })
        .collect())
}

pub async fn manual_episodes(db: &PgPool, episodes: &[i32], kind: &str) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar!(
        r#"SELECT "itemId" AS "episode_id!" FROM item_markers
           WHERE "itemId" = ANY($1) AND kind = $2 AND manual = true"#,
        episodes,
        kind
    )
    .fetch_all(db)
    .await
}

/// A marker made manual during the run is never overwritten.
pub async fn upsert_detected(
    db: &PgPool,
    episode: i32,
    kind: &str,
    start: f64,
    end: f64,
    confidence: f64,
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO item_markers ("itemId", kind, "startSeconds", "endSeconds", confidence, manual)
           VALUES ($1, $2, $3, $4, $5, false)
           ON CONFLICT ("itemId", kind) WHERE kind <> 'chapter' DO UPDATE SET "startSeconds" = EXCLUDED."startSeconds",
             "endSeconds" = EXCLUDED."endSeconds", confidence = EXCLUDED.confidence, manual = false
           WHERE item_markers.manual = false"#,
        episode,
        kind,
        start,
        end,
        confidence
    )
    .execute(db)
    .await
    .map(drop)
}

pub async fn stamp_scanned(db: &PgPool, season: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE items SET "markersScannedAt" = now() WHERE "groupId" = $1
           AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = items.id)"#,
        season
    )
    .execute(db)
    .await
    .map(drop)
}

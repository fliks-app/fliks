//! Playback state queries (`docs/spec/playback-state.md` SQL section).
use crate::http::{AppError, json::iso_ms};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;

const RESUME_FROM_START_UNDER_SECONDS: f64 = 10.0;
const CONTINUE_MAX: usize = 20;

/// The `PlaybackState` entity as loaded.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateRow {
    pub(crate) id: i32,
    #[serde(with = "iso_ms")]
    pub(super) created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub(super) updated_at: DateTime<Utc>,
    pub(crate) position_seconds: f64,
    pub(super) duration_seconds: Option<f64>,
    pub(crate) completed: bool,
    pub(super) hidden_from_continue_watching: bool,
    #[serde(with = "iso_ms")]
    pub(super) last_played_at: DateTime<Utc>,
    #[serde(with = "iso_ms::opt")]
    pub(super) played_at: Option<DateTime<Utc>>,
    pub(super) user_id: Option<i32>,
    pub(super) media_id: Option<i32>,
    pub(super) media_file_id: Option<i32>,
    pub(super) episode_id: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeInfo {
    media_file_id: Option<i32>,
    episode_id: Option<i32>,
    position_seconds: f64,
    duration_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    season_number: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    episode_number: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueItem {
    id: i32,
    media_id: i32,
    media_file_id: Option<i32>,
    episode_id: Option<i32>,
    position_seconds: f64,
    duration_seconds: Option<f64>,
    #[serde(with = "iso_ms")]
    last_played_at: DateTime<Utc>,
    media_title: String,
    media_type: String,
    poster_url: Option<String>,
    fanart_url: Option<String>,
    still_url: Option<String>,
    episode_label: Option<String>,
    progress_percent: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    id: i32,
    media_id: i32,
    media_file_id: Option<i32>,
    episode_id: Option<i32>,
    position_seconds: f64,
    duration_seconds: Option<f64>,
    completed: bool,
    #[serde(with = "iso_ms")]
    last_played_at: DateTime<Utc>,
    media_title: String,
    media_type: String,
    poster_url: Option<String>,
    fanart_url: Option<String>,
    still_url: Option<String>,
    progress_percent: f64,
    episode_label: Option<String>,
}

#[derive(Serialize)]
pub struct History {
    pub data: Vec<HistoryItem>,
    total: i64,
}

/// An unknown media, episode or file is a 404, never a foreign-key 500.
pub(super) fn fk(e: sqlx::Error) -> AppError {
    match &e {
        sqlx::Error::Database(d) if d.code().as_deref() == Some("23503") => {
            AppError::not_found("not_found")
        }
        _ => e.into(),
    }
}

/// The movie row when `episode` is `None`.
pub async fn find_state(
    db: &PgPool,
    user: i32,
    media: i32,
    episode: Option<i32>,
) -> sqlx::Result<Option<StateRow>> {
    sqlx::query_as!(
        StateRow,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at,
                  "positionSeconds" AS position_seconds, "durationSeconds" AS duration_seconds,
                  completed, "hiddenFromContinueWatching" AS hidden_from_continue_watching,
                  "lastPlayedAt" AS last_played_at, "playedAt" AS played_at,
                  "userId" AS user_id, "mediaId" AS media_id, "mediaFileId" AS media_file_id,
                  "episodeId" AS episode_id
           FROM playback_states
           WHERE "userId" = $1 AND "mediaId" = $2 AND "episodeId" IS NOT DISTINCT FROM $3"#,
        user,
        media,
        episode
    )
    .fetch_optional(db)
    .await
}

pub async fn delete_state(
    db: &PgPool,
    user: i32,
    media: i32,
    episode: Option<i32>,
) -> sqlx::Result<()> {
    if let Some(s) = find_state(db, user, media, episode).await? {
        sqlx::query!("DELETE FROM playback_states WHERE id = $1", s.id)
            .execute(db)
            .await?;
    }
    Ok(())
}

pub async fn resume_info(db: &PgPool, user: i32, media: i32) -> sqlx::Result<Option<ResumeInfo>> {
    let row = sqlx::query!(
        r#"SELECT
             ps."mediaFileId" AS media_file_id, ps."episodeId" AS episode_id,
             ps."positionSeconds" AS position_seconds, ps."durationSeconds" AS duration_seconds,
             s."number" AS "season_number?", e."number" AS "episode_number?"
           FROM playback_states ps
           LEFT JOIN items e ON e.id = ps."episodeId"
           LEFT JOIN item_groups s ON s.id = e."groupId"
           WHERE ps."userId" = $1
             AND ps."mediaId" = $2
             AND ps.completed = false
             AND ps."positionSeconds" > 0
           ORDER BY ps."lastPlayedAt" DESC
           LIMIT 1"#,
        user,
        media
    )
    .fetch_optional(db)
    .await?;
    Ok(row.map(|r| ResumeInfo {
        media_file_id: r.media_file_id,
        episode_id: r.episode_id,
        position_seconds: if r.position_seconds < RESUME_FROM_START_UNDER_SECONDS {
            0.0
        } else {
            r.position_seconds
        },
        duration_seconds: r.duration_seconds.unwrap_or(0.0),
        season_number: r.season_number,
        episode_number: r.episode_number,
    }))
}

pub async fn watched_episodes(db: &PgPool, user: i32, media: i32) -> sqlx::Result<Vec<i32>> {
    Ok(sqlx::query_scalar!(
        r#"SELECT DISTINCT ps."episodeId"
           FROM playback_states ps
           WHERE ps."userId" = $1 AND ps."mediaId" = $2
             AND ps.completed = true AND ps."episodeId" IS NOT NULL"#,
        user,
        media
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .flatten()
    .collect())
}

/// `(episodeId, percent)` of in-progress episodes, strictly between 0 and 100.
pub async fn episode_progress(db: &PgPool, user: i32, media: i32) -> sqlx::Result<Vec<(i32, f64)>> {
    Ok(sqlx::query!(
        r#"SELECT ps."episodeId" AS episode_id,
                  ROUND((ps."positionSeconds" / ps."durationSeconds") * 100) AS percent
           FROM playback_states ps
           WHERE ps."userId" = $1 AND ps."mediaId" = $2
             AND ps."episodeId" IS NOT NULL
             AND ps.completed = false
             AND ps."durationSeconds" > 0
             AND ps."positionSeconds" > 0"#,
        user,
        media
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .filter_map(|r| Some((r.episode_id?, r.percent?)))
    .filter(|(_, p)| *p > 0.0 && *p < 100.0)
    .collect())
}

/// Movies and series "next up" merged, newest first. `libs` is the accessible scope (never empty).
pub async fn continue_watching(
    db: &PgPool,
    user: i32,
    libs: &[i32],
) -> sqlx::Result<Vec<ContinueItem>> {
    if libs.is_empty() {
        return Ok(vec![]);
    }
    let mut items = sqlx::query_as!(
        ContinueItem,
        r#"SELECT
             ps.id, ps."mediaId" AS "media_id!", ps."mediaFileId" AS media_file_id,
             ps."episodeId" AS episode_id,
             ps."positionSeconds" AS position_seconds, ps."durationSeconds" AS duration_seconds,
             ps."lastPlayedAt" AS last_played_at,
             m.title AS media_title, m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url,
             'movie'::text AS "media_type!",
             NULL::text AS still_url, NULL::text AS episode_label,
             CASE WHEN ps."durationSeconds" > 0
                  THEN ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)
                  ELSE 0 END AS "progress_percent!"
           FROM playback_states ps
           JOIN media m ON m.id = ps."mediaId"
           WHERE ps."userId" = $1
             AND ps.completed = false
             AND ps."hiddenFromContinueWatching" = false
             AND ps."positionSeconds" >= 5
             AND m.type = 'movie' AND m."libraryId" = ANY($2)
           ORDER BY ps."lastPlayedAt" DESC"#,
        user,
        libs
    )
    .fetch_all(db)
    .await?;
    let series = sqlx::query_as!(
        ContinueItem,
        r#"WITH user_series AS (
             SELECT DISTINCT ON (ps."mediaId")
                    ps."mediaId", ps."lastPlayedAt"
             FROM playback_states ps
             JOIN media m ON m.id = ps."mediaId"
             WHERE ps."userId" = $1 AND m.type = 'series'
               AND ps."hiddenFromContinueWatching" = false
             ORDER BY ps."mediaId", ps."lastPlayedAt" DESC
           ),
           last_completed AS (
             -- Highest (seasonNumber, episodeNumber) among completed episodes: lastPlayedAt ties
             -- when the user bulk-marks a season.
             SELECT DISTINCT ON (ps."mediaId")
                    ps."mediaId", ps."episodeId",
                    s."number" AS "seasonNumber", e."number" AS "episodeNumber"
             FROM playback_states ps
             JOIN items e ON e.id = ps."episodeId"
             JOIN item_groups s ON s.id = e."groupId"
             WHERE ps."userId" = $1 AND ps.completed = true AND ps."episodeId" IS NOT NULL
             ORDER BY ps."mediaId", s."number" DESC, e."number" DESC
           ),
           in_progress AS (
             SELECT DISTINCT ON (ps."mediaId")
                    ps."mediaId", ps."episodeId", ps."mediaFileId",
                    ps."positionSeconds", ps."durationSeconds"
             FROM playback_states ps
             WHERE ps."userId" = $1
               AND ps.completed = false AND ps."positionSeconds" >= 5
               AND ps."episodeId" IS NOT NULL
             ORDER BY ps."mediaId", ps."lastPlayedAt" DESC
           ),
           next_ep AS (
             SELECT lc."mediaId",
                    (SELECT e.id FROM items e
                     JOIN item_groups s ON s.id = e."groupId"
                     WHERE s."mediaId" = lc."mediaId" AND s."number" > 0
                       AND (s."number" > lc."seasonNumber"
                            OR (s."number" = lc."seasonNumber" AND e."number" > lc."episodeNumber"))
                     ORDER BY s."number", e."number" LIMIT 1
                    ) AS "episodeId"
             FROM last_completed lc
             WHERE lc."mediaId" NOT IN (SELECT "mediaId" FROM in_progress)
           ),
           combined AS (
             SELECT ip."mediaId", ip."episodeId", ip."mediaFileId", ip."positionSeconds", ip."durationSeconds"
             FROM in_progress ip
             UNION ALL
             SELECT ne."mediaId", ne."episodeId", NULL::int AS "mediaFileId", 0.0 AS "positionSeconds", 0.0 AS "durationSeconds"
             FROM next_ep ne WHERE ne."episodeId" IS NOT NULL
           )
           SELECT
             COALESCE(ps_next.id, 0) AS "id!",
             c."mediaId" AS "media_id!",
             COALESCE(c."mediaFileId", mf.id) AS media_file_id,
             c."episodeId" AS episode_id,
             COALESCE(ps_next."positionSeconds", c."positionSeconds", 0) AS "position_seconds!",
             COALESCE(ps_next."durationSeconds", c."durationSeconds", 0) AS duration_seconds,
             us."lastPlayedAt" AS "last_played_at!",
             m.title AS media_title,
             m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url,
             'series'::text AS "media_type!",
             e."stillUrl" AS still_url,
             'S' || LPAD(s."number"::text, 2, '0') || 'E' || LPAD(e."number"::text, 2, '0')
               || COALESCE(' - ' || e.title, '') AS episode_label,
             CASE WHEN COALESCE(ps_next."durationSeconds", c."durationSeconds", 0) > 0
                  THEN ROUND((COALESCE(ps_next."positionSeconds", c."positionSeconds", 0)
                             / COALESCE(ps_next."durationSeconds", c."durationSeconds", 1)) * 100)
                  ELSE 0 END AS "progress_percent!"
           FROM combined c
           JOIN user_series us ON us."mediaId" = c."mediaId"
           JOIN media m ON m.id = c."mediaId"
           JOIN items e ON e.id = c."episodeId"
           JOIN item_groups s ON s.id = e."groupId"
           LEFT JOIN LATERAL (
             SELECT mf2.id FROM media_files mf2 JOIN item_parts p2 ON p2."mediaFileId" = mf2.id
             WHERE p2."itemId" = c."episodeId"
             ORDER BY mf2.id DESC LIMIT 1
           ) mf ON c."mediaFileId" IS NULL
           LEFT JOIN playback_states ps_next ON ps_next."userId" = $1 AND ps_next."mediaId" = c."mediaId" AND ps_next."episodeId" = c."episodeId"
           WHERE COALESCE(ps_next.completed, false) = false
             AND COALESCE(c."mediaFileId", mf.id) IS NOT NULL AND m."libraryId" = ANY($2)"#,
        user,
        libs
    )
    .fetch_all(db)
    .await?;
    items.extend(series);
    for i in &mut items {
        if i.position_seconds < RESUME_FROM_START_UNDER_SECONDS {
            i.position_seconds = 0.0;
            i.progress_percent = 0.0;
        }
    }
    items.sort_by_key(|i| std::cmp::Reverse(i.last_played_at.timestamp_millis()));
    items.truncate(CONTINUE_MAX);
    Ok(items)
}

pub async fn history(
    db: &PgPool,
    user: i32,
    page: i64,
    limit: i64,
    libs: &[i32],
) -> sqlx::Result<History> {
    if libs.is_empty() {
        return Ok(History {
            data: vec![],
            total: 0,
        });
    }
    let total = sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "cnt!"
           FROM playback_states ps
           WHERE ps."userId" = $1 AND ps."playedAt" IS NOT NULL
             AND EXISTS (SELECT 1 FROM media mAcl WHERE mAcl.id = ps."mediaId" AND mAcl."libraryId" = ANY($2))"#,
        user,
        libs
    )
    .fetch_one(db)
    .await?;
    let data = sqlx::query_as!(
        HistoryItem,
        r#"SELECT
             ps.id, ps."mediaId" AS "media_id!", ps."mediaFileId" AS media_file_id,
             ps."episodeId" AS episode_id,
             ps."positionSeconds" AS position_seconds, ps."durationSeconds" AS duration_seconds,
             ps.completed,
             ps."lastPlayedAt" AS last_played_at,
             m.title AS media_title, m.type AS "media_type!",
             m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url, e."stillUrl" AS still_url,
             CASE WHEN ps."durationSeconds" > 0
                  THEN ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)
                  ELSE 0 END AS "progress_percent!",
             CASE WHEN ps."episodeId" IS NOT NULL
                  THEN 'S' || LPAD(s."number"::text, 2, '0') || 'E' || LPAD(e."number"::text, 2, '0')
                       || COALESCE(' - ' || e.title, '')
                  ELSE NULL END AS episode_label
           FROM playback_states ps
           JOIN media m ON m.id = ps."mediaId"
           LEFT JOIN items e ON e.id = ps."episodeId"
           LEFT JOIN item_groups s ON s.id = e."groupId"
           WHERE ps."userId" = $1 AND ps."playedAt" IS NOT NULL
             AND m."libraryId" = ANY($4)
           ORDER BY ps."playedAt" DESC
           LIMIT $2 OFFSET $3"#,
        user,
        limit,
        (page - 1).saturating_mul(limit),
        libs
    )
    .fetch_all(db)
    .await?;
    Ok(History { data, total })
}

pub async fn watched_media_ids(db: &PgPool, user: i32, libs: &[i32]) -> sqlx::Result<Vec<i32>> {
    if libs.is_empty() {
        return Ok(vec![]);
    }
    Ok(sqlx::query_scalar!(
        r#"SELECT DISTINCT ps."mediaId" AS id
           FROM playback_states ps
           JOIN media m ON m.id = ps."mediaId"
           WHERE ps."userId" = $1 AND ps.completed = true AND m.type = 'movie'
             AND m."libraryId" = ANY($2)

           UNION

           SELECT s."mediaId" AS id
           FROM item_groups s
           JOIN items e ON e."groupId" = s.id
           LEFT JOIN playback_states ps
             ON ps."userId" = $1 AND ps."episodeId" = e.id AND ps.completed = true
           WHERE s."number" > 0 AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
             AND EXISTS (SELECT 1 FROM media m2 WHERE m2.id = s."mediaId" AND m2."libraryId" = ANY($2))
           GROUP BY s."mediaId"
           HAVING COUNT(*) > 0 AND COUNT(*) = COUNT(ps.id)"#,
        user,
        libs
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .flatten()
    .collect())
}

pub async fn hide(db: &PgPool, user: i32, media: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE playback_states SET "hiddenFromContinueWatching" = true
           WHERE "userId" = $1 AND "mediaId" = $2"#,
        user,
        media
    )
    .execute(db)
    .await
    .map(drop)
}

pub async fn dismiss(db: &PgPool, user: i32, media: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO recommendation_dismissals ("userId", "mediaId") VALUES ($1, $2)
           ON CONFLICT DO NOTHING"#,
        user,
        media
    )
    .execute(db)
    .await
    .map(drop)
}

pub async fn count_dismissals(db: &PgPool, user: i32) -> sqlx::Result<i64> {
    sqlx::query_scalar!(
        r#"SELECT COUNT(*) AS "count!" FROM recommendation_dismissals WHERE "userId" = $1"#,
        user
    )
    .fetch_one(db)
    .await
}

pub async fn reset_dismissals(db: &PgPool, user: i32) -> sqlx::Result<u64> {
    sqlx::query!(
        r#"DELETE FROM recommendation_dismissals WHERE "userId" = $1"#,
        user
    )
    .execute(db)
    .await
    .map(|r| r.rows_affected())
}

pub async fn media_exists(db: &PgPool, media: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM media WHERE id = $1) AS "e!""#,
        media
    )
    .fetch_one(db)
    .await
}

/// `Some(mediaId)` of an existing season.
pub async fn season_media(db: &PgPool, season: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!(r#"SELECT "mediaId" FROM item_groups WHERE id = $1"#, season)
        .fetch_optional(db)
        .await
}

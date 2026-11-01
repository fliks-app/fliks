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
    pub(super) user_id: i32,
    pub(super) media_id: i32,
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

/// The item a `(mediaId, episodeId?)` pair names; `None` for an unknown or mismatched pair.
pub async fn item_of(db: &PgPool, media: i32, episode: Option<i32>) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!(r#"SELECT item_of($1, $2) AS "item""#, media, episode)
        .fetch_one(db)
        .await
}

pub async fn find_state(db: &PgPool, user: i32, item: i32) -> sqlx::Result<Option<StateRow>> {
    sqlx::query_as!(
        StateRow,
        r#"SELECT ps.id, ps."createdAt" AS created_at, ps."updatedAt" AS updated_at,
                  ps."positionSeconds" AS position_seconds, ps."durationSeconds" AS duration_seconds,
                  ps.completed, ps."hiddenFromContinueWatching" AS hidden_from_continue_watching,
                  ps."lastPlayedAt" AS last_played_at, ps."playedAt" AS played_at,
                  ps."userId" AS user_id, i."mediaId" AS media_id, ps."mediaFileId" AS media_file_id,
                  CASE WHEN i."groupId" IS NOT NULL THEN i.id END AS episode_id
           FROM playback_states ps JOIN items i ON i.id = ps."itemId"
           WHERE ps."userId" = $1 AND ps."itemId" = $2"#,
        user,
        item
    )
    .fetch_optional(db)
    .await
}

pub async fn delete_state(db: &PgPool, user: i32, item: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"DELETE FROM playback_states WHERE "userId" = $1 AND "itemId" = $2"#,
        user,
        item
    )
    .execute(db)
    .await
    .map(drop)
}

pub async fn resume_info(db: &PgPool, user: i32, media: i32) -> sqlx::Result<Option<ResumeInfo>> {
    let row = sqlx::query!(
        r#"SELECT
             f.id AS "media_file_id?",
             CASE WHEN e."groupId" IS NOT NULL THEN e.id END AS episode_id,
             ps."positionSeconds" AS position_seconds, ps."durationSeconds" AS duration_seconds,
             s."number" AS "season_number?", e."number" AS "episode_number?"
           FROM playback_states ps
           JOIN items e ON e.id = ps."itemId"
           LEFT JOIN item_groups s ON s.id = e."groupId"
           LEFT JOIN LATERAL (
             SELECT p."mediaFileId" AS id FROM item_parts p WHERE p."itemId" = e.id
             ORDER BY (p."mediaFileId" = ps."mediaFileId") DESC NULLS LAST, p."mediaFileId" DESC
             LIMIT 1) f ON true
           WHERE ps."userId" = $1
             AND e."mediaId" = $2
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
    sqlx::query_scalar!(
        r#"SELECT DISTINCT i.id
           FROM playback_states ps JOIN items i ON i.id = ps."itemId"
           WHERE ps."userId" = $1 AND i."mediaId" = $2
             AND ps.completed = true AND i."groupId" IS NOT NULL"#,
        user,
        media
    )
    .fetch_all(db)
    .await
}

/// `(episodeId, percent)` of in-progress episodes, strictly between 0 and 100.
pub async fn episode_progress(db: &PgPool, user: i32, media: i32) -> sqlx::Result<Vec<(i32, f64)>> {
    Ok(sqlx::query!(
        r#"SELECT i.id AS episode_id,
                  ROUND((ps."positionSeconds" / ps."durationSeconds") * 100) AS percent
           FROM playback_states ps JOIN items i ON i.id = ps."itemId"
           WHERE ps."userId" = $1 AND i."mediaId" = $2
             AND i."groupId" IS NOT NULL
             AND ps.completed = false
             AND ps."durationSeconds" > 0
             AND ps."positionSeconds" > 0"#,
        user,
        media
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .filter_map(|r| Some((r.episode_id, r.percent?)))
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
        r#"WITH st AS (
             SELECT ps.id, ps."itemId", ps."mediaFileId", ps."positionSeconds", ps."durationSeconds",
                    ps.completed, ps."hiddenFromContinueWatching" AS hidden, ps."lastPlayedAt",
                    i."mediaId", i."groupId", i."number" AS inum, g."number" AS gnum
             FROM playback_states ps
             JOIN items i ON i.id = ps."itemId"
             LEFT JOIN item_groups g ON g.id = i."groupId"
             WHERE ps."userId" = $1
           ),
           user_series AS (
             SELECT "mediaId", max("lastPlayedAt") AS "lastPlayedAt"
             FROM st WHERE "groupId" IS NOT NULL AND NOT hidden GROUP BY "mediaId"
           ),
           last_completed AS (
             -- Highest (group, number) among completed items: lastPlayedAt ties when the user
             -- bulk-marks a season.
             SELECT DISTINCT ON ("mediaId") "mediaId", gnum, inum
             FROM st WHERE completed AND "groupId" IS NOT NULL
             ORDER BY "mediaId", gnum DESC, inum DESC
           ),
           in_progress AS (
             SELECT DISTINCT ON ("mediaId") id, "mediaId", "itemId", "mediaFileId",
                    "positionSeconds", "durationSeconds"
             FROM st
             WHERE NOT completed AND "positionSeconds" >= 5 AND "groupId" IS NOT NULL
             ORDER BY "mediaId", "lastPlayedAt" DESC
           ),
           next_item AS (
             SELECT lc."mediaId",
                    (SELECT e.id FROM items e JOIN item_groups s ON s.id = e."groupId"
                     WHERE s."mediaId" = lc."mediaId" AND s."number" > 0
                       AND (s."number" > lc.gnum OR (s."number" = lc.gnum AND e."number" > lc.inum))
                     ORDER BY s."number", e."number" LIMIT 1) AS "itemId"
             FROM last_completed lc
             WHERE lc."mediaId" NOT IN (SELECT "mediaId" FROM in_progress)
           ),
           picked AS (
             SELECT st.id, st."mediaId", st."itemId", st."mediaFileId", st."positionSeconds",
                    st."durationSeconds", st."lastPlayedAt"
             FROM st
             WHERE st."groupId" IS NULL AND NOT st.completed AND NOT st.hidden
               AND st."positionSeconds" >= 5
             UNION ALL
             SELECT ip.id, ip."mediaId", ip."itemId", ip."mediaFileId",
                    ip."positionSeconds", ip."durationSeconds", us."lastPlayedAt"
             FROM in_progress ip
             JOIN user_series us ON us."mediaId" = ip."mediaId"
             UNION ALL
             SELECT COALESCE(ps.id, 0), ni."mediaId", ni."itemId", NULL::int,
                    COALESCE(ps."positionSeconds", 0), COALESCE(ps."durationSeconds", 0),
                    us."lastPlayedAt"
             FROM next_item ni
             JOIN user_series us ON us."mediaId" = ni."mediaId"
             LEFT JOIN playback_states ps ON ps."userId" = $1 AND ps."itemId" = ni."itemId"
             WHERE ni."itemId" IS NOT NULL AND COALESCE(NOT ps.completed, true)
           )
           SELECT x.id AS "id!", x."mediaId" AS "media_id!", x.file AS media_file_id,
                  x."episodeId" AS episode_id, x.pos AS "position_seconds!",
                  x.dur AS duration_seconds, x."lastPlayedAt" AS "last_played_at!",
                  x.title AS media_title, x.poster AS poster_url, x.fanart AS fanart_url,
                  x.kind AS "media_type!", x.still AS still_url, x.label AS episode_label,
                  CASE WHEN COALESCE(x.dur, 0) > 0 THEN ROUND((x.pos / x.dur) * 100)
                       ELSE 0 END AS "progress_percent!"
           FROM (
             SELECT c.id, c."mediaId", f.id AS file, c.pos, c.dur, c."lastPlayedAt",
                    CASE WHEN e."groupId" IS NOT NULL THEN e.id END AS "episodeId",
                    m.title, m."posterUrl" AS poster, m."fanartUrl" AS fanart,
                    m.type AS kind,
                    e."stillUrl" AS still,
                    CASE WHEN e."groupId" IS NOT NULL
                         THEN 'S' || LPAD(s."number"::text, 2, '0') || 'E' || LPAD(e."number"::text, 2, '0')
                              || COALESCE(' - ' || e.title, '') END AS label
             FROM (SELECT id, "mediaId", "itemId", "mediaFileId", "positionSeconds" AS pos,
                          "durationSeconds" AS dur, "lastPlayedAt" FROM picked) c
             JOIN media m ON m.id = c."mediaId" AND m."libraryId" = ANY($2)
             JOIN items e ON e.id = c."itemId"
             LEFT JOIN item_groups s ON s.id = e."groupId"
             LEFT JOIN LATERAL (
               SELECT p."mediaFileId" AS id FROM item_parts p WHERE p."itemId" = e.id
               ORDER BY (p."mediaFileId" = c."mediaFileId") DESC NULLS LAST, p."mediaFileId" DESC
               LIMIT 1) f ON true
             WHERE f.id IS NOT NULL
           ) x
           ORDER BY date_trunc('milliseconds', x."lastPlayedAt") DESC, x.kind, x."mediaId"
           LIMIT $3"#,
        user,
        libs,
        CONTINUE_MAX as i64
    )
    .fetch_all(db)
    .await?;
    for i in &mut items {
        if i.position_seconds < RESUME_FROM_START_UNDER_SECONDS {
            i.position_seconds = 0.0;
            i.progress_percent = 0.0;
        }
    }
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
           FROM playback_states ps JOIN items i ON i.id = ps."itemId"
           WHERE ps."userId" = $1 AND ps."playedAt" IS NOT NULL
             AND EXISTS (SELECT 1 FROM media mAcl WHERE mAcl.id = i."mediaId" AND mAcl."libraryId" = ANY($2))"#,
        user,
        libs
    )
    .fetch_one(db)
    .await?;
    let data = sqlx::query_as!(
        HistoryItem,
        r#"SELECT
             ps.id, e."mediaId" AS "media_id!", ps."mediaFileId" AS media_file_id,
             CASE WHEN e."groupId" IS NOT NULL THEN e.id END AS episode_id,
             ps."positionSeconds" AS position_seconds, ps."durationSeconds" AS duration_seconds,
             ps.completed,
             ps."lastPlayedAt" AS last_played_at,
             m.title AS media_title, m.type AS "media_type!",
             m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url, e."stillUrl" AS still_url,
             CASE WHEN ps."durationSeconds" > 0
                  THEN ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)
                  ELSE 0 END AS "progress_percent!",
             CASE WHEN e."groupId" IS NOT NULL
                  THEN 'S' || LPAD(s."number"::text, 2, '0') || 'E' || LPAD(e."number"::text, 2, '0')
                       || COALESCE(' - ' || e.title, '')
                  ELSE NULL END AS episode_label
           FROM playback_states ps
           JOIN items e ON e.id = ps."itemId"
           JOIN media m ON m.id = e."mediaId"
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
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT m.id FROM media m WHERE m."libraryId" = ANY($2) AND ({})"#,
        crate::media::watched::predicate("$1", "m")
    )))
    .bind(user)
    .bind(libs)
    .fetch_all(db)
    .await
}

pub async fn hide(db: &PgPool, user: i32, media: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE playback_states SET "hiddenFromContinueWatching" = true
           WHERE "userId" = $1 AND "itemId" IN (SELECT id FROM items WHERE "mediaId" = $2)"#,
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

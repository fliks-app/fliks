//! Playback state queries (`docs/spec/playback-state.md` SQL section).
use crate::http::{AppError, json::iso_ms};
use crate::playlists::remove_watched_from_auto_playlists;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;

const RESUME_FROM_START_UNDER_SECONDS: f64 = 10.0;
const CONTINUE_MAX: usize = 20;

/// The `PlaybackState` entity as loaded.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateRow {
    pub(crate) id: i32,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    updated_at: DateTime<Utc>,
    pub(crate) position_seconds: f64,
    duration_seconds: Option<f64>,
    pub(crate) completed: bool,
    hidden_from_continue_watching: bool,
    #[serde(with = "iso_ms")]
    last_played_at: DateTime<Utc>,
    #[serde(with = "iso_ms::opt")]
    played_at: Option<DateTime<Utc>>,
    user_id: Option<i32>,
    media_id: Option<i32>,
    media_file_id: Option<i32>,
    episode_id: Option<i32>,
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

/// An unknown media, episode or file is a 404 instead of Nest's FK-violation 500 (C1).
fn fk(e: sqlx::Error) -> AppError {
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
             s."seasonNumber" AS "season_number?", e."episodeNumber" AS "episode_number?"
           FROM playback_states ps
           LEFT JOIN episodes e ON e.id = ps."episodeId"
           LEFT JOIN seasons s ON s.id = e."seasonId"
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
                    s."seasonNumber", e."episodeNumber"
             FROM playback_states ps
             JOIN episodes e ON e.id = ps."episodeId"
             JOIN seasons s ON s.id = e."seasonId"
             WHERE ps."userId" = $1 AND ps.completed = true AND ps."episodeId" IS NOT NULL
             ORDER BY ps."mediaId", s."seasonNumber" DESC, e."episodeNumber" DESC
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
                    (SELECT e.id FROM episodes e
                     JOIN seasons s ON s.id = e."seasonId"
                     WHERE s."mediaId" = lc."mediaId" AND s."seasonNumber" > 0
                       AND (s."seasonNumber" > lc."seasonNumber"
                            OR (s."seasonNumber" = lc."seasonNumber" AND e."episodeNumber" > lc."episodeNumber"))
                     ORDER BY s."seasonNumber", e."episodeNumber" LIMIT 1
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
             'S' || LPAD(s."seasonNumber"::text, 2, '0') || 'E' || LPAD(e."episodeNumber"::text, 2, '0')
               || COALESCE(' - ' || e.title, '') AS episode_label,
             CASE WHEN COALESCE(ps_next."durationSeconds", c."durationSeconds", 0) > 0
                  THEN ROUND((COALESCE(ps_next."positionSeconds", c."positionSeconds", 0)
                             / COALESCE(ps_next."durationSeconds", c."durationSeconds", 1)) * 100)
                  ELSE 0 END AS "progress_percent!"
           FROM combined c
           JOIN user_series us ON us."mediaId" = c."mediaId"
           JOIN media m ON m.id = c."mediaId"
           JOIN episodes e ON e.id = c."episodeId"
           JOIN seasons s ON s.id = e."seasonId"
           LEFT JOIN LATERAL (
             SELECT mf2.id FROM media_files mf2
             WHERE mf2."mediaId" = c."mediaId" AND mf2."episodeId" = c."episodeId"
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
             m.title AS media_title, m.type::text AS "media_type!",
             m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url, e."stillUrl" AS still_url,
             CASE WHEN ps."durationSeconds" > 0
                  THEN ROUND((ps."positionSeconds" / ps."durationSeconds") * 100)
                  ELSE 0 END AS "progress_percent!",
             CASE WHEN ps."episodeId" IS NOT NULL
                  THEN 'S' || LPAD(s."seasonNumber"::text, 2, '0') || 'E' || LPAD(e."episodeNumber"::text, 2, '0')
                       || COALESCE(' - ' || e.title, '')
                  ELSE NULL END AS episode_label
           FROM playback_states ps
           JOIN media m ON m.id = ps."mediaId"
           LEFT JOIN episodes e ON e.id = ps."episodeId"
           LEFT JOIN seasons s ON s.id = e."seasonId"
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
           FROM seasons s
           JOIN episodes e ON e."seasonId" = s.id
           LEFT JOIN playback_states ps
             ON ps."userId" = $1 AND ps."episodeId" = e.id AND ps.completed = true
           WHERE s."seasonNumber" > 0 AND e."hasFile" = true
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

/// `Some(mediaId)` of an existing season (itself `None` for an orphan season).
pub async fn season_media(db: &PgPool, season: i32) -> sqlx::Result<Option<Option<i32>>> {
    sqlx::query_scalar!(r#"SELECT "mediaId" FROM seasons WHERE id = $1"#, season)
        .fetch_optional(db)
        .await
}

/// Rule 15. Returns the saved entity in the shape Nest's `repo.save` gave it.
pub async fn toggle_watched(
    db: &PgPool,
    user: i32,
    media: i32,
    file: Option<i32>,
    episode: Option<i32>,
) -> Result<Value, AppError> {
    let existing = find_state(db, user, media, episode).await?;
    if existing.is_none() && !media_exists(db, media).await? {
        return Err(AppError::not_found("not_found"));
    }
    let completing = existing.as_ref().is_none_or(|e| !e.completed);
    let mut file = file.filter(|f| *f != 0);
    if file.is_none() && existing.is_none() {
        file = match episode {
            Some(ep) => {
                sqlx::query_scalar!(r#"SELECT id FROM media_files WHERE "episodeId" = $1 LIMIT 1"#, ep)
                    .fetch_optional(db)
                    .await?
            }
            None => {
                sqlx::query_scalar!(
                    r#"SELECT id FROM media_files WHERE "mediaId" = $1 AND "episodeId" IS NULL LIMIT 1"#,
                    media
                )
                .fetch_optional(db)
                .await?
            }
        };
    }
    let prev_file = existing.as_ref().and_then(|e| e.media_file_id);
    let mut position = existing.as_ref().map_or(0.0, |e| e.position_seconds);
    let mut duration = existing.as_ref().and_then(|e| e.duration_seconds);
    if completing {
        position = 0.0;
        if duration.is_none_or(|d| d == 0.0)
            && let Some(id) = file.or(prev_file)
        {
            duration = Some(sqlx::query_scalar!(
                    r#"SELECT ("streamInfo"->>'durationSeconds')::float8 FROM media_files WHERE id = $1"#,
                    id
                )
                .fetch_optional(db)
                .await?
                .flatten()
                .unwrap_or(0.0));
        }
    }
    match &existing {
        Some(e) => {
            sqlx::query!(
                r#"UPDATE playback_states
                   SET completed = $2, "lastPlayedAt" = now(), "positionSeconds" = $3,
                       "durationSeconds" = $4, "mediaFileId" = COALESCE($5, "mediaFileId")
                   WHERE id = $1"#,
                e.id,
                completing,
                position,
                duration,
                file
            )
            .execute(db)
            .await
            .map_err(fk)?;
        }
        None => {
            sqlx::query!(
                r#"INSERT INTO playback_states
                     ("userId", "mediaId", "mediaFileId", "episodeId", "positionSeconds",
                      "durationSeconds", completed, "lastPlayedAt")
                   VALUES ($1, $2, $3, $4, $5, $6, true, now())"#,
                user,
                media,
                file,
                episode,
                position,
                duration
            )
            .execute(db)
            .await
            .map_err(fk)?;
        }
    }
    let mut row = find_state(db, user, media, episode)
        .await?
        .ok_or_else(|| AppError::internal("playback state vanished"))?;
    if completing {
        remove_watched_from_auto_playlists(
            db,
            user,
            media,
            episode.as_ref().map(std::slice::from_ref),
        )
        .await;
    }
    if existing.is_some() {
        row.media_file_id = prev_file;
    }
    let mut out = serde_json::to_value(&row).map_err(|e| AppError::internal(e.to_string()))?;
    if existing.is_none() {
        out["user"] = json!({"id": user});
        out["media"] = json!({"id": media, "path": null});
        out["episode"] = episode.map_or(Value::Null, |id| json!({"id": id}));
    }
    if let Some(id) = file {
        out["mediaFile"] = json!({"id": id});
    }
    Ok(out)
}

/// Rule 16.
pub async fn toggle_series_watched(
    db: &PgPool,
    user: i32,
    media: i32,
    watched: bool,
) -> sqlx::Result<()> {
    if !watched {
        return sqlx::query!(
            r#"UPDATE playback_states
               SET completed = false,
                   "positionSeconds" = 0,
                   "lastPlayedAt" = NOW()
               WHERE "userId" = $1
                 AND "mediaId" = $2
                 AND "episodeId" IS NOT NULL"#,
            user,
            media
        )
        .execute(db)
        .await
        .map(drop);
    }
    sqlx::query!(
        r#"INSERT INTO playback_states
             ("userId", "mediaId", "mediaFileId", "episodeId",
              "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
           SELECT $1::int4, $2::int4,
                  (SELECT mf.id FROM media_files mf
                    WHERE mf."episodeId" = e.id
                    ORDER BY mf.id DESC LIMIT 1),
                  e.id,
                  0,
                  COALESCE(
                    (SELECT (mf2."streamInfo"->>'durationSeconds')::float
                       FROM media_files mf2
                      WHERE mf2."episodeId" = e.id
                      ORDER BY mf2.id DESC LIMIT 1),
                    0
                  ),
                  true,
                  NOW()
           FROM episodes e
           JOIN seasons s ON s.id = e."seasonId"
           WHERE s."mediaId" = $2
             AND s."seasonNumber" > 0
             AND e."hasFile" = true
           ON CONFLICT ("userId", "episodeId") WHERE "episodeId" IS NOT NULL
           DO UPDATE SET
             completed = true,
             "positionSeconds" = 0,
             "lastPlayedAt" = NOW()"#,
        user,
        media
    )
    .execute(db)
    .await?;
    let done: Vec<i32> = sqlx::query_scalar!(
        r#"SELECT "episodeId" FROM playback_states
           WHERE "userId" = $1 AND "mediaId" = $2 AND completed = true"#,
        user,
        media
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .flatten()
    .collect();
    remove_watched_from_auto_playlists(db, user, media, Some(&done)).await;
    Ok(())
}

/// Rule 17; the caller checked that the season belongs to `media`.
pub async fn toggle_season_watched(
    db: &PgPool,
    user: i32,
    media: i32,
    season: i32,
    watched: bool,
) -> sqlx::Result<()> {
    if !watched {
        return sqlx::query!(
            r#"UPDATE playback_states
               SET completed = false, "positionSeconds" = 0, "lastPlayedAt" = now()
               WHERE "userId" = $1 AND "mediaId" = $2
                 AND "episodeId" IN (SELECT id FROM episodes WHERE "seasonId" = $3)"#,
            user,
            media,
            season
        )
        .execute(db)
        .await
        .map(drop);
    }
    let mut tx = db.begin().await?;
    sqlx::query!(
        r#"DELETE FROM playback_states
           WHERE "userId" = $1
             AND "episodeId" IN (SELECT id FROM episodes WHERE "seasonId" = $2 AND "hasFile")"#,
        user,
        season
    )
    .execute(&mut *tx)
    .await?;
    let inserted: Vec<i32> = sqlx::query_scalar!(
        r#"INSERT INTO playback_states
             ("userId", "mediaId", "mediaFileId", "episodeId", "positionSeconds",
              "durationSeconds", completed, "lastPlayedAt", "playedAt")
           SELECT $1::int4, $2::int4, f.id, e.id, 0,
                  COALESCE((f."streamInfo"->>'durationSeconds')::float8, 0), true, now(), NULL
           FROM episodes e
           CROSS JOIN LATERAL (SELECT mf.id, mf."streamInfo" FROM media_files mf
                               WHERE mf."episodeId" = e.id ORDER BY mf.id DESC LIMIT 1) f
           WHERE e."seasonId" = $3 AND e."hasFile"
           RETURNING "episodeId""#,
        user,
        media,
        season
    )
    .fetch_all(&mut *tx)
    .await?
    .into_iter()
    .flatten()
    .collect();
    tx.commit().await?;
    remove_watched_from_auto_playlists(db, user, media, Some(&inserted)).await;
    Ok(())
}

/// What a heartbeat flush records (`heartbeat.md` rule 15).
pub struct Watch {
    pub position: f64,
    pub duration: f64,
    pub file: i32,
    pub episode: Option<i32>,
}

/// Seconds before the end, or the fraction of the runtime, from which a title counts as watched.
pub fn completes(pos: f64, dur: f64) -> bool {
    dur > 0.0 && (pos >= dur - 30.0 || pos >= dur * 0.9)
}

/// Upserts the viewer's row (movie row when `episode` is falsy) and returns it as `repo.save` did,
/// `None` after an FK violation (media or file gone mid-session).
pub async fn record_watch(
    db: &PgPool,
    user: i32,
    media: i32,
    w: &Watch,
) -> Result<Option<Value>, AppError> {
    let lookup = w.episode.filter(|e| *e != 0);
    let existing = find_state(db, user, media, lookup).await?;
    let completed = completes(w.position, w.duration);
    let watched = w.position >= 5.0;
    let saved = match &existing {
        Some(e) => sqlx::query!(
            r#"UPDATE playback_states
               SET "positionSeconds" = $2,
                   "durationSeconds" = CASE WHEN $3::float8 > 0 THEN $3 ELSE "durationSeconds" END,
                   completed = $4, "hiddenFromContinueWatching" = false, "lastPlayedAt" = now(),
                   "playedAt" = CASE WHEN $5 THEN now() ELSE "playedAt" END, "mediaFileId" = $6
               WHERE id = $1"#,
            e.id,
            w.position,
            w.duration,
            completed,
            watched,
            w.file
        )
        .execute(db)
        .await
        .map(drop),
        None => sqlx::query!(
            r#"INSERT INTO playback_states
                 ("userId", "mediaId", "mediaFileId", "episodeId", "positionSeconds",
                  "durationSeconds", completed, "lastPlayedAt", "playedAt")
               VALUES ($1, $2, $3, $4, $5, $6, $7, now(), CASE WHEN $8 THEN now() END)"#,
            user,
            media,
            w.file,
            w.episode,
            w.position,
            w.duration,
            completed,
            watched
        )
        .execute(db)
        .await
        .map(drop),
    };
    match saved {
        Ok(()) => {}
        Err(sqlx::Error::Database(d)) if d.code().as_deref() == Some("23503") => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    if completed && existing.as_ref().is_none_or(|e| !e.completed) {
        let episodes = w.episode.map(|e| [e]);
        remove_watched_from_auto_playlists(db, user, media, episodes.as_ref().map(|e| &e[..]))
            .await;
    }
    let mut row = find_state(db, user, media, lookup)
        .await?
        .ok_or_else(|| AppError::internal("playback state vanished"))?;
    if let Some(e) = &existing {
        row.media_file_id = e.media_file_id;
    }
    let mut out = serde_json::to_value(&row).map_err(|e| AppError::internal(e.to_string()))?;
    if existing.is_none() {
        out["user"] = json!({"id": user});
        out["media"] = json!({"id": media, "path": null});
        out["episode"] = w.episode.map_or(Value::Null, |id| json!({"id": id}));
    }
    out["mediaFile"] = json!({"id": w.file});
    Ok(Some(out))
}

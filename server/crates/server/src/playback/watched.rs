//! The watched toggles and the watch recorded by the heartbeat (`docs/spec/playback-state.md`).
use super::db::{beat_item, find_state, fk};
use crate::http::AppError;
use crate::playlists::remove_watched_from_auto_playlists;
use chrono::{DateTime, Utc};
use fliks_domain::media::{
    family::Family,
    finish::{self, Standing},
};
use serde_json::{Value, json};
use sqlx::PgPool;

/// Appends one `playback_history` row (`cleanup.md` rule 6a).
async fn log_play(db: &PgPool, user: i32, item: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO playback_history ("userId", "itemId") VALUES ($1, $2)"#,
        user,
        item
    )
    .execute(db)
    .await
    .map(drop)
}

/// Appends a row per episode with a file the user has not completed: of `season`, else of the
/// series' regular seasons.
async fn log_uncompleted_episodes(
    db: &PgPool,
    user: i32,
    media: i32,
    season: Option<i32>,
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO playback_history ("userId", "itemId")
           SELECT $1, e.id FROM items e JOIN item_groups s ON s.id = e."groupId"
           WHERE EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
             AND CASE WHEN $3::int IS NULL THEN s."mediaId" = $2 AND s."number" > 0
                      ELSE s.id = $3 END
             AND NOT EXISTS (SELECT 1 FROM playback_states ps
                             WHERE ps."userId" = $1 AND ps."itemId" = e.id AND ps.completed)"#,
        user,
        media,
        season
    )
    .execute(db)
    .await
    .map(drop)
}

/// Rule 15. Returns the saved entity in the shape the 4.x clients read.
pub async fn toggle_watched(
    db: &PgPool,
    user: i32,
    media: i32,
    file: Option<i32>,
    episode: Option<i32>,
    item: Option<i32>,
    acl: &[i32],
) -> Result<Value, AppError> {
    let item = beat_item(db, media, episode, item, acl)
        .await?
        .ok_or_else(|| AppError::not_found("not_found"))?;
    let existing = find_state(db, user, item).await?;
    let completing = existing.as_ref().is_none_or(|e| !e.completed);
    let mut file = file.filter(|f| *f != 0);
    if file.is_none() && existing.is_none() {
        file = sqlx::query_scalar!(
            r#"SELECT "mediaFileId" FROM item_parts WHERE "itemId" = $1
               ORDER BY "version" DESC, "position" LIMIT 1"#,
            item
        )
        .fetch_optional(db)
        .await?;
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
                     ("userId", "itemId", "mediaFileId", "positionSeconds", "durationSeconds",
                      completed, "lastPlayedAt")
                   VALUES ($1, $2, $3, $4, $5, true, now())"#,
                user,
                item,
                file,
                position,
                duration
            )
            .execute(db)
            .await
            .map_err(fk)?;
        }
    }
    let mut row = find_state(db, user, item)
        .await?
        .ok_or_else(|| AppError::internal("playback state vanished"))?;
    if completing {
        log_play(db, user, item).await?;
        remove_watched_from_auto_playlists(db, user, &[item]).await;
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
                 AND "itemId" IN (SELECT id FROM items WHERE "mediaId" = $2 AND "groupId" IS NOT NULL)"#,
            user,
            media
        )
        .execute(db)
        .await
        .map(drop);
    }
    log_uncompleted_episodes(db, user, media, None).await?;
    sqlx::query!(
        r#"INSERT INTO playback_states
             ("userId", "itemId", "mediaFileId",
              "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
           SELECT $1::int4, e.id,
                  (SELECT p."mediaFileId" FROM item_parts p
                    WHERE p."itemId" = e.id
                    ORDER BY p."version" DESC, p."position" LIMIT 1),
                  0,
                  COALESCE(
                    (SELECT (mf2."streamInfo"->>'durationSeconds')::float
                       FROM media_files mf2 JOIN item_parts p2 ON p2."mediaFileId" = mf2.id
                      WHERE p2."itemId" = e.id
                      ORDER BY p2."version" DESC, p2."position" LIMIT 1),
                    0
                  ),
                  true,
                  NOW()
           FROM items e
           JOIN item_groups s ON s.id = e."groupId"
           WHERE s."mediaId" = $2
             AND s."number" > 0
             AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = e.id)
           ON CONFLICT ("userId", "itemId")
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
        r#"SELECT i.id FROM playback_states ps JOIN items i ON i.id = ps."itemId"
           WHERE ps."userId" = $1 AND i."mediaId" = $2 AND i."groupId" IS NOT NULL
             AND ps.completed = true"#,
        user,
        media
    )
    .fetch_all(db)
    .await?;
    remove_watched_from_auto_playlists(db, user, &done).await;
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
               WHERE "userId" = $1 AND "itemId" IN (SELECT id FROM items WHERE "groupId" = $2)"#,
            user,
            season
        )
        .execute(db)
        .await
        .map(drop);
    }
    log_uncompleted_episodes(db, user, media, Some(season)).await?;
    let inserted: Vec<i32> = sqlx::query_scalar!(
        r#"INSERT INTO playback_states
             ("userId", "itemId", "mediaFileId", "positionSeconds",
              "durationSeconds", completed, "lastPlayedAt")
           SELECT $1::int4, e.id, f.id, 0,
                  COALESCE((f."streamInfo"->>'durationSeconds')::float8, 0), true, now()
           FROM items e
           CROSS JOIN LATERAL (SELECT mf.id, mf."streamInfo" FROM media_files mf
                               JOIN item_parts p ON p."mediaFileId" = mf.id
                               WHERE p."itemId" = e.id ORDER BY p."version" DESC, p."position" LIMIT 1) f
           WHERE e."groupId" = $2
           ON CONFLICT ("userId", "itemId") DO UPDATE SET
             "mediaFileId" = EXCLUDED."mediaFileId", "positionSeconds" = 0,
             "durationSeconds" = EXCLUDED."durationSeconds", completed = true,
             "hiddenFromContinueWatching" = false, "lastPlayedAt" = now()
           RETURNING "itemId""#,
        user,
        season
    )
    .fetch_all(db)
    .await?;
    remove_watched_from_auto_playlists(db, user, &inserted).await;
    Ok(())
}

/// What a heartbeat flush records (`heartbeat.md` rule 15).
pub struct Watch {
    pub position: f64,
    pub duration: f64,
    pub file: i32,
    /// The item the beat names, resolved from `(mediaId, episodeId)`.
    pub item: i32,
    pub episode: Option<i32>,
    /// When the client played it, for an offline replay; `None` for a live beat.
    pub client_played_at: Option<DateTime<Utc>>,
    /// The family of the item's edition, which decides when it is finished.
    pub family: Family,
    pub last_chapter_start: Option<f64>,
    pub progression: Option<f64>,
    pub locator: Option<Value>,
}

/// The video rule: also the zone in which every beat of any family is written.
pub fn completes(pos: f64, dur: f64) -> bool {
    finish::video(pos, dur)
}

/// The family of an item and, for an audio item, the start of its last chapter on the timeline of the
/// version holding `file` (only with two chapters or more).
pub async fn finish_context(
    db: &PgPool,
    item: i32,
    file: i32,
) -> sqlx::Result<(Family, Option<f64>)> {
    let family = sqlx::query_scalar!(
        r#"SELECT e.family FROM items i JOIN editions e ON e.id = i."editionId" WHERE i.id = $1"#,
        item
    )
    .fetch_optional(db)
    .await?
    .and_then(|f| Family::parse(&f))
    .unwrap_or(Family::Video);
    if family != Family::Audio {
        return Ok((family, None));
    }
    let last = sqlx::query_scalar!(
        r#"WITH v AS (SELECT version FROM item_parts WHERE "itemId" = $1 AND "mediaFileId" = $2),
parts AS (SELECT ip."mediaFileId" AS fid,
    COALESCE(sum(COALESCE((f."streamInfo"->>'durationSeconds')::float8, 0))
      OVER (ORDER BY ip.position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS off
  FROM item_parts ip JOIN media_files f ON f.id = ip."mediaFileId", v
  WHERE ip."itemId" = $1 AND ip.version = v.version),
ch AS (SELECT parts.off + mk."startSeconds" AS s FROM parts
  JOIN item_markers mk ON mk."itemId" = $1 AND mk."mediaFileId" = parts.fid AND mk.kind = 'chapter')
SELECT CASE WHEN count(*) >= 2 THEN max(s) END::float8 AS last FROM ch"#,
        item,
        file
    )
    .fetch_one(db)
    .await?;
    Ok((family, last))
}

/// Writes an offline replay stamped with the time it was played.
async fn write_replay(
    db: &PgPool,
    existing: Option<&super::db::StateRow>,
    user: i32,
    w: &Watch,
    at: DateTime<Utc>,
    completed: bool,
) -> sqlx::Result<()> {
    let watched = w.position >= 5.0;
    match existing {
        Some(e) => sqlx::query(
            r#"UPDATE playback_states
               SET "positionSeconds" = $2,
                   "durationSeconds" = CASE WHEN $3::float8 > 0 THEN $3 ELSE "durationSeconds" END,
                   completed = $4, "hiddenFromContinueWatching" = false, "lastPlayedAt" = $5,
                   "playedAt" = CASE WHEN $6 THEN $5 ELSE "playedAt" END, "mediaFileId" = $7,
                   progression = COALESCE($8, progression), locator = COALESCE($9, locator)
               WHERE id = $1"#,
        )
        .bind(e.id)
        .bind(w.position)
        .bind(w.duration)
        .bind(completed)
        .bind(at)
        .bind(watched)
        .bind(w.file)
        .bind(w.progression)
        .bind(&w.locator),
        None => sqlx::query(
            r#"INSERT INTO playback_states
                 ("userId", "itemId", "mediaFileId", "positionSeconds",
                  "durationSeconds", completed, "lastPlayedAt", "playedAt", progression, locator)
               VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN $7 END, $9, $10)"#,
        )
        .bind(user)
        .bind(w.item)
        .bind(w.file)
        .bind(w.position)
        .bind(w.duration)
        .bind(completed)
        .bind(at)
        .bind(watched)
        .bind(w.progression)
        .bind(&w.locator),
    }
    .execute(db)
    .await
    .map(drop)
}

/// Completes the other items the file plays, and returns those that were not completed yet.
async fn complete_covered(db: &PgPool, user: i32, w: &Watch) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar!(
        r#"WITH cov AS (
             SELECT p."itemId" AS id FROM item_parts p JOIN items i ON i.id = p."itemId"
             WHERE p."mediaFileId" = $2 AND p."itemId" <> $3 AND i."groupId" IS NOT NULL),
           fresh AS (
             SELECT cov.id FROM cov WHERE NOT EXISTS (SELECT 1 FROM playback_states ps
               WHERE ps."userId" = $1 AND ps."itemId" = cov.id AND ps.completed)),
           done AS (
             INSERT INTO playback_states ("userId", "itemId", "mediaFileId",
               "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
             SELECT $1, cov.id, $2, 0, $4, true, now() FROM cov
             ON CONFLICT ("userId", "itemId")
             DO UPDATE SET completed = true, "positionSeconds" = 0, "lastPlayedAt" = now()
             RETURNING 1)
           SELECT id AS "id!" FROM fresh"#,
        user,
        w.file,
        w.item,
        w.duration
    )
    .fetch_all(db)
    .await
}

/// Upserts the viewer's row for the item the beat names and returns it as `repo.save` did,
/// `None` after an FK violation (file gone mid-session).
pub async fn record_watch(
    db: &PgPool,
    user: i32,
    media: i32,
    w: &Watch,
) -> Result<Option<Value>, AppError> {
    let existing = find_state(db, user, w.item).await?;
    let replay = w.client_played_at;
    let stale = replay
        .zip(existing.as_ref())
        .is_some_and(|(at, e)| e.last_played_at > at);
    let was_completed = existing.as_ref().is_some_and(|e| e.completed);
    let standing = Standing {
        position: w.position,
        duration: w.duration,
        progression: w.progression,
        last_chapter_start: w.last_chapter_start,
    };
    let completed = finish::finished(w.family, &standing) || (replay.is_some() && was_completed);
    let watched = w.position >= 5.0 || w.progression.is_some_and(|p| p > 0.0);
    let saved = if stale {
        Ok(())
    } else if let Some(at) = replay {
        write_replay(db, existing.as_ref(), user, w, at, completed).await
    } else {
        match &existing {
            Some(e) => sqlx::query!(
                r#"UPDATE playback_states
               SET "positionSeconds" = $2,
                   "durationSeconds" = CASE WHEN $3::float8 > 0 THEN $3 ELSE "durationSeconds" END,
                   completed = $4, "hiddenFromContinueWatching" = false, "lastPlayedAt" = now(),
                   "playedAt" = CASE WHEN $5 THEN now() ELSE "playedAt" END, "mediaFileId" = $6,
                   progression = COALESCE($7, progression), locator = COALESCE($8, locator)
               WHERE id = $1"#,
                e.id,
                w.position,
                w.duration,
                completed,
                watched,
                w.file,
                w.progression,
                w.locator
            )
            .execute(db)
            .await
            .map(drop),
            None => sqlx::query!(
                r#"INSERT INTO playback_states
                 ("userId", "itemId", "mediaFileId", "positionSeconds",
                  "durationSeconds", completed, "lastPlayedAt", "playedAt", progression, locator)
               VALUES ($1, $2, $3, $4, $5, $6, now(), CASE WHEN $7 THEN now() END, $8, $9)"#,
                user,
                w.item,
                w.file,
                w.position,
                w.duration,
                completed,
                watched,
                w.progression,
                w.locator
            )
            .execute(db)
            .await
            .map(drop),
        }
    };
    match saved {
        Ok(()) => {}
        Err(sqlx::Error::Database(d)) if d.code().as_deref() == Some("23503") => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    if completed && !was_completed && !stale {
        log_play(db, user, w.item).await?;
        let mut done = vec![w.item];
        if w.episode.is_some() {
            for id in complete_covered(db, user, w).await? {
                log_play(db, user, id).await?;
                done.push(id);
            }
        }
        remove_watched_from_auto_playlists(db, user, &done).await;
    }
    let mut row = find_state(db, user, w.item)
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

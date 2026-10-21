//! The watched toggles and the watch recorded by the heartbeat (`docs/spec/playback-state.md`).
use super::db::{find_state, fk, media_exists};
use crate::http::AppError;
use crate::playlists::remove_watched_from_auto_playlists;
use serde_json::{Value, json};
use sqlx::PgPool;

/// Rule 15. Returns the saved entity in the shape the 4.x clients read.
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

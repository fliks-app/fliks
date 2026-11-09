//! Wanting one track of an album by its recording (`docs/spec/music.md` rule 73), shared by
//! `POST /api/music/want-recording` and the import lists' `music-want-recording`.
use super::target;
use crate::state::AppState;
use fliks_domain::metadata::limiter::Priority;
use sqlx::PgPool;

#[derive(Clone, Copy)]
pub enum Recording<'a> {
    Isrc(&'a str),
    Mbid(&'a str),
}

/// Why no track was wanted.
pub enum Refused {
    /// The album's target release has no track of that recording.
    NoTrack,
    /// The album's releases could not be read yet: retryable.
    Unavailable,
    Db(sqlx::Error),
}

impl From<sqlx::Error> for Refused {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

/// The item of `media` a recording names; `owned` keeps only the tracks that have a file.
pub async fn item_of(
    db: &PgPool,
    media: Option<i32>,
    recording: Recording<'_>,
    owned: bool,
) -> sqlx::Result<Option<(i32, i32)>> {
    let (column, value) = match recording {
        Recording::Isrc(v) => ("isrc", v),
        Recording::Mbid(v) => ("\"recordingMbid\"::text", v),
    };
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT td."mediaId", td."itemId" FROM track_details td
             JOIN album_details ad ON ad."mediaId" = td."mediaId"
             JOIN items i ON i.id = td."itemId"
            WHERE td.{column} = $1 AND ($2::int IS NULL OR td."mediaId" = $2)
              AND (NOT $3 OR EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = td."itemId"))
            ORDER BY (i."editionId" = ad."targetEditionId") DESC, td."itemId" LIMIT 1"#
    )))
    .bind(value)
    .bind(media)
    .bind(owned)
    .fetch_optional(db)
    .await
}

async fn has_target(db: &PgPool, media: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT COALESCE((SELECT "targetEditionId" IS NOT NULL FROM album_details WHERE "mediaId" = $1), false)"#,
    )
    .bind(media)
    .fetch_one(db)
    .await
}

/// The item of `recording` on the album just resolved. An album with no target edition (its provider call
/// failed) is asked again once; if it still has none the call is retryable. When no track is found, an
/// album this call made, or one nobody monitored, is left unmonitored so nothing is wanted.
pub async fn held_track(
    st: &AppState,
    media: i32,
    recording: Recording<'_>,
    existed: bool,
) -> Result<i32, Refused> {
    if let Some((_, item)) = item_of(&st.db, Some(media), recording, false).await? {
        return Ok(item);
    }
    let was: bool = sqlx::query_scalar("SELECT monitored FROM media WHERE id = $1")
        .bind(media)
        .fetch_one(&st.db)
        .await?;
    let leave = async |refused| {
        if !existed || !was {
            sqlx::query("UPDATE media SET monitored = false WHERE id = $1")
                .bind(media)
                .execute(&st.db)
                .await?;
        }
        Err(refused)
    };
    if has_target(&st.db, media).await? {
        return leave(Refused::NoTrack).await;
    }
    sqlx::query("UPDATE media SET monitored = true WHERE id = $1")
        .bind(media)
        .execute(&st.db)
        .await?;
    if let Err(e) = target::ensure(st, media, Priority::Background).await {
        tracing::warn!("album #{media}: no target edition yet: {}", e.text());
    }
    if let Some((_, item)) = item_of(&st.db, Some(media), recording, false).await? {
        return Ok(item);
    }
    leave(if has_target(&st.db, media).await? {
        Refused::NoTrack
    } else {
        Refused::Unavailable
    })
    .await
}

/// Makes `item` wanted and its album monitored. An album this call created (`fresh`) keeps only that track
/// of its target edition monitored; one the library already had keeps its other tracks as they are.
pub async fn monitor(db: &PgPool, media: i32, item: i32, fresh: bool) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    if fresh {
        sqlx::query(
            r#"UPDATE items SET monitored = false
                WHERE "mediaId" = $1 AND id <> $2
                  AND "editionId" = (SELECT "targetEditionId" FROM album_details WHERE "mediaId" = $1)"#,
        )
        .bind(media)
        .bind(item)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE items SET monitored = true WHERE id = $1")
        .bind(item)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE media SET monitored = true WHERE id = $1 AND NOT monitored")
        .bind(media)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// `held_track` then `monitor`: the track of a recording wanted on an album just resolved.
pub async fn want(
    st: &AppState,
    media: i32,
    recording: Recording<'_>,
    existed: bool,
) -> Result<i32, Refused> {
    let item = held_track(st, media, recording, existed).await?;
    monitor(&st.db, media, item, !existed).await?;
    Ok(item)
}

//! Editions and items of a media (`docs/spec/items.md`).
use fliks_domain::media::kind::MediaKind;
use sqlx::{PgConnection, PgExecutor};

/// Gives a new media its `video` edition and, when it has no seasons, its sole item.
pub async fn create_shell(c: &mut PgConnection, media: i32, kind: MediaKind) -> sqlx::Result<()> {
    let edition = sqlx::query_scalar!(
        r#"INSERT INTO editions ("mediaId", family) VALUES ($1, 'video') RETURNING id"#,
        media
    )
    .fetch_one(&mut *c)
    .await?;
    if !kind.has_seasons() {
        sqlx::query!(
            r#"INSERT INTO items ("mediaId", "editionId", monitored) VALUES ($1, $2, true)"#,
            media,
            edition
        )
        .execute(&mut *c)
        .await?;
    }
    Ok(())
}

/// Follows a media type change: a series loses its ungrouped item, a movie gains one.
pub async fn follow_kind(c: &mut PgConnection, media: i32, kind: MediaKind) -> sqlx::Result<()> {
    if kind.has_seasons() {
        sqlx::query!(
            r#"DELETE FROM items WHERE "mediaId" = $1 AND "groupId" IS NULL"#,
            media
        )
        .execute(&mut *c)
        .await?;
        return Ok(());
    }
    let edition = video_edition(&mut *c, media).await?;
    sqlx::query!(
        r#"INSERT INTO items ("mediaId", "editionId", monitored)
           SELECT $1, $2, true
           WHERE NOT EXISTS (SELECT 1 FROM items WHERE "mediaId" = $1 AND "groupId" IS NULL)"#,
        media,
        edition
    )
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// The media's `video` edition.
pub async fn video_edition(db: impl PgExecutor<'_>, media: i32) -> sqlx::Result<i32> {
    sqlx::query_scalar!(
        r#"SELECT id FROM editions WHERE "mediaId" = $1 AND family = 'video' ORDER BY id LIMIT 1"#,
        media
    )
    .fetch_one(db)
    .await
}

/// The ungrouped item of a media without seasons.
pub async fn sole_item(db: impl PgExecutor<'_>, media: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!(
        r#"SELECT id FROM items WHERE "mediaId" = $1 AND "groupId" IS NULL ORDER BY id LIMIT 1"#,
        media
    )
    .fetch_optional(db)
    .await
}

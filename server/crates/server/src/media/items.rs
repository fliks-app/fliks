//! Editions and items of a media (`docs/spec/items.md`).
use fliks_domain::media::{family::Family, kind::MediaKind};
use sqlx::{PgConnection, PgExecutor, PgPool};

/// One file and the item it belongs to; `last` is the last episode number a multi-episode file covers.
pub struct Link {
    pub file: i32,
    pub owner: Option<i32>,
    pub last: Option<i32>,
}

/// Replaces each file's parts with its owner and the existing items of its range; no owner means the sole item.
pub async fn attach(db: &PgPool, media: i32, links: &[Link]) -> sqlx::Result<()> {
    if links.is_empty() {
        return Ok(());
    }
    let files: Vec<i32> = links.iter().map(|l| l.file).collect();
    let owners: Vec<Option<i32>> = links.iter().map(|l| l.owner).collect();
    let lasts: Vec<Option<i32>> = links.iter().map(|l| l.last).collect();
    let mut tx = db.begin().await?;
    sqlx::query!(
        r#"DELETE FROM item_parts WHERE "mediaFileId" = ANY($1)"#,
        &files
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId")
           SELECT i.id, v.file, $1
           FROM UNNEST($2::int[], $3::int[], $4::int[]) AS v(file, owner, last)
           JOIN items o ON o."mediaId" = $1 AND o.id = COALESCE(v.owner,
                (SELECT id FROM items WHERE "mediaId" = $1 AND "groupId" IS NULL ORDER BY id LIMIT 1))
           JOIN items i ON i.id = o.id
                OR (i."groupId" = o."groupId" AND i."number" > o."number" AND i."number" <= v.last)
           ON CONFLICT DO NOTHING"#,
        media,
        &files,
        &owners as &[Option<i32>],
        &lasts as &[Option<i32>]
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// Gives the items inside a multi-episode range the parts of its owner, once they exist.
pub async fn cover_ranges(db: impl PgExecutor<'_>, media: i32) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId")
           SELECT j.id, p."mediaFileId", p."mediaId"
           FROM items o
           JOIN item_parts p ON p."itemId" = o.id
           JOIN items j ON j."groupId" = o."groupId" AND j."number" > o."number" AND j."number" <= o."endNumber"
           WHERE o."mediaId" = $1 AND o."endNumber" IS NOT NULL
           ON CONFLICT DO NOTHING"#,
        media
    )
    .execute(db)
    .await
    .map(drop)
}

/// What a new media is wished with: the quality profile of each of its wants.
#[derive(Clone, Copy, Default)]
pub struct NewWant {
    pub quality_profile_id: Option<i32>,
}

/// Gives a new media its `video` edition, one want per family of its kind and, when it has no seasons, its sole item.
pub async fn create_shell(
    c: &mut PgConnection,
    media: i32,
    kind: MediaKind,
    want: NewWant,
) -> sqlx::Result<()> {
    for family in kind.families() {
        sqlx::query!(
            r#"INSERT INTO wants ("mediaId", family, "qualityProfileId") VALUES ($1, $2, $3)"#,
            media,
            family.as_str(),
            want.quality_profile_id
        )
        .execute(&mut *c)
        .await?;
    }
    let edition = sqlx::query_scalar!(
        r#"INSERT INTO editions ("mediaId", family) VALUES ($1, $2) RETURNING id"#,
        media,
        Family::Video.as_str()
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

/// Follows a media type change: a series loses its ungrouped item, a movie gains one that plays every file.
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
    sqlx::query!(
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId")
           SELECT i.id, f.id, $1 FROM items i JOIN media_files f ON f."mediaId" = i."mediaId"
           WHERE i."mediaId" = $1 AND i."groupId" IS NULL
           ON CONFLICT DO NOTHING"#,
        media
    )
    .execute(&mut *c)
    .await?;
    Ok(())
}

/// The media's `video` edition.
pub async fn video_edition(db: impl PgExecutor<'_>, media: i32) -> sqlx::Result<i32> {
    sqlx::query_scalar!(
        r#"SELECT id FROM editions WHERE "mediaId" = $1 AND family = $2 ORDER BY id LIMIT 1"#,
        media,
        Family::Video.as_str()
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

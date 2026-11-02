//! Editions and items of a media (`docs/spec/items.md`).
use fliks_domain::media::{family::Family, kind::MediaKind};
use sqlx::{Acquire, PgConnection, PgExecutor, PgPool};

/// One file and the item it belongs to; `last` is the last episode number a multi-episode file covers.
pub struct Link {
    pub file: i32,
    pub owner: Option<i32>,
    pub last: Option<i32>,
}

/// Advisory lock class of the item-version writers, keyed by media.
const VERSIONS_LOCK: i32 = 0x4956_5253;

/// Serialises the writers of a media's item parts so two never pick the same version. A writer that
/// also deletes items takes it before its first delete, the order `attach` follows.
pub(crate) async fn lock_versions(c: &mut PgConnection, media: i32) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1, $2)")
        .bind(VERSIONS_LOCK)
        .bind(media)
        .execute(c)
        .await
        .map(drop)
}

/// Refuses to guess among several ungrouped items: a writer that names none must not pick the first.
async fn refuse_several_ungrouped(c: &mut PgConnection, media: i32) -> sqlx::Result<()> {
    let n: i64 = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM items WHERE "mediaId" = $1 AND "groupId" IS NULL"#,
        media
    )
    .fetch_one(c)
    .await?;
    if n > 1 {
        return Err(sqlx::Error::Protocol(format!(
            "media {media} has {n} ungrouped items, none was named"
        )));
    }
    Ok(())
}

/// Replaces each file's parts with its owner and the existing items of its range; no owner means the sole item.
/// A part keeps its version on the same item, a new one is the item's next version at position 0.
pub async fn attach(db: &PgPool, media: i32, links: &[Link]) -> sqlx::Result<()> {
    if links.is_empty() {
        return Ok(());
    }
    let files: Vec<i32> = links.iter().map(|l| l.file).collect();
    let owners: Vec<Option<i32>> = links.iter().map(|l| l.owner).collect();
    let lasts: Vec<Option<i32>> = links.iter().map(|l| l.last).collect();
    let mut tx = db.begin().await?;
    lock_versions(&mut tx, media).await?;
    if links.iter().any(|l| l.owner.is_none()) {
        refuse_several_ungrouped(&mut tx, media).await?;
    }
    sqlx::query!(
        r#"WITH old AS (
             DELETE FROM item_parts WHERE "mediaFileId" = ANY($2)
             RETURNING "itemId", "mediaFileId", "version"),
           target AS (
             SELECT DISTINCT i.id AS item, v.file
             FROM UNNEST($2::int[], $3::int[], $4::int[]) AS v(file, owner, last)
             JOIN items o ON o."mediaId" = $1 AND o.id = COALESCE(v.owner,
                  item_of($1, NULL))
             JOIN items i ON i.id = o.id
                  OR (i."groupId" = o."groupId" AND i."number" > o."number" AND i."number" <= v.last))
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
           SELECT t.item, t.file, $1,
                  COALESCE(old."version",
                           (SELECT COALESCE(max(p."version") + 1, 0) FROM item_parts p WHERE p."itemId" = t.item)
                           + row_number() OVER (PARTITION BY t.item ORDER BY t.file) - 1)
           FROM target t
           LEFT JOIN old ON old."itemId" = t.item AND old."mediaFileId" = t.file"#,
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
pub async fn cover_ranges(c: &mut PgConnection, media: i32) -> sqlx::Result<()> {
    let mut tx = c.begin().await?;
    lock_versions(&mut tx, media).await?;
    sqlx::query!(
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
           SELECT t.item, t.file, t.media,
                  (SELECT COALESCE(max(q."version") + 1, 0) FROM item_parts q WHERE q."itemId" = t.item)
                  + row_number() OVER (PARTITION BY t.item ORDER BY t.file) - 1
           FROM (SELECT DISTINCT j.id AS item, p."mediaFileId" AS file, p."mediaId" AS media
                 FROM items o
                 JOIN item_parts p ON p."itemId" = o.id
                 JOIN items j ON j."groupId" = o."groupId" AND j."number" > o."number" AND j."number" <= o."endNumber"
                 WHERE o."mediaId" = $1 AND o."endNumber" IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM item_parts x WHERE x."itemId" = j.id AND x."mediaFileId" = p."mediaFileId")) t"#,
        media
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

/// What a new media is wished with: the quality profile and the target folder of each of its wants.
#[derive(Clone, Copy, Default)]
pub struct NewWant {
    pub quality_profile_id: Option<i32>,
    pub folder_id: Option<i32>,
}

/// Gives a new media one want per family of its kind and, but for a book, its `video` edition and, without seasons, its sole item.
pub async fn create_shell(
    c: &mut PgConnection,
    media: i32,
    kind: MediaKind,
    want: NewWant,
) -> sqlx::Result<()> {
    for family in kind.families() {
        sqlx::query!(
            r#"INSERT INTO wants ("mediaId", family, "qualityProfileId", "folderId") VALUES ($1, $2, $3, $4)"#,
            media,
            family.as_str(),
            want.quality_profile_id,
            want.folder_id
        )
        .execute(&mut *c)
        .await?;
    }
    if kind == MediaKind::Book {
        return Ok(());
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
    lock_versions(&mut *c, media).await?;
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
    refuse_several_ungrouped(&mut *c, media).await?;
    sqlx::query!(
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
           SELECT i.id, f.id, $1,
                  (SELECT COALESCE(max(q."version") + 1, 0) FROM item_parts q WHERE q."itemId" = i.id)
                  + row_number() OVER (PARTITION BY i.id ORDER BY f.id) - 1
           FROM items i JOIN media_files f ON f."mediaId" = i."mediaId"
           WHERE i."mediaId" = $1 AND i."groupId" IS NULL
             AND NOT EXISTS (SELECT 1 FROM item_parts x WHERE x."itemId" = i.id AND x."mediaFileId" = f.id)"#,
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

/// The ungrouped item of a media without seasons; `None` when it has none or several.
pub async fn sole_item(db: impl PgExecutor<'_>, media: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar!(r#"SELECT item_of($1, NULL) AS "item""#, media)
        .fetch_one(db)
        .await
}

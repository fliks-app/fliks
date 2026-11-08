//! Folds a duplicate book into the work that already holds its id.
use crate::{
    images::paths::{Size, Target, Variant},
    media::write::orphans::{self, Refs},
    state::AppState,
};
use sqlx::PgConnection;

/// Copies `into`'s poster out of `from`'s image folder when it points there, before that folder is cleaned.
pub async fn carry_poster(st: &AppState, from: i32, into: i32) {
    let old = Target::media(from, Variant::Poster);
    let target = Target::media(into, Variant::Poster);
    let prefix = format!("{}%", old.api_path());
    let stored = sqlx::query_scalar::<_, bool>(
        r#"SELECT COALESCE("posterUrl" LIKE $2, false) FROM media WHERE id = $1"#,
    )
    .bind(into)
    .bind(&prefix)
    .fetch_optional(&st.db)
    .await;
    if matches!(stored, Ok(Some(false) | None)) {
        return;
    }
    let url = match stored {
        Ok(_) => {
            st.images
                .store_from_disk(&old.file(st.images.root(), Size::Full), &target)
                .await
        }
        Err(_) => None,
    };
    // A dangling url would block the next cover write, which only fills a NULL poster.
    let res =
        sqlx::query(r#"UPDATE media SET "posterUrl" = $2 WHERE id = $1 AND "posterUrl" LIKE $3"#)
            .bind(into)
            .bind(&url)
            .bind(prefix)
            .execute(&st.db)
            .await;
    if url.is_none() || res.is_err() {
        tracing::warn!("poster of book #{into} not carried from #{from}");
    }
}

/// Whether two media sit in the same library (both in none counts): another library's media is never folded in.
pub async fn same_library(c: &mut PgConnection, a: i32, b: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT (SELECT "libraryId" FROM media WHERE id = $1)
              IS NOT DISTINCT FROM (SELECT "libraryId" FROM media WHERE id = $2)"#,
    )
    .bind(a)
    .bind(b)
    .fetch_one(c)
    .await
}

/// Moves what `from` owns onto `into`, fills the facts `into` lacks, then deletes `from`. The caller
/// `orphans::release`s the result once its transaction commits.
pub async fn absorb(c: &mut PgConnection, from: i32, into: i32) -> sqlx::Result<Refs> {
    let (a, b) = (from.min(into), from.max(into));
    // `item_parts` rows change media: no version writer of either runs meanwhile (`items.md` rule 23).
    crate::media::items::lock_versions(c, a).await?;
    crate::media::items::lock_versions(c, b).await?;
    sqlx::query!(
        "SELECT id FROM media WHERE id IN ($1, $2) ORDER BY id FOR UPDATE",
        a,
        b
    )
    .fetch_all(&mut *c)
    .await?;
    // The target edition of the duplicate would point at an edition that changes media.
    sqlx::query!(r#"DELETE FROM album_details WHERE "mediaId" = $1"#, from)
        .execute(&mut *c)
        .await?;
    // One statement: the composite foreign keys on (id, "mediaId") are checked at its end.
    sqlx::query!(
        r#"WITH e AS (UPDATE editions SET "mediaId" = $2 WHERE "mediaId" = $1),
             g AS (UPDATE item_groups SET "mediaId" = $2 WHERE "mediaId" = $1),
             i AS (UPDATE items SET "mediaId" = $2 WHERE "mediaId" = $1),
             td AS (UPDATE track_details SET "mediaId" = $2 WHERE "mediaId" = $1),
             ci AS (UPDATE comic_issues SET "mediaId" = $2 WHERE "mediaId" = $1),
             p AS (UPDATE item_parts SET "mediaId" = $2 WHERE "mediaId" = $1),
             f AS (UPDATE media_files SET "mediaId" = $2 WHERE "mediaId" = $1),
             c AS (UPDATE media_credits SET "mediaId" = $2
                    WHERE "mediaId" = $1 AND "editionId" IS NOT NULL),
             r AS (UPDATE media_release_dates SET "mediaId" = $2
                    WHERE "mediaId" = $1 AND "editionId" IS NOT NULL),
             x AS (UPDATE edition_external_ids SET "mediaId" = $2 WHERE "mediaId" = $1),
             n AS (UPDATE collection_entries SET "mediaId" = $2
                    WHERE "mediaId" = $1 AND "itemId" IS NOT NULL),
             s AS (UPDATE subtitle_files SET "mediaId" = $2 WHERE "mediaId" = $1),
             sb AS (UPDATE subtitle_blacklist SET "mediaId" = $2 WHERE "mediaId" = $1),
             cr AS (UPDATE content_recommendations SET "mediaId" = $2 WHERE "mediaId" = $1),
             rq AS (UPDATE requests SET "mediaId" = $2 WHERE "mediaId" = $1),
             dw AS (UPDATE discovered_works SET "mediaId" = $2 WHERE "mediaId" = $1),
             bm AS (UPDATE book_merges SET "mediaId" = $2 WHERE "mediaId" = $1)
           SELECT 1 AS done"#,
        from,
        into
    )
    .fetch_one(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE media_external_ids x SET "mediaId" = $2 WHERE "mediaId" = $1
             AND NOT EXISTS (SELECT 1 FROM media_external_ids y
                              WHERE y."mediaId" = $2 AND y.provider = x.provider)"#,
        from,
        into
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE likes SET "mediaId" = $2 WHERE "mediaId" = $1
             AND ("groupId" IS NOT NULL OR "itemId" IS NOT NULL OR NOT EXISTS (SELECT 1 FROM likes y
               WHERE y."mediaId" = $2 AND y."groupId" IS NULL AND y."itemId" IS NULL
                 AND y."userId" = likes."userId"))"#,
        from,
        into
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE wants SET "mediaId" = $2 WHERE "mediaId" = $1
             AND NOT EXISTS (SELECT 1 FROM wants y WHERE y."mediaId" = $2 AND y.family = wants.family
                               AND y.language IS NOT DISTINCT FROM wants.language)"#,
        from,
        into
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE cleanup_exclusions x SET "mediaId" = $2 WHERE "mediaId" = $1
             AND NOT EXISTS (SELECT 1 FROM cleanup_exclusions y WHERE y."mediaId" = $2
               AND y."groupId" IS NOT DISTINCT FROM x."groupId"
               AND y."itemId" IS NOT DISTINCT FROM x."itemId")"#,
        from,
        into
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE media_moves SET "mediaId" = $2 WHERE "mediaId" = $1
             AND NOT EXISTS (SELECT 1 FROM media_moves WHERE "mediaId" = $2)"#,
        from,
        into
    )
    .execute(&mut *c)
    .await?;
    // No foreign key: the rows would outlive the media.
    sqlx::query!(
        r#"WITH d AS (DELETE FROM recommendation_dismissals WHERE "mediaId" = $1 RETURNING "userId")
           INSERT INTO recommendation_dismissals ("userId", "mediaId") SELECT "userId", $2 FROM d
           ON CONFLICT DO NOTHING"#,
        from,
        into
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE media t SET "posterUrl" = COALESCE(t."posterUrl", d."posterUrl"),
             overview = COALESCE(t.overview, d.overview), year = COALESCE(t.year, d.year),
             rating = COALESCE(t.rating, d.rating), "originalTitle" = COALESCE(t."originalTitle", d."originalTitle")
           FROM media d WHERE t.id = $2 AND d.id = $1"#,
        from,
        into
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"INSERT INTO book_details ("mediaId", subtitle, "originalLanguage", subjects)
           SELECT $2, subtitle, "originalLanguage", subjects FROM book_details WHERE "mediaId" = $1
           ON CONFLICT ("mediaId") DO UPDATE SET
             subtitle = COALESCE(book_details.subtitle, EXCLUDED.subtitle),
             "originalLanguage" = COALESCE(book_details."originalLanguage", EXCLUDED."originalLanguage"),
             subjects = COALESCE(book_details.subjects, EXCLUDED.subjects)"#,
        from,
        into
    )
    .execute(&mut *c)
    .await?;
    let held = orphans::refs_of(c, from).await?;
    sqlx::query!("DELETE FROM media WHERE id = $1", from)
        .execute(&mut *c)
        .await?;
    Ok(held)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::PgPool;

    /// Tables with a foreign key to `media` whose rows `absorb` carries over (some only in part,
    /// when the holder already has the same row).
    const MOVED: &[&str] = &[
        "book_details",
        "book_merges",
        "cleanup_exclusions",
        "collection_entries",
        "content_recommendations",
        "discovered_works",
        "editions",
        "item_groups",
        "likes",
        "media_credits",
        "media_external_ids",
        "media_files",
        "media_moves",
        "media_release_dates",
        "requests",
        "subtitle_blacklist",
        "subtitle_files",
        "wants",
    ];
    /// Left to cascade: the attach on the holder and the cleanup job derive them again, and a book
    /// has no other kind's details nor aliases of a music id.
    const DROPPED: &[&str] = &[
        "album_details",
        "cleanup_candidates",
        "comic_details",
        "media_external_id_aliases",
        "media_field_sources",
        "movie_details",
        "series_details",
    ];

    #[sqlx::test(migrations = false)]
    async fn every_table_with_a_media_key_is_moved_or_dropped_on_purpose(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let mut found: Vec<String> = sqlx::query_scalar(
            r#"SELECT DISTINCT c.conrelid::regclass::text FROM pg_constraint c
               WHERE c.contype = 'f' AND c.confrelid = 'media'::regclass"#,
        )
        .fetch_all(&db)
        .await
        .unwrap();
        found.sort();
        let mut listed: Vec<String> = MOVED.iter().chain(DROPPED).map(|t| (*t).into()).collect();
        listed.sort();
        assert_eq!(found, listed);
    }

    /// Tables with a composite foreign key onto `items`, `editions` or `media_files` by `(id, "mediaId")`:
    /// each must change media with its parent, in the one statement of `absorb`.
    const MOVED_WITH_PARENT: &[&str] = &[
        "collection_entries",
        "comic_issues",
        "edition_external_ids",
        "item_parts",
        "items",
        "media_credits",
        "media_release_dates",
        "track_details",
    ];

    #[sqlx::test(migrations = false)]
    async fn every_composite_key_on_a_media_child_moves_with_it(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let mut found: Vec<String> = sqlx::query_scalar(
            r#"SELECT DISTINCT c.conrelid::regclass::text FROM pg_constraint c
               WHERE c.contype = 'f' AND cardinality(c.conkey) = 2
                 AND c.confrelid IN ('items'::regclass, 'editions'::regclass, 'item_groups'::regclass,
                                     'media_files'::regclass)"#,
        )
        .fetch_all(&db)
        .await
        .unwrap();
        found.sort();
        let mut listed: Vec<String> = MOVED_WITH_PARENT
            .iter()
            .chain(&["album_details"])
            .map(|t| (*t).into())
            .collect();
        listed.sort();
        assert_eq!(found, listed);
    }

    #[sqlx::test(migrations = false)]
    async fn an_album_with_tracks_folds_into_another(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO persons (name) VALUES ('Ana');
               INSERT INTO libraries (name, "mediaTypes") VALUES ('l', '["album"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/x');
               INSERT INTO collections (name) VALUES ('c');
               INSERT INTO media (id, title, type) VALUES (1, 'Dup', 'album'), (2, 'Held', 'album');
               INSERT INTO editions (id, "mediaId", family) VALUES (1, 1, 'audio'), (2, 2, 'audio');
               INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 1, 1), (2, 2, 2);
               INSERT INTO track_details ("itemId", "mediaId", position) VALUES (1, 1, 1), (2, 2, 1);
               INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
                 VALUES (1, 1, 1, 'a.flac', 1, 'flac');
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version) VALUES (1, 1, 1, 0);
               INSERT INTO album_details ("mediaId", "targetEditionId") VALUES (1, 1), (2, 2);
               INSERT INTO media_credits ("mediaId", "editionId", "personId", role) VALUES (1, 1, 1, 'artist');
               INSERT INTO media_release_dates ("mediaId", "editionId", kind, date) VALUES (1, 1, 'release', '1999-01-01');
               INSERT INTO collection_entries ("collectionId", "mediaId", "itemId") VALUES (1, 1, 1);"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        absorb(&mut tx, 1, 2).await.unwrap();
        tx.commit().await.unwrap();
        let counts: (i64, i64, i64, i64, i64, i64, i64) = sqlx::query_as(
            r#"SELECT (SELECT count(*) FROM editions WHERE "mediaId" = 2),
                      (SELECT count(*) FROM track_details WHERE "mediaId" = 2),
                      (SELECT count(*) FROM item_parts WHERE "mediaId" = 2),
                      (SELECT count(*) FROM media_credits WHERE "mediaId" = 2 AND "editionId" IS NOT NULL),
                      (SELECT count(*) FROM media_release_dates WHERE "mediaId" = 2 AND "editionId" IS NOT NULL),
                      (SELECT count(*) FROM collection_entries WHERE "mediaId" = 2),
                      (SELECT count(*) FROM album_details WHERE "targetEditionId" = 2)"#,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(counts, (2, 2, 1, 1, 1, 1, 1));
    }

    #[sqlx::test(migrations = false)]
    async fn absorb_keeps_what_users_did_on_the_duplicate(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO users (id, username) VALUES (1, 'u'), (2, 'v');
               INSERT INTO media (id, title, type) VALUES (1, 'Dup', 'book'), (2, 'Held', 'book');
               INSERT INTO editions (id, "mediaId", family) VALUES (1, 1, 'text'), (2, 2, 'audio');
               INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 1, 1), (2, 2, 2);
               INSERT INTO playback_states ("userId", "itemId", "positionSeconds", completed)
                 VALUES (1, 1, 60, false);
               INSERT INTO likes ("userId", "mediaId") VALUES (1, 1), (1, 2), (2, 1);
               INSERT INTO likes ("userId", "mediaId", "itemId") VALUES (1, 1, 1);
               INSERT INTO content_recommendations ("senderId", "recipientId", "mediaId")
                 VALUES (1, 2, 1);
               INSERT INTO cleanup_exclusions ("mediaId") VALUES (1), (2);
               INSERT INTO cleanup_exclusions ("mediaId", "itemId") VALUES (1, 1);
               INSERT INTO recommendation_dismissals ("userId", "mediaId") VALUES (1, 1), (2, 1);
               INSERT INTO recommendation_dismissals ("userId", "mediaId") VALUES (1, 2);"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let mut tx = db.begin().await.unwrap();
        absorb(&mut tx, 1, 2).await.unwrap();
        tx.commit().await.unwrap();
        let counts: (i64, i64, i64, i64, i64, i64) = sqlx::query_as(
            r#"SELECT (SELECT count(*) FROM playback_states ps JOIN items i ON i.id = ps."itemId"
                        WHERE i."mediaId" = 2),
                      (SELECT count(*) FROM likes WHERE "mediaId" = 2),
                      (SELECT count(*) FROM content_recommendations WHERE "mediaId" = 2),
                      (SELECT count(*) FROM cleanup_exclusions WHERE "mediaId" = 2),
                      (SELECT count(*) FROM recommendation_dismissals WHERE "mediaId" = 2),
                      (SELECT count(*) FROM recommendation_dismissals WHERE "mediaId" = 1)"#,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(counts, (1, 3, 1, 2, 2, 0));
    }
}

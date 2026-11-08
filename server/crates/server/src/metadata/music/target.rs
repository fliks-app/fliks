//! The target edition of a monitored album (`docs/spec/music.md` rule 9): the release that best fits the
//! library, its tracks made wanted, a track already owned through another album left alone.
use super::{fetch, fetch_edition, write_edition};
use crate::{http::AppError, ingest::music::identify, libraries, state::AppState};
use fliks_domain::{
    external_id::Namespace, metadata::limiter::Priority, music::target::pick_target,
};
use sqlx::PgPool;

const NS: Namespace = Namespace::MUSICBRAINZ;

#[derive(sqlx::FromRow)]
struct Album {
    monitored: bool,
    library: Option<i32>,
    id: Option<String>,
    target: Option<i32>,
    parts: bool,
}

async fn album(db: &PgPool, media: i32) -> sqlx::Result<Option<Album>> {
    sqlx::query_as(
        r#"SELECT m.monitored, m."libraryId" AS library,
             (SELECT x.value FROM media_external_ids x
               WHERE x."mediaId" = m.id AND x.kind = 'album' AND x.provider = 'musicbrainz') AS id,
             (SELECT ad."targetEditionId" FROM album_details ad WHERE ad."mediaId" = m.id) AS target,
             EXISTS (SELECT 1 FROM item_parts p WHERE p."mediaId" = m.id) AS parts
           FROM media m WHERE m.id = $1 AND m.type = 'album'"#,
    )
    .bind(media)
    .fetch_optional(db)
    .await
}

/// A monitored track whose recording an item of another media already has a file for is no longer wanted.
async fn leave_owned(db: &PgPool, media: i32, edition: i32) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE items i SET monitored = false FROM track_details td
           WHERE td."itemId" = i.id AND i."editionId" = $1 AND i.monitored AND td."recordingMbid" IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = i.id)
             AND EXISTS (SELECT 1 FROM track_details o JOIN item_parts op ON op."itemId" = o."itemId"
                          WHERE o."recordingMbid" = td."recordingMbid" AND o."mediaId" <> $2)"#,
    )
    .bind(edition)
    .bind(media)
    .execute(db)
    .await
    .map(drop)
}

/// The edition holding the musicbrainz release `release`, created bare when the album has none.
async fn edition_of(db: &PgPool, media: i32, release: &str) -> sqlx::Result<i32> {
    let mut tx = db.begin().await?;
    sqlx::query("SELECT id FROM media WHERE id = $1 FOR UPDATE")
        .bind(media)
        .execute(&mut *tx)
        .await?;
    let held: Option<i32> = sqlx::query_scalar(
        r#"SELECT e.id FROM editions e JOIN edition_external_ids x ON x."editionId" = e.id
           WHERE e."mediaId" = $1 AND e.family = 'audio' AND x.provider = 'musicbrainz' AND x.value = $2"#,
    )
    .bind(media)
    .bind(release)
    .fetch_optional(&mut *tx)
    .await?;
    let id = match held {
        Some(id) => id,
        None => {
            sqlx::query_scalar(
                r#"INSERT INTO editions ("mediaId", family) VALUES ($1, 'audio') RETURNING id"#,
            )
            .bind(media)
            .fetch_one(&mut *tx)
            .await?
        }
    };
    tx.commit().await?;
    Ok(id)
}

async fn set_target(db: &PgPool, media: i32, edition: i32) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO album_details ("mediaId", "targetEditionId") VALUES ($1, $2)
           ON CONFLICT ("mediaId") DO UPDATE SET "targetEditionId" = EXCLUDED."targetEditionId""#,
    )
    .bind(media)
    .bind(edition)
    .execute(db)
    .await
    .map(drop)
}

/// The edition holding most of the album's files.
async fn held_edition(db: &PgPool, media: i32) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar(
        r#"SELECT i."editionId" FROM item_parts p JOIN items i ON i.id = p."itemId"
           WHERE p."mediaId" = $1 GROUP BY i."editionId" ORDER BY count(*) DESC, i."editionId" LIMIT 1"#,
    )
    .bind(media)
    .fetch_optional(db)
    .await
}

/// Picks the target edition of a monitored album and makes its tracks wanted; an album that already has
/// files targets the edition they made. `false` when there was nothing to do: not monitored, no id, or a
/// target already set.
pub async fn ensure(st: &AppState, media: i32, prio: Priority) -> Result<bool, AppError> {
    let Some(a) = album(&st.db, media).await? else {
        return Ok(false);
    };
    let (true, Some(id), Some(library), None) = (a.monitored, a.id, a.library, a.target) else {
        return Ok(false);
    };
    if a.parts {
        let Some(held) = held_edition(&st.db, media).await? else {
            return Ok(false);
        };
        set_target(&st.db, media, held).await?;
        return Ok(true);
    }
    let lang = crate::metadata::library_language(st, library).await?;
    let fetched = fetch(st, NS, &id, &lang, prio).await?;
    let profile = libraries::metadata_profile(&st.db, library).await?;
    let cfg = identify::config(st).await;
    let Some(release) = pick_target(&fetched.releases, &profile, &cfg) else {
        return Ok(false);
    };
    let edition_data = fetch_edition(st, NS, &release.external_id, &lang, prio).await?;
    let edition = edition_of(&st.db, media, &release.external_id).await?;
    write_edition(st, media, edition, &edition_data, true).await?;
    leave_owned(&st.db, media, edition).await?;
    set_target(&st.db, media, edition).await?;
    Ok(true)
}

/// The monitored albums that hold an id, no file and no target yet, oldest first: a provider that was
/// down when they were added is asked again.
pub async fn sweep(st: &AppState) -> Result<usize, AppError> {
    let ids: Vec<i32> = sqlx::query_scalar(
        r#"SELECT m.id FROM media m
           WHERE m.type = 'album' AND m.monitored AND m."libraryId" IS NOT NULL
             AND EXISTS (SELECT 1 FROM media_external_ids x WHERE x."mediaId" = m.id AND x.provider = 'musicbrainz')
             AND NOT EXISTS (SELECT 1 FROM item_parts p WHERE p."mediaId" = m.id)
             AND NOT EXISTS (SELECT 1 FROM album_details ad WHERE ad."mediaId" = m.id AND ad."targetEditionId" IS NOT NULL)
           ORDER BY m.id LIMIT 50"#,
    )
    .fetch_all(&st.db)
    .await?;
    let mut done = 0;
    for id in ids {
        match ensure(st, id, Priority::Background).await {
            Ok(true) => done += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!("album #{id}: no target edition yet: {}", e.text()),
        }
    }
    Ok(done)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn two_albums(db: &PgPool) {
        crate::db::migrate(db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'M', '["album"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO media (id, title, type, "libraryId", "folderName", monitored)
                 VALUES (1, 'Owned', 'album', 1, 'a/Owned', true), (2, 'Wanted', 'album', 1, 'a/Wanted', true);
               INSERT INTO editions ("mediaId", family) VALUES (1, 'audio'), (2, 'audio');
               INSERT INTO items ("mediaId", "editionId", monitored, title)
                 SELECT e."mediaId", e.id, true, 'T' FROM editions e, generate_series(1, 2) n;
               INSERT INTO track_details ("itemId", "mediaId", position, "recordingMbid")
                 SELECT i.id, i."mediaId", 1, CASE WHEN i.id = (SELECT min(x.id) FROM items x WHERE x."mediaId" = i."mediaId")
                      THEN '33333333-3333-3333-3333-333333333333'::uuid END FROM items i;
               WITH f AS (INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId")
                          VALUES ('x.flac', 1, 'flac', 1, (SELECT min(id) FROM library_folders)) RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
                 SELECT (SELECT min(i.id) FROM items i WHERE i."mediaId" = 1), f.id, 1, 0, 0 FROM f"#,
        )
        .execute(db)
        .await
        .unwrap();
    }

    #[sqlx::test(migrations = false)]
    async fn a_recording_owned_through_another_album_is_not_wanted_again(db: PgPool) {
        two_albums(&db).await;
        let edition: i32 = sqlx::query_scalar(r#"SELECT id FROM editions WHERE "mediaId" = 2"#)
            .fetch_one(&db)
            .await
            .unwrap();
        leave_owned(&db, 2, edition).await.unwrap();
        let wanted: Vec<(i32, bool)> = sqlx::query_as(
            r#"SELECT i.id % 2, i.monitored FROM items i WHERE i."mediaId" = 2 ORDER BY i.id"#,
        )
        .fetch_all(&db)
        .await
        .unwrap();
        // the item with the recording is left, the one without keeps being wanted
        assert_eq!(wanted.iter().filter(|(_, m)| *m).count(), 1);
        let left: i64 = sqlx::query_scalar(
            r#"SELECT count(*) FROM items i JOIN track_details td ON td."itemId" = i.id
                WHERE i."mediaId" = 2 AND NOT i.monitored AND td."recordingMbid" IS NOT NULL"#,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(left, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn an_album_with_files_targets_the_edition_that_holds_most_of_them(db: PgPool) {
        two_albums(&db).await;
        assert!(held_edition(&db, 2).await.unwrap().is_none());
        let held = held_edition(&db, 1).await.unwrap().unwrap();
        set_target(&db, 1, held).await.unwrap();
        let target: Option<i32> = sqlx::query_scalar(
            r#"SELECT "targetEditionId" FROM album_details WHERE "mediaId" = 1"#,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(target, Some(held));
        let again = edition_of(&db, 2, "44444444-4444-4444-4444-444444444444")
            .await
            .unwrap();
        assert_ne!(
            again, held,
            "a release the album does not hold gets its own edition"
        );
    }
}

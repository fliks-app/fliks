//! A merged MusicBrainz id is kept as an alias of the row that holds the surviving id
//! (`docs/spec/music.md` rule 15): lookups read the live id first, then the alias.
use crate::ingest::music::pairing::{Key, assign};
use crate::metadata::books::absorb::same_library;
use crate::{media::write::orphans::Refs, state::AppState};
use fliks_domain::external_id::ExternalProvider;
use sqlx::{PgConnection, PgPool};

const MB: &str = "musicbrainz";

/// The album holding `id` as its live id, else as an alias.
pub async fn album_of(db: impl sqlx::PgExecutor<'_>, id: &str) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar(
        r#"SELECT "mediaId" FROM (
             SELECT "mediaId", 0 AS alias FROM media_external_ids WHERE kind = 'album' AND provider = $1 AND value = $2
             UNION ALL
             SELECT "mediaId", 1 FROM media_external_id_aliases WHERE kind = 'album' AND provider = $1 AND value = $2
           ) x ORDER BY alias LIMIT 1"#,
    )
    .bind(MB)
    .bind(id)
    .fetch_optional(db)
    .await
}

/// The albums an id names: the release as its live id or an alias, or every release of the group.
pub async fn albums_named(db: impl sqlx::PgExecutor<'_>, id: &str) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"SELECT DISTINCT "mediaId" FROM (
             SELECT "mediaId" FROM media_external_ids WHERE kind = 'album' AND provider = $1 AND value = $2
             UNION ALL
             SELECT "mediaId" FROM media_external_id_aliases WHERE kind = 'album' AND provider = $1 AND value = $2
             UNION ALL
             SELECT "mediaId" FROM album_details WHERE "releaseGroupMbid" = $3::uuid
           ) x ORDER BY 1"#,
    )
    .bind(MB)
    .bind(id)
    .bind(ExternalProvider::MusicBrainz.normalize(id))
    .fetch_all(db)
    .await
}

/// The one album an id names (see `albums_named`); none when it names no album or several of them.
pub async fn sole_album_named(
    db: impl sqlx::PgExecutor<'_>,
    id: &str,
) -> sqlx::Result<Option<i32>> {
    Ok(match albums_named(db, id).await?.as_slice() {
        [media] => Some(*media),
        _ => None,
    })
}

/// The person holding `id` as its live id, else as an alias.
pub async fn person_of(db: impl sqlx::PgExecutor<'_>, id: &str) -> sqlx::Result<Option<i32>> {
    sqlx::query_scalar(
        r#"SELECT "personId" FROM (
             SELECT "personId", 0 AS alias FROM person_external_ids WHERE provider = $1 AND value = $2
             UNION ALL
             SELECT "personId", 1 FROM person_external_id_aliases WHERE provider = $1 AND value = $2
           ) x ORDER BY alias LIMIT 1"#,
    )
    .bind(MB)
    .bind(id)
    .fetch_optional(db)
    .await
}

/// What a redirect did.
#[derive(Debug, PartialEq, Eq)]
pub enum Moved {
    /// The row now holds the new id, the old one is its alias.
    Renamed,
    /// Another row held the new id: the row was folded into it.
    Folded(i32),
    /// The old id is no longer on this row.
    Gone,
    /// An album of another library holds the new id: nothing moved.
    Elsewhere,
}

/// The album `media` held `old` and the provider now answers `new`: `new` becomes its live id and `old` its
/// alias. An album that already holds `new` absorbs it instead. The caller holds the media's lock.
pub async fn redirect_album(
    st: &AppState,
    media: i32,
    old: &str,
    new: &str,
) -> sqlx::Result<(Moved, Option<Refs>)> {
    let mut tx = st.db.begin().await?;
    let held: Option<i32> = sqlx::query_scalar(
        r#"SELECT "mediaId" FROM media_external_ids WHERE kind = 'album' AND provider = $1 AND value = $2"#,
    )
    .bind(MB)
    .bind(new)
    .fetch_optional(&mut *tx)
    .await?;
    let live: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM media_external_ids WHERE "mediaId" = $1 AND kind = 'album' AND provider = $2 AND value = $3)"#,
    )
    .bind(media)
    .bind(MB)
    .bind(old)
    .fetch_one(&mut *tx)
    .await?;
    if !live {
        return Ok((Moved::Gone, None));
    }
    if let Some(other) = held.filter(|o| *o != media) {
        if !same_library(&mut tx, media, other).await? {
            tracing::warn!("album #{media}: an album of another library holds the merged id");
            return Ok((Moved::Elsewhere, None));
        }
        let refs = fold(&mut tx, media, other, Some(old)).await?;
        tx.commit().await?;
        return Ok((Moved::Folded(other), Some(refs)));
    }
    sqlx::query(
        r#"DELETE FROM media_external_id_aliases WHERE kind = 'album' AND provider = $1 AND value = $2"#,
    )
    .bind(MB)
    .bind(new)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"UPDATE media_external_ids SET value = $4 WHERE "mediaId" = $1 AND kind = 'album' AND provider = $2 AND value = $3"#,
    )
    .bind(media)
    .bind(MB)
    .bind(old)
    .bind(new)
    .execute(&mut *tx)
    .await?;
    add_album_alias(&mut tx, media, old).await?;
    tx.commit().await?;
    Ok((Moved::Renamed, None))
}

/// `value` as an alias of `media`, unless another album holds it as its live id.
async fn add_album_alias(c: &mut PgConnection, media: i32, value: &str) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO media_external_id_aliases ("mediaId", kind, provider, value)
           SELECT $1, 'album', $2, $3
            WHERE NOT EXISTS (SELECT 1 FROM media_external_ids
                               WHERE kind = 'album' AND provider = $2 AND value = $3)
           ON CONFLICT (kind, provider, value) DO UPDATE SET "mediaId" = EXCLUDED."mediaId""#,
    )
    .bind(media)
    .bind(MB)
    .bind(value)
    .execute(c)
    .await
    .map(drop)
}

/// `from` is folded into `into`: its aliases and its live id (`old`) become `into`'s aliases, then the
/// generic absorb moves what it owns. The caller `release`s the result once the transaction commits.
async fn fold(c: &mut PgConnection, from: i32, into: i32, old: Option<&str>) -> sqlx::Result<Refs> {
    sqlx::query(
        r#"UPDATE media_external_id_aliases SET "mediaId" = $2 WHERE "mediaId" = $1 AND kind = 'album'"#,
    )
    .bind(from)
    .bind(into)
    .execute(&mut *c)
    .await?;
    sqlx::query(
        r#"DELETE FROM media_external_ids WHERE "mediaId" = $1 AND kind = 'album' AND provider = $2"#,
    )
    .bind(from)
    .bind(MB)
    .execute(&mut *c)
    .await?;
    if let Some(old) = old {
        add_album_alias(c, into, old).await?;
    }
    let editions = editions_of(c, from, into).await?;
    let refs = crate::metadata::books::absorb::absorb(c, from, into).await?;
    if let Some((old, kept)) = editions {
        merge_editions(c, old, kept).await?;
    }
    Ok(refs)
}

/// A track as the merge of two albums reads it.
#[derive(sqlx::FromRow)]
struct Track {
    item: i32,
    recording: Option<String>,
    isrc: Option<String>,
    disc: i32,
    number: Option<i32>,
    duration_ms: Option<i32>,
    title: Option<String>,
}

impl Track {
    fn key(&self) -> Key {
        Key::new(
            (self.recording.clone(), self.isrc.clone()),
            (self.disc, self.number),
            self.duration_ms,
            self.title.as_deref(),
        )
    }
}

fn keys(tracks: &[&Track]) -> Vec<Key> {
    tracks.iter().map(|t| t.key()).collect()
}

const TRACKS: &str = r#"SELECT i.id AS item, td."recordingMbid"::text AS recording, td.isrc, td."discNumber" AS disc,
       td."trackNumber" AS number, td."durationMs" AS duration_ms, i.title
     FROM items i JOIN track_details td ON td."itemId" = i.id
     WHERE i."editionId" = $1 AND "#;

/// The audio editions of `from` and of `into`, when both albums have one.
async fn editions_of(
    c: &mut PgConnection,
    from: i32,
    into: i32,
) -> sqlx::Result<Option<(i32, i32)>> {
    let edition = |media| {
        sqlx::query_scalar::<_, i32>(
            r#"SELECT id FROM editions WHERE "mediaId" = $1 AND family = 'audio' ORDER BY id LIMIT 1"#,
        )
        .bind(media)
    };
    Ok(edition(from)
        .fetch_optional(&mut *c)
        .await?
        .zip(edition(into).fetch_optional(&mut *c).await?))
}

/// An album holds one edition: filed tracks of `old` take over the free tracks of `kept` they pair with, or
/// join the filed ones as older versions; `old` goes with the rest.
async fn merge_editions(c: &mut PgConnection, old: i32, kept: i32) -> sqlx::Result<()> {
    let load = |edition: i32, filed: bool| {
        let clause = if filed { "EXISTS" } else { "NOT EXISTS" };
        sqlx::query_as::<_, Track>(sqlx::AssertSqlSafe(format!(
            "{TRACKS} {clause} (SELECT 1 FROM item_parts p WHERE p.\"itemId\" = i.id) ORDER BY i.id"
        )))
        .bind(edition)
    };
    let filed = load(old, true).fetch_all(&mut *c).await?;
    let free = load(kept, false).fetch_all(&mut *c).await?;
    let held = load(kept, true).fetch_all(&mut *c).await?;
    let all: Vec<&Track> = filed.iter().collect();
    let by_free = assign(&keys(&all), &keys(&free.iter().collect::<Vec<_>>()));
    for (t, heir) in filed.iter().zip(&by_free) {
        if let Some(heir) = heir {
            take_over(c, t.item, free[*heir].item).await?;
        }
    }
    let rest: Vec<&Track> = filed
        .iter()
        .zip(&by_free)
        .filter(|(_, h)| h.is_none())
        .map(|(t, _)| t)
        .collect();
    let by_held = assign(&keys(&rest), &keys(&held.iter().collect::<Vec<_>>()));
    for (t, twin) in rest.iter().zip(&by_held) {
        if let Some(twin) = twin {
            add_versions(c, t.item, held[*twin].item).await?;
        }
    }
    sqlx::query(
        r#"DELETE FROM items WHERE "editionId" = $1 AND NOT EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = items.id)"#,
    )
    .bind(old)
    .execute(&mut *c)
    .await?;
    sqlx::query(r#"UPDATE items SET "editionId" = $2 WHERE "editionId" = $1"#)
        .bind(old)
        .bind(kept)
        .execute(&mut *c)
        .await?;
    sqlx::query("DELETE FROM editions WHERE id = $1")
        .bind(old)
        .execute(&mut *c)
        .await?;
    Ok(())
}

/// The filed track `filed` becomes the free track `heir`: its edition, title, monitoring, details, credits and
/// works, the queue rows that target it and the user rows it held; the file's ReplayGain and length stay.
async fn take_over(c: &mut PgConnection, filed: i32, heir: i32) -> sqlx::Result<()> {
    let (gain, peak, duration): (Option<f32>, Option<f32>, Option<i32>) =
        sqlx::query_as(r#"SELECT gain, peak, "durationMs" FROM track_details WHERE "itemId" = $1"#)
            .bind(filed)
            .fetch_optional(&mut *c)
            .await?
            .unwrap_or_default();
    for table in ["track_details", "item_credits", "item_works"] {
        sqlx::query(sqlx::AssertSqlSafe(format!(
            r#"DELETE FROM {table} WHERE "itemId" = $1"#
        )))
        .bind(filed)
        .execute(&mut *c)
        .await?;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            r#"UPDATE {table} SET "itemId" = $1 WHERE "itemId" = $2"#
        )))
        .bind(filed)
        .bind(heir)
        .execute(&mut *c)
        .await?;
    }
    sqlx::query(
        r#"UPDATE track_details SET gain = COALESCE($2, gain), peak = COALESCE($3, peak),
             "durationMs" = COALESCE($4, "durationMs") WHERE "itemId" = $1"#,
    )
    .bind(filed)
    .bind(gain)
    .bind(peak)
    .bind(duration)
    .execute(&mut *c)
    .await?;
    sqlx::query(
        r#"UPDATE items t SET title = h.title, monitored = h.monitored, "editionId" = h."editionId"
             FROM items h WHERE t.id = $1 AND h.id = $2"#,
    )
    .bind(filed)
    .bind(heir)
    .execute(&mut *c)
    .await?;
    sqlx::query(
        r#"UPDATE acquisition_queue SET "itemIds" = array_replace("itemIds", $2, $1) WHERE $2 = ANY("itemIds")"#,
    )
    .bind(filed)
    .bind(heir)
    .execute(&mut *c)
    .await?;
    move_user_rows(c, heir, filed).await?;
    sqlx::query("DELETE FROM items WHERE id = $1")
        .bind(heir)
        .execute(&mut *c)
        .await?;
    Ok(())
}

/// The files of the track `from` become older versions of the track `into`, whose own keep playing (the
/// version numbers of its files and plays move up); `from` is deleted.
async fn add_versions(c: &mut PgConnection, from: i32, into: i32) -> sqlx::Result<()> {
    let below: i32 = sqlx::query_scalar(
        r#"SELECT COALESCE(max(version) + 1, 0) FROM item_parts WHERE "itemId" = $1"#,
    )
    .bind(from)
    .fetch_one(&mut *c)
    .await?;
    // Two steps: a unique key never sees a number twice.
    for (table, columns) in [
        ("item_parts", &["version"][..]),
        ("playback_states", &["version"][..]),
        ("item_version_aliases", &["version", "toVersion"][..]),
    ] {
        for shift in [VERSION_PARK, below - VERSION_PARK] {
            let set: Vec<String> = columns
                .iter()
                .map(|c| format!(r#""{c}" = "{c}" + {shift}"#))
                .collect();
            sqlx::query(sqlx::AssertSqlSafe(format!(
                r#"UPDATE {table} SET {} WHERE "itemId" = $1"#,
                set.join(", ")
            )))
            .bind(into)
            .execute(&mut *c)
            .await?;
        }
    }
    sqlx::query(r#"UPDATE item_parts SET "itemId" = $2 WHERE "itemId" = $1"#)
        .bind(from)
        .bind(into)
        .execute(&mut *c)
        .await?;
    move_user_rows(c, from, into).await?;
    sqlx::query("DELETE FROM items WHERE id = $1")
        .bind(from)
        .execute(&mut *c)
        .await
        .map(drop)
}

/// Far above any version number: parks the numbers of a table while they shift.
const VERSION_PARK: i32 = 1_000_000;

/// The rows that hang on the track `from` (likes, plays, lyrics, playlist entries, annotations, party rows) move
/// to `to`, one by one: one that `to` holds already stays and goes with `from`.
async fn move_user_rows(c: &mut PgConnection, from: i32, to: i32) -> sqlx::Result<()> {
    let columns: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT DISTINCT c.conrelid::regclass::text, quote_ident(a.attname)
             FROM pg_constraint c
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
            WHERE c.contype = 'f' AND c.confrelid = 'items'::regclass AND a.attname = 'itemId'
              AND c.conrelid NOT IN ('item_parts'::regclass, 'track_details'::regclass,
                                     'item_credits'::regclass, 'item_works'::regclass)"#,
    )
    .fetch_all(&mut *c)
    .await?;
    for (table, column) in columns {
        let rows: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            "SELECT ctid::text FROM {table} WHERE {column} = $1"
        )))
        .bind(from)
        .fetch_all(&mut *c)
        .await?;
        for ctid in rows {
            sqlx::query("SAVEPOINT move_row").execute(&mut *c).await?;
            let moved = sqlx::query(sqlx::AssertSqlSafe(format!(
                "UPDATE {table} SET {column} = $1 WHERE ctid = $2::tid"
            )))
            .bind(to)
            .bind(&ctid)
            .execute(&mut *c)
            .await;
            let undo = if moved.is_ok() {
                "RELEASE SAVEPOINT move_row"
            } else {
                "ROLLBACK TO SAVEPOINT move_row"
            };
            sqlx::query(undo).execute(&mut *c).await?;
        }
    }
    Ok(())
}

/// `from` (an album that holds no id) is folded into `into`, which holds the id its files were matched to;
/// `false` and nothing moved when `into` is in another library.
pub async fn absorb_into(st: &AppState, from: i32, into: i32) -> sqlx::Result<bool> {
    let mut tx = st.db.begin().await?;
    if !same_library(&mut tx, from, into).await? {
        return Ok(false);
    }
    let refs = fold(&mut tx, from, into, None).await?;
    tx.commit().await?;
    crate::media::write::orphans::release(st, refs);
    Ok(true)
}

/// The person `person` held `old` and the provider now answers `new`; a person that already holds `new`
/// keeps it and nothing moves.
pub async fn redirect_person(
    db: &PgPool,
    person: i32,
    old: &str,
    new: &str,
) -> sqlx::Result<Moved> {
    let mut tx = db.begin().await?;
    let held: Option<i32> = sqlx::query_scalar(
        r#"SELECT "personId" FROM person_external_ids WHERE provider = $1 AND value = $2"#,
    )
    .bind(MB)
    .bind(new)
    .fetch_optional(&mut *tx)
    .await?;
    if held.is_some_and(|h| h != person) {
        return Ok(Moved::Folded(held.unwrap_or_default()));
    }
    sqlx::query(r#"DELETE FROM person_external_id_aliases WHERE provider = $1 AND value = $2"#)
        .bind(MB)
        .bind(new)
        .execute(&mut *tx)
        .await?;
    let n = sqlx::query(
        r#"UPDATE person_external_ids SET value = $4 WHERE "personId" = $1 AND provider = $2 AND value = $3"#,
    )
    .bind(person)
    .bind(MB)
    .bind(old)
    .bind(new)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Ok(Moved::Gone);
    }
    sqlx::query(
        r#"INSERT INTO person_external_id_aliases ("personId", provider, value) VALUES ($1, $2, $3)
           ON CONFLICT (provider, value) DO UPDATE SET "personId" = EXCLUDED."personId""#,
    )
    .bind(person)
    .bind(MB)
    .bind(old)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Moved::Renamed)
}

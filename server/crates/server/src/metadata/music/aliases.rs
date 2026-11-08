//! A merged MusicBrainz id is kept as an alias of the row that holds the surviving id
//! (`docs/spec/music.md` rule 15): lookups read the live id first, then the alias.
use crate::{media::write::orphans::Refs, state::AppState};
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
    crate::metadata::books::absorb::absorb(c, from, into).await
}

/// `from` (an album that holds no id) is folded into `into`, which holds the id its files were matched to.
pub async fn absorb_into(st: &AppState, from: i32, into: i32) -> sqlx::Result<()> {
    let mut tx = st.db.begin().await?;
    let refs = fold(&mut tx, from, into, None).await?;
    tx.commit().await?;
    crate::media::write::orphans::release(st, refs);
    Ok(())
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

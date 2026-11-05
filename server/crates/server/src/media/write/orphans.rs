//! What a deleted media leaves behind (`media-write.md` rule 67a): the persons it credited and the
//! collections it was in, once nothing else holds them, and its images.
use crate::{
    images::paths::{Size, Target},
    state::AppState,
};
use sqlx::PgConnection;
use std::path::Path;

/// Taken by every transaction that references a person or a collection, so a cleanup never deletes
/// one between its lookup and its use.
pub async fn hold(c: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtext('persons:orphans'))")
        .execute(c)
        .await
        .map(|_| ())
}

/// The rows a media references, read in its delete transaction before the cascade.
#[derive(Debug, Default)]
pub struct Refs {
    media: i32,
    persons: Vec<i32>,
    collections: Vec<i32>,
    groups: Vec<i32>,
    items: Vec<i32>,
}

pub async fn refs_of(c: &mut PgConnection, media: i32) -> sqlx::Result<Refs> {
    let ids = |sql: &'static str| sqlx::query_scalar::<_, i32>(sql).bind(media);
    Ok(Refs {
        media,
        persons: ids(r#"SELECT DISTINCT "personId" FROM media_credits WHERE "mediaId" = $1"#)
            .fetch_all(&mut *c)
            .await?,
        collections: ids(
            r#"SELECT DISTINCT "collectionId" FROM collection_entries WHERE "mediaId" = $1"#,
        )
        .fetch_all(&mut *c)
        .await?,
        groups: ids(r#"SELECT id FROM item_groups WHERE "mediaId" = $1"#)
            .fetch_all(&mut *c)
            .await?,
        items: ids(r#"SELECT id FROM items WHERE "mediaId" = $1"#)
            .fetch_all(&mut *c)
            .await?,
    })
}

/// `clean` in the background, once the media's delete has committed.
pub fn release(st: &AppState, refs: Refs) {
    let st = st.clone();
    tokio::spawn(async move {
        if let Err(e) = clean(&st, &refs).await {
            tracing::warn!("Cleanup after media #{}: {e}", refs.media);
        }
    });
}

pub async fn clean(st: &AppState, refs: &Refs) -> sqlx::Result<()> {
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('persons:orphans'))")
        .execute(&mut *tx)
        .await?;
    let persons = sqlx::query_scalar::<_, i32>(
        r#"DELETE FROM persons p WHERE p.id = ANY($1)
             AND NOT EXISTS (SELECT 1 FROM media_credits c WHERE c."personId" = p.id)
             AND NOT EXISTS (SELECT 1 FROM person_follows f WHERE f."personId" = p.id)
           RETURNING id"#,
    )
    .bind(&refs.persons)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query(
        r#"DELETE FROM collections c WHERE c.id = ANY($1)
             AND NOT EXISTS (SELECT 1 FROM collection_entries e WHERE e."collectionId" = c.id)
             AND NOT EXISTS (SELECT 1 FROM series_watches w WHERE w."collectionId" = c.id)"#,
    )
    .bind(&refs.collections)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let root = st.images.root();
    remove(&root.join("media").join(refs.media.to_string())).await;
    let targets = (refs.groups.iter().map(|g| Target::season(*g)))
        .chain(refs.items.iter().map(|i| Target::episode(*i)))
        .chain(persons.iter().map(|p| Target::person(*p)));
    for t in targets {
        for size in [Size::Full, Size::Medium, Size::Thumb] {
            remove(&t.file(root, size)).await;
        }
        remove(&t.sidecar(root)).await;
    }
    Ok(())
}

/// A missing file or folder is already clean.
async fn remove(path: &Path) {
    let gone = if path.is_dir() {
        tokio::fs::remove_dir_all(path).await
    } else {
        tokio::fs::remove_file(path).await
    };
    if let Err(e) = gone
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("Image {} not removed: {e}", path.display());
    }
}

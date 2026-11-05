//! What a deleted media leaves behind (`media-write.md` rule 67a): persons with no credit and no
//! follow, collections with no entry and no watch, and the image files of rows that are gone.
use crate::state::AppState;
use sqlx::PgConnection;
use std::{
    collections::HashSet,
    sync::atomic::{AtomicBool, Ordering},
};

static PENDING: AtomicBool = AtomicBool::new(false);
static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Taken by every transaction that credits or follows a person, so a sweep never deletes one between
/// its lookup and its credit.
pub async fn hold_persons(c: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock_shared(hashtext('persons:orphans'))")
        .execute(c)
        .await
        .map(|_| ())
}

/// Queues a sweep in the background; calls made while one waits share it.
pub fn schedule(st: &AppState) {
    if PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let st = st.clone();
    tokio::spawn(async move {
        let _one = RUNNING.lock().await;
        PENDING.store(false, Ordering::SeqCst);
        if let Err(e) = sweep(&st).await {
            tracing::warn!("Orphan sweep failed: {e}");
        }
    });
}

pub async fn sweep(st: &AppState) -> sqlx::Result<()> {
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('persons:orphans'))")
        .execute(&mut *tx)
        .await?;
    let persons = sqlx::query_scalar::<_, i32>(
        r#"DELETE FROM persons p
           WHERE NOT EXISTS (SELECT 1 FROM media_credits c WHERE c."personId" = p.id)
             AND NOT EXISTS (SELECT 1 FROM person_follows f WHERE f."personId" = p.id)
           RETURNING id"#,
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let collections = sqlx::query(
        // A collection a writer is adding an entry to holds a key-share lock: it is skipped.
        r#"DELETE FROM collections WHERE id IN (
             SELECT c.id FROM collections c
              WHERE NOT EXISTS (SELECT 1 FROM collection_entries e WHERE e."collectionId" = c.id)
                AND NOT EXISTS (SELECT 1 FROM series_watches w WHERE w."collectionId" = c.id)
              FOR UPDATE SKIP LOCKED)"#,
    )
    .execute(&st.db)
    .await?
    .rows_affected();
    let mut files = 0;
    for (dir, rows) in [
        ("media", "SELECT id FROM media"),
        ("seasons", "SELECT id FROM item_groups"),
        ("episodes", "SELECT id FROM items"),
        ("persons", "SELECT id FROM persons"),
    ] {
        let dir = st.images.root().join(dir);
        // Listed before the ids are read: an image is written after its row commits.
        let Ok(mut rd) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        let mut names = vec![];
        while let Ok(Some(e)) = rd.next_entry().await {
            names.push(e.file_name().to_string_lossy().into_owned());
        }
        let ids: HashSet<i32> = sqlx::query_scalar(rows)
            .fetch_all(&st.db)
            .await?
            .into_iter()
            .collect();
        for name in names {
            let Some(id) = owner(&name) else { continue };
            if ids.contains(&id) {
                continue;
            }
            let path = dir.join(&name);
            let gone = if path.is_dir() {
                tokio::fs::remove_dir_all(&path).await
            } else {
                tokio::fs::remove_file(&path).await
            };
            match gone {
                Ok(()) => files += 1,
                Err(e) => tracing::warn!("Orphan image {} not removed: {e}", path.display()),
            }
        }
    }
    if !persons.is_empty() || collections > 0 || files > 0 {
        tracing::info!(
            "Orphan sweep: {} person(s), {collections} collection(s), {files} image entries removed",
            persons.len()
        );
    }
    Ok(())
}

/// The row id an image entry belongs to: `137`, `42-thumb.jpg`, `42.src.json`; `None` for anything else.
fn owner(name: &str) -> Option<i32> {
    let id = name.split(['-', '.']).next()?;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
        .then(|| id.parse().ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::owner;

    #[test]
    fn an_image_entry_names_its_row() {
        assert_eq!(owner("137"), Some(137));
        assert_eq!(owner("42-thumb.jpg"), Some(42));
        assert_eq!(owner("42.src.json"), Some(42));
        assert_eq!(owner(".fliks-tmp-ab12"), None);
        assert_eq!(owner("notes.txt"), None);
    }
}

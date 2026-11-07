//! Whether a file may be replaced under its readers, and whether it is still the bytes a job read.
use crate::{ingest::rescan::mtime_ms, state::AppState};

/// Seconds since the last save of a playback state under which someone is taken to be listening.
pub const LISTENING_SECS: f64 = 600.0;

/// Whether a live session or a recent playback state names an item of these files.
pub async fn listening(st: &AppState, ids: &[i32]) -> sqlx::Result<bool> {
    let items: Vec<i32> = sqlx::query_scalar(
        r#"SELECT DISTINCT "itemId" FROM item_parts WHERE "mediaFileId" = ANY($1)"#,
    )
    .bind(ids)
    .fetch_all(&st.db)
    .await?;
    if st.presence.list().iter().any(|s| {
        s.item_id.is_some_and(|i| items.contains(&i))
            || ids.iter().any(|f| *f as u32 == s.media_file_id)
    }) {
        return Ok(true);
    }
    sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM playback_states WHERE "itemId" = ANY($1)
             AND "lastPlayedAt" > now() - make_interval(secs => $2))"#,
    )
    .bind(&items)
    .bind(LISTENING_SECS)
    .fetch_one(&st.db)
    .await
}

/// Whether the file on disk still has the stored size and, when one is stored, the stored mtime.
pub fn on_disk_matches(meta: &std::fs::Metadata, size: i64, mtime: Option<i64>) -> bool {
    meta.len() as i64 == size && (mtime.is_none() || mtime_ms(meta) == mtime)
}

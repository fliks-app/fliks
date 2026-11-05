//! The sprite and source-scan jobs of one media file, run for the post-import queue and the rescans.
use super::{file::resolve_file, scan, sprite};
use crate::{events::Subject, http::AppError, state::AppState};
use fliks_engine_core::api::{JobPriority, SpriteMeta};

/// The file's seek-bar sprite, detached so a caller giving up leaves no activity row behind.
pub async fn sprite_file(
    st: &AppState,
    id: i32,
    force: bool,
    priority: JobPriority,
    parent_id: Option<String>,
) -> Result<Option<SpriteMeta>, AppError> {
    let file = resolve_file(st, None, i64::from(id)).await?;
    let title = file.media_title.clone().unwrap_or_default();
    let subject = crate::events::subject::for_file(&st.db, file.id)
        .await?
        .unwrap_or_else(|| Subject::titled(&title));
    let st = st.clone();
    Ok(tokio::spawn(async move {
        sprite::generate(
            &st,
            sprite::SpriteJob {
                file_id: file.id,
                path: &file.absolute,
                info: file.info.as_ref(),
                title: &title,
                subject,
                force,
                priority,
                parent_id,
            },
        )
        .await
    })
    .await
    .ok()
    .flatten())
}

/// Scans the file's source unless its current version was; detached so it is not left marked scanning.
pub async fn scan_file(st: &AppState, id: i32, priority: JobPriority) -> Result<(), AppError> {
    let file = resolve_file(st, None, i64::from(id)).await?;
    let st = st.clone();
    let _ = tokio::spawn(async move {
        scan::schedule_if_needed(&st, file.id, &file.absolute, file.info, priority).await;
    })
    .await;
    Ok(())
}

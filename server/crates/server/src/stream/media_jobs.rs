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
) -> Result<Option<SpriteMeta>, AppError> {
    let file = resolve_file(st, None, i64::from(id)).await?;
    let title = file.media_title.clone().unwrap_or_default();
    let subject = subject_of(st, &file, &title).await?;
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

/// `buildMediaProgressSubject`: the media, plus the episode when the file is one.
async fn subject_of(
    st: &AppState,
    file: &super::ResolvedFile,
    title: &str,
) -> Result<Subject, AppError> {
    let ep = match file.episode_id {
        Some(id) => {
            sqlx::query!(
                r#"SELECT e.title AS "title?", e."episodeNumber" AS "number?", s."seasonNumber" AS "season?"
                   FROM episodes e LEFT JOIN seasons s ON s.id = e."seasonId" WHERE e.id = $1"#,
                id
            )
            .fetch_optional(&st.db)
            .await?
        }
        None => None,
    };
    // Without a season number the subject stays the media's, like the TS builder.
    let ep = ep.filter(|e| e.season.is_some());
    let numbered = ep.as_ref().is_some_and(|e| e.number.is_some());
    Ok(Subject {
        title: title.to_owned(),
        media_id: file.media_id.map(i64::from),
        media_type: file.media_type,
        season_number: ep.as_ref().and_then(|e| e.season).map(i64::from),
        episode_number: ep.as_ref().and_then(|e| e.number).map(i64::from),
        episode_title: ep
            .as_ref()
            .filter(|_| numbered)
            .and_then(|e| e.title.clone()),
        episode_id: file.episode_id.filter(|_| numbered).map(i64::from),
    })
}

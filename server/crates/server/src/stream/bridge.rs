//! Nest's way into the sprite and source-scan jobs (`bridge.md`): the file is looked up here, the jobs run here.
use super::{file::resolve_file, scan, sprite};
use crate::{events::Subject, http::AppError, state::AppState};
use axum::{
    Json,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
};
use fliks_engine_core::api::{JobPriority, SpriteMeta};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Req {
    media_file_id: i32,
    #[serde(default)]
    force: bool,
    priority: Option<JobPriority>,
}

fn parse(st: &AppState, h: &HeaderMap, body: &[u8]) -> Result<Req, AppError> {
    st.bridge.check(h)?;
    serde_json::from_slice(body).map_err(|e| AppError::bad_request(e.to_string()))
}

/// 200 with the sprite's metadata, 204 when none could be made (no duration, or the job failed).
pub async fn sprite(
    State(st): State<AppState>,
    h: HeaderMap,
    body: Bytes,
) -> Result<Result<Json<SpriteMeta>, StatusCode>, AppError> {
    let r = parse(&st, &h, &body)?;
    let file = resolve_file(&st, None, i64::from(r.media_file_id)).await?;
    let title = file.media_title.clone().unwrap_or_default();
    let subject = subject_of(&st, &file, &title).await?;
    let meta = sprite::generate(
        &st,
        sprite::SpriteJob {
            file_id: file.id,
            path: &file.absolute,
            info: file.info.as_ref(),
            title: &title,
            subject,
            force: r.force,
            priority: r.priority.unwrap_or(JobPriority::Low),
        },
    )
    .await;
    Ok(meta.map(Json).ok_or(StatusCode::NO_CONTENT))
}

/// 204 once the scan is settled (done, not needed, or failed and logged).
pub async fn source(
    State(st): State<AppState>,
    h: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, AppError> {
    let r = parse(&st, &h, &body)?;
    let file = resolve_file(&st, None, i64::from(r.media_file_id)).await?;
    let priority = r.priority.unwrap_or(JobPriority::Low);
    scan::schedule_if_needed(&st, file.id, &file.absolute, file.info, priority).await;
    Ok(StatusCode::NO_CONTENT)
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
        media_type: file.media_type.clone(),
        season_number: ep.as_ref().and_then(|e| e.season).map(i64::from),
        episode_number: ep.as_ref().and_then(|e| e.number).map(i64::from),
        episode_title: ep
            .as_ref()
            .filter(|_| numbered)
            .and_then(|e| e.title.clone()),
        episode_id: file.episode_id.filter(|_| numbered).map(i64::from),
    })
}

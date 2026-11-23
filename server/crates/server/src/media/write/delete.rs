//! Media, file and library delete routes (rules 66, 75-77): the services are in `media::service`.
use super::gate;
use crate::{
    events::SseEvent,
    http::{AppError, auth::Authed, validate::PathParams},
    ingest::{MediaRow, load_media},
    media::service::{delete_media_file, media_dirs_to_remove, remove_media},
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use fliks_domain::acl::{Action, Subject};
use serde_json::{Value, json};
use std::collections::HashMap;

fn delete_failed(st: &AppState, user: i32, m: &MediaRow) {
    st.hub.emit_to_user(
        user,
        SseEvent::MediaFilesDeleteFailed {
            media_id: i64::from(m.id),
            title: m.title.clone(),
        },
    );
}

/// `DELETE /api/media/:id` (rule 66): the folder goes after the response, contained (rule 70).
#[utoipa::path(delete, path = "/api/media/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    let id = gate(&st, &a, Action::Delete, id).await?;
    let guard = st.ingest.media.lock(id).await;
    let (media, left) = remove_media(&st, &guard, id).await?;
    let user = a.user.id;
    let st2 = st.clone();
    tokio::spawn(async move {
        let _guard = guard;
        let m = &media;
        for dir in media_dirs_to_remove(&st2, m, &left).await {
            match dir {
                Ok(d) => {
                    let path = d.dir.clone();
                    match tokio::task::spawn_blocking(move || d.remove()).await {
                        Ok(Ok(())) => {
                            tracing::info!("Deleted media folder on disk: {}", path.display())
                        }
                        Ok(Err(e)) => {
                            tracing::error!(
                                "Media file deletion failed: id={} title=\"{}\" path=\"{}\" error={e}",
                                m.id,
                                m.title,
                                path.display()
                            );
                            delete_failed(&st2, user, m);
                        }
                        Err(e) => tracing::error!("media folder removal task: {e}"),
                    }
                }
                Err(why) => {
                    tracing::warn!("Media #{} \"{}\": folder kept ({why})", m.id, m.title);
                    delete_failed(&st2, user, m);
                }
            }
        }
    });
    Ok(Json(json!({"ok": true})))
}

/// `DELETE /api/media/:id/files/:fileId` (rule 77): only the string `true` deletes on disk.
#[utoipa::path(delete, path = "/api/media/{id}/files/{fileId}", responses((status = 200)))]
pub async fn remove_file(
    State(st): State<AppState>,
    a: Authed,
    ids: Result<PathParams<(i32, i32)>, AppError>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Delete, Subject::Media)?;
    let PathParams((id, file)) = ids?;
    let libs = crate::libraries::accessible_library_ids(&st.db, &a).await?;
    crate::libraries::assert_media_accessible(&st.db, id, &libs).await?;
    let guard = st.ingest.media.lock(id).await;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    delete_media_file(
        &st,
        &media,
        file,
        q.get("deleteOnDisk").is_some_and(|v| v == "true"),
    )
    .await?;
    drop(guard);
    Ok(StatusCode::OK)
}

/// `DELETE /api/libraries/:id` (rules 75-76): every media row, never a file; not transactional.
#[utoipa::path(delete, path = "/api/libraries/{id}", responses((status = 200)))]
pub async fn remove_library(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let PathParams(id) = id?;
    sqlx::query_scalar!("SELECT id FROM libraries WHERE id = $1", id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::not_found(format!("Library #{id} not found")))?;
    let ids = sqlx::query_scalar!(
        r#"SELECT id FROM media WHERE "libraryId" = $1 ORDER BY id"#,
        id
    )
    .fetch_all(&st.db)
    .await?;
    let mut n = 0;
    for m in ids {
        let guard = st.ingest.media.lock(m).await;
        let here =
            sqlx::query_scalar::<_, Option<i32>>(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
                .bind(m)
                .fetch_optional(&st.db)
                .await?
                .flatten();
        if here != Some(id) {
            continue;
        }
        remove_media(&st, &guard, m).await?;
        n += 1;
    }
    sqlx::query!("DELETE FROM libraries WHERE id = $1", id)
        .execute(&st.db)
        .await?;
    tracing::info!("Library #{id} deleted — {n} media row(s) removed, files kept");
    Ok(StatusCode::OK)
}

//! Media, file and library deletes (rules 65-80): rows first, then contained disk removals.
use super::gate;
use crate::{
    events::{DomainEvent, SseEvent},
    http::{AppError, auth::Authed, validate::PathParams},
    ingest::{MediaRow, clear_has_file, drop_thumbnails, fsx, load_media},
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use fliks_domain::{
    acl::{Action, Subject},
    media::path::media_path,
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf};

/// Rule 70: the folder a media delete may remove, `Err` with the reason it is kept.
pub async fn media_dir_to_remove(st: &AppState, m: &MediaRow) -> Result<Option<PathBuf>, String> {
    let (Some(lib), Some(folder)) = (m.library_path.as_deref(), m.folder_name.as_deref()) else {
        return Ok(None);
    };
    if folder.is_empty() || lib.is_empty() {
        return Ok(None);
    }
    let root = match fsx::Root::open(lib) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(
                "Media #{}: library root unavailable ({e}), folder kept",
                m.id
            );
            return Ok(None);
        }
    };
    let roots: Vec<PathBuf> = sqlx::query_scalar!(
        r#"SELECT path AS "path!" FROM libraries WHERE path IS NOT NULL AND path <> ''"#
    )
    .fetch_all(&st.db)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .map(PathBuf::from)
    .collect();
    let others: Vec<PathBuf> = sqlx::query!(
        r#"SELECT l.path AS "lib!", m."folderName" AS "folder!" FROM media m JOIN libraries l ON l.id = m."libraryId"
           WHERE m.id <> $1 AND m."folderName" <> '' AND l.path IS NOT NULL"#,
        m.id
    )
    .fetch_all(&st.db)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .filter_map(|r| media_path(Some(&r.lib), Some(&r.folder)).map(PathBuf::from))
    .collect();
    fsx::removable_media_dir(&root, folder, &roots, &others)
}

/// `remove(id)` (rules 67-69): hook and row delete in one transaction; the caller holds the lock.
pub async fn remove_media(
    st: &AppState,
    _guard: &tokio::sync::OwnedMutexGuard<()>,
    id: i32,
) -> Result<MediaRow, AppError> {
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let files = sqlx::query_scalar!(
        r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        id
    )
    .fetch_all(&st.db)
    .await?;
    crate::party::end_playing(st, id).await?;
    let mut tx = st.db.begin().await?;
    crate::requests::Lifecycle::of(st)
        .on_media_removed(&mut tx, &media.lifecycle_ref())
        .await?;
    sqlx::query!("DELETE FROM media WHERE id = $1", id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    for f in files {
        drop_thumbnails(st, f);
    }
    st.hub.emit_domain(DomainEvent::MediaRemoved {
        media_id: i64::from(id),
        tmdb_id: media.tmdb_id.map(i64::from),
        media_type: media.media_type.clone(),
    });
    crate::media_servers::dispatch_detached(st, "media.deleted");
    Ok(media)
}

/// `remove_media` plus the folder it judged contained (`None` when kept); the caller holds the lock.
pub async fn remove_media_with_dir(
    st: &AppState,
    guard: &tokio::sync::OwnedMutexGuard<()>,
    id: i32,
) -> Result<(MediaRow, Option<PathBuf>), AppError> {
    let media = remove_media(st, guard, id).await?;
    let dir = match media_dir_to_remove(st, &media).await {
        Ok(dir) => dir,
        Err(why) => {
            tracing::warn!(
                "Media #{} \"{}\": folder kept ({why})",
                media.id,
                media.title
            );
            None
        }
    };
    Ok((media, dir))
}

/// Removes a folder `media_dir_to_remove` judged contained.
pub async fn remove_media_folder(dir: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || fsx::remove_media_dir(&dir))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

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
    let media = remove_media(&st, &guard, id).await?;
    let user = a.user.id;
    let st2 = st.clone();
    tokio::spawn(async move {
        let _guard = guard;
        let m = &media;
        match media_dir_to_remove(&st2, m).await {
            Ok(None) => {}
            Ok(Some(d)) => match tokio::task::spawn_blocking({
                let d = d.clone();
                move || fsx::remove_media_dir(&d)
            })
            .await
            {
                Ok(Ok(())) => tracing::info!("Deleted media folder on disk: {}", d.display()),
                Ok(Err(e)) => {
                    tracing::error!(
                        "Media file deletion failed — id={} title=\"{}\" path=\"{}\" error={e}",
                        m.id,
                        m.title,
                        d.display()
                    );
                    delete_failed(&st2, user, m);
                }
                Err(e) => tracing::error!("media folder removal task: {e}"),
            },
            Err(why) => {
                tracing::warn!("Media #{} \"{}\": folder kept ({why})", m.id, m.title);
                delete_failed(&st2, user, m);
            }
        }
    });
    Ok(Json(json!({"ok": true})))
}

fn invalid_path() -> AppError {
    AppError::bad_request("Invalid file path")
}

/// `deleteMediaFile` (rules 78-79); the caller holds the media's lock.
pub async fn delete_media_file(
    st: &AppState,
    media: &MediaRow,
    file_id: i32,
    on_disk: bool,
) -> Result<(), AppError> {
    let f = sqlx::query!(
        r#"SELECT "relativePath" AS rel, "episodeId" AS episode FROM media_files WHERE id = $1 AND "mediaId" = $2"#,
        file_id,
        media.id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("File #{file_id} not found")))?;
    if on_disk && let Some(lib) = media.library_path.as_deref().filter(|l| !l.is_empty()) {
        let rel = fsx::safe_rel(&f.rel).ok_or_else(invalid_path)?;
        match fsx::Root::open(lib) {
            Err(e) => {
                tracing::warn!("file #{file_id}: library root unavailable ({e}), nothing unlinked")
            }
            Ok(root) => {
                let full = root
                    .media_dir(media.folder_name.as_deref())
                    .map_err(|_| invalid_path())?
                    .join(rel);
                match fsx::unlink_contained(&root, &full) {
                    Ok(fsx::Unlinked::Removed) => {}
                    Ok(fsx::Unlinked::Missing) => {
                        tracing::warn!("file already gone: {}", full.display())
                    }
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::IsADirectory
                        ) && e.raw_os_error().is_none() =>
                    {
                        return Err(invalid_path());
                    }
                    Err(e) => {
                        tracing::error!("unlink of {} failed: {e}", full.display());
                        return Err(AppError::internal(e.to_string()));
                    }
                }
                remove_orphan_edl(&root, &full).await;
                crate::subtitles::sidecars::delete_files_on_disk(st, media.id, file_id).await;
            }
        }
    }
    sqlx::query!("DELETE FROM media_files WHERE id = $1", file_id)
        .execute(&st.db)
        .await?;
    drop_thumbnails(st, file_id);
    if let Some(ep) = f.episode {
        clear_has_file(&st.db, ep).await?;
    }
    crate::media_servers::dispatch_detached(st, "file.deleted");
    Ok(())
}

/// W8: the video's sidecar unless another video of the directory shares the stem.
async fn remove_orphan_edl(root: &fsx::Root, video: &std::path::Path) {
    let edl = PathBuf::from(crate::stream::edl_sidecar(&video.to_string_lossy()).await);
    let stem = |n: &str| crate::ingest::transfer::split_ext(n).0.to_lowercase();
    let mine = stem(&crate::ingest::library::file_name(video));
    let mut shared = false;
    if let Ok(mut rd) = tokio::fs::read_dir(video.parent().unwrap_or(root.path())).await {
        while let Ok(Some(e)) = rd.next_entry().await {
            if let Ok(n) = e.file_name().into_string()
                && crate::ingest::is_video(&n)
                && stem(&n) == mine
            {
                shared = true;
                break;
            }
        }
    }
    if shared {
        return;
    }
    if let Err(e) = fsx::unlink_contained(root, &edl) {
        tracing::warn!("orphan EDL \"{}\" kept: {e}", edl.display());
    }
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
    let n = ids.len();
    for m in ids {
        let guard = st.ingest.media.lock(m).await;
        remove_media(&st, &guard, m).await?;
    }
    sqlx::query!("DELETE FROM libraries WHERE id = $1", id)
        .execute(&st.db)
        .await?;
    tracing::info!("Library #{id} deleted — {n} media row(s) removed, files kept");
    Ok(StatusCode::OK)
}

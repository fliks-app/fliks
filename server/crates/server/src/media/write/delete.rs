//! Media, file and library deletes (rules 65-80): rows first, then contained disk removals.
use super::gate;
use crate::{
    events::{DomainEvent, SseEvent},
    http::{AppError, auth::Authed, validate::PathParams},
    ingest::{MediaRow, drop_thumbnails, fsx, load_media},
    media::external_ids,
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use fliks_domain::{
    acl::{Action, Subject},
    media::{kind::MediaKind, path::media_path},
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf};

/// Rule 70 for the folder rooted at `lib`: the media directory a delete may remove, `Err` with the reason it is kept.
async fn media_dir_in(st: &AppState, m: &MediaRow, lib: &str) -> Result<Option<PathBuf>, String> {
    let Some(folder) = m.folder_name.as_deref() else {
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
    let all = sqlx::query!(r#"SELECT id, path FROM library_folders"#)
        .fetch_all(&st.db)
        .await
        .map_err(|e| e.to_string())?;
    let roots: Vec<PathBuf> = all.iter().map(|f| PathBuf::from(&f.path)).collect();
    // A book removes only what it owns and the directories that end up empty: sharing is harmless.
    if m.media_type == MediaKind::Book {
        return fsx::removable_dir_of(&root, m.media_type, folder, &roots, &[]);
    }
    let mut others: Vec<PathBuf> = sqlx::query!(
        r#"SELECT lf.path AS "lib!", m."folderName" AS "folder!" FROM media m
           JOIN (SELECT "mediaId", "folderId" FROM media_files
                 WHERE "mediaId" IS NOT NULL
                 UNION SELECT "mediaId", "folderId" FROM media_target_folders) x ON x."mediaId" = m.id
           JOIN library_folders lf ON lf.id = x."folderId"
           WHERE m.id <> $1 AND m."folderName" <> ''"#,
        m.id
    )
    .fetch_all(&st.db)
    .await
    .map_err(|e| e.to_string())?
    .into_iter()
    .filter_map(|r| media_path(Some(&r.lib), Some(&r.folder)).map(PathBuf::from))
    .collect();
    // A file another media owns inside the folder, whatever that media's folder name.
    let prefix = format!("{folder}/");
    others.extend(
        sqlx::query!(
            r#"SELECT lf.path AS "lib!", f."relativePath" AS "rel!" FROM media_files f
               JOIN library_folders lf ON lf.id = f."folderId"
               WHERE f."mediaId" <> $1 AND starts_with(replace(f."relativePath", '\', '/'), $2)"#,
            m.id,
            prefix
        )
        .fetch_all(&st.db)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter_map(|r| {
            media_path(Some(&r.lib), Some(&r.rel.replace('\\', "/"))).map(PathBuf::from)
        }),
    );
    fsx::removable_dir_of(&root, m.media_type, folder, &roots, &others)
}

/// What a delete leaves to remove from disk: the folders that held the media's files and, for a
/// book, those files as `(folder id, relative path)`; both are unreadable once the rows are gone.
#[derive(Default)]
pub struct Leftover {
    pub folders: Vec<i32>,
    pub files: Vec<(i32, String)>,
}

/// Rule 70 once per folder holding one of the media's files plus its target folder (libraries rule 55).
pub async fn media_dirs_to_remove(
    st: &AppState,
    m: &MediaRow,
    left: &Leftover,
) -> Vec<Result<fsx::Removal, String>> {
    let mut ids = left.folders.clone();
    ids.extend(m.folder.as_ref().map(|f| f.id));
    let rows = match sqlx::query!(
        r#"SELECT id, path FROM library_folders WHERE id = ANY($1) ORDER BY id"#,
        &ids
    )
    .fetch_all(&st.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => return vec![Err(e.to_string())],
    };
    let mut out = vec![];
    for r in rows {
        match media_dir_in(st, m, &r.path).await {
            Ok(Some(dir)) => {
                let owned = (m.media_type == MediaKind::Book).then(|| {
                    left.files
                        .iter()
                        .filter(|(f, _)| *f == r.id)
                        .filter_map(|(_, rel)| fsx::locate(&r.path, rel))
                        .collect()
                });
                out.push(Ok(fsx::Removal { dir, owned }));
            }
            Ok(None) => {}
            Err(why) => out.push(Err(why)),
        }
    }
    out
}

/// `remove(id)` (rules 67-69): hook and row delete in one transaction; the caller holds the lock.
/// Also answers what its files left on disk, unreadable once the rows are gone.
pub async fn remove_media(
    st: &AppState,
    _guard: &tokio::sync::OwnedMutexGuard<()>,
    id: i32,
) -> Result<(MediaRow, Leftover), AppError> {
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let rows = sqlx::query!(
        r#"SELECT id, "folderId" AS folder_id, "relativePath" AS rel FROM media_files
           WHERE "mediaId" = $1 ORDER BY id"#,
        id
    )
    .fetch_all(&st.db)
    .await?;
    let files: Vec<i32> = rows.iter().map(|r| r.id).collect();
    let mut left = Leftover {
        folders: rows.iter().map(|r| r.folder_id).collect(),
        files: vec![],
    };
    left.folders.sort_unstable();
    left.folders.dedup();
    if media.media_type == MediaKind::Book {
        left.files = rows.into_iter().map(|r| (r.folder_id, r.rel)).collect();
    }
    crate::party::end_playing(st, id).await?;
    let mut tx = st.db.begin().await?;
    crate::requests::Lifecycle::of(st)
        .on_media_removed(&mut tx, &media.lifecycle_ref())
        .await?;
    let external_ids = external_ids::refs(&mut *tx, id).await?;
    sqlx::query!("DELETE FROM media WHERE id = $1", id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    for f in files {
        drop_thumbnails(st, f);
    }
    st.hub.emit_domain(DomainEvent::MediaRemoved {
        media_id: i64::from(id),
        external_ids,
        media_type: media.media_type,
    });
    crate::media_servers::dispatch_detached(st, "media.deleted");
    Ok((media, left))
}

/// `remove_media` plus the folders it judged contained; the caller holds the lock.
pub async fn remove_media_with_dir(
    st: &AppState,
    guard: &tokio::sync::OwnedMutexGuard<()>,
    id: i32,
) -> Result<(MediaRow, Vec<fsx::Removal>), AppError> {
    let (media, left) = remove_media(st, guard, id).await?;
    let mut dirs = vec![];
    for dir in media_dirs_to_remove(st, &media, &left).await {
        match dir {
            Ok(d) => dirs.push(d),
            Err(why) => tracing::warn!(
                "Media #{} \"{}\": folder kept ({why})",
                media.id,
                media.title
            ),
        }
    }
    Ok((media, dirs))
}

/// Removes what `media_dirs_to_remove` judged contained.
pub async fn remove_media_folder(dir: fsx::Removal) -> Result<(), String> {
    tokio::task::spawn_blocking(move || dir.remove())
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
        r#"SELECT f."relativePath" AS rel, lf.path AS folder FROM media_files f
           JOIN library_folders lf ON lf.id = f."folderId" WHERE f.id = $1 AND f."mediaId" = $2"#,
        file_id,
        media.id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("File #{file_id} not found")))?;
    if on_disk && !f.folder.is_empty() {
        let rel = fsx::safe_rel(&f.rel).ok_or_else(invalid_path)?;
        match fsx::Root::open(&f.folder) {
            Err(e) => {
                tracing::warn!("file #{file_id}: library root unavailable ({e}), nothing unlinked")
            }
            Ok(root) => {
                let full = root.path().join(rel);
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
    // An issue whose file is deleted stays unmonitored: it is not downloaded again behind the user's back.
    sqlx::query(
        r#"UPDATE items SET monitored = false WHERE id IN (
             SELECT p."itemId" FROM item_parts p JOIN comic_issues ci ON ci."itemId" = p."itemId"
              WHERE p."mediaFileId" = $1)
           AND NOT EXISTS (SELECT 1 FROM item_parts o WHERE o."itemId" = items.id AND o."mediaFileId" <> $1)"#,
    )
    .bind(file_id)
    .execute(&st.db)
    .await?;
    sqlx::query!("DELETE FROM media_files WHERE id = $1", file_id)
        .execute(&st.db)
        .await?;
    drop_thumbnails(st, file_id);
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

/// Deletes the rows of a media's files in one folder and keeps the media (libraries rule 52); the caller holds the lock.
pub async fn unlink_folder_files(
    st: &AppState,
    _guard: &tokio::sync::OwnedMutexGuard<()>,
    media: i32,
    folder: i32,
) -> Result<(), AppError> {
    let files = sqlx::query_scalar!(
        r#"DELETE FROM media_files WHERE "mediaId" = $1 AND "folderId" = $2 RETURNING id"#,
        media,
        folder
    )
    .fetch_all(&st.db)
    .await?;
    for f in files {
        drop_thumbnails(st, f);
    }
    crate::media_servers::dispatch_detached(st, "file.deleted");
    Ok(())
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

//! Moves a media's files between library folders (`media-write.md` rules 101-107).
use super::{already_running, body::Body, gate, subject};
use crate::{
    events::{Num, SseEvent, Subject},
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    ingest::{fsx, load_media},
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::{
    acl::Action,
    subtitle_path::{relative_path_under_root, resolve_subtitle_absolute_path},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
};

struct Dest {
    id: i32,
    library_id: i32,
    path: String,
}

enum Row {
    File(i32),
    Sub {
        id: i32,
        stored: String,
        rel: String,
    },
}

struct Item {
    row: Row,
    /// The stored location, unlinked at the end; `real` is what is read (links resolved).
    rel: String,
    src: PathBuf,
    real: PathBuf,
    src_folder: String,
    dest: PathBuf,
    size: u64,
    present: bool,
}

#[utoipa::path(post, path = "/api/media/{id}/move", responses((status = 202)))]
pub async fn move_media(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let b = Body::new(v, &["folderId"])?;
    let folder = b.required(b.id("folderId")?, "folderId", "must be an integer number")?;
    start(&st, &a, id, folder).await?;
    Ok((StatusCode::ACCEPTED, Json(json!({"ok": true}))))
}

/// Claims the move and detaches it (rule 101); the folder must be in a library the caller reaches.
pub async fn start(st: &AppState, a: &Authed, id: i32, folder: i32) -> Result<(), AppError> {
    let libs = accessible_library_ids(&st.db, a).await?;
    let dest = sqlx::query_as::<_, (i32, String)>(
        r#"SELECT "libraryId", path FROM library_folders WHERE id = $1"#,
    )
    .bind(folder)
    .fetch_optional(&st.db)
    .await?
    .filter(|(l, _)| libs.contains(l))
    .map(|(library_id, path)| Dest {
        id: folder,
        library_id,
        path,
    })
    .ok_or_else(|| AppError::not_found(format!("Folder #{folder} not found")))?;
    let media = load_media(&st.db, id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(id))?;
    let key = format!("MediaMove:{id}");
    let subj = subject(id, &media.title, media.media_type);
    if !st
        .hub
        .activity()
        .claim(&key, "MediaMove", Some(subj.clone()), None, None, None)
    {
        return Err(already_running());
    }
    tracing::info!(
        "Move requested for media #{id} \"{}\" to folder #{folder}",
        media.title
    );
    let (st, user) = (st.clone(), a.user.id);
    tokio::spawn(async move {
        let guard = st.ingest.media.lock(id).await;
        let r = run(&st, &key, subj, id, &dest).await;
        drop(guard);
        st.hub.activity().remove(&key);
        let (media_id, title) = (i64::from(id), media.title);
        match r {
            Ok((files, leftover)) => {
                tracing::info!("Media #{id} moved to folder #{} ({files} file(s))", dest.id);
                st.hub.emit_to_user(
                    user,
                    SseEvent::MediaMoveCompleted {
                        media_id,
                        title,
                        files,
                        leftover,
                    },
                );
            }
            Err(error) => {
                tracing::error!("Move of media #{id} to folder #{} failed: {error}", dest.id);
                st.hub.emit_to_user(
                    user,
                    SseEvent::MediaMoveFailed {
                        media_id,
                        title,
                        error,
                    },
                );
            }
        }
    });
    Ok(())
}

/// The caller holds the media's lock; returns the files moved and the sources left behind.
async fn run(
    st: &AppState,
    key: &str,
    subj: Subject,
    id: i32,
    dest: &Dest,
) -> Result<(i64, i64), String> {
    let _moves = st.folder_moves.write().await;
    let db = |e: sqlx::Error| e.to_string();
    let droot =
        fsx::Root::open(&dest.path).map_err(|e| format!("Folder \"{}\": {e}", dest.path))?;
    let items = plan(st, id, dest, &droot).await?;
    let need: u64 = items
        .iter()
        .filter(|i| !i.present && !fsx::same_device(&i.real, droot.path()))
        .map(|i| i.size)
        .sum();
    if need > 0 {
        let d = crate::libraries::disk(&dest.path).await;
        if d.accessible && u64::try_from(d.free_space).is_ok_and(|f| f < need) {
            return Err(format!(
                "Not enough free space in \"{}\": {need} bytes needed",
                dest.path
            ));
        }
    }
    let total = items.len();
    let mut created: Vec<&Path> = Vec::new();
    for (n, it) in items.iter().enumerate() {
        st.hub.activity().upsert_running(
            key,
            "MediaMove",
            Some(subj.clone()),
            Some(Num(n as f64)),
            Some(Num(total as f64)),
            None,
        );
        let (real, to) = (it.real.clone(), it.dest.clone());
        let placed = tokio::task::spawn_blocking(move || fsx::place_copy(&real, &to))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r.map_err(|e| format!("{}: {e}", it.dest.display())));
        match placed {
            Ok(true) => created.push(&it.dest),
            Ok(false) if it.present => {}
            Ok(false) => {
                undo(&droot, &dest.path, &created);
                return Err(format!("{} appeared during the move", it.dest.display()));
            }
            Err(e) => {
                undo(&droot, &dest.path, &created);
                return Err(e);
            }
        }
    }
    if let Err(e) = commit(st, id, dest, &items).await {
        undo(&droot, &dest.path, &created);
        return Err(db(e));
    }
    let mut leftover = 0;
    for it in &items {
        let gone =
            fsx::Root::open(&it.src_folder).and_then(|root| fsx::unlink_contained(&root, &it.src));
        match gone {
            Ok(_) => {
                if let Some(dir) = it.src.parent() {
                    fsx::prune_empty(Path::new(&it.src_folder), dir);
                }
            }
            Err(e) => {
                leftover += 1;
                tracing::warn!("Moved media #{id}, source kept: {}: {e}", it.src.display());
            }
        }
    }
    Ok((total as i64, leftover))
}

/// Removes the copies this run made, then the directories it left empty.
fn undo(droot: &fsx::Root, folder: &str, created: &[&Path]) {
    for p in created {
        if let Err(e) = fsx::unlink_contained(droot, p) {
            tracing::warn!("Move rolled back, copy kept: {}: {e}", p.display());
        } else if let Some(dir) = p.parent() {
            fsx::prune_empty(Path::new(folder), dir);
        }
    }
}

/// Everything outside the destination folder that must follow the media, checked before any copy (rule 103).
async fn plan(st: &AppState, id: i32, dest: &Dest, droot: &fsx::Root) -> Result<Vec<Item>, String> {
    let db = |e: sqlx::Error| e.to_string();
    let files = sqlx::query_as::<_, (i32, String, String)>(
        r#"SELECT f.id, lf.path, f."relativePath" FROM media_files f
           JOIN library_folders lf ON lf.id = f."folderId"
           WHERE f."mediaId" = $1 AND f."folderId" <> $2 ORDER BY f.id"#,
    )
    .bind(id)
    .bind(dest.id)
    .fetch_all(&st.db)
    .await
    .map_err(db)?;
    let subs = sqlx::query_as::<_, (i32, String, String)>(
        r#"SELECT s.id, s."filePath", lf.path FROM subtitle_files s
           LEFT JOIN media_files f ON f.id = s."mediaFileId"
           LEFT JOIN media_target_folders t ON t."mediaId" = COALESCE(s."mediaId", f."mediaId")
           JOIN library_folders lf ON lf.id = COALESCE(f."folderId", t."folderId")
           WHERE COALESCE(s."mediaId", f."mediaId") = $1 AND btrim(COALESCE(s."filePath", '')) <> ''
             AND lf.id <> $2 ORDER BY s.id"#,
    )
    .bind(id)
    .bind(dest.id)
    .fetch_all(&st.db)
    .await
    .map_err(db)?;
    let mut wanted = Vec::with_capacity(files.len() + subs.len());
    for (fid, folder, rel) in files {
        wanted.push((Row::File(fid), folder, rel));
    }
    for (sid, stored, folder) in subs {
        let rel = resolve_subtitle_absolute_path(&folder, &stored)
            .and_then(|abs| relative_path_under_root(&folder, &abs))
            .ok_or_else(|| format!("Subtitle #{sid} is outside its folder"))?;
        wanted.push((
            Row::Sub {
                id: sid,
                stored,
                rel: rel.clone(),
            },
            folder,
            rel,
        ));
    }
    let mut items = Vec::with_capacity(wanted.len());
    for (row, folder, rel) in wanted {
        let outside = || format!("\"{rel}\" would leave its folder");
        let src = fsx::locate(&folder, &rel).ok_or_else(outside)?;
        let to = fsx::locate(&dest.path, &rel).ok_or_else(outside)?;
        let (real, meta) =
            fsx::regular_source(&src).map_err(|e| format!("{}: {e}", src.display()))?;
        if !to.parent().is_some_and(|p| droot.contains(p, true)) {
            return Err(outside());
        }
        let present = match fs::symlink_metadata(&to) {
            Ok(_) if same_copy(&real, &to) => true,
            Ok(_) => return Err(format!("{} already exists", to.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(format!("{}: {e}", to.display())),
        };
        items.push(Item {
            row,
            rel,
            src,
            real,
            src_folder: folder,
            dest: to,
            size: meta.len(),
            present,
        });
    }
    let rels: Vec<&str> = items
        .iter()
        .filter_map(|i| match &i.row {
            Row::File(_) => Some(i.rel.as_str()),
            Row::Sub { .. } => None,
        })
        .collect();
    let held = sqlx::query_scalar::<_, String>(
        r#"SELECT "relativePath" FROM media_files WHERE "folderId" = $1 AND "relativePath" = ANY($2)"#,
    )
    .bind(dest.id)
    .bind(&rels)
    .fetch_optional(&st.db)
    .await
    .map_err(db)?;
    match held {
        Some(rel) => Err(format!("The destination folder already holds \"{rel}\"")),
        None => Ok(items),
    }
}

/// A destination already holding the source's bytes: same size and modification time (rule 103).
fn same_copy(a: &Path, b: &Path) -> bool {
    matches!((fs::metadata(a), fs::metadata(b)), (Ok(x), Ok(y))
        if x.is_file() && y.is_file() && x.len() == y.len()
            && x.modified().is_ok_and(|t| y.modified().is_ok_and(|u| t == u)))
}

/// Re-aims the rows at the destination in one transaction (rule 104).
async fn commit(st: &AppState, id: i32, dest: &Dest, items: &[Item]) -> sqlx::Result<()> {
    let mut tx = st.db.begin().await?;
    let mut files = Vec::new();
    for it in items {
        match &it.row {
            Row::File(f) => files.push(*f),
            Row::Sub { id, stored, rel } if stored != rel => {
                sqlx::query(r#"UPDATE subtitle_files SET "filePath" = $2 WHERE id = $1"#)
                    .bind(id)
                    .bind(rel)
                    .execute(&mut *tx)
                    .await?;
            }
            Row::Sub { .. } => {}
        }
    }
    sqlx::query(r#"UPDATE media_files SET "folderId" = $1 WHERE id = ANY($2)"#)
        .bind(dest.id)
        .bind(&files)
        .execute(&mut *tx)
        .await?;
    sqlx::query(r#"UPDATE wants SET "folderId" = $1 WHERE "mediaId" = $2"#)
        .bind(dest.id)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        r#"UPDATE media SET "libraryId" = $1 WHERE id = $2 AND "libraryId" IS DISTINCT FROM $1"#,
    )
    .bind(dest.library_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

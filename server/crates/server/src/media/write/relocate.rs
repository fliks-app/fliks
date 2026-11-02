//! Moves a media's files between library folders (`media-write.md` rules 101-107).
use super::{already_running, body::Body, gate, subject};
use crate::{
    events::{Num, SseEvent, Subject},
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    ingest::{
        fsx, is_video, load_media,
        transfer::{companion_exts, companion_names, split_ext},
    },
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::{
    acl::Action,
    subtitle_path::{relative_path_under_root, resolve_subtitle_absolute_path},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
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
    /// A same-stem sidecar without a row (`.idx`, `.edl`, `.nfo`, artwork).
    Extra,
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
    /// Another media's row lists the same file: the source stays.
    keep: bool,
}

/// One planned source and destination; the journal outlives a crash (rule 105).
#[derive(Clone, Serialize, Deserialize)]
struct Move {
    folder: String,
    rel: String,
    from: PathBuf,
    to: PathBuf,
    keep: bool,
}

struct Journal {
    committed: bool,
    moves: Vec<Move>,
}

async fn save_journal(db: impl sqlx::PgExecutor<'_>, id: i32, j: &Journal) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO media_moves ("mediaId", plan, committed) VALUES ($1, $2, $3)
           ON CONFLICT ("mediaId") DO UPDATE SET plan = EXCLUDED.plan, committed = EXCLUDED.committed"#,
    )
    .bind(id)
    .bind(sqlx::types::Json(&j.moves))
    .bind(j.committed)
    .execute(db)
    .await
    .map(drop)
}

async fn folder_of(db: &sqlx::PgPool, id: i32) -> sqlx::Result<Option<Dest>> {
    Ok(sqlx::query_as::<_, (i32, String)>(
        r#"SELECT "libraryId", path FROM library_folders WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(db)
    .await?
    .map(|(library_id, path)| Dest {
        id,
        library_id,
        path,
    }))
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
    folder_of(&st.db, folder)
        .await?
        .filter(|d| libs.contains(&d.library_id))
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
        let r = run(&st, &key, subj, id, folder).await;
        drop(guard);
        st.hub.activity().remove(&key);
        let (media_id, title) = (i64::from(id), media.title);
        match r {
            Ok((files, leftover)) => {
                tracing::info!("Media #{id} moved to folder #{folder} ({files} file(s))");
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
                tracing::error!("Move of media #{id} to folder #{folder} failed: {error}");
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

async fn blocking<T: Send + 'static>(
    at: &Path,
    f: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}: {e}", at.display()))
}

/// The caller holds the media's lock; returns the files moved and the sources left behind.
async fn run(
    st: &AppState,
    key: &str,
    subj: Subject,
    id: i32,
    folder: i32,
) -> Result<(i64, i64), String> {
    let _moves = st.folder_moves.write().await;
    let db = |e: sqlx::Error| e.to_string();
    let dest = folder_of(&st.db, folder)
        .await
        .map_err(db)?
        .ok_or_else(|| format!("Folder #{folder} no longer exists"))?;
    let dest = &dest;
    finish_pending(st, id).await;
    let droot =
        fsx::Root::open(&dest.path).map_err(|e| format!("Folder \"{}\": {e}", dest.path))?;
    let items = plan(st, id, dest, &droot).await?;
    let moves: Vec<Move> = items
        .iter()
        .map(|i| Move {
            folder: i.src_folder.clone(),
            rel: i.rel.clone(),
            from: i.src.clone(),
            to: i.dest.clone(),
            keep: i.keep,
        })
        .collect();
    let listing: Vec<String> = moves
        .iter()
        .map(|m| format!("{} -> {}", m.from.display(), m.to.display()))
        .collect();
    tracing::info!("Move of media #{id} planned: {}", listing.join("; "));
    let mut journal = Journal {
        committed: false,
        moves,
    };
    save_journal(&st.db, id, &journal).await.map_err(db)?;
    let total = items.len();
    let mut done = items.iter().filter(|i| i.present).count();
    let progress = |n: usize| {
        st.hub.activity().upsert_running(
            key,
            "MediaMove",
            Some(subj.clone()),
            Some(Num(n as f64)),
            Some(Num(total as f64)),
            None,
        );
    };
    let mut created: Vec<&Path> = Vec::new();
    let mut copies: Vec<&Item> = Vec::new();
    for it in items.iter().filter(|i| !i.present) {
        progress(done);
        let (real, to) = (it.real.clone(), it.dest.clone());
        match blocking(&it.dest, move || fsx::link_new(&real, &to)).await {
            Ok(Some(true)) => {
                created.push(&it.dest);
                done += 1;
            }
            Ok(Some(false)) => {
                undo(&droot, &dest.path, &created);
                return Err(format!("{} appeared during the move", it.dest.display()));
            }
            Ok(None) => copies.push(it),
            Err(e) => {
                undo(&droot, &dest.path, &created);
                return Err(e);
            }
        }
    }
    let need: u64 = copies.iter().map(|i| i.size).sum();
    if need > 0 {
        let d = crate::libraries::disk(&dest.path).await;
        if d.accessible && u64::try_from(d.free_space).is_ok_and(|f| f < need) {
            undo(&droot, &dest.path, &created);
            return Err(format!(
                "Not enough free space in \"{}\": {need} bytes needed",
                dest.path
            ));
        }
    }
    for it in copies {
        progress(done);
        let (real, to) = (it.real.clone(), it.dest.clone());
        match blocking(&it.dest, move || fsx::copy_new(&real, &to)).await {
            Ok(true) => {
                created.push(&it.dest);
                done += 1;
            }
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
    journal.committed = true;
    if let Err(e) = commit(st, id, dest, &items, &journal).await {
        undo(&droot, &dest.path, &created);
        return Err(db(e));
    }
    let left = unlink_sources(id, journal.moves.into_iter().filter(|m| !m.keep).collect());
    let leftover = left.len() as i64;
    settle_journal(st, id, left).await;
    Ok((total as i64, leftover))
}

/// Unlinks the moved sources, pruning the directories they empty; returns those that stay.
fn unlink_sources(id: i32, moves: Vec<Move>) -> Vec<Move> {
    moves
        .into_iter()
        .filter(|m| {
            let gone =
                fsx::Root::open(&m.folder).and_then(|root| fsx::unlink_contained(&root, &m.from));
            if let Err(e) = &gone {
                tracing::warn!("Moved media #{id}, source kept: {}: {e}", m.from.display());
            } else if let Some(dir) = m.from.parent() {
                fsx::prune_empty(Path::new(&m.folder), dir);
            }
            gone.is_err()
        })
        .collect()
}

/// A committed move whose sources could not all be unlinked (a crash, a busy file) finishes here
/// on the media's next move; a source a row points at again is left alone.
async fn finish_pending(st: &AppState, id: i32) {
    let Some((moves, true)) = sqlx::query_as::<_, (sqlx::types::Json<Vec<Move>>, bool)>(
        r#"SELECT plan, committed FROM media_moves WHERE "mediaId" = $1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await
    .ok()
    .flatten()
    .map(|(m, c)| (m.0, c)) else {
        return;
    };
    let mut todo = Vec::new();
    for m in moves.into_iter().filter(|m| !m.keep) {
        let held = sqlx::query_scalar::<_, bool>(
            r#"SELECT EXISTS (SELECT 1 FROM media_files f JOIN library_folders lf ON lf.id = f."folderId"
               WHERE lf.path = $1 AND f."relativePath" = $2)"#,
        )
        .bind(&m.folder)
        .bind(&m.rel)
        .fetch_one(&st.db)
        .await
        .unwrap_or(true);
        if !held {
            todo.push(m);
        }
    }
    settle_journal(st, id, unlink_sources(id, todo)).await;
}

/// Drops the journal once every source is gone, else keeps the sources still to unlink.
async fn settle_journal(st: &AppState, id: i32, left: Vec<Move>) {
    let r = if left.is_empty() {
        sqlx::query(r#"DELETE FROM media_moves WHERE "mediaId" = $1"#)
            .bind(id)
            .execute(&st.db)
            .await
            .map(drop)
    } else {
        let j = Journal {
            committed: true,
            moves: left,
        };
        save_journal(&st.db, id, &j).await
    };
    if let Err(e) = r {
        tracing::warn!("Move journal of media #{id} not settled: {e}");
    }
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

/// One source checked against its destination (rule 103).
async fn item(
    row: Row,
    folder: String,
    rel: String,
    dest: &Dest,
    droot: &fsx::Root,
) -> Result<Item, String> {
    let outside = || format!("\"{rel}\" would leave its folder");
    let src = fsx::locate(&folder, &rel).ok_or_else(outside)?;
    let to = fsx::locate(&dest.path, &rel).ok_or_else(outside)?;
    let (real, meta) = fsx::regular_source(&src).map_err(|e| format!("{}: {e}", src.display()))?;
    if !to.parent().is_some_and(|p| droot.contains(p, true)) {
        return Err(outside());
    }
    let present = match fs::symlink_metadata(&to) {
        Ok(_) if same_copy(real.clone(), to.clone()).await => true,
        Ok(_) => return Err(format!("{} already exists", to.display())),
        Err(e) if e.kind() == io::ErrorKind::NotFound => false,
        Err(e) => return Err(format!("{}: {e}", to.display())),
    };
    Ok(Item {
        row,
        rel,
        src,
        real,
        src_folder: folder,
        dest: to,
        size: meta.len(),
        present,
        keep: false,
    })
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
    let mut items = Vec::with_capacity(files.len() + subs.len());
    for (fid, folder, rel) in files {
        items.push(item(Row::File(fid), folder, rel, dest, droot).await?);
    }
    for (sid, stored, folder) in subs {
        let rel = relative_of(&folder, &stored)
            .ok_or_else(|| format!("Subtitle #{sid} is outside its folder"))?;
        let row = Row::Sub {
            id: sid,
            stored,
            rel: rel.clone(),
        };
        let mut it = item(row, folder, rel, dest, droot).await?;
        it.keep = shared_with_others(st, id, &it).await.map_err(db)?;
        items.push(it);
    }
    let exts = companion_exts(&st.db).await.map_err(db)?;
    let videos: Vec<(String, String)> = items
        .iter()
        .filter(|i| matches!(i.row, Row::File(_)))
        .map(|i| (i.src_folder.clone(), i.rel.clone()))
        .collect();
    for (folder, rel) in videos {
        let (dir, name) = rel.rsplit_once('/').unwrap_or(("", &rel));
        if !is_video(name) {
            continue;
        }
        let Some(src_dir) =
            fsx::locate(&folder, &rel).and_then(|p| p.parent().map(Path::to_path_buf))
        else {
            continue;
        };
        for extra in companion_names(&src_dir, split_ext(name).0, &exts) {
            let crel = if dir.is_empty() {
                extra
            } else {
                format!("{dir}/{extra}")
            };
            if items
                .iter()
                .any(|i| i.src_folder == folder && i.rel == crel)
            {
                continue;
            }
            match item(Row::Extra, folder.clone(), crel.clone(), dest, droot).await {
                Ok(it) => items.push(it),
                Err(e) => tracing::warn!("Sidecar \"{crel}\" stays behind: {e}"),
            }
        }
    }
    let rels: Vec<&str> = items
        .iter()
        .filter_map(|i| match &i.row {
            Row::File(_) => Some(i.rel.as_str()),
            _ => None,
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

/// The path of a stored subtitle relative to its folder root.
fn relative_of(folder: &str, stored: &str) -> Option<String> {
    resolve_subtitle_absolute_path(folder, stored)
        .and_then(|abs| relative_path_under_root(folder, &abs))
}

/// Whether a subtitle row of another media resolves to this item's source file.
async fn shared_with_others(st: &AppState, id: i32, it: &Item) -> sqlx::Result<bool> {
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"SELECT s."filePath", lf.path FROM subtitle_files s
           LEFT JOIN media_files f ON f.id = s."mediaFileId"
           LEFT JOIN media_target_folders t ON t."mediaId" = COALESCE(s."mediaId", f."mediaId")
           JOIN library_folders lf ON lf.id = COALESCE(f."folderId", t."folderId")
           WHERE COALESCE(s."mediaId", f."mediaId") <> $1
             AND right(btrim(s."filePath"), length($2)) = $2"#,
    )
    .bind(id)
    .bind(&it.rel)
    .fetch_all(&st.db)
    .await?;
    Ok(rows.iter().any(|(stored, folder)| {
        relative_of(folder, stored)
            .and_then(|r| fsx::locate(folder, &r))
            .as_deref()
            == Some(&*it.src)
    }))
}

/// A destination already holding the source's bytes (rule 103): the same inode on one device, else the
/// same size and content hash.
async fn same_copy(a: PathBuf, b: PathBuf) -> bool {
    tokio::task::spawn_blocking(move || {
        let (Ok(x), Ok(y)) = (fs::metadata(&a), fs::metadata(&b)) else {
            return false;
        };
        if !x.is_file() || !y.is_file() {
            return false;
        }
        match same_inode(&x, &y) {
            Some(same) => same,
            None => {
                x.len() == y.len() && matches!((digest(&a), digest(&b)), (Ok(p), Ok(q)) if p == q)
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// `Some(same inode)` when both files are on one device, `None` when they are not.
fn same_inode(x: &fs::Metadata, y: &fs::Metadata) -> Option<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (x.dev() == y.dev()).then(|| x.ino() == y.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = (x, y);
        None
    }
}

fn digest(p: &Path) -> io::Result<Vec<u8>> {
    use io::Read;
    let mut f = fs::File::open(p)?;
    let (mut h, mut buf) = (Sha256::new(), vec![0u8; 1 << 20]);
    loop {
        match f.read(&mut buf)? {
            0 => return Ok(h.finalize().to_vec()),
            n => h.update(&buf[..n]),
        }
    }
}

/// Re-aims the rows at the destination in one transaction, journal included (rule 104).
async fn commit(
    st: &AppState,
    id: i32,
    dest: &Dest,
    items: &[Item],
    journal: &Journal,
) -> sqlx::Result<()> {
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
            Row::Sub { .. } | Row::Extra => {}
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
    save_journal(&mut *tx, id, journal).await?;
    tx.commit().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn only_the_same_bytes_across_devices_are_ours() {
        use std::os::unix::fs::MetadataExt;
        let shm = PathBuf::from("/dev/shm");
        let here = std::env::temp_dir();
        let (Ok(x), Ok(y)) = (fs::metadata(&shm), fs::metadata(&here)) else {
            return;
        };
        if x.dev() == y.dev() {
            return;
        }
        let n = std::process::id();
        let (a, b, c) = (
            here.join(format!("fliks-copy-a-{n}")),
            shm.join(format!("fliks-copy-b-{n}")),
            shm.join(format!("fliks-copy-c-{n}")),
        );
        fs::write(&a, b"same bytes").unwrap();
        fs::write(&b, b"same bytes").unwrap();
        fs::write(&c, b"othr bytes").unwrap();
        let (ours, other) = (
            same_copy(a.clone(), b.clone()).await,
            same_copy(a.clone(), c.clone()).await,
        );
        for p in [&a, &b, &c] {
            fs::remove_file(p).unwrap();
        }
        assert!(ours && !other);
    }
}

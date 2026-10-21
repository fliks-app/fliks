//! Sidecar rows against the disk: discovery, rescan reconcile, carry-over and deletes
//! (`subtitle-files.md` rules 13, 14, 18-20). Every path is confined to the media directory.
use super::{
    files::{self, Dirs, MediaCtx},
    model::{self, New, Row},
};
use crate::{http::AppError, ingest::fsx, state::AppState};
use fliks_domain::{
    subtitle_flags::{TEXT_EXTENSIONS, external_image_codec},
    subtitle_name::{SUBTITLE_EXTS, match_subtitle_video, parse_subtitle_filename},
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

fn norm(p: &str) -> String {
    p.replace('\\', "/")
}

async fn dirs_of(st: &AppState, media_id: i32) -> Option<(MediaCtx, Dirs)> {
    let media = files::load_media(&st.db, media_id).await.ok().flatten()?;
    let dirs = media.dirs("no root").ok()?;
    Some((media, dirs))
}

/// Inserts a row per sidecar next to the videos that no row lists yet; returns how many.
pub async fn discover_external(st: &AppState, media_id: i32) -> usize {
    let Some((media, dirs)) = dirs_of(st, media_id).await else {
        return 0;
    };
    let Ok(mfiles) = files::files_of_media(&st.db, media_id).await else {
        return 0;
    };
    if mfiles.is_empty() {
        return 0;
    }
    let mut known: HashSet<String> = model::of_media(&st.db, media_id)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| r.file_path.map(|p| norm(&p)))
        .collect();
    let mut scan_dirs: Vec<PathBuf> = vec![dirs.m.clone()];
    for f in &mfiles {
        if let Some(p) = fsx::safe_rel(&f.relative_path)
            .and_then(|r| dirs.m.join(r).parent().map(Path::to_path_buf))
            && !scan_dirs.contains(&p)
        {
            scan_dirs.push(p);
        }
    }
    let video_dirs: Vec<Option<PathBuf>> = mfiles
        .iter()
        .map(|f| {
            fsx::safe_rel(&f.relative_path)
                .and_then(|r| dirs.m.join(r).parent().map(Path::to_path_buf))
        })
        .collect();
    let mut found = 0;
    for dir in scan_dirs {
        if !dirs.mc.contains(&dir, true) {
            continue;
        }
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        let entries: Vec<String> = rd
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        for entry in &entries {
            let ext = fliks_domain::subtitle_name::ext(entry);
            if !SUBTITLE_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let stem_as_written = entry.rfind('.').map_or(entry.as_str(), |i| &entry[..i]);
            let image = external_image_codec(
                &ext,
                entries
                    .iter()
                    .any(|e| *e == format!("{stem_as_written}.idx")),
            );
            if !TEXT_EXTENSIONS.contains(&ext.as_str()) && image.is_none() {
                continue;
            }
            let abs = dir.join(entry);
            // A regular file whose real parent stays under the media directory.
            if !fs::symlink_metadata(&abs).is_ok_and(|m| m.is_file()) {
                continue;
            }
            let Some(rel) = dirs.rel(&abs) else { continue };
            if known.contains(&rel) {
                continue;
            }
            let probe: Vec<(&str, bool)> = mfiles
                .iter()
                .zip(&video_dirs)
                .map(|(f, d)| {
                    (
                        f.relative_path.as_str(),
                        d.as_deref() == Some(dir.as_path()),
                    )
                })
                .collect();
            let own = media.folder_name.as_deref().is_some_and(|f| !f.is_empty());
            let Some(hit) = match_subtitle_video(entry, &probe, own) else {
                continue;
            };
            let Some(p) = parse_subtitle_filename(entry) else {
                continue;
            };
            let n = New {
                media_id,
                media_file_id: mfiles[hit].id,
                episode_id: mfiles[hit].episode_id,
                language: p.language.clone(),
                codec: image.map(str::to_owned),
                forced: p.forced,
                hearing_impaired: p.hearing_impaired,
                provider_type: "disk".into(),
                file_path: Some(rel.clone()),
                status: "downloaded".into(),
                score: 100,
                synced: true,
                ..New::default()
            };
            if let Err(e) = model::insert(&st.db, &n).await {
                tracing::warn!("Discovered subtitle {rel} not stored: {e}");
                continue;
            }
            known.insert(rel.clone());
            found += 1;
            tracing::info!(
                "Discovered external subtitle: \"{rel}\" -> media file #{}",
                mfiles[hit].id
            );
        }
    }
    found
}

fn is_external(r: &Row) -> bool {
    r.provider_type != "embedded" && r.status != "processing" && r.status != "failed"
}

/// Drops rows whose sidecar is gone and collapses rows listing the same file; never touches a file.
pub async fn reconcile_after_rescan(st: &AppState, media_id: i32) -> (usize, usize) {
    let Some((_, dirs)) = dirs_of(st, media_id).await else {
        return (0, 0);
    };
    let (mut missing, mut dupes) = (0, 0);
    let rows = model::of_media(&st.db, media_id).await.unwrap_or_default();
    for r in rows.iter().filter(|r| is_external(r)) {
        let stored = r.file_path.as_deref().unwrap_or_default();
        // Gone: no path, an unresolvable or non-regular one, or NotFound; any other error keeps the row.
        let gone = stored.trim().is_empty()
            || match dirs.resolve(stored) {
                None => true,
                Some(abs) => match fs::symlink_metadata(abs) {
                    Ok(m) => !m.is_file(),
                    Err(e) => e.kind() == std::io::ErrorKind::NotFound,
                },
            };
        if gone && remove_row(st, r.id).await {
            missing += 1;
        }
    }
    let rows = model::of_media(&st.db, media_id).await.unwrap_or_default();
    let mut groups: HashMap<String, Vec<&Row>> = HashMap::new();
    for r in rows.iter().filter(|r| is_external(r)) {
        if let Some(p) = r.file_path.as_deref().filter(|p| !p.trim().is_empty()) {
            groups.entry(norm(p)).or_default().push(r);
        }
    }
    for mut g in groups.into_values().filter(|g| g.len() > 1) {
        g.sort_by(|a, b| {
            b.locked
                .cmp(&a.locked)
                .then(b.score.cmp(&a.score))
                .then(b.id.cmp(&a.id))
        });
        for loser in &g[1..] {
            if remove_row(st, loser.id).await {
                dupes += 1;
            }
        }
    }
    (missing, dupes)
}

async fn remove_row(st: &AppState, id: i32) -> bool {
    sqlx::query("DELETE FROM subtitle_files WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await
        .is_ok_and(|r| r.rows_affected() > 0)
}

/// Moves the sidecars of a superseded video onto its replacement; returns the moved row ids.
pub async fn carry_over(st: &AppState, media_id: i32, from_file: i32, to_file: i32) -> Vec<i32> {
    let Some((_, dirs)) = dirs_of(st, media_id).await else {
        return vec![];
    };
    let Ok(Some(from)) = files::file_by_id(&st.db, from_file).await else {
        return vec![];
    };
    let Ok(Some(to)) = files::file_by_id(&st.db, to_file).await else {
        return vec![];
    };
    let base = |rel: &str| -> (String, String) {
        let rel = norm(rel);
        let (dir, name) = rel.rsplit_once('/').unwrap_or(("", &rel));
        let stem = name
            .rfind('.')
            .filter(|i| *i > 0)
            .map_or(name, |i| &name[..i]);
        (dir.to_owned(), stem.to_owned())
    };
    let (_, old_base) = base(&from.relative_path);
    let (new_dir, new_base) = base(&to.relative_path);
    let rows = model::of_file(&st.db, from_file).await.unwrap_or_default();
    let mut moved = vec![];
    for r in rows {
        let Some(stored) = r.file_path.as_deref().filter(|_| !r.is_embedded()) else {
            continue;
        };
        let name = stored.rsplit(['/', '\\']).next().unwrap_or(stored);
        let Some(tail) = name.strip_prefix(&format!("{old_base}.")) else {
            continue;
        };
        let rel = if new_dir.is_empty() {
            format!("{new_base}.{tail}")
        } else {
            format!("{new_dir}/{new_base}.{tail}")
        };
        let (Some(src), Some(dest)) = (dirs.resolve(stored), dirs.resolve(&rel)) else {
            continue;
        };
        if fs::symlink_metadata(&dest).is_ok()
            || !fs::symlink_metadata(&src).is_ok_and(|m| m.is_file())
        {
            continue;
        }
        if let Err(e) = fsx::rename_noreplace(&src, &dest) {
            tracing::warn!("Could not carry subtitle {} over: {e}", src.display());
            continue;
        }
        let up = sqlx::query(r#"UPDATE subtitle_files SET "filePath" = $2, "mediaFileId" = $3, "hashMatched" = false WHERE id = $1"#)
            .bind(r.id)
            .bind(&rel)
            .bind(to.id)
            .execute(&st.db)
            .await;
        match up {
            Ok(_) => moved.push(r.id),
            Err(e) => tracing::error!("Carried subtitle #{} not saved: {e}", r.id),
        }
    }
    moved
}

/// Unlinks the sidecars of a video about to be deleted, except files another video's row lists.
pub async fn delete_files_on_disk(st: &AppState, media_id: i32, file_id: i32) {
    let Some((_, dirs)) = dirs_of(st, media_id).await else {
        return;
    };
    let rows = model::of_media(&st.db, media_id).await.unwrap_or_default();
    let keep: HashSet<String> = rows
        .iter()
        .filter(|r| r.media_file_id != Some(file_id))
        .filter_map(|r| r.file_path.as_deref().map(norm))
        .collect();
    for r in rows
        .iter()
        .filter(|r| r.media_file_id == Some(file_id) && !r.is_embedded())
    {
        let Some(p) = r.file_path.as_deref() else {
            continue;
        };
        if keep.contains(&norm(p)) {
            continue;
        }
        match dirs.unlink(p) {
            Ok(()) => tracing::info!("Deleted subtitle on disk with its video: {p}"),
            Err(e) => tracing::warn!("Could not delete subtitle {p}: {e}"),
        }
    }
}

/// Unlinks a row's sidecar unless another row lists the same file; a failure is logged.
pub async fn unlink_unless_shared(st: &AppState, row: &Row) -> Result<(), AppError> {
    let (Some(stored), Some(media_id)) = (row.file_path.as_deref(), row.media_id) else {
        return Ok(());
    };
    let Some((_, dirs)) = dirs_of(st, media_id).await else {
        return Ok(());
    };
    let shared = model::of_media(&st.db, media_id)
        .await?
        .iter()
        .any(|o| o.id != row.id && o.file_path.as_deref().map(norm) == Some(norm(stored)));
    if !shared && let Err(e) = dirs.unlink(stored) {
        tracing::warn!("Could not delete subtitle {stored}: {e}");
    }
    Ok(())
}

/// `deleteSubtitle`: the sidecar goes (a failure is logged), then the row.
pub async fn delete_subtitle(st: &AppState, id: i32) -> Result<(), AppError> {
    let row = model::by_id(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found(format!("SubtitleFile #{id} not found")))?;
    if row.is_embedded() {
        return Err(AppError::bad_request("Cannot delete an embedded subtitle"));
    }
    unlink_unless_shared(st, &row).await?;
    sqlx::query("DELETE FROM subtitle_files WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(())
}

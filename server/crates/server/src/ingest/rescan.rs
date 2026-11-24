//! `MediaRescanService` (`ingest.md` rules 38-54): disk walk, row reconcile, analyze, link in place.
use super::{
    MediaRow, drop_thumbnails, fsx,
    library::{Ep, file_name},
    load_media, probe, probe_with,
};
use crate::{
    events::{Num, Subject},
    jobs::bodies::ActivityRows,
};
use crate::{
    http::AppError,
    media::items::{self, Link},
    state::AppState,
};
use fliks_domain::{
    media::{
        bonus::{is_bonus_dir, is_sample_file},
        kind::MediaKind,
    },
    metadata::limiter::Priority,
    naming::{EpisodeNumbers, match_special_by_title, parse_episode_numbers},
    release::parsing::quality::parse_release_quality,
};
use fliks_engine_core::api::{JobKind, JobPriority, JobRequest, MediaInfo, MediaRef};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{sync::OwnedMutexGuard, task::JoinSet};

#[derive(Debug, Default, Clone, Copy)]
pub struct Counts {
    pub added: i64,
    pub removed: i64,
    pub updated: i64,
    pub subtitle_removed_missing: i64,
    pub subtitle_removed_duplicates: i64,
}

/// Bumped when a probe stores something new, so unchanged files are probed again once.
pub const PROBE_VERSION: i32 = 4;

struct Row {
    id: i32,
    folder_id: i32,
    rel: String,
    size: i64,
    mtime_ms: Option<i64>,
    probe_version: Option<i32>,
    episode_id: Option<i32>,
    info: Option<serde_json::Value>,
}

/// `media.path`: the library root and the media folder must exist (never created here).
fn media_dir(media: &MediaRow) -> Result<(fsx::Root, PathBuf), AppError> {
    let lib = media
        .folder
        .as_ref()
        .map(|f| f.path.as_str())
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            AppError::bad_request(format!("Media #{} has no root path configured", media.id))
        })?;
    let missing = |d: &str| AppError::bad_request(format!("Media folder not found: {d}"));
    let root = fsx::Root::open(lib).map_err(|_| missing(lib))?;
    let dir = media.dir_in(&root).map_err(AppError::bad_request)?;
    let real = dunce::canonicalize(&dir).map_err(|_| missing(&dir.to_string_lossy()))?;
    if !real.is_dir() || !real.starts_with(root.path()) {
        return Err(missing(&dir.to_string_lossy()));
    }
    Ok((root, dir))
}

struct Walk {
    files: Vec<PathBuf>,
    complete: bool,
}

/// Rule 40: depth 3, links never followed into, only regular video files (book files: never a link).
fn walk(
    dir: &Path,
    root: &Path,
    depth: usize,
    linked: &HashSet<String>,
    bonus: bool,
    kind: MediaKind,
    out: &mut Walk,
) {
    if depth > 3 {
        tracing::warn!(
            "Rescan: skipping subfolder (max depth 3) \"{}\"",
            dir.display()
        );
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!("Rescan: cannot read directory \"{}\": {e}", dir.display());
            out.complete = false;
            return;
        }
    };
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let in_bonus = bonus || (depth > 0 && is_bonus_dir(&name));
    for e in entries.flatten() {
        let path = e.path();
        if e.file_type().is_ok_and(|t| t.is_dir()) {
            let disc = fliks_domain::music::group::is_disc_folder(&e.file_name().to_string_lossy());
            if kind != MediaKind::Album || disc {
                walk(&path, root, depth + 1, linked, in_bonus, kind, out);
            }
            continue;
        }
        let n = e.file_name().to_string_lossy().into_owned();
        let regular = match kind {
            MediaKind::Book | MediaKind::Comic | MediaKind::Album => {
                e.file_type().is_ok_and(|t| t.is_file())
            }
            _ => fs::metadata(&path).is_ok_and(|m| m.is_file()),
        };
        if !super::books::owns(kind, &n) || !regular {
            continue;
        }
        let known = fsx::rel_under(root, &path).is_some_and(|r| linked.contains(&r));
        if known || !(in_bonus || is_sample_file(&n)) {
            out.files.push(path);
        }
    }
}

/// The folders a rescan visits: those holding the media's files plus its target, by id.
async fn rescan_folders(
    st: &AppState,
    media: &MediaRow,
    rows: &[Row],
) -> Result<Vec<crate::libraries::Folder>, AppError> {
    let mut ids: Vec<i32> = rows.iter().map(|r| r.folder_id).collect();
    ids.extend(media.folder.iter().map(|f| f.id));
    if super::registers(media.media_type) {
        ids.extend(super::books::want_folders(&st.db, media.id).await?);
    }
    Ok(sqlx::query!(
        r#"SELECT id, path FROM library_folders WHERE id = ANY($1) ORDER BY id"#,
        &ids
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|f| crate::libraries::Folder {
        id: f.id,
        path: f.path,
    })
    .collect())
}

/// `rescanFiles` (rules 38-48): one pass per folder (libraries rule 55); the caller holds the media's lock.
/// `force` reads every file again as if it had changed.
pub async fn rescan_files(
    st: &AppState,
    _guard: &OwnedMutexGuard<()>,
    media_id: i32,
    force: bool,
) -> Result<Counts, AppError> {
    let _moves = st.folder_moves.read().await;
    let media = load_media(&st.db, media_id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(media_id))?;
    if media.folder.as_ref().is_none_or(|f| f.path.is_empty()) {
        return Err(AppError::bad_request(format!(
            "Media #{media_id} has no root path configured"
        )));
    }
    let all = sqlx::query_as!(
        Row,
        r#"SELECT f.id, f."folderId" AS folder_id, f."relativePath" AS rel, f.size, f."mtimeMs" AS mtime_ms,
                  f."probeVersion" AS probe_version, f."streamInfo" AS info,
                  (SELECT fi."episodeId" FROM media_file_items fi WHERE fi."mediaFileId" = f.id) AS episode_id
           FROM media_files f
           WHERE f."mediaId" = $1 ORDER BY f.id"#,
        media_id
    )
    .fetch_all(&st.db)
    .await?;
    let folders = rescan_folders(st, &media, &all).await?;
    let mut by_folder: HashMap<i32, Vec<Row>> = HashMap::new();
    for r in all {
        by_folder.entry(r.folder_id).or_default().push(r);
    }
    let mut c = Counts::default();
    let mut slots_created = false;
    let mut touched: Vec<Touched> = vec![];
    let mut added: Vec<i32> = vec![];
    let mut slots = Slots::default();
    if media.has_seasons() {
        slots = Slots::load(&st.db, media_id).await?;
    }
    let (mut complete, mut ran, mut visited, mut skipped) = (true, false, false, None);
    let mut applied = Ok(());
    for folder in folders {
        let rows = by_folder.remove(&folder.id).unwrap_or_default();
        let m = MediaRow {
            folder: Some(folder),
            ..media.clone()
        };
        let probe_m = m.clone();
        let found = tokio::task::spawn_blocking(move || media_dir(&probe_m))
            .await
            .map_err(|e| AppError::internal(e.to_string()))?;
        let (root, dir) = match found {
            Ok(d) => d,
            Err(e) => {
                if !rows.is_empty() {
                    tracing::warn!(
                        "Rescan[media #{media_id}]: folder skipped, rows kept: {}",
                        e.text()
                    );
                    skipped.get_or_insert(e);
                }
                continue;
            }
        };
        ran |= !rows.is_empty();
        visited = true;
        tracing::info!(
            "Rescan: started media #{media_id} \"{}\" root=\"{}\"",
            media.title,
            dir.display()
        );
        let base = root.path().to_path_buf();
        let linked: HashSet<String> = rows.iter().map(|r| norm(&r.rel)).collect();
        let w = walk_media(&m, &dir, &base, &rows, &linked).await?;
        let disk: Vec<(String, PathBuf)> = w
            .files
            .into_iter()
            .filter_map(|p| Some((fsx::rel_under(&base, &p)?, p)))
            .collect();
        let on_disk: HashSet<&str> = disk.iter().map(|(r, _)| r.as_str()).collect();
        if media.has_seasons() {
            let wanted = wanted_numbers(&base, &rows, &on_disk, &disk, &linked);
            slots_created |= slots.ensure(st, media_id, &wanted).await?;
        }
        if w.complete {
            remove_missing(st, media_id, &rows, &on_disk, &mut c).await?;
        } else {
            complete = false;
            tracing::warn!(
                "Rescan[media #{media_id}]: a directory could not be read, no row removed"
            );
        }
        let kept: Vec<&Row> = rows
            .iter()
            .filter(|r| on_disk.contains(norm(&r.rel).as_str()))
            .collect();
        applied = async {
            if super::registers(media.media_type) {
                return book_pass(st, &m, &base, &kept, &disk, &linked, force, &mut c).await;
            }
            refresh_existing(
                st,
                &m,
                &base,
                &kept,
                &slots,
                force,
                &mut c,
                &mut touched,
                &mut added,
            )
            .await?;
            slots_created |= add_new(
                st,
                &m,
                &disk,
                &linked,
                &mut slots,
                &mut c,
                &mut touched,
                &mut added,
            )
            .await?;
            Ok(())
        }
        .await;
        if applied.is_err() {
            break;
        }
    }
    if let Some(e) = skipped
        && !ran
    {
        return Err(e);
    }
    if !visited {
        return Ok(c);
    }
    // A stamped row must get its embedded detection even when a later step failed.
    // An interrupted walk proves nothing about the sidecars on disk.
    if !super::registers(media.media_type) {
        reconcile_subtitles(st, media_id, &mut c, &touched, complete).await;
    }
    // After the sidecars are registered: the enrich's subtitle search must see them.
    queue_registered(st, media_id, &added).await;
    applied?;
    tracing::info!(
        "Rescan: media #{media_id} done (added {}, removed {}, updated {})",
        c.added,
        c.removed,
        c.updated
    );
    if c.added + c.removed + c.updated > 0 {
        crate::media_servers::dispatch_detached(st, "library.rescan");
    }
    if slots_created
        && crate::media::external_ids::any(&st.db, media_id).await?
        && let Err(e) =
            crate::media::service::refresh_series_episodes(st, &media, Priority::Background).await
    {
        tracing::warn!("Rescan[media #{media_id}]: episode metadata refresh failed: {e:?}");
    }
    Ok(c)
}

/// A book's rows are refreshed and its new files registered together (`book-ingest.md` rule 6);
/// `force` registers its known files again too.
#[allow(clippy::too_many_arguments)]
async fn book_pass(
    st: &AppState,
    media: &MediaRow,
    base: &Path,
    kept: &[&Row],
    disk: &[(String, PathBuf)],
    linked: &HashSet<String>,
    force: bool,
    c: &mut Counts,
) -> Result<(), AppError> {
    let known: Vec<super::books::KnownFile> = kept
        .iter()
        .map(|r| super::books::KnownFile {
            id: r.id,
            rel: r.rel.clone(),
            size: r.size,
            mtime_ms: r.mtime_ms,
            probe_version: r.probe_version,
        })
        .collect();
    let refs: Vec<&super::books::KnownFile> = known.iter().collect();
    if !force {
        c.updated += match media.media_type {
            MediaKind::Comic => super::comics::refresh(st, base, &refs).await,
            MediaKind::Album => super::music::refresh(st, media.id, base, &refs).await,
            _ => super::books::refresh(st, base, &refs).await,
        }
        .map_err(AppError::internal)?;
    }
    let Some(folder) = media.folder.as_ref() else {
        return Ok(());
    };
    let new: Vec<String> = disk
        .iter()
        .filter(|(r, _)| !linked.contains(r))
        .map(|(r, _)| r.clone())
        .collect();
    let owned: HashSet<String> = sqlx::query_scalar!(
        r#"SELECT "relativePath" FROM media_files
           WHERE "folderId" = $1 AND "mediaId" <> $2 AND "relativePath" = ANY($3)"#,
        folder.id,
        media.id,
        &new
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .collect();
    let fresh: Vec<super::books::Placed> = disk
        .iter()
        .filter(|(r, _)| (force || !linked.contains(r)) && !owned.contains(r))
        .map(|(rel, abs)| super::books::Placed {
            folder_id: folder.id,
            rel: rel.clone(),
            abs: abs.clone(),
        })
        .collect();
    let reg = if fresh.is_empty() {
        super::books::Registration::default()
    } else {
        match media.media_type {
            MediaKind::Album => super::music::register_with(st, media.id, &fresh, force).await,
            kind => super::register_files(st, kind, media.id, &fresh, None).await,
        }
        .map_err(AppError::internal)?
    };
    for why in &reg.conflicts {
        tracing::warn!("Rescan[media #{}]: {why}", media.id);
    }
    if reg.files.is_empty()
        && media.media_type == MediaKind::Book
        && let Err(e) = super::books::relay(st, media.id).await
    {
        tracing::warn!("Rescan[media #{}]: {e}", media.id);
    }
    let again = reg.files.iter().filter(|f| linked.contains(&f.rel)).count() as i64;
    c.updated += again;
    c.added += reg.files.len() as i64 - again;
    Ok(())
}

fn norm(r: &str) -> String {
    r.replace('\\', "/")
}

async fn walk_media(
    media: &MediaRow,
    dir: &Path,
    base: &Path,
    rows: &[Row],
    linked: &HashSet<String>,
) -> Result<Walk, AppError> {
    let mut w = Walk {
        files: vec![],
        complete: true,
    };
    if media.folder_name.as_deref().is_some_and(|f| !f.is_empty()) {
        let (d, b, l) = (dir.to_path_buf(), base.to_path_buf(), linked.clone());
        let kind = media.media_type;
        w = tokio::task::spawn_blocking(move || {
            let mut w = Walk {
                files: vec![],
                complete: true,
            };
            walk(&d, &b, 0, &l, false, kind, &mut w);
            w
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    } else {
        for r in rows {
            if let Some(rel) = fsx::safe_rel(&r.rel) {
                let p = base.join(rel);
                if tokio::fs::metadata(&p).await.is_ok_and(|m| m.is_file()) {
                    w.files.push(p);
                }
            }
        }
        // An empty or unlistable root may be an unmounted share: trust the walk only when it lists an entry.
        if !rows.is_empty() && w.files.is_empty() {
            w.complete = match tokio::fs::read_dir(dir).await {
                Ok(mut e) => matches!(e.next_entry().await, Ok(Some(_))),
                Err(_) => false,
            };
        }
    }
    Ok(w)
}

async fn remove_missing(
    st: &AppState,
    media_id: i32,
    rows: &[Row],
    on_disk: &HashSet<&str>,
    c: &mut Counts,
) -> Result<(), AppError> {
    let gone: Vec<&Row> = rows
        .iter()
        .filter(|r| !on_disk.contains(norm(&r.rel).as_str()))
        .collect();
    for r in gone.iter().filter(|r| r.rel.contains("..")) {
        tracing::error!(
            "Rescan[media #{media_id}]: row with \"..\" in relativePath \"{}\"",
            r.rel
        );
    }
    if gone.is_empty() {
        return Ok(());
    }
    let ids: Vec<i32> = gone.iter().map(|r| r.id).collect();
    match sqlx::query!("DELETE FROM media_files WHERE id = ANY($1)", &ids)
        .execute(&st.db)
        .await
    {
        Ok(_) => {
            if let Err(e) = crate::party::clear_files(st, &ids).await {
                tracing::warn!("Rescan[media #{media_id}]: parties keep a removed file: {e}");
            }
            for id in ids {
                drop_thumbnails(st, id);
            }
            c.removed += gone.len() as i64;
        }
        Err(e) => tracing::error!(
            "Rescan[media #{media_id}]: failed to remove {} rows: {e}",
            gone.len()
        ),
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn refresh_existing(
    st: &AppState,
    media: &MediaRow,
    dir: &Path,
    rows: &[&Row],
    slots: &Slots,
    force: bool,
    c: &mut Counts,
    touched: &mut Vec<Touched>,
    added: &mut Vec<i32>,
) -> Result<(), AppError> {
    let media_id = media.id;
    let mut links: Vec<Link> = vec![];
    let mut ends: Vec<(i32, i32)> = vec![];
    for r in rows {
        let abs = dir.join(norm(&r.rel));
        let Ok(meta) = tokio::fs::metadata(&abs).await else {
            continue;
        };
        let disk_size = meta.len() as i64;
        let mtime = mtime_ms(&meta);
        let name = file_name(&abs);
        let mut episode_id = r.episode_id;
        if media.has_seasons() {
            let nums = parse_episode_numbers(&name, Some(&abs.to_string_lossy()));
            match (nums, r.episode_id) {
                (Some(n), None) => {
                    if let Some(ep) = slots.episode(n) {
                        links.push(Link {
                            file: r.id,
                            owner: Some(ep),
                            last: n.episode_end.map(|e| e as i32),
                        });
                        episode_id = Some(ep);
                        c.updated += 1;
                    }
                }
                (None, None) => {
                    if let Some(ep) = slots.special(&name) {
                        links.push(Link {
                            file: r.id,
                            owner: Some(ep.id),
                            last: None,
                        });
                        episode_id = Some(ep.id);
                        c.updated += 1;
                    }
                }
                (Some(n), Some(ep)) => {
                    if let Some(end) = n.episode_end {
                        ends.push((ep, end as i32));
                    }
                }
                _ => {}
            }
        }
        let unchanged = !force && r.size == disk_size;
        if unchanged
            && mtime.is_some()
            && r.mtime_ms == mtime
            && r.probe_version == Some(PROBE_VERSION)
        {
            if episode_id != r.episode_id {
                touched.push((r.id, episode_id, None));
            }
            continue;
        }
        let stored = Stored {
            file_id: r.id,
            info: r.info.clone().and_then(|v| serde_json::from_value(v).ok()),
            mtime_ms: r.mtime_ms,
        };
        let change = Change {
            content_changed: !unchanged,
            timeline_preserved: false,
        };
        let Ok(info) = refresh_content(st, &abs, &name, stored, change, disk_size, mtime)
            .await
            .inspect_err(|e| {
                tracing::error!("Rescan[media #{media_id}] refresh \"{}\": {e}", r.rel)
            })
        else {
            continue;
        };
        c.updated += 1;
        // A row registered while the engine could not probe it gets its post-import work now.
        if r.info.is_none() {
            added.push(r.id);
        }
        touched.push((r.id, episode_id, Some(info)));
    }
    items::attach(&st.db, media_id, &links).await?;
    set_ends(&st.db, &ends).await?;
    items::cover_ranges(&mut *st.db.acquire().await?, media_id).await?;
    Ok(())
}

/// What the row held before the refresh.
pub struct Stored {
    pub file_id: i32,
    pub info: Option<MediaInfo>,
    pub mtime_ms: Option<i64>,
}

/// Why a file is refreshed. `content_changed` recomputes what is derived from the bytes (crop, clock
/// break) and invalidates the engine; `timeline_preserved` keeps the OpenSubtitles hash of the original.
#[derive(Clone, Copy)]
pub struct Change {
    pub content_changed: bool,
    pub timeline_preserved: bool,
}

/// The "content changed" path of a rescan for one file: probe, row update, engine invalidation, scan.
pub async fn refresh_content(
    st: &AppState,
    abs: &Path,
    name: &str,
    stored: Stored,
    change: Change,
    disk_size: i64,
    mtime: Option<i64>,
) -> Result<MediaInfo, String> {
    let p = probe_with(st, abs, change.content_changed, !change.timeline_preserved).await?;
    let mut info = p.info.clone();
    if let Some(old) = &stored.info
        && !change.content_changed
    {
        if let (Some(o), Some(v)) = (
            old.video.first().filter(|v| v.crop.is_some()),
            info.video.first_mut(),
        ) {
            v.crop = o.crop.clone();
            v.crop_stable = o.crop_stable;
        }
        if old.timestamp_break_seconds.is_some() {
            info.timestamp_break_seconds = old.timestamp_break_seconds;
        }
    }
    let quality = p.quality(name);
    let (hash, bytes) = match &p.moviehash {
        Some((h, b)) if !change.timeline_preserved => (Some(h.clone()), Some(*b)),
        _ => (None, None),
    };
    sqlx::query!(
        r#"UPDATE media_files SET size = $2, quality = COALESCE($3, quality), "streamInfo" = $4,
             "mtimeMs" = $5, "probeVersion" = $6, "osdbHash" = COALESCE($7, "osdbHash"),
             "osdbBytesize" = COALESCE($8, "osdbBytesize") WHERE id = $1"#,
        stored.file_id,
        disk_size,
        quality,
        serde_json::to_value(&info).map_err(|e| e.to_string())?,
        mtime,
        PROBE_VERSION,
        hash,
        bytes
    )
    .execute(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    if change.content_changed {
        st.engine.invalidate(stored.file_id as u32).await;
    }
    if change.content_changed || stored.mtime_ms.is_some_and(|m| Some(m) != mtime) {
        crate::stream::spawn_scan(st, stored.file_id, abs.to_path_buf(), Some(info.clone()));
    }
    Ok(info)
}

/// Rule 44: the files of this folder pass no row holds yet; returns whether a slot was created.
#[allow(clippy::too_many_arguments)]
async fn add_new(
    st: &AppState,
    media: &MediaRow,
    disk: &[(String, PathBuf)],
    linked: &HashSet<String>,
    slots: &mut Slots,
    c: &mut Counts,
    touched: &mut Vec<Touched>,
    added: &mut Vec<i32>,
) -> Result<bool, AppError> {
    let Some(folder_id) = media.folder.as_ref().map(|f| f.id) else {
        return Ok(false);
    };
    let files = disk
        .iter()
        .filter(|(r, _)| !linked.contains(r))
        .map(|(rel, abs)| OnDisk {
            folder_id,
            rel: rel.clone(),
            abs: abs.clone(),
            nums: None,
        })
        .collect();
    let mut r = Registered::default();
    // The rows are stored even when the link fails: the tail still queues them.
    let done = register_on_disk(st, media, slots, files, &mut r).await;
    for (abs, why) in &r.rejected {
        tracing::warn!(
            "Rescan[media #{}]: \"{}\" skipped: {why}",
            media.id,
            file_name(abs)
        );
    }
    c.added += r.added.len() as i64;
    added.extend(r.probed());
    touched.extend(r.added);
    done.map(|()| r.created)
}

/// A video file to register where it lies, with the caller's episode numbers if it gave some.
pub(crate) struct OnDisk {
    pub folder_id: i32,
    pub rel: String,
    pub abs: PathBuf,
    pub nums: Option<EpisodeNumbers>,
}

#[derive(Default)]
struct Registered {
    /// Every row inserted, with its probe when it had one.
    added: Vec<Touched>,
    created: bool,
    rejected: Vec<(PathBuf, String)>,
}

impl Registered {
    /// The rows the post-import queue can enrich: a row without a probe waits for the next rescan.
    fn probed(&self) -> impl Iterator<Item = i32> + '_ {
        self.added.iter().filter(|t| t.2.is_some()).map(|t| t.0)
    }
}

/// Rules 44, 49 and 52: probe without the crop, insert the rows (stamped when probed) and link them
/// to their episodes. The caller hands `probed()` to `queue_registered` once its own steps are done.
async fn register_on_disk(
    st: &AppState,
    media: &MediaRow,
    slots: &mut Slots,
    files: Vec<OnDisk>,
    r: &mut Registered,
) -> Result<(), AppError> {
    let media_id = media.id;
    let eps = if media.has_seasons() {
        let paths: Vec<_> = files.iter().map(|f| (f.abs.as_path(), f.nums)).collect();
        let (eps, created) = resolve_episodes(st, slots, media_id, &paths).await?;
        r.created = created;
        eps
    } else {
        vec![Some((None, None)); files.len()]
    };
    let mut fresh: Vec<NewRow> = vec![];
    for (f, ep) in files.into_iter().zip(eps) {
        let Some((episode_id, last)) = ep else {
            r.rejected.push((f.abs, "no SxxEyy pattern found".into()));
            continue;
        };
        let Ok(meta) = tokio::fs::metadata(&f.abs).await else {
            r.rejected.push((f.abs, "not readable".into()));
            continue;
        };
        let name = file_name(&f.abs);
        let named = || parse_release_quality(&name).quality.name.to_owned();
        // An engine that cannot probe now leaves an unstamped row, which the next rescan probes.
        let p = probe(st, &f.abs, false)
            .await
            .inspect_err(|e| tracing::warn!("Register[media #{media_id}] \"{name}\": {e}"))
            .ok();
        let (quality, info, mtime, stamp) = match &p {
            Some(p) => (
                p.quality(&name).unwrap_or_else(named),
                Some(serde_json::to_value(&p.info).map_err(|e| AppError::internal(e.to_string()))?),
                mtime_ms(&meta),
                Some(PROBE_VERSION),
            ),
            None => (named(), None, None, None),
        };
        fresh.push(NewRow {
            folder_id: f.folder_id,
            rel: f.rel,
            abs: f.abs,
            episode_id,
            last,
            size: meta.len() as i64,
            quality,
            info,
            probed: p.map(|p| p.info),
            mtime,
            stamp,
        });
    }
    if fresh.is_empty() {
        return Ok(());
    }
    let mut failed: HashMap<(i32, &str), String> = HashMap::new();
    let inserted = match insert_rows(&st.db, media_id, &fresh).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(
                "Register[media #{media_id}]: batch insert of {} files failed, retrying one by one: {e}",
                fresh.len()
            );
            let mut rows = vec![];
            for n in &fresh {
                match insert_rows(&st.db, media_id, std::slice::from_ref(n)).await {
                    Ok(r) => rows.extend(r),
                    Err(e) => {
                        failed.insert((n.folder_id, n.rel.as_str()), format!("insert failed: {e}"));
                    }
                }
            }
            rows
        }
    };
    let ids: HashMap<(i32, &str), i32> = inserted
        .iter()
        .map(|(id, folder, rel)| ((*folder, rel.as_str()), *id))
        .collect();
    let mut links = vec![];
    for n in &fresh {
        let key = (n.folder_id, n.rel.as_str());
        let Some(&id) = ids.get(&key) else {
            let why = failed
                .remove(&key)
                .unwrap_or_else(|| "already registered".into());
            r.rejected.push((n.abs.clone(), why));
            continue;
        };
        r.added.push((id, n.episode_id, n.probed.clone()));
        links.push(Link {
            file: id,
            owner: n.episode_id,
            last: n.last,
        });
    }
    items::attach(&st.db, media_id, &links).await?;
    Ok(())
}

/// Registered files go to the bulk lane of the post-import queue and the media settles after them.
async fn queue_registered(st: &AppState, media_id: i32, ids: &[i32]) {
    if !ids.is_empty() {
        st.ingest.queue.enqueue_bulk(st, ids).await;
        st.ingest.settle.schedule(st, media_id);
    }
}

async fn insert_rows(
    db: &sqlx::PgPool,
    media_id: i32,
    fresh: &[NewRow],
) -> Result<Vec<(i32, i32, String)>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality, "streamInfo",
             "mtimeMs", "probeVersion")
           SELECT $1, v.folder, v.rel, v.size, v.quality, v.info, v.mtime, v.stamp
           FROM UNNEST($2::int[], $3::text[], $4::bigint[], $5::text[], $6::jsonb[], $7::bigint[], $8::int[])
             AS v(folder, rel, size, quality, info, mtime, stamp)
           ON CONFLICT ("folderId", "relativePath") DO NOTHING
           RETURNING id, "folderId" AS folder, "relativePath" AS rel"#,
        media_id,
        &fresh.iter().map(|n| n.folder_id).collect::<Vec<_>>(),
        &fresh.iter().map(|n| n.rel.clone()).collect::<Vec<_>>(),
        &fresh.iter().map(|n| n.size).collect::<Vec<_>>(),
        &fresh.iter().map(|n| n.quality.clone()).collect::<Vec<_>>(),
        &fresh.iter().map(|n| n.info.clone()).collect::<Vec<_>>() as &[Option<serde_json::Value>],
        &fresh.iter().map(|n| n.mtime).collect::<Vec<_>>() as &[Option<i64>],
        &fresh.iter().map(|n| n.stamp).collect::<Vec<_>>() as &[Option<i32>]
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.id, r.folder, r.rel)).collect())
}

/// A file the pass added, re-probed or relinked, with its probe unless it was only relinked.
type Touched = (i32, Option<i32>, Option<MediaInfo>);

struct NewRow {
    folder_id: i32,
    rel: String,
    abs: PathBuf,
    episode_id: Option<i32>,
    last: Option<i32>,
    size: i64,
    quality: String,
    info: Option<serde_json::Value>,
    probed: Option<MediaInfo>,
    mtime: Option<i64>,
    stamp: Option<i32>,
}

/// The media's seasons and episodes, loaded once so a batch of files resolves in memory.
#[derive(Default)]
pub(crate) struct Slots {
    seasons: HashMap<i32, i32>,
    episodes: HashMap<(i32, i32), (i32, Option<i32>)>,
    specials: Vec<Ep>,
}

impl Slots {
    pub(crate) async fn load(db: &sqlx::PgPool, media: i32) -> Result<Self, sqlx::Error> {
        let rows = sqlx::query!(
            r#"SELECT s.id AS season_id, s."number" AS season, e.id AS "ep_id?",
                      e."number" AS "ep?", e."endNumber" AS end, e.title,
                      e."airDate"::text AS air_date
               FROM item_groups s LEFT JOIN items e ON e."groupId" = s.id
               WHERE s."mediaId" = $1 ORDER BY s.id, e.id"#,
            media
        )
        .fetch_all(db)
        .await?;
        let mut me = Self::default();
        for r in &rows {
            me.seasons.entry(r.season).or_insert(r.season_id);
        }
        for r in rows {
            let (Some(id), Some(ep)) = (r.ep_id, r.ep) else {
                continue;
            };
            if me.seasons[&r.season] == r.season_id {
                me.episodes.entry((r.season, ep)).or_insert((id, r.end));
            }
            if r.season == 0 {
                me.specials.push(Ep {
                    id,
                    season_number: 0,
                    episode_number: ep,
                    end: r.end,
                    title: r.title,
                    air_date: r.air_date,
                });
            }
        }
        me.specials.sort_by_key(|e| e.id);
        Ok(me)
    }

    /// Rule 45 in batches: the missing seasons and episodes are inserted, end numbers widened.
    async fn ensure(
        &mut self,
        st: &AppState,
        media: i32,
        wanted: &[EpisodeNumbers],
    ) -> Result<bool, sqlx::Error> {
        let seasons: BTreeSet<i32> = wanted
            .iter()
            .map(|n| n.season as i32)
            .filter(|s| !self.seasons.contains_key(s))
            .collect();
        let db = &st.db;
        let mut created = false;
        if !seasons.is_empty() {
            let nums: Vec<i32> = seasons.into_iter().collect();
            let before = crate::media::service::media_flag(db, media).await?;
            created = sqlx::query!(
                r#"INSERT INTO item_groups ("mediaId", "number", monitored)
                   SELECT m.id, n, n > 0 AND m."monitorNewSeasons" FROM media m, UNNEST($2::int[]) AS n
                   WHERE m.id = $1
                   ON CONFLICT ("mediaId", "number") DO NOTHING"#,
                media,
                &nums
            )
            .execute(db)
            .await?
            .rows_affected()
                > 0;
            crate::media::service::announce_flip(st, media, before).await?;
            let rows = sqlx::query!(
                r#"SELECT id, "number" AS n FROM item_groups WHERE "mediaId" = $1 AND "number" = ANY($2)"#,
                media,
                &nums
            )
            .fetch_all(db)
            .await?;
            self.seasons.extend(rows.into_iter().map(|r| (r.n, r.id)));
        }
        let mut fresh: BTreeMap<(i32, i32), Option<i32>> = BTreeMap::new();
        let mut ends: Vec<(i32, i32)> = vec![];
        for n in wanted {
            let key = (n.season as i32, n.episode as i32);
            let end = n.episode_end.map(|e| e as i32);
            match self.episodes.get(&key) {
                Some(&(id, cur)) => {
                    if let Some(e) = end.filter(|e| Some(*e) != cur) {
                        ends.push((id, e));
                    }
                }
                None => {
                    let slot = fresh.entry(key).or_insert(end);
                    *slot = end.or(*slot);
                }
            }
        }
        if !fresh.is_empty() {
            let by_id: HashMap<i32, i32> = self.seasons.iter().map(|(n, id)| (*id, *n)).collect();
            let sids: Vec<i32> = fresh.keys().map(|k| self.seasons[&k.0]).collect();
            let nums: Vec<i32> = fresh.keys().map(|k| k.1).collect();
            let es: Vec<Option<i32>> = fresh.values().copied().collect();
            let edition = items::video_edition(db, media).await?;
            created |= sqlx::query!(
                r#"INSERT INTO items ("groupId", "mediaId", "editionId", "number", "endNumber", monitored)
                   SELECT v.s, $4, $5, v.n, v.e, g.monitored
                   FROM UNNEST($1::int[], $2::int[], $3::int[]) AS v(s, n, e)
                   JOIN item_groups g ON g.id = v.s
                   ON CONFLICT ("groupId", "number") DO NOTHING"#,
                &sids,
                &nums,
                &es as &[Option<i32>],
                media,
                edition
            )
            .execute(db)
            .await?
            .rows_affected()
                > 0;
            let rows = sqlx::query!(
                r#"SELECT e.id, e."groupId" AS "season_id!", e."number" AS "n!", e."endNumber" AS end
                   FROM items e JOIN UNNEST($1::int[], $2::int[]) AS v(s, n)
                     ON e."groupId" = v.s AND e."number" = v.n"#,
                &sids,
                &nums
            )
            .fetch_all(db)
            .await?;
            for r in rows {
                let key = (by_id[&r.season_id], r.n);
                let want = fresh.get(&key).copied().flatten();
                if let Some(e) = want.filter(|e| Some(*e) != r.end) {
                    ends.push((r.id, e));
                }
                self.episodes.insert(key, (r.id, want.or(r.end)));
            }
        }
        set_ends(db, &ends).await?;
        items::cover_ranges(&mut *db.acquire().await?, media).await?;
        Ok(created)
    }

    fn episode(&self, n: EpisodeNumbers) -> Option<i32> {
        self.episodes
            .get(&(n.season as i32, n.episode as i32))
            .map(|e| e.0)
    }

    fn special(&self, file_name: &str) -> Option<&Ep> {
        match_special_by_title(file_name, &self.specials).map(|i| &self.specials[i])
    }
}

/// Embedded detection reuses the pass's probe; a relinked file was not probed, so it probes here.
async fn reconcile_subtitles(
    st: &AppState,
    media_id: i32,
    c: &mut Counts,
    touched: &[Touched],
    walk_complete: bool,
) {
    if walk_complete {
        let (missing, dupes) =
            crate::subtitles::sidecars::reconcile_after_rescan(st, media_id).await;
        c.subtitle_removed_missing = missing as i64;
        c.subtitle_removed_duplicates = dupes as i64;
        crate::subtitles::sidecars::discover_external(st, media_id).await;
    }
    store_embedded(st, media_id, touched).await;
}

/// The embedded subtitle rows of each file, from its probe when it has one.
async fn store_embedded(st: &AppState, media_id: i32, touched: &[Touched]) {
    for (file, episode, info) in touched {
        match info {
            Some(info) => {
                crate::subtitles::embedded::store_probed(st, media_id, *file, *episode, info).await
            }
            None => {
                crate::subtitles::embedded::detect_and_store(st, media_id, *file, *episode).await
            }
        };
    }
}

pub(crate) fn mtime_ms(m: &fs::Metadata) -> Option<i64> {
    let d = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    i64::try_from(d.as_millis()).ok()
}

async fn set_ends(db: &sqlx::PgPool, ends: &[(i32, i32)]) -> Result<(), sqlx::Error> {
    if ends.is_empty() {
        return Ok(());
    }
    let (ids, ends): (Vec<i32>, Vec<i32>) = ends.iter().copied().unzip();
    sqlx::query!(
        r#"UPDATE items e SET "endNumber" = v.e
           FROM UNNEST($1::int[], $2::int[]) AS v(id, e)
           WHERE e.id = v.id AND e."endNumber" IS DISTINCT FROM v.e"#,
        &ids,
        &ends
    )
    .execute(db)
    .await
    .map(drop)
}

/// Episode numbers of every file the rescan may link, parsed up front so the slots are created in one batch.
fn wanted_numbers(
    dir: &Path,
    rows: &[Row],
    on_disk: &HashSet<&str>,
    disk: &[(String, PathBuf)],
    linked: &HashSet<String>,
) -> Vec<EpisodeNumbers> {
    let parse = |abs: &Path| parse_episode_numbers(&file_name(abs), Some(&abs.to_string_lossy()));
    let rows = rows
        .iter()
        .filter(|r| on_disk.contains(norm(&r.rel).as_str()))
        .filter_map(|r| parse(&dir.join(norm(&r.rel))));
    let new = disk
        .iter()
        .filter(|(r, _)| !linked.contains(r))
        .filter_map(|(_, abs)| parse(abs));
    rows.chain(new).collect()
}

/// Rule 45 for a batch: each file's episode `(id, end)` from the caller's numbers or its name, else
/// a season-0 title match, `None` when neither. Missing slots are created first; returns whether any was.
pub(crate) async fn resolve_episodes(
    st: &AppState,
    slots: &mut Slots,
    media: i32,
    files: &[(&Path, Option<EpisodeNumbers>)],
) -> Result<(Vec<Option<(Option<i32>, Option<i32>)>>, bool), sqlx::Error> {
    let nums: Vec<Option<EpisodeNumbers>> = files
        .iter()
        .map(|(p, n)| {
            n.or_else(|| parse_episode_numbers(&file_name(p), Some(&p.to_string_lossy())))
        })
        .collect();
    let wanted: Vec<EpisodeNumbers> = nums.iter().flatten().copied().collect();
    let created = !wanted.is_empty() && slots.ensure(st, media, &wanted).await?;
    let eps = files
        .iter()
        .zip(nums)
        .map(|((p, _), n)| match n {
            Some(n) => slots
                .episode(n)
                .map(|id| (Some(id), n.episode_end.map(|e| e as i32))),
            None => slots.special(&file_name(p)).map(|ep| (Some(ep.id), None)),
        })
        .collect();
    Ok((eps, created))
}

#[derive(Default)]
pub struct Linked {
    /// Every file now linked to the media, the ones it already held included.
    pub file_ids: Vec<i32>,
    /// The rows this call inserted.
    pub added: Vec<i32>,
    pub created: bool,
    pub errors: Vec<String>,
}

/// Where a file lies inside one of the media's folders (`ingest.md` rules 52-53).
pub struct Located {
    pub folder: crate::libraries::Folder,
    pub rel: String,
    pub real: PathBuf,
}

/// The folder of the media's library that contains `abs` and the path of the file in it.
pub async fn locate_in_place(
    st: &AppState,
    media: &MediaRow,
    abs: &Path,
) -> Result<Result<Located, String>, AppError> {
    let outside = || Ok(Err("file outside the media folder".to_owned()));
    // The target folder first, then the library's others: the file's folder is the one containing it.
    let mut candidates: Vec<crate::libraries::Folder> = media.folder.iter().cloned().collect();
    if let Some(library) = media.library_id {
        let others = sqlx::query!(
            r#"SELECT id, path FROM library_folders WHERE "libraryId" = $1 AND id IS DISTINCT FROM $2
               ORDER BY position, id"#,
            library,
            media.folder.as_ref().map(|f| f.id)
        )
        .fetch_all(&st.db)
        .await?;
        candidates.extend(others.into_iter().map(|f| crate::libraries::Folder {
            id: f.id,
            path: f.path,
        }));
    }
    let mut roots = vec![];
    for folder in candidates {
        if let Ok(root) = fsx::Root::open(&folder.path)
            && let Ok(dir) = media.dir_in(&root)
        {
            roots.push((folder, root, dir));
        }
    }
    if roots.is_empty() {
        return outside();
    }
    let Ok((real, _)) = fsx::regular_source(abs) else {
        return Ok(Err("not a regular file".into()));
    };
    let mut hit = None;
    for (folder, root, dir) in roots {
        let real_dir = dunce::canonicalize(&dir).unwrap_or(dir.clone());
        if let Some(inner) =
            fsx::rel_under(&real_dir, &real).filter(|_| root.contains(&real, false))
        {
            hit = Some((folder, inner));
            break;
        }
    }
    let Some((folder, inner)) = hit else {
        return outside();
    };
    let named = media.folder_name.as_deref().filter(|f| !f.is_empty());
    let rel = named.map_or_else(|| inner.clone(), |f| format!("{f}/{inner}"));
    if !super::books::owns(media.media_type, &file_name(&real)) {
        return Ok(Err(super::not_owned_message(media.media_type).into()));
    }
    if named.is_none() && inner.contains('/') && !super::registers(media.media_type) {
        return Ok(Err(
            "a title with no folder can only own files at the library root".into(),
        ));
    }
    Ok(Ok(Located { folder, rel, real }))
}

/// `linkExistingFileInPlace` (rules 52-53) for a batch, its new rows queued like a rescan's; the
/// caller holds the media's lock.
pub async fn link_in_place(
    st: &AppState,
    _guard: &OwnedMutexGuard<()>,
    media: &MediaRow,
    files: &[(PathBuf, Option<EpisodeNumbers>)],
) -> Result<Linked, AppError> {
    let mut out = Linked::default();
    let mut fresh = vec![];
    for (abs, nums) in files {
        let l = match locate_in_place(st, media, abs).await? {
            Ok(l) => l,
            Err(e) => {
                out.errors.push(format!("{}: {e}", file_name(abs)));
                continue;
            }
        };
        if let Some(held) = sqlx::query!(
            r#"SELECT id, "mediaId" AS media_id FROM media_files WHERE "folderId" = $1 AND "relativePath" = $2"#,
            l.folder.id,
            l.rel
        )
        .fetch_optional(&st.db)
        .await?
        {
            if held.media_id == media.id {
                out.file_ids.push(held.id);
            } else {
                out.errors
                    .push(format!("{}: file already linked to another media", file_name(abs)));
            }
            continue;
        }
        fresh.push(OnDisk {
            folder_id: l.folder.id,
            rel: l.rel,
            abs: l.real,
            nums: *nums,
        });
    }
    let mut slots = if media.has_seasons() {
        Slots::load(&st.db, media.id).await?
    } else {
        Slots::default()
    };
    let mut r = Registered::default();
    let done = register_on_disk(st, media, &mut slots, fresh, &mut r).await;
    out.errors.extend(
        r.rejected
            .iter()
            .map(|(abs, why)| format!("{}: {why}", file_name(abs))),
    );
    out.created = r.created;
    out.added = r.added.iter().map(|t| t.0).collect();
    out.file_ids.extend(&out.added);
    // As a rescan does: sidecars and embedded tracks first, so the queue's subtitle search sees them.
    if !r.added.is_empty() {
        crate::subtitles::sidecars::discover_external(st, media.id).await;
        store_embedded(st, media.id, &r.added).await;
        queue_registered(st, media.id, &r.probed().collect::<Vec<_>>()).await;
    }
    done.map(|()| out)
}

/// `AnalyzeMediaDto`: only the string `'true'` and the boolean `true` are true.
#[derive(Debug, Default, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Analyze {
    #[serde(default, deserialize_with = "truthy")]
    pub sprites: bool,
    #[serde(default, deserialize_with = "truthy")]
    pub crop: bool,
    #[serde(default, deserialize_with = "truthy")]
    pub subtitle_cache: bool,
}

fn truthy<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    let v = serde_json::Value::deserialize(d)?;
    Ok(v == serde_json::json!(true) || v == serde_json::json!("true"))
}

/// Activity id of the parent row grouping one analysis (rule 51).
fn analyze_activity_id(media_id: i32) -> String {
    format!("Analyze:{media_id}")
}

/// Releases the shared `Analyze` row however the analysis ends.
struct ParentRow(crate::events::Hub, String);

impl Drop for ParentRow {
    fn drop(&mut self) {
        self.0.activity().release(&self.1);
    }
}

/// `analyzeMedia` (rule 51); runs detached, errors logged by the caller. The `Analyze` parent row
/// stays until every spawned job has ended, and until the last concurrent analysis of the media.
pub async fn analyze(st: &AppState, media_id: i32, o: Analyze) -> Result<(), AppError> {
    if !(o.sprites || o.crop || o.subtitle_cache) {
        return Ok(());
    }
    let parent = analyze_activity_id(media_id);
    let mut jobs = JoinSet::new();
    let mut media = None;
    let _row = ParentRow(st.hub.clone(), parent.clone());
    let done = analyze_files(st, media_id, o, &parent, &mut jobs, &mut media).await;
    let total = jobs.len();
    let report = |ended: usize| {
        st.hub.activity().upsert_running(
            &parent,
            "Analyze",
            media.clone(),
            Some(Num(ended as f64)),
            Some(Num(total as f64)),
            None,
        );
    };
    if media.is_some() {
        report(0);
    }
    while jobs.join_next().await.is_some() {
        report(total - jobs.len());
    }
    done
}

async fn analyze_files(
    st: &AppState,
    media_id: i32,
    o: Analyze,
    parent: &str,
    jobs: &mut JoinSet<()>,
    media: &mut Option<Subject>,
) -> Result<(), AppError> {
    let ids = sqlx::query_scalar!(
        r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        media_id
    )
    .fetch_all(&st.db)
    .await?;
    let subjects = crate::events::subject::for_files(&st.db, &ids).await?;
    if let Some(s) = subjects.values().next() {
        let subject = Subject::media(media_id, &s.title, s.media_type);
        st.hub
            .activity()
            .hold(parent, "Analyze", Some(subject.clone()));
        *media = Some(subject);
    }
    for id in ids {
        let Some((abs, info)) = super::post_import::file_path(st, id).await? else {
            continue;
        };
        if !tokio::fs::try_exists(&abs).await.unwrap_or(false) {
            tracing::warn!(
                "analyzeMedia[#{media_id}]: file off-disk, skipping \"{}\"",
                abs.display()
            );
            continue;
        }
        if o.crop && info.as_ref().is_some_and(|i| !i.video.is_empty()) {
            match probe(st, &abs, true).await {
                Ok(p) => super::post_import::store_crop(&st.db, id, p.info.video.first()).await?,
                Err(e) => {
                    tracing::warn!("analyzeMedia[#{media_id}]: crop of file #{id} failed: {e}")
                }
            }
        }
        if o.subtitle_cache
            && let Some(info) = info.filter(|i| i.subtitles.iter().any(|s| !s.is_image_based))
        {
            let st = st.clone();
            let child = format!("SubtitleExtract:{id}");
            let subject = subjects.get(&id).cloned();
            let parent = parent.to_owned();
            st.hub.activity().upsert_pending(
                &child,
                "SubtitleExtract",
                subject.clone(),
                Some(parent.clone()),
            );
            let req = JobRequest {
                kind: JobKind::SubtitleExtract { info },
                media: MediaRef {
                    media_file_id: id as u32,
                    path: abs.to_string_lossy().into_owned(),
                },
                priority: Some(JobPriority::High),
                force: true,
            };
            jobs.spawn(async move {
                let _row = ActivityRows::new(&st.hub, [child.clone()]);
                let progress = {
                    let (hub, child, parent) = (st.hub.clone(), child.clone(), parent);
                    Arc::new(move |pct: f64| {
                        hub.activity().upsert_running(
                            &child,
                            "SubtitleExtract",
                            subject.clone(),
                            Some(Num(pct.round())),
                            Some(Num(100.0)),
                            Some(parent.clone()),
                        );
                    })
                };
                if let Err(e) = st.engine.run_job(&req, Some(progress)).await {
                    tracing::warn!("Subtitle cache of file #{id} failed: {e}");
                }
            });
        }
        if o.sprites {
            let st = st.clone();
            let parent = Some(parent.to_owned());
            jobs.spawn(async move {
                let _row = ActivityRows::new(&st.hub, [format!("GenerateSprite:{id}")]);
                if let Err(e) =
                    crate::stream::sprite_file(&st, id, true, JobPriority::High, parent).await
                {
                    tracing::warn!("Sprite failed for file #{id}: {e:?}");
                }
            });
        }
    }
    Ok(())
}

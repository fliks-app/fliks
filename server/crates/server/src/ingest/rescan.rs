//! `MediaRescanService` (`ingest.md` rules 38-54): disk walk, row reconcile, analyze, link in place.
use super::{
    MediaRow, drop_thumbnails, fsx, is_video,
    library::{Ep, file_name, season_episodes},
    load_media, probe,
};
use crate::{
    http::AppError,
    media::items::{self, Link},
    state::AppState,
};
use fliks_domain::{
    media::bonus::{is_bonus_dir, is_sample_file},
    metadata::limiter::Priority,
    naming::{EpisodeNumbers, match_special_by_title, parse_episode_numbers},
    release::parsing::{
        quality::parse_release_quality, quality_from_resolution::quality_from_resolution,
    },
};
use fliks_engine_core::api::{JobKind, JobPriority, JobRequest, MediaInfo, MediaRef};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use tokio::sync::OwnedMutexGuard;

#[derive(Debug, Default, Clone, Copy)]
pub struct Counts {
    pub added: i64,
    pub removed: i64,
    pub updated: i64,
    pub subtitle_removed_missing: i64,
    pub subtitle_removed_duplicates: i64,
}

/// Bumped when a probe stores something new, so unchanged files are probed again once.
const PROBE_VERSION: i32 = 2;

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
    let dir = root
        .media_dir(media.folder_name.as_deref())
        .map_err(AppError::bad_request)?;
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

/// Rule 40: depth 3, links never followed into, only regular video files.
fn walk(
    dir: &Path,
    root: &Path,
    depth: usize,
    linked: &HashSet<String>,
    bonus: bool,
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
            walk(&path, root, depth + 1, linked, in_bonus, out);
            continue;
        }
        let n = e.file_name().to_string_lossy().into_owned();
        if !is_video(&n) || !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
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
pub async fn rescan_files(
    st: &AppState,
    _guard: &OwnedMutexGuard<()>,
    media_id: i32,
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
    let mut touched: Vec<(i32, Option<i32>)> = vec![];
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
            slots_created |= slots.ensure(&st.db, media_id, &wanted).await?;
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
            refresh_existing(st, &m, &base, &kept, &slots, &mut c, &mut touched).await?;
            add_new(st, &m, &disk, &linked, &slots, &mut c, &mut touched).await
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
    reconcile_subtitles(st, media_id, &mut c, &touched, complete).await;
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
        && let Err(e) =
            crate::media::write::refresh_series_episodes(st, &media, Priority::Background).await
    {
        tracing::warn!("Rescan[media #{media_id}]: episode metadata refresh failed: {e:?}");
    }
    Ok(c)
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
        w = tokio::task::spawn_blocking(move || {
            let mut w = Walk {
                files: vec![],
                complete: true,
            };
            walk(&d, &b, 0, &l, false, &mut w);
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

async fn refresh_existing(
    st: &AppState,
    media: &MediaRow,
    dir: &Path,
    rows: &[&Row],
    slots: &Slots,
    c: &mut Counts,
    touched: &mut Vec<(i32, Option<i32>)>,
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
        let unchanged = r.size == disk_size;
        if unchanged
            && mtime.is_some()
            && r.mtime_ms == mtime
            && r.probe_version == Some(PROBE_VERSION)
        {
            if episode_id != r.episode_id {
                touched.push((r.id, episode_id));
            }
            continue;
        }
        let Ok(mut p) = probe(st, &abs, !unchanged).await.inspect_err(|e| {
            tracing::error!("Rescan[media #{media_id}] refresh \"{}\": {e}", r.rel)
        }) else {
            continue;
        };
        let old: Option<MediaInfo> = r.info.clone().and_then(|v| serde_json::from_value(v).ok());
        if let Some(old) = &old {
            if unchanged
                && let (Some(crop), Some(v)) = (
                    old.video.first().and_then(|v| v.crop.clone()),
                    p.info.video.first_mut(),
                )
            {
                v.crop = Some(crop);
            }
            if old.timestamp_break_seconds.is_some() {
                p.info.timestamp_break_seconds = old.timestamp_break_seconds;
            }
        }
        let quality = p.quality(&name);
        sqlx::query!(
            r#"UPDATE media_files SET size = $2, quality = COALESCE($3, quality), "streamInfo" = $4,
                 "mtimeMs" = $5, "probeVersion" = $6 WHERE id = $1"#,
            r.id,
            disk_size,
            quality,
            serde_json::to_value(&p.info).map_err(|e| AppError::internal(e.to_string()))?,
            mtime,
            PROBE_VERSION
        )
        .execute(&st.db)
        .await?;
        c.updated += 1;
        touched.push((r.id, episode_id));
        if !unchanged {
            let st = st.clone();
            let id = r.id as u32;
            tokio::spawn(async move { st.engine.invalidate(id).await });
        }
        if !unchanged || r.mtime_ms.is_some_and(|m| Some(m) != mtime) {
            crate::stream::spawn_scan(st, r.id, abs.clone(), Some(p.info.clone()));
        }
    }
    items::attach(&st.db, media_id, &links).await?;
    set_ends(&st.db, &ends).await?;
    items::cover_ranges(&mut *st.db.acquire().await?, media_id).await?;
    Ok(())
}

async fn add_new(
    st: &AppState,
    media: &MediaRow,
    disk: &[(String, PathBuf)],
    linked: &HashSet<String>,
    slots: &Slots,
    c: &mut Counts,
    touched: &mut Vec<(i32, Option<i32>)>,
) -> Result<(), AppError> {
    let media_id = media.id;
    let Some(folder_id) = media.folder.as_ref().map(|f| f.id) else {
        return Ok(());
    };
    let mut fresh: Vec<NewRow> = vec![];
    for (rel, abs) in disk.iter().filter(|(r, _)| !linked.contains(r)) {
        let Ok(meta) = tokio::fs::metadata(abs).await else {
            continue;
        };
        let name = file_name(abs);
        let mut episode_id = None;
        let mut last = None;
        if media.has_seasons() {
            match parse_episode_numbers(&name, Some(&abs.to_string_lossy())) {
                Some(n) => {
                    episode_id = slots.episode(n);
                    last = n.episode_end.map(|e| e as i32);
                }
                None => match slots.special(&name) {
                    Some(ep) => episode_id = Some(ep.id),
                    None => {
                        tracing::warn!(
                            "Rescan[media #{media_id}]: \"{name}\" has no SxxEyy pattern (skipped, alien file in series folder)"
                        );
                        continue;
                    }
                },
            }
        }
        let Ok(p) = probe(st, abs, true)
            .await
            .inspect_err(|e| tracing::error!("Rescan[media #{media_id}] new file \"{rel}\": {e}"))
        else {
            continue;
        };
        let quality = p
            .quality(&name)
            .unwrap_or_else(|| quality_from_resolution(&name, None, None));
        fresh.push(NewRow {
            rel: rel.clone(),
            episode_id,
            last,
            size: meta.len() as i64,
            quality,
            info: serde_json::to_value(&p.info).map_err(|e| AppError::internal(e.to_string()))?,
            mtime: mtime_ms(&meta),
        });
    }
    if fresh.is_empty() {
        return Ok(());
    }
    let by_rel: HashMap<&str, (Option<i32>, Option<i32>)> = fresh
        .iter()
        .map(|n| (n.rel.as_str(), (n.episode_id, n.last)))
        .collect();
    let inserted = match insert_rows(&st.db, media_id, folder_id, &fresh).await {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!(
                "Rescan[media #{media_id}]: batch insert of {} files failed, retrying one by one: {e}",
                fresh.len()
            );
            let mut rows = vec![];
            for n in &fresh {
                match insert_rows(&st.db, media_id, folder_id, std::slice::from_ref(n)).await {
                    Ok(r) => rows.extend(r),
                    Err(e) => tracing::error!(
                        "Rescan[media #{media_id}]: failed to add \"{}\": {e}",
                        n.rel
                    ),
                }
            }
            rows
        }
    };
    let mut links = vec![];
    for (id, rel) in inserted {
        let (ep, last) = by_rel.get(rel.as_str()).copied().unwrap_or_default();
        touched.push((id, ep));
        c.added += 1;
        links.push(Link {
            file: id,
            owner: ep,
            last,
        });
    }
    items::attach(&st.db, media_id, &links).await?;
    Ok(())
}

async fn insert_rows(
    db: &sqlx::PgPool,
    media_id: i32,
    folder_id: i32,
    fresh: &[NewRow],
) -> Result<Vec<(i32, String)>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality, "streamInfo",
             "mtimeMs", "probeVersion")
           SELECT $1, $8, v.rel, v.size, v.quality, v.info, v.mtime, $7
           FROM UNNEST($2::text[], $3::bigint[], $4::text[], $5::jsonb[], $6::bigint[])
             AS v(rel, size, quality, info, mtime)
           ON CONFLICT ("folderId", "relativePath") DO NOTHING
           RETURNING id, "relativePath" AS rel"#,
        media_id,
        &fresh.iter().map(|n| n.rel.clone()).collect::<Vec<_>>(),
        &fresh.iter().map(|n| n.size).collect::<Vec<_>>(),
        &fresh.iter().map(|n| n.quality.clone()).collect::<Vec<_>>(),
        &fresh.iter().map(|n| n.info.clone()).collect::<Vec<_>>(),
        &fresh.iter().map(|n| n.mtime).collect::<Vec<_>>() as &[Option<i64>],
        PROBE_VERSION,
        folder_id
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.id, r.rel)).collect())
}

struct NewRow {
    rel: String,
    episode_id: Option<i32>,
    last: Option<i32>,
    size: i64,
    quality: String,
    info: serde_json::Value,
    mtime: Option<i64>,
}

/// The media's seasons and episodes, loaded once so a rescan resolves every file in memory.
#[derive(Default)]
struct Slots {
    seasons: HashMap<i32, i32>,
    episodes: HashMap<(i32, i32), (i32, Option<i32>)>,
    specials: Vec<Ep>,
}

impl Slots {
    async fn load(db: &sqlx::PgPool, media: i32) -> Result<Self, sqlx::Error> {
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
        db: &sqlx::PgPool,
        media: i32,
        wanted: &[EpisodeNumbers],
    ) -> Result<bool, sqlx::Error> {
        let seasons: BTreeSet<i32> = wanted
            .iter()
            .map(|n| n.season as i32)
            .filter(|s| !self.seasons.contains_key(s))
            .collect();
        let mut created = !seasons.is_empty();
        if created {
            let nums: Vec<i32> = seasons.into_iter().collect();
            let rows = sqlx::query!(
                r#"INSERT INTO item_groups ("mediaId", "number", monitored)
                   SELECT $1, n, n > 0 FROM UNNEST($2::int[]) AS n RETURNING id, "number" AS n"#,
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
            created = true;
            let by_id: HashMap<i32, i32> = self.seasons.iter().map(|(n, id)| (*id, *n)).collect();
            let sids: Vec<i32> = fresh.keys().map(|k| self.seasons[&k.0]).collect();
            let nums: Vec<i32> = fresh.keys().map(|k| k.1).collect();
            let es: Vec<Option<i32>> = fresh.values().copied().collect();
            let edition = items::video_edition(db, media).await?;
            let rows = sqlx::query!(
                r#"INSERT INTO items ("groupId", "mediaId", "editionId", "number", "endNumber", monitored)
                   SELECT v.s, $4, $5, v.n, v.e, true
                   FROM UNNEST($1::int[], $2::int[], $3::int[]) AS v(s, n, e)
                   RETURNING id, "groupId" AS "season_id!", "number" AS "n!""#,
                &sids,
                &nums,
                &es as &[Option<i32>],
                media,
                edition
            )
            .fetch_all(db)
            .await?;
            for r in rows {
                let end = fresh.get(&(by_id[&r.season_id], r.n)).copied().flatten();
                self.episodes
                    .insert((by_id[&r.season_id], r.n), (r.id, end));
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

/// Embedded detection probes again, so it runs only for files this pass added, re-probed or relinked.
async fn reconcile_subtitles(
    st: &AppState,
    media_id: i32,
    c: &mut Counts,
    touched: &[(i32, Option<i32>)],
    walk_complete: bool,
) {
    if walk_complete {
        let (missing, dupes) =
            crate::subtitles::sidecars::reconcile_after_rescan(st, media_id).await;
        c.subtitle_removed_missing = missing as i64;
        c.subtitle_removed_duplicates = dupes as i64;
        crate::subtitles::sidecars::discover_external(st, media_id).await;
    }
    for &(file, episode) in touched {
        crate::subtitles::embedded::detect_and_store(st, media_id, file, episode).await;
    }
}

fn mtime_ms(m: &fs::Metadata) -> Option<i64> {
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

/// Season 0 episode whose title the file name contains.
pub async fn match_special(
    db: &sqlx::PgPool,
    media: i32,
    file_name: &str,
) -> Result<Option<Ep>, sqlx::Error> {
    let specials = season_episodes(db, media, 0).await?;
    Ok(match_special_by_title(file_name, &specials).map(|i| specials[i].clone()))
}

/// Rule 45: `(episode id, created)`; a missing season or episode is created.
pub async fn ensure_season_and_episode(
    db: &sqlx::PgPool,
    media: i32,
    n: EpisodeNumbers,
) -> Result<(i32, bool), sqlx::Error> {
    let (season, episode, end) = (
        n.season as i32,
        n.episode as i32,
        n.episode_end.map(|e| e as i32),
    );
    let mut created = false;
    let sid = match sqlx::query_scalar!(
        r#"SELECT id FROM item_groups WHERE "mediaId" = $1 AND "number" = $2 ORDER BY id LIMIT 1"#,
        media,
        season
    )
    .fetch_optional(db)
    .await?
    {
        Some(id) => id,
        None => {
            created = true;
            sqlx::query_scalar!(
                r#"INSERT INTO item_groups ("mediaId", "number", monitored) VALUES ($1, $2, $3) RETURNING id"#,
                media,
                season,
                season > 0
            )
            .fetch_one(db)
            .await?
        }
    };
    let ep = sqlx::query!(
        r#"SELECT id, "endNumber" AS end FROM items WHERE "groupId" = $1 AND "number" = $2
           ORDER BY id LIMIT 1"#,
        sid,
        episode
    )
    .fetch_optional(db)
    .await?;
    let id = match ep {
        Some(e) => {
            if end.is_some() && e.end != end {
                sqlx::query!(
                    r#"UPDATE items SET "endNumber" = $2 WHERE id = $1"#,
                    e.id,
                    end
                )
                .execute(db)
                .await?;
            }
            e.id
        }
        None => {
            created = true;
            let edition = items::video_edition(db, media).await?;
            sqlx::query_scalar!(
                r#"INSERT INTO items ("groupId", "mediaId", "editionId", "number", "endNumber", monitored)
                   VALUES ($1, $2, $3, $4, $5, true) RETURNING id"#,
                sid,
                media,
                edition,
                episode,
                end
            )
            .fetch_one(db)
            .await?
        }
    };
    items::cover_ranges(&mut *db.acquire().await?, media).await?;
    Ok((id, created))
}

/// `enrichMediaFileFromDisk` (rule 49): probe, row update, queue.
pub async fn enrich_from_disk(st: &AppState, file_id: i32) -> Result<(), AppError> {
    let Some((abs, old)) = super::post_import::file_path(st, file_id).await? else {
        tracing::warn!("enrich: file #{file_id} has no contained path");
        return Ok(());
    };
    let Ok(meta) = tokio::fs::metadata(&abs).await else {
        tracing::warn!(
            "enrich: file #{file_id} missing on disk \"{}\"",
            abs.display()
        );
        return Ok(());
    };
    // `probeAndResolve` failing leaves the provisional row as it is.
    let mut p = match probe(st, &abs, false).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("enrich: probe of file #{file_id} failed: {e}");
            return Ok(());
        }
    };
    if let Some(t) = old.and_then(|o| o.timestamp_break_seconds) {
        p.info.timestamp_break_seconds = Some(t);
    }
    let quality = p.quality(&file_name(&abs));
    sqlx::query!(
        r#"UPDATE media_files SET size = $2, quality = COALESCE($3, quality), "streamInfo" = $4 WHERE id = $1"#,
        file_id,
        meta.len() as i64,
        quality,
        serde_json::to_value(&p.info).map_err(|e| AppError::internal(e.to_string()))?
    )
    .execute(&st.db)
    .await?;
    st.ingest.queue.enqueue(st, file_id);
    let m = sqlx::query!(
        r#"SELECT m.id FROM media_files f JOIN media m ON m.id = f."mediaId" WHERE f.id = $1"#,
        file_id
    )
    .fetch_one(&st.db)
    .await?;
    if load_media(&st.db, m.id).await?.is_some() {
        crate::media_servers::dispatch_detached(st, "library.rescan");
    }
    Ok(())
}

pub struct Linked {
    pub file_id: i32,
    pub created: bool,
}

/// `linkExistingFileInPlace` (rules 52-53); the caller holds the media's lock.
pub async fn link_in_place(
    st: &AppState,
    _guard: &OwnedMutexGuard<()>,
    media: &MediaRow,
    abs: &Path,
    nums: Option<EpisodeNumbers>,
) -> Result<Result<Linked, String>, AppError> {
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
            && let Ok(dir) = root.media_dir(media.folder_name.as_deref())
        {
            roots.push((folder, root, dir));
        }
    }
    if roots.is_empty() {
        return outside();
    }
    let Ok((real, meta)) = fsx::regular_source(abs) else {
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
    if !is_video(&file_name(&real)) {
        return Ok(Err("not a video file".into()));
    }
    if named.is_none() && inner.contains('/') {
        return Ok(Err(
            "a title with no folder can only own files at the library root".into(),
        ));
    }
    if let Some(held) = sqlx::query!(
        r#"SELECT id, "mediaId" AS media_id FROM media_files WHERE "folderId" = $1 AND "relativePath" = $2"#,
        folder.id,
        rel
    )
    .fetch_optional(&st.db)
    .await?
    {
        if held.media_id != Some(media.id) {
            return Ok(Err("file already linked to another media".into()));
        }
        return Ok(Ok(Linked {
            file_id: held.id,
            created: false,
        }));
    }
    let name = file_name(&real);
    let mut episode_id = None;
    let mut last = None;
    let mut created = false;
    if media.has_seasons() {
        match nums.or_else(|| parse_episode_numbers(&name, Some(&real.to_string_lossy()))) {
            None => match match_special(&st.db, media.id, &name).await? {
                Some(ep) => episode_id = Some(ep.id),
                None => return Ok(Err("no SxxEyy pattern found".into())),
            },
            Some(n) => {
                let (ep, c) = ensure_season_and_episode(&st.db, media.id, n).await?;
                episode_id = Some(ep);
                last = n.episode_end.map(|e| e as i32);
                created = c;
            }
        }
    }
    let id = sqlx::query_scalar!(
        r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality)
           VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
        media.id,
        folder.id,
        rel,
        meta.len() as i64,
        parse_release_quality(&name).quality.name
    )
    .fetch_one(&st.db)
    .await?;
    let link = Link {
        file: id,
        owner: episode_id,
        last,
    };
    items::attach(&st.db, media.id, &[link]).await?;
    enrich_from_disk(st, id).await?;
    Ok(Ok(Linked {
        file_id: id,
        created,
    }))
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

/// `analyzeMedia` (rule 51); runs detached, errors logged by the caller.
pub async fn analyze(st: &AppState, media_id: i32, o: Analyze) -> Result<(), AppError> {
    if !(o.sprites || o.crop || o.subtitle_cache) {
        return Ok(());
    }
    let ids = sqlx::query_scalar!(
        r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        media_id
    )
    .fetch_all(&st.db)
    .await?;
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
        if o.crop
            && let Some(mut info) = info.clone()
            && !info.video.is_empty()
        {
            match probe(st, &abs, true).await {
                Ok(p) => {
                    info.video[0].crop = p.info.video.first().and_then(|v| v.crop.clone());
                    sqlx::query!(
                        r#"UPDATE media_files SET "streamInfo" = $2 WHERE id = $1"#,
                        id,
                        serde_json::to_value(&info)
                            .map_err(|e| AppError::internal(e.to_string()))?
                    )
                    .execute(&st.db)
                    .await?;
                }
                Err(e) => {
                    tracing::warn!("analyzeMedia[#{media_id}]: crop of file #{id} failed: {e}")
                }
            }
        }
        if o.subtitle_cache
            && let Some(info) = info.filter(|i| i.subtitles.iter().any(|s| !s.is_image_based))
        {
            let st = st.clone();
            let req = JobRequest {
                kind: JobKind::SubtitleExtract { info },
                media: MediaRef {
                    media_file_id: id as u32,
                    path: abs.to_string_lossy().into_owned(),
                },
                priority: Some(JobPriority::High),
                force: true,
            };
            tokio::spawn(async move {
                if let Err(e) = st.engine.run_job(&req, None).await {
                    tracing::warn!("Subtitle cache of file #{id} failed: {e}");
                }
            });
        }
        if o.sprites {
            let st = st.clone();
            tokio::spawn(async move {
                if let Err(e) = crate::stream::sprite_file(&st, id, true, JobPriority::High).await {
                    tracing::warn!("Sprite failed for file #{id}: {e:?}");
                }
            });
        }
    }
    Ok(())
}

//! `MediaRescanService` (`ingest.md` rules 38-54): disk walk, row reconcile, analyze, link in place.
use super::{
    MediaRow, clear_has_file, drop_thumbnails, fsx, is_video,
    library::{Ep, file_name, season_episodes, set_has_file},
    load_media, probe,
};
use crate::{http::AppError, state::AppState};
use fliks_domain::{
    media::bonus::{is_bonus_dir, is_sample_file},
    naming::{EpisodeNumbers, match_special_by_title, parse_episode_numbers},
    release::parsing::{
        quality::parse_release_quality, quality_from_resolution::quality_from_resolution,
    },
};
use fliks_engine_core::api::{JobKind, JobPriority, JobRequest, MediaInfo, MediaRef};
use serde::Deserialize;
use std::{
    collections::HashSet,
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

struct Row {
    id: i32,
    rel: String,
    size: i64,
    episode_id: Option<i32>,
    info: Option<serde_json::Value>,
}

/// `media.path` with C51: the library root and the media folder must exist (never created here).
fn media_dir(media: &MediaRow) -> Result<(fsx::Root, PathBuf), AppError> {
    let lib = media
        .library_path
        .as_deref()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| {
            AppError::bad_request(format!("Media #{} has no root path configured", media.id))
        })?;
    let missing = |d: &str| AppError::bad_request(format!("Media folder not found: {d}"));
    let root = fsx::Root::open(lib).map_err(|_| missing(lib))?;
    let dir = root
        .media_dir(media.folder_name.as_deref())
        .map_err(AppError::bad_request)?;
    let real = fs::canonicalize(&dir).map_err(|_| missing(&dir.to_string_lossy()))?;
    if !real.is_dir() || !real.starts_with(root.path()) {
        return Err(missing(&dir.to_string_lossy()));
    }
    Ok((root, dir))
}

struct Walk {
    files: Vec<PathBuf>,
    complete: bool,
}

/// Rule 40: depth 3, links never followed into, only regular video files (C55).
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

/// `rescanFiles` (rules 38-48); the caller holds the media's lock.
pub async fn rescan_files(
    st: &AppState,
    _guard: &OwnedMutexGuard<()>,
    media_id: i32,
) -> Result<Counts, AppError> {
    let media = load_media(&st.db, media_id)
        .await?
        .ok_or_else(|| crate::libraries::media_not_found(media_id))?;
    if media.library_path.as_deref().is_none_or(str::is_empty) {
        return Err(AppError::bad_request(format!(
            "Media #{media_id} has no root path configured"
        )));
    }
    let rows = sqlx::query_as!(
        Row,
        r#"SELECT id, "relativePath" AS rel, size, "episodeId" AS episode_id, "streamInfo" AS info
           FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
        media_id
    )
    .fetch_all(&st.db)
    .await?;
    let (_, dir) = match media_dir(&media) {
        Ok(d) => d,
        Err(_) if rows.is_empty() => return Ok(Counts::default()),
        Err(e) => return Err(e),
    };
    tracing::info!(
        "Rescan: started media #{media_id} \"{}\" root=\"{}\"",
        media.title,
        dir.display()
    );
    let norm = |r: &str| r.replace('\\', "/");
    let linked: HashSet<String> = rows.iter().map(|r| norm(&r.rel)).collect();
    let mut w = Walk {
        files: vec![],
        complete: true,
    };
    if media.folder_name.as_deref().is_some_and(|f| !f.is_empty()) {
        let (d, l) = (dir.clone(), linked.clone());
        w = tokio::task::spawn_blocking(move || {
            let mut w = Walk {
                files: vec![],
                complete: true,
            };
            walk(&d, &d, 0, &l, false, &mut w);
            w
        })
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    } else {
        for r in &rows {
            if let Some(rel) = fsx::safe_rel(&r.rel) {
                let p = dir.join(rel);
                if fs::metadata(&p).is_ok_and(|m| m.is_file()) {
                    w.files.push(p);
                }
            }
        }
    }
    let disk: Vec<(String, PathBuf)> = w
        .files
        .into_iter()
        .filter_map(|p| Some((fsx::rel_under(&dir, &p)?, p)))
        .collect();
    let on_disk: HashSet<&str> = disk.iter().map(|(r, _)| r.as_str()).collect();
    let mut c = Counts::default();
    let mut slots_created = false;

    if w.complete {
        for r in rows
            .iter()
            .filter(|r| !on_disk.contains(norm(&r.rel).as_str()))
        {
            if r.rel.contains("..") {
                tracing::error!(
                    "Rescan[media #{media_id}]: row with \"..\" in relativePath \"{}\"",
                    r.rel
                );
            }
            match sqlx::query!("DELETE FROM media_files WHERE id = $1", r.id)
                .execute(&st.db)
                .await
            {
                Ok(_) => {
                    drop_thumbnails(st, r.id);
                    c.removed += 1;
                    if let Some(ep) = r.episode_id {
                        clear_has_file(&st.db, ep).await?;
                    }
                }
                Err(e) => tracing::error!(
                    "Rescan[media #{media_id}]: failed to remove row #{}: {e}",
                    r.id
                ),
            }
        }
    } else {
        tracing::warn!("Rescan[media #{media_id}]: a directory could not be read, no row removed");
    }

    for r in rows
        .iter()
        .filter(|r| on_disk.contains(norm(&r.rel).as_str()))
    {
        let abs = dir.join(norm(&r.rel));
        let Ok(meta) = fs::metadata(&abs) else {
            continue;
        };
        let disk_size = meta.len() as i64;
        let name = file_name(&abs);
        if media.is_series() {
            let nums = parse_episode_numbers(&name, Some(&abs.to_string_lossy()));
            match (nums, r.episode_id) {
                (Some(n), None) => {
                    let (ep, created) = ensure_season_and_episode(&st.db, media_id, n).await?;
                    slots_created |= created;
                    link_row(st, r.id, ep).await?;
                    c.updated += 1;
                }
                (None, None) => {
                    if let Some(ep) = match_special(&st.db, media_id, &name).await? {
                        link_row(st, r.id, ep.id).await?;
                        c.updated += 1;
                    }
                }
                (Some(n), Some(ep)) if n.episode_end.is_some() => {
                    sqlx::query!(
                        r#"UPDATE episodes SET "endEpisodeNumber" = $2 WHERE id = $1 AND "endEpisodeNumber" IS DISTINCT FROM $2"#,
                        ep,
                        n.episode_end.map(|e| e as i32)
                    )
                    .execute(&st.db)
                    .await?;
                }
                _ => {}
            }
        }
        let unchanged = r.size == disk_size;
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
            r#"UPDATE media_files SET size = $2, quality = COALESCE($3, quality), "streamInfo" = $4 WHERE id = $1"#,
            r.id,
            disk_size,
            quality,
            serde_json::to_value(&p.info).map_err(|e| AppError::internal(e.to_string()))?
        )
        .execute(&st.db)
        .await?;
        c.updated += 1;
        if !unchanged {
            let st = st.clone();
            let id = r.id as u32;
            tokio::spawn(async move { st.engine.invalidate(id).await });
        }
    }

    for (rel, abs) in disk.iter().filter(|(r, _)| !linked.contains(r)) {
        let Ok(meta) = fs::metadata(abs) else {
            continue;
        };
        let name = file_name(abs);
        let mut episode_id = None;
        if media.is_series() {
            match parse_episode_numbers(&name, Some(&abs.to_string_lossy())) {
                Some(n) => {
                    let (ep, created) = ensure_season_and_episode(&st.db, media_id, n).await?;
                    slots_created |= created;
                    episode_id = Some(ep);
                }
                None => match match_special(&st.db, media_id, &name).await? {
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
        let inserted = sqlx::query!(
            r#"INSERT INTO media_files ("mediaId", "episodeId", "relativePath", size, quality, "streamInfo")
               VALUES ($1, $2, $3, $4, $5, $6)"#,
            media_id,
            episode_id,
            rel,
            meta.len() as i64,
            quality,
            serde_json::to_value(&p.info).map_err(|e| AppError::internal(e.to_string()))?
        )
        .execute(&st.db)
        .await;
        match inserted {
            Ok(_) => {
                c.added += 1;
                if let Some(ep) = episode_id {
                    set_has_file(&st.db, ep).await?;
                }
            }
            Err(e) => tracing::error!("Rescan[media #{media_id}]: failed to add \"{rel}\": {e}"),
        }
    }

    let (missing, dupes) = crate::subtitles::sidecars::reconcile_after_rescan(st, media_id).await;
    c.subtitle_removed_missing = missing as i64;
    c.subtitle_removed_duplicates = dupes as i64;
    crate::subtitles::sidecars::discover_external(st, media_id).await;
    for (file, episode) in sqlx::query_as::<_, (i32, Option<i32>)>(
        r#"SELECT id, "episodeId" FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
    )
    .bind(media_id)
    .fetch_all(&st.db)
    .await
    .unwrap_or_default()
    {
        crate::subtitles::embedded::detect_and_store(st, media_id, file, episode).await;
    }
    tracing::info!(
        "Rescan: media #{media_id} done (added {}, removed {}, updated {})",
        c.added,
        c.removed,
        c.updated
    );
    if c.added + c.removed + c.updated > 0 {
        crate::media_servers::dispatch_detached(st, "library.rescan");
    }
    if slots_created && let Err(e) = crate::media::write::refresh_series_episodes(st, &media).await
    {
        tracing::warn!("Rescan[media #{media_id}]: episode metadata refresh failed: {e:?}");
    }
    Ok(c)
}

async fn link_row(st: &AppState, file: i32, ep: i32) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE media_files SET "episodeId" = $2 WHERE id = $1"#,
        file,
        ep
    )
    .execute(&st.db)
    .await?;
    set_has_file(&st.db, ep).await
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
        r#"SELECT id FROM seasons WHERE "mediaId" = $1 AND "seasonNumber" = $2 ORDER BY id LIMIT 1"#,
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
                r#"INSERT INTO seasons ("mediaId", "seasonNumber", monitored) VALUES ($1, $2, $3) RETURNING id"#,
                media,
                season,
                season > 0
            )
            .fetch_one(db)
            .await?
        }
    };
    let ep = sqlx::query!(
        r#"SELECT id, "endEpisodeNumber" AS end FROM episodes WHERE "seasonId" = $1 AND "episodeNumber" = $2
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
                    r#"UPDATE episodes SET "endEpisodeNumber" = $2 WHERE id = $1"#,
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
            sqlx::query_scalar!(
                r#"INSERT INTO episodes ("seasonId", "episodeNumber", "endEpisodeNumber", monitored)
                   VALUES ($1, $2, $3, true) RETURNING id"#,
                sid,
                episode,
                end
            )
            .fetch_one(db)
            .await?
        }
    };
    Ok((id, created))
}

/// `enrichMediaFileFromDisk` (rule 49): probe, row update, queue.
pub async fn enrich_from_disk(st: &AppState, file_id: i32) -> Result<(), AppError> {
    let Some((abs, old)) = super::post_import::file_path(st, file_id).await? else {
        tracing::warn!("enrich: file #{file_id} has no contained path");
        return Ok(());
    };
    let Ok(meta) = fs::metadata(&abs) else {
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

/// `linkExistingFileInPlace` (rules 52-53, F47); the caller holds the media's lock.
pub async fn link_in_place(
    st: &AppState,
    _guard: &OwnedMutexGuard<()>,
    media: &MediaRow,
    abs: &Path,
    nums: Option<EpisodeNumbers>,
) -> Result<Result<Linked, String>, AppError> {
    let outside = || Ok(Err("file outside the media folder".to_owned()));
    let Some(lib) = media.library_path.as_deref() else {
        return outside();
    };
    let Ok(root) = fsx::Root::open(lib) else {
        return outside();
    };
    let Ok(dir) = root.media_dir(media.folder_name.as_deref()) else {
        return outside();
    };
    let Ok((real, meta)) = fsx::regular_source(abs) else {
        return Ok(Err("not a regular file".into()));
    };
    let real_dir = fs::canonicalize(&dir).unwrap_or(dir.clone());
    let Some(rel) = fsx::rel_under(&real_dir, &real).filter(|_| root.contains(&real, false)) else {
        return outside();
    };
    if !is_video(&file_name(&real)) {
        return Ok(Err("not a video file".into()));
    }
    if media.folder_name.as_deref().is_none_or(str::is_empty) && rel.contains('/') {
        return Ok(Err(
            "a title with no folder can only own files at the library root".into(),
        ));
    }
    if let Some(id) = sqlx::query_scalar!(
        r#"SELECT id FROM media_files WHERE "mediaId" = $1 AND "relativePath" = $2"#,
        media.id,
        rel
    )
    .fetch_optional(&st.db)
    .await?
    {
        return Ok(Ok(Linked {
            file_id: id,
            created: false,
        }));
    }
    let name = file_name(&real);
    let mut episode_id = None;
    let mut created = false;
    if media.is_series() {
        match nums.or_else(|| parse_episode_numbers(&name, Some(&real.to_string_lossy()))) {
            None => match match_special(&st.db, media.id, &name).await? {
                Some(ep) => episode_id = Some(ep.id),
                None => return Ok(Err("no SxxEyy pattern found".into())),
            },
            Some(n) => {
                let (ep, c) = ensure_season_and_episode(&st.db, media.id, n).await?;
                episode_id = Some(ep);
                created = c;
            }
        }
    }
    let id = sqlx::query_scalar!(
        r#"INSERT INTO media_files ("mediaId", "episodeId", "relativePath", size, quality)
           VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
        media.id,
        episode_id,
        rel,
        meta.len() as i64,
        parse_release_quality(&name).quality.name
    )
    .fetch_one(&st.db)
    .await?;
    enrich_from_disk(st, id).await?;
    if let Some(ep) = episode_id {
        set_has_file(&st.db, ep).await?;
    }
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
        if !abs.exists() {
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

//! `LibraryIngestService.ingest` (`ingest.md` rules 17-33): files into a media's folder, never
//! replacing what is there unless asked, then the rows, the event and the post-import queue.
use super::{
    MediaRow, Probed, fsx, load_media, naming_formats, probe,
    transfer::{self, Method},
};
use crate::{
    events::{DomainEvent, event::ImportSource},
    state::AppState,
};
use fliks_domain::{
    media::VIDEO_EXTS,
    naming::{
        self, EpisodeNumbers, HasTitle, MovieFile, SeriesFile, extract_release_group,
        match_special_by_title, parse_episode_numbers,
    },
};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};
use tokio::sync::OwnedMutexGuard;

pub struct File {
    pub path: PathBuf,
    pub episode_id: Option<i32>,
}

pub struct Request {
    pub media_id: i32,
    pub files: Vec<File>,
    pub transfer: Method,
    pub fallback_quality: Option<String>,
    pub release_name: Option<String>,
    pub force: bool,
    pub uniquify_on_collision: bool,
    pub replace_existing: bool,
}

#[derive(Debug, Clone)]
pub struct Imported {
    pub file_id: i32,
    pub relative_path: String,
    pub quality: String,
    pub episode_id: Option<i32>,
    pub season_number: Option<i32>,
    pub episode_number: Option<i32>,
    pub episode_end: Option<i32>,
    pub source_path: PathBuf,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub imported: Vec<Imported>,
    pub already_present: Vec<String>,
    pub errors: Vec<String>,
}

/// An episode row with its season, as rule 20 reads it.
#[derive(Debug, Clone)]
pub struct Ep {
    pub id: i32,
    pub season_number: i32,
    pub episode_number: i32,
    pub end: Option<i32>,
    pub title: Option<String>,
    pub air_date: Option<String>,
}

impl HasTitle for Ep {
    fn title(&self) -> Option<&str> {
        self.title.as_deref()
    }
}

pub fn file_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn stem_of(p: &Path) -> String {
    transfer::split_ext(&file_name(p)).0.to_owned()
}

/// The caller holds the media's lock (`guard`).
pub async fn ingest(
    st: &AppState,
    _guard: &OwnedMutexGuard<()>,
    mut req: Request,
) -> Result<Outcome, String> {
    let media = load_media(&st.db, req.media_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media #{} not found", req.media_id))?;
    let lib = media
        .library_path
        .clone()
        .filter(|p| !p.is_empty())
        .ok_or_else(|| format!("Media #{} is not anchored to a library folder", media.id))?;
    if media.folder_name.as_deref().is_none_or(str::is_empty) {
        return Err(format!(
            "Media #{} has no folder of its own, refusing to place files at the library root",
            media.id
        ));
    }
    let mut out = Outcome::default();
    if req.files.is_empty() {
        return Ok(out);
    }
    let root = fsx::Root::open(&lib).map_err(|e| format!("Library root \"{lib}\": {e}"))?;
    let mdir = root.media_dir(media.folder_name.as_deref())?;
    let formats = naming_formats(&st.db).await.map_err(|e| e.to_string())?;
    let allowed = transfer::companion_exts(&st.db)
        .await
        .map_err(|e| e.to_string())?;
    for f in select(&media, std::mem::take(&mut req.files)) {
        let ctx = Ctx {
            st,
            media: &media,
            root: &root,
            mdir: &mdir,
            formats: &formats,
            allowed: &allowed,
            req: &req,
        };
        match ctx.one(&f).await? {
            Placed::Imported(i) => out.imported.push(i),
            Placed::Present => out
                .already_present
                .push(f.path.to_string_lossy().into_owned()),
            Placed::Error(e) => out.errors.push(e),
        }
    }
    if out.imported.is_empty() {
        return Ok(out);
    }
    let carried = if req.replace_existing {
        remove_superseded(st, &media, &out.imported).await
    } else {
        vec![]
    };
    let one = (out.imported.len() == 1).then(|| &out.imported[0]);
    st.hub.emit_domain(DomainEvent::MediaFilesImported {
        media_id: i64::from(media.id),
        season_number: one.and_then(|i| i.season_number).map(i64::from),
        episode_number: one.and_then(|i| i.episode_number).map(i64::from),
        source: if req.release_name.is_some() {
            ImportSource::Download
        } else {
            ImportSource::Disk
        },
    });
    st.ingest.settle.schedule(st, media.id);
    for i in &out.imported {
        st.ingest.queue.enqueue(st, i.file_id);
    }
    if !carried.is_empty() {
        let st2 = st.clone();
        tokio::spawn(async move {
            for id in carried {
                let o = crate::subtitles::sync::Options {
                    automatic: true,
                    ..Default::default()
                };
                if let Err(e) = crate::subtitles::sync::do_sync(&st2, id, &o).await {
                    tracing::warn!("Auto-sync of carried subtitle #{id} failed: {e}");
                }
            }
        });
    }
    Ok(out)
}

/// Rule 19 (largest file by its real size; on a tie the later one) unless a series season pack.
fn select(media: &MediaRow, files: Vec<File>) -> Vec<File> {
    if media.is_series() && files.len() > 1 {
        return files;
    }
    let size = |f: &File| fs::metadata(&f.path).map_or(0, |m| m.len());
    let mut best: Option<(u64, File)> = None;
    for f in files {
        let s = size(&f);
        if best.as_ref().is_none_or(|(b, _)| s >= *b) {
            best = Some((s, f));
        }
    }
    best.map(|(_, f)| f).into_iter().collect()
}

enum Placed {
    Imported(Imported),
    Present,
    Error(String),
}

struct Ctx<'a> {
    st: &'a AppState,
    media: &'a MediaRow,
    root: &'a fsx::Root,
    mdir: &'a Path,
    formats: &'a naming::NamingFormats,
    allowed: &'a [String],
    req: &'a Request,
}

/// Rule 4: one component, at most 255 bytes, the base truncated at a character boundary.
pub fn file_component(base: &str, ext: &str) -> Result<String, String> {
    let ext_l = ext.to_lowercase();
    if !VIDEO_EXTS.contains(&ext_l.as_str()) {
        return Err(format!("not a video extension: \"{ext}\""));
    }
    let base = base.trim();
    let mut cut = 255usize.saturating_sub(ext.len()).min(base.len());
    while !base.is_char_boundary(cut) {
        cut -= 1;
    }
    let base = base[..cut].trim_end();
    if base.is_empty()
        || base == "."
        || base == ".."
        || base
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        return Err(format!("invalid file name \"{base}{ext}\""));
    }
    Ok(format!("{base}{ext}"))
}

impl Ctx<'_> {
    async fn one(&self, f: &File) -> Result<Placed, String> {
        let name = file_name(&f.path);
        let Ok((src, _)) = fsx::regular_source(&f.path) else {
            return Ok(Placed::Error(format!(
                "{name}: source is not a regular file"
            )));
        };
        let ep = if self.media.is_series() {
            self.episode(f).await?
        } else {
            None
        };
        let probed = probe(self.st, &src, false).await?;
        let release = self.req.release_name.as_deref();
        let quality = probed
            .quality(release.unwrap_or(&name))
            .unwrap_or_else(|| self.req.fallback_quality.clone().unwrap_or_default());
        let group = release.map(extract_release_group);
        let ext = transfer::split_ext(&name).1.to_owned();
        let (dir, base) = self.layout(ep.as_ref(), &quality, group);
        let dir = match dir {
            Ok(d) => d,
            Err(e) => return Ok(Placed::Error(format!("{name}: {e}"))),
        };
        let mut file = match file_component(&base, &ext) {
            Ok(n) => n,
            Err(e) => return Ok(Placed::Error(format!("{name}: {e}"))),
        };
        // Rule 13: a file already at its layout path is linked where it is.
        let at_dest = dunce::canonicalize(dir.join(&file)).is_ok_and(|d| d == src);
        let src_size = fs::metadata(&src).map_or(0, |m| m.len());
        if !at_dest {
            let same_size = |p: &Path| fs::metadata(p).is_ok_and(|m| m.len() == src_size);
            let overwrite =
                self.req.force || (self.req.replace_existing && !same_size(&dir.join(&file)));
            if !overwrite && self.collides(&dir, &file).await? {
                if !self.req.uniquify_on_collision {
                    return Ok(Placed::Present);
                }
                match self.free_name(&dir, &base, &ext).await? {
                    Some(n) => file = n,
                    None => return Ok(Placed::Error(format!("{name}: no free name up to (99)"))),
                }
            }
            let dest = dir.join(&file);
            if !self.root.contains(&dir, false) || !dir.starts_with(self.mdir) {
                return Ok(Placed::Error(format!(
                    "{name}: destination outside the library root"
                )));
            }
            if let Err(e) = fs::create_dir_all(&dir) {
                return Err(format!("{name}: {e}"));
            }
            tracing::info!("Ingesting \"{}\" -> \"{}\"", src.display(), dest.display());
            let method = self.req.transfer;
            let (s, d) = (src.clone(), dest.clone());
            let done = tokio::task::spawn_blocking(move || {
                transfer::transfer_file(&s, &d, method, overwrite)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("{name}: {e}"))?;
            if !done {
                return Ok(Placed::Present);
            }
            if overwrite || self.req.replace_existing {
                remove_stale_edl(&dest).await;
            }
            let src_dir = src.parent().map(Path::to_path_buf).unwrap_or_default();
            let (source_base, new_base) = (stem_of(&src), transfer::split_ext(&file).0.to_owned());
            let (allowed, dest_dir) = (self.allowed.to_vec(), dir.clone());
            let _ = tokio::task::spawn_blocking(move || {
                transfer::transfer_companions(&transfer::Companions {
                    src_dir: &src_dir,
                    dest_dir: &dest_dir,
                    source_base: &source_base,
                    new_base: &new_base,
                    method,
                    allowed: &allowed,
                })
            })
            .await;
        }
        let dest = dir.join(&file);
        let rel = fsx::rel_under(self.mdir, &dest).ok_or("computed dest outside media folder")?;
        let size = fs::metadata(&dest).map_or(src_size, |m| m.len()) as i64;
        let file_id = self.row(&rel, ep.as_ref(), size, &quality, &probed).await?;
        Ok(Placed::Imported(Imported {
            file_id,
            relative_path: rel,
            quality,
            episode_id: ep.as_ref().map(|e| e.0.id),
            season_number: ep.as_ref().map(|e| e.0.season_number),
            episode_number: ep.as_ref().map(|e| e.0.episode_number),
            episode_end: ep.as_ref().and_then(|e| e.1),
            source_path: f.path.clone(),
        }))
    }

    /// Rule 8: `(destDir, newBaseName)`; the season folder is one component or empty.
    fn layout(
        &self,
        ep: Option<&(Ep, Option<i32>)>,
        quality: &str,
        group: Option<String>,
    ) -> (Result<PathBuf, String>, String) {
        let m = self.media;
        if !m.is_series() {
            let base = naming::apply_movie_format(
                &self.formats.movie,
                &MovieFile {
                    title: m.title.clone(),
                    original_title: m.original_title.clone(),
                    year: m.year.map(i64::from),
                    quality: quality.to_owned(),
                    release_group: group,
                    tmdb_id: m.tmdb_id.map(i64::from),
                },
            );
            return (Ok(self.mdir.to_path_buf()), base);
        }
        let season = ep.map_or(1, |e| e.0.season_number);
        let base = naming::apply_series_format(
            &self.formats.series,
            &SeriesFile {
                series_title: m.title.clone(),
                season: i64::from(season),
                episode: i64::from(ep.map_or(1, |e| e.0.episode_number)),
                episode_title: ep.and_then(|e| e.0.title.clone()),
                quality: quality.to_owned(),
                release_group: group,
                air_date: ep.and_then(|e| e.0.air_date.clone()),
            },
        );
        let folder =
            naming::apply_season_folder_format(&self.formats.season_folder, i64::from(season));
        let dir = match folder.as_str() {
            "" => Ok(self.mdir.to_path_buf()),
            "." | ".." => Err(format!("invalid season folder \"{folder}\"")),
            f if f.chars().any(|c| c == '/' || c == '\\' || c.is_control()) => {
                Err(format!("invalid season folder \"{folder}\""))
            }
            f => Ok(self.mdir.join(f)),
        };
        (dir, base)
    }

    async fn collides(&self, dir: &Path, file: &str) -> Result<bool, String> {
        let dest = dir.join(file);
        if fs::symlink_metadata(&dest).is_ok() {
            return Ok(true);
        }
        let Some(rel) = fsx::rel_under(self.mdir, &dest) else {
            return Ok(false);
        };
        sqlx::query_scalar!(
            r#"SELECT 1 AS "x!" FROM media_files WHERE "mediaId" = $1 AND "relativePath" = $2 LIMIT 1"#,
            self.media.id,
            rel
        )
        .fetch_optional(&self.st.db)
        .await
        .map(|r| r.is_some())
        .map_err(|e| e.to_string())
    }

    /// `<base> (n)<ext>` for n in 2..=99; `None` when every one is taken.
    async fn free_name(&self, dir: &Path, base: &str, ext: &str) -> Result<Option<String>, String> {
        for n in 2..=99 {
            let Ok(name) = file_component(&format!("{base} ({n})"), ext) else {
                return Ok(None);
            };
            if !self.collides(dir, &name).await? {
                return Ok(Some(name));
            }
        }
        Ok(None)
    }

    /// Rule 20: `(episode, episodeEnd)`; ingest never creates seasons or episodes.
    async fn episode(&self, f: &File) -> Result<Option<(Ep, Option<i32>)>, String> {
        let db = &self.st.db;
        let name = file_name(&f.path);
        let base = transfer::split_ext(&name).0.to_owned();
        let nums = parse_episode_numbers(&base, Some(&f.path.to_string_lossy())).or_else(|| {
            self.req
                .release_name
                .as_deref()
                .and_then(|r| parse_episode_numbers(r, None))
        });
        if let Some(id) = f.episode_id {
            match episode_of_media(db, self.media.id, id)
                .await
                .map_err(|e| e.to_string())?
            {
                Some(e) => {
                    return Ok(Some((
                        e,
                        nums.and_then(|n| n.episode_end).map(|n| n as i32),
                    )));
                }
                None => tracing::warn!(
                    "episode #{id} is not an episode of media #{}",
                    self.media.id
                ),
            }
        }
        if let Some(n) = nums {
            let hit = find_episode(db, self.media.id, n.season as i32, n.episode as i32)
                .await
                .map_err(|e| e.to_string())?;
            let end = n.episode_end.map(|e| e as i32);
            if let Some(e) = &hit
                && end.is_some()
                && e.end != end
            {
                sqlx::query!(
                    r#"UPDATE episodes SET "endEpisodeNumber" = $2 WHERE id = $1"#,
                    e.id,
                    end
                )
                .execute(db)
                .await
                .map_err(|e| e.to_string())?;
            }
            return Ok(hit.map(|e| (e, end)));
        }
        let specials = season_episodes(db, self.media.id, 0)
            .await
            .map_err(|e| e.to_string())?;
        Ok(match_special_by_title(&base, &specials).map(|i| (specials[i].clone(), None)))
    }

    async fn row(
        &self,
        rel: &str,
        ep: Option<&(Ep, Option<i32>)>,
        size: i64,
        quality: &str,
        probed: &Probed,
    ) -> Result<i32, String> {
        let db = &self.st.db;
        let ep_id = ep.map(|e| e.0.id);
        let info = serde_json::to_value(&probed.info).map_err(|e| e.to_string())?;
        let id = sqlx::query_scalar!(
            r#"INSERT INTO media_files ("mediaId", "episodeId", "relativePath", size, quality, "streamInfo")
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT ("mediaId", "relativePath") DO UPDATE
               SET "episodeId" = EXCLUDED."episodeId", size = EXCLUDED.size, quality = EXCLUDED.quality,
                   "streamInfo" = EXCLUDED."streamInfo"
               RETURNING id"#,
            self.media.id,
            ep_id,
            rel,
            size,
            quality,
            info
        )
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
        if let Some(e) = ep_id {
            set_has_file(db, e).await.map_err(|e| e.to_string())?;
        }
        Ok(id)
    }
}

pub async fn set_has_file(db: &sqlx::PgPool, episode: i32) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE episodes SET "hasFile" = true WHERE id = $1"#,
        episode
    )
    .execute(db)
    .await
    .map(drop)
}

/// W6: the replaced video's old sidecar, so it is not applied to the new cut.
async fn remove_stale_edl(dest: &Path) {
    let edl = crate::stream::edl_sidecar(&dest.to_string_lossy()).await;
    if let Err(e) = tokio::fs::remove_file(&edl).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::warn!("could not remove stale EDL \"{edl}\": {e}");
    }
}

pub async fn episode_of_media(
    db: &sqlx::PgPool,
    media: i32,
    id: i32,
) -> Result<Option<Ep>, sqlx::Error> {
    sqlx::query_as!(
        Ep,
        r#"SELECT e.id, s."seasonNumber" AS season_number, e."episodeNumber" AS episode_number,
                  e."endEpisodeNumber" AS end, e.title, e."airDate"::text AS air_date
           FROM episodes e JOIN seasons s ON s.id = e."seasonId" WHERE e.id = $1 AND s."mediaId" = $2"#,
        id,
        media
    )
    .fetch_optional(db)
    .await
}

pub async fn find_episode(
    db: &sqlx::PgPool,
    media: i32,
    season: i32,
    episode: i32,
) -> Result<Option<Ep>, sqlx::Error> {
    sqlx::query_as!(
        Ep,
        r#"SELECT e.id, s."seasonNumber" AS season_number, e."episodeNumber" AS episode_number,
                  e."endEpisodeNumber" AS end, e.title, e."airDate"::text AS air_date
           FROM seasons s JOIN episodes e ON e."seasonId" = s.id
           WHERE s."mediaId" = $1 AND s."seasonNumber" = $2 AND e."episodeNumber" = $3
           ORDER BY s.id, e.id LIMIT 1"#,
        media,
        season,
        episode
    )
    .fetch_optional(db)
    .await
}

pub async fn season_episodes(
    db: &sqlx::PgPool,
    media: i32,
    season: i32,
) -> Result<Vec<Ep>, sqlx::Error> {
    sqlx::query_as!(
        Ep,
        r#"SELECT e.id, s."seasonNumber" AS season_number, e."episodeNumber" AS episode_number,
                  e."endEpisodeNumber" AS end, e.title, e."airDate"::text AS air_date
           FROM seasons s JOIN episodes e ON e."seasonId" = s.id
           WHERE s."mediaId" = $1 AND s."seasonNumber" = $2 ORDER BY e.id"#,
        media,
        season
    )
    .fetch_all(db)
    .await
}

struct Old {
    id: i32,
    relative_path: String,
    episode_id: Option<i32>,
    season_number: Option<i32>,
    episode_number: Option<i32>,
    end: Option<i32>,
}

/// Rules 29-31: the files the new ones replace; progress moves to the heir first.
async fn remove_superseded(st: &AppState, media: &MediaRow, imported: &[Imported]) -> Vec<i32> {
    let mut carried = vec![];
    let new_ids: Vec<i32> = imported.iter().map(|i| i.file_id).collect();
    let olds = sqlx::query_as!(
        Old,
        r#"SELECT mf.id, mf."relativePath" AS relative_path, mf."episodeId" AS episode_id,
                  s."seasonNumber" AS "season_number?", e."episodeNumber" AS "episode_number?",
                  e."endEpisodeNumber" AS end
           FROM media_files mf LEFT JOIN episodes e ON e.id = mf."episodeId"
           LEFT JOIN seasons s ON s.id = e."seasonId"
           WHERE mf."mediaId" = $1 AND mf.id <> ALL($2) ORDER BY mf.id"#,
        media.id,
        &new_ids
    )
    .fetch_all(&st.db)
    .await;
    let olds = match olds {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!("superseded lookup failed: {e}");
            return carried;
        }
    };
    let covered: HashSet<(i32, i32)> = imported
        .iter()
        .filter_map(|i| Some((i.season_number?, i.episode_number?, i.episode_end)))
        .flat_map(|(s, e, end)| (e..=end.unwrap_or(e).max(e)).map(move |n| (s, n)))
        .collect();
    for old in olds {
        let r: Result<(), String> = async {
            let heir = if media.is_series() {
                match (old.season_number, old.episode_number, old.end) {
                    (Some(s), Some(e), None) => imported
                        .iter()
                        .find(|i| i.season_number == Some(s) && i.episode_number == Some(e) && i.episode_end.is_none()),
                    _ => None,
                }
            } else {
                imported.first()
            };
            if media.is_series() {
                let (Some(s), Some(e)) = (old.season_number, old.episode_number) else {
                    return Ok(());
                };
                let span = e..=old.end.unwrap_or(e).max(e);
                if !span.clone().all(|n| covered.contains(&(s, n))) {
                    return Ok(());
                }
                for i in imported.iter().filter(|i| i.episode_id.is_some()) {
                    sqlx::query!(
                        r#"UPDATE playback_states SET "mediaFileId" = $1 WHERE "mediaFileId" = $2 AND "episodeId" = $3"#,
                        i.file_id,
                        old.id,
                        i.episode_id
                    )
                    .execute(&st.db)
                    .await
                    .map_err(|e| e.to_string())?;
                }
            } else {
                sqlx::query!(
                    r#"UPDATE playback_states SET "mediaFileId" = $1 WHERE "mediaFileId" = $2"#,
                    imported[0].file_id,
                    old.id
                )
                .execute(&st.db)
                .await
                .map_err(|e| e.to_string())?;
            }
            if let Some(h) = heir {
                carried.extend(crate::subtitles::sidecars::carry_over(st, media.id, old.id, h.file_id).await);
            }
            crate::media::write::delete_media_file(st, media, old.id, true)
                .await
                .map_err(|e| format!("{e:?}"))?;
            let ep_has_range = imported
                .iter()
                .any(|i| i.episode_id == old.episode_id && i.episode_end.is_some());
            if let (Some(ep), Some(_)) = (old.episode_id, old.end)
                && !ep_has_range
            {
                sqlx::query!(r#"UPDATE episodes SET "endEpisodeNumber" = NULL WHERE id = $1"#, ep)
                    .execute(&st.db)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        .await;
        if let Err(e) = r {
            tracing::warn!("could not remove superseded \"{}\": {e}", old.relative_path);
        }
    }
    carried
}

/// `epNums` from a caller's season and episode (both present).
pub fn caller_nums(
    season: Option<i32>,
    episode: Option<i32>,
    end: Option<i32>,
) -> Option<EpisodeNumbers> {
    Some(EpisodeNumbers {
        season: i64::from(season?),
        episode: i64::from(episode?),
        episode_end: end.map(i64::from),
    })
}

pub fn info_json(p: &Probed) -> Value {
    serde_json::to_value(&p.info).unwrap_or(Value::Null)
}

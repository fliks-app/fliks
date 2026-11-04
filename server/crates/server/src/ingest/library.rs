//! `LibraryIngestService.ingest` (`ingest.md` rules 17-33): files into a media's folder, never
//! replacing what is there unless asked, then the rows, the event and the post-import queue.
use super::{
    MediaRow, Probed, books, fsx, load_media, naming_formats, probe,
    transfer::{self, Method},
};
use crate::scene::Mapping;
use crate::{
    events::{DomainEvent, event::ImportSource},
    media::items::{self, Link},
    state::AppState,
};
use fliks_domain::release::parsing::season_episode::ParsedSeasonEpisode;
use fliks_domain::{
    media::{VIDEO_EXTS, family::Family, kind::MediaKind},
    naming::{
        self, BookNameTokens, EpisodeNumbers, HasTitle, MovieFile, SeriesFile,
        extract_release_group, match_special_by_title, parse_episode_numbers,
    },
};
use fliks_engine_core::api::{MediaInfo, SourceScan};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
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
    /// A book file's language: the new files join the edition of that language (`book-ingest.md` rule 7).
    pub language: Option<String>,
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
    /// Files refused for now (a series' scene mapping not known yet): the caller retries them.
    pub retry: Vec<String>,
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
    let _moves = st.folder_moves.read().await;
    let media = load_media(&st.db, req.media_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Media #{} not found", req.media_id))?;
    let folder = media
        .folder
        .clone()
        .filter(|f| !f.path.is_empty())
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
    let book = super::comics::registers(media.media_type);
    let root = fsx::Root::open(&folder.path)
        .map_err(|e| format!("Library root \"{}\": {e}", folder.path))?;
    let mdir = media.dir_in(&root)?;
    let formats = naming_formats(&st.db).await.map_err(|e| e.to_string())?;
    let allowed = transfer::companion_exts(&st.db)
        .await
        .map_err(|e| e.to_string())?;
    let chosen = select(&media, std::mem::take(&mut req.files)).await;
    let parts = if media.media_type == MediaKind::Book {
        book_parts(&chosen)
    } else {
        Default::default()
    };
    let mut placed: Vec<(books::Placed, PathBuf)> = vec![];
    for f in chosen {
        // A book's files go to the folder of their family (`book-ingest.md` rule 8).
        let target = if book {
            let family = if media.media_type == MediaKind::Comic {
                Some(Family::Image)
            } else {
                books::classify(&file_name(&f.path)).map(|c| c.0)
            };
            match family {
                Some(family) => {
                    books::folder_for(&st.db, media.id, family, req.language.as_deref())
                        .await
                        .map_err(|e| e.to_string())?
                }
                None => None,
            }
            .filter(|t| t.id != folder.id)
        } else {
            None
        };
        let other = match &target {
            Some(t) => {
                let r = fsx::Root::open(&t.path)
                    .map_err(|e| format!("Library root \"{}\": {e}", t.path))?;
                let d = media.dir_in(&r)?;
                Some((r, d, t.id))
            }
            None => None,
        };
        if req.transfer == Method::Move
            && let Ok((src, _)) = fsx::regular_source(&f.path)
            && let Some(o) = linked_to_other(&st.db, media.id, &src).await?
        {
            out.errors.push(format!(
                "{}: source is linked to media #{o}",
                file_name(&f.path)
            ));
            continue;
        }
        let ctx = Ctx {
            st,
            media: &media,
            root: other.as_ref().map_or(&root, |o| &o.0),
            folder_id: other.as_ref().map_or(folder.id, |o| o.2),
            mdir: other.as_ref().map_or(&mdir, |o| &o.1),
            formats: &formats,
            allowed: &allowed,
            req: &req,
            scene: Default::default(),
        };
        if book {
            let pending: Vec<String> = placed.iter().map(|(p, _)| p.rel.clone()).collect();
            match ctx
                .one_book(&f, parts.get(&f.path).copied(), &pending)
                .await?
            {
                Placed::Book(b) => placed.push((b, f.path.clone())),
                Placed::Present => out
                    .already_present
                    .push(f.path.to_string_lossy().into_owned()),
                Placed::Error(e) => out.errors.push(e),
                Placed::Retry(e) => out.retry.push(e),
                Placed::Imported(_) => {}
            }
            continue;
        }
        match ctx.one(&f).await? {
            Placed::Book(_) => {}
            Placed::Imported(i) => out.imported.push(i),
            Placed::Present => out
                .already_present
                .push(f.path.to_string_lossy().into_owned()),
            Placed::Error(e) => out.errors.push(e),
            Placed::Retry(e) => out.retry.push(e),
        }
    }
    let mut family = Family::Video;
    if !placed.is_empty() {
        let files: Vec<books::Placed> = placed
            .iter()
            .map(|(p, _)| books::Placed {
                folder_id: p.folder_id,
                rel: p.rel.clone(),
                abs: p.abs.clone(),
            })
            .collect();
        let reg = super::comics::register_files(
            st,
            media.media_type,
            media.id,
            &files,
            req.language.as_deref(),
        )
        .await?;
        out.errors.extend(reg.conflicts);
        for r in reg.files {
            let Some((_, source)) = placed.iter().find(|(p, _)| p.rel == r.rel) else {
                continue;
            };
            family = r.family;
            out.imported.push(Imported {
                file_id: r.file_id,
                relative_path: r.rel,
                quality: r.format,
                episode_id: None,
                season_number: None,
                episode_number: None,
                episode_end: None,
                source_path: source.clone(),
            });
        }
    }
    if out.imported.is_empty() {
        return Ok(out);
    }
    let carried = if req.replace_existing && !book {
        remove_superseded(st, &media, &out.imported).await
    } else {
        vec![]
    };
    let one = (out.imported.len() == 1).then(|| &out.imported[0]);
    st.hub.emit_domain(DomainEvent::MediaFilesImported {
        media_id: i64::from(media.id),
        family,
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
        st.ingest.queue.enqueue(st, i.file_id).await;
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
async fn select(media: &MediaRow, files: Vec<File>) -> Vec<File> {
    if (media.has_seasons() && files.len() > 1) || super::comics::registers(media.media_type) {
        return files;
    }
    let mut best: Option<(u64, File)> = None;
    for f in files {
        let s = tokio::fs::metadata(&f.path).await.map_or(0, |m| m.len());
        if best.as_ref().is_none_or(|(b, _)| s >= *b) {
            best = Some((s, f));
        }
    }
    best.map(|(_, f)| f).into_iter().collect()
}

/// How long an import waits for the scan that tells a truncated file from a complete one.
const TRUNCATION_SCAN_WAIT: Duration = Duration::from_secs(5 * 60);

/// The source's scan when the probe has a video stream and a declared duration to compare it with.
async fn scan_source(st: &AppState, src: &Path, info: &MediaInfo) -> Option<(SourceScan, String)> {
    if info.video.is_empty() || info.duration_seconds.is_none_or(|d| d <= 0.0) {
        return None;
    }
    crate::stream::scan_now(st, src, info, TRUNCATION_SCAN_WAIT).await
}

/// `(readable end, declared duration)` when the data ends short of the declared duration by more
/// than `max(120 s, 5 %)` (`ingest.md` rule 21a). A clock break is another defect, not a cut file.
fn truncated(info: &MediaInfo, scan: &SourceScan) -> Option<(f64, f64)> {
    let declared = info.duration_seconds?;
    let readable = scan.end - info.format_start_seconds.unwrap_or(0.0);
    (scan.break_seconds.is_none() && declared - readable > (declared * 0.05).max(120.0))
        .then_some((readable.max(0.0), declared))
}

fn clock(secs: f64) -> String {
    let s = secs.round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// Why a file's episode could not be resolved: a retry may succeed, the file cannot be placed,
/// or the import failed.
enum Refusal {
    Retry(String),
    Refused(String),
    Failed(String),
}

impl From<String> for Refusal {
    fn from(e: String) -> Self {
        Self::Failed(e)
    }
}

enum Placed {
    Imported(Imported),
    Book(books::Placed),
    Present,
    Error(String),
    Retry(String),
}

struct Ctx<'a> {
    st: &'a AppState,
    media: &'a MediaRow,
    root: &'a fsx::Root,
    folder_id: i32,
    mdir: &'a Path,
    formats: &'a naming::NamingFormats,
    allowed: &'a [String],
    req: &'a Request,
    /// The series' scene mapping, read once for the whole pack.
    scene: tokio::sync::OnceCell<Mapping>,
}

/// Rule 4: one component, at most 255 bytes, the base truncated at a character boundary.
pub fn file_component(base: &str, ext: &str) -> Result<String, String> {
    let ext_l = ext.to_lowercase();
    if !VIDEO_EXTS.contains(&ext_l.as_str()) {
        return Err(format!("not a video extension: \"{ext}\""));
    }
    component(base, ext)
}

/// The name check of `file_component` without the extension list, for the files of a book.
fn component(base: &str, ext: &str) -> Result<String, String> {
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

/// The other media whose file row sits at `src`, so that moving it would unlink that row's file.
async fn linked_to_other(db: &sqlx::PgPool, media: i32, src: &Path) -> Result<Option<i32>, String> {
    let folders = sqlx::query!(r#"SELECT id, path FROM library_folders"#)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    for f in folders {
        let Some(rel) = dunce::canonicalize(&f.path)
            .ok()
            .and_then(|root| fsx::rel_under(&root, src))
        else {
            continue;
        };
        let owner = sqlx::query_scalar!(
            r#"SELECT "mediaId" FROM media_files
               WHERE "folderId" = $1 AND replace("relativePath", '\', '/') = $2 AND "mediaId" <> $3"#,
            f.id,
            rel,
            media
        )
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
        if owner.is_some() {
            return Ok(owner);
        }
    }
    Ok(None)
}

/// `(index, count)` of each source file within its version (`book-ingest.md` rule 8).
fn book_parts(files: &[File]) -> std::collections::HashMap<PathBuf, (usize, usize)> {
    let paths: Vec<String> = files
        .iter()
        .map(|f| f.path.to_string_lossy().trim_start_matches('/').to_owned())
        .collect();
    let mut out = std::collections::HashMap::new();
    for v in books::group::group(&paths)
        .into_iter()
        .flat_map(|w| w.versions)
    {
        for (i, p) in v.files.iter().enumerate() {
            out.insert(PathBuf::from(format!("/{p}")), (i, v.files.len()));
        }
    }
    out
}

impl Ctx<'_> {
    /// A book file: no probe, no scan; placed under `mdir`, registered by the caller with its siblings.
    async fn one_book(
        &self,
        f: &File,
        part: Option<(usize, usize)>,
        pending: &[String],
    ) -> Result<Placed, String> {
        let name = file_name(&f.path);
        let Ok((src, _)) = fsx::regular_source(&f.path) else {
            return Ok(Placed::Error(format!(
                "{name}: source is not a regular file"
            )));
        };
        if !books::owns(self.media.media_type, &name) {
            let what = if self.media.media_type == MediaKind::Comic {
                "comic"
            } else {
                "book"
            };
            return Ok(Placed::Error(format!("{name}: not a {what} file")));
        }
        let m = self.media;
        let ext = transfer::split_ext(&name).1.to_owned();
        // An issue's number lives in its file name, so a comic keeps it.
        let mut base = if m.media_type == MediaKind::Comic {
            transfer::split_ext(&name).0.to_owned()
        } else {
            naming::apply_book_format(
                &self.formats.book,
                &BookNameTokens {
                    title: m.title.clone(),
                    year: m.year.map(i64::from),
                    language: self.req.language.clone(),
                    ..Default::default()
                },
            )
        };
        // The language is in the name so two languages of one format never collide (as `.fr` for a subtitle).
        if let Some(l) = self
            .req
            .language
            .as_deref()
            .filter(|_| !self.formats.book.contains("{Language}"))
        {
            base = format!("{base} ({l})");
        }
        if let Some((i, _)) = part.filter(|(_, n)| *n > 1) {
            base = format!("{base} - {:02}", i + 1);
        }
        let mut file = match component(&base, &ext) {
            Ok(n) => n,
            Err(e) => return Ok(Placed::Error(format!("{name}: {e}"))),
        };
        let dir = self.mdir.to_path_buf();
        let (dest_at, src_at) = (dir.join(&file), src.clone());
        let at_dest = tokio::task::spawn_blocking(move || {
            dunce::canonicalize(dest_at).is_ok_and(|d| d == src_at)
        })
        .await
        .unwrap_or(false);
        if !at_dest {
            if self.collides(&dir, &file).await? {
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
            if let Some(other) = self.owner(&dest).await?.filter(|o| *o != m.id) {
                return Ok(Placed::Error(format!(
                    "{name}: destination belongs to media #{other}"
                )));
            }
            if let Some(rel) = fsx::rel_under(self.root.path(), &dest)
                && self.req.language.is_none()
                && m.media_type == MediaKind::Book
                && !books::is_own_work(&self.st.db, m.id, pending, &rel)
                    .await
                    .map_err(|e| e.to_string())?
            {
                return Ok(Placed::Error(format!(
                    "{name}: belongs to another work of the folder"
                )));
            }
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| format!("{name}: {e}"))?;
            tracing::info!("Ingesting \"{}\" -> \"{}\"", src.display(), dest.display());
            let method = self.req.transfer;
            let (s, d) = (src.clone(), dest.clone());
            let done =
                tokio::task::spawn_blocking(move || transfer::transfer_file(&s, &d, method, false))
                    .await
                    .map_err(|e| e.to_string())?
                    .map_err(|e| format!("{name}: {e}"))?;
            if !done {
                return Ok(Placed::Present);
            }
        }
        let dest = dir.join(&file);
        let rel =
            fsx::rel_under(self.root.path(), &dest).ok_or("computed dest outside media folder")?;
        Ok(Placed::Book(books::Placed {
            folder_id: self.folder_id,
            rel,
            abs: dest,
        }))
    }

    async fn one(&self, f: &File) -> Result<Placed, String> {
        let name = file_name(&f.path);
        let Ok((src, _)) = fsx::regular_source(&f.path) else {
            return Ok(Placed::Error(format!(
                "{name}: source is not a regular file"
            )));
        };
        let ep = if self.media.has_seasons() {
            match self.episode(f).await {
                Ok(ep) => ep,
                Err(Refusal::Retry(why)) => return Ok(Placed::Retry(format!("{name}: {why}"))),
                Err(Refusal::Refused(why)) => return Ok(Placed::Error(format!("{name}: {why}"))),
                Err(Refusal::Failed(e)) => return Err(e),
            }
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
        let (dest_at, src_at) = (dir.join(&file), src.clone());
        let at_dest = tokio::task::spawn_blocking(move || {
            dunce::canonicalize(dest_at).is_ok_and(|d| d == src_at)
        })
        .await
        .unwrap_or(false);
        let src_size = tokio::fs::metadata(&src).await.map_or(0, |m| m.len());
        let mut unchanged_scan = None;
        if !at_dest {
            let same_size = self.req.replace_existing
                && !self.req.force
                && tokio::fs::metadata(dir.join(&file))
                    .await
                    .is_ok_and(|m| m.len() == src_size);
            let overwrite = self.req.force || (self.req.replace_existing && !same_size);
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
            if let Some(other) = self.owner(&dest).await?.filter(|o| *o != self.media.id) {
                return Ok(Placed::Error(format!(
                    "{name}: destination belongs to media #{other}"
                )));
            }
            let scanned = scan_source(self.st, &src, &probed.info).await;
            if let Some((scan, _)) = &scanned
                && let Some((end, declared)) = truncated(&probed.info, scan)
            {
                tracing::warn!(
                    "Refusing \"{}\": data ends at {end:.0}s of {declared:.0}s",
                    src.display()
                );
                return Ok(Placed::Error(format!(
                    "{name}: truncated file, its data ends at {} of the {} its container declares",
                    clock(end),
                    clock(declared)
                )));
            }
            // The scan describes bytes: it carries over to a copy of the same size.
            unchanged_scan = match scanned {
                Some((scan, v)) if crate::stream::version_of(&src).await.as_deref() == Some(&v) => {
                    Some(scan)
                }
                _ => None,
            };
            if let Err(e) = tokio::fs::create_dir_all(&dir).await {
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
        let rel =
            fsx::rel_under(self.root.path(), &dest).ok_or("computed dest outside media folder")?;
        let size = tokio::fs::metadata(&dest)
            .await
            .map_or(src_size, |m| m.len()) as i64;
        let file_id = self.row(&rel, ep.as_ref(), size, &quality, &probed).await?;
        if let Some(scan) = unchanged_scan
            && size as u64 == src_size
            && let Some(version) = crate::stream::version_of(&dest).await
        {
            let prior = probed.info.timestamp_break_seconds.flatten();
            crate::stream::keep_scan(self.st, file_id, &dest, &version, &scan, prior).await;
        }
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
        match m.media_type {
            MediaKind::Movie | MediaKind::Book | MediaKind::Comic => {
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
            MediaKind::Series => {}
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

    /// The media whose file row sits at `dest`, if any.
    async fn owner(&self, dest: &Path) -> Result<Option<i32>, String> {
        let Some(rel) = fsx::rel_under(self.root.path(), dest) else {
            return Ok(None);
        };
        sqlx::query_scalar!(
            r#"SELECT "mediaId" FROM media_files WHERE "folderId" = $1 AND "relativePath" = $2"#,
            self.folder_id,
            rel
        )
        .fetch_optional(&self.st.db)
        .await
        .map(Option::flatten)
        .map_err(|e| e.to_string())
    }

    async fn collides(&self, dir: &Path, file: &str) -> Result<bool, String> {
        let dest = dir.join(file);
        if fs::symlink_metadata(&dest).is_ok() {
            return Ok(true);
        }
        let Some(rel) = fsx::rel_under(self.root.path(), &dest) else {
            return Ok(false);
        };
        sqlx::query_scalar!(
            r#"SELECT 1 AS "x!" FROM media_files WHERE "folderId" = $1 AND "relativePath" = $2 LIMIT 1"#,
            self.folder_id,
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
            let Ok(name) = component(&format!("{base} ({n})"), ext) else {
                return Ok(None);
            };
            if !self.collides(dir, &name).await? {
                return Ok(Some(name));
            }
        }
        Ok(None)
    }

    /// The aired numbers of a name's numbers, for a series with a scene mapping.
    async fn aired(&self, n: EpisodeNumbers) -> Result<EpisodeNumbers, Refusal> {
        let scene = self
            .scene
            .get_or_try_init(|| crate::scene::for_media(self.st, self.media.id))
            .await
            .map_err(|e| e.to_string())?;
        let map = match scene {
            Mapping::Unmapped => return Ok(n),
            Mapping::Mapped(map) => map,
            Mapping::Unknown => {
                return Err(Refusal::Retry(
                    "the scene mapping of this series is not known yet, import it later".into(),
                ));
            }
        };
        let p = ParsedSeasonEpisode {
            season: Some(n.season),
            episode: Some(n.episode),
            is_full_season: false,
            season_end: None,
            episode_end: n.episode_end,
            is_complete_series: false,
        };
        let t = map.translate(&p).ok_or_else(|| {
            Refusal::Refused("the scene number is ambiguous in the series' scene mapping".into())
        })?;
        Ok(EpisodeNumbers {
            season: t.season.unwrap_or(n.season),
            episode: t.episode.unwrap_or(n.episode),
            episode_end: t.episode_end,
        })
    }

    /// Rule 20: `(episode, episodeEnd)`; ingest never creates seasons or episodes.
    async fn episode(&self, f: &File) -> Result<Option<(Ep, Option<i32>)>, Refusal> {
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
            let n = self.aired(n).await?;
            let hit = find_episode(db, self.media.id, n.season as i32, n.episode as i32)
                .await
                .map_err(|e| e.to_string())?;
            let end = n.episode_end.map(|e| e as i32);
            if let Some(e) = &hit
                && end.is_some()
                && e.end != end
            {
                sqlx::query!(
                    r#"UPDATE items SET "endNumber" = $2 WHERE id = $1"#,
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
        let info = serde_json::to_value(&probed.info).map_err(|e| e.to_string())?;
        let id = sqlx::query_scalar!(
            r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality, "streamInfo")
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT ("folderId", "relativePath") DO UPDATE
               SET size = EXCLUDED.size, quality = EXCLUDED.quality, "streamInfo" = EXCLUDED."streamInfo"
               WHERE media_files."mediaId" = EXCLUDED."mediaId"
               RETURNING id"#,
            self.media.id,
            self.folder_id,
            rel,
            size,
            quality,
            info
        )
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
        let link = Link {
            file: id,
            owner: ep.map(|e| e.0.id),
            last: ep.and_then(|e| e.1),
        };
        items::attach(db, self.media.id, &[link])
            .await
            .map_err(|e| e.to_string())?;
        Ok(id)
    }
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
        r#"SELECT e.id, s."number" AS season_number, e."number" AS "episode_number!",
                  e."endNumber" AS end, e.title, e."airDate"::text AS air_date
           FROM items e JOIN item_groups s ON s.id = e."groupId" WHERE e.id = $1 AND s."mediaId" = $2"#,
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
        r#"SELECT e.id, s."number" AS season_number, e."number" AS "episode_number!",
                  e."endNumber" AS end, e.title, e."airDate"::text AS air_date
           FROM item_groups s JOIN items e ON e."groupId" = s.id
           WHERE s."mediaId" = $1 AND s."number" = $2 AND e."number" = $3
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
        r#"SELECT e.id, s."number" AS season_number, e."number" AS "episode_number!",
                  e."endNumber" AS end, e.title, e."airDate"::text AS air_date
           FROM item_groups s JOIN items e ON e."groupId" = s.id
           WHERE s."mediaId" = $1 AND s."number" = $2 ORDER BY e.id"#,
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

/// Rules 29-31: the files the new ones replace.
async fn remove_superseded(st: &AppState, media: &MediaRow, imported: &[Imported]) -> Vec<i32> {
    let mut carried = vec![];
    let new_ids: Vec<i32> = imported.iter().map(|i| i.file_id).collect();
    let olds = sqlx::query_as!(
        Old,
        r#"SELECT mf.id, mf."relativePath" AS relative_path, fi."episodeId" AS episode_id,
                  s."number" AS "season_number?", e."number" AS "episode_number?",
                  e."endNumber" AS end
           FROM media_files mf
           LEFT JOIN LATERAL (SELECT "episodeId" FROM media_file_items WHERE "mediaFileId" = mf.id) fi ON true
           LEFT JOIN items e ON e.id = fi."episodeId"
           LEFT JOIN item_groups s ON s.id = e."groupId"
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
            let heir = match media.media_type {
                MediaKind::Series => match (old.season_number, old.episode_number, old.end) {
                    (Some(s), Some(e), None) => imported.iter().find(|i| {
                        i.season_number == Some(s)
                            && i.episode_number == Some(e)
                            && i.episode_end.is_none()
                    }),
                    _ => None,
                },
                MediaKind::Movie | MediaKind::Book | MediaKind::Comic => imported.first(),
            };
            if media.media_type == MediaKind::Series {
                let (Some(s), Some(e)) = (old.season_number, old.episode_number) else {
                    return Ok(());
                };
                let span = e..=old.end.unwrap_or(e).max(e);
                if !span.clone().all(|n| covered.contains(&(s, n))) {
                    return Ok(());
                }
            }
            if let Some(h) = heir {
                carried.extend(
                    crate::subtitles::sidecars::carry_over(st, media.id, old.id, h.file_id).await,
                );
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
                sqlx::query!(r#"UPDATE items SET "endNumber" = NULL WHERE id = $1"#, ep)
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

#[cfg(test)]
mod truncation_tests {
    use super::*;
    use serde_json::json;

    fn info(duration: f64, start: f64) -> MediaInfo {
        serde_json::from_value(json!({"video": [], "audio": [], "subtitles": [],
            "durationSeconds": duration, "formatStartSeconds": start}))
        .unwrap()
    }

    fn scan(end: f64, brk: Option<f64>) -> SourceScan {
        serde_json::from_value(json!({"keyframes": [], "end": end, "breakSeconds": brk,
            "audioConfigChanges": {}}))
        .unwrap()
    }

    #[test]
    fn a_cut_file_is_truncated_and_a_whole_one_is_not() {
        assert!(truncated(&info(4800.0, 0.0), &scan(1764.0, None)).is_some());
        assert!(truncated(&info(4800.0, 0.0), &scan(4799.0, None)).is_none());
        // short of 5 %: 4560 s of 4800 s passes, 4500 s does not
        assert!(truncated(&info(4800.0, 0.0), &scan(4560.0, None)).is_none());
        assert!(truncated(&info(4800.0, 0.0), &scan(4500.0, None)).is_some());
        // under 10 min the floor is 120 s
        assert!(truncated(&info(600.0, 0.0), &scan(500.0, None)).is_none());
        assert!(truncated(&info(600.0, 0.0), &scan(470.0, None)).is_some());
    }

    #[test]
    fn a_start_offset_and_a_clock_break_are_not_truncation() {
        assert!(truncated(&info(3600.0, 36000.0), &scan(39600.0, None)).is_none());
        assert!(truncated(&info(4800.0, 0.0), &scan(100.0, Some(100.0))).is_none());
    }
}

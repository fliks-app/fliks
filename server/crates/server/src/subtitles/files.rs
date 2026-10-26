//! The media directory model and the confined sidecar writes (`subtitle-files.md` rules 5-7, 34).
use crate::{
    http::AppError,
    ingest::fsx::{self, Unlinked},
};
use fliks_domain::subtitle_path::{
    is_safe_lang_suffix, relative_path_under_root, resolve_subtitle_absolute_path,
};
use serde_json::Value;
use sqlx::{FromRow, PgExecutor};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub const NO_ROOT_DOWNLOAD: &str =
    "Assign a root folder to this media before downloading subtitles";
pub const NO_ROOT_ADD: &str = "Assign a root folder to this media before adding subtitles";
pub const OUTSIDE: &str =
    "Subtitle file would be outside the media folder; check root folder configuration";

#[derive(Debug, Clone, FromRow)]
pub struct MediaCtx {
    pub id: i32,
    pub title: String,
    pub kind: String,
    pub year: Option<i32>,
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<i32>,
    pub folder_name: Option<String>,
    pub library_path: Option<String>,
    pub library_id: Option<i32>,
    pub language_profile_id: Option<i32>,
    pub monitored: bool,
    pub genres: Option<Value>,
    pub overview: Option<String>,
}

const MEDIA_SQL: &str = r#"SELECT m.id, m.title, m."type"::text AS kind, m.year, m."imdbId" AS imdb_id, m."tmdbId" AS tmdb_id,
  m."folderName" AS folder_name, l.path AS library_path, m."libraryId" AS library_id,
  m."languageProfileId" AS language_profile_id, m.monitored, m.genres, m.overview
  FROM media m LEFT JOIN libraries l ON l.id = m."libraryId""#;

pub async fn load_media(db: impl PgExecutor<'_>, id: i32) -> sqlx::Result<Option<MediaCtx>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!("{MEDIA_SQL} WHERE m.id = $1")))
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn media_batch(
    db: impl PgExecutor<'_>,
    after: i32,
    limit: i64,
) -> sqlx::Result<Vec<MediaCtx>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{MEDIA_SQL} WHERE m.monitored = true AND m.id > $1 ORDER BY m.id ASC LIMIT $2"
    )))
    .bind(after)
    .bind(limit)
    .fetch_all(db)
    .await
}

#[derive(Debug, Clone, FromRow)]
pub struct FileRow {
    pub id: i32,
    pub media_id: Option<i32>,
    pub episode_id: Option<i32>,
    pub relative_path: String,
    pub stream_info: Option<Value>,
    pub osdb_hash: Option<String>,
    pub osdb_bytesize: Option<i64>,
}

pub const FILE_COLS: &str = r#"id, "mediaId" AS media_id, "episodeId" AS episode_id, "relativePath" AS relative_path,
  "streamInfo" AS stream_info, "osdbHash" AS osdb_hash, "osdbBytesize" AS osdb_bytesize"#;

pub async fn file_by_id(db: impl PgExecutor<'_>, id: i32) -> sqlx::Result<Option<FileRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {FILE_COLS} FROM media_files WHERE id = $1"
    )))
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn files_of_media(db: impl PgExecutor<'_>, media: i32) -> sqlx::Result<Vec<FileRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {FILE_COLS} FROM media_files WHERE "mediaId" = $1 ORDER BY id"#
    )))
    .bind(media)
    .fetch_all(db)
    .await
}

/// `M` and its realpath `Mc`: every write is checked against `Mc`.
pub struct Dirs {
    pub m: PathBuf,
    pub mc: fsx::Root,
}

impl MediaCtx {
    pub fn dirs(&self, no_root: &str) -> Result<Dirs, AppError> {
        let lib = self
            .library_path
            .as_deref()
            .filter(|p| !p.trim().is_empty())
            .ok_or_else(|| AppError::bad_request(no_root))?;
        let lib_root = fsx::Root::open(lib).map_err(|_| missing_disk())?;
        let m = lib_root
            .media_dir(self.folder_name.as_deref())
            .map_err(|_| AppError::bad_request(no_root))?;
        // A folder name that is a symlink out of the library is no media directory.
        if !lib_root.contains(&m, true) {
            return Err(AppError::bad_request(no_root));
        }
        let mc = fsx::Root::open(&m.to_string_lossy()).map_err(|_| missing_disk())?;
        Ok(Dirs { m, mc })
    }
}

fn missing_disk() -> AppError {
    AppError::not_found("Media file is missing on disk")
}

impl Dirs {
    /// The absolute path of a stored relative path: lexically under `M`, parent really under `Mc`.
    pub fn resolve(&self, stored: &str) -> Option<PathBuf> {
        let abs = resolve_subtitle_absolute_path(&self.m.to_string_lossy(), stored)?;
        let abs = PathBuf::from(abs);
        self.mc.contains(abs.parent()?, true).then_some(abs)
    }

    /// `resolve` and the final component is a regular file (not a link, not a directory).
    pub fn resolve_file(&self, stored: &str) -> Result<PathBuf, AppError> {
        let abs = self
            .resolve(stored)
            .ok_or_else(|| AppError::not_found("Subtitle file path could not be resolved"))?;
        match fs::symlink_metadata(&abs) {
            Ok(m) if m.is_file() => Ok(abs),
            Ok(_) => Err(AppError::bad_request("Subtitle path is not a regular file")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(abs),
            Err(e) => Err(io_error(&e)),
        }
    }

    /// `relativePath` of a path already under `M`, `/`-separated.
    pub fn rel(&self, abs: &Path) -> Option<String> {
        relative_path_under_root(&self.m.to_string_lossy(), &abs.to_string_lossy())
    }

    /// Creates `<video>.<suffix>[-N]<ext>` next to the video, never replacing a file (rule 6).
    pub fn write_sidecar(
        &self,
        video_rel: &str,
        suffix: &str,
        ext: &str,
        bytes: &[u8],
    ) -> Result<String, AppError> {
        self.write_with(video_rel, suffix, bytes, |stem, n| {
            let tagged = if n == 0 {
                suffix.to_owned()
            } else {
                format!("{suffix}-{n}")
            };
            format!("{stem}.{tagged}{ext}")
        })
    }

    /// An OCR result: `<video>.<suffix>.ocr[-N].srt` (rule 26).
    pub fn write_sidecar_ocr(
        &self,
        video_rel: &str,
        suffix: &str,
        bytes: &[u8],
    ) -> Result<String, AppError> {
        self.write_with(video_rel, suffix, bytes, |stem, n| {
            let counter = if n == 0 {
                String::new()
            } else {
                format!("-{n}")
            };
            format!("{stem}.{suffix}.ocr{counter}.srt")
        })
    }

    fn write_with(
        &self,
        video_rel: &str,
        suffix: &str,
        bytes: &[u8],
        name: impl Fn(&str, usize) -> String,
    ) -> Result<String, AppError> {
        if !is_safe_lang_suffix(suffix) {
            return Err(AppError::bad_request(format!(
                "Invalid subtitle language \"{suffix}\""
            )));
        }
        let video = self
            .resolve(video_rel)
            .ok_or_else(|| AppError::bad_request(OUTSIDE))?;
        let dir = video
            .parent()
            .ok_or_else(|| AppError::bad_request(OUTSIDE))?;
        if !dir.is_dir() {
            return Err(missing_disk());
        }
        let stem = video
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| AppError::bad_request(OUTSIDE))?;
        for n in 0..100 {
            let dest = dir.join(name(stem, n));
            let Some(rel) = self.rel(&dest).filter(|r| !r.split('/').any(|p| p == "..")) else {
                return Err(AppError::bad_request(OUTSIDE));
            };
            match fsx::write_new(&dest, bytes) {
                Ok(true) => return Ok(rel),
                Ok(false) => {}
                Err(e) => return Err(io_error(&e)),
            }
        }
        Err(AppError::conflict("Too many sidecars with this name"))
    }

    /// Rewrites a stored sidecar in place (temp + rename), refusing a non-regular file.
    pub fn rewrite(&self, stored: &str, bytes: &[u8]) -> Result<(), AppError> {
        let abs = self.resolve_file(stored)?;
        if !self.mc.contains(abs.parent().unwrap_or(&abs), true) {
            return Err(AppError::bad_request(OUTSIDE));
        }
        fsx::write_atomic(&abs, bytes).map_err(|e| io_error(&e))
    }

    /// Unlinks a stored sidecar; a missing file counts as removed.
    pub fn unlink(&self, stored: &str) -> Result<(), AppError> {
        let abs = self.resolve_file(stored)?;
        match fsx::unlink_contained(&self.mc, &abs) {
            Ok(Unlinked::Removed | Unlinked::Missing) => Ok(()),
            Err(e) => Err(io_error(&e)),
        }
    }

    /// No-replace rename of a stored sidecar to a new name in the same directory.
    pub fn rename(&self, stored: &str, new_name: &str) -> Option<String> {
        let abs = self.resolve_file(stored).ok()?;
        let target = abs.parent()?.join(new_name);
        if target == abs {
            return self.rel(&abs);
        }
        if !self.mc.contains(target.parent()?, true) {
            return None;
        }
        fsx::rename_noreplace(&abs, &target).ok()?;
        self.rel(&target)
    }
}

fn io_error(e: &io::Error) -> AppError {
    tracing::error!(error = %e, "subtitle file write");
    AppError::plain(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    )
}

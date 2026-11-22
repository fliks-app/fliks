//! Library writes (`docs/spec/ingest.md`): file transfer, library ingest, the post-import queue,
//! rescan and the disk import routes.
pub mod books;
pub mod busy;
pub mod comics;
pub mod disk;
pub mod fsx;
pub mod library;
pub mod music;
pub mod post_import;
pub mod record;
pub mod rescan;
pub mod transfer;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod keyed_locks_tests {
    use super::KeyedLocks;

    #[tokio::test]
    async fn held_is_true_only_while_the_guard_lives() {
        let l = KeyedLocks::<i32>::default();
        assert!(!l.held(&1));
        let g = l.lock(1).await;
        assert!(l.held(&1) && !l.held(&2));
        drop(g);
        assert!(!l.held(&1));
    }
}

use crate::libraries::Folder;
use crate::media::external_ids;
use crate::state::AppState;
use crate::sync::MutexExt;
use books::{Placed, Registration};
use fliks_domain::{
    media::kind::MediaKind,
    naming::{NamingFormats, Scope, formats_from_rows, setting_key},
};
use fliks_engine_core::api::MediaInfo;
use sqlx::PgPool;
use std::{
    collections::HashMap,
    hash::Hash,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// In-process locks keyed by id; entries nobody holds are pruned on the next lock.
pub struct KeyedLocks<K>(Mutex<HashMap<K, Arc<AsyncMutex<()>>>>);

impl<K> Default for KeyedLocks<K> {
    fn default() -> Self {
        Self(Mutex::default())
    }
}

impl<K: Eq + Hash + Clone> KeyedLocks<K> {
    pub async fn lock(&self, key: K) -> OwnedMutexGuard<()> {
        let m = {
            let mut map = self.0.lock_clean();
            map.retain(|_, m| Arc::strong_count(m) > 1);
            map.entry(key).or_default().clone()
        };
        m.lock_owned().await
    }
}

impl<K: Eq + Hash> KeyedLocks<K> {
    /// Whether a holder has the key now.
    pub fn held(&self, key: &K) -> bool {
        self.0
            .lock_clean()
            .get(key)
            .is_some_and(|m| m.try_lock().is_err())
    }
}

/// Process-wide ingest state: the per-media lock, the relink creation lock and the queue.
#[derive(Default)]
pub struct Shared {
    pub media: KeyedLocks<i32>,
    pub unmatched: KeyedLocks<String>,
    pub covers: KeyedLocks<i32>,
    pub merging: KeyedLocks<i32>,
    /// One m4b merge at a time, whatever triggered it.
    pub merge_slot: AsyncMutex<()>,
    /// Libraries whose merge backfill is running, and whether another round was asked for.
    pub backfills: Mutex<HashMap<i32, bool>>,
    /// Books waiting out the quiet period before their merge.
    pub merge_waiting: Mutex<std::collections::HashSet<i32>>,
    pub unmatched_holders: Mutex<HashMap<i32, usize>>,
    pub queue: post_import::Queue,
    pub settle: post_import::Settle,
}

/// A media with its library, as every write path loads it.
#[derive(Debug, Clone)]
pub struct MediaRow {
    pub id: i32,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<i32>,
    pub media_type: MediaKind,
    pub tmdb_id: Option<i32>,
    pub tvdb_id: Option<i32>,
    pub imdb_id: Option<String>,
    pub monitored: bool,
    pub folder_name: Option<String>,
    pub library_id: Option<i32>,
    pub library_name: Option<String>,
    pub folder: Option<Folder>,
    pub library_types: Option<serde_json::Value>,
}

impl MediaRow {
    pub fn has_seasons(&self) -> bool {
        self.media_type.has_seasons()
    }

    /// The `Media.path` getter (lexical, for messages and outbound notifications only).
    pub fn path(&self) -> Option<String> {
        fliks_domain::media::path::media_path(
            self.folder.as_ref().map(|f| f.path.as_str()),
            self.folder_name.as_deref(),
        )
    }

    /// `M` of this media under `root`.
    pub fn dir_in(&self, root: &fsx::Root) -> Result<std::path::PathBuf, String> {
        root.media_dir_of(self.media_type, self.folder_name.as_deref())
    }

    pub fn lifecycle_ref(&self) -> crate::requests::MediaRef {
        crate::requests::MediaRef {
            id: self.id,
            media_type: self.media_type,
            monitored: self.monitored,
        }
    }
}

pub async fn load_media(db: &PgPool, id: i32) -> Result<Option<MediaRow>, sqlx::Error> {
    let Some(r) = sqlx::query!(
        r#"SELECT m.id, m.title, m."originalTitle" AS original_title, m.year, m.type AS "media_type!",
                  ids.tmdb AS tmdb_id, ids.tvdb AS tvdb_id, ids.imdb AS imdb_id, m.monitored,
                  m."folderName" AS folder_name, m."libraryId" AS library_id, l.name AS "library_name?",
                  df."folderId" AS "folder_id?", df.path AS "folder_path?", l."mediaTypes" AS "library_types?"
           FROM media m LEFT JOIN libraries l ON l.id = m."libraryId"
           LEFT JOIN media_target_folders df ON df."mediaId" = m.id
           LEFT JOIN LATERAL (SELECT max(value) FILTER (WHERE provider = $2)::int AS tmdb,
             max(value) FILTER (WHERE provider = $3)::int AS tvdb,
             max(value) FILTER (WHERE provider = $4) AS imdb
           FROM media_external_ids WHERE "mediaId" = m.id) ids ON true
           WHERE m.id = $1"#,
        id,
        external_ids::TMDB,
        external_ids::TVDB,
        external_ids::IMDB
    )
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    Ok(Some(MediaRow {
        id: r.id,
        title: r.title,
        original_title: r.original_title,
        year: r.year,
        media_type: crate::db::kind(&r.media_type)?,
        tmdb_id: r.tmdb_id,
        tvdb_id: r.tvdb_id,
        imdb_id: r.imdb_id,
        monitored: r.monitored,
        folder_name: r.folder_name,
        library_id: r.library_id,
        library_name: r.library_name,
        folder: r
            .folder_id
            .zip(r.folder_path)
            .map(|(id, path)| Folder { id, path }),
        library_types: r.library_types,
    }))
}

pub async fn naming_formats(db: &PgPool) -> Result<NamingFormats, sqlx::Error> {
    let keys: Vec<&str> = MediaKind::ALL
        .into_iter()
        .flat_map(|k| Scope::ALL.map(|s| setting_key(k, s)))
        .flatten()
        .collect();
    let rows = crate::settings::texts(db, &keys).await?;
    Ok(formats_from_rows(
        &rows
            .into_iter()
            .map(|(k, v)| (k, Some(v)))
            .collect::<Vec<_>>(),
    ))
}

/// `true` when unset or exactly `'true'` (`ingest.md` rule 37).
pub async fn setting_on(db: &PgPool, key: &str) -> Result<bool, sqlx::Error> {
    let v = crate::settings::text(db, key).await?;
    Ok(v.is_none_or(|v| v == "true"))
}

/// `detectMediaFileInfo` through the engine probe: a bad file is an `error` blob, an unreachable
/// engine an `Err` (`ingest.md` rule 21).
pub async fn probe(st: &AppState, path: &Path, crop: bool) -> Result<Probed, String> {
    probe_with(st, path, crop, false).await
}

/// `probe` plus the OpenSubtitles hash, which reads the head and tail of the file.
pub async fn probe_hashed(st: &AppState, path: &Path, crop: bool) -> Result<Probed, String> {
    probe_with(st, path, crop, true).await
}

pub(crate) async fn probe_with(
    st: &AppState,
    path: &Path,
    crop: bool,
    moviehash: bool,
) -> Result<Probed, String> {
    let r = st
        .engine
        .probe(&path.to_string_lossy(), crop, false, moviehash)
        .await
        .map_err(|e| e.to_string())?;
    let info = match r.info {
        Some(i) if r.ok => i,
        _ => serde_json::from_value(serde_json::json!({
            "video": [], "audio": [], "subtitles": [], "error": r.error.unwrap_or_default()
        }))
        .map_err(|e| e.to_string())?,
    };
    Ok(Probed {
        info,
        moviehash: r.moviehash.map(|h| (h.hash, h.bytesize as i64)),
    })
}

pub struct Probed {
    pub info: MediaInfo,
    pub moviehash: Option<(String, i64)>,
}

impl Probed {
    /// `qualityFromResolution` when the first video stream has both dimensions.
    pub fn quality(&self, source: &str) -> Option<String> {
        let v = self.info.video.first()?;
        let (w, h) = (v.width?, v.height?);
        Some(
            fliks_domain::release::parsing::quality_from_resolution::quality_from_resolution(
                source,
                Some(f64::from(w)),
                Some(f64::from(h)),
            ),
        )
    }
}

/// `path.extname` lowercased, `""` when none.
pub fn ext_lower(name: &str) -> String {
    crate::stream::extname(name).to_lowercase()
}

pub fn is_video(name: &str) -> bool {
    fliks_domain::media::VIDEO_EXTS.contains(&ext_lower(name).as_str())
}

/// A video or a music file: what a sidecar rides along with.
pub fn is_media(name: &str) -> bool {
    is_video(name) || music::is_music_file(name)
}

/// Drops the engine's jobs, cache entries and sprite of a file, detached.
pub fn drop_thumbnails(st: &AppState, file_id: i32) {
    let st = st.clone();
    tokio::spawn(async move { st.engine.invalidate(file_id as u32).await });
}

/// Whether `kind` registers its files in one batch through `register_files`.
pub fn registers(kind: MediaKind) -> bool {
    matches!(kind, MediaKind::Book | MediaKind::Comic | MediaKind::Album)
}

/// `books::register_language` for a book, `comics::register` for a comic, `music::register` for an album.
pub async fn register_files(
    st: &AppState,
    kind: MediaKind,
    media: i32,
    files: &[Placed],
    language: Option<&str>,
) -> Result<Registration, String> {
    match kind {
        MediaKind::Comic => comics::register(st, media, files).await,
        MediaKind::Album => music::register(st, media, files).await,
        _ => books::register_language(st, media, files, language).await,
    }
}

/// Why a file is refused by a media of `kind`.
pub fn not_owned_message(kind: MediaKind) -> &'static str {
    match kind {
        MediaKind::Book => "not a book file",
        MediaKind::Comic => "not a comic file",
        MediaKind::Album => "not an audio file",
        _ => "not a video file",
    }
}

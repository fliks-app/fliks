//! Library writes (`docs/spec/ingest.md`): file transfer, library ingest, the post-import queue,
//! rescan and the disk import routes.
pub mod disk;
pub mod fsx;
pub mod library;
pub mod post_import;
pub mod rescan;
pub mod transfer;

#[cfg(test)]
mod tests;

use crate::state::AppState;
use crate::sync::MutexExt;
use fliks_domain::naming::{NamingFormats, formats_from_rows};
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

/// Process-wide ingest state: the per-media lock, the relink creation lock and the queue.
#[derive(Default)]
pub struct Shared {
    pub media: KeyedLocks<i32>,
    pub unmatched: KeyedLocks<String>,
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
    pub media_type: String,
    pub tmdb_id: Option<i32>,
    pub tvdb_id: Option<i32>,
    pub imdb_id: Option<String>,
    pub monitored: bool,
    pub folder_name: Option<String>,
    pub library_id: Option<i32>,
    pub library_name: Option<String>,
    pub library_path: Option<String>,
    pub library_types: Option<serde_json::Value>,
}

impl MediaRow {
    pub fn is_series(&self) -> bool {
        self.media_type != "movie"
    }

    /// The `Media.path` getter (lexical, for messages and outbound notifications only).
    pub fn path(&self) -> Option<String> {
        fliks_domain::media::path::media_path(
            self.library_path.as_deref(),
            self.folder_name.as_deref(),
        )
    }

    pub fn lifecycle_ref(&self) -> crate::requests::MediaRef {
        crate::requests::MediaRef {
            id: self.id,
            media_type: self.media_type.clone(),
            tmdb_id: self.tmdb_id,
            monitored: self.monitored,
        }
    }
}

pub async fn load_media(db: &PgPool, id: i32) -> Result<Option<MediaRow>, sqlx::Error> {
    sqlx::query_as!(
        MediaRow,
        r#"SELECT m.id, m.title, m."originalTitle" AS original_title, m.year, m.type::text AS "media_type!",
                  m."tmdbId" AS tmdb_id, m."tvdbId" AS tvdb_id, m."imdbId" AS imdb_id, m.monitored,
                  m."folderName" AS folder_name, m."libraryId" AS library_id, l.name AS "library_name?",
                  l.path AS "library_path?", l."mediaTypes" AS "library_types?"
           FROM media m LEFT JOIN libraries l ON l.id = m."libraryId" WHERE m.id = $1"#,
        id
    )
    .fetch_optional(db)
    .await
}

pub async fn naming_formats(db: &PgPool) -> Result<NamingFormats, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT key, value FROM app_settings WHERE key = ANY($1)"#,
        &[
            "naming_movie_format",
            "naming_movie_folder_format",
            "naming_series_format",
            "naming_series_folder_format",
            "naming_season_folder_format",
        ]
        .map(String::from)[..]
    )
    .fetch_all(db)
    .await?;
    Ok(formats_from_rows(
        &rows
            .into_iter()
            .map(|r| (r.key, r.value))
            .collect::<Vec<_>>(),
    ))
}

/// `true` when unset or exactly `'true'` (`ingest.md` rule 37).
pub async fn setting_on(db: &PgPool, key: &str) -> Result<bool, sqlx::Error> {
    let v = sqlx::query_scalar!(
        r#"SELECT value FROM app_settings WHERE key = $1 LIMIT 1"#,
        key
    )
    .fetch_optional(db)
    .await?
    .flatten();
    Ok(v.is_none_or(|v| v == "true"))
}

/// `detectMediaFileInfo` through the engine probe: a bad file is an `error` blob, an unreachable
/// engine an `Err` (`ingest.md` rule 21).
pub async fn probe(st: &AppState, path: &Path, crop: bool) -> Result<Probed, String> {
    let r = st
        .engine
        .probe(&path.to_string_lossy(), crop, false, true)
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

/// `hasFile = false` once no file of the episode remains.
pub async fn clear_has_file(db: &PgPool, episode_id: i32) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE episodes SET "hasFile" = false
           WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM media_files WHERE "episodeId" = $1)"#,
        episode_id
    )
    .execute(db)
    .await
    .map(drop)
}

/// W11 `thumbnails.deleteForFile`, detached: engine invalidate then the sprite cache dir.
pub fn drop_thumbnails(st: &AppState, file_id: i32) {
    let st = st.clone();
    tokio::spawn(async move {
        st.engine.invalidate(file_id as u32).await;
        let dir = crate::paths::cache_dir()
            .join("thumbnails")
            .join(file_id.to_string());
        if let Err(e) = tokio::fs::remove_dir_all(&dir).await
            && e.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!("could not remove thumbnails of file #{file_id}: {e}");
        }
    });
}

//! Narrow calls into the services other S5 branches port (metadata providers, image store, NFO
//! reader, request lifecycle, media servers, markers); `Unwired` stands in until they are wired.
use crate::http::AppError;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use std::{future::Future, path::Path, pin::Pin, sync::Arc};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `MetadataDetails` of the provider interface, the fields the media services read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Details {
    pub tmdb_id: Option<i32>,
    pub tvdb_id: Option<i32>,
    pub imdb_id: Option<String>,
    pub title: String,
    pub original_title: Option<String>,
    pub overview: Option<String>,
    pub year: Option<f64>,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
    pub logo_url: Option<String>,
    pub additional_fanart_urls: Vec<String>,
    pub rating: Option<f64>,
    pub genres: Vec<String>,
    pub runtime: Option<i32>,
    pub release_date: Option<String>,
    pub in_cinemas: Option<String>,
    pub digital_release: Option<String>,
    pub physical_release: Option<String>,
    pub status: String,
    pub alternative_titles: Vec<String>,
    pub tmdb_collection_id: Option<i32>,
    pub tmdb_collection_name: Option<String>,
    /// Cast, crew, videos and the `media_metadata` columns, handed back to [`Metadata::persist_credits`].
    #[serde(flatten)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SeasonDetails {
    pub season_number: i32,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub poster_url: Option<String>,
    pub episodes: Vec<EpisodeDetails>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EpisodeDetails {
    pub episode_number: i32,
    pub title: String,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub runtime: Option<i32>,
    pub still_url: Option<String>,
}

/// A title as read from its provider; `seasons` is every season with full episode lists (series).
#[derive(Debug, Clone, Default)]
pub struct Found {
    pub details: Details,
    pub seasons: Vec<SeasonDetails>,
}

/// What `importMedia` / `importFromTmdb` look up (`media-write.md` rules 16-17).
#[derive(Debug, Clone)]
pub struct Lookup {
    pub media_type: String,
    /// `None` = default provider.
    pub provider: Option<String>,
    pub external_id: String,
    pub library_id: i32,
}

/// A provider failure already mapped to its HTTP answer by the metadata service (C28).
#[derive(Debug, Clone)]
pub struct SeamError {
    pub status: u16,
    pub message: String,
}

impl From<SeamError> for AppError {
    fn from(e: SeamError) -> Self {
        let status = StatusCode::from_u16(e.status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE);
        AppError::with_message(status, e.message)
    }
}

impl std::fmt::Display for SeamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

type Fut<'a, T> = BoxFuture<'a, Result<T, SeamError>>;

/// Metadata providers (`metadata.md`): provider choice, cross-references and the HTTP clients.
pub trait Metadata: Send + Sync {
    /// `TMDB_API_KEY` is set (`media-write.md` rule 11a).
    fn tmdb_configured(&self) -> bool;
    /// `readForLibrary` with the tvdb-to-tmdb fill of rule 17; seasons only for series.
    fn import(&self, req: Lookup) -> Fut<'_, Found>;
    /// `resolveProviderForMedia` then details and, for series, every season (season overrides applied).
    fn for_media(&self, media_id: i32) -> Fut<'_, Found>;
    /// Rule 55: the episode as its season's provider lists it.
    fn episode(&self, episode_id: i32) -> Fut<'_, Option<EpisodeDetails>>;
    /// Rule 58 `persistMediaMetadata`: metadata row, persons, cast and crew.
    fn persist_credits(&self, media_id: i32, details: Details) -> Fut<'_, ()>;
}

/// The image store (`image-store.md`): writes only in the data dir; `None` when nothing was stored.
pub trait Images: Send + Sync {
    /// `downloadAndStore(url, kind, id, variant?)`: the local URL.
    fn download<'a>(
        &'a self,
        url: &'a str,
        kind: &'a str,
        id: i32,
        variant: Option<&'a str>,
    ) -> BoxFuture<'a, Option<String>>;
    fn store_from_disk<'a>(
        &'a self,
        path: &'a Path,
        kind: &'a str,
        id: i32,
        variant: &'a str,
    ) -> BoxFuture<'a, Option<String>>;
}

/// `NfoData` (`importers.md` rule 47); absent keys are omitted.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Nfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmdb_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imdb_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tvdb_id: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub premiered: Option<String>,
}

/// The NFO reader (`importers.md` rule 48), capped at 1 MiB per file (C55).
pub trait NfoReader: Send + Sync {
    fn for_video<'a>(&'a self, video: &'a Path) -> BoxFuture<'a, Option<Nfo>>;
    fn file<'a>(&'a self, path: &'a Path) -> BoxFuture<'a, Option<Nfo>>;
}

/// The media row the lifecycle hooks read.
#[derive(Debug, Clone)]
pub struct MediaRef {
    pub id: i32,
    pub media_type: String,
    pub tmdb_id: Option<i32>,
    pub monitored: bool,
}

/// Request lifecycle hooks (`requests.md` rules 36-42), called in process.
pub trait Lifecycle: Send + Sync {
    fn on_media_imported(&self, media: MediaRef, added_by: Option<i32>) -> BoxFuture<'_, ()>;
    /// Runs inside the media delete's transaction (C48).
    fn on_media_removed<'a>(
        &'a self,
        tx: &'a mut PgConnection,
        media: &'a MediaRef,
    ) -> BoxFuture<'a, Result<(), sqlx::Error>>;
    fn on_media_monitor_change(&self, media: MediaRef, was_monitored: bool) -> BoxFuture<'_, ()>;
    fn on_season_monitor_change(
        &self,
        media: MediaRef,
        season: i32,
        was: bool,
        now: bool,
    ) -> BoxFuture<'_, ()>;
}

/// `mediaServers.dispatch` (fire-and-forget outbound notification).
pub trait MediaServers: Send + Sync {
    fn dispatch(&self, event: &'static str, title: String, path: Option<String>);
}

/// `markers.autoDetectMissing` after an import settled (`ingest.md` rule 37).
pub trait Markers: Send + Sync {
    fn auto_detect_missing(&self, media_id: i32) -> BoxFuture<'_, ()>;
}

#[derive(Clone)]
pub struct Seams {
    pub metadata: Arc<dyn Metadata>,
    pub images: Arc<dyn Images>,
    pub nfo: Arc<dyn NfoReader>,
    pub lifecycle: Arc<dyn Lifecycle>,
    pub media_servers: Arc<dyn MediaServers>,
    pub markers: Arc<dyn Markers>,
}

impl Default for Seams {
    fn default() -> Self {
        let u = Arc::new(Unwired);
        Self {
            metadata: u.clone(),
            images: u.clone(),
            nfo: u.clone(),
            lifecycle: u.clone(),
            media_servers: u.clone(),
            markers: u,
        }
    }
}

/// Until the S5 integration: providers fail with 503, the rest is a no-op (`bridge.md` known gaps).
pub struct Unwired;

fn unwired() -> SeamError {
    SeamError {
        status: 503,
        message: "Metadata providers are not available".into(),
    }
}

impl Metadata for Unwired {
    fn tmdb_configured(&self) -> bool {
        std::env::var("TMDB_API_KEY").is_ok_and(|k| !k.trim().is_empty())
    }
    fn import(&self, _: Lookup) -> Fut<'_, Found> {
        Box::pin(async { Err(unwired()) })
    }
    fn for_media(&self, _: i32) -> Fut<'_, Found> {
        Box::pin(async { Err(unwired()) })
    }
    fn episode(&self, _: i32) -> Fut<'_, Option<EpisodeDetails>> {
        Box::pin(async { Err(unwired()) })
    }
    fn persist_credits(&self, _: i32, _: Details) -> Fut<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

impl Images for Unwired {
    fn download<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: i32,
        _: Option<&'a str>,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
    fn store_from_disk<'a>(
        &'a self,
        _: &'a Path,
        _: &'a str,
        _: i32,
        _: &'a str,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { None })
    }
}

impl NfoReader for Unwired {
    fn for_video<'a>(&'a self, _: &'a Path) -> BoxFuture<'a, Option<Nfo>> {
        Box::pin(async { None })
    }
    fn file<'a>(&'a self, _: &'a Path) -> BoxFuture<'a, Option<Nfo>> {
        Box::pin(async { None })
    }
}

impl Lifecycle for Unwired {
    fn on_media_imported(&self, _: MediaRef, _: Option<i32>) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn on_media_removed<'a>(
        &'a self,
        _: &'a mut PgConnection,
        _: &'a MediaRef,
    ) -> BoxFuture<'a, Result<(), sqlx::Error>> {
        Box::pin(async { Ok(()) })
    }
    fn on_media_monitor_change(&self, _: MediaRef, _: bool) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
    fn on_season_monitor_change(&self, _: MediaRef, _: i32, _: bool, _: bool) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

impl MediaServers for Unwired {
    fn dispatch(&self, _: &'static str, _: String, _: Option<String>) {}
}

impl Markers for Unwired {
    fn auto_detect_missing(&self, _: i32) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }
}

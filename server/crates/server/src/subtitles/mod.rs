//! Subtitles (`docs/spec/subtitles.md`, `subtitle-files.md`, `subtitle-providers.md`, `translation.md`).
pub mod embedded;
pub mod files;
pub mod model;
pub mod ocr;
pub mod postprocess;
pub mod providers;
pub mod routes_activity;
pub mod routes_providers;
pub mod scheduler;
pub mod secrets;
pub mod service;
pub mod sidecars;
pub mod sync;
#[cfg(test)]
mod tests;
pub mod translate;
pub mod translation;
pub mod translation_providers;

mod events;

use providers::limiter::Limiter;
use std::{collections::HashMap, sync::Mutex};

/// Provider origins; tests point them at stubs. There is no production override (a config
/// value would let a setting redirect the credentials, rule 45).
#[derive(Debug, Clone)]
pub struct Bases {
    pub opensubtitles: String,
    pub subdl_api: String,
    pub subdl_dl: String,
    pub subsynchro: String,
    pub supersubtitles: String,
    pub yify: String,
    pub gestdown: String,
    pub gemini: String,
    /// The OpenSubtitles CDN link must be https unless a test allows http.
    pub allow_http_link: bool,
}

impl Default for Bases {
    fn default() -> Self {
        Self {
            opensubtitles: "https://api.opensubtitles.com/api/v1".into(),
            subdl_api: "https://api.subdl.com/api/v1/subtitles".into(),
            subdl_dl: "https://dl.subdl.com".into(),
            subsynchro: "https://www.subsynchro.com".into(),
            supersubtitles: "https://www.feliratok.eu".into(),
            yify: "https://yifysubtitles.ch".into(),
            gestdown: "https://api.gestdown.info".into(),
            gemini: "https://generativelanguage.googleapis.com/v1beta".into(),
            allow_http_link: false,
        }
    }
}

/// Process-wide subtitle state: provider limiter and token cache, in-memory queues and guards.
pub struct Shared {
    pub limiter: Limiter,
    pub bases: Bases,
    pub http: reqwest::Client,
    /// No redirects: YIFY treats any 3xx as no result.
    pub plain: reqwest::Client,
    pub os_tokens: Mutex<HashMap<String, (String, i64)>>,
    pub sync: sync::Queue,
    pub pacing: translation::Pacing,
    pub gate: translate::Gate,
    pub starting: crate::busy::Claims<String>,
    /// Files a search pass holds right now (a concurrent call returns `[]`).
    pub searching: crate::busy::Claims<i32>,
    progress: Mutex<HashMap<i32, i32>>,
}

impl Shared {
    pub fn new(bases: Bases) -> Self {
        Self {
            limiter: Limiter::default(),
            bases,
            http: crate::outbound::client().clone(),
            plain: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("plain client"),
            os_tokens: Mutex::default(),
            sync: sync::Queue::default(),
            pacing: translation::Pacing::default(),
            gate: translate::Gate::default(),
            starting: crate::busy::Claims::default(),
            searching: crate::busy::Claims::default(),
            progress: Mutex::default(),
        }
    }

    /// The percent of a running translation, absent when none runs.
    pub fn translation_progress(&self, id: i32) -> Option<i32> {
        self.progress
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .copied()
    }

    pub fn set_translation_progress(&self, id: i32, pct: Option<i32>) {
        let mut p = self.progress.lock().unwrap_or_else(|e| e.into_inner());
        match pct {
            Some(v) => p.insert(id, v),
            None => p.remove(&id),
        };
    }
}

impl Default for Shared {
    fn default() -> Self {
        Self::new(Bases::default())
    }
}
pub mod routes_media;

use crate::state::AppState;
use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{delete, get, patch, post},
};
use utoipa::OpenApi;

/// The routes of this domain, merged into the API document by `app::openapi`.
#[derive(OpenApi)]
#[openapi(paths(
    routes_activity::history,
    routes_activity::stats,
    routes_activity::health,
    routes_activity::missing,
    routes_activity::blacklist_list,
    routes_activity::blacklist_add,
    routes_activity::blacklist_remove,
    routes_activity::blacklist_clear,
    routes_providers::rate_limits,
    routes_providers::test_connection,
    routes_providers::create,
    routes_providers::list,
    routes_providers::get_one,
    routes_providers::update,
    routes_providers::remove,
    routes_providers::test,
    routes_providers::stats,
    routes_media::list,
    routes_media::search,
    routes_media::auto,
    routes_media::search_missing,
    routes_media::download,
    routes_media::upload,
    routes_media::remove,
    routes_media::set_language,
    routes_media::validate,
    routes_media::upgrade,
    routes_media::post_process,
    routes_media::ocr,
    routes_media::sync,
    routes_media::sync_queue,
    routes_media::translate,
    translation_providers::available,
    translation_providers::test_connection,
    translation_providers::models,
    translation_providers::create,
    translation_providers::list,
    translation_providers::get_one,
    translation_providers::update,
    translation_providers::remove,
    translation_providers::test,
))]
pub struct Doc;

pub fn router() -> Router<AppState> {
    let upload = post(routes_media::upload)
        .layer(DefaultBodyLimit::max(service::UPLOAD_MAX_BYTES + 64 * 1024));
    Router::new()
        .route("/api/subtitles/history", get(routes_activity::history))
        .route("/api/subtitles/stats", get(routes_activity::stats))
        .route("/api/subtitles/health", get(routes_activity::health))
        .route("/api/subtitles/missing", get(routes_activity::missing))
        .route(
            "/api/subtitles/blacklist",
            get(routes_activity::blacklist_list)
                .post(routes_activity::blacklist_add)
                .delete(routes_activity::blacklist_clear),
        )
        .route(
            "/api/subtitles/blacklist/{id}",
            delete(routes_activity::blacklist_remove),
        )
        .route(
            "/api/subtitles/providers/rate-limits",
            get(routes_providers::rate_limits),
        )
        .route(
            "/api/subtitles/providers/test-connection",
            post(routes_providers::test_connection),
        )
        .route(
            "/api/subtitles/providers",
            get(routes_providers::list).post(routes_providers::create),
        )
        .route(
            "/api/subtitles/providers/{id}",
            get(routes_providers::get_one)
                .put(routes_providers::update)
                .delete(routes_providers::remove),
        )
        .route(
            "/api/subtitles/providers/{id}/test",
            post(routes_providers::test),
        )
        .route(
            "/api/subtitles/providers/{id}/stats",
            get(routes_providers::stats),
        )
        .route(
            "/api/subtitles/translation-providers/available",
            get(translation_providers::available),
        )
        .route(
            "/api/subtitles/translation-providers/test-connection",
            post(translation_providers::test_connection),
        )
        .route(
            "/api/subtitles/translation-providers/models",
            post(translation_providers::models),
        )
        .route(
            "/api/subtitles/translation-providers",
            get(translation_providers::list).post(translation_providers::create),
        )
        .route(
            "/api/subtitles/translation-providers/{id}",
            get(translation_providers::get_one)
                .put(translation_providers::update)
                .delete(translation_providers::remove),
        )
        .route(
            "/api/subtitles/translation-providers/{id}/test",
            post(translation_providers::test),
        )
        .route("/api/media/sync-queue", get(routes_media::sync_queue))
        .route("/api/media/{id}/subtitles", get(routes_media::list))
        .route(
            "/api/media/{id}/subtitles/search",
            get(routes_media::search),
        )
        .route("/api/media/{id}/subtitles/auto", post(routes_media::auto))
        .route(
            "/api/media/{id}/subtitles/search-missing",
            post(routes_media::search_missing),
        )
        .route(
            "/api/media/{id}/subtitles/download",
            post(routes_media::download),
        )
        .route("/api/media/{id}/subtitles/upload", upload)
        .route(
            "/api/media/{id}/subtitles/{subtitleId}",
            delete(routes_media::remove),
        )
        .route(
            "/api/media/{id}/subtitles/{subtitleId}/language",
            patch(routes_media::set_language),
        )
        .route(
            "/api/media/{id}/subtitles/{subtitleId}/validate",
            post(routes_media::validate),
        )
        .route(
            "/api/media/{id}/subtitles/{subtitleId}/upgrade",
            post(routes_media::upgrade),
        )
        .route(
            "/api/media/{id}/subtitles/{subtitleId}/post-process",
            post(routes_media::post_process),
        )
        .route(
            "/api/media/{id}/subtitles/{subtitleId}/ocr",
            post(routes_media::ocr),
        )
        .route(
            "/api/media/{id}/subtitles/{subtitleId}/sync",
            post(routes_media::sync),
        )
        .route(
            "/api/media/{id}/subtitles/{subtitleId}/translate",
            post(routes_media::translate),
        )
}

/// OCR runs and translations in flight at a restart are failed (files rule 27).
pub async fn sweep(db: &sqlx::PgPool) -> sqlx::Result<u64> {
    let n = sqlx::query(
        r#"UPDATE subtitle_files SET status = 'failed', "errorMessage" = 'activity.subtitle_error_interrupted'
           WHERE "providerType" IN ('ocr', 'translated') AND status = 'processing'"#,
    )
    .execute(db)
    .await?
    .rows_affected();
    if n > 0 {
        tracing::warn!("Marked {n} interrupted subtitle run(s) as failed on startup");
    }
    Ok(n)
}

/// The 6 h tick of the search and upgrade passes.
pub fn spawn(st: &AppState) {
    scheduler::spawn_tick(st);
}

//! Playback control plane (`docs/spec/playback-info.md`): playback-info, `info/*`, EDL, session stop,
//! source scans, host hardware and the admin streams and cache routes.
mod burn_in;
mod db;
mod edl;
mod file;
mod hardware;
mod info;
mod preroll;
mod qoe;
mod routes;
mod scan;
pub mod sprite;
mod system;

pub use file::{ResolvedFile, resolve_file};
pub use info::__path_playback_info;
pub use routes::{
    __path_delete_session, __path_edl, __path_effective_settings, __path_gpus, __path_hw_accel,
    __path_qualities, __path_tonemap_algos,
};
pub use system::{
    __path_command, __path_purge_all, __path_purge_file, __path_stats, __path_streams,
};

use crate::{engine::EngineError, http::AppError, state::AppState};
use axum::{
    Router,
    http::StatusCode,
    routing::{delete, get, post},
};
use fliks_domain::edl::EdlCache;
use std::{
    collections::HashSet,
    sync::Mutex,
    time::{Duration, Instant},
};

/// In-process state of the playback plane: nothing here outlives the process.
pub struct Shared {
    hardware: hardware::Hardware,
    edl: Mutex<EdlCache>,
    edl_warned: Mutex<HashSet<String>>,
    scans: scan::Scans,
    booted: Instant,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            hardware: hardware::Hardware::default(),
            edl: Mutex::default(),
            edl_warned: Mutex::default(),
            scans: scan::Scans::default(),
            booted: Instant::now(),
        }
    }
}

/// The control-plane routes; the engine serves every byte route under `/api/stream/:id`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/stream/{mediaFileId}/playback-info",
            post(info::playback_info),
        )
        .route(
            "/api/stream/info/qualities/{mediaFileId}",
            get(routes::qualities),
        )
        .route("/api/stream/info/hw-accel", get(routes::hw_accel))
        .route("/api/stream/info/tonemap-algos", get(routes::tonemap_algos))
        .route(
            "/api/stream/info/effective-settings",
            get(routes::effective_settings),
        )
        .route("/api/stream/info/gpus", get(routes::gpus))
        .route("/api/stream/{mediaFileId}/edl", get(routes::edl))
        .route(
            "/api/stream/sessions/{sessionId}",
            delete(routes::delete_session),
        )
        .route("/api/system/streams", get(system::streams))
        .route(
            "/api/system/streams/{sessionId}/command",
            post(system::command),
        )
        .route(
            "/api/system/transcode-cache",
            get(system::stats).delete(system::purge_all),
        )
        .route(
            "/api/system/transcode-cache/{mediaFileId}",
            delete(system::purge_file),
        )
}

/// Background work of the plane: hardware (re)detection on each engine adoption, the scan backfill.
pub fn spawn(st: &AppState) {
    hardware::spawn(st.clone());
    scan::spawn_backfill(st.clone());
    sprite::spawn_legacy_cleanup();
}

/// An engine failure on a route that does not map it: 503 for the states Nest named, else a 500.
fn engine_err(e: EngineError) -> AppError {
    match e {
        EngineError::NotRunning | EngineError::NoLive => {
            AppError::with_message(StatusCode::SERVICE_UNAVAILABLE, e.to_string())
        }
        e => {
            tracing::error!("engine call failed: {e}");
            AppError::plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

const BACKFILL_EVERY: Duration = Duration::from_secs(60);

#[cfg(test)]
mod tests;

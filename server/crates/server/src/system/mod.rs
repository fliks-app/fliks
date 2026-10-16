//! `/api/system/*` rest (`docs/spec/system.md`): health, restart, version, update, stats, backups, logs.
pub mod backup;
pub mod logs;
mod routes;
mod supervisor;
mod update;

use crate::state::AppState;
use axum::{
    Json, Router,
    routing::{get, post},
};
use serde::Serialize;
use std::{
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};
use utoipa::ToSchema;

pub use routes::*;

/// Process-wide state of these routes.
pub struct Shared {
    update: update::Cache,
    started: Instant,
    restarting: AtomicBool,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            update: update::Cache::default(),
            started: Instant::now(),
            restarting: AtomicBool::new(false),
        }
    }
}

impl Shared {
    /// True once `POST /restart` has begun the shutdown: the process must then exit non-zero.
    pub fn restarting(&self) -> bool {
        self.restarting.load(Ordering::SeqCst)
    }
}

#[derive(Serialize, ToSchema)]
pub struct Liveness {
    ok: bool,
}

/// Unauthenticated; the only route a container healthcheck can call before credentials exist.
#[utoipa::path(get, path = "/api/system/liveness", responses((status = 200, body = Liveness)))]
pub async fn liveness() -> Json<Liveness> {
    Json(Liveness { ok: true })
}

pub fn router() -> Router {
    Router::new().route("/api/system/liveness", get(liveness))
}

pub fn api() -> Router<AppState> {
    Router::new()
        .route("/api/system/health", get(health))
        .route("/api/system/restart", post(restart))
        .route("/api/system/version", get(version))
        .route("/api/system/update", get(update))
        .route("/api/system/stats", get(stats))
        .route("/api/system/backup", post(backup_create))
        .route("/api/system/backups", get(backup_list))
        .route("/api/system/restore", post(backup_restore))
        .route(
            "/api/system/backups/{name}",
            get(backup_download).delete(backup_delete),
        )
        .route("/api/system/logs", get(log_list))
}

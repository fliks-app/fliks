//! The durable job queue (`library-optimize.plan.md`, "Generic job queue" and "Worker protocol"): workers
//! lease `jobs` rows over `/engine/workers/*` and `/engine/jobs/*`. Not `jobs/`, the cron scheduler.
pub(crate) mod api;
mod auth;
mod cleanup;
pub mod commit;
mod enqueue;
pub mod ocr;
pub mod recover;
pub(crate) mod routes;
pub mod settings;
mod store;
mod swap;
mod tokens;
mod trash;
mod words;

use crate::{state::AppState, sync::MutexExt};
use fliks_engine_core::api::WorkerDevice;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::Notify;

pub use api::router;
pub use auth::{Principal, WorkerAuth};
pub use routes::worker_router;
pub use store::boot;

/// A worker instance that said hello; lost at a server restart, the next lease asks it to say hello again.
#[derive(Clone)]
pub struct Worker {
    pub principal: Principal,
    pub engine_version: String,
    pub devices: Vec<WorkerDevice>,
}

#[derive(Default)]
pub struct Shared {
    /// Woken when a job is queued or comes back, so a long-poll answers at once.
    pub wake: Notify,
    workers: Mutex<HashMap<String, Worker>>,
    /// Woken after a backup restore, so `committing` jobs are reviewed at once.
    pub recover: Notify,
    downloads: Mutex<HashMap<i32, Instant>>,
}

/// A `download` resolve younger than this may be a client still reading the file.
const DOWNLOAD_HOLD: Duration = Duration::from_secs(600);

impl Shared {
    pub fn worker(&self, key: &str) -> Option<Worker> {
        self.workers.lock_clean().get(key).cloned()
    }

    pub fn register(&self, key: String, w: Worker) {
        self.workers.lock_clean().insert(key, w);
    }

    pub fn note_download(&self, file: i32) {
        let mut g = self.downloads.lock_clean();
        g.retain(|_, t| t.elapsed() < DOWNLOAD_HOLD);
        g.insert(file, Instant::now());
    }

    pub fn recent_download(&self, file: i32) -> bool {
        self.downloads
            .lock_clean()
            .get(&file)
            .is_some_and(|t| t.elapsed() < DOWNLOAD_HOLD)
    }

    pub fn workers(&self) -> Vec<(String, Worker)> {
        let g = self.workers.lock_clean();
        let mut v: Vec<_> = g.iter().map(|(k, w)| (k.clone(), w.clone())).collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }
}

/// Recovery of `committing` jobs at boot, the lease sweep, the commits, the cleanup and the trash purge.
pub fn spawn(st: &AppState) {
    let st = st.clone();
    tokio::spawn(async move {
        recover::recover(&st, 0.0).await;
        let mut tick = tokio::time::interval(Duration::from_secs(15));
        let mut n: u32 = 0;
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                () = st.queue.recover.notified() => recover::recover(&st, 0.0).await,
            }
            match store::expire(&st.db).await {
                Ok(0) => {}
                Ok(_) => st.queue.wake.notify_waiters(),
                Err(e) => tracing::warn!("job lease sweep failed: {e}"),
            }
            commit::run(&st).await;
            cleanup::staged(&st.db).await;
            n = n.wrapping_add(1);
            if n.is_multiple_of(4) {
                recover::recover(&st, 120.0).await;
            }
            if n.is_multiple_of(240) {
                trash::purge(&st.db).await;
            }
        }
    });
}

#[cfg(test)]
mod commit_tests;
#[cfg(test)]
mod tests;

//! The durable job queue (`library-optimize.plan.md`, "Generic job queue" and "Worker protocol"): workers
//! lease `jobs` rows over `/engine/workers/*` and `/engine/jobs/*`. Not `jobs/`, the cron scheduler.
pub(crate) mod api;
mod auth;
mod cleanup;
mod enqueue;
pub(crate) mod routes;
pub mod settings;
mod store;
mod tokens;

use crate::{state::AppState, sync::MutexExt};
use fliks_engine_core::api::WorkerDevice;
use std::{collections::HashMap, sync::Mutex, time::Duration};
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
}

impl Shared {
    pub fn worker(&self, key: &str) -> Option<Worker> {
        self.workers.lock_clean().get(key).cloned()
    }

    pub fn register(&self, key: String, w: Worker) {
        self.workers.lock_clean().insert(key, w);
    }

    pub fn workers(&self) -> Vec<(String, Worker)> {
        let g = self.workers.lock_clean();
        let mut v: Vec<_> = g.iter().map(|(k, w)| (k.clone(), w.clone())).collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }
}

/// The lease expiry sweep and the `staged` cleanup, every 15 s.
pub fn spawn(st: &AppState) {
    let st = st.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(15));
        loop {
            tick.tick().await;
            match store::expire(&st.db).await {
                Ok(0) => {}
                Ok(_) => st.queue.wake.notify_waiters(),
                Err(e) => tracing::warn!("job lease sweep failed: {e}"),
            }
            cleanup::staged(&st.db).await;
        }
    });
}

#[cfg(test)]
mod tests;

//! The durable job queue (`library-optimize.plan.md`, "Generic job queue" and "Worker protocol"): workers
//! lease `jobs` rows over `/engine/workers/*` and `/engine/jobs/*`. Not `jobs/`, the cron scheduler.
pub(crate) mod api;
mod auth;
mod auto;
mod cleanup;
pub mod commit;
pub(crate) mod control;
mod enqueue;
mod estimate;
pub mod ocr;
pub mod recover;
pub(crate) mod remote;
pub(crate) mod routes;
pub mod settings;
mod store;
mod swap;
mod tokens;
mod trash;
mod watch;
mod words;

use crate::{
    optimize::codec::{Capabilities, Target},
    state::AppState,
    sync::MutexExt,
};
use fliks_engine_core::api::WorkerDevice;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::Notify;

pub use api::router;
pub use auth::{Principal, WorkerAuth};
pub use enqueue::{Outcome, queue_new};
pub use estimate::{PerLevelOpt, speeds};
pub use remote::grant_answer;
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
    /// Last request of each instance; an instance silent for `LIVE` is not counted.
    seen: Mutex<HashMap<String, Instant>>,
    /// Woken after a backup restore, so `committing` jobs are reviewed at once.
    pub recover: Notify,
    downloads: Mutex<HashMap<i32, Instant>>,
    grants: Mutex<HashMap<String, remote::Grant>>,
    uploads: Mutex<HashMap<(i64, i32), remote::Slot>>,
    /// Files whose OCR just ended; their queueing runs in the queue's own task.
    ocr_ended: Mutex<Vec<i32>>,
    ocr_wake: Notify,
}

/// A `download` resolve younger than this may be a client still reading the file.
const DOWNLOAD_HOLD: Duration = Duration::from_secs(600);

/// An instance that has not said hello, leased or beaten for this long is offline.
pub const LIVE: Duration = Duration::from_secs(180);

impl Shared {
    /// The registered instance; the call counts as a sign of life.
    pub fn worker(&self, key: &str) -> Option<Worker> {
        let w = self.workers.lock_clean().get(key).cloned()?;
        self.seen
            .lock_clean()
            .insert(key.to_owned(), Instant::now());
        Some(w)
    }

    pub fn register(&self, key: String, w: Worker) {
        self.seen.lock_clean().insert(key.clone(), Instant::now());
        self.workers.lock_clean().insert(key, w);
    }

    /// The local instances seen recently: the only ones that get jobs.
    fn live_local(&self) -> Vec<Worker> {
        let seen = self.seen.lock_clean();
        self.workers
            .lock_clean()
            .iter()
            .filter(|(k, w)| {
                w.principal == Principal::Local && seen.get(*k).is_some_and(|t| t.elapsed() < LIVE)
            })
            .map(|(_, w)| w.clone())
            .collect()
    }

    pub fn note_ocr_ended(&self, file: i32) {
        self.ocr_ended.lock_clean().push(file);
        self.ocr_wake.notify_one();
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

    /// What the registered workers can encode; the main engine decodes AV1 in hardware when a local worker device does.
    pub fn capabilities(&self) -> Capabilities {
        let g = self.live_local();
        let mut encodable = Vec::new();
        for t in [Target::Hevc, Target::Av1] {
            let any = g.iter().any(|w| {
                w.devices.iter().any(|d| {
                    routes::codecs_of(&d.encoders)
                        .iter()
                        .any(|c| c == t.as_str())
                })
            });
            if any {
                encodable.push(t);
            }
        }
        let hw = ["cuvid", "nvdec", "qsv", "vaapi", "amf", "videotoolbox"];
        let main_decodes_av1_hw = g.iter().any(|w| {
            w.devices.iter().any(|d| {
                d.decoders.iter().any(|n| {
                    let n = n.to_lowercase();
                    n.contains("av1") && hw.iter().any(|h| n.contains(h))
                })
            })
        });
        Capabilities {
            encodable,
            main_decodes_av1_hw,
        }
    }

    /// Codecs some registered device encodes in hardware.
    pub fn hardware_codecs(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .live_local()
            .iter()
            .flat_map(|w| w.devices.iter())
            .flat_map(|d| routes::codec_split(&d.encoders).0)
            .collect();
        out.sort();
        out.dedup();
        out
    }

    /// Every instance with the time since its last sign of life.
    pub fn workers(&self) -> Vec<(String, Worker, Duration)> {
        let g = self.workers.lock_clean();
        let seen = self.seen.lock_clean();
        let mut v: Vec<_> = g
            .iter()
            .map(|(k, w)| {
                let silent = seen.get(k).map_or(LIVE, Instant::elapsed);
                (k.clone(), w.clone(), silent)
            })
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }
}

/// The optimizer's events go to the users who manage libraries, not to every connection.
pub(crate) async fn emit_managers(st: &AppState, ev: crate::events::SseEvent) {
    let ids = sqlx::query_scalar::<_, i32>(
        r#"SELECT u.id FROM users u LEFT JOIN roles r ON r.id = u."roleId"
           WHERE u.enabled AND (u."isAdmin" OR r.permissions LIKE '%"manage:all"%'
             OR r.permissions LIKE '%"settings.access"%')"#,
    )
    .fetch_all(&st.db)
    .await
    .unwrap_or_default();
    if !ids.is_empty() {
        st.hub.emit_to_users(&ids, ev);
    }
}

/// Recovery of `committing` jobs at boot, the lease sweep, the commits, the cleanup and the trash purge.
pub fn spawn(st: &AppState) {
    watch::spawn(st);
    let st2 = st.clone();
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
            remote::sweep(&st).await;
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
    let st3 = st2.clone();
    tokio::spawn(async move {
        loop {
            st3.queue.ocr_wake.notified().await;
            let files = std::mem::take(&mut *st3.queue.ocr_ended.lock_clean());
            for f in files {
                enqueue::after_ocr(&st3, f).await;
            }
        }
    });
    let st = st2;
    tokio::spawn(async move {
        let mut hour = tokio::time::interval(Duration::from_secs(3600));
        loop {
            hour.tick().await;
            auto::hourly(&st).await;
        }
    });
}

#[cfg(test)]
mod auto_tests;
#[cfg(test)]
mod commit_tests;
#[cfg(test)]
mod remote_tests;
#[cfg(test)]
mod tests;

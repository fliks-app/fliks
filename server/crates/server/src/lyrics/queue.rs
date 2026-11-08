//! The one lyrics fetch queue: a few workers for the whole server, so a big scan does not flood the providers
//! (`docs/spec/music.md` rule 69).
use super::providers;
use crate::state::AppState;
use fliks_domain::metadata::limiter::Priority;
use std::{
    collections::{HashSet, VecDeque},
    sync::Mutex,
    time::Duration,
};

const WORKERS: usize = 2;
const FIRST_SWEEP: Duration = Duration::from_secs(300);
const SWEEP_EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Default)]
struct Inner {
    pending: VecDeque<i32>,
    /// Pending or running, so a track is queued once.
    queued: HashSet<i32>,
    workers: usize,
}

#[derive(Default)]
pub struct Queue(Mutex<Inner>);

impl Queue {
    /// Nothing waits and no worker runs.
    pub fn idle(&self) -> bool {
        let g = self.0.lock().unwrap_or_else(|e| e.into_inner());
        g.queued.is_empty() && g.workers == 0
    }
}

/// Queues tracks for `providers::fetch` and starts the workers a backlog needs.
pub fn enqueue(st: &AppState, items: impl IntoIterator<Item = i32>) {
    let spawn = {
        let mut g = st.lyrics.0.lock().unwrap_or_else(|e| e.into_inner());
        for i in items {
            if g.queued.insert(i) {
                g.pending.push_back(i);
            }
        }
        let spawn = WORKERS.saturating_sub(g.workers).min(g.pending.len());
        g.workers += spawn;
        spawn
    };
    for _ in 0..spawn {
        tokio::spawn(work(st.clone()));
    }
}

async fn work(st: AppState) {
    loop {
        let next = {
            let mut g = st.lyrics.0.lock().unwrap_or_else(|e| e.into_inner());
            let next = g.pending.pop_front();
            if next.is_none() {
                g.workers -= 1;
            }
            next
        };
        let Some(item) = next else { return };
        if let Err(e) = providers::fetch(&st, item, false, Priority::Background).await {
            tracing::warn!("lyrics of track #{item} not fetched: {e}");
        }
        st.lyrics
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .queued
            .remove(&item);
    }
}

/// Queues the tracks the providers failed on or never answered, now and every few hours.
pub fn spawn_sweep(st: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(FIRST_SWEEP).await;
        loop {
            providers::enqueue_missing(&st, None).await;
            tokio::time::sleep(SWEEP_EVERY).await;
        }
    });
}

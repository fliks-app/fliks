//! Keeps presence in step with the engine's feed (`presence.md` rules 13-17).
use super::Presence;
use crate::engine::{Engine, Feed};
use fliks_engine_core::api::EngineEvent;
use tokio::sync::broadcast::{Receiver, error::RecvError};

/// Subscribes before the engine starts, so the first `Resync` is never missed. Runs for the process.
pub fn spawn(presence: Presence, engine: Engine) {
    let rx = engine.subscribe();
    tokio::spawn(run(rx, presence, move || engine.resync_events()));
}

/// A lagged receiver lost events: `on_lag` makes the engine reconnect, whose `Resync` repairs it.
pub(super) async fn run(mut rx: Receiver<Feed>, presence: Presence, on_lag: impl Fn()) {
    loop {
        match rx.recv().await {
            Ok(feed) => apply(&presence, &feed),
            Err(RecvError::Lagged(n)) => {
                tracing::warn!("presence feed lagged by {n}, resyncing");
                on_lag();
            }
            Err(RecvError::Closed) => return,
        }
    }
}

pub(super) fn apply(presence: &Presence, feed: &Feed) {
    match feed {
        Feed::Resync(snaps, listed_at) => presence.resync(snaps, *listed_at),
        Feed::Event(ev) => match &**ev {
            EngineEvent::SessionOpened { session } => {
                presence.restore(session);
            }
            EngineEvent::SessionEnded { session_id, .. } => {
                presence.stop(session_id);
            }
            _ => {}
        },
    }
}

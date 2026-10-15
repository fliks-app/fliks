//! Keeps presence in step with the engine's feed (`presence.md` rules 13-17).
use super::Presence;
use crate::{
    engine::{Engine, Feed},
    qoe::Qoe,
};
use fliks_engine_core::api::EngineEvent;
use tokio::sync::broadcast::{Receiver, error::RecvError};

/// Subscribes before the engine starts, so the first `Resync` is never missed. Runs for the process.
pub fn spawn(presence: Presence, engine: Engine, qoe: Qoe) {
    let rx = engine.subscribe();
    let on_end = move |sid: &str| qoe.session_ended(sid);
    tokio::spawn(run(rx, presence, on_end, move || engine.resync_events()));
}

/// A lagged receiver lost events: `on_lag` makes the engine reconnect, whose `Resync` repairs it.
/// `on_end` hears every session that ended or was dropped as an orphan (QoE finalizes its tracker).
pub(super) async fn run(
    mut rx: Receiver<Feed>,
    presence: Presence,
    on_end: impl Fn(&str),
    on_lag: impl Fn(),
) {
    loop {
        match rx.recv().await {
            Ok(feed) => apply(&presence, &feed).iter().for_each(|sid| on_end(sid)),
            Err(RecvError::Lagged(n)) => {
                tracing::warn!("presence feed lagged by {n}, resyncing");
                on_lag();
            }
            Err(RecvError::Closed) => return,
        }
    }
}

/// The sids that left presence.
pub(super) fn apply(presence: &Presence, feed: &Feed) -> Vec<String> {
    match feed {
        Feed::Resync(snaps, listed_at) => presence.resync(snaps, *listed_at),
        Feed::Event(ev) => match &**ev {
            EngineEvent::SessionOpened { session } => {
                presence.restore(session);
                vec![]
            }
            EngineEvent::SessionEnded { session_id, .. } => {
                presence.stop(session_id);
                vec![session_id.clone()]
            }
            _ => vec![],
        },
    }
}

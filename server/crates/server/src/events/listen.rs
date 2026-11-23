//! The one subscriber loop of the in-process feeds (`docs/spec/events-hub.md`, In-process subscribers).
use tokio::sync::broadcast::{Receiver, error::RecvError};

/// Runs `on_event` for every item until the channel closes. A lagged receiver lost events, so
/// `on_lag(lost)` runs the subscriber's reconcile (or nothing, where its spec says the feed is lossy).
pub async fn listen<T: Clone>(
    name: &str,
    mut rx: Receiver<T>,
    mut on_event: impl FnMut(&T),
    on_lag: impl Fn(u64),
) {
    loop {
        match rx.recv().await {
            Ok(ev) => on_event(&ev),
            Err(RecvError::Lagged(n)) => {
                tracing::warn!("{name} lagged by {n}, reconciling");
                on_lag(n);
            }
            Err(RecvError::Closed) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn a_lag_runs_the_reconcile_then_the_loop_carries_on() {
        let (tx, rx) = tokio::sync::broadcast::channel(2);
        for i in 0..5 {
            tx.send(i).unwrap();
        }
        drop(tx);
        let (lags, seen) = (AtomicUsize::new(0), std::cell::RefCell::new(vec![]));
        listen(
            "test feed",
            rx,
            |i| seen.borrow_mut().push(*i),
            |n| {
                lags.fetch_add(n as usize, Ordering::SeqCst);
            },
        )
        .await;
        assert_eq!(lags.load(Ordering::SeqCst), 3, "on_lag gets the lost count");
        assert_eq!(*seen.borrow(), [3, 4]);
    }
}

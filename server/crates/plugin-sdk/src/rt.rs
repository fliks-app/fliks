//! Single-threaded async runtime over `wasi:io/poll` (the `wstd` reactor) and export budgets
//! (SDK-5). Futures run inside one [`block_on`] per export; dropping one drops its pollables.

use std::future::Future;
use std::time::{Duration, Instant};

pub use futures_util::future::join_all;
pub use futures_util::stream::{FuturesUnordered, StreamExt};
pub use wstd::runtime::{Task, block_on};

/// Runs `fut` on the current [`block_on`] (panics outside one), which waits for a detached task
/// before it returns; dropping the [`Task`] cancels it.
pub fn spawn_local<F>(fut: F) -> Task<F::Output>
where
    F: Future + 'static,
    F::Output: 'static,
{
    wstd::runtime::spawn(fut)
}

pub async fn sleep(d: Duration) {
    wstd::task::sleep(d.into()).await;
}

/// `None` once `d` elapsed first; `fut` is then dropped, which abandons its requests.
pub async fn timeout<F: Future>(d: Duration, fut: F) -> Option<F::Output> {
    use wstd::future::FutureExt;
    fut.timeout(wstd::time::Duration::from(d)).await.ok()
}

/// Guest budgets per export, a margin under the host deadlines of `plugins.md` rule 43.
pub mod budgets {
    use std::time::Duration;
    pub const HTTP: Duration = Duration::from_secs(150);
    pub const EVENT: Duration = Duration::from_secs(50);
    pub const SCHEDULED: Duration = Duration::from_secs(4 * 60);
    pub const JOB: Duration = Duration::from_secs(50 * 60);
}

/// A monotonic deadline that work below an export shares.
#[derive(Clone, Copy, Debug)]
pub struct Budget {
    end: Instant,
}

impl Budget {
    pub fn new(d: Duration) -> Budget {
        Budget {
            end: Instant::now() + d,
        }
    }

    /// What the host still allows the current export (`deadline-remaining-ms`).
    pub fn host() -> Budget {
        Budget::new(Duration::from_millis(crate::host::deadline_remaining_ms()))
    }

    pub fn remaining(&self) -> Duration {
        self.end.saturating_duration_since(Instant::now())
    }

    pub fn expired(&self) -> bool {
        self.remaining().is_zero()
    }

    /// `fraction` (clamped to 0..=1) of what remains, e.g. one indexer's share of a search.
    pub fn child(&self, fraction: f64) -> Budget {
        let now = Instant::now();
        let left = self.end.saturating_duration_since(now);
        Budget {
            end: now + left.mul_f64(fraction.clamp(0.0, 1.0)),
        }
    }

    /// `d`, cut to what remains: a request timeout that cannot outlive the budget.
    pub fn cap(&self, d: Duration) -> Duration {
        d.min(self.remaining())
    }
}

#[cfg(test)]
mod tests {
    use super::Budget;
    use std::time::Duration;

    #[test]
    fn budget_children_and_expiry() {
        let b = Budget::new(Duration::from_secs(10));
        assert!(!b.expired());
        assert!(b.remaining() > Duration::from_secs(9));
        let c = b.child(0.5);
        assert!(c.remaining() <= Duration::from_secs(5) && c.remaining() > Duration::from_secs(4));
        assert!(b.child(2.0).end <= b.end);
        assert_eq!(b.cap(Duration::from_secs(1)), Duration::from_secs(1));
        assert!(b.cap(Duration::from_secs(60)) <= Duration::from_secs(10));

        let short = Budget::new(Duration::from_millis(20));
        std::thread::sleep(Duration::from_millis(30));
        assert!(short.expired());
        assert_eq!(short.remaining(), Duration::ZERO);
        assert!(short.child(0.5).expired());
    }
}

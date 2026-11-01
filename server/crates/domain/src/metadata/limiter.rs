//! Per-provider rate limiter (`metadata-orchestrator.md` rules 12-16): two token buckets, a pause and a
//! daily quota; the clock is injected as milliseconds.

/// The longest a `Retry-After` can pause the limiter.
pub const MAX_PAUSE_MS: u64 = 300_000;
const BACKOFF_START_MS: u64 = 1_000;
const BACKOFF_MAX_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    /// A person is waiting for the answer.
    Interactive,
    Background,
}

/// What a provider declares; `background_share` is the part of the rate the background side may use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    pub rate_per_sec: f64,
    pub burst: u32,
    pub daily_quota: Option<u32>,
    pub background_share: f64,
}

impl Limits {
    pub fn new(rate_per_sec: f64, burst: u32) -> Self {
        Self {
            rate_per_sec,
            burst,
            daily_quota: None,
            background_share: 0.75,
        }
    }
}

/// Milliseconds until a call may go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WaitMs(pub u64);

#[derive(Debug, Clone)]
struct Bucket {
    per_ms: f64,
    burst: f64,
    tokens: f64,
    at: u64,
}

impl Bucket {
    fn new(rate_per_sec: f64, burst: u32) -> Self {
        let burst = f64::from(burst.max(1));
        Self {
            per_ms: rate_per_sec.max(0.001) / 1000.0,
            burst,
            tokens: burst,
            at: 0,
        }
    }

    fn refill(&mut self, now: u64) {
        let dt = now.saturating_sub(self.at);
        self.tokens = (self.tokens + dt as f64 * self.per_ms).min(self.burst);
        self.at = self.at.max(now);
    }

    fn wait(&self) -> u64 {
        let missing = 1.0 - self.tokens;
        if missing <= 1e-9 {
            0
        } else {
            (missing / self.per_ms).ceil() as u64
        }
    }
}

#[derive(Debug, Clone)]
pub struct Limiter {
    shared: Bucket,
    background: Bucket,
    daily_quota: Option<u32>,
    paused_until: u64,
    backoff_ms: u64,
    day: u64,
    used: u32,
    spent_day: Option<u64>,
}

impl Limiter {
    pub fn new(l: Limits) -> Self {
        let share = l.background_share.clamp(0.01, 1.0);
        Self {
            shared: Bucket::new(l.rate_per_sec, l.burst),
            background: Bucket::new(l.rate_per_sec * share, l.burst),
            daily_quota: l.daily_quota,
            paused_until: 0,
            backoff_ms: 0,
            day: 0,
            used: 0,
            spent_day: None,
        }
    }

    /// Takes a token (two for a background call), or says how long to wait; nothing is taken then.
    pub fn take(&mut self, now: u64, priority: Priority) -> Result<(), WaitMs> {
        self.shared.refill(now);
        self.background.refill(now);
        if now < self.paused_until {
            return Err(WaitMs(self.paused_until - now));
        }
        let mut wait = self.shared.wait();
        if priority == Priority::Background {
            wait = wait.max(self.background.wait());
        }
        if wait > 0 {
            return Err(WaitMs(wait));
        }
        self.shared.tokens -= 1.0;
        if priority == Priority::Background {
            self.background.tokens -= 1.0;
        }
        Ok(())
    }

    /// Stops every taker until `until`, at most `MAX_PAUSE_MS` from `now`.
    pub fn pause_until(&mut self, now: u64, until: u64) {
        self.paused_until = self.paused_until.max(until.min(now + MAX_PAUSE_MS));
    }

    /// Pauses for 1 s, then twice as long on each consecutive call up to 60 s; returns the delay.
    pub fn backoff(&mut self, now: u64) -> u64 {
        self.backoff_ms = match self.backoff_ms {
            0 => BACKOFF_START_MS,
            b => (b * 2).min(BACKOFF_MAX_MS),
        };
        self.pause_until(now, now + self.backoff_ms);
        self.backoff_ms
    }

    pub fn reset_backoff(&mut self) {
        self.backoff_ms = 0;
    }

    /// Calls left on UTC `day`; `None` when the provider has no quota.
    pub fn quota_left(&self, day: u64) -> Option<u32> {
        let quota = self.daily_quota?;
        if self.spent_day == Some(day) {
            return Some(0);
        }
        Some(if self.day == day {
            quota.saturating_sub(self.used)
        } else {
            quota
        })
    }

    pub fn count_call(&mut self, day: u64) {
        if self.day != day {
            self.day = day;
            self.used = 0;
        }
        self.used = self.used.saturating_add(1);
    }

    /// The provider said the quota of `day` is spent.
    pub fn on_quota_exhausted(&mut self, day: u64) {
        self.spent_day = Some(day);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Priority::*;

    fn limiter(rate: f64, burst: u32, share: f64) -> Limiter {
        Limiter::new(Limits {
            background_share: share,
            ..Limits::new(rate, burst)
        })
    }

    #[test]
    fn a_burst_then_the_steady_rate() {
        let mut l = limiter(10.0, 3, 1.0);
        for _ in 0..3 {
            assert_eq!(l.take(0, Interactive), Ok(()));
        }
        assert_eq!(l.take(0, Interactive), Err(WaitMs(100)));
        assert_eq!(l.take(50, Interactive), Err(WaitMs(50)));
        assert_eq!(l.take(100, Interactive), Ok(()));
        assert_eq!(l.take(100, Interactive), Err(WaitMs(100)));
        assert_eq!(l.take(10_000, Interactive), Ok(()));
        for _ in 0..2 {
            assert_eq!(l.take(10_000, Interactive), Ok(()));
        }
        assert_eq!(l.take(10_000, Interactive), Err(WaitMs(100)));
    }

    #[test]
    fn the_background_is_capped_at_its_share_while_interactive_passes() {
        let mut l = limiter(10.0, 4, 0.5);
        for _ in 0..4 {
            assert_eq!(l.take(0, Background), Ok(()));
        }
        // 1 shared token and half a background one have come back.
        assert_eq!(l.take(100, Background), Err(WaitMs(100)));
        assert_eq!(l.take(100, Interactive), Ok(()));
        assert_eq!(l.take(200, Background), Ok(()));
    }

    #[test]
    fn a_hundred_background_calls_stay_under_the_rate() {
        let mut l = limiter(40.0, 40, 0.75);
        let mut now = 0;
        for _ in 0..100 {
            while let Err(WaitMs(w)) = l.take(now, Background) {
                now += w;
            }
        }
        // 40 in the burst, 60 more at 30 per second.
        assert!(now >= 2_000, "{now}");
    }

    #[test]
    fn a_pause_holds_everyone_and_is_capped() {
        let mut l = limiter(10.0, 3, 1.0);
        l.pause_until(1_000, 3_000);
        assert_eq!(l.take(1_000, Interactive), Err(WaitMs(2_000)));
        assert_eq!(l.take(3_000, Interactive), Ok(()));
        l.pause_until(3_000, 10_000_000);
        assert_eq!(l.take(3_000, Background), Err(WaitMs(MAX_PAUSE_MS)));
        l.pause_until(3_000, 4_000);
        assert_eq!(l.take(3_000, Background), Err(WaitMs(MAX_PAUSE_MS)));
    }

    #[test]
    fn the_backoff_doubles_to_a_cap_and_resets() {
        let mut l = limiter(10.0, 3, 1.0);
        let got: Vec<u64> = (0..8).map(|_| l.backoff(0)).collect();
        assert_eq!(
            got,
            [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]
        );
        l.reset_backoff();
        assert_eq!(l.backoff(0), 1_000);
    }

    #[test]
    fn a_spent_quota_is_back_at_the_next_utc_midnight() {
        let mut l = Limiter::new(Limits {
            daily_quota: Some(2),
            ..Limits::new(10.0, 3)
        });
        assert_eq!(l.quota_left(5), Some(2));
        l.count_call(5);
        l.count_call(5);
        assert_eq!(l.quota_left(5), Some(0));
        assert_eq!(l.quota_left(6), Some(2));
        l.count_call(6);
        assert_eq!(l.quota_left(6), Some(1));
        l.on_quota_exhausted(6);
        assert_eq!(l.quota_left(6), Some(0));
        assert_eq!(l.quota_left(7), Some(2));
    }

    #[test]
    fn no_quota_is_no_limit() {
        let mut l = limiter(10.0, 3, 1.0);
        l.count_call(1);
        assert_eq!(l.quota_left(1), None);
    }
}

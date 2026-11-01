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

/// Why a call may not go now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    /// Milliseconds until a token (or the end of a pause) is available.
    Wait(u64),
    /// The daily quota is spent for the rest of the UTC day.
    QuotaSpent,
}

#[derive(Debug, Clone)]
struct Bucket {
    per_ms: f64,
    burst: f64,
    tokens: f64,
    at: u64,
}

impl Bucket {
    fn new(rate_per_sec: f64, burst: u32) -> Self {
        let mut b = Self {
            per_ms: 0.0,
            burst: 0.0,
            tokens: 0.0,
            at: 0,
        };
        b.retune(rate_per_sec, burst);
        b.tokens = b.burst;
        b
    }

    fn retune(&mut self, rate_per_sec: f64, burst: u32) {
        self.burst = f64::from(burst.max(1));
        self.per_ms = rate_per_sec.max(0.001) / 1000.0;
        self.tokens = self.tokens.min(self.burst);
    }

    fn refill(&mut self, now: u64) {
        let dt = now.saturating_sub(self.at);
        self.tokens = (self.tokens + dt as f64 * self.per_ms).min(self.burst);
        self.at = self.at.max(now);
    }

    fn empty(&mut self, now: u64) {
        self.tokens = 0.0;
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
    limits: Limits,
    shared: Bucket,
    background: Bucket,
    paused_until: u64,
    backoff_ms: u64,
    day: u64,
    used: u32,
    spent_day: Option<u64>,
}

fn background_rate(l: &Limits) -> f64 {
    l.rate_per_sec * l.background_share.clamp(0.01, 1.0)
}

impl Limiter {
    pub fn new(l: Limits) -> Self {
        Self {
            limits: l,
            shared: Bucket::new(l.rate_per_sec, l.burst),
            background: Bucket::new(background_rate(&l), l.burst),
            paused_until: 0,
            backoff_ms: 0,
            day: 0,
            used: 0,
            spent_day: None,
        }
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// Changes the limits of a running limiter; the tokens, the pause and the day counter stay.
    pub fn set_limits(&mut self, l: Limits) {
        self.limits = l;
        self.shared.retune(l.rate_per_sec, l.burst);
        self.background.retune(background_rate(&l), l.burst);
    }

    /// Takes a token (two for a background call) and counts the call against the quota of `day`, or
    /// says why not; nothing is taken then.
    pub fn take(&mut self, now: u64, day: u64, priority: Priority) -> Result<(), Refused> {
        if self.quota_left(day) == Some(0) {
            return Err(Refused::QuotaSpent);
        }
        self.shared.refill(now);
        self.background.refill(now);
        if now < self.paused_until {
            return Err(Refused::Wait(self.paused_until - now));
        }
        let mut wait = self.shared.wait();
        if priority == Priority::Background {
            wait = wait.max(self.background.wait());
        }
        if wait > 0 {
            return Err(Refused::Wait(wait));
        }
        self.shared.tokens -= 1.0;
        if priority == Priority::Background {
            self.background.tokens -= 1.0;
        }
        if self.day != day {
            self.day = day;
            self.used = 0;
        }
        self.used = self.used.saturating_add(1);
        Ok(())
    }

    /// Stops every taker until `until`, at most `MAX_PAUSE_MS` from `now`, and empties the buckets so
    /// the pause does not end on a burst.
    pub fn pause_until(&mut self, now: u64, until: u64) {
        self.paused_until = self.paused_until.max(until.min(now + MAX_PAUSE_MS));
        self.shared.empty(now);
        self.background.empty(now);
    }

    /// Pauses for 1 s, then twice as long on each consecutive throttle up to 60 s; returns the delay.
    /// A throttle inside a pause that is already running costs no step.
    pub fn backoff(&mut self, now: u64) -> u64 {
        if now < self.paused_until {
            return self.paused_until - now;
        }
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
        if self.spent_day == Some(day) {
            return Some(0);
        }
        let quota = self.limits.daily_quota?;
        Some(if self.day == day {
            quota.saturating_sub(self.used)
        } else {
            quota
        })
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

    const DAY: u64 = 5;

    fn limiter(rate: f64, burst: u32, share: f64) -> Limiter {
        Limiter::new(Limits {
            background_share: share,
            ..Limits::new(rate, burst)
        })
    }

    fn take(l: &mut Limiter, now: u64, p: Priority) -> Result<(), Refused> {
        l.take(now, DAY, p)
    }

    #[test]
    fn a_burst_then_the_steady_rate() {
        let mut l = limiter(10.0, 3, 1.0);
        for _ in 0..3 {
            assert_eq!(take(&mut l, 0, Interactive), Ok(()));
        }
        assert_eq!(take(&mut l, 0, Interactive), Err(Refused::Wait(100)));
        assert_eq!(take(&mut l, 50, Interactive), Err(Refused::Wait(50)));
        assert_eq!(take(&mut l, 100, Interactive), Ok(()));
        assert_eq!(take(&mut l, 100, Interactive), Err(Refused::Wait(100)));
        for _ in 0..3 {
            assert_eq!(take(&mut l, 10_000, Interactive), Ok(()));
        }
        assert_eq!(take(&mut l, 10_000, Interactive), Err(Refused::Wait(100)));
    }

    #[test]
    fn the_background_is_capped_at_its_share_while_interactive_passes() {
        let mut l = limiter(10.0, 4, 0.5);
        for _ in 0..4 {
            assert_eq!(take(&mut l, 0, Background), Ok(()));
        }
        // 1 shared token and half a background one have come back.
        assert_eq!(take(&mut l, 100, Background), Err(Refused::Wait(100)));
        assert_eq!(take(&mut l, 100, Interactive), Ok(()));
        assert_eq!(take(&mut l, 200, Background), Ok(()));
    }

    #[test]
    fn a_hundred_background_calls_stay_under_the_rate() {
        let mut l = limiter(40.0, 40, 0.75);
        let mut now = 0;
        for _ in 0..100 {
            while let Err(Refused::Wait(w)) = take(&mut l, now, Background) {
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
        assert_eq!(take(&mut l, 1_000, Interactive), Err(Refused::Wait(2_000)));
        assert_eq!(take(&mut l, 3_000, Interactive), Ok(()));
        l.pause_until(3_000, 10_000_000);
        let capped = Err(Refused::Wait(MAX_PAUSE_MS));
        assert_eq!(take(&mut l, 3_000, Background), capped);
        l.pause_until(3_000, 4_000);
        assert_eq!(take(&mut l, 3_000, Background), capped);
    }

    #[test]
    fn a_pause_does_not_end_on_a_burst() {
        let mut l = limiter(10.0, 3, 1.0);
        l.pause_until(0, 100);
        assert_eq!(take(&mut l, 100, Interactive), Ok(()));
        assert_eq!(take(&mut l, 100, Interactive), Err(Refused::Wait(100)));
    }

    #[test]
    fn the_backoff_doubles_to_a_cap_and_resets() {
        let mut l = limiter(10.0, 3, 1.0);
        let mut now = 0;
        let got: Vec<u64> = (0..8)
            .map(|_| {
                let d = l.backoff(now);
                now += d;
                d
            })
            .collect();
        assert_eq!(
            got,
            [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]
        );
        l.reset_backoff();
        assert_eq!(l.backoff(now), 1_000);
    }

    #[test]
    fn throttles_inside_one_pause_cost_one_step() {
        let mut l = limiter(10.0, 3, 1.0);
        assert_eq!(l.backoff(0), 1_000);
        assert_eq!(l.backoff(0), 1_000);
        assert_eq!(l.backoff(400), 600);
        assert_eq!(l.backoff(1_000), 2_000);
    }

    #[test]
    fn a_spent_quota_is_back_at_the_next_utc_midnight() {
        let mut l = Limiter::new(Limits {
            daily_quota: Some(2),
            ..Limits::new(1000.0, 10)
        });
        assert_eq!(l.quota_left(5), Some(2));
        assert_eq!(l.take(0, 5, Interactive), Ok(()));
        assert_eq!(l.take(0, 5, Background), Ok(()));
        assert_eq!(l.quota_left(5), Some(0));
        assert_eq!(l.take(0, 5, Interactive), Err(Refused::QuotaSpent));
        assert_eq!(l.take(0, 6, Interactive), Ok(()));
        assert_eq!(l.quota_left(6), Some(1));
        l.on_quota_exhausted(6);
        assert_eq!(l.take(0, 6, Interactive), Err(Refused::QuotaSpent));
        assert_eq!(l.quota_left(7), Some(2));
    }

    #[test]
    fn a_refused_call_is_not_counted() {
        let mut l = Limiter::new(Limits {
            daily_quota: Some(5),
            ..Limits::new(10.0, 1)
        });
        assert_eq!(l.take(0, 5, Interactive), Ok(()));
        assert_eq!(l.take(0, 5, Interactive), Err(Refused::Wait(100)));
        assert_eq!(l.quota_left(5), Some(4));
    }

    #[test]
    fn no_quota_is_no_limit() {
        let mut l = limiter(10.0, 3, 1.0);
        assert_eq!(l.take(0, 1, Interactive), Ok(()));
        assert_eq!(l.quota_left(1), None);
        l.on_quota_exhausted(1);
        assert_eq!(l.take(0, 1, Interactive), Err(Refused::QuotaSpent));
        assert_eq!(l.quota_left(2), None);
    }

    #[test]
    fn new_limits_apply_to_a_running_limiter() {
        let mut l = limiter(10.0, 5, 1.0);
        l.set_limits(Limits::new(1.0, 2));
        assert_eq!(l.limits(), Limits::new(1.0, 2));
        assert_eq!(take(&mut l, 0, Interactive), Ok(()));
        assert_eq!(take(&mut l, 0, Interactive), Ok(()));
        assert_eq!(take(&mut l, 0, Interactive), Err(Refused::Wait(1_000)));
    }
}

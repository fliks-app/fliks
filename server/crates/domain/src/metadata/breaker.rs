//! Consecutive-failure circuit breaker (`metadata.md` rule 18); the clock is injected as epoch milliseconds.

/// What an upstream call came back as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    /// No response, HTTP 429 or `>= 500`.
    Transient,
    /// Any other 4xx: a real answer that neither counts nor resets.
    Client4xx,
}

impl Outcome {
    pub fn of_status(status: u16) -> Self {
        match status {
            429 | 500.. => Self::Transient,
            400..=499 => Self::Client4xx,
            _ => Self::Ok,
        }
    }
}

/// What a recorded outcome changed, for the caller's log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    None,
    Opened,
    Recovered,
}

#[derive(Debug, Clone)]
pub struct Breaker {
    threshold: u32,
    cooldown_ms: u64,
    pub failures: u32,
    pub open_until: u64,
}

impl Breaker {
    pub fn new(threshold: u32, cooldown_ms: u64) -> Self {
        Self {
            threshold,
            cooldown_ms,
            failures: 0,
            open_until: 0,
        }
    }

    /// False while open; the rejection itself counts as a transient failure, without reopening.
    pub fn allow(&mut self, now: u64) -> bool {
        if now < self.open_until {
            self.record(now, Outcome::Transient);
            return false;
        }
        true
    }

    pub fn record(&mut self, now: u64, outcome: Outcome) -> Event {
        match outcome {
            Outcome::Ok => {
                let was = self.failures > 0;
                self.failures = 0;
                if was { Event::Recovered } else { Event::None }
            }
            Outcome::Client4xx => Event::None,
            Outcome::Transient => {
                self.failures += 1;
                if self.failures >= self.threshold && now >= self.open_until {
                    self.open_until = now + self.cooldown_ms;
                    return Event::Opened;
                }
                Event::None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Outcome::*;

    fn run(steps: &[(u64, Outcome)]) -> Vec<(bool, u64, u32)> {
        let mut b = Breaker::new(3, 30_000);
        steps
            .iter()
            .map(|&(at, o)| {
                let allowed = b.allow(at);
                if allowed {
                    b.record(at, o);
                }
                (allowed, b.open_until, b.failures)
            })
            .collect()
    }

    #[test]
    fn opens_on_the_third_consecutive_transient_failure() {
        let got = run(&[(0, Transient), (1, Transient), (2, Transient), (3, Ok)]);
        assert_eq!(
            got,
            [
                (true, 0, 1),
                (true, 0, 2),
                (true, 30_002, 3),
                (false, 30_002, 4)
            ]
        );
    }

    #[test]
    fn a_rejection_counts_without_reopening() {
        let got = run(&[
            (0, Transient),
            (0, Transient),
            (0, Transient),
            (10_000, Ok),
            (29_999, Ok),
        ]);
        assert_eq!(got[3], (false, 30_000, 4));
        assert_eq!(got[4], (false, 30_000, 5));
    }

    #[test]
    fn success_resets_and_a_client_error_does_not() {
        let got = run(&[
            (0, Transient),
            (1, Client4xx),
            (2, Transient),
            (3, Ok),
            (4, Transient),
        ]);
        let failures: Vec<u32> = got.iter().map(|g| g.2).collect();
        assert_eq!(failures, [1, 1, 2, 0, 1]);
    }

    #[test]
    fn after_the_cooldown_one_transient_failure_reopens() {
        let mut b = Breaker::new(3, 30_000);
        for t in 0..3 {
            b.allow(t);
            b.record(t, Transient);
        }
        assert!(b.allow(40_000));
        assert_eq!(b.record(40_000, Transient), Event::Opened);
        assert_eq!(b.open_until, 70_000);
        assert!(!b.allow(69_999));
        assert!(b.allow(70_000));
        assert_eq!(b.record(70_000, Ok), Event::Recovered);
    }

    #[test]
    fn statuses() {
        for (s, o) in [
            (200, Ok),
            (404, Client4xx),
            (401, Client4xx),
            (429, Transient),
            (500, Transient),
            (503, Transient),
        ] {
            assert_eq!(Outcome::of_status(s), o, "{s}");
        }
    }
}

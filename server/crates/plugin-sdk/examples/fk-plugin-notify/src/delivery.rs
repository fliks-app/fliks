//! One delivery attempt and its outcome (rust-port.md 3.2 step 5).

pub const MAX_ATTEMPTS: u32 = 6;
pub const BACKOFF_MS: [u64; 5] = [1000, 5000, 15000, 30000, 60000];

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Delivered(u16),
    /// Final without retry: guard denial, DNS failure, bad URL, no target.
    Refused(String),
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Delivered { status: String },
    Refused { status: String },
    Retry { status: String, delay_ms: u64 },
    Failed { status: String },
}

/// `n` counts completed attempts, this one included.
pub fn next(n: u32, outcome: Outcome) -> Action {
    match outcome {
        Outcome::Delivered(code) => Action::Delivered {
            status: format!("delivered:{code}"),
        },
        Outcome::Refused(r) => Action::Refused {
            status: format!("refused:{r}"),
        },
        Outcome::Failed(r) if n < MAX_ATTEMPTS => Action::Retry {
            status: format!("retrying:{r}"),
            delay_ms: BACKOFF_MS[(n - 1) as usize],
        },
        Outcome::Failed(r) => Action::Failed {
            status: format!("failed:{r}"),
        },
    }
}

/// `targetHost` as the log shows it.
pub fn host_of(target: Option<&str>) -> String {
    match target {
        None => "unconfigured".into(),
        Some(t) => url::Url::parse(t)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_else(|| "invalid".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_attempts_with_five_delays() {
        let f = || Outcome::Failed("target replied 500".into());
        let delays: Vec<u64> = (1..MAX_ATTEMPTS)
            .map(|n| match next(n, f()) {
                Action::Retry { delay_ms, .. } => delay_ms,
                a => panic!("{a:?}"),
            })
            .collect();
        assert_eq!(delays, BACKOFF_MS);
        assert_eq!(
            next(6, f()),
            Action::Failed {
                status: "failed:target replied 500".into()
            }
        );
    }

    #[test]
    fn refusals_and_success_are_final() {
        assert_eq!(
            next(1, Outcome::Delivered(204)),
            Action::Delivered {
                status: "delivered:204".into()
            }
        );
        assert!(matches!(
            next(1, Outcome::Refused("x".into())),
            Action::Refused { .. }
        ));
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of(None), "unconfigured");
        assert_eq!(host_of(Some("::")), "invalid");
        assert_eq!(
            host_of(Some("https://hooks.example.com/x?t=1")),
            "hooks.example.com"
        );
    }
}

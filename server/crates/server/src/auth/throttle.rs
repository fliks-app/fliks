//! In-process limiter of failed logins per (client address, username).
use crate::sync::MutexExt;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_FAILS: u32 = 5;
const WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_KEYS: usize = 10_000;

#[derive(Default)]
pub struct LoginThrottle {
    fails: Mutex<HashMap<(String, String), (u32, Instant)>>,
}

fn key(ip: &str, username: &str) -> (String, String) {
    (ip.to_owned(), username.to_lowercase())
}

impl LoginThrottle {
    pub fn blocked(&self, ip: &str, username: &str) -> bool {
        self.fails
            .lock_clean()
            .get(&key(ip, username))
            .is_some_and(|(n, since)| *n >= MAX_FAILS && since.elapsed() < WINDOW)
    }

    pub fn fail(&self, ip: &str, username: &str) {
        let mut m = self.fails.lock_clean();
        if m.len() >= MAX_KEYS {
            m.retain(|_, (_, since)| since.elapsed() < WINDOW);
            // ponytail: a flood of distinct usernames resets everyone, per-user caps if that matters
            if m.len() >= MAX_KEYS {
                m.clear();
            }
        }
        let e = m.entry(key(ip, username)).or_insert((0, Instant::now()));
        if e.1.elapsed() >= WINDOW {
            *e = (0, Instant::now());
        }
        e.0 += 1;
    }

    pub fn clear(&self, ip: &str, username: &str) {
        self.fails.lock_clean().remove(&key(ip, username));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_failures_block_that_pair_only_until_a_success_clears_it() {
        let t = LoginThrottle::default();
        for _ in 0..MAX_FAILS {
            assert!(!t.blocked("1.1.1.1", "Bob"));
            t.fail("1.1.1.1", "Bob");
        }
        assert!(t.blocked("1.1.1.1", "bob"), "usernames fold case");
        assert!(!t.blocked("2.2.2.2", "bob"));
        assert!(!t.blocked("1.1.1.1", "alice"));
        t.clear("1.1.1.1", "bob");
        assert!(!t.blocked("1.1.1.1", "bob"));
    }

    #[test]
    fn an_expired_window_starts_over() {
        let t = LoginThrottle::default();
        let old = Instant::now()
            .checked_sub(WINDOW + Duration::from_secs(1))
            .unwrap();
        t.fails
            .lock_clean()
            .insert(key("ip", "bob"), (MAX_FAILS, old));
        assert!(!t.blocked("ip", "bob"));
        t.fail("ip", "bob");
        assert!(!t.blocked("ip", "bob"));
    }
}

//! In-process limiter of failed logins per (client network, username).
use crate::sync::MutexExt;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_FAILS: u32 = 5;
const WINDOW: Duration = Duration::from_secs(15 * 60);
const MAX_KEYS: usize = 10_000;

type Key = (String, String);

#[derive(Default)]
pub struct LoginThrottle {
    fails: Mutex<HashMap<Key, (u32, Instant)>>,
}

/// An IPv6 client owns a whole /64, so it is keyed by that prefix.
pub fn net(ip: Option<IpAddr>) -> String {
    match ip.map(|a| a.to_canonical()) {
        Some(IpAddr::V6(v6)) => {
            format!(
                "{}/64",
                std::net::Ipv6Addr::from(u128::from(v6) & (!0u128 << 64))
            )
        }
        Some(v4) => v4.to_string(),
        None => String::new(),
    }
}

fn key(ip: Option<IpAddr>, username: &str) -> Key {
    (net(ip), username.to_lowercase())
}

impl LoginThrottle {
    /// Counts an attempt and says whether it may run: check and count are one locked step, so a
    /// burst cannot pass the limit together. A success calls `clear`.
    pub fn attempt(&self, ip: Option<IpAddr>, username: &str) -> bool {
        self.attempt_with(ip, username, MAX_FAILS)
    }

    /// `attempt` with its own limit per window.
    pub fn attempt_with(&self, ip: Option<IpAddr>, username: &str, max: u32) -> bool {
        let mut m = self.fails.lock_clean();
        let k = key(ip, username);
        if !m.contains_key(&k) && m.len() >= MAX_KEYS {
            m.retain(|_, (_, since)| since.elapsed() < WINDOW);
            // Evict the least-failed, then oldest, so a flood of one-off keys never frees a locked one.
            if m.len() >= MAX_KEYS
                && let Some(victim) = m
                    .iter()
                    .min_by_key(|(_, (n, since))| (*n, *since))
                    .map(|(k, _)| k.clone())
            {
                m.remove(&victim);
            }
        }
        let e = m.entry(k).or_insert((0, Instant::now()));
        if e.1.elapsed() >= WINDOW {
            *e = (0, Instant::now());
        }
        if e.0 >= max {
            return false;
        }
        e.0 += 1;
        true
    }

    /// Whether the pair has used up `max` failures in the window, without counting anything.
    pub fn blocked(&self, ip: Option<IpAddr>, username: &str, max: u32) -> bool {
        self.fails
            .lock_clean()
            .get(&key(ip, username))
            .is_some_and(|(n, since)| *n >= max && since.elapsed() < WINDOW)
    }

    /// Counts one failure.
    pub fn fail(&self, ip: Option<IpAddr>, username: &str) {
        self.attempt_with(ip, username, u32::MAX);
    }

    /// Gives back one attempt that turned out not to be a failure; unlike `clear` it cannot reset
    /// a counter an attacker fed with failures.
    pub fn refund(&self, ip: Option<IpAddr>, username: &str) {
        if let Some(e) = self.fails.lock_clean().get_mut(&key(ip, username)) {
            e.0 = e.0.saturating_sub(1);
        }
    }

    pub fn clear(&self, ip: Option<IpAddr>, username: &str) {
        self.fails.lock_clean().remove(&key(ip, username));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> Option<IpAddr> {
        Some(s.parse().unwrap())
    }

    #[test]
    fn five_attempts_then_blocked_for_that_pair_only_until_a_success_clears_it() {
        let t = LoginThrottle::default();
        for _ in 0..MAX_FAILS {
            assert!(t.attempt(ip("1.1.1.1"), "Bob"));
        }
        assert!(!t.attempt(ip("1.1.1.1"), "bob"), "usernames fold case");
        assert!(t.attempt(ip("2.2.2.2"), "bob"));
        assert!(t.attempt(ip("1.1.1.1"), "alice"));
        t.clear(ip("1.1.1.1"), "bob");
        assert!(t.attempt(ip("1.1.1.1"), "bob"));
    }

    #[test]
    fn a_refund_gives_back_one_attempt_and_never_resets_the_rest() {
        let t = LoginThrottle::default();
        for _ in 0..MAX_FAILS {
            assert!(t.attempt(ip("1.1.1.1"), "bob"));
        }
        t.refund(ip("1.1.1.1"), "bob");
        assert!(t.attempt(ip("1.1.1.1"), "bob"));
        assert!(
            !t.attempt(ip("1.1.1.1"), "bob"),
            "four failures stayed counted"
        );
    }

    #[test]
    fn blocked_reads_without_counting_and_fail_counts() {
        let t = LoginThrottle::default();
        for _ in 0..100 {
            assert!(!t.blocked(ip("1.1.1.1"), "bob", 3));
        }
        for _ in 0..3 {
            t.fail(ip("1.1.1.1"), "Bob");
        }
        assert!(t.blocked(ip("1.1.1.1"), "bob", 3));
        assert!(!t.blocked(ip("1.1.1.1"), "alice", 3));
        assert!(!t.blocked(ip("2.2.2.2"), "bob", 3));
    }

    #[test]
    fn an_ipv6_client_is_keyed_by_its_64() {
        let t = LoginThrottle::default();
        for _ in 0..MAX_FAILS {
            assert!(t.attempt(ip("2001:db8:1:2::1"), "bob"));
        }
        assert!(!t.attempt(ip("2001:db8:1:2:ffff::9"), "bob"));
        assert!(t.attempt(ip("2001:db8:1:3::1"), "bob"));
    }

    #[test]
    fn an_expired_window_starts_over() {
        let t = LoginThrottle::default();
        let old = Instant::now()
            .checked_sub(WINDOW + Duration::from_secs(1))
            .unwrap();
        t.fails
            .lock_clean()
            .insert(key(ip("1.1.1.1"), "bob"), (MAX_FAILS, old));
        assert!(t.attempt(ip("1.1.1.1"), "bob"));
    }

    #[test]
    fn a_flood_of_new_keys_does_not_free_a_locked_one() {
        let t = LoginThrottle::default();
        for _ in 0..MAX_FAILS {
            t.attempt(ip("1.1.1.1"), "victim");
        }
        for i in 0..MAX_KEYS + 50 {
            t.attempt(ip("9.9.9.9"), &format!("u{i}"));
        }
        assert!(!t.attempt(ip("1.1.1.1"), "victim"));
        assert!(t.fails.lock_clean().len() <= MAX_KEYS);
    }
}

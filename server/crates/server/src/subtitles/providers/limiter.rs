//! Per-type cooldown and circuit breaker (`subtitle-providers.md` rules 5-14, C70, C71).
use crate::sync::MutexExt;
use reqwest::{Client, RequestBuilder, Response, header::HeaderMap};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::time::Instant;

const FAILURE_THRESHOLD: u32 = 3;
const CIRCUIT_OPEN_MS: i64 = 5 * 60_000;
/// C71: a `Retry-After` never blocks a type for more than the OpenSubtitles quota cooldown.
const MAX_BACKOFF_SEC: f64 = 3600.0;
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Circuit {
    Closed,
    Open,
    HalfOpen,
}

#[derive(Debug, Clone)]
struct Cooldown {
    retry_after: i64,
    remaining: Option<f64>,
    failures: u32,
    circuit: Circuit,
    reset_at: i64,
    probing: bool,
}

/// `getAllCooldowns` entry.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CooldownInfo {
    pub provider_type: String,
    pub retry_after: i64,
    pub remaining: Option<f64>,
    pub delay_sec: i64,
    pub circuit: Circuit,
    pub circuit_reset_at: i64,
    pub circuit_reset_in_sec: i64,
    pub consecutive_failures: u32,
}

/// Epoch ms that follows the tokio clock, so a paused clock drives the breaker in tests.
pub fn now_ms() -> i64 {
    static BASE: OnceLock<(Instant, i64)> = OnceLock::new();
    let (start, epoch) = BASE.get_or_init(|| {
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        (Instant::now(), epoch)
    });
    epoch + start.elapsed().as_millis() as i64
}

/// Insertion-ordered like a JS `Map`.
#[derive(Default)]
struct Table {
    order: Vec<String>,
    by_type: HashMap<String, Cooldown>,
}

impl Table {
    fn entry(&mut self, t: &str) -> &mut Cooldown {
        if !self.by_type.contains_key(t) {
            self.order.push(t.to_owned());
        }
        self.by_type.entry(t.to_owned()).or_insert(Cooldown {
            retry_after: 0,
            remaining: None,
            failures: 0,
            circuit: Circuit::Closed,
            reset_at: 0,
            probing: false,
        })
    }
}

#[derive(Default)]
pub struct Limiter(Mutex<Table>);

fn number(h: &HeaderMap, k: &str) -> Option<f64> {
    let v = h.get(k)?.to_str().ok()?;
    Some(fliks_domain::media::query::js_number(v).unwrap_or(f64::NAN))
}

impl Limiter {
    fn table(&self) -> std::sync::MutexGuard<'_, Table> {
        self.0.lock_clean()
    }

    /// Seconds left of a cooldown, 0 when none (and then cleared).
    pub fn rate_limit_delay(&self, t: &str) -> i64 {
        let mut tb = self.table();
        let Some(cd) = tb.by_type.get_mut(t) else {
            return 0;
        };
        let now = now_ms();
        if now >= cd.retry_after {
            cd.retry_after = 0;
            return 0;
        }
        (cd.retry_after - now + 999) / 1000
    }

    /// True while a cooldown runs or the circuit blocks callers (an open circuit past its reset
    /// reads half-open; a half-open one with its probe out still blocks).
    pub fn is_rate_limited(&self, t: &str) -> bool {
        if self.rate_limit_delay(t) > 0 {
            return true;
        }
        let mut tb = self.table();
        let Some(cd) = tb.by_type.get_mut(t) else {
            return false;
        };
        match cd.circuit {
            Circuit::Closed => false,
            Circuit::Open if now_ms() >= cd.reset_at => {
                cd.circuit = Circuit::HalfOpen;
                tracing::warn!("{t}: circuit half-open, letting one probe request through");
                cd.probing
            }
            Circuit::Open => true,
            Circuit::HalfOpen => cd.probing,
        }
    }

    /// Admits a request; a half-open circuit admits one probe at a time (C70).
    fn admit(&self, t: &str) -> Option<bool> {
        if self.rate_limit_delay(t) > 0 {
            return None;
        }
        let mut tb = self.table();
        let Some(cd) = tb.by_type.get_mut(t) else {
            return Some(false);
        };
        if cd.circuit == Circuit::Open && now_ms() >= cd.reset_at {
            cd.circuit = Circuit::HalfOpen;
        }
        match cd.circuit {
            Circuit::Closed => Some(false),
            Circuit::Open => None,
            Circuit::HalfOpen if cd.probing => None,
            Circuit::HalfOpen => {
                cd.probing = true;
                Some(true)
            }
        }
    }

    fn success(&self, t: &str) {
        if let Some(cd) = self.table().by_type.get_mut(t) {
            cd.failures = 0;
            cd.circuit = Circuit::Closed;
            cd.reset_at = 0;
            cd.probing = false;
        }
    }

    fn failure(&self, t: &str, reason: &str) {
        let mut tb = self.table();
        let cd = tb.entry(t);
        cd.probing = false;
        if cd.circuit == Circuit::HalfOpen {
            cd.circuit = Circuit::Open;
            cd.reset_at = now_ms() + CIRCUIT_OPEN_MS;
            tracing::warn!("{t}: half-open probe failed ({reason}), re-opening");
            return;
        }
        cd.failures += 1;
        if cd.failures >= FAILURE_THRESHOLD {
            cd.circuit = Circuit::Open;
            cd.reset_at = now_ms() + CIRCUIT_OPEN_MS;
            tracing::warn!(
                "{t}: circuit OPEN after {} consecutive failures ({reason}); skipping for 5min",
                cd.failures
            );
        }
    }

    fn release_probe(&self, t: &str) {
        if let Some(cd) = self.table().by_type.get_mut(t) {
            cd.probing = false;
        }
    }

    /// Cooldown after a 429/423, or `default_sec` with no header (also the quota-zero hour).
    pub fn mark_rate_limited(&self, t: &str, headers: Option<&HeaderMap>, default_sec: f64) {
        let mut backoff = default_sec;
        let mut tb = self.table();
        let cd = tb.entry(t);
        if let Some(h) = headers {
            if let Some(v) = h
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty())
            {
                if let Ok(n) = v.trim().parse::<f64>() {
                    if n.is_finite() && n >= 0.0 {
                        backoff = n;
                    }
                } else if let Ok(d) = httpdate::parse_http_date(v.trim()) {
                    let ms = d
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_millis() as i64)
                        - now_ms();
                    backoff = (((ms as f64) / 1000.0).ceil()).max(1.0);
                }
            }
            if let Some(n) = number(h, "x-ratelimit-remaining-second")
                .or_else(|| number(h, "ratelimit-remaining"))
            {
                cd.remaining = Some(n);
            }
        }
        let backoff = backoff.min(MAX_BACKOFF_SEC);
        tracing::warn!("{t} rate-limited, backing off {backoff}s");
        cd.retry_after = now_ms() + (backoff * 1000.0) as i64;
    }

    fn track_quota(&self, t: &str, h: &HeaderMap) {
        let n = number(h, "x-ratelimit-remaining-second")
            .or_else(|| number(h, "ratelimit-remaining"))
            .or_else(|| number(h, "x-ratelimit-remaining"));
        if let Some(n) = n {
            self.table().entry(t).remaining = Some(n);
        }
    }

    /// Types with a cooldown, a non-closed circuit or failures, in first-touched order (rule 12).
    pub fn all(&self) -> Vec<CooldownInfo> {
        let tb = self.table();
        let now = now_ms();
        tb.order
            .iter()
            .filter_map(|t| {
                let cd = &tb.by_type[t];
                let limited = now < cd.retry_after;
                let breaker = cd.circuit != Circuit::Closed;
                if !limited && !breaker && cd.failures == 0 {
                    return None;
                }
                let secs = |at: i64| (at - now + 999) / 1000;
                Some(CooldownInfo {
                    provider_type: t.clone(),
                    retry_after: cd.retry_after,
                    remaining: cd.remaining,
                    delay_sec: if limited { secs(cd.retry_after) } else { 0 },
                    circuit: cd.circuit,
                    circuit_reset_at: cd.reset_at,
                    circuit_reset_in_sec: if breaker && cd.reset_at > now {
                        secs(cd.reset_at)
                    } else {
                        0
                    },
                    consecutive_failures: cd.failures,
                })
            })
            .collect()
    }

    /// `rateLimitedFetch`: `None` when skipped, cooled down, or the request failed to reach the host.
    pub async fn fetch(
        &self,
        t: &str,
        build: impl Fn() -> RequestBuilder,
        max_retries: u32,
        default_backoff_sec: f64,
    ) -> Option<Response> {
        let probe = self.admit(t)?;
        let _guard = probe.then(|| ProbeGuard(self, t.to_owned()));
        self.attempts(t, &build, max_retries, default_backoff_sec)
            .await
    }

    async fn attempts(
        &self,
        t: &str,
        build: &impl Fn() -> RequestBuilder,
        max_retries: u32,
        default_backoff_sec: f64,
    ) -> Option<Response> {
        for attempt in 0..=max_retries {
            let res = match build().timeout(FETCH_TIMEOUT).send().await {
                Ok(r) => r,
                Err(e) => {
                    self.failure(t, &format!("network: {}", e.without_url()));
                    return None;
                }
            };
            let status = res.status().as_u16();
            if status == 429 || status == 423 {
                self.mark_rate_limited(t, Some(res.headers()), default_backoff_sec);
                if attempt < max_retries {
                    let delay = self.rate_limit_delay(t).min(10);
                    tokio::time::sleep(Duration::from_secs(delay as u64)).await;
                    continue;
                }
                return None;
            }
            if status >= 500 {
                self.failure(t, &format!("http {status}"));
                return Some(res);
            }
            self.success(t);
            self.track_quota(t, res.headers());
            return Some(res);
        }
        None
    }
}

/// Frees the half-open probe slot whatever way the request ends, a dropped future included.
struct ProbeGuard<'a>(&'a Limiter, String);

impl Drop for ProbeGuard<'_> {
    fn drop(&mut self) {
        self.0.release_probe(&self.1);
    }
}

/// Convenience for call sites that hold the client: `limiter.fetch(.., || client.get(url))`.
pub fn get(client: &Client, url: &str) -> impl Fn() -> RequestBuilder {
    let (client, url) = (client.clone(), url.to_owned());
    move || client.get(&url)
}

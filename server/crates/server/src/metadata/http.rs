//! One upstream: a `reqwest` client behind a rate limiter and the shared circuit breaker
//! (`metadata.md` rules 18, 20, 21; `metadata-orchestrator.md` rules 12-21).
use crate::sync::MutexExt;
use fliks_domain::metadata::{
    breaker::{Breaker, Event, Outcome},
    limiter::{Limiter, Limits, MAX_PAUSE_MS, Priority, Refused},
};
use futures_util::future::BoxFuture;
use reqwest::header::HeaderMap;
use serde_json::Value;
use std::{
    error::Error,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

/// An interactive call never waits longer than this, token waits and pauses together.
const INTERACTIVE_BUDGET_MS: u64 = 5_000;
const BACKGROUND_RETRIES: u32 = 3;
const INTERACTIVE_RETRIES: u32 = 1;
const SLOW_CALL_MS: u64 = 1_000;
const DAY_MS: u64 = 86_400_000;

/// Time as the limiter and the breaker read it: replaceable by a fake clock in tests.
pub trait Clock: Send + Sync {
    /// Monotonic milliseconds.
    fn now_ms(&self) -> u64;
    /// Days since the Unix epoch, UTC.
    fn day(&self) -> u64;
    fn sleep(&self, ms: u64) -> BoxFuture<'_, ()>;
}

struct SystemClock {
    started: Instant,
}

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn day(&self) -> u64 {
        let since = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH);
        since.map_or(0, |d| d.as_millis() as u64 / DAY_MS)
    }

    fn sleep(&self, ms: u64) -> BoxFuture<'_, ()> {
        Box::pin(tokio::time::sleep(Duration::from_millis(ms)))
    }
}

/// A failed upstream call; `reason` never contains the request URL (rule 21).
#[derive(Debug, Clone)]
pub struct Upstream {
    pub status: Option<u16>,
    reason: String,
}

impl Upstream {
    pub fn new(status: Option<u16>, reason: impl Into<String>) -> Self {
        Self {
            status,
            reason: reason.into(),
        }
    }

    pub fn reason(&self) -> &str {
        &self.reason
    }

    pub fn is_not_found(&self) -> bool {
        self.status == Some(404)
    }

    pub fn is_unauthorized(&self) -> bool {
        self.status == Some(401)
    }

    /// The provider's daily quota is spent: no request was made.
    pub fn quota(name: &str) -> Self {
        Self::new(Some(429), format!("{name} daily quota spent"))
    }

    /// The provider (or the limiter) asks for fewer calls: 429 or 503.
    pub fn is_throttled(&self) -> bool {
        matches!(self.status, Some(429 | 503))
    }
}

impl std::fmt::Display for Upstream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

/// The axios code name of a transport failure, `network error` when unknown.
fn code_of(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        return "ECONNABORTED";
    }
    let mut src = e.source();
    while let Some(s) = src {
        if let Some(io) = s.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::ConnectionRefused => return "ECONNREFUSED",
                std::io::ErrorKind::ConnectionReset => return "ECONNRESET",
                _ => {}
            }
        }
        if s.to_string().contains("dns error") {
            return "ENOTFOUND";
        }
        src = s.source();
    }
    "network error"
}

/// The transport failure as `<code> — <message>` with every source of the chain, URL stripped.
pub fn transport(e: reqwest::Error) -> Upstream {
    let code = code_of(&e);
    let e = e.without_url();
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        src = s.source();
    }
    Upstream::new(None, format!("{code} — {msg}"))
}

/// `HTTP <status> — <status_message|message|default>` as the controller words it.
pub fn http_reason(status: u16, body: &Value) -> String {
    let said = ["status_message", "message"]
        .iter()
        .find_map(|k| body.get(k).and_then(Value::as_str))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("Request failed with status code {status}"));
    format!("HTTP {status} — {said}")
}

/// `Retry-After` as a delay in milliseconds: delta-seconds or an HTTP date (past dates are 0).
fn retry_after_ms(value: &str, now: SystemTime) -> Option<u64> {
    let value = value.trim();
    if let Ok(secs) = value.parse::<u64>() {
        return Some(secs.saturating_mul(1000));
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(at.duration_since(now).map_or(0, |d| d.as_millis() as u64))
}

/// What a provider reads off a response (`x-ratelimit-*` and the like).
#[derive(Debug, Default)]
pub struct Observed {
    /// New limits for the limiter.
    pub limits: Option<Limits>,
    /// The daily quota is spent for the rest of the UTC day.
    pub quota_spent: bool,
}

type Observer = Box<dyn Fn(u16, &HeaderMap) -> Observed + Send + Sync>;

pub struct Guarded {
    name: &'static str,
    base: String,
    client: reqwest::Client,
    limiter: Mutex<Limiter>,
    breaker: Mutex<Breaker>,
    clock: Arc<dyn Clock>,
    slow_logged: AtomicBool,
    observer: Option<Observer>,
    /// Query parameters sent on every request (TMDB's `api_key`).
    fixed: Vec<(String, String)>,
}

impl Guarded {
    pub fn new(
        name: &'static str,
        base: &str,
        timeout: Duration,
        fixed: Vec<(String, String)>,
        limits: Limits,
    ) -> Self {
        Self {
            name,
            base: base.trim_end_matches('/').to_owned(),
            client: reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .expect("reqwest client"),
            limiter: Mutex::new(Limiter::new(limits)),
            breaker: Mutex::new(Breaker::new(3, 30_000)),
            clock: Arc::new(SystemClock {
                started: Instant::now(),
            }),
            slow_logged: AtomicBool::new(false),
            observer: None,
            fixed,
        }
    }

    /// Reads every response's status and headers (`Observed`).
    pub fn with_observer(
        mut self,
        f: impl Fn(u16, &HeaderMap) -> Observed + Send + Sync + 'static,
    ) -> Self {
        self.observer = Some(Box::new(f));
        self
    }

    pub fn limits(&self) -> Limits {
        self.limiter.lock_clean().limits()
    }

    pub fn set_limits(&self, limits: Limits) {
        self.limiter.lock_clean().set_limits(limits);
    }

    fn observe(&self, status: u16, headers: &HeaderMap) {
        let Some(f) = &self.observer else { return };
        let seen = f(status, headers);
        let mut l = self.limiter.lock_clean();
        if let Some(limits) = seen.limits {
            l.set_limits(limits);
        }
        if seen.quota_spent {
            l.on_quota_exhausted(self.clock.day());
        }
    }

    #[cfg(test)]
    fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    fn now(&self) -> u64 {
        self.clock.now_ms()
    }

    fn record(&self, outcome: Outcome) {
        let event = self.breaker.lock_clean().record(self.now(), outcome);
        match event {
            Event::Opened => tracing::warn!(
                "{}: 3 consecutive failures, circuit open for 30s",
                self.name
            ),
            Event::Recovered => tracing::info!("{}: upstream recovered, circuit closed", self.name),
            Event::None => {}
        }
    }

    pub fn get(&self, path: &str, query: &[(String, String)]) -> reqwest::RequestBuilder {
        self.client
            .get(format!("{}{path}", self.base))
            .query(&self.fixed)
            .query(query)
    }

    pub fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.client.post(format!("{}{path}", self.base))
    }

    /// A token, waited for and counted against the quota; an interactive call gives up past its budget.
    async fn admit(&self, p: Priority, waited: &mut u64) -> Result<(), Upstream> {
        loop {
            let taken = self
                .limiter
                .lock_clean()
                .take(self.now(), self.clock.day(), p);
            let wait = match taken {
                Ok(()) => break,
                Err(Refused::QuotaSpent) => return Err(Upstream::quota(self.name)),
                Err(Refused::Wait(wait)) => wait,
            };
            if p == Priority::Interactive && *waited + wait > INTERACTIVE_BUDGET_MS {
                return Err(Upstream::new(
                    Some(429),
                    format!("{} rate limit reached, try again shortly", self.name),
                ));
            }
            self.clock.sleep(wait).await;
            *waited += wait;
        }
        if *waited > SLOW_CALL_MS && !self.slow_logged.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "{}: a call waited {}ms for the rate limit",
                self.name,
                waited
            );
        }
        Ok(())
    }

    /// Pauses the limiter after a 429 or 503 and returns the pause length.
    fn throttled(&self, retry_after: Option<u64>) -> u64 {
        let now = self.now();
        let mut l = self.limiter.lock_clean();
        match retry_after {
            Some(ms) => {
                l.pause_until(now, now + ms);
                ms.min(MAX_PAUSE_MS)
            }
            None => l.backoff(now),
        }
    }

    /// Sends the request through the breaker and the limiter and returns the 2xx JSON body.
    pub async fn send(&self, req: reqwest::RequestBuilder, p: Priority) -> Result<Value, Upstream> {
        let (mut req, mut waited, mut retries) = (req, 0, 0);
        // The throttle answer a retry follows: what the caller gets if the retry cannot go.
        let mut last: Option<(Upstream, u16)> = None;
        loop {
            let allowed = {
                let mut b = self.breaker.lock_clean();
                b.allow(self.now())
            };
            if !allowed {
                return Err(Upstream::new(
                    None,
                    format!(
                        "{} circuit open — upstream temporarily unreachable",
                        self.name
                    ),
                ));
            }
            if let Err(refused) = self.admit(p, &mut waited).await {
                return Err(match last {
                    Some((err, status)) => {
                        self.record(Outcome::of_status(status));
                        err
                    }
                    None => refused,
                });
            }
            let spare = req.try_clone();
            let resp = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    self.record(Outcome::Transient);
                    return Err(transport(e));
                }
            };
            let status = resp.status().as_u16();
            self.observe(status, resp.headers());
            if !resp.status().is_success() {
                let after = resp
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| retry_after_ms(v, SystemTime::now()));
                let body: Value = resp.json().await.unwrap_or(Value::Null);
                let err = Upstream::new(Some(status), http_reason(status, &body));
                if err.is_throttled() {
                    let pause = self.throttled(after);
                    let fits = match p {
                        Priority::Background => retries < BACKGROUND_RETRIES,
                        Priority::Interactive => {
                            retries < INTERACTIVE_RETRIES && waited + pause <= INTERACTIVE_BUDGET_MS
                        }
                    };
                    if let Some(next) = spare.filter(|_| fits) {
                        (req, retries, last) = (next, retries + 1, Some((err, status)));
                        continue;
                    }
                } else {
                    self.limiter.lock_clean().reset_backoff();
                }
                self.record(Outcome::of_status(status));
                return Err(err);
            }
            self.limiter.lock_clean().reset_backoff();
            self.record(Outcome::Ok);
            return resp
                .json()
                .await
                .map_err(|_| Upstream::new(Some(status), "invalid JSON response"));
        }
    }

    pub async fn get_json(
        &self,
        path: &str,
        query: &[(String, String)],
        p: Priority,
    ) -> Result<Value, Upstream> {
        self.send(self.get(path, query), p).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons() {
        let body = serde_json::json!({"status_message": "Invalid API key"});
        assert_eq!(http_reason(401, &body), "HTTP 401 — Invalid API key");
        assert_eq!(
            http_reason(500, &Value::Null),
            "HTTP 500 — Request failed with status code 500"
        );
        let body = serde_json::json!({"message": "nope"});
        assert_eq!(http_reason(404, &body), "HTTP 404 — nope");
    }

    use crate::metadata::stub::serve;
    use std::sync::atomic::{AtomicU32, AtomicU64};

    #[test]
    fn retry_after_is_seconds_or_a_date() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(784_111_777);
        assert_eq!(retry_after_ms("2", now), Some(2_000));
        assert_eq!(retry_after_ms(" 120 ", now), Some(120_000));
        assert_eq!(
            retry_after_ms("Sun, 06 Nov 1994 08:49:57 GMT", now),
            Some(20_000)
        );
        assert_eq!(
            retry_after_ms("Sun, 06 Nov 1994 08:49:00 GMT", now),
            Some(0)
        );
        assert_eq!(retry_after_ms("soon", now), None);
    }

    /// Time that only moves when something sleeps.
    #[derive(Default)]
    struct Fake {
        now: AtomicU64,
        sleeps: Mutex<Vec<u64>>,
    }

    impl Clock for Fake {
        fn now_ms(&self) -> u64 {
            self.now.load(Ordering::Relaxed)
        }

        fn day(&self) -> u64 {
            19_000 + self.now_ms() / DAY_MS
        }

        fn sleep(&self, ms: u64) -> BoxFuture<'_, ()> {
            self.sleeps.lock().unwrap().push(ms);
            self.now.fetch_add(ms, Ordering::Relaxed);
            Box::pin(std::future::ready(()))
        }
    }

    /// Each request gets the next scripted `(status, Retry-After)`, then 200.
    async fn stub(script: &[(u16, Option<&str>)]) -> (String, Arc<AtomicU32>) {
        let script: Vec<(u16, Option<String>)> = script
            .iter()
            .map(|(s, h)| (*s, h.map(str::to_owned)))
            .collect();
        serve(move |_, n| {
            let (status, after) = script.get(n as usize).cloned().unwrap_or((200, None));
            (status, after, "{}".into())
        })
        .await
    }

    fn guarded(url: &str, limits: Limits) -> (Guarded, Arc<Fake>) {
        let clock = Arc::new(Fake::default());
        let g = Guarded::new("stub", url, Duration::from_secs(5), vec![], limits)
            .with_clock(clock.clone());
        (g, clock)
    }

    fn fast() -> Limits {
        Limits::new(1000.0, 1000)
    }

    async fn call(g: &Guarded, p: Priority) -> Result<Value, Upstream> {
        g.get_json("/x", &[], p).await
    }

    fn sleeps(c: &Fake) -> Vec<u64> {
        c.sleeps.lock().unwrap().clone()
    }

    fn hits(h: &AtomicU32) -> u32 {
        h.load(Ordering::Relaxed)
    }

    #[tokio::test]
    async fn a_background_call_waits_out_retry_after_and_retries() {
        let (url, h) = stub(&[(429, Some("2"))]).await;
        let (g, clock) = guarded(&url, fast());
        assert!(call(&g, Priority::Background).await.is_ok());
        assert_eq!(hits(&h), 2);
        assert_eq!(sleeps(&clock), [2_000]);
        assert_eq!(g.breaker.lock().unwrap().failures, 0);
    }

    #[tokio::test]
    async fn without_retry_after_the_call_backs_off() {
        let (url, h) = stub(&[(429, None), (429, None)]).await;
        let (g, clock) = guarded(&url, fast());
        assert!(call(&g, Priority::Background).await.is_ok());
        assert_eq!(hits(&h), 3);
        assert_eq!(sleeps(&clock), [1_000, 2_000]);
    }

    #[tokio::test]
    async fn a_background_call_gives_up_after_three_retries() {
        let (url, h) = stub(&[(503, None); 9]).await;
        let (g, clock) = guarded(&url, fast());
        let e = call(&g, Priority::Background).await.unwrap_err();
        assert_eq!(e.status, Some(503));
        assert_eq!(hits(&h), 4);
        assert_eq!(sleeps(&clock), [1_000, 2_000, 4_000]);
        // four answers, one failure for the breaker
        assert_eq!(g.breaker.lock().unwrap().failures, 1);
    }

    #[tokio::test]
    async fn an_interactive_call_retries_once_within_five_seconds() {
        let (url, h) = stub(&[(429, Some("2"))]).await;
        let (g, clock) = guarded(&url, fast());
        assert!(call(&g, Priority::Interactive).await.is_ok());
        assert_eq!(hits(&h), 2);
        assert_eq!(sleeps(&clock), [2_000]);
        let (url, h) = stub(&[(503, None); 9]).await;
        let (g, clock) = guarded(&url, fast());
        let e = call(&g, Priority::Interactive).await.unwrap_err();
        assert_eq!(e.status, Some(503));
        assert_eq!((hits(&h), sleeps(&clock)), (2, vec![1_000]));
    }

    #[tokio::test]
    async fn an_immediate_retry_after_does_not_loop() {
        let (url, h) = stub(&[(429, Some("0")); 9]).await;
        let (g, _) = guarded(&url, fast());
        let e = call(&g, Priority::Interactive).await.unwrap_err();
        assert_eq!((e.status, hits(&h)), (Some(429), 2));
    }

    #[tokio::test]
    async fn an_interactive_call_gives_up_instead_of_waiting_past_five_seconds() {
        let (url, h) = stub(&[(429, Some("10"))]).await;
        let (g, clock) = guarded(&url, fast());
        let e = call(&g, Priority::Interactive).await.unwrap_err();
        assert_eq!(e.status, Some(429));
        assert_eq!(hits(&h), 1);
        assert!(sleeps(&clock).is_empty());
        // the pause holds the next interactive call too: it fails without a request
        let e = call(&g, Priority::Interactive).await.unwrap_err();
        assert_eq!(e.status, Some(429));
        assert_eq!(hits(&h), 1);
    }

    #[tokio::test]
    async fn the_429_received_is_what_the_caller_gets_when_the_budget_runs_out() {
        let (url, h) = stub(&[(429, Some("4"))]).await;
        // one token every 10 s: after the pause the retry would wait past the budget
        let (g, clock) = guarded(&url, Limits::new(0.1, 1));
        let e = call(&g, Priority::Interactive).await.unwrap_err();
        assert!(e.reason().starts_with("HTTP 429"), "{}", e.reason());
        assert_eq!(hits(&h), 1);
        assert_eq!(sleeps(&clock), [4_000]);
        assert_eq!(g.breaker.lock().unwrap().failures, 1);
    }

    #[tokio::test]
    async fn a_spent_daily_quota_is_skipped_without_a_request_until_midnight() {
        let (url, h) = stub(&[]).await;
        let (g, clock) = guarded(
            &url,
            Limits {
                daily_quota: Some(2),
                ..fast()
            },
        );
        assert!(call(&g, Priority::Background).await.is_ok());
        assert!(call(&g, Priority::Interactive).await.is_ok());
        let e = call(&g, Priority::Interactive).await.unwrap_err();
        assert_eq!((e.status, hits(&h)), (Some(429), 2));
        clock.now.store(DAY_MS, Ordering::Relaxed);
        assert!(call(&g, Priority::Background).await.is_ok());
        assert_eq!(hits(&h), 3);
    }

    #[tokio::test]
    async fn a_429_the_provider_calls_a_quota_error_spends_the_day() {
        let (url, h) = stub(&[(429, None)]).await;
        let (g, _) = guarded(&url, fast());
        let g = g.with_observer(|status, _| Observed {
            quota_spent: status == 429,
            ..Observed::default()
        });
        let e = call(&g, Priority::Background).await.unwrap_err();
        assert!(e.reason().starts_with("HTTP 429"), "{}", e.reason());
        let e = call(&g, Priority::Background).await.unwrap_err();
        assert!(e.reason().contains("quota"), "{}", e.reason());
        assert_eq!(hits(&h), 1);
    }

    #[tokio::test]
    async fn the_observer_can_change_the_limits() {
        let (url, _) = stub(&[]).await;
        let (g, _) = guarded(&url, fast());
        let slower = Limits::new(2.0, 2);
        let g = g.with_observer(move |_, _| Observed {
            limits: Some(slower),
            ..Observed::default()
        });
        assert!(call(&g, Priority::Background).await.is_ok());
        assert_eq!(g.limits(), slower);
        g.set_limits(fast());
        assert_eq!(g.limits(), fast());
    }

    #[tokio::test]
    async fn an_open_breaker_spends_no_token() {
        let (url, h) = stub(&[(500, None); 3]).await;
        let (g, _) = guarded(&url, Limits::new(1000.0, 4));
        for _ in 0..3 {
            let _ = call(&g, Priority::Interactive).await;
        }
        // the fourth burst token is still there: three calls took three
        assert!(call(&g, Priority::Interactive).await.is_err());
        assert_eq!(hits(&h), 3);
        assert!(
            g.limiter
                .lock()
                .unwrap()
                .take(0, 0, Priority::Interactive)
                .is_ok()
        );
    }

    #[tokio::test]
    async fn the_rate_makes_a_call_wait_for_its_token() {
        let (url, _) = stub(&[]).await;
        let (g, clock) = guarded(&url, Limits::new(10.0, 1));
        assert!(call(&g, Priority::Interactive).await.is_ok());
        assert!(call(&g, Priority::Interactive).await.is_ok());
        assert_eq!(sleeps(&clock), [100]);
    }
}

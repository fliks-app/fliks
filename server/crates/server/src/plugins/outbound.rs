//! Guest outbound HTTP: one lookup, every address vetted, connect to the vetted address.

use crate::net::guard::{self, Net, Refused};
use crate::sync::MutexExt;
use bytes::Bytes;
use fliks_domain::metadata::{
    breaker::{Breaker, Event, Outcome},
    limiter::{Limiter, Limits, MAX_PAUSE_MS, MAX_PLUGIN_PAUSE_MS, Priority, Refused as Wait},
};
use futures_util::future::BoxFuture;
use http_body_util::{BodyExt, Full};
use serde_json::Value;
use std::collections::HashMap;
use std::future::{Future, poll_fn};
use std::net::{IpAddr, SocketAddr};
use std::pin::{Pin, pin};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, ready};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio_rustls::rustls::pki_types::ServerName;
use wasmtime_wasi_http::io::TokioIo;
use wasmtime_wasi_http::{Error, RequestOptions, WasiBody, WasiHttpHooks};

tokio::task_local! {
    /// The rate-limit waits of the provider exports called in this task.
    pub static RATE_WAIT: Arc<RateWait>;
}

/// Waits for a rate-limit token or pause in progress, and the time the finished ones took.
#[derive(Default)]
pub struct RateWait(watch::Sender<(u32, Duration)>);

impl RateWait {
    fn enter(self: &Arc<Self>) -> impl Drop {
        struct Leave(Arc<RateWait>, tokio::time::Instant);
        impl Drop for Leave {
            fn drop(&mut self) {
                let took = self.1.elapsed();
                self.0
                    .0
                    .send_modify(|(n, ms)| (*n, *ms) = (*n - 1, *ms + took));
            }
        }
        self.0.send_modify(|(n, _)| *n += 1);
        Leave(self.clone(), tokio::time::Instant::now())
    }
}

/// `f`, given up `cut` after it started; the time its provider calls spend waiting for a rate-limit
/// slot does not count, so a queued call is never cut for the provider's own rate.
pub async fn cut_past_rate_wait<F: Future>(cut: Duration, f: F) -> Option<F::Output> {
    let waits = Arc::new(RateWait::default());
    let mut seen = waits.0.subscribe();
    let start = tokio::time::Instant::now();
    RATE_WAIT
        .scope(waits.clone(), async {
            let mut f = pin!(f);
            loop {
                let (n, waited) = *seen.borrow_and_update();
                let expiry = async {
                    if n > 0 {
                        std::future::pending::<()>().await;
                    }
                    tokio::time::sleep_until(start + cut + waited).await;
                };
                tokio::select! {
                    r = f.as_mut() => return Some(r),
                    _ = seen.changed() => {}
                    () = expiry => return None,
                }
            }
        })
        .await
}

/// Most outbound requests one plugin has in flight; the rest queue within the call's deadline.
pub const MAX_IN_FLIGHT: usize = 32;

pub struct Outbound {
    pub plugin_id: Arc<str>,
    pub internal: bool,
    pub net: Arc<dyn Net>,
    pub permits: Arc<Semaphore>,
    /// Set for a plugin with a `provider` block (`provider-plugins.md` rule 54): one limiter and breaker per
    /// upstream host.
    pub gate: Option<Arc<Gates>>,
    /// The gate of the latest request of the export in progress: what its `rate-limited`, spent quota and
    /// checked records are about.
    pub last: Option<Arc<Gate>>,
    /// Whether the host answered that latest request itself (rule 57): a `rate-limited` echoing it pauses nothing.
    pub last_refused: Arc<AtomicBool>,
    /// The export in progress in this Store (rule 58).
    pub priority: Priority,
    /// When the export in progress is interrupted.
    pub deadline: Instant,
    /// The `RATE_WAIT` of the caller of the export in progress.
    pub queued: Option<Arc<RateWait>>,
    pub over: Arc<Override>,
}

type IoFuture = Box<dyn Future<Output = Result<(), Error>> + Send>;
type Sent = Result<(http::Response<WasiBody>, IoFuture), Error>;
type Attempt = (http::Response<WasiBody>, IoFuture);

impl WasiHttpHooks for Outbound {
    fn send_request(
        &mut self,
        mut request: http::Request<WasiBody>,
        options: Option<RequestOptions>,
        fut: IoFuture,
    ) -> Box<dyn Future<Output = Sent> + Send> {
        drop(fut);
        let net = self.net.clone();
        let id = self.plugin_id.clone();
        let permits = self.permits.clone();
        let gate = self.gate.clone();
        let priority = self.priority;
        let queued = self.queued.clone();
        let left = self.deadline.saturating_duration_since(Instant::now());
        let internal = self.internal | self.over.rewrite(request.uri_mut());
        let gate = gate.map(|g| g.for_host(request.uri().host().unwrap_or_default()));
        self.last.clone_from(&gate);
        let refused = self.last_refused.clone();
        refused.store(false, Ordering::SeqCst);
        Box::new(async move {
            // The call's deadline aborts a guest still queued here, like any other host wait.
            let permit = Arc::new(permits.acquire_owned().await.expect("never closed"));
            let Some(gate) = gate else {
                let (res, io) = send(net, id, internal, request, options, permit).await?;
                return Ok((res.map(BodyExt::boxed_unsync), Box::new(io) as IoFuture));
            };
            let (parts, body) = request.into_parts();
            // hyper sends these without a body when no length is set, so the guest's stream is never read to its end.
            let bodiless = matches!(
                parts.method,
                http::Method::GET | http::Method::HEAD | http::Method::CONNECT
            ) && !parts.headers.contains_key(http::header::CONTENT_LENGTH)
                && !parts.headers.contains_key(http::header::TRANSFER_ENCODING);
            let rec = Arc::new(Mutex::new(Recorded::default()));
            let mut first = Some(Tee::new(body, rec.clone()).boxed_unsync());
            let attempt = || {
                let body = first.take().unwrap_or_else(|| {
                    let bytes = Bytes::from(rec.lock_clean().buf.clone());
                    Full::new(bytes).map_err(|e| match e {}).boxed_unsync()
                });
                let mut req = http::Request::new(body);
                *req.method_mut() = parts.method.clone();
                *req.uri_mut() = parts.uri.clone();
                *req.version_mut() = parts.version;
                *req.headers_mut() = parts.headers.clone();
                let (net, id, permit) = (net.clone(), id.clone(), permit.clone());
                let limit = gate.timeout;
                async move {
                    let sent =
                        tokio::time::timeout(limit, send(net, id, internal, req, options, permit))
                            .await
                            .map_err(|_| Error::ConnectionTimeout)??;
                    let (res, io) = sent;
                    let retry_after_ms = res
                        .headers()
                        .get(http::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| retry_after_ms(v, SystemTime::now()));
                    Ok(Reply {
                        status: res.status().as_u16(),
                        retry_after_ms,
                        inner: (res.map(BodyExt::boxed_unsync), Box::new(io) as IoFuture),
                    })
                }
            };
            let replayable = || bodiless || rec.lock_clean().replayable();
            match gate
                .run(priority, left, queued.as_ref(), attempt, replayable)
                .await
            {
                Done::Reply(r) => {
                    let (res, io): Attempt = r.inner;
                    Ok((res, io))
                }
                Done::Failed(e) => Err(e),
                Done::Refused(r) => {
                    refused.store(true, Ordering::SeqCst);
                    Ok(r.into_response())
                }
            }
        })
    }
}

/// An interactive request never waits longer than this, token waits and pauses together.
const INTERACTIVE_BUDGET_MS: u64 = 5_000;
/// Consecutive failures that open the breaker.
const BREAKER_FAILURES: u32 = 3;
/// Replays of a 429 or 503; an interactive one also stops at its wait budget.
const RETRIES: u32 = 3;
const SLOW_CALL_MS: u64 = 1_000;
const DAY_MS: u64 = 86_400_000;
/// The largest request body the host keeps to replay it.
const MAX_REPLAY: usize = 64 * 1024;
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

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

/// `Retry-After` as a delay in milliseconds: delta-seconds or an HTTP date (past dates are 0).
fn retry_after_ms(value: &str, now: SystemTime) -> Option<u64> {
    let value = value.trim();
    if let Ok(secs) = value.parse::<u64>() {
        return Some(secs.saturating_mul(1000));
    }
    let at = httpdate::parse_http_date(value).ok()?;
    Some(at.duration_since(now).map_or(0, |d| d.as_millis() as u64))
}

/// What the host answers in place of the upstream (rule 57).
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub status: u16,
    pub retry_after_secs: Option<u64>,
    pub message: String,
}

impl Refusal {
    fn into_response(self) -> Attempt {
        let body = serde_json::json!({ "message": self.message }).to_string();
        let mut res = http::Response::builder()
            .status(self.status)
            .header(http::header::CONTENT_TYPE, "application/json");
        if let Some(s) = self.retry_after_secs {
            res = res.header(http::header::RETRY_AFTER, s);
        }
        let body = Full::new(Bytes::from(body))
            .map_err(|e| match e {})
            .boxed_unsync();
        let io: IoFuture = Box::new(std::future::ready(Ok(())));
        (res.body(body).expect("static head"), io)
    }
}

/// One upstream answer: the status and `Retry-After` the gate reads, `inner` what the caller gets.
pub struct Reply<R> {
    pub status: u16,
    pub retry_after_ms: Option<u64>,
    pub inner: R,
}

pub enum Done<R, E> {
    Reply(Reply<R>),
    Failed(E),
    Refused(Refusal),
}

/// The limiter and the breaker of one provider plugin (`provider-plugins.md` rules 54-58).
pub struct Gate {
    id: Arc<str>,
    limiter: Mutex<Limiter>,
    /// Waiters of each priority take their token in arrival order.
    turns: [tokio::sync::Mutex<()>; 2],
    breaker: Mutex<Breaker>,
    clock: Arc<dyn Clock>,
    slow_logged: AtomicBool,
    /// Malformed records in a row (rule 14).
    malformed: AtomicU32,
    /// `requestTimeoutMs`: connection and response headers of each attempt.
    pub timeout: Duration,
    /// `limits.maxPauseSecs`: the longest a `rate-limited(retry)` of the plugin pauses the limiter.
    max_pause_ms: u64,
}

impl Gate {
    pub fn new(id: &str, limits: Limits, timeout: Duration) -> Self {
        Self {
            id: id.into(),
            limiter: Mutex::new(Limiter::new(limits)),
            turns: Default::default(),
            breaker: Mutex::new(Breaker::new(BREAKER_FAILURES, 30_000)),
            clock: Arc::new(SystemClock {
                started: Instant::now(),
            }),
            slow_logged: AtomicBool::new(false),
            malformed: AtomicU32::new(0),
            timeout,
            max_pause_ms: MAX_PAUSE_MS,
        }
    }

    pub fn with_max_pause_secs(mut self, secs: u64) -> Self {
        self.max_pause_ms = (secs * 1000).clamp(MAX_PAUSE_MS, MAX_PLUGIN_PAUSE_MS);
        self
    }

    /// From a validated manifest `provider` block.
    pub fn from_block(id: &str, block: &Value) -> Option<Self> {
        let l = block.get("limits")?;
        let rate = l.get("ratePerSec")?.as_f64()?;
        let mut limits = Limits::new(rate, u32::try_from(l.get("burst")?.as_u64()?).ok()?);
        limits.daily_quota = l
            .get("dailyQuota")
            .and_then(Value::as_u64)
            .and_then(|q| u32::try_from(q).ok());
        if let Some(s) = l.get("backgroundShare").and_then(Value::as_f64) {
            limits.background_share = s;
        }
        let timeout = block
            .get("requestTimeoutMs")
            .and_then(Value::as_u64)
            .map_or(DEFAULT_REQUEST_TIMEOUT, Duration::from_millis);
        let max_pause = l.get("maxPauseSecs").and_then(Value::as_u64);
        Some(Self::new(id, limits, timeout).with_max_pause_secs(max_pause.unwrap_or(0)))
    }

    #[cfg(test)]
    fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    pub fn limits(&self) -> Limits {
        self.limiter.lock_clean().limits()
    }

    /// `provider-set-limits`: the background share stays the manifest's.
    pub fn set_limits(&self, rate_per_sec: f64, burst: u32, daily_quota: Option<u32>) {
        let mut l = self.limiter.lock_clean();
        let share = l.limits().background_share;
        l.set_limits(Limits {
            rate_per_sec,
            burst,
            daily_quota,
            background_share: share,
        });
    }

    /// `provider-quota-spent`: no request until midnight UTC.
    pub fn quota_spent(&self) {
        let day = self.clock.day();
        self.limiter.lock_clean().on_quota_exhausted(day);
    }

    /// `rate-limited(retry)`: the upstream asked for `secs` of quiet, up to `limits.maxPauseSecs`.
    pub fn pause_secs(&self, secs: u32) {
        let now = self.clock.now_ms();
        let ms = (u64::from(secs) * 1000).min(self.max_pause_ms);
        if ms > MAX_PAUSE_MS {
            tracing::warn!(
                "{}: paused for {}s at the provider's request",
                self.id,
                ms / 1000
            );
        }
        self.limiter
            .lock_clean()
            .pause_up_to(now, now + ms, self.max_pause_ms);
    }

    /// The plugin's settings changed (a new key may lift what paused it).
    pub fn clear_pause(&self) {
        self.limiter.lock_clean().clear_pause();
    }

    /// A record that parsed (`true`) or not: the failure of its export, which the 2xx of the request
    /// already cleared, so a run of `BREAKER_FAILURES` opens the breaker.
    pub fn record_checked(&self, valid: bool) {
        if valid {
            self.malformed.store(0, Ordering::Relaxed);
        } else if self.malformed.fetch_add(1, Ordering::Relaxed) + 1 >= BREAKER_FAILURES {
            self.malformed.store(0, Ordering::Relaxed);
            for _ in 0..BREAKER_FAILURES {
                self.record(Outcome::Transient);
            }
        }
    }

    fn refusal(&self, status: u16, retry_after_secs: Option<u64>, reason: &str) -> Refusal {
        Refusal {
            status,
            retry_after_secs,
            message: format!("{} {reason}", self.id),
        }
    }

    fn record(&self, outcome: Outcome) {
        let event = self
            .breaker
            .lock_clean()
            .record(self.clock.now_ms(), outcome);
        match event {
            Event::Opened => {
                tracing::warn!("{}: 3 consecutive failures, circuit open for 30s", self.id)
            }
            Event::Recovered => tracing::info!("{}: upstream recovered, circuit closed", self.id),
            Event::None => {}
        }
    }

    /// A token, waited for and counted against the quota; a call gives up past `budget_ms` of waiting.
    async fn admit(
        &self,
        p: Priority,
        budget_ms: u64,
        waited: &mut u64,
        queued: Option<&Arc<RateWait>>,
    ) -> Result<(), Refusal> {
        let _waiting = queued.map(RateWait::enter);
        let since = self.clock.now_ms();
        let line = self.turns[usize::from(p == Priority::Background)].lock();
        let left = Duration::from_millis(budget_ms.saturating_sub(*waited));
        let Ok(_turn) = tokio::time::timeout(left, line).await else {
            return Err(self.refusal(429, Some(1), "rate limit reached, try again shortly"));
        };
        *waited += self.clock.now_ms().saturating_sub(since);
        loop {
            let taken = self
                .limiter
                .lock_clean()
                .take(self.clock.now_ms(), self.clock.day(), p);
            let wait = match taken {
                Ok(()) => break,
                Err(Wait::QuotaSpent) => return Err(self.refusal(429, None, "daily quota spent")),
                Err(Wait::Wait(wait)) => wait,
            };
            if *waited + wait > budget_ms {
                return Err(self.refusal(
                    429,
                    Some(wait.div_ceil(1000)),
                    "rate limit reached, try again shortly",
                ));
            }
            self.clock.sleep(wait).await;
            *waited += wait;
        }
        if *waited > SLOW_CALL_MS && !self.slow_logged.swap(true, Ordering::Relaxed) {
            tracing::warn!("{}: a call waited {waited}ms for the rate limit", self.id);
        }
        Ok(())
    }

    /// The breaker's outcome of a final answer. A 429, or a 503 with `Retry-After`, is the upstream
    /// throttling: the limiter is paused for it, and it is no outage.
    fn settle<R>(&self, r: &Reply<R>) {
        if r.status == 429 || (r.status == 503 && r.retry_after_ms.is_some()) {
            return;
        }
        self.record(Outcome::of_status(r.status));
    }

    /// Pauses the limiter after a 429 or 503 and returns the pause length.
    fn throttled(&self, retry_after: Option<u64>) -> u64 {
        let now = self.clock.now_ms();
        let mut l = self.limiter.lock_clean();
        match retry_after {
            Some(ms) => {
                l.pause_until(now, now + ms);
                ms.min(MAX_PAUSE_MS)
            }
            None => l.backoff(now),
        }
    }

    /// Runs `attempt` through the breaker and the limiter, replaying a 429 or 503 while
    /// `replayable()` holds and the counts and the wait budget allow: 5 s interactive, never more
    /// than `left` of the export's deadline.
    pub async fn run<R, E, Fut>(
        &self,
        p: Priority,
        left: Duration,
        queued: Option<&Arc<RateWait>>,
        mut attempt: impl FnMut() -> Fut,
        replayable: impl Fn() -> bool,
    ) -> Done<R, E>
    where
        Fut: Future<Output = Result<Reply<R>, E>>,
    {
        let left = u64::try_from(left.as_millis()).unwrap_or(u64::MAX);
        let budget = match p {
            Priority::Interactive => left.min(INTERACTIVE_BUDGET_MS),
            Priority::Background => left,
        };
        let (mut waited, mut retries) = (0, 0);
        // The throttle answer a replay follows: what the caller gets if the replay cannot go.
        let mut last: Option<Reply<R>> = None;
        loop {
            if !self.breaker.lock_clean().allow(self.clock.now_ms()) {
                return Done::Refused(self.refusal(
                    503,
                    None,
                    "circuit open, upstream temporarily unreachable",
                ));
            }
            if let Err(refused) = self.admit(p, budget, &mut waited, queued).await {
                return match last {
                    Some(r) => {
                        self.settle(&r);
                        Done::Reply(r)
                    }
                    None => Done::Refused(refused),
                };
            }
            drop(last.take());
            let reply = match attempt().await {
                Ok(r) => r,
                Err(e) => {
                    self.record(Outcome::Transient);
                    return Done::Failed(e);
                }
            };
            if (200..300).contains(&reply.status) {
                self.limiter.lock_clean().reset_backoff();
                self.record(Outcome::Ok);
                return Done::Reply(reply);
            }
            if matches!(reply.status, 429 | 503) {
                let pause = self.throttled(reply.retry_after_ms);
                let fits = match p {
                    Priority::Background => retries < RETRIES,
                    Priority::Interactive => retries < RETRIES && waited + pause <= budget,
                };
                if fits && replayable() {
                    (retries, last) = (retries + 1, Some(reply));
                    continue;
                }
            } else {
                self.limiter.lock_clean().reset_backoff();
            }
            self.settle(&reply);
            return Done::Reply(reply);
        }
    }
}

/// The gates of one provider plugin, one per upstream host (`provider-plugins.md` rule 54): each host gets
/// the declared rate, and its pause (`Retry-After`) and breaker never touch another host's, so an outage
/// of one upstream (a popularity service) leaves the main one (the catalogue) running.
pub struct Gates {
    id: Arc<str>,
    limits: Mutex<Limits>,
    timeout: Duration,
    max_pause_ms: u64,
    hosts: Mutex<HashMap<String, Arc<Gate>>>,
}

/// Hosts with a gate of their own; the others share the one keyed by the empty string.
const MAX_HOSTS: usize = 16;

impl Gates {
    /// From a validated manifest `provider` block.
    pub fn from_block(id: &str, block: &Value) -> Option<Self> {
        let proto = Gate::from_block(id, block)?;
        Some(Self {
            id: id.into(),
            limits: Mutex::new(proto.limits()),
            timeout: proto.timeout,
            max_pause_ms: proto.max_pause_ms,
            hosts: Mutex::default(),
        })
    }

    #[cfg(test)]
    fn of(host: &str, gate: Gate) -> Self {
        Self {
            id: "stub".into(),
            limits: Mutex::new(gate.limits()),
            timeout: gate.timeout,
            max_pause_ms: gate.max_pause_ms,
            hosts: Mutex::new(HashMap::from([(host.to_owned(), Arc::new(gate))])),
        }
    }

    /// The gate of `host` (lower-case, no trailing dot), made on its first request.
    pub fn for_host(&self, host: &str) -> Arc<Gate> {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let mut hosts = self.hosts.lock_clean();
        let key = if hosts.contains_key(&host) || hosts.len() < MAX_HOSTS {
            host
        } else {
            String::new()
        };
        hosts
            .entry(key)
            .or_insert_with(|| {
                let mut g = Gate::new(&self.id, *self.limits.lock_clean(), self.timeout);
                g.max_pause_ms = self.max_pause_ms;
                Arc::new(g)
            })
            .clone()
    }

    pub fn limits(&self) -> Limits {
        *self.limits.lock_clean()
    }

    /// `provider-set-limits`: every host, the background share staying the manifest's.
    pub fn set_limits(&self, rate_per_sec: f64, burst: u32, daily_quota: Option<u32>) {
        let mut l = self.limits.lock_clean();
        l.rate_per_sec = rate_per_sec;
        l.burst = burst;
        l.daily_quota = daily_quota;
        for g in self.hosts.lock_clean().values() {
            g.set_limits(rate_per_sec, burst, daily_quota);
        }
    }

    /// The plugin's settings changed: no host stays paused.
    pub fn clear_pause(&self) {
        for g in self.hosts.lock_clean().values() {
            g.clear_pause();
        }
    }
}

/// What a request body showed on its way out, kept to replay it.
#[derive(Default)]
struct Recorded {
    buf: Vec<u8>,
    over: bool,
    done: bool,
}

impl Recorded {
    fn replayable(&self) -> bool {
        self.done && !self.over
    }
}

/// A request body that remembers up to `MAX_REPLAY` bytes while it streams.
struct Tee {
    inner: WasiBody,
    rec: Arc<Mutex<Recorded>>,
}

impl Tee {
    fn new(inner: WasiBody, rec: Arc<Mutex<Recorded>>) -> Self {
        Self { inner, rec }
    }
}

impl http_body::Body for Tee {
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Error>>> {
        let r = ready!(Pin::new(&mut self.inner).poll_frame(cx));
        let mut rec = self.rec.lock_clean();
        match &r {
            None => rec.done = true,
            Some(Err(_)) => rec.over = true,
            Some(Ok(f)) => {
                if let Some(d) = f.data_ref().filter(|_| !rec.over) {
                    if rec.buf.len() + d.len() > MAX_REPLAY {
                        (rec.over, rec.buf) = (true, Vec::new());
                    } else {
                        rec.buf.extend_from_slice(d);
                    }
                }
            }
        }
        Poll::Ready(r)
    }

    fn is_end_stream(&self) -> bool {
        let end = self.inner.is_end_stream();
        if end {
            self.rec.lock_clean().done = true;
        }
        end
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.inner.size_hint()
    }
}

struct Target {
    scheme: http::uri::Scheme,
    authority: http::uri::Authority,
    prefix: String,
}

/// `FLIKS_PLUGIN_UPSTREAM_OVERRIDE`: guest requests for a host go to another base (rule 59).
#[derive(Default)]
pub struct Override(HashMap<String, Target>);

impl Override {
    /// `<host>=<url>,...`; a malformed pair is skipped with a warn.
    pub fn parse(spec: &str) -> Self {
        let mut map = HashMap::new();
        for pair in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            let target = pair.split_once('=').and_then(|(host, url)| {
                let uri: http::Uri = url.trim().parse().ok()?;
                let scheme = uri
                    .scheme()
                    .filter(|s| matches!(s.as_str(), "http" | "https"))?;
                let target = Target {
                    scheme: scheme.clone(),
                    authority: uri.authority()?.clone(),
                    prefix: uri.path().trim_end_matches('/').to_owned(),
                };
                Some((host.trim().to_ascii_lowercase(), target))
            });
            match target {
                Some((host, t)) => {
                    tracing::warn!("plugin upstream override: {host} -> {}", t.authority);
                    map.insert(host, t);
                }
                None => tracing::warn!("plugin upstream override: pair \"{pair}\" skipped"),
            }
        }
        Self(map)
    }

    /// Empty unless the `parity` feature is compiled in.
    pub fn from_env() -> Self {
        #[cfg(feature = "parity")]
        if let Ok(v) = std::env::var("FLIKS_PLUGIN_UPSTREAM_OVERRIDE") {
            return Self::parse(&v);
        }
        Self::default()
    }

    /// `rewrite` for a `reqwest` URL.
    pub(crate) fn rewrite_url(&self, url: &mut reqwest::Url) -> bool {
        let mut uri: http::Uri = match url.as_str().parse() {
            Ok(u) => u,
            Err(_) => return false,
        };
        let hit = self.rewrite(&mut uri);
        if hit && let Ok(u) = reqwest::Url::parse(&uri.to_string()) {
            *url = u;
        }
        hit
    }

    /// Points `uri` at the target of its host; true when it did.
    fn rewrite(&self, uri: &mut http::Uri) -> bool {
        let Some(t) = uri.host().and_then(|h| self.0.get(&h.to_ascii_lowercase())) else {
            return false;
        };
        let pq = uri.path_and_query().map_or("/", |p| p.as_str());
        let rewritten = http::Uri::builder()
            .scheme(t.scheme.clone())
            .authority(t.authority.clone())
            .path_and_query(format!("{}{pq}", t.prefix))
            .build();
        match rewritten {
            Ok(u) => {
                *uri = u;
                true
            }
            Err(_) => false,
        }
    }
}

/// The addresses a guest request may connect to, or the `wasi:http` error it sees.
pub async fn vet(
    net: &dyn Net,
    id: &str,
    internal: bool,
    host: &str,
    port: u16,
) -> Result<Vec<SocketAddr>, Error> {
    guard::vet(net, host, port, internal)
        .await
        .map_err(|r| match r {
            Refused::Address(class) => {
                tracing::warn!(
                    "plugin \"{id}\" outbound refused: {host} resolves to {class} address"
                );
                Error::HttpRequestDenied
            }
            Refused::NotFound => Error::DnsError {
                rcode: Some("NXDOMAIN".into()),
                info_code: None,
            },
            Refused::Lookup => Error::DnsError {
                rcode: Some("SERVFAIL".into()),
                info_code: None,
            },
            Refused::Timeout => Error::DnsTimeout,
        })
}

trait Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Sync + Unpin + 'static {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Sync + Unpin + 'static> Stream for T {}

const CONNECT: Duration = Duration::from_secs(10);
const FIRST_BYTE: Duration = Duration::from_secs(60);
const BETWEEN_BYTES: Duration = Duration::from_secs(60);

async fn send(
    net: Arc<dyn Net>,
    id: Arc<str>,
    internal: bool,
    mut req: http::Request<WasiBody>,
    options: Option<RequestOptions>,
    permit: Arc<OwnedSemaphorePermit>,
) -> Result<
    (
        http::Response<IncomingBody>,
        impl Future<Output = Result<(), Error>> + Send,
    ),
    Error,
> {
    let uri = req.uri();
    let tls = uri.scheme() == Some(&http::uri::Scheme::HTTPS);
    let host = uri
        .host()
        .ok_or(Error::HttpRequestUriInvalid)?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let pick = |f: fn(&RequestOptions) -> Option<Duration>, cap: Duration| {
        options.as_ref().and_then(f).map_or(cap, |d| d.min(cap))
    };
    let connect_timeout = pick(|o| o.connect_timeout, CONNECT);
    let first_byte = pick(|o| o.first_byte_timeout, FIRST_BYTE);
    let between = pick(|o| o.between_bytes_timeout, BETWEEN_BYTES).max(Duration::new(0, 1));

    let addrs = vet(&*net, &id, internal, &host, port).await?;
    let mut last = None;
    let mut stream = None;
    for a in addrs {
        match tokio::time::timeout(connect_timeout, net.connect(a)).await {
            Ok(Ok(s)) => {
                stream = Some(s);
                break;
            }
            Ok(Err(e)) => last = Some(Error::Connect(e)),
            Err(_) => last = Some(Error::ConnectionTimeout),
        }
    }
    let stream = stream.ok_or_else(|| last.unwrap_or(Error::ConnectionRefused))?;
    let stream: Box<dyn Stream> = if tls {
        let name = match host.parse::<IpAddr>() {
            Ok(ip) => ServerName::from(ip),
            Err(_) => {
                ServerName::try_from(host.clone()).map_err(|_| Error::HttpRequestUriInvalid)?
            }
        };
        let connector = tokio_rustls::TlsConnector::from(net.tls());
        match tokio::time::timeout(connect_timeout, connector.connect(name, stream)).await {
            Ok(Ok(s)) => Box::new(s),
            Ok(Err(e)) => return Err(Error::Tls(e)),
            Err(_) => return Err(Error::ConnectionTimeout),
        }
    } else {
        Box::new(stream)
    };
    let (mut sender, conn) = tokio::time::timeout(
        connect_timeout,
        hyper::client::conn::http1::Builder::new().handshake(TokioIo::new(stream)),
    )
    .await
    .map_err(|_| Error::ConnectionTimeout)??;
    *req.uri_mut() = http::Uri::builder()
        .path_and_query(req.uri().path_and_query().map_or("/", |p| p.as_str()))
        .build()
        .expect("comes from a valid request");

    let body_permit = permit.clone();
    let send = async move {
        let res = tokio::time::timeout(first_byte, sender.send_request(req))
            .await
            .map_err(|_| Error::ConnectionReadTimeout)?
            .map_err(Error::from)?;
        let mut timeout = tokio::time::interval(between);
        timeout.reset();
        Ok::<_, Error>(res.map(|incoming| IncomingBody {
            incoming,
            timeout,
            _permit: body_permit,
        }))
    };
    let mut send = pin!(send);
    let mut conn = Some(conn);
    let res = poll_fn(|cx| match send.as_mut().poll(cx) {
        Poll::Ready(r) => Poll::Ready(r),
        Poll::Pending => {
            let Some(c) = conn.as_mut() else {
                return Poll::Pending;
            };
            let r = ready!(Pin::new(c).poll(cx));
            conn = None;
            match r {
                Ok(()) => send.as_mut().poll(cx),
                Err(e) => Poll::Ready(Err(Error::from(e))),
            }
        }
    })
    .await?;
    Ok((res, async move {
        let _permit = permit;
        match conn.take() {
            Some(c) => c.await.map_err(Error::from),
            None => Ok(()),
        }
    }))
}

pub struct IncomingBody {
    incoming: hyper::body::Incoming,
    timeout: tokio::time::Interval,
    _permit: Arc<OwnedSemaphorePermit>,
}

impl http_body::Body for IncomingBody {
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Error>>> {
        match Pin::new(&mut self.incoming).poll_frame(cx) {
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(Error::from(e)))),
            Poll::Ready(Some(Ok(f))) => {
                self.timeout.reset();
                Poll::Ready(Some(Ok(f)))
            }
            Poll::Pending => {
                ready!(self.timeout.poll_tick(cx));
                Poll::Ready(Some(Err(Error::ConnectionReadTimeout)))
            }
        }
    }
    fn is_end_stream(&self) -> bool {
        self.incoming.is_end_stream()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, AtomicU64};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

    fn gate(limits: Limits) -> (Gate, Arc<Fake>) {
        let clock = Arc::new(Fake::default());
        let g = Gate::new("stub", limits, Duration::from_secs(5)).with_clock(clock.clone());
        (g, clock)
    }

    fn fast() -> Limits {
        Limits::new(1000.0, 1000)
    }

    type Script<'a> = &'a [(u16, Option<u64>)];

    /// Each attempt gets the next scripted `(status, Retry-After seconds)` of `hits`, then 200.
    async fn call(
        g: &Gate,
        p: Priority,
        script: Script<'_>,
        hits: &AtomicU32,
        replay: bool,
    ) -> Done<(), ()> {
        let attempt = || {
            let n = hits.fetch_add(1, Ordering::Relaxed) as usize;
            let (status, after) = script.get(n).copied().unwrap_or((200, None));
            async move {
                Ok::<_, ()>(Reply {
                    status,
                    retry_after_ms: after.map(|s| s * 1000),
                    inner: (),
                })
            }
        };
        g.run(p, Duration::MAX, None, attempt, || replay).await
    }

    fn status(d: &Done<(), ()>) -> u16 {
        match d {
            Done::Reply(r) => r.status,
            Done::Refused(r) => r.status,
            Done::Failed(()) => 0,
        }
    }

    fn sleeps(c: &Fake) -> Vec<u64> {
        c.sleeps.lock().unwrap().clone()
    }

    fn failures(g: &Gate) -> u32 {
        g.breaker.lock().unwrap().failures
    }

    fn hits(h: &AtomicU32) -> u32 {
        h.load(Ordering::Relaxed)
    }

    use Priority::{Background, Interactive};

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

    #[tokio::test]
    async fn a_background_call_waits_out_retry_after_and_retries() {
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        let d = call(&g, Background, &[(429, Some(2))], &h, true).await;
        assert_eq!(status(&d), 200);
        assert_eq!(hits(&h), 2);
        assert_eq!(sleeps(&clock), [2_000]);
        assert_eq!(failures(&g), 0);
    }

    #[tokio::test]
    async fn without_retry_after_the_call_backs_off() {
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        let d = call(&g, Background, &[(429, None), (429, None)], &h, true).await;
        assert_eq!(status(&d), 200);
        assert_eq!(hits(&h), 3);
        assert_eq!(sleeps(&clock), [1_000, 2_000]);
    }

    #[tokio::test]
    async fn a_background_call_gives_up_after_three_retries() {
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        let d = call(&g, Background, &[(503, None); 9], &h, true).await;
        assert_eq!(status(&d), 503);
        assert_eq!(hits(&h), 4);
        assert_eq!(sleeps(&clock), [1_000, 2_000, 4_000]);
        // four answers, one failure for the breaker
        assert_eq!(failures(&g), 1);
    }

    #[tokio::test]
    async fn an_interactive_call_retries_within_five_seconds() {
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        let d = call(&g, Interactive, &[(429, Some(2))], &h, true).await;
        assert_eq!((status(&d), hits(&h)), (200, 2));
        assert_eq!(sleeps(&clock), [2_000]);
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        let d = call(&g, Interactive, &[(503, None); 9], &h, true).await;
        assert_eq!(status(&d), 503);
        // the next backoff step (4 s) would end past the budget
        assert_eq!((hits(&h), sleeps(&clock)), (3, vec![1_000, 2_000]));
        assert_eq!(failures(&g), 1);
    }

    #[tokio::test]
    async fn an_immediate_retry_after_does_not_loop() {
        let (g, _) = gate(fast());
        let h = AtomicU32::new(0);
        let d = call(&g, Interactive, &[(429, Some(0)); 9], &h, true).await;
        assert_eq!((status(&d), hits(&h)), (429, 4));
    }

    #[tokio::test]
    async fn a_pause_past_the_export_deadline_is_answered_in_place_and_trips_nothing() {
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        let go = |left: u64| {
            g.run(
                Background,
                Duration::from_secs(left),
                None,
                || {
                    h.fetch_add(1, Ordering::Relaxed);
                    async {
                        Ok::<_, ()>(Reply {
                            status: 200,
                            retry_after_ms: None,
                            inner: (),
                        })
                    }
                },
                || true,
            )
        };
        g.pause_secs(300);
        for _ in 0..4 {
            let d = go(120).await;
            assert!(matches!(&d, Done::Refused(r) if r.status == 429));
        }
        assert_eq!((hits(&h), failures(&g)), (0, 0));
        assert!(sleeps(&clock).is_empty());
        // a pause that fits the time left is waited out
        let (g2, clock2) = gate(fast());
        g2.pause_secs(60);
        let d = g2
            .run(
                Background,
                Duration::from_secs(120),
                None,
                || async {
                    Ok::<_, ()>(Reply {
                        status: 200,
                        retry_after_ms: None,
                        inner: (),
                    })
                },
                || true,
            )
            .await;
        assert_eq!(status(&d), 200);
        assert_eq!(sleeps(&clock2), [60_000]);
    }

    #[test]
    fn three_malformed_records_in_a_row_open_the_breaker() {
        let (g, clock) = gate(fast());
        g.record_checked(false);
        g.record_checked(false);
        g.record_checked(true);
        g.record_checked(false);
        g.record_checked(false);
        assert_eq!(failures(&g), 0);
        g.record_checked(false);
        assert!(!g.breaker.lock().unwrap().allow(clock.now_ms()));
    }

    #[tokio::test]
    async fn an_interactive_call_gives_up_instead_of_waiting_past_five_seconds() {
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        let d = call(&g, Interactive, &[(429, Some(10))], &h, true).await;
        assert_eq!((status(&d), hits(&h)), (429, 1));
        assert!(sleeps(&clock).is_empty());
        // the pause holds the next interactive call too: refused without a request
        let d = call(&g, Interactive, &[], &h, true).await;
        assert!(
            matches!(&d, Done::Refused(r) if r.status == 429 && r.retry_after_secs == Some(10))
        );
        assert_eq!(hits(&h), 1);
    }

    #[tokio::test]
    async fn the_429_received_is_what_the_caller_gets_when_the_budget_runs_out() {
        // one token every 10 s: after the pause the retry would wait past the budget
        let (g, clock) = gate(Limits::new(0.1, 1));
        let h = AtomicU32::new(0);
        let d = call(&g, Interactive, &[(429, Some(4))], &h, true).await;
        assert!(matches!(&d, Done::Reply(r) if r.status == 429));
        assert_eq!(hits(&h), 1);
        assert_eq!(sleeps(&clock), [4_000]);
        assert_eq!(failures(&g), 0);
    }

    #[tokio::test]
    async fn a_throttle_never_opens_the_breaker() {
        let (g, _) = gate(fast());
        let h = AtomicU32::new(0);
        for _ in 0..3 {
            let d = call(&g, Interactive, &[(503, Some(0)); 4], &h, true).await;
            assert_eq!(status(&d), 503);
            h.store(0, Ordering::Relaxed);
        }
        assert_eq!(failures(&g), 0);
    }

    #[tokio::test]
    async fn a_request_that_cannot_be_replayed_gets_the_429() {
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        let d = call(&g, Background, &[(429, Some(2))], &h, false).await;
        assert_eq!((status(&d), hits(&h)), (429, 1));
        assert!(sleeps(&clock).is_empty());
        // the pause still holds the limiter
        let d = call(&g, Background, &[], &h, true).await;
        assert_eq!(status(&d), 200);
        assert_eq!(sleeps(&clock), [2_000]);
    }

    #[tokio::test]
    async fn a_spent_daily_quota_is_skipped_without_a_request_until_midnight() {
        let (g, clock) = gate(Limits {
            daily_quota: Some(2),
            ..fast()
        });
        let h = AtomicU32::new(0);
        assert_eq!(status(&call(&g, Background, &[], &h, true).await), 200);
        assert_eq!(status(&call(&g, Interactive, &[], &h, true).await), 200);
        let d = call(&g, Interactive, &[], &h, true).await;
        assert!(matches!(&d, Done::Refused(r) if r.status == 429));
        assert_eq!(hits(&h), 2);
        clock.now.store(DAY_MS, Ordering::Relaxed);
        assert_eq!(status(&call(&g, Background, &[], &h, true).await), 200);
        assert_eq!(hits(&h), 3);
    }

    #[tokio::test]
    async fn quota_spent_stops_requests_until_midnight() {
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        g.quota_spent();
        let d = call(&g, Background, &[], &h, true).await;
        assert!(matches!(&d, Done::Refused(r) if r.message == "stub daily quota spent"));
        assert_eq!(hits(&h), 0);
        clock.now.store(DAY_MS, Ordering::Relaxed);
        assert_eq!(status(&call(&g, Background, &[], &h, true).await), 200);
    }

    #[test]
    fn set_limits_keeps_the_background_share() {
        let (g, _) = gate(Limits {
            background_share: 0.5,
            ..fast()
        });
        g.set_limits(2.0, 2, Some(10));
        let l = g.limits();
        assert_eq!((l.rate_per_sec, l.burst, l.daily_quota), (2.0, 2, Some(10)));
        assert_eq!(l.background_share, 0.5);
    }

    #[tokio::test]
    async fn a_retry_hint_pauses_the_limiter() {
        let (g, clock) = gate(fast());
        let h = AtomicU32::new(0);
        g.pause_secs(3);
        assert_eq!(status(&call(&g, Background, &[], &h, true).await), 200);
        assert_eq!(sleeps(&clock), [3_000]);
    }

    #[tokio::test]
    async fn a_plugin_pause_of_hours_is_kept_and_answered_with_its_length() {
        let (g, _) = gate(fast());
        let g = g.with_max_pause_secs(86_400);
        let h = AtomicU32::new(0);
        let go = || {
            g.run(
                Background,
                Duration::from_secs(120),
                None,
                || {
                    h.fetch_add(1, Ordering::Relaxed);
                    async {
                        Ok::<_, ()>(Reply {
                            status: 200,
                            retry_after_ms: None,
                            inner: (),
                        })
                    }
                },
                || true,
            )
        };
        g.pause_secs(7_200);
        let d = go().await;
        assert!(
            matches!(&d, Done::Refused(r) if r.status == 429 && r.retry_after_secs == Some(7_200))
        );
        g.pause_secs(10 * 86_400);
        let d = go().await;
        assert!(matches!(&d, Done::Refused(r) if r.retry_after_secs == Some(86_400)));
        assert_eq!(hits(&h), 0);
        g.clear_pause();
        assert_eq!(status(&go().await), 200);
        // a plugin that did not opt in is held to 5 minutes
        let (g2, _) = gate(fast());
        g2.pause_secs(7_200);
        let d = g2
            .run(
                Background,
                Duration::from_secs(120),
                None,
                || async {
                    Ok::<_, ()>(Reply {
                        status: 200,
                        retry_after_ms: None,
                        inner: (),
                    })
                },
                || true,
            )
            .await;
        assert!(matches!(&d, Done::Refused(r) if r.retry_after_secs == Some(300)));
    }

    #[test]
    fn the_manifest_key_opts_in_to_long_pauses() {
        let block = |extra: &str| {
            serde_json::from_str::<Value>(&format!(
                r#"{{"limits": {{"ratePerSec": 1.0, "burst": 1{extra}}}}}"#
            ))
            .unwrap()
        };
        let pause = |b: &Value| Gate::from_block("p", b).unwrap().max_pause_ms;
        assert_eq!(pause(&block("")), MAX_PAUSE_MS);
        assert_eq!(pause(&block(r#", "maxPauseSecs": 86400"#)), 86_400_000);
    }

    #[tokio::test]
    async fn an_open_breaker_spends_no_token() {
        let (g, _) = gate(Limits::new(1000.0, 4));
        let h = AtomicU32::new(0);
        for _ in 0..3 {
            call(&g, Interactive, &[(500, None); 3], &h, true).await;
        }
        let d = call(&g, Interactive, &[], &h, true).await;
        assert!(matches!(&d, Done::Refused(r) if r.status == 503));
        assert_eq!(hits(&h), 3);
        // the fourth burst token is still there: three calls took three
        assert!(g.limiter.lock().unwrap().take(0, 0, Interactive).is_ok());
    }

    #[tokio::test]
    async fn the_rate_makes_a_call_wait_for_its_token() {
        let (g, clock) = gate(Limits::new(10.0, 1));
        let h = AtomicU32::new(0);
        call(&g, Interactive, &[], &h, true).await;
        call(&g, Interactive, &[], &h, true).await;
        assert_eq!(sleeps(&clock), [100]);
    }

    async fn ok_after(g: &Gate, queued: Option<&Arc<RateWait>>, done: &Mutex<Vec<u8>>, n: u8) {
        let attempt = || async {
            done.lock().unwrap().push(n);
            Ok::<_, ()>(Reply {
                status: 200,
                retry_after_ms: None,
                inner: (),
            })
        };
        g.run(Interactive, Duration::MAX, queued, attempt, || true)
            .await;
    }

    #[tokio::test]
    async fn waiters_take_their_token_in_arrival_order() {
        let g = Arc::new(Gate::new(
            "stub",
            Limits::new(10.0, 1),
            Duration::from_secs(5),
        ));
        let done = Arc::new(Mutex::new(vec![]));
        ok_after(&g, None, &done, 0).await;
        let early = tokio::spawn({
            let (g, done) = (g.clone(), done.clone());
            async move { ok_after(&g, None, &done, 1).await }
        });
        // Late enough that its own token wait would end before the earlier waiter's.
        tokio::time::sleep(Duration::from_millis(80)).await;
        ok_after(&g, None, &done, 2).await;
        early.await.unwrap();
        assert_eq!(*done.lock().unwrap(), [0, 1, 2]);
    }

    #[tokio::test]
    async fn the_cut_does_not_count_the_wait_for_a_rate_slot() {
        let g = Gate::new("stub", Limits::new(4.0, 1), Duration::from_secs(5));
        let done = Mutex::new(vec![]);
        let cut = Duration::from_millis(100);
        let queued = || RATE_WAIT.try_with(Arc::clone).ok();
        let two = cut_past_rate_wait(cut, async {
            ok_after(&g, queued().as_ref(), &done, 0).await;
            ok_after(&g, queued().as_ref(), &done, 1).await;
        });
        assert!(
            two.await.is_some(),
            "the second call waits 250ms for its token"
        );
        let slow = cut_past_rate_wait(cut, tokio::time::sleep(Duration::from_millis(300)));
        assert!(slow.await.is_none());
    }

    #[test]
    fn each_upstream_host_has_its_own_limiter_pause_and_breaker() {
        let block = serde_json::json!({"limits": {"ratePerSec": 1.0, "burst": 1}});
        let gates = Gates::from_block("p", &block).unwrap();
        let (a, b) = (gates.for_host("a.example"), gates.for_host("b.example"));
        assert!(!Arc::ptr_eq(&a, &b) && Arc::ptr_eq(&a, &gates.for_host("a.example")));
        assert!(Arc::ptr_eq(&a, &gates.for_host("A.Example.")));
        a.pause_secs(60);
        assert!(a.limiter.lock_clean().take(0, 0, Interactive).is_err());
        assert!(b.limiter.lock_clean().take(0, 0, Interactive).is_ok());
        for _ in 0..BREAKER_FAILURES {
            a.record(Outcome::Transient);
        }
        assert!(!a.breaker.lock_clean().allow(1));
        assert!(b.breaker.lock_clean().allow(1));
        gates.set_limits(5.0, 3, None);
        assert_eq!(b.limits().burst, 3);
        assert_eq!(gates.for_host("c.example").limits().rate_per_sec, 5.0);
        gates.clear_pause();
        assert!(a.limiter.lock_clean().take(2_000, 0, Interactive).is_ok());
    }

    #[test]
    fn hosts_past_the_cap_share_one_gate() {
        let block = serde_json::json!({"limits": {"ratePerSec": 1.0, "burst": 1}});
        let gates = Gates::from_block("p", &block).unwrap();
        for i in 0..MAX_HOSTS {
            gates.for_host(&format!("h{i}.example"));
        }
        let (x, y) = (gates.for_host("x.example"), gates.for_host("y.example"));
        assert!(Arc::ptr_eq(&x, &y));
        assert!(!Arc::ptr_eq(&x, &gates.for_host("h0.example")));
        assert_eq!(gates.hosts.lock_clean().len(), MAX_HOSTS + 1);
    }

    #[tokio::test]
    async fn each_export_remembers_the_gate_of_its_own_latest_request() {
        let block = serde_json::json!({"limits": {"ratePerSec": 100.0, "burst": 100}});
        let gates = Arc::new(Gates::from_block("p", &block).unwrap());
        let (mut one, mut two) = (hook(Some(gates.clone())), hook(Some(gates.clone())));
        let (port, _) = serve(&[]).await;
        post(&mut one, port, 1).await;
        let other = gates.for_host("other.example");
        assert!(!Arc::ptr_eq(one.last.as_ref().unwrap(), &other));
        assert!(two.last.is_none());
        post(&mut two, port, 1).await;
        assert!(Arc::ptr_eq(
            one.last.as_ref().unwrap(),
            two.last.as_ref().unwrap()
        ));
    }

    #[test]
    fn the_gate_reads_the_manifest_block() {
        let block = serde_json::json!({
            "limits": {"ratePerSec": 4.0, "burst": 8, "dailyQuota": 100, "backgroundShare": 0.5},
            "requestTimeoutMs": 2500,
        });
        let g = Gate::from_block("p", &block).unwrap();
        let l = g.limits();
        assert_eq!(
            (l.rate_per_sec, l.burst, l.daily_quota),
            (4.0, 8, Some(100))
        );
        assert_eq!(l.background_share, 0.5);
        assert_eq!(g.timeout, Duration::from_millis(2500));
        let bare = serde_json::json!({"limits": {"ratePerSec": 1.0, "burst": 1}});
        let g = Gate::from_block("p", &bare).unwrap();
        assert_eq!(g.timeout, DEFAULT_REQUEST_TIMEOUT);
        assert_eq!(g.limits().background_share, 0.75);
    }

    #[test]
    fn the_override_rewrites_listed_hosts_only() {
        let o = Override::parse(
            "API.example.com=http://127.0.0.1:9100/v3/, bad, x=ftp://h, other.test=https://stub.test",
        );
        let mut u: http::Uri = "https://api.example.com/search?q=a".parse().unwrap();
        assert!(o.rewrite(&mut u));
        assert_eq!(u.to_string(), "http://127.0.0.1:9100/v3/search?q=a");
        let mut u: http::Uri = "https://other.test/x".parse().unwrap();
        assert!(o.rewrite(&mut u));
        assert_eq!(u.to_string(), "https://stub.test/x");
        let mut u: http::Uri = "https://x/y".parse().unwrap();
        assert!(!o.rewrite(&mut u));
        assert_eq!(u.to_string(), "https://x/y");
    }

    fn body(n: usize) -> WasiBody {
        Full::new(Bytes::from(vec![b'a'; n]))
            .map_err(|e| match e {})
            .boxed_unsync()
    }

    #[tokio::test]
    async fn the_tee_keeps_a_small_body_and_drops_a_large_one() {
        for (n, replayable) in [(3, true), (MAX_REPLAY, true), (MAX_REPLAY + 1, false)] {
            let rec = Arc::new(Mutex::new(Recorded::default()));
            Tee::new(body(n), rec.clone()).collect().await.unwrap();
            let rec = rec.lock().unwrap();
            assert_eq!(rec.replayable(), replayable, "{n} bytes");
            assert_eq!(rec.buf.len(), if replayable { n } else { 0 });
        }
    }

    /// Answers each connection with the next scripted status and records the request bodies.
    async fn serve(script: &'static [(u16, &'static str)]) -> (u16, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            for (status, after) in script.iter().copied().chain(std::iter::repeat((200, ""))) {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                let split = loop {
                    let n = s.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..split]).to_lowercase();
                let len: usize = head
                    .split("content-length: ")
                    .nth(1)
                    .and_then(|v| v.split("\r\n").next()?.parse().ok())
                    .unwrap_or(0);
                while buf.len() < split + len {
                    let n = s.read(&mut chunk).await.unwrap();
                    buf.extend_from_slice(&chunk[..n]);
                }
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[split..]).into_owned());
                let extra = if after.is_empty() {
                    String::new()
                } else {
                    format!("retry-after: {after}\r\n")
                };
                let reply = format!(
                    "HTTP/1.1 {status} X\r\n{extra}content-length: 2\r\nconnection: close\r\n\r\nok"
                );
                let _ = s.write_all(reply.as_bytes()).await;
            }
        });
        (port, seen)
    }

    fn hook(gate: Option<Arc<Gates>>) -> Outbound {
        Outbound {
            plugin_id: "p".into(),
            internal: true,
            net: Arc::new(crate::net::guard::SystemNet::new()),
            permits: Arc::new(Semaphore::new(4)),
            gate,
            last: None,
            priority: Background,
            deadline: Instant::now() + Duration::from_secs(600),
            last_refused: Arc::default(),
            queued: None,
            over: Arc::new(Override::default()),
        }
    }

    async fn post(h: &mut Outbound, port: u16, n: usize) -> u16 {
        let mut req = http::Request::new(body(n));
        *req.method_mut() = http::Method::POST;
        *req.uri_mut() = format!("http://127.0.0.1:{port}/x").parse().unwrap();
        req.headers_mut()
            .insert(http::header::CONTENT_LENGTH, n.into());
        let io: IoFuture = Box::new(std::future::ready(Ok(())));
        let sent = Box::into_pin(h.send_request(req, None, io)).await;
        sent.unwrap_or_else(|e| panic!("{e:?}")).0.status().as_u16()
    }

    #[tokio::test]
    async fn the_hook_replays_a_small_post_and_hands_a_large_one_the_429() {
        let (g, clock) = gate(fast());
        let mut h = hook(Some(Arc::new(Gates::of("127.0.0.1", g))));
        let (port, seen) = serve(&[(429, "2")]).await;
        assert_eq!(post(&mut h, port, 3).await, 200);
        assert_eq!(*seen.lock().unwrap(), ["aaa", "aaa"]);
        assert_eq!(sleeps(&clock), [2_000]);
        let (port, seen) = serve(&[(429, "1")]).await;
        assert_eq!(post(&mut h, port, MAX_REPLAY + 1).await, 429);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_hook_replays_a_get_whose_body_stream_never_ends() {
        let (g, _) = gate(fast());
        let mut h = hook(Some(Arc::new(Gates::of("127.0.0.1", g))));
        let (port, seen) = serve(&[(503, "0")]).await;
        let pending = futures_util::stream::pending::<
            Result<http_body::Frame<Bytes>, std::convert::Infallible>,
        >();
        let mut req = http::Request::new(
            http_body_util::StreamBody::new(pending)
                .map_err(|e| match e {})
                .boxed_unsync(),
        );
        *req.uri_mut() = format!("http://127.0.0.1:{port}/x").parse().unwrap();
        let io: IoFuture = Box::new(std::future::ready(Ok(())));
        let sent = Box::into_pin(h.send_request(req, None, io)).await;
        assert_eq!(sent.unwrap().0.status().as_u16(), 200);
        assert_eq!(seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn without_a_gate_a_429_is_not_replayed() {
        let mut h = hook(None);
        let (port, seen) = serve(&[(429, "2")]).await;
        assert_eq!(post(&mut h, port, 3).await, 429);
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn the_hook_answers_for_a_spent_quota_without_a_request() {
        let (g, _) = gate(fast());
        g.quota_spent();
        let mut h = hook(Some(Arc::new(Gates::of("127.0.0.1", g))));
        let (port, seen) = serve(&[]).await;
        assert_eq!(post(&mut h, port, 3).await, 429);
        assert!(seen.lock().unwrap().is_empty());
        // the plugin echoing this 429 as `rate-limited` must not pause the gate again
        assert!(h.last_refused.load(Ordering::SeqCst));
    }
}

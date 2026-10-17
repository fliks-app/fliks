//! Wasm runtime: engine, instances, lanes, supervision (`plugins.md` rules 39-47).
use super::db::PluginDb;
use super::logs::{Logs, Pipe};
use super::outbound::Outbound;
use crate::net::guard::Net;
use futures_util::future::BoxFuture;
use serde_json::Value as Json;
use sqlx::PgPool;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, Semaphore, watch};
use wasmtime::component::{Component, HasSelf, Linker, ResourceTable};
use wasmtime::{Engine, ResourceLimiter, Store, Trap, UpdateDeadline};
use wasmtime_wasi::{FsPerms, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpCtxView, WasiHttpView};

wasmtime::component::bindgen!({
    path: "../plugin-sdk/wit",
    world: "fliks:plugin/plugin",
    imports: { default: async },
    exports: { default: async },
    with: {
        "wasi:cli": wasmtime_wasi::p2::bindings::cli,
        "wasi:clocks": wasmtime_wasi::p2::bindings::clocks,
        "wasi:filesystem": wasmtime_wasi::p2::bindings::filesystem,
        "wasi:io": wasmtime_wasi::p2::bindings::io,
        "wasi:random": wasmtime_wasi::p2::bindings::random,
        "wasi:sockets": wasmtime_wasi::p2::bindings::sockets,
        "wasi:http": wasmtime_wasi_http::p2::bindings::http,
    },
    require_store_data_send: true,
});

pub use fliks::plugin::db::{DbError, Param, RowSet, Value};
pub use fliks::plugin::types::{
    HealthReport, HostError, HttpRequest, HttpResponse, ManifestCheck, Principal,
};

pub const EPOCH_TICK: Duration = Duration::from_millis(100);

#[derive(Clone, Debug)]
pub struct Deadlines {
    pub hello: Duration,
    pub start: Duration,
    pub short: Duration,
    pub event: Duration,
    pub http: Duration,
    pub pre_roll: Duration,
    pub job: Duration,
    pub scheduled: Duration,
    pub db_query: Duration,
    pub queue_wait: Duration,
}

impl Default for Deadlines {
    fn default() -> Self {
        let s = Duration::from_secs;
        Deadlines {
            hello: s(10),
            start: s(900),
            short: s(3),
            event: s(60),
            http: s(180),
            pre_roll: s(3),
            job: s(3600),
            scheduled: s(300),
            db_query: s(60),
            queue_wait: s(30),
        }
    }
}

#[derive(Clone)]
pub struct HostConfig {
    pub core_version: String,
    pub runtime_dir: PathBuf,
    pub pg: super::db::PgTarget,
    pub net: Arc<dyn Net>,
    pub deadlines: Deadlines,
    pub health_every: Duration,
    pub ladder: Vec<Duration>,
    pub breaker_crashes: usize,
    pub breaker_window: Duration,
    pub ladder_reset: Duration,
    pub lease_extra: Duration,
    pub idle_after: Duration,
    pub db_retry: Duration,
    pub http_max: usize,
    pub http_queue: usize,
    pub task_max: usize,
    /// The image the compile child runs (`/proc/self/exe` in production).
    pub compiler: PathBuf,
    pub compile_kill: Duration,
}

impl HostConfig {
    pub fn new(
        core_version: &str,
        runtime_dir: PathBuf,
        pg: super::db::PgTarget,
        net: Arc<dyn Net>,
    ) -> Self {
        HostConfig {
            core_version: core_version.into(),
            runtime_dir,
            pg,
            net,
            deadlines: Deadlines::default(),
            health_every: Duration::from_secs(15),
            ladder: [1, 2, 4, 8, 16, 30].map(Duration::from_secs).to_vec(),
            breaker_crashes: 6,
            breaker_window: Duration::from_secs(600),
            ladder_reset: Duration::from_secs(120),
            lease_extra: Duration::from_secs(60),
            idle_after: Duration::from_secs(600),
            db_retry: Duration::from_secs(30),
            http_max: 4,
            http_queue: 32,
            task_max: 2,
            compiler: super::compile::own_image(),
            compile_kill: Duration::from_secs(600),
        }
    }
}

pub struct Env {
    pub engine: Engine,
    pub linker: Linker<Ctx>,
    pub cfg: HostConfig,
    pub core: PgPool,
    pub logs: Arc<Logs>,
    pub wake: Notify,
    pub app: OnceLock<crate::state::AppState>,
}

/// The one engine configuration of the server and the compile child.
pub fn engine_config() -> wasmtime::Config {
    let mut c = wasmtime::Config::new();
    c.wasm_component_model(true).epoch_interruption(true);
    c
}

pub fn engine() -> anyhow::Result<Engine> {
    let engine = Engine::new(&engine_config())?;
    let weak = engine.weak();
    std::thread::Builder::new()
        .name("wasm-epoch".into())
        .spawn(move || {
            while let Some(e) = weak.upgrade() {
                std::thread::sleep(EPOCH_TICK);
                e.increment_epoch();
            }
        })?;
    Ok(engine)
}

pub fn linker(engine: &Engine) -> anyhow::Result<Linker<Ctx>> {
    let mut l = Linker::new(engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut l)?;
    wasmtime_wasi_http::p2::add_only_http_to_linker_async(&mut l)?;
    fliks::plugin::types::add_to_linker::<_, HasSelf<Ctx>>(&mut l, |c| c)?;
    fliks::plugin::host::add_to_linker::<_, HasSelf<Ctx>>(&mut l, |c| c)?;
    fliks::plugin::db::add_to_linker::<_, HasSelf<Ctx>>(&mut l, |c| c)?;
    fliks::plugin::log::add_to_linker::<_, HasSelf<Ctx>>(&mut l, |c| c)?;
    Ok(l)
}

/// Host call counters of rule 47 (latencies: the last 256).
#[derive(Default)]
pub struct CallStats {
    pub count: AtomicU64,
    pub failures: AtomicU64,
    latencies: Mutex<VecDeque<f64>>,
}

impl CallStats {
    pub fn record(&self, started: Instant, ok: bool) {
        self.count.fetch_add(1, Ordering::Relaxed);
        if !ok {
            self.failures.fetch_add(1, Ordering::Relaxed);
        }
        let mut l = self.latencies.lock().unwrap();
        if l.len() == 256 {
            l.pop_front();
        }
        l.push_back(started.elapsed().as_secs_f64() * 1000.0);
    }

    /// Nearest rank, rounded to 0.1 ms; `None` with no calls.
    pub fn p95(&self) -> Option<f64> {
        let mut v: Vec<f64> = self.latencies.lock().unwrap().iter().copied().collect();
        if v.is_empty() {
            return None;
        }
        v.sort_by(f64::total_cmp);
        let rank = ((0.95 * v.len() as f64).ceil() as usize)
            .saturating_sub(1)
            .min(v.len() - 1);
        Some((v[rank] * 10.0).round() / 10.0)
    }
}

/// What host imports see of their plugin.
pub struct Shared {
    pub id: Arc<str>,
    pub env: Arc<Env>,
    pub db: Option<Arc<PluginDb>>,
    pub scopes: Vec<String>,
    pub ingest_roots: Vec<String>,
    /// Bumped by a stop: instances of an older generation trap at their next epoch tick.
    pub era: AtomicU64,
    pub stopped: Notify,
    pub mem_total: AtomicUsize,
    pub stats: CallStats,
}

pub struct Ctx {
    wasi: WasiCtx,
    http: WasiHttpCtx,
    table: ResourceTable,
    out: Outbound,
    pub sh: Arc<Shared>,
    pub deadline: Instant,
    era: u64,
    mem: usize,
    mem_max: usize,
    /// Set by a `db` call that failed `unavailable` during the current export (C109).
    pub db_unavailable: bool,
}

impl WasiView for Ctx {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for Ctx {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: &mut self.out,
        }
    }
}

impl ResourceLimiter for Ctx {
    fn memory_growing(
        &mut self,
        current: usize,
        desired: usize,
        _: Option<usize>,
    ) -> wasmtime::Result<bool> {
        if desired > self.mem_max {
            wasmtime::bail!("memory limit of {} MiB exceeded", self.mem_max >> 20);
        }
        self.mem += desired - current;
        self.sh
            .mem_total
            .fetch_add(desired - current, Ordering::Relaxed);
        Ok(true)
    }
    fn table_growing(
        &mut self,
        _: usize,
        desired: usize,
        _: Option<usize>,
    ) -> wasmtime::Result<bool> {
        Ok(desired <= 100_000)
    }
}

pub struct Inst {
    store: Store<Ctx>,
    guest: Plugin,
    cfg_gen: u64,
}

impl Drop for Inst {
    fn drop(&mut self) {
        let d = self.store.data();
        d.sh.mem_total.fetch_sub(d.mem, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// Not ready, lane in backoff, queue full or waited too long, stopped: the proxy answers 503.
    Unavailable(String),
    /// The deadline passed; the instance was dropped and the crash counted (C105).
    Timeout,
    /// A trap; the instance was dropped and the crash counted.
    Crashed(String),
    /// A job lane is already running (no-overlap guard).
    Busy,
    /// The guest answered `Err`: not a crash.
    Guest(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaneKind {
    Core,
    Event,
    Http,
    Task,
    Job,
}

pub struct Lane {
    pub kind: LaneKind,
    max: usize,
    queue: usize,
    idle: Mutex<Vec<(Inst, Instant)>>,
    pub live: AtomicUsize,
    sem: Semaphore,
    waiting: AtomicUsize,
    retry_at: Mutex<Option<Instant>>,
    /// Whether the lane's last call saw a `db` call fail `unavailable`.
    last_db: AtomicBool,
}

struct Waiting<'a>(&'a AtomicUsize);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

type CallFn<R> = Box<dyn for<'a> FnOnce(&'a mut Inst) -> BoxFuture<'a, wasmtime::Result<R>> + Send>;

/// How long a call may wait for an instance and run on it.
#[derive(Clone, Copy)]
pub struct Budget {
    pub deadline: Duration,
    pub queue_wait: Duration,
    /// Pre-roll: one bound over the wait and the call.
    pub inclusive: bool,
}

impl Budget {
    pub fn of(deadline: Duration) -> Self {
        Budget {
            deadline,
            queue_wait: deadline,
            inclusive: false,
        }
    }
}

impl Lane {
    fn new(kind: LaneKind, max: usize, queue: usize) -> Self {
        Lane {
            kind,
            max,
            queue,
            idle: Mutex::new(Vec::new()),
            live: AtomicUsize::new(0),
            sem: Semaphore::new(max),
            waiting: AtomicUsize::new(0),
            retry_at: Mutex::new(None),
            last_db: AtomicBool::new(false),
        }
    }

    pub fn free(&self) -> usize {
        self.sem.available_permits()
    }

    fn clear(&self) {
        let gone = std::mem::take(&mut *self.idle.lock().unwrap());
        self.live.fetch_sub(gone.len(), Ordering::SeqCst);
    }

    fn put(&self, inst: Inst) {
        self.live.fetch_add(1, Ordering::SeqCst);
        self.idle.lock().unwrap().push((inst, Instant::now()));
    }

    /// Drops the instances idle for `after` (rule 40: `http`, `task`, `job` lanes only).
    fn reap(&self, after: Duration) -> usize {
        let mut idle = self.idle.lock().unwrap();
        let before = idle.len();
        idle.retain(|(_, at)| at.elapsed() < after);
        let gone = before - idle.len();
        self.live.fetch_sub(gone, Ordering::SeqCst);
        gone
    }

    async fn call<R: Send>(
        &self,
        rt: &Arc<PluginRt>,
        budget: Budget,
        f: CallFn<R>,
    ) -> Result<R, CallError> {
        let entered = tokio::time::Instant::now();
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= self.max + self.queue {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return Err(if self.queue == 0 {
                CallError::Busy
            } else {
                CallError::Unavailable("queue full".into())
            });
        }
        let _w = Waiting(&self.waiting);
        let _permit = if self.queue == 0 {
            self.sem.try_acquire().map_err(|_| CallError::Busy)?
        } else {
            let wait = if budget.inclusive {
                budget.deadline
            } else {
                budget.queue_wait
            };
            match tokio::time::timeout_at(entered + wait, self.sem.acquire()).await {
                Ok(p) => p.expect("never closed"),
                Err(_) => return Err(CallError::Unavailable("queue wait".into())),
            }
        };
        let until = if budget.inclusive {
            entered + budget.deadline
        } else {
            tokio::time::Instant::now() + budget.deadline
        };
        let era = rt.sh.era.load(Ordering::SeqCst);
        let pooled = self.idle.lock().unwrap().pop();
        let mut inst = match pooled {
            Some((i, _)) => i,
            None => {
                if let Some(at) = *self.retry_at.lock().unwrap()
                    && Instant::now() < at
                {
                    return Err(CallError::Unavailable("backoff".into()));
                }
                match rt.instantiate().await {
                    Ok(i) => {
                        self.live.fetch_add(1, Ordering::SeqCst);
                        i
                    }
                    Err(e) => {
                        rt.crash(self, &e.to_string());
                        return Err(CallError::Unavailable(e.to_string()));
                    }
                }
            }
        };
        {
            let d = inst.store.data_mut();
            d.deadline = until.into_std();
            d.db_unavailable = false;
        }
        let cfg_gen = rt.cfg_gen.load(Ordering::SeqCst);
        let keys = (inst.cfg_gen < cfg_gen).then(|| rt.cfg_keys.lock().unwrap().clone());
        let stopped = rt.sh.stopped.notified();
        tokio::pin!(stopped);
        stopped.as_mut().enable();
        if rt.sh.era.load(Ordering::SeqCst) != era {
            self.live.fetch_sub(1, Ordering::SeqCst);
            return Err(CallError::Unavailable("stopped".into()));
        }
        let res = {
            let work = async {
                if let Some(keys) = keys {
                    let Inst { store, guest, .. } = &mut inst;
                    guest
                        .fliks_plugin_guest()
                        .call_config_changed(&mut *store, &keys)
                        .await?;
                    inst.cfg_gen = cfg_gen;
                }
                f(&mut inst).await
            };
            tokio::select! {
                r = tokio::time::timeout_at(until, work) => r,
                _ = stopped => {
                    self.live.fetch_sub(1, Ordering::SeqCst);
                    return Err(CallError::Unavailable("stopped".into()));
                }
            }
        };
        let db = inst.store.data().db_unavailable;
        self.last_db.store(db, Ordering::SeqCst);
        let current = rt.sh.era.load(Ordering::SeqCst) == era;
        match res {
            Ok(Ok(r)) => {
                if current {
                    self.idle.lock().unwrap().push((inst, Instant::now()));
                } else {
                    self.live.fetch_sub(1, Ordering::SeqCst);
                }
                Ok(r)
            }
            Ok(Err(trap)) => {
                drop(inst);
                self.live.fetch_sub(1, Ordering::SeqCst);
                let why = format!("{trap:?}");
                // The epoch callback interrupts at the call's deadline: that is a timeout (rule 39).
                let timeout = trap.downcast_ref::<Trap>() == Some(&Trap::Interrupt);
                if current {
                    rt.lost(self, db, if timeout { "deadline" } else { &why });
                }
                if timeout {
                    return Err(CallError::Timeout);
                }
                Err(CallError::Crashed(why))
            }
            Err(_) => {
                drop(inst);
                self.live.fetch_sub(1, Ordering::SeqCst);
                if current {
                    rt.lost(self, db, "deadline");
                }
                Err(CallError::Timeout)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Stopped,
    Starting,
    Handshaking,
    Ready,
    Degraded,
    Crashed,
    Backoff,
    Failed,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            State::Stopped => "stopped",
            State::Starting => "starting",
            State::Handshaking => "handshaking",
            State::Ready => "ready",
            State::Degraded => "degraded",
            State::Crashed => "crashed",
            State::Backoff => "backoff",
            State::Failed => "failed",
        }
    }
}

struct Sup {
    crashes: VecDeque<Instant>,
    ladder: usize,
    ready_since: Option<Instant>,
    misses: u32,
    message: String,
    /// `start` failed only because the database was unreachable (C109).
    db_down: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Timings {
    pub compile: Duration,
    pub cache_hit: bool,
    pub first_hello: Duration,
    pub start: Duration,
}

pub struct PluginRt {
    pub sh: Arc<Shared>,
    pub timings: Mutex<Timings>,
    pub manifest: Json,
    pre: PluginPre<Ctx>,
    internal: bool,
    mem_max: usize,
    pub core: Lane,
    pub event: Lane,
    pub http: Lane,
    pub task: Lane,
    pub jobs: HashMap<String, Lane>,
    sup: Mutex<Sup>,
    state: watch::Sender<State>,
    ring: Mutex<VecDeque<(String, String)>>,
    ring_wake: Notify,
    pub event_drops: AtomicU64,
    cfg_gen: AtomicU64,
    cfg_keys: Mutex<Vec<String>>,
    pub restarts: AtomicU64,
}

#[derive(Debug)]
pub enum SpawnError {
    Mismatch(String),
    Failed(String),
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SpawnError::Mismatch(d) => write!(f, "manifest-mismatch: {d}"),
            SpawnError::Failed(d) => write!(f, "spawn-failed: {d}"),
        }
    }
}

const RING: usize = 64;

fn call_fn<R: Send + 'static>(
    f: impl for<'a> FnOnce(&'a mut Inst) -> BoxFuture<'a, wasmtime::Result<R>> + Send + 'static,
) -> CallFn<R> {
    Box::new(f)
}

impl PluginRt {
    pub fn new(
        sh: Arc<Shared>,
        manifest: Json,
        component: &Component,
        internal: bool,
    ) -> anyhow::Result<Arc<Self>> {
        let env = sh.env.clone();
        let pre = PluginPre::new(env.linker.instantiate_pre(component)?)?;
        let jobs = manifest["jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|j| j["name"].as_str())
            .map(|n| (n.to_owned(), Lane::new(LaneKind::Job, 1, 0)))
            .collect();
        let c = &env.cfg;
        Ok(Arc::new(PluginRt {
            mem_max: manifest["memoryMb"].as_f64().unwrap_or(64.0).max(1.0) as usize * (1 << 20),
            manifest,
            pre,
            internal,
            core: Lane::new(LaneKind::Core, 1, 32),
            event: Lane::new(LaneKind::Event, 1, 0),
            http: Lane::new(LaneKind::Http, c.http_max, c.http_queue),
            task: Lane::new(LaneKind::Task, c.task_max, 0),
            jobs,
            sup: Mutex::new(Sup {
                crashes: VecDeque::new(),
                ladder: 0,
                ready_since: None,
                misses: 0,
                message: String::new(),
                db_down: false,
            }),
            state: watch::channel(State::Stopped).0,
            ring: Mutex::new(VecDeque::new()),
            ring_wake: Notify::new(),
            event_drops: AtomicU64::new(0),
            cfg_gen: AtomicU64::new(0),
            cfg_keys: Mutex::new(Vec::new()),
            restarts: AtomicU64::new(0),
            timings: Mutex::default(),
            sh,
        }))
    }

    pub fn state(&self) -> State {
        *self.state.borrow()
    }

    pub fn watch(&self) -> watch::Receiver<State> {
        self.state.subscribe()
    }

    /// The breaker message, else (in a down state) the stderr tail.
    pub fn message(&self) -> String {
        let m = self.sup.lock().unwrap().message.clone();
        if !m.is_empty() {
            return m;
        }
        if matches!(
            self.state(),
            State::Crashed | State::Backoff | State::Failed | State::Degraded
        ) {
            return self.sh.env.logs.tail(&self.sh.id);
        }
        String::new()
    }

    fn set_state(&self, s: State) {
        {
            let mut sup = self.sup.lock().unwrap();
            if s == State::Ready && sup.ready_since.is_none() {
                sup.ready_since = Some(Instant::now());
            } else if s != State::Ready && s != State::Degraded {
                sup.ready_since = None;
            }
        }
        self.state.send_replace(s);
        if s == State::Ready {
            self.ring_wake.notify_one();
            self.sh.env.wake.notify_one();
        }
    }

    fn lanes(&self) -> impl Iterator<Item = &Lane> {
        [&self.core, &self.event, &self.http, &self.task]
            .into_iter()
            .chain(self.jobs.values())
    }

    pub fn live_instances(&self) -> usize {
        self.lanes().map(|l| l.live.load(Ordering::SeqCst)).sum()
    }

    /// A fresh instance that passed `hello` and the manifest check.
    pub async fn instantiate(self: &Arc<Self>) -> Result<Inst, SpawnError> {
        let env = &self.sh.env;
        let id = self.sh.id.clone();
        let mut b = WasiCtxBuilder::new();
        b.stdout(Pipe {
            logs: env.logs.clone(),
            plugin: id.clone(),
            stderr: false,
        })
        .stderr(Pipe {
            logs: env.logs.clone(),
            plugin: id.clone(),
            stderr: true,
        })
        .allow_ip_name_lookup(false)
        .socket_addr_check(|_, _| Box::pin(async { false }));
        let data = env.cfg.runtime_dir.join("data").join(&*id);
        if std::fs::create_dir_all(&data).is_ok() {
            set_mode(&data, 0o700);
            b.preopened_dir(&data, "/data", FsPerms::ReadWrite)
                .map_err(|e| SpawnError::Failed(e.to_string()))?;
        }
        let ctx = Ctx {
            wasi: b.build(),
            http: WasiHttpCtx::new(),
            table: ResourceTable::new(),
            out: Outbound {
                plugin_id: id.clone(),
                internal: self.internal,
                net: env.cfg.net.clone(),
            },
            sh: self.sh.clone(),
            deadline: Instant::now() + env.cfg.deadlines.hello,
            era: self.sh.era.load(Ordering::SeqCst),
            mem: 0,
            mem_max: self.mem_max,
            db_unavailable: false,
        };
        let mut store = Store::new(&env.engine, ctx);
        store.limiter(|c| c);
        store.epoch_deadline_callback(|cx| {
            let d = cx.data();
            if Instant::now() >= d.deadline || d.sh.era.load(Ordering::SeqCst) != d.era {
                Err(Trap::Interrupt.into())
            } else {
                Ok(UpdateDeadline::Yield(1))
            }
        });
        store.set_epoch_deadline(1);
        let hello = env.cfg.deadlines.hello;
        let config = super::imports::config_for(&env.core, &id, None)
            .await
            .unwrap_or_default();
        let fail = |e: String| SpawnError::Failed(e);
        let work = async {
            let guest = self
                .pre
                .instantiate_async(&mut store)
                .await
                .map_err(|e| fail(format!("{e:?}")))?;
            let check = guest
                .fliks_plugin_guest()
                .call_hello(&mut store, &env.cfg.core_version, &config)
                .await
                .map_err(|e| fail(format!("{e:?}")))?
                .map_err(fail)?;
            Ok::<_, SpawnError>((guest, check))
        };
        let (guest, check) = match tokio::time::timeout(hello, work).await {
            Ok(r) => r?,
            Err(_) => return Err(fail("hello deadline".into())),
        };
        let m = &self.manifest;
        let mut bad = Vec::new();
        if m["id"].as_str() != Some(&check.id) {
            bad.push("id");
        }
        if m["version"].as_str() != Some(&check.version) {
            bad.push("version");
        }
        if m["pluginApi"].as_f64() != Some(check.plugin_api as f64) {
            bad.push("pluginApi");
        }
        if !bad.is_empty() {
            return Err(SpawnError::Mismatch(bad.join(", ")));
        }
        Ok(Inst {
            store,
            guest,
            cfg_gen: self.cfg_gen.load(Ordering::SeqCst),
        })
    }

    /// First core instance and its `hello`, under the registration lock; `start` comes after.
    pub async fn hello(self: &Arc<Self>) -> Result<(), SpawnError> {
        self.set_state(State::Starting);
        self.spawn_loops();
        let t = Instant::now();
        self.set_state(State::Handshaking);
        match self.instantiate().await {
            Ok(inst) => {
                self.timings.lock().unwrap().first_hello = t.elapsed();
                self.core.put(inst);
                Ok(())
            }
            Err(SpawnError::Mismatch(d)) => {
                self.sup.lock().unwrap().message = format!("manifest-mismatch: {d}");
                self.set_state(State::Failed);
                self.drop_all();
                Err(SpawnError::Mismatch(d))
            }
            Err(e) => {
                self.crash(&self.core, &e.to_string());
                Ok(())
            }
        }
    }

    /// `start` in the background (rule 41); a caller watches the state for `ready`.
    pub fn spawn_start(self: &Arc<Self>) {
        if self.core.live.load(Ordering::SeqCst) == 0 {
            return;
        }
        let rt = self.clone();
        tokio::spawn(async move { rt.run_start().await });
    }

    async fn run_start(self: &Arc<Self>) {
        let d = self.sh.env.cfg.deadlines.start;
        let era = self.sh.era.load(Ordering::SeqCst);
        let t = Instant::now();
        let r = self
            .core
            .call(
                self,
                Budget::of(d),
                call_fn(|i| {
                    Box::pin(
                        async move { i.guest.fliks_plugin_guest().call_start(&mut i.store).await },
                    )
                }),
            )
            .await;
        self.timings.lock().unwrap().start = t.elapsed();
        if !self.alive(era) {
            return;
        }
        let db = self.core.last_db.load(Ordering::SeqCst);
        match r {
            Ok(Ok(())) => {
                self.sup.lock().unwrap().db_down = false;
                self.set_state(State::Ready);
            }
            Ok(Err(e)) if db => {
                tracing::warn!(
                    "plugin \"{}\" start: database unreachable ({e})",
                    self.sh.id
                );
                self.db_degraded(era);
            }
            Ok(Err(e)) => {
                self.core.clear();
                self.crash(&self.core, &format!("start failed: {e}"));
            }
            Err(_) => {}
        }
    }

    /// C109: `degraded` with the core instance kept; `start` again after the ladder, then every 30 s.
    fn db_degraded(self: &Arc<Self>, era: u64) {
        let delay = {
            let mut s = self.sup.lock().unwrap();
            s.db_down = true;
            let cfg = &self.sh.env.cfg;
            let d = cfg.ladder.get(s.ladder).copied().unwrap_or(cfg.db_retry);
            s.ladder += 1;
            d
        };
        self.set_state(State::Degraded);
        let rt = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if rt.alive(era) && rt.sup.lock().unwrap().db_down {
                rt.run_start().await;
            }
        });
    }

    fn spawn_loops(self: &Arc<Self>) {
        let era = self.sh.era.load(Ordering::SeqCst);
        let rt = self.clone();
        tokio::spawn(async move { rt.health_loop(era).await });
        let rt = self.clone();
        tokio::spawn(async move { rt.event_loop(era).await });
    }

    fn alive(&self, era: u64) -> bool {
        self.sh.era.load(Ordering::SeqCst) == era
            && !matches!(self.state(), State::Failed | State::Stopped)
    }

    /// A failed call lost its instance: a crash, unless the database caused it (C109).
    fn lost(self: &Arc<Self>, lane: &Lane, db: bool, why: &str) {
        if db && lane.kind == LaneKind::Core {
            tracing::warn!(
                "plugin \"{}\" core call lost to the database ({why})",
                self.sh.id
            );
            let rt = self.clone();
            let era = self.sh.era.load(Ordering::SeqCst);
            tokio::spawn(async move { rt.recreate_core(era, Duration::ZERO).await });
            return;
        }
        self.crash(lane, why);
    }

    pub fn crash(self: &Arc<Self>, lane: &Lane, why: &str) {
        self.restarts.fetch_add(1, Ordering::SeqCst);
        let cfg = &self.sh.env.cfg;
        let now = Instant::now();
        let delay = {
            let mut s = self.sup.lock().unwrap();
            if matches!(self.state(), State::Failed | State::Stopped) {
                return;
            }
            s.crashes.push_back(now);
            while s
                .crashes
                .front()
                .is_some_and(|t| now - *t > cfg.breaker_window)
            {
                s.crashes.pop_front();
            }
            if s.crashes.len() >= cfg.breaker_crashes {
                s.message = self.sh.env.logs.tail(&self.sh.id);
                let n = s.crashes.len();
                drop(s);
                tracing::error!(
                    "plugin \"{}\" circuit breaker tripped after {n} crashes in the last 10 min ({why}); manual re-enable required",
                    self.sh.id
                );
                self.set_state(State::Failed);
                self.drop_all();
                return;
            }
            let d = cfg.ladder[s.ladder.min(cfg.ladder.len() - 1)];
            s.ladder += 1;
            d
        };
        tracing::warn!(
            "plugin \"{}\" {:?} instance crashed ({why}), retry in {delay:?}",
            self.sh.id,
            lane.kind
        );
        *lane.retry_at.lock().unwrap() = Some(now + delay);
        if lane.kind == LaneKind::Core {
            self.set_state(State::Crashed);
            self.set_state(State::Backoff);
            let rt = self.clone();
            let era = self.sh.era.load(Ordering::SeqCst);
            tokio::spawn(async move { rt.recreate_core(era, delay).await });
        }
    }

    /// A new core instance after `delay`; `start` runs again when no other instance lives.
    async fn recreate_core(self: Arc<Self>, era: u64, delay: Duration) {
        tokio::time::sleep(delay).await;
        if !self.alive(era) || self.core.live.load(Ordering::SeqCst) > 0 {
            return;
        }
        match self.instantiate().await {
            Ok(inst) => {
                let others = self.live_instances();
                self.core.put(inst);
                if others == 0 || self.sup.lock().unwrap().db_down {
                    self.run_start().await;
                } else if matches!(self.state(), State::Crashed | State::Backoff) {
                    self.set_state(State::Ready);
                }
            }
            Err(SpawnError::Mismatch(d)) => {
                self.sup.lock().unwrap().message = format!("manifest-mismatch: {d}");
                self.set_state(State::Failed);
                self.drop_all();
            }
            Err(e) => self.crash(&self.core, &e.to_string()),
        }
    }

    /// Breaker or stop: every instance goes, running ones are abandoned (rule 44).
    pub fn drop_all(&self) {
        self.sh.era.fetch_add(1, Ordering::SeqCst);
        self.sh.stopped.notify_waiters();
        for l in self.lanes() {
            l.clear();
        }
        self.ring.lock().unwrap().clear();
        self.ring_wake.notify_one();
    }

    pub async fn stop(self: &Arc<Self>) {
        if matches!(self.state(), State::Ready | State::Degraded) {
            let d = self.sh.env.cfg.deadlines.short;
            let _ = self
                .core
                .call(
                    self,
                    Budget::of(d),
                    call_fn(|i| {
                        Box::pin(async move {
                            i.guest
                                .fliks_plugin_guest()
                                .call_shutdown(&mut i.store)
                                .await
                        })
                    }),
                )
                .await;
        }
        self.set_state(State::Stopped);
        self.drop_all();
    }

    async fn health_loop(self: Arc<Self>, era: u64) {
        let cfg = &self.sh.env.cfg;
        loop {
            tokio::time::sleep(cfg.health_every).await;
            if self.sh.era.load(Ordering::SeqCst) != era {
                return;
            }
            for l in [&self.http, &self.task]
                .into_iter()
                .chain(self.jobs.values())
            {
                l.reap(cfg.idle_after);
            }
            if !matches!(self.state(), State::Ready | State::Degraded)
                || self.sup.lock().unwrap().db_down
            {
                continue;
            }
            let ok = match self.health().await {
                Ok(h) => h.ok,
                Err(_) => continue,
            };
            let db = self.core.last_db.load(Ordering::SeqCst);
            let mut s = self.sup.lock().unwrap();
            if ok {
                s.misses = 0;
                if s.ready_since
                    .is_some_and(|t| t.elapsed() >= cfg.ladder_reset)
                {
                    s.ladder = 0;
                }
                drop(s);
                if self.state() == State::Degraded {
                    self.set_state(State::Ready);
                }
                continue;
            }
            if db {
                drop(s);
                self.set_state(State::Degraded);
                continue;
            }
            s.misses += 1;
            let misses = s.misses;
            if misses >= 4 {
                s.misses = 0;
            }
            drop(s);
            if misses == 2 {
                self.set_state(State::Degraded);
            }
            if misses >= 4 {
                self.core.clear();
                self.crash(&self.core, "4 health misses");
            }
        }
    }

    pub async fn health(self: &Arc<Self>) -> Result<HealthReport, CallError> {
        let d = self.sh.env.cfg.deadlines.short;
        self.core
            .call(
                self,
                Budget::of(d),
                call_fn(|i| {
                    Box::pin(
                        async move { i.guest.fliks_plugin_guest().call_health(&mut i.store).await },
                    )
                }),
            )
            .await
    }

    pub fn push_event(&self, name: &str, payload: &str) {
        let mut r = self.ring.lock().unwrap();
        if r.len() == RING {
            r.pop_front();
            self.event_drops.fetch_add(1, Ordering::SeqCst);
        }
        r.push_back((name.to_owned(), payload.to_owned()));
        self.ring_wake.notify_one();
    }

    async fn event_loop(self: Arc<Self>, era: u64) {
        let d = self.sh.env.cfg.deadlines.event;
        loop {
            if self.sh.era.load(Ordering::SeqCst) != era {
                return;
            }
            let next = (self.state() == State::Ready)
                .then(|| self.ring.lock().unwrap().pop_front())
                .flatten();
            let Some((name, payload)) = next else {
                let _ =
                    tokio::time::timeout(Duration::from_secs(1), self.ring_wake.notified()).await;
                continue;
            };
            let _ = self
                .event
                .call(
                    &self,
                    Budget::of(d),
                    call_fn(move |i| {
                        Box::pin(async move {
                            i.guest
                                .fliks_plugin_guest()
                                .call_event(&mut i.store, &name, &payload)
                                .await
                        })
                    }),
                )
                .await;
        }
    }

    fn ready(&self) -> Result<(), CallError> {
        match self.state() {
            State::Ready => Ok(()),
            s => Err(CallError::Unavailable(s.as_str().into())),
        }
    }

    pub async fn http(
        self: &Arc<Self>,
        req: HttpRequest,
        pre_roll: bool,
    ) -> Result<HttpResponse, CallError> {
        self.ready()?;
        let d = &self.sh.env.cfg.deadlines;
        let budget = if pre_roll {
            Budget {
                deadline: d.pre_roll,
                queue_wait: d.pre_roll,
                inclusive: true,
            }
        } else {
            Budget {
                deadline: d.http,
                queue_wait: d.queue_wait,
                inclusive: false,
            }
        };
        self.http
            .call(
                self,
                budget,
                call_fn(move |i| {
                    Box::pin(async move {
                        i.guest
                            .fliks_plugin_guest()
                            .call_http(&mut i.store, &req)
                            .await
                    })
                }),
            )
            .await?
            .map_err(CallError::Guest)
    }

    pub fn job_busy(&self, name: &str) -> bool {
        self.jobs.get(name).is_some_and(|l| l.free() == 0)
    }

    pub async fn job(self: &Arc<Self>, name: &str, args: Option<String>) -> Result<(), CallError> {
        self.ready()?;
        let lane = self
            .jobs
            .get(name)
            .ok_or_else(|| CallError::Unavailable(format!("unknown job {name}")))?;
        let d = self.sh.env.cfg.deadlines.job;
        let name = name.to_owned();
        let job_id = uuid_v4();
        lane.call(
            self,
            Budget::of(d),
            call_fn(move |i| {
                Box::pin(async move {
                    i.guest
                        .fliks_plugin_guest()
                        .call_job(&mut i.store, &name, &job_id, args.as_ref())
                        .await
                })
            }),
        )
        .await?
        .map_err(CallError::Guest)
    }

    pub async fn scheduled(
        self: &Arc<Self>,
        key: String,
        payload: String,
        attempt: u32,
    ) -> Result<(), CallError> {
        let d = self.sh.env.cfg.deadlines.scheduled;
        self.task
            .call(
                self,
                Budget::of(d),
                call_fn(move |i| {
                    Box::pin(async move {
                        i.guest
                            .fliks_plugin_guest()
                            .call_scheduled(&mut i.store, &key, &payload, attempt)
                            .await
                    })
                }),
            )
            .await?
            .map_err(CallError::Guest)
    }

    /// Every live instance sees `config-changed` before its next call.
    pub fn config_changed(&self, keys: Vec<String>) {
        *self.cfg_keys.lock().unwrap() = keys;
        self.cfg_gen.fetch_add(1, Ordering::SeqCst);
    }

    /// `residentSetSizeBytes`: linear memory in use, `None` with no instance up.
    pub fn memory(&self) -> Option<u64> {
        (self.live_instances() > 0).then(|| self.sh.mem_total.load(Ordering::Relaxed) as u64)
    }
}

pub fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os rng");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

pub fn set_mode(p: &std::path::Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (p, mode);
}

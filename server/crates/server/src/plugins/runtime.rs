//! Wasm runtime: engine, instances, lanes, supervision (plugins.md rules 40-43).

use super::db::PluginDb;
use super::logs::{Logs, Pipe};
use super::outbound::{Net, Outbound};
use futures_util::future::BoxFuture;
use serde_json::Value as Json;
use sqlx::PgPool;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Notify, Semaphore};
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
    pub job: Duration,
    pub scheduled: Duration,
    pub db_query: Duration,
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
            job: s(3600),
            scheduled: s(300),
            db_query: s(60),
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
    pub http_max: usize,
    pub http_queue: usize,
    pub task_max: usize,
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
            http_max: 4,
            http_queue: 32,
            task_max: 2,
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
}

pub fn engine() -> anyhow::Result<Engine> {
    let mut c = wasmtime::Config::new();
    c.wasm_component_model(true).epoch_interruption(true);
    let engine = Engine::new(&c)?;
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

/// What host imports see of their plugin.
pub struct Shared {
    pub id: Arc<str>,
    pub env: Arc<Env>,
    pub db: Option<Arc<PluginDb>>,
    pub scopes: Vec<String>,
    /// Bumped by a stop: instances of an older generation trap at their next epoch tick.
    pub era: AtomicU64,
    pub stopped: Notify,
    pub mem_total: AtomicUsize,
}

pub struct Ctx {
    wasi: WasiCtx,
    http: WasiHttpCtx,
    table: ResourceTable,
    out: Outbound,
    pub sh: Arc<Shared>,
    deadline: Instant,
    era: u64,
    mem: usize,
    mem_max: usize,
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
    /// Not ready, lane in backoff, queue full: the proxy answers 503.
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
    idle: Mutex<Vec<Inst>>,
    pub live: AtomicUsize,
    sem: Semaphore,
    waiting: AtomicUsize,
    retry_at: Mutex<Option<Instant>>,
}

struct Waiting<'a>(&'a AtomicUsize);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

type CallFn<R> = Box<dyn for<'a> FnOnce(&'a mut Inst) -> BoxFuture<'a, wasmtime::Result<R>> + Send>;

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
        self.idle.lock().unwrap().push(inst);
    }

    async fn call<R: Send>(
        &self,
        rt: &Arc<PluginRt>,
        deadline: Duration,
        f: CallFn<R>,
    ) -> Result<R, CallError> {
        let until = tokio::time::Instant::now() + deadline;
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
            match tokio::time::timeout_at(until, self.sem.acquire()).await {
                Ok(p) => p.expect("never closed"),
                Err(_) => return Err(CallError::Timeout),
            }
        };
        let era = rt.sh.era.load(Ordering::SeqCst);
        let pooled = self.idle.lock().unwrap().pop();
        let mut inst = match pooled {
            Some(i) => i,
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
        inst.store.data_mut().deadline = until.into_std();
        let cfg_gen = rt.cfg_gen.load(Ordering::SeqCst);
        let keys = (inst.cfg_gen < cfg_gen).then(|| rt.cfg_keys.lock().unwrap().clone());
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
        let stopped = rt.sh.stopped.notified();
        tokio::pin!(stopped);
        stopped.as_mut().enable();
        if rt.sh.era.load(Ordering::SeqCst) != era {
            self.live.fetch_sub(1, Ordering::SeqCst);
            return Err(CallError::Unavailable("stopped".into()));
        }
        let res = tokio::select! {
            r = tokio::time::timeout_at(until, work) => r,
            _ = stopped => {
                self.live.fetch_sub(1, Ordering::SeqCst);
                return Err(CallError::Unavailable("stopped".into()));
            }
        };
        match res {
            Ok(Ok(r)) => {
                if rt.sh.era.load(Ordering::SeqCst) == era {
                    self.idle.lock().unwrap().push(inst);
                } else {
                    self.live.fetch_sub(1, Ordering::SeqCst);
                }
                Ok(r)
            }
            Ok(Err(trap)) => {
                drop(inst);
                self.live.fetch_sub(1, Ordering::SeqCst);
                let why = format!("{trap:?}");
                if rt.sh.era.load(Ordering::SeqCst) == era {
                    rt.crash(self, &why);
                }
                Err(CallError::Crashed(why))
            }
            Err(_) => {
                drop(inst);
                self.live.fetch_sub(1, Ordering::SeqCst);
                rt.crash(self, "deadline");
                Err(CallError::Timeout)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Stopped,
    Starting,
    Ready,
    Degraded,
    Backoff,
    Failed,
}

struct Sup {
    state: State,
    crashes: VecDeque<Instant>,
    ladder: usize,
    ready_since: Option<Instant>,
    misses: u32,
    message: String,
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
            mem_max: manifest["memoryMb"].as_u64().unwrap_or(64) as usize * (1 << 20),
            manifest,
            pre,
            internal,
            core: Lane::new(LaneKind::Core, 1, 32),
            event: Lane::new(LaneKind::Event, 1, 0),
            http: Lane::new(LaneKind::Http, c.http_max, c.http_queue),
            task: Lane::new(LaneKind::Task, c.task_max, 0),
            jobs,
            sup: Mutex::new(Sup {
                state: State::Stopped,
                crashes: VecDeque::new(),
                ladder: 0,
                ready_since: None,
                misses: 0,
                message: String::new(),
            }),
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
        self.sup.lock().unwrap().state
    }

    pub fn message(&self) -> String {
        self.sup.lock().unwrap().message.clone()
    }

    fn set_state(&self, s: State) {
        let mut sup = self.sup.lock().unwrap();
        sup.state = s;
        if s == State::Ready && sup.ready_since.is_none() {
            sup.ready_since = Some(Instant::now());
        } else if s != State::Ready && s != State::Degraded {
            sup.ready_since = None;
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
        .allow_ip_name_lookup(false);
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
        if m["pluginApi"].as_u64() != Some(check.plugin_api as u64) {
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

    /// First core instance, then `start`; `Err` only for a deterministic refusal.
    pub async fn boot(self: &Arc<Self>) -> Result<(), SpawnError> {
        self.set_state(State::Starting);
        self.spawn_loops();
        let t = Instant::now();
        match self.instantiate().await {
            Ok(inst) => {
                self.timings.lock().unwrap().first_hello = t.elapsed();
                self.core.put(inst)
            }
            Err(SpawnError::Mismatch(d)) => {
                self.set_state(State::Failed);
                self.sup.lock().unwrap().message = format!("manifest-mismatch: {d}");
                return Err(SpawnError::Mismatch(d));
            }
            Err(e) => {
                self.crash(&self.core, &e.to_string());
                return Err(e);
            }
        }
        let t = Instant::now();
        let r = self.run_start().await;
        self.timings.lock().unwrap().start = t.elapsed();
        r
    }

    async fn run_start(self: &Arc<Self>) -> Result<(), SpawnError> {
        let d = self.sh.env.cfg.deadlines.start;
        let r = self
            .core
            .call(
                self,
                d,
                Box::new(|i| {
                    Box::pin(
                        async move { i.guest.fliks_plugin_guest().call_start(&mut i.store).await },
                    )
                }),
            )
            .await;
        match r {
            Ok(Ok(())) => {
                self.set_state(State::Ready);
                self.sh.env.wake.notify_one();
                Ok(())
            }
            Ok(Err(e)) => {
                self.core.clear();
                self.crash(&self.core, &format!("start failed: {e}"));
                Err(SpawnError::Failed(e))
            }
            Err(e) => Err(SpawnError::Failed(format!("{e:?}"))),
        }
    }

    fn spawn_loops(self: &Arc<Self>) {
        let era = self.sh.era.load(Ordering::SeqCst);
        let rt = self.clone();
        tokio::spawn(async move { rt.health_loop(era).await });
        let rt = self.clone();
        tokio::spawn(async move { rt.event_loop(era).await });
    }

    fn alive(&self, era: u64) -> bool {
        self.sh.era.load(Ordering::SeqCst) == era && self.state() != State::Failed
    }

    pub fn crash(self: &Arc<Self>, lane: &Lane, why: &str) {
        self.restarts.fetch_add(1, Ordering::SeqCst);
        let cfg = &self.sh.env.cfg;
        let now = Instant::now();
        let delay = {
            let mut s = self.sup.lock().unwrap();
            if s.state == State::Failed || s.state == State::Stopped {
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
                s.state = State::Failed;
                s.message = format!(
                    "circuit breaker: {} crashes in 10 min, last: {why}",
                    s.crashes.len()
                );
                drop(s);
                tracing::error!("plugin \"{}\" failed: circuit breaker", self.sh.id);
                self.drop_all();
                return;
            }
            let d = cfg.ladder[s.ladder.min(cfg.ladder.len() - 1)];
            s.ladder += 1;
            if lane.kind == LaneKind::Core {
                s.state = State::Backoff;
                s.ready_since = None;
            }
            d
        };
        tracing::warn!(
            "plugin \"{}\" {:?} instance crashed ({why}), retry in {delay:?}",
            self.sh.id,
            lane.kind
        );
        *lane.retry_at.lock().unwrap() = Some(now + delay);
        if lane.kind == LaneKind::Core {
            let rt = self.clone();
            let era = self.sh.era.load(Ordering::SeqCst);
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                if !rt.alive(era) {
                    return;
                }
                match rt.instantiate().await {
                    Ok(inst) => {
                        let others = rt.live_instances() - rt.core.live.load(Ordering::SeqCst);
                        rt.core.put(inst);
                        if others == 0 {
                            let _ = rt.run_start().await;
                        } else {
                            rt.set_state(State::Ready);
                        }
                    }
                    Err(e) => rt.crash(&rt.core, &e.to_string()),
                }
            });
        }
    }

    /// Breaker or stop: every instance goes, running ones trap at their next tick.
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
                    d,
                    Box::new(|i| {
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
            if !matches!(self.state(), State::Ready | State::Degraded) {
                continue;
            }
            let ok = match self.health().await {
                Ok(h) => h.ok,
                Err(CallError::Timeout | CallError::Crashed(_)) => continue,
                Err(_) => false,
            };
            let mut s = self.sup.lock().unwrap();
            if ok {
                s.misses = 0;
                if s.state == State::Degraded {
                    s.state = State::Ready;
                }
                if s.ready_since
                    .is_some_and(|t| t.elapsed() >= cfg.ladder_reset)
                {
                    s.ladder = 0;
                }
                continue;
            }
            s.misses += 1;
            if s.misses == 2 {
                s.state = State::Degraded;
            }
            if s.misses >= 4 {
                s.misses = 0;
                drop(s);
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
                d,
                Box::new(|i| {
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
            if !self.alive(era) {
                return;
            }
            if self.state() != State::Ready {
                tokio::time::sleep(Duration::from_millis(50)).await;
                continue;
            }
            let next = self.ring.lock().unwrap().pop_front();
            let Some((name, payload)) = next else {
                self.ring_wake.notified().await;
                continue;
            };
            let _ = self
                .event
                .call(
                    &self,
                    d,
                    Box::new(move |i| {
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
            s => Err(CallError::Unavailable(format!("{s:?}"))),
        }
    }

    pub async fn http(self: &Arc<Self>, req: HttpRequest) -> Result<HttpResponse, CallError> {
        self.ready()?;
        let d = self.sh.env.cfg.deadlines.http;
        self.http
            .call(
                self,
                d,
                Box::new(move |i| {
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

    pub async fn job(self: &Arc<Self>, name: &str, args: Option<String>) -> Result<(), CallError> {
        self.ready()?;
        let lane = self
            .jobs
            .get(name)
            .ok_or_else(|| CallError::Unavailable(format!("unknown job {name}")))?;
        let d = self.sh.env.cfg.deadlines.job;
        let (name, job_id) = (name.to_owned(), format!("{:032x}", rand_u128()));
        lane.call(
            self,
            d,
            Box::new(move |i| {
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
                d,
                Box::new(move |i| {
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
}

fn rand_u128() -> u128 {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os rng");
    u128::from_le_bytes(b)
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

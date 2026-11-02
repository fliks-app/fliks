//! Wasm runtime: engine, instances, lanes, supervision (`plugins.md` rules 39-47).
use super::db::PluginDb;
use super::logs::{Logs, Pipe};
use super::outbound::Outbound;
use crate::events::uuid_v4;
use crate::net::guard::Net;
use crate::sync::MutexExt;
use fliks_domain::metadata::limiter::Priority;
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
    pub health: Duration,
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
            health: s(10),
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
    pub upstream_override: Arc<super::outbound::Override>,
    /// The image the compile child runs (`/proc/self/exe` in production).
    pub compiler: PathBuf,
    pub compile_kill: Duration,
    /// A `parity` seam for the SDK harness, which has no server image to start.
    #[cfg(feature = "parity")]
    pub compile_in_process: bool,
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
            upstream_override: Arc::new(super::outbound::Override::from_env()),
            compiler: super::compile::own_image(),
            compile_kill: Duration::from_secs(600),
            #[cfg(feature = "parity")]
            compile_in_process: false,
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
        let mut l = self.latencies.lock_clean();
        if l.len() == 256 {
            l.pop_front();
        }
        l.push_back(started.elapsed().as_secs_f64() * 1000.0);
    }

    /// Nearest rank, rounded to 0.1 ms; `None` with no calls.
    pub fn p95(&self) -> Option<f64> {
        let mut v: Vec<f64> = self.latencies.lock_clean().iter().copied().collect();
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
    /// The manifest carries a `provider` block.
    pub provider: bool,
    /// Bumped by a stop: instances of an older generation trap at their next epoch tick.
    pub era: AtomicU64,
    pub stopped: Notify,
    pub mem_total: AtomicUsize,
    pub stats: CallStats,
    /// In-flight guest outbound requests of this plugin, across its instances.
    pub outbound: Arc<tokio::sync::Semaphore>,
    /// The outbound limiter of a plugin with a `provider` block.
    pub gate: Option<Arc<super::outbound::Gate>>,
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
    /// Set by a `db` call that failed `unavailable` during the current export.
    pub db_unavailable: bool,
}

impl Ctx {
    /// The priority of the export about to run in this Store (`provider-plugins.md` rule 58).
    pub fn set_priority(&mut self, p: Priority) {
        self.out.priority = p;
    }
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
        let total = self.sh.mem_total.load(Ordering::Relaxed);
        if over_plugin_budget(total, desired - current, self.mem_max) {
            wasmtime::bail!(
                "plugin memory budget of {} MiB exceeded",
                (self.mem_max * PLUGIN_MEM_FACTOR) >> 20
            );
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
    /// The deadline passed; the instance was dropped and the crash counted.
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
    /// `start` failed only because the database was unreachable.
    db_down: bool,
    /// A core instance is being created: a second crash must not start another.
    recreating: bool,
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
fn over_plugin_budget(total: usize, grow: usize, mem_max: usize) -> bool {
    total.saturating_add(grow) > mem_max.saturating_mul(PLUGIN_MEM_FACTOR)
}

/// All instances of a plugin together may hold this many times its `memoryMb`.
const PLUGIN_MEM_FACTOR: usize = 2;

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
                recreating: false,
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
        let m = self.sup.lock_clean().message.clone();
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
            let mut sup = self.sup.lock_clean();
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
                permits: self.sh.outbound.clone(),
                gate: self.sh.gate.clone(),
                priority: Priority::Background,
                over: env.cfg.upstream_override.clone(),
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
                self.timings.lock_clean().first_hello = t.elapsed();
                self.core.put(inst);
                Ok(())
            }
            Err(SpawnError::Mismatch(d)) => {
                self.sup.lock_clean().message = format!("manifest-mismatch: {d}");
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
}

mod calls;
mod lane;
pub use lane::*;
mod supervision;

pub fn set_mode(p: &std::path::Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (p, mode);
}

#[cfg(test)]
mod tests {
    use super::over_plugin_budget;

    #[test]
    fn instances_share_a_budget_of_twice_the_declared_memory() {
        let mib = 1 << 20;
        assert!(!over_plugin_budget(64 * mib, 64 * mib, 64 * mib));
        assert!(over_plugin_budget(100 * mib, 64 * mib, 64 * mib));
    }
}

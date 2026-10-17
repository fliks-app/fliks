//! The plugin host (`docs/spec/plugins.md`, pluginApi 2 on wasm): install pipeline, registry,
//! runtime and the `/api/plugins/*` routes.
pub mod acquisition;
pub mod archive;
pub mod backup;
pub mod catalog;
pub mod compile;
pub mod counts;
pub mod db;
pub mod events;
pub mod fetch;
pub mod imports;
pub mod ingest;
pub mod install;
pub mod jobs;
pub mod logs;
pub mod manifest;
pub mod outbound;
pub mod packages;
pub mod registry;
pub mod routes;
pub mod runtime;
pub mod scheduled;
pub mod sources;
pub mod staging;
pub mod trust;
pub mod ui;
#[cfg(test)]
mod vectors;
pub mod webhooks;

use crate::ingest::KeyedLocks;
use crate::state::AppState;
use packages::Package;
use registry::{Fail, Registered, Registry, fail};
use runtime::{Env, HostConfig, PluginRt, Shared, SpawnError, State};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;
use tokio::sync::Notify;

pub use runtime::{HealthReport, HttpRequest, HttpResponse, Principal};

/// The 15 s a caller (boot, enable, confirm, restart) waits for `ready` (rules 23, 41).
pub const READY_WAIT: Duration = Duration::from_secs(15);

/// Everything the host needs that is not the database; tests tune it.
/// Adjusts the host configuration before the first instance (tests shorten deadlines).
pub type Tune = Arc<dyn Fn(&mut HostConfig) + Send + Sync>;

#[derive(Clone)]
pub struct Options {
    pub version: String,
    pub runtime_dir: PathBuf,
    pub disabled: bool,
    pub pg: db::PgTarget,
    pub tune: Option<Tune>,
    pub fetch: fetch::Fetcher,
    pub keys: trust::Keys,
    pub ready_wait: Duration,
}

impl Options {
    pub fn from_config(cfg: &crate::config::Config) -> Self {
        let runtime = std::env::var("FLIKS_RUNTIME_DIR")
            .ok()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .map_or_else(
                || std::env::temp_dir().join("fliks-plugins"),
                |d| PathBuf::from(d).join("fliks-plugins"),
            );
        Options {
            version: env!("CARGO_PKG_VERSION").into(),
            runtime_dir: runtime,
            disabled: std::env::var("FLIKS_PLUGINS_DISABLED").as_deref() == Ok("1"),
            pg: db::PgTarget {
                host: cfg.db.get_host().to_owned(),
                port: cfg.db.get_port(),
                dbname: cfg.db.get_database().unwrap_or("fliks").to_owned(),
            },
            tune: None,
            fetch: fetch::Fetcher::default(),
            keys: trust::official_keys(),
            ready_wait: READY_WAIT,
        }
    }
}

/// The live runtime: the wasm engine and one `PluginRt` per started plugin.
pub struct Host {
    pub env: Arc<Env>,
    live: RwLock<HashMap<String, Arc<PluginRt>>>,
}

pub struct Plugins {
    pub db: PgPool,
    pub opts: Options,
    pub registry: Registry,
    pub counts: counts::Counts,
    pub staging: staging::Staging,
    host: OnceLock<Arc<Host>>,
    locks: KeyedLocks<String>,
    crons: Mutex<HashMap<String, Vec<tokio::task::JoinHandle<()>>>>,
    app: OnceLock<AppState>,
    pub(crate) fk_warnings: Mutex<HashMap<String, String>>,
    /// C109: plugins whose registration waits for the database, by generation and `statusReason`.
    db_waits: Mutex<HashMap<String, (u64, String)>>,
    wait_gen: AtomicU64,
}

const DB_UNAVAILABLE: &str = "db-unavailable";

/// `reason`, or `db-unavailable` when Postgres could not be reached (C109).
fn db_fail(reason: &'static str, e: impl Into<db::ProvisionError>) -> Fail {
    let e = e.into();
    fail(
        if e.unavailable {
            DB_UNAVAILABLE
        } else {
            reason
        },
        e.message,
    )
}

/// A registration that passed `hello`: the caller releases the lock, then waits for `ready`.
pub struct Pending {
    pub id: String,
    rt: Option<Arc<PluginRt>>,
    declared: registry::Declared,
    registered: Registered,
}

impl Plugins {
    pub fn new(db: PgPool, opts: Options) -> Self {
        Plugins {
            staging: staging::Staging::new(opts.runtime_dir.join("import-staging")),
            db,
            opts,
            registry: Registry::default(),
            counts: counts::Counts::default(),
            host: OnceLock::new(),
            locks: KeyedLocks::default(),
            crons: Mutex::default(),
            app: OnceLock::new(),
            fk_warnings: Mutex::default(),
            db_waits: Mutex::default(),
            wait_gen: AtomicU64::new(0),
        }
    }

    pub fn attach(&self, st: &AppState) {
        let _ = self.app.set(st.clone());
        if let Some(h) = self.host.get() {
            let _ = h.env.app.set(st.clone());
        }
    }

    fn app(&self) -> Option<&AppState> {
        self.app.get()
    }

    /// The runtime, created at the first registration.
    pub fn host(&self) -> anyhow::Result<Arc<Host>> {
        if let Some(h) = self.host.get() {
            return Ok(h.clone());
        }
        let engine = runtime::engine()?;
        let linker = runtime::linker(&engine)?;
        let mut cfg = HostConfig::new(
            &self.opts.version,
            self.opts.runtime_dir.clone(),
            self.opts.pg.clone(),
            self.opts.fetch.net.clone(),
        );
        if let Some(t) = &self.opts.tune {
            t(&mut cfg);
        }
        let env = Arc::new(Env {
            engine,
            linker,
            cfg,
            core: self.db.clone(),
            logs: Arc::default(),
            wake: Notify::new(),
            app: OnceLock::new(),
        });
        if let Some(st) = self.app() {
            let _ = env.app.set(st.clone());
        }
        let h = Arc::new(Host {
            env,
            live: RwLock::default(),
        });
        let _ = self.host.set(h);
        Ok(self.host.get().expect("set").clone())
    }

    pub fn rt(&self, id: &str) -> Option<Arc<PluginRt>> {
        self.host.get()?.live.read().unwrap().get(id).cloned()
    }

    pub fn live(&self) -> Vec<Arc<PluginRt>> {
        self.host
            .get()
            .map(|h| h.live.read().unwrap().values().cloned().collect())
            .unwrap_or_default()
    }

    pub async fn lock(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        self.locks.lock(id.to_owned()).await
    }

    /// `processState`: null for data plugins and plugins with no live host entry.
    pub fn state_of(&self, id: &str) -> Option<State> {
        self.rt(id).map(|r| r.state()).or_else(|| {
            self.db_waits
                .lock()
                .unwrap()
                .contains_key(id)
                .then_some(State::Degraded)
        })
    }

    /// The `statusReason` of a registration waiting for the database (C109).
    pub fn db_wait_reason(&self, id: &str) -> Option<String> {
        self.db_waits.lock().unwrap().get(id).map(|w| w.1.clone())
    }

    /// The breaker message, else (down) the stderr tail, else the foreign-key advisory.
    pub fn status_message(&self, id: &str) -> String {
        let Some(rt) = self.rt(id) else {
            return String::new();
        };
        let m = rt.message();
        if !m.is_empty() {
            return m;
        }
        self.fk_warnings
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    async fn stop_rt(&self, id: &str) {
        let rt = self
            .host
            .get()
            .and_then(|h| h.live.write().unwrap().remove(id));
        if let Some(rt) = rt {
            rt.stop().await;
        }
    }

    fn drop_crons(&self, id: &str) {
        for h in self.crons.lock().unwrap().remove(id).unwrap_or_default() {
            h.abort();
        }
    }

    /// The failure funnel (rule 7): live state goes, declarations stay for 503-type reasons.
    async fn fail(&self, id: &str, f: Fail) -> Fail {
        self.stop_rt(id).await;
        self.drop_crons(id);
        self.counts.forget(id);
        self.registry
            .withdraw(id, registry::installed_but_not_running(f.reason));
        f
    }

    /// Withdraws what the plugin offers and stops it; routes and permissions stay (503, not 403).
    pub async fn unregister(&self, id: &str) {
        self.db_waits.lock().unwrap().remove(id);
        self.stop_rt(id).await;
        self.drop_crons(id);
        self.counts.forget(id);
        self.registry.withdraw(id, true);
    }

    /// Uninstall: nothing the plugin declared is true any more.
    pub async fn forget(&self, id: &str) {
        self.unregister(id).await;
        self.registry.withdraw(id, false);
        acquisition::forget(id);
    }

    pub async fn revoke(&self, id: &str, reason: &str) {
        self.unregister(id).await;
        self.registry.withdraw(id, false);
        tracing::warn!("plugin \"{id}\" revoked: {reason}");
    }

    async fn skip_compat(&self) -> bool {
        crate::settings::setting_value(&self.db, "plugins.skip_compatibility_check")
            .await
            .ok()
            .flatten()
            .as_deref()
            == Some("true")
    }

    fn reverify(&self, pkg: &Package) -> Result<(), Fail> {
        let Some(key_id) = pkg.verified_by_key_id.as_deref() else {
            return Ok(());
        };
        let Some(key) = self.opts.keys.iter().find(|(k, _)| k == key_id).cloned() else {
            return Err(fail(
                "untrusted",
                format!("key \"{key_id}\" is no longer in the trust store"),
            ));
        };
        let a = archive::read(&pkg.archive)
            .map_err(|e| fail("untrusted", format!("archive unreadable: {}", e.detail)))?;
        let (Some(m), Some(sig)) = (a.get("plugin.json"), a.get("plugin.json.sig")) else {
            return Err(fail(
                "untrusted",
                "archive is missing plugin.json or its signature",
            ));
        };
        let sig = trust::decode(&String::from_utf8_lossy(sig)).unwrap_or_default();
        if trust::resolve(m, Some(&sig), &vec![key]).0 != trust::Trust::Official {
            return Err(fail(
                "untrusted",
                format!("signature no longer verifies against key \"{key_id}\""),
            ));
        }
        Ok(())
    }

    pub async fn denial(
        &self,
        id: &str,
        version: &str,
        sha: &str,
        by: Option<&str>,
    ) -> sqlx::Result<Option<String>> {
        let lists: Vec<_> = packages::sources(&self.db, true)
            .await?
            .iter()
            .map(|s| catalog::deny_list_of(s.cached_catalog.as_ref()))
            .collect();
        Ok(catalog::find_denial(
            &catalog::Denied {
                plugin_id: id,
                version,
                sha256: sha,
                verified_by: by,
            },
            &lists,
        ))
    }

    /// Rule 7 up to the end of `hello`, under the caller's per-id lock.
    pub async fn register(&self, pkg: &Package) -> Result<Pending, Fail> {
        let id = pkg.plugin_id.clone();
        self.db_waits.lock().unwrap().remove(&id);
        match self.try_register(pkg).await {
            Ok(p) => Ok(p),
            Err(f) => {
                let f = self.fail(&id, f).await;
                if f.reason == DB_UNAVAILABLE {
                    self.wait_for_db(pkg, &f);
                }
                Err(f)
            }
        }
    }

    /// C109: `degraded` while the database is down, registered again on the ladder until it answers.
    fn wait_for_db(&self, pkg: &Package, f: &Fail) {
        let (Some(me), Ok(host)) = (self.app().map(|a| a.plugins.clone()), self.host()) else {
            return;
        };
        let generation = self.wait_gen.fetch_add(1, Ordering::SeqCst);
        let reason = format!("{}: {}", f.reason, f.detail);
        self.db_waits
            .lock()
            .unwrap()
            .insert(pkg.plugin_id.clone(), (generation, reason));
        let pkg = pkg.clone();
        tokio::spawn(async move {
            let id = &pkg.plugin_id;
            let cfg = &host.env.cfg;
            for attempt in 0.. {
                tokio::time::sleep(cfg.ladder.get(attempt).copied().unwrap_or(cfg.db_retry)).await;
                let pending = {
                    let _l = me.lock(id).await;
                    if me.db_waits.lock().unwrap().get(id).map(|w| w.0) != Some(generation) {
                        return;
                    }
                    let r = me.try_register(&pkg).await;
                    if let Err(f) = &r
                        && f.reason == DB_UNAVAILABLE
                    {
                        me.fail(id, f.clone()).await;
                        continue;
                    }
                    me.db_waits.lock().unwrap().remove(id);
                    match r {
                        Ok(p) => Ok(p),
                        Err(f) => Err(me.fail(id, f).await),
                    }
                };
                let outcome = match pending {
                    Ok(p) => me.settle(p).await,
                    Err(f) => Err(f),
                };
                let reason = outcome.err().map(|f| format!("{}: {}", f.reason, f.detail));
                if let Err(e) = packages::set_status(&me.db, id, reason.as_deref()).await {
                    tracing::warn!("plugin \"{id}\": status not saved: {e}");
                }
                return;
            }
        });
    }

    /// A restore holds its claim (C112).
    pub(crate) fn restoring(&self) -> bool {
        self.app().is_some_and(|a| a.jobs.is_restoring())
    }

    async fn try_register(&self, pkg: &Package) -> Result<Pending, Fail> {
        let id = &pkg.plugin_id;
        let m = &pkg.manifest;
        // The ladder retries it; `after_restore` registers everything again anyway.
        if self.restoring() {
            return Err(fail(DB_UNAVAILABLE, "a restore is running"));
        }
        self.stop_rt(id).await;
        self.drop_crons(id);
        self.reverify(pkg)?;
        let sha = archive::sha256_hex(&pkg.archive);
        if let Some(reason) = self
            .denial(id, &pkg.version, &sha, pkg.verified_by_key_id.as_deref())
            .await
            .map_err(|e| db_fail("revoked", e))?
        {
            return Err(fail("revoked", reason));
        }
        if !manifest::api_supported(m) {
            return Err(fail(
                "incompatible-api",
                format!(
                    "manifest declares pluginApi {}, this core accepts 2",
                    m["pluginApi"]
                ),
            ));
        }
        let range = m["fliks"].as_str().unwrap_or_default();
        if !manifest::fliks_satisfied(range, &self.opts.version) {
            let detail = format!(
                "manifest requires fliks \"{range}\", running {}",
                self.opts.version
            );
            if !self.skip_compat().await {
                return Err(fail("incompatible-fliks", detail));
            }
            tracing::warn!("{id}: {detail} — loading anyway, the compatibility check is disabled");
        }
        let declared = self.registry.validate(id, m)?;
        let registered = Registered {
            plugin_id: id.clone(),
            version: pkg.version.clone(),
            manifest: m.clone(),
            signature: pkg.signature.clone(),
            archive: Arc::new(pkg.archive.clone()),
        };
        if !pkg.is_process() {
            return Ok(Pending {
                id: id.clone(),
                rt: None,
                declared,
                registered,
            });
        }
        self.registry.install_declarations(id, m, &declared);
        if manifest::requests_network(m) && !pkg.network_internal {
            return Err(fail(
                "network-not-granted",
                "the manifest requests network.internal, which the install consent did not grant",
            ));
        }
        let inspected = manifest::inspect(&pkg.archive, true, &vec![])
            .map_err(|r| fail("tampered", r.detail))?;
        manifest::check_files(&inspected).map_err(|r| fail("tampered", r.detail))?;
        let wasm = inspected
            .archive
            .get("plugin.wasm")
            .unwrap_or_default()
            .to_vec();
        let host = self
            .host()
            .map_err(|e| fail("spawn-failed", e.to_string()))?;
        let loaded = compile::load(&host.env, id, &wasm)
            .await
            .map_err(|e| match e {
                compile::LoadError::Invalid(m) => fail("invalid-component", m),
                compile::LoadError::Host(m) => {
                    tracing::error!("plugin \"{id}\" component cache: {m}");
                    fail("spawn-failed", m)
                }
            })?;
        packages::upsert_registration(&self.db, id, m)
            .await
            .map_err(|e| db_fail("db-provision-failed", e))?;
        let pool = if m["database"]["schema"] == Value::Bool(true) {
            let refs: Vec<String> = m["database"]["coreRefs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            let jobs = m["jobs"].as_array().map_or(0, Vec::len);
            let c = &host.env.cfg;
            let cap = 1 + 1 + c.http_max + c.task_max + jobs;
            self.warn_connection_budget(cap).await;
            Some(self.open_db(&host, id, &refs, cap).await?)
        } else {
            if m["database"]["coreRefs"]
                .as_array()
                .is_some_and(|a| !a.is_empty())
            {
                return Err(fail(
                    "db-provision-failed",
                    "coreRefs declared with database.schema false — no schema to grant them into",
                ));
            }
            None
        };
        let strs = |k: &str| -> Vec<String> {
            m[k].as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        };
        let sh = Arc::new(Shared {
            id: id.as_str().into(),
            env: host.env.clone(),
            db: pool,
            scopes: strs("scopes"),
            ingest_roots: strs("ingestRoots"),
            era: AtomicU64::new(0),
            stopped: Notify::new(),
            mem_total: Default::default(),
            stats: Default::default(),
        });
        let rt = PluginRt::new(sh, m.clone(), &loaded.component, pkg.network_internal)
            .map_err(|e| fail("invalid-component", e.to_string()))?;
        {
            let mut t = rt.timings.lock().unwrap();
            t.compile = loaded.elapsed;
            t.cache_hit = loaded.cache_hit;
        }
        host.live.write().unwrap().insert(id.clone(), rt.clone());
        match rt.hello().await {
            Ok(()) => {}
            Err(SpawnError::Mismatch(d)) => return Err(fail("manifest-mismatch", d)),
            Err(SpawnError::Failed(d)) => return Err(fail("spawn-failed", d)),
        }
        rt.spawn_start();
        Ok(Pending {
            id: id.clone(),
            rt: Some(rt),
            declared,
            registered,
        })
    }

    /// Provisions (rotating the password) and opens the plugin's own role pool.
    pub(crate) async fn open_db(
        &self,
        host: &Host,
        id: &str,
        refs: &[String],
        cap: usize,
    ) -> Result<Arc<db::PluginDb>, Fail> {
        let password = db::provision(&self.db, id, refs)
            .await
            .map_err(|e| db_fail("db-provision-failed", e))?;
        let oid = db::database_oid(&self.db)
            .await
            .map_err(|e| db_fail("db-provision-failed", e))?;
        let c = &host.env.cfg;
        Ok(db::PluginDb::new(
            &c.pg,
            self.db.clone(),
            &db::role(&oid, id),
            &db::schema(id),
            &password,
            cap,
            c.deadlines.db_query,
        ))
    }

    async fn warn_connection_budget(&self, _cap: usize) {
        let max: Option<String> = sqlx::query_scalar("SHOW max_connections")
            .fetch_one(&self.db)
            .await
            .ok();
        let Some(max) = max.and_then(|m| m.parse::<usize>().ok()) else {
            return;
        };
        let live: usize = self
            .live()
            .iter()
            .map(|r| 1 + 1 + r.sh.env.cfg.http_max + r.sh.env.cfg.task_max + r.jobs.len())
            .sum();
        if (live + crate::POOL_MAX as usize) * 5 > max * 4 {
            tracing::warn!(
                "plugin database pools may use {live} connections, over 80 % of max_connections {max}"
            );
        }
    }

    /// Waits for `ready` (at most the boot wait), then activates; the outcome is `statusReason`.
    pub async fn settle(&self, p: Pending) -> Result<(), Fail> {
        let Some(rt) = p.rt.clone() else {
            self.activate(p);
            return Ok(());
        };
        let mut w = rt.watch();
        let ready = tokio::time::timeout(self.opts.ready_wait, async {
            loop {
                let s = *w.borrow_and_update();
                if matches!(s, State::Ready | State::Failed | State::Stopped) {
                    return s;
                }
                if w.changed().await.is_err() {
                    return State::Stopped;
                }
            }
        })
        .await;
        match ready {
            Ok(State::Ready) => {
                self.activate(p);
                Ok(())
            }
            Ok(_) => {
                let id = p.id.clone();
                Err(self.fail(&id, fail("spawn-failed", rt.message())).await)
            }
            Err(_) => {
                let detail = Some(rt.message())
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| "still starting".into());
                self.watch_late(p);
                Err(fail("spawn-failed", detail))
            }
        }
    }

    /// A start that outlived the wait: the host rewrites the status when it settles.
    fn watch_late(&self, p: Pending) {
        let Some(st) = self.app().cloned() else {
            return;
        };
        let rt = p.rt.clone().expect("process");
        tokio::spawn(async move {
            let mut w = rt.watch();
            loop {
                let s = *w.borrow_and_update();
                let plugins = &st.plugins;
                if s == State::Ready {
                    if plugins.rt(&p.id).is_some_and(|r| Arc::ptr_eq(&r, &rt)) {
                        let id = p.id.clone();
                        plugins.activate(p);
                        let _ = packages::set_status(&st.db, &id, None).await;
                    }
                    return;
                }
                if matches!(s, State::Failed | State::Stopped) || w.changed().await.is_err() {
                    if s == State::Failed {
                        let _ = packages::set_status(
                            &st.db,
                            &p.id,
                            Some(&format!("spawn-failed: {}", rt.message())),
                        )
                        .await;
                    }
                    return;
                }
            }
        });
    }

    fn activate(&self, p: Pending) {
        let id = p.id.clone();
        let picker = p.registered.manifest["ui"].get("releasePicker").is_some();
        let player = p.registered.manifest["ui"].get("player").is_some();
        self.registry
            .install_declarations(&id, &p.registered.manifest, &p.declared);
        self.registry
            .activate(p.registered, p.declared.webhooks.clone());
        if picker && self.registry.release_picker_winner().as_deref() != Some(id.as_str()) {
            tracing::warn!(
                "plugin \"{id}\" declared a releasePicker but \"{}\" holds it (lower plugin id wins)",
                self.registry.release_picker_winner().unwrap_or_default()
            );
        }
        if player && self.registry.pre_roll_winner().as_deref() != Some(id.as_str()) {
            tracing::warn!(
                "plugin \"{id}\" declared ui.player but \"{}\" holds it (lower plugin id wins)",
                self.registry.pre_roll_winner().unwrap_or_default()
            );
        }
        if p.rt.is_some() {
            self.registry.set_jobs(&id, p.declared.jobs.clone());
            self.start_crons(&id, &p.declared.jobs);
        }
    }

    fn start_crons(&self, id: &str, jobs: &[registry::Job]) {
        let Some(st) = self.app().cloned() else {
            return;
        };
        let handles = jobs
            .iter()
            .map(|j| {
                let (st, id, name) = (st.clone(), id.to_owned(), j.name.clone());
                crate::jobs::spawn_cron(
                    j.cron.clone(),
                    crate::jobs::server_tz(),
                    chrono::Utc::now,
                    move || {
                        let (st, id, name) = (st.clone(), id.clone(), name.clone());
                        tokio::spawn(async move { jobs::run(&st, &id, &name, true).await });
                    },
                )
            })
            .collect();
        self.crons.lock().unwrap().insert(id.to_owned(), handles);
    }

    /// Registers under the lock, waits outside it, persists the outcome when `persist`.
    pub async fn register_and_settle(&self, pkg: &Package) -> Result<(), Fail> {
        let pending = {
            let _l = self.lock(&pkg.plugin_id).await;
            self.register(pkg).await
        };
        match pending {
            Ok(p) => self.settle(p).await,
            Err(f) => Err(f),
        }
    }

    /// Boot (rule 23): every enabled package concurrently, at most the boot wait before serving.
    pub async fn boot(self: &Arc<Self>) {
        let dir = &self.opts.runtime_dir;
        for old in ["installed", "fliks-rt"] {
            let _ = std::fs::remove_dir_all(dir.join(old));
        }
        let Ok(pkgs) = packages::all(&self.db).await else {
            return;
        };
        let keep: Vec<String> = pkgs
            .iter()
            .filter_map(|p| {
                archive::read(&p.archive)
                    .ok()?
                    .get("plugin.wasm")
                    .map(archive::sha256_hex)
            })
            .collect();
        compile::sweep(dir, &keep);
        if self.opts.disabled {
            tracing::warn!("FLIKS_PLUGINS_DISABLED=1 — no plugin will be loaded");
            return;
        }
        let mut tasks = vec![];
        for pkg in pkgs {
            if !pkg.enabled {
                tracing::info!("plugin \"{}\" is disabled — not loaded", pkg.plugin_id);
                continue;
            }
            let me = self.clone();
            tasks.push(tokio::spawn(async move {
                let r = me.register_and_settle(&pkg).await;
                let reason = r
                    .as_ref()
                    .err()
                    .map(|f| format!("{}: {}", f.reason, f.detail));
                if let Some(r) = &reason {
                    tracing::warn!("plugin \"{}\" not loaded ({r})", pkg.plugin_id);
                }
                if pkg.status_reason != reason || (reason.is_none() && pkg.status != "active") {
                    let _ = packages::set_status(&me.db, &pkg.plugin_id, reason.as_deref()).await;
                }
            }));
        }
        let _ =
            tokio::time::timeout(self.opts.ready_wait, futures_util::future::join_all(tasks)).await;
    }

    /// Process lifetime tasks: domain events, scheduled calls, staging sweep, catalog boot pass.
    pub fn spawn(self: &Arc<Self>, st: &AppState) {
        let me = self.clone();
        let mut rx = st.hub.subscribe();
        let st2 = st.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(bus) => {
                        if let crate::events::Bus::Domain(ev) = &*bus {
                            me.domain_event(&st2, ev);
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => return,
                }
            }
        });
        jobs::spawn_claimer(st);
        let st3 = st.clone();
        crate::jobs::spawn_cron(
            "0 * * * *".to_owned(),
            crate::jobs::server_tz(),
            chrono::Utc::now,
            move || {
                st3.plugins.staging.sweep();
            },
        );
        let st4 = st.clone();
        tokio::spawn(async move { sources::refresh_all(&st4, true).await });
    }

    fn domain_event(&self, st: &AppState, ev: &crate::events::DomainEvent) {
        let Ok(payload) = serde_json::to_value(ev) else {
            return;
        };
        let name = payload["type"].as_str().unwrap_or_default().to_owned();
        let text = payload.to_string();
        for rt in self.live() {
            rt.push_event(&name, &text);
        }
        webhooks::dispatch(st, &name, payload);
    }

    /// A settings write: the owning running plugin gets `config-changed` unless it wrote it.
    pub fn settings_changed(&self, keys: &[String], origin: Option<&str>) {
        let live = self.live();
        for key in keys {
            let ids: Vec<&str> = live.iter().map(|r| &*r.sh.id).collect();
            let Some(owner) = fliks_domain::plugins::setting_owner(key, ids.iter().copied()) else {
                continue;
            };
            if Some(owner) == origin {
                continue;
            }
            let short = key[format!("plugin.{owner}.").len()..].to_owned();
            if let Some(rt) = live.iter().find(|r| &*r.sh.id == owner) {
                rt.config_changed(vec![short]);
            }
        }
    }

    /// C112: every plugin stops before a restore replays.
    pub async fn stop_all(&self) {
        self.db_waits.lock().unwrap().clear();
        let ids: Vec<String> = self.live().iter().map(|r| r.sh.id.to_string()).collect();
        for id in ids {
            let _l = self.lock(&id).await;
            self.unregister(&id).await;
        }
    }

    /// After a restore (success or failure): adopt every schema, drop the dump's foreign roles,
    /// then register the enabled plugins as at boot.
    pub async fn after_restore(self: &Arc<Self>, roles: &[String]) {
        if let Ok(pkgs) = packages::all(&self.db).await {
            for p in pkgs
                .iter()
                .filter(|p| p.is_process() && p.manifest["database"]["schema"] == Value::Bool(true))
            {
                let refs: Vec<String> = p.manifest["database"]["coreRefs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                if let Err(e) = db::provision(&self.db, &p.plugin_id, &refs).await {
                    tracing::warn!(
                        "plugin \"{}\" schema adoption after restore: {}",
                        p.plugin_id,
                        e.message
                    );
                }
            }
        }
        if let Err(e) = db::drop_foreign_roles(&self.db, roles).await {
            tracing::warn!("restore: dropping foreign plugin roles failed: {e}");
        }
        self.boot().await;
    }

    pub async fn probe_core_fks(&self, id: &str) {
        let fks = match db::unsafe_core_fks(&self.db, id).await {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("plugin \"{id}\": could not check core foreign keys: {e}");
                return;
            }
        };
        for (c, t, r) in &fks {
            crate::system::logs::push(
                "warn",
                &format!("plugin:{id}"),
                format!(
                    "constraint \"{c}\" on \"{t}\" references public.\"{r}\" without ON DELETE CASCADE or SET NULL, which will block core deletion of that table's rows. Declare ON DELETE CASCADE or SET NULL on it, or uninstall this plugin to drop its schema."
                ),
            );
        }
        let msg = if fks.is_empty() {
            String::new()
        } else {
            let names: Vec<String> = fks.iter().map(|(c, ..)| format!("\"{c}\"")).collect();
            format!(
                "{} foreign key(s) block core deletion ({}) — declare ON DELETE CASCADE or SET NULL on them.",
                fks.len(),
                names.join(", ")
            )
        };
        self.fk_warnings.lock().unwrap().insert(id.to_owned(), msg);
    }

    /// Rule 51: the winning `ui.player.preRollRoute`, 3 s including the queue; `None` on any failure.
    pub async fn pre_roll(&self, body: Value, user: i32) -> Option<Value> {
        let (id, route) = self.registry.pre_roll()?;
        let rt = self.rt(&id).filter(|r| r.state() == State::Ready)?;
        let req = HttpRequest {
            method: "POST".into(),
            path: route,
            query: vec![],
            body: serde_json::to_vec(&body).ok()?,
            principal: Principal::Delegated(user as u32),
        };
        match rt.http(req, true).await {
            Ok(r) if r.status == 200 => serde_json::from_slice(&r.body).ok(),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!("pre-roll call to \"{id}\" failed: {e:?}");
                None
            }
        }
    }

    pub async fn shutdown(&self) {
        for rt in self.live() {
            let id = rt.sh.id.to_string();
            self.stop_rt(&id).await;
        }
    }
}

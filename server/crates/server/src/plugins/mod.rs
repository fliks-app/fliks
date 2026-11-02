//! The plugin host (`docs/spec/plugins.md`, pluginApi 3 on wasm): install pipeline, registry,
//! runtime and the `/api/plugins/*` routes.
pub mod acquisition;
pub mod archive;
pub mod backup;
pub mod catalog;
pub mod compile;
pub mod counts;
pub mod db;
pub mod defaults;
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
mod register;
pub mod registry;
pub mod routes;
pub mod runtime;
pub mod scheduled;
pub mod sources;
pub mod staging;
pub mod trust;
pub mod ui;
pub mod units;
#[cfg(test)]
mod vectors;
pub mod webhooks;

use crate::ingest::KeyedLocks;
use crate::state::AppState;
use crate::sync::{MutexExt, RwLockExt};
use fliks_domain::media::family::Family;
use packages::Package;
use registry::{Fail, Registered, Registry, fail};
use runtime::{Env, HostConfig, PluginRt, Shared, SpawnError, State};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;
use tokio::sync::Notify;

pub use runtime::{HealthReport, HostError, HttpRequest, HttpResponse, Principal};

impl From<Family> for runtime::fliks::plugin::types::Family {
    fn from(f: Family) -> Self {
        match f {
            Family::Video => Self::Video,
            Family::Audio => Self::Audio,
            Family::Text => Self::Text,
            Family::Image => Self::Image,
        }
    }
}

impl From<runtime::fliks::plugin::types::Family> for Family {
    fn from(f: runtime::fliks::plugin::types::Family) -> Self {
        use runtime::fliks::plugin::types::Family as W;
        match f {
            W::Video => Self::Video,
            W::Audio => Self::Audio,
            W::Text => Self::Text,
            W::Image => Self::Image,
        }
    }
}

/// The family of a call naming one work: only `video` is served.
pub fn served(f: runtime::fliks::plugin::types::Family) -> Result<Family, HostError> {
    match Family::from(f) {
        Family::Video => Ok(Family::Video),
        other => Err(imports::host_err(
            "unsupported-family",
            format!("family \"{other}\" is not served"),
        )),
    }
}

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
                || {
                    default_runtime_dir(
                        &std::env::temp_dir().join("fliks-plugins"),
                        crate::paths::data_dir().join("plugins"),
                    )
                },
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

/// `new` (under the data dir), after moving over the plugin files the temp dir held before.
/// Left in place when the move fails (another filesystem), so no plugin loses its `/data`.
fn default_runtime_dir(legacy: &Path, new: PathBuf) -> PathBuf {
    let (old_data, new_data) = (legacy.join("data"), new.join("data"));
    if old_data.is_dir() && !new_data.exists() {
        let moved =
            std::fs::create_dir_all(&new).and_then(|()| std::fs::rename(&old_data, &new_data));
        if moved.is_err() {
            return legacy.to_path_buf();
        }
    }
    new
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
    /// Plugins whose registration waits for the database, by generation and `statusReason`.
    db_waits: Mutex<HashMap<String, (u64, String)>>,
    wait_gen: AtomicU64,
}

const DB_UNAVAILABLE: &str = "db-unavailable";

/// `reason`, or `db-unavailable` when Postgres could not be reached.
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
        self.host.get()?.live.read_clean().get(id).cloned()
    }

    pub fn live(&self) -> Vec<Arc<PluginRt>> {
        self.host
            .get()
            .map(|h| h.live.read_clean().values().cloned().collect())
            .unwrap_or_default()
    }

    pub async fn lock(&self, id: &str) -> tokio::sync::OwnedMutexGuard<()> {
        self.locks.lock(id.to_owned()).await
    }

    /// `processState`: null for data plugins and plugins with no live host entry.
    pub fn state_of(&self, id: &str) -> Option<State> {
        self.rt(id).map(|r| r.state()).or_else(|| {
            self.db_waits
                .lock_clean()
                .contains_key(id)
                .then_some(State::Degraded)
        })
    }

    /// The `statusReason` of a registration waiting for the database.
    pub fn db_wait_reason(&self, id: &str) -> Option<String> {
        self.db_waits.lock_clean().get(id).map(|w| w.1.clone())
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
            .lock_clean()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    async fn stop_rt(&self, id: &str) {
        let rt = self
            .host
            .get()
            .and_then(|h| h.live.write_clean().remove(id));
        if let Some(rt) = rt {
            rt.stop().await;
        }
    }

    fn drop_crons(&self, id: &str) {
        for h in self.crons.lock_clean().remove(id).unwrap_or_default() {
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
        self.db_waits.lock_clean().remove(id);
        self.stop_rt(id).await;
        self.drop_crons(id);
        self.counts.forget(id);
        self.registry.withdraw(id, true);
    }

    /// Uninstall: nothing the plugin declared is true any more.
    pub async fn forget(&self, id: &str) {
        self.unregister(id).await;
        self.registry.withdraw(id, false);
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
        let failed = Arc::new(Mutex::new(Vec::<String>::new()));
        for pkg in pkgs {
            if !pkg.enabled {
                tracing::info!("plugin \"{}\" is disabled — not loaded", pkg.plugin_id);
                continue;
            }
            let me = self.clone();
            let failed = failed.clone();
            tasks.push(tokio::spawn(async move {
                let r = me.register_and_settle(&pkg).await;
                if r.is_err() {
                    failed.lock_clean().push(pkg.plugin_id.clone());
                }
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
        let failed = std::mem::take(&mut *failed.lock_clean());
        if let (false, Some(st)) = (failed.is_empty(), self.app().cloned()) {
            tokio::spawn(async move {
                sources::refresh_all(&st, true).await;
                st.plugins.auto_update_of(Some(&failed)).await;
            });
        }
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
                let st3 = st3.clone();
                tokio::spawn(async move { st3.plugins.staging.sweep().await });
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

    /// Every plugin stops before a restore replays.
    pub async fn stop_all(&self) {
        self.db_waits.lock_clean().clear();
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
        self.fk_warnings.lock_clean().insert(id.to_owned(), msg);
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

#[cfg(test)]
mod runtime_dir_tests {
    use super::default_runtime_dir;

    #[test]
    fn plugin_files_of_the_temp_dir_move_under_the_data_dir() {
        let root = std::env::temp_dir().join(format!("fliks-rtdir-{}", std::process::id()));
        let (legacy, new) = (root.join("tmp/fliks-plugins"), root.join("data/plugins"));
        std::fs::create_dir_all(legacy.join("data/p")).unwrap();
        std::fs::write(legacy.join("data/p/f"), b"kept").unwrap();
        assert_eq!(default_runtime_dir(&legacy, new.clone()), new);
        assert_eq!(std::fs::read(new.join("data/p/f")).unwrap(), b"kept");
        assert!(!legacy.join("data").exists());
        std::fs::create_dir_all(legacy.join("data/q")).unwrap();
        assert_eq!(
            default_runtime_dir(&legacy, new.clone()),
            new,
            "existing data is never replaced"
        );
        assert!(legacy.join("data/q").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod kind_tests {
    use super::runtime::fliks::plugin::types as w;
    use super::*;

    #[test]
    fn an_unserved_family_is_named_in_the_refusal() {
        let family = served(w::Family::Audio).unwrap_err();
        assert_eq!(family.code, "unsupported-family");
        assert_eq!(family.message, "family \"audio\" is not served");
        assert_eq!(served(w::Family::Video).unwrap(), Family::Video);
    }
}

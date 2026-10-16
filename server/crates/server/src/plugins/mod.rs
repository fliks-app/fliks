//! Wasm plugin host (pluginApi 2), S8 spike scope: install, registry, lanes, imports.

pub mod archive;
pub mod db;
pub mod imports;
pub mod logs;
pub mod outbound;
pub mod runtime;
pub mod scheduled;

use runtime::{CallError, Env, HostConfig, PluginRt, Shared, SpawnError, State};
use serde_json::Value as Json;
use sqlx::PgPool;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use wasmtime::component::Component;

pub use runtime::{HealthReport, HttpRequest, HttpResponse, Principal};

pub struct Host {
    pub env: Arc<Env>,
    plugins: RwLock<HashMap<String, Arc<PluginRt>>>,
    stopping: AtomicU64,
}

pub struct Loaded {
    pub component: Component,
    pub compile: Duration,
    pub cache_hit: bool,
}

impl Host {
    pub fn new(core: PgPool, cfg: HostConfig) -> anyhow::Result<Arc<Self>> {
        let engine = runtime::engine()?;
        let linker = runtime::linker(&engine)?;
        let env = Arc::new(Env {
            engine,
            linker,
            cfg,
            core,
            logs: Arc::default(),
            wake: Notify::new(),
        });
        let host = Arc::new(Host {
            env,
            plugins: RwLock::default(),
            stopping: AtomicU64::new(0),
        });
        let weak = Arc::downgrade(&host);
        tokio::spawn(async move { claimer(weak).await });
        Ok(host)
    }

    pub fn get(&self, id: &str) -> Option<Arc<PluginRt>> {
        self.plugins.read().unwrap().get(id).cloned()
    }

    /// Stores the package (rule 19, unsigned allowed) and registers it.
    pub async fn install(&self, bytes: &[u8], network_internal: bool) -> Result<String, String> {
        let pkg = archive::read(bytes)?;
        let id = pkg.manifest["id"]
            .as_str()
            .ok_or("PLUGIN_BAD_ID")?
            .to_owned();
        let version = pkg.manifest["version"]
            .as_str()
            .ok_or("PLUGIN_BAD_VERSION")?
            .to_owned();
        let internal = network_internal && pkg.manifest["network"]["internal"] == Json::Bool(true);
        sqlx::query(
            r#"INSERT INTO plugin_packages ("pluginId", version, archive, origin, signature, manifest, "networkInternal")
               VALUES ($1, $2, $3, 'manual', 'unsigned', $4, $5)
               ON CONFLICT ("pluginId") DO UPDATE SET version = EXCLUDED.version, archive = EXCLUDED.archive,
                 manifest = EXCLUDED.manifest, "networkInternal" = EXCLUDED."networkInternal",
                 status = 'active', "statusReason" = NULL, "cwasmSha256" = NULL, "cwasmEngine" = NULL,
                 "updatedAt" = now()"#,
        )
        .bind(&id)
        .bind(&version)
        .bind(bytes)
        .bind(&pkg.manifest)
        .bind(internal)
        .execute(&self.env.core)
        .await
        .map_err(|e| format!("PLUGIN_INSTALL_FAILED: {e}"))?;
        self.register(&id).await.map(|_| id)
    }

    /// Loads, provisions and boots one package; the outcome goes to `status`/`statusReason`.
    pub async fn register(&self, id: &str) -> Result<Arc<PluginRt>, String> {
        let r = self.try_register(id).await;
        let (status, reason) = match &r {
            Ok(_) => ("active", None),
            Err(e) => ("failed", Some(e.clone())),
        };
        let _ = sqlx::query(
            r#"UPDATE plugin_packages SET status = $2::plugin_packages_status_enum, "statusReason" = $3 WHERE "pluginId" = $1"#,
        )
        .bind(id)
        .bind(status)
        .bind(reason)
        .execute(&self.env.core)
        .await;
        r
    }

    async fn try_register(&self, id: &str) -> Result<Arc<PluginRt>, String> {
        if let Some(old) = self.plugins.write().unwrap().remove(id) {
            old.drop_all();
        }
        let (archive, internal): (Vec<u8>, bool) = sqlx::query_as(
            r#"SELECT archive, "networkInternal" FROM plugin_packages WHERE "pluginId" = $1"#,
        )
        .bind(id)
        .fetch_one(&self.env.core)
        .await
        .map_err(|e| format!("PLUGIN_NOT_FOUND: {e}"))?;
        let pkg = archive::read(&archive).map_err(|e| format!("tampered: {e}"))?;
        let loaded = self
            .load(id, &pkg.wasm)
            .await
            .map_err(|e| format!("invalid-component: {e}"))?;
        let m = pkg.manifest;
        let db = if m["database"]["schema"] == Json::Bool(true) {
            let refs: Vec<String> = m["database"]["coreRefs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            let pw = db::provision(&self.env.core, id, &refs)
                .await
                .map_err(|e| format!("db-provision-failed: {e}"))?;
            let jobs = m["jobs"].as_array().map_or(0, Vec::len);
            let c = &self.env.cfg;
            let cap = 1 + 1 + c.http_max + c.task_max + jobs;
            Some(db::PluginDb::new(&c.pg, id, &pw, cap, c.deadlines.db_query))
        } else {
            None
        };
        let scopes = m["scopes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let sh = Arc::new(Shared {
            id: id.into(),
            env: self.env.clone(),
            db,
            scopes,
            era: AtomicU64::new(0),
            stopped: Notify::new(),
            mem_total: AtomicUsize::new(0),
        });
        let rt = PluginRt::new(sh, m, &loaded.component, internal)
            .map_err(|e| format!("invalid-component: {e}"))?;
        {
            let mut t = rt.timings.lock().unwrap();
            t.compile = loaded.compile;
            t.cache_hit = loaded.cache_hit;
        }
        self.plugins
            .write()
            .unwrap()
            .insert(id.to_owned(), rt.clone());
        match rt.boot().await {
            Ok(()) => Ok(rt),
            Err(SpawnError::Mismatch(d)) => {
                self.plugins.write().unwrap().remove(id);
                Err(format!("manifest-mismatch: {d}"))
            }
            Err(e) => Err(e.to_string()),
        }
    }

    /// The component from the authenticated `.cwasm` cache, else compiled and cached.
    pub async fn load(&self, id: &str, wasm: &[u8]) -> anyhow::Result<Loaded> {
        let engine = &self.env.engine;
        let mut h = std::collections::hash_map::DefaultHasher::new();
        engine.precompile_compatibility_hash().hash(&mut h);
        let fp = format!("{:016x}", h.finish());
        let dir = self.env.cfg.runtime_dir.join("cwasm");
        let path = dir.join(format!("{}-{fp}.cwasm", archive::sha256_hex(wasm)));
        let (sha, eng): (Option<String>, Option<String>) = sqlx::query_as(
            r#"SELECT "cwasmSha256", "cwasmEngine" FROM plugin_packages WHERE "pluginId" = $1"#,
        )
        .bind(id)
        .fetch_one(&self.env.core)
        .await?;
        let t = Instant::now();
        if eng.as_deref() == Some(&fp)
            && let Ok(bytes) = std::fs::read(&path)
            && sha.as_deref() == Some(&archive::sha256_hex(&bytes))
        {
            // SAFETY: the bytes are the ones this host serialised, authenticated by the row's sha256.
            let component = unsafe { Component::deserialize(engine, &bytes)? };
            return Ok(Loaded {
                component,
                compile: t.elapsed(),
                cache_hit: true,
            });
        }
        let (engine2, wasm2) = (engine.clone(), wasm.to_vec());
        let component =
            tokio::task::spawn_blocking(move || Component::new(&engine2, &wasm2)).await??;
        let compile = t.elapsed();
        let bytes = component.serialize()?;
        std::fs::create_dir_all(&dir)?;
        runtime::set_mode(&dir, 0o700);
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, &bytes)?;
        runtime::set_mode(&tmp, 0o600);
        std::fs::rename(&tmp, &path)?;
        sqlx::query(r#"UPDATE plugin_packages SET "cwasmSha256" = $2, "cwasmEngine" = $3 WHERE "pluginId" = $1"#)
            .bind(id)
            .bind(archive::sha256_hex(&bytes))
            .bind(&fp)
            .execute(&self.env.core)
            .await?;
        Ok(Loaded {
            component,
            compile,
            cache_hit: false,
        })
    }

    pub async fn restart(&self, id: &str) -> Result<Arc<PluginRt>, String> {
        if let Some(rt) = self.get(id) {
            rt.stop().await;
        }
        self.register(id).await
    }

    pub async fn shutdown(&self) {
        self.stopping
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.env.wake.notify_one();
        let all: Vec<_> = self
            .plugins
            .write()
            .unwrap()
            .drain()
            .map(|(_, v)| v)
            .collect();
        for rt in all {
            rt.stop().await;
        }
    }

    pub async fn http(&self, id: &str, req: HttpRequest) -> Result<HttpResponse, CallError> {
        let rt = self
            .get(id)
            .ok_or_else(|| CallError::Unavailable("not running".into()))?;
        rt.http(req).await
    }

    pub fn publish(&self, name: &str, payload: &str) {
        for rt in self.plugins.read().unwrap().values() {
            rt.push_event(name, payload);
        }
    }

    pub async fn set_config(&self, id: &str, key: &str, value: Option<&str>) -> sqlx::Result<()> {
        sqlx::query(
            r#"INSERT INTO app_settings ("key", "value") VALUES ($1, $2)
               ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()"#,
        )
        .bind(format!("plugin.{id}.{key}"))
        .bind(value)
        .execute(&self.env.core)
        .await?;
        if let Some(rt) = self.get(id) {
            rt.config_changed(vec![key.to_owned()]);
        }
        Ok(())
    }
}

/// One task: claims due scheduled calls of ready plugins, as many as their task lane can run.
async fn claimer(host: std::sync::Weak<Host>) {
    let stop = match host.upgrade() {
        Some(h) => h.stopping.load(std::sync::atomic::Ordering::SeqCst),
        None => return,
    };
    loop {
        let Some(h) = host.upgrade() else { return };
        if h.stopping.load(std::sync::atomic::Ordering::SeqCst) != stop {
            return;
        }
        let ready: Vec<Arc<PluginRt>> = h
            .plugins
            .read()
            .unwrap()
            .values()
            .filter(|rt| rt.state() == State::Ready)
            .cloned()
            .collect();
        let cfg = &h.env.cfg;
        let lease = cfg.deadlines.scheduled + cfg.lease_extra;
        let mut ids = Vec::new();
        for rt in &ready {
            let free = rt.task.free();
            if free == 0 {
                continue;
            }
            ids.push(rt.sh.id.to_string());
            let Ok(rows) = scheduled::claim(&h.env.core, &rt.sh.id, free, lease).await else {
                continue;
            };
            for c in rows {
                let (rt, core) = (rt.clone(), h.env.core.clone());
                tokio::spawn(async move {
                    if c.attempt > scheduled::MAX_ATTEMPTS {
                        tracing::error!(
                            "plugin \"{}\" scheduled call {} dropped after {} attempts",
                            rt.sh.id,
                            c.key,
                            c.attempt - 1
                        );
                        let _ = scheduled::done(&core, &rt.sh.id, &c.key, c.version).await;
                        return;
                    }
                    if rt
                        .scheduled(c.key.clone(), c.payload, c.attempt as u32)
                        .await
                        .is_ok()
                    {
                        let _ = scheduled::done(&core, &rt.sh.id, &c.key, c.version).await;
                    }
                    rt.sh.env.wake.notify_one();
                });
            }
        }
        let next = scheduled::next_due(&h.env.core, &ids).await.ok().flatten();
        let wake = h.env.clone();
        drop(h);
        let wait = next.map_or(Duration::from_secs(1), |t| {
            (t - chrono::Utc::now())
                .to_std()
                .unwrap_or_default()
                .min(Duration::from_secs(1))
        });
        let _ =
            tokio::time::timeout(wait.max(Duration::from_millis(5)), wake.wake.notified()).await;
    }
}

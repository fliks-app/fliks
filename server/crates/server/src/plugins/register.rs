//! Registering a package with the host: checks, database provisioning, settling and activation.
use super::*;

impl Plugins {
    pub(super) fn reverify(&self, pkg: &Package) -> Result<(), Fail> {
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
        self.db_waits.lock_clean().remove(&id);
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
    pub(super) fn wait_for_db(&self, pkg: &Package, f: &Fail) {
        let (Some(me), Ok(host)) = (self.app().map(|a| a.plugins.clone()), self.host()) else {
            return;
        };
        let generation = self.wait_gen.fetch_add(1, Ordering::SeqCst);
        let reason = format!("{}: {}", f.reason, f.detail);
        self.db_waits
            .lock_clean()
            .insert(pkg.plugin_id.clone(), (generation, reason));
        let pkg = pkg.clone();
        tokio::spawn(async move {
            let id = &pkg.plugin_id;
            let cfg = &host.env.cfg;
            for attempt in 0.. {
                tokio::time::sleep(cfg.ladder.get(attempt).copied().unwrap_or(cfg.db_retry)).await;
                let pending = {
                    let _l = me.lock(id).await;
                    if me.db_waits.lock_clean().get(id).map(|w| w.0) != Some(generation) {
                        return;
                    }
                    let r = me.try_register(&pkg).await;
                    if let Err(f) = &r
                        && f.reason == DB_UNAVAILABLE
                    {
                        me.fail(id, f.clone()).await;
                        continue;
                    }
                    me.db_waits.lock_clean().remove(id);
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

    pub(super) async fn try_register(&self, pkg: &Package) -> Result<Pending, Fail> {
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
            outbound: Arc::new(tokio::sync::Semaphore::new(outbound::MAX_IN_FLIGHT)),
        });
        let rt = PluginRt::new(sh, m.clone(), &loaded.component, pkg.network_internal)
            .map_err(|e| fail("invalid-component", e.to_string()))?;
        {
            let mut t = rt.timings.lock_clean();
            t.compile = loaded.elapsed;
            t.cache_hit = loaded.cache_hit;
        }
        host.live.write_clean().insert(id.clone(), rt.clone());
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

    pub(super) async fn warn_connection_budget(&self, _cap: usize) {
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
    pub(super) fn watch_late(&self, p: Pending) {
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

    pub(super) fn activate(&self, p: Pending) {
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

    pub(super) fn start_crons(&self, id: &str, jobs: &[registry::Job]) {
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
        self.crons.lock_clean().insert(id.to_owned(), handles);
    }
}

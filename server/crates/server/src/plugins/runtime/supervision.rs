//! Starting, crash handling and recreation of a plugin's instances, and its health loop.
use super::*;

impl PluginRt {
    pub(super) async fn run_start(self: &Arc<Self>) {
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
        self.timings.lock_clean().start = t.elapsed();
        if !self.alive(era) {
            return;
        }
        let db = self.core.last_db.load(Ordering::SeqCst);
        match r {
            Ok(Ok(())) => {
                self.sup.lock_clean().db_down = false;
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

    /// `degraded` with the core instance kept; `start` again after the ladder, then every 30 s.
    pub(super) fn db_degraded(self: &Arc<Self>, era: u64) {
        let delay = {
            let mut s = self.sup.lock_clean();
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
            if rt.alive(era) && rt.sup.lock_clean().db_down {
                rt.run_start().await;
            }
        });
    }

    pub(super) fn spawn_loops(self: &Arc<Self>) {
        let era = self.sh.era.load(Ordering::SeqCst);
        let rt = self.clone();
        tokio::spawn(async move { rt.health_loop(era).await });
        let rt = self.clone();
        tokio::spawn(async move { rt.event_loop(era).await });
    }

    pub(super) fn alive(&self, era: u64) -> bool {
        self.sh.era.load(Ordering::SeqCst) == era
            && !matches!(self.state(), State::Failed | State::Stopped)
    }

    /// A failed call lost its instance: a crash, unless the database caused it.
    pub(super) fn lost(self: &Arc<Self>, lane: &Lane, db: bool, why: &str) {
        if db && lane.kind == LaneKind::Core {
            tracing::warn!(
                "plugin \"{}\" core call lost, instance re-created without a crash ({why})",
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
            let mut s = self.sup.lock_clean();
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
        *lane.retry_at.lock_clean() = Some(now + delay);
        if lane.kind == LaneKind::Core {
            self.set_state(State::Crashed);
            self.set_state(State::Backoff);
            let rt = self.clone();
            let era = self.sh.era.load(Ordering::SeqCst);
            tokio::spawn(async move { rt.recreate_core(era, delay).await });
        }
    }

    /// A new core instance after `delay`; `start` runs again when no other instance lives.
    pub(super) async fn recreate_core(self: Arc<Self>, era: u64, delay: Duration) {
        tokio::time::sleep(delay).await;
        {
            let mut s = self.sup.lock_clean();
            if s.recreating || !self.alive(era) || self.core.live.load(Ordering::SeqCst) > 0 {
                return;
            }
            s.recreating = true;
        }
        let made = self.instantiate().await;
        match made {
            Ok(inst) => {
                let others = self.live_instances();
                self.core.put(inst);
                self.sup.lock_clean().recreating = false;
                if others == 0 || self.sup.lock_clean().db_down {
                    self.run_start().await;
                } else if matches!(self.state(), State::Crashed | State::Backoff) {
                    self.set_state(State::Ready);
                }
            }
            Err(SpawnError::Mismatch(d)) => {
                let mut s = self.sup.lock_clean();
                s.recreating = false;
                s.message = format!("manifest-mismatch: {d}");
                drop(s);
                self.set_state(State::Failed);
                self.drop_all();
            }
            Err(e) => {
                self.sup.lock_clean().recreating = false;
                self.crash(&self.core, &e.to_string());
            }
        }
    }

    /// Breaker or stop: every instance goes, running ones are abandoned (rule 44).
    pub fn drop_all(&self) {
        self.sh.era.fetch_add(1, Ordering::SeqCst);
        self.sh.stopped.notify_waiters();
        for l in self.lanes() {
            l.clear();
        }
        self.ring.lock_clean().clear();
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

    pub(super) async fn health_loop(self: Arc<Self>, era: u64) {
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
                || self.sup.lock_clean().db_down
            {
                continue;
            }
            let ok = match self.health().await {
                Ok(h) => h.ok,
                Err(CallError::Timeout) => false,
                Err(_) => continue,
            };
            let db = self.core.last_db.load(Ordering::SeqCst);
            let mut s = self.sup.lock_clean();
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
}

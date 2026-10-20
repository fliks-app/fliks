//! The calls into a running plugin: health, events, http, jobs and the config notice.
use super::*;

impl PluginRt {
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
        let mut r = self.ring.lock_clean();
        if r.len() == RING {
            r.pop_front();
            self.event_drops.fetch_add(1, Ordering::SeqCst);
        }
        r.push_back((name.to_owned(), payload.to_owned()));
        self.ring_wake.notify_one();
    }

    pub(super) async fn event_loop(self: Arc<Self>, era: u64) {
        let d = self.sh.env.cfg.deadlines.event;
        loop {
            if self.sh.era.load(Ordering::SeqCst) != era {
                return;
            }
            let next = (self.state() == State::Ready)
                .then(|| self.ring.lock_clean().pop_front())
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

    pub(super) fn ready(&self) -> Result<(), CallError> {
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
        *self.cfg_keys.lock_clean() = keys;
        self.cfg_gen.fetch_add(1, Ordering::SeqCst);
    }

    /// `residentSetSizeBytes`: linear memory in use, `None` with no instance up.
    pub fn memory(&self) -> Option<u64> {
        (self.live_instances() > 0).then(|| self.sh.mem_total.load(Ordering::Relaxed) as u64)
    }
}

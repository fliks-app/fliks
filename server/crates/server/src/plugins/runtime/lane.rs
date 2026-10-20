//! One lane of a plugin's instances: a bounded pool of calls with its own budget and waiting count.
use super::*;

pub struct Lane {
    pub kind: LaneKind,
    pub(super) max: usize,
    pub(super) queue: usize,
    pub(super) idle: Mutex<Vec<(Inst, Instant)>>,
    pub live: AtomicUsize,
    pub(super) sem: Semaphore,
    pub(super) waiting: AtomicUsize,
    pub(super) retry_at: Mutex<Option<Instant>>,
    /// Whether the lane's last call saw a `db` call fail `unavailable`.
    pub(super) last_db: AtomicBool,
}

pub(super) struct Waiting<'a>(&'a AtomicUsize);
impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(super) type CallFn<R> =
    Box<dyn for<'a> FnOnce(&'a mut Inst) -> BoxFuture<'a, wasmtime::Result<R>> + Send>;

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
    pub(super) fn new(kind: LaneKind, max: usize, queue: usize) -> Self {
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

    pub(super) fn clear(&self) {
        let gone = std::mem::take(&mut *self.idle.lock_clean());
        self.live.fetch_sub(gone.len(), Ordering::SeqCst);
    }

    pub(super) fn put(&self, inst: Inst) {
        self.live.fetch_add(1, Ordering::SeqCst);
        self.idle.lock_clean().push((inst, Instant::now()));
    }

    /// Drops the instances idle for `after` (rule 40: `http`, `task`, `job` lanes only).
    pub(super) fn reap(&self, after: Duration) -> usize {
        let mut idle = self.idle.lock_clean();
        let before = idle.len();
        idle.retain(|(_, at)| at.elapsed() < after);
        let gone = before - idle.len();
        self.live.fetch_sub(gone, Ordering::SeqCst);
        gone
    }

    pub(super) async fn call<R: Send>(
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
        let pooled = self.idle.lock_clean().pop();
        let inst = match pooled {
            Some((i, _)) => i,
            None => {
                if let Some(at) = *self.retry_at.lock_clean()
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
        // Counted live until it goes back to the pool; dropping the call drops it from the count.
        let mut slot = Slot {
            lane: self,
            inst: Some(inst),
        };
        let inst = slot.inst.as_mut().expect("held");
        {
            let d = inst.store.data_mut();
            d.deadline = until.into_std();
            d.db_unavailable = false;
        }
        let cfg_gen = rt.cfg_gen.load(Ordering::SeqCst);
        let keys = (inst.cfg_gen < cfg_gen).then(|| rt.cfg_keys.lock_clean().clone());
        let stopped = rt.sh.stopped.notified();
        tokio::pin!(stopped);
        stopped.as_mut().enable();
        if rt.sh.era.load(Ordering::SeqCst) != era {
            return Err(CallError::Unavailable("stopped".into()));
        }
        let res = {
            let work = async {
                if let Some(keys) = keys {
                    let Inst { store, guest, .. } = &mut *inst;
                    guest
                        .fliks_plugin_guest()
                        .call_config_changed(&mut *store, &keys)
                        .await?;
                    inst.cfg_gen = cfg_gen;
                }
                f(inst).await
            };
            tokio::select! {
                r = tokio::time::timeout_at(until, work) => r,
                _ = stopped => return Err(CallError::Unavailable("stopped".into())),
            }
        };
        let db = slot
            .inst
            .as_ref()
            .expect("held")
            .store
            .data()
            .db_unavailable;
        self.last_db.store(db, Ordering::SeqCst);
        let current = rt.sh.era.load(Ordering::SeqCst) == era;
        match res {
            Ok(Ok(r)) => {
                if current {
                    slot.back();
                }
                Ok(r)
            }
            Ok(Err(trap)) => {
                drop(slot);
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
                drop(slot);
                if current {
                    rt.lost(self, db, "deadline");
                }
                Err(CallError::Timeout)
            }
        }
    }
}

/// An instance taken from a lane: back to the pool, or dropped and uncounted.
pub(super) struct Slot<'a> {
    lane: &'a Lane,
    inst: Option<Inst>,
}

impl Slot<'_> {
    pub(super) fn back(mut self) {
        let inst = self.inst.take().expect("held");
        self.lane.idle.lock_clean().push((inst, Instant::now()));
    }
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        if self.inst.take().is_some() {
            self.lane.live.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

//! Plugin crons and triggers (rule 50, C111) and the scheduled-call claimer (rule 55).
use super::runtime::{CallError, State};
use super::scheduled;
use crate::state::AppState;
use std::time::Duration;

#[derive(Debug, PartialEq)]
pub enum Trigger {
    Started,
    Unknown,
    NotTriggerable,
    AlreadyRunning,
}

fn claim_name(id: &str, job: &str) -> String {
    format!("plugin:{id}:{job}")
}

/// One run of a declared job on its own instance, under its `jobs::Running` claim.
pub async fn run(st: &AppState, id: &str, name: &str, tick: bool) {
    let Some(claim) = st.jobs.claim(&claim_name(id, name)) else {
        let why = if st.jobs.is_restoring() {
            "a restore is running"
        } else {
            "previous run still in flight"
        };
        tracing::warn!("skipping job \"{name}\" for plugin \"{id}\" — {why}");
        return;
    };
    run_claimed(st, id, name, claim, tick).await;
}

async fn run_claimed(st: &AppState, id: &str, name: &str, claim: crate::jobs::Claim, _tick: bool) {
    let Some(rt) = st.plugins.rt(id).filter(|r| r.state() == State::Ready) else {
        tracing::warn!("skipping job \"{name}\" for plugin \"{id}\" — process is not ready");
        return;
    };
    match rt.job(name, None).await {
        Ok(()) => tracing::info!("job \"{name}\" for plugin \"{id}\" completed"),
        Err(e) => {
            let msg = match e {
                CallError::Guest(m) | CallError::Crashed(m) | CallError::Unavailable(m) => m,
                CallError::Timeout => "deadline".into(),
                CallError::Busy => "already running".into(),
            };
            tracing::warn!("job \"{name}\" for plugin \"{id}\" failed: {msg}");
        }
    }
    drop(claim);
}

/// `POST /api/commands` of a declared plugin job: started detached, or why not.
pub fn trigger(st: &AppState, name: &str) -> Trigger {
    let Some((id, job)) = st.plugins.registry.job(name) else {
        return Trigger::Unknown;
    };
    if !job.triggerable {
        return Trigger::NotTriggerable;
    }
    let Some(claim) = st.jobs.claim(&claim_name(&id, name)) else {
        return Trigger::AlreadyRunning;
    };
    let (st, name) = (st.clone(), name.to_owned());
    tokio::spawn(async move { run_claimed(&st, &id, &name, claim, false).await });
    Trigger::Started
}

/// Claims due calls of ready plugins, one per free task instance; none during a restore.
pub fn spawn_claimer(st: &AppState) {
    let st = st.clone();
    tokio::spawn(async move {
        loop {
            let Ok(host) = st.plugins.host() else { return };
            let env = host.env.clone();
            let mut ids = vec![];
            if !st.jobs.is_restoring() {
                for rt in st
                    .plugins
                    .live()
                    .into_iter()
                    .filter(|r| r.state() == State::Ready)
                {
                    ids.push(rt.sh.id.to_string());
                    let free = rt.task.free();
                    if free == 0 {
                        continue;
                    }
                    let lease = env.cfg.deadlines.scheduled + env.cfg.lease_extra;
                    let Ok(rows) = scheduled::claim(&st.db, &rt.sh.id, free, lease).await else {
                        continue;
                    };
                    for c in rows {
                        let (rt, st) = (rt.clone(), st.clone());
                        tokio::spawn(async move {
                            let id = rt.sh.id.to_string();
                            if c.attempt > scheduled::MAX_ATTEMPTS {
                                tracing::error!(
                                    "plugin \"{id}\" scheduled call {} dropped after {} attempts",
                                    c.key,
                                    c.attempt - 1
                                );
                                let _ = scheduled::done(&st.db, &id, &c.key, c.version).await;
                                return;
                            }
                            let Some(claim) = st.jobs.claim(&format!("plugin-call:{id}:{}", c.key))
                            else {
                                let _ = scheduled::release(&st.db, &id, &c.key, c.version).await;
                                return;
                            };
                            if rt
                                .scheduled(c.key.clone(), c.payload, c.attempt as u32)
                                .await
                                .is_ok()
                            {
                                let _ = scheduled::done(&st.db, &id, &c.key, c.version).await;
                            }
                            drop(claim);
                            rt.sh.env.wake.notify_one();
                        });
                    }
                }
            }
            let next = scheduled::next_due(&st.db, &ids).await.ok().flatten();
            let wait = next.map_or(Duration::from_secs(1), |t| {
                (t - chrono::Utc::now())
                    .to_std()
                    .unwrap_or_default()
                    .min(Duration::from_secs(1))
            });
            let _ =
                tokio::time::timeout(wait.max(Duration::from_millis(5)), env.wake.notified()).await;
        }
    });
}

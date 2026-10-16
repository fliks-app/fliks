//! The cron runner (`scheduler.md` rules 8, 19, 26) and the in-process "already running" set (C22).
use super::{audit, bodies, cron, names};
use crate::state::AppState;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};

/// Names of the jobs queued or running in this process.
#[derive(Default)]
pub struct Running(Mutex<HashSet<String>>);

/// Holds a name in `Running` until dropped.
pub struct Claim {
    set: Arc<Running>,
    name: String,
}

impl Running {
    pub fn claim(self: &Arc<Self>, name: &str) -> Option<Claim> {
        let fresh = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name.to_owned());
        fresh.then(|| Claim {
            set: self.clone(),
            name: name.to_owned(),
        })
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.set
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.name);
    }
}

/// One timer per job Rust schedules; the subtitle ticks stay Nest's (rule 31). Timers die with the runtime.
pub fn spawn(st: &AppState) {
    let tz = cron::server_tz();
    for &(name, expr, _) in names::CORE
        .iter()
        .filter(|(n, ..)| !names::SUBTITLE.contains(n))
    {
        let st = st.clone();
        cron::spawn(expr, tz, chrono::Utc::now, move || fire(st.clone(), name));
    }
    let st = st.clone();
    cron::spawn(names::PRUNE_CRON, tz, chrono::Utc::now, move || {
        let db = st.db.clone();
        tokio::spawn(async move {
            if let Err(e) = audit::prune(&db).await {
                tracing::error!("PruneOldCommands: {e}");
            }
        });
    });
}

fn fire(st: AppState, name: &'static str) {
    let Some(claim) = st.jobs.claim(name) else {
        tracing::warn!("Scheduled {name} skipped: the previous run is still going");
        return;
    };
    tokio::spawn(async move {
        audit::run_audited(&st, name, audit::Trigger::Scheduled, bodies::run(&st, name)).await;
        drop(claim);
    });
}

/// The manual path (rule 6) after the row is queued; the claim is released when the job ends.
pub async fn run_manual(st: AppState, id: i32, name: String, claim: Claim) {
    if let Err(e) = audit::mark_running(&st.db, id).await {
        tracing::error!("Command {name}: cannot record running: {e}");
    }
    audit::execute(&st, id, &name, "failed", bodies::run(&st, &name)).await;
    drop(claim);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_claimed_once_until_released() {
        let r = Arc::new(Running::default());
        let a = r.claim("Backup").unwrap();
        assert!(r.claim("Backup").is_none());
        assert!(r.claim("RescanAll").is_some());
        drop(a);
        assert!(r.claim("Backup").is_some());
    }
}

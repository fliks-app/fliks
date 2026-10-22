//! The cron runner (`scheduler.md` rules 8, 19, 26) and the in-process "already running" set.
use super::{audit, bodies, cron, names};
use crate::state::AppState;
use crate::sync::MutexExt;
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

/// The claim a restore holds: it excludes every job, and is refused while any job runs.
pub const RESTORE: &str = "Restore";

impl Running {
    /// A restore holds its claim: nothing new may start.
    pub fn is_restoring(&self) -> bool {
        self.0.lock_clean().contains(RESTORE)
    }

    pub fn claim(self: &Arc<Self>, name: &str) -> Option<Claim> {
        let mut set = self.0.lock_clean();
        let free = if name == RESTORE {
            set.is_empty()
        } else {
            !set.contains(RESTORE)
        };
        let fresh = free && set.insert(name.to_owned());
        fresh.then(|| Claim {
            set: self.clone(),
            name: name.to_owned(),
        })
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        self.set.0.lock_clean().remove(&self.name);
    }
}

/// One timer per job Rust schedules; the subtitle ticks are `subtitles::scheduler::spawn_tick`'s (rule 31). Timers die with the runtime.
pub fn spawn(st: &AppState) {
    let tz = cron::server_tz();
    for &(name, expr, _) in names::CORE
        .iter()
        .filter(|(n, ..)| !names::SUBTITLE.contains(n))
        .chain(names::LIVETV.iter())
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
        if crate::livetv::jobs::idle(&st, name).await {
            return;
        }
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

    #[test]
    fn a_restore_excludes_every_job_and_is_refused_while_one_runs() {
        let r = Arc::new(Running::default());
        let job = r.claim("Backup").unwrap();
        assert!(r.claim(RESTORE).is_none());
        drop(job);
        let restore = r.claim(RESTORE).unwrap();
        assert!(r.claim(RESTORE).is_none() && r.claim("Backup").is_none());
        drop(restore);
        assert!(r.claim("Backup").is_some());
    }
}

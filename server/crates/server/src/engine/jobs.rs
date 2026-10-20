//! Background-job waiters (`engine-glue.md` section E): `run_job` resolves on `BgJobDone`.
use super::{Engine, EngineError};
use crate::sync::MutexExt;
use fliks_engine_core::api::{BgJobState, JobRequest, JobResult};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::{sync::oneshot, task::JoinSet};

/// Called with a running job's percent (0 to 100), at most about once a second.
pub type Progress = Arc<dyn Fn(f64) + Send + Sync>;

struct JobEnd {
    state: BgJobState,
    result: Option<JobResult>,
    error: Option<String>,
}

struct Waiter {
    done: oneshot::Sender<Result<JobEnd, EngineError>>,
    progress: Option<Progress>,
}

/// Waiters by job id; several may share one (an identical request answers the same id).
#[derive(Default)]
pub(super) struct Waiters(Mutex<HashMap<String, Vec<Waiter>>>);

impl Waiters {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Waiter>>> {
        self.0.lock_clean()
    }

    /// Ids someone still waits for.
    pub(super) fn pending(&self) -> Vec<String> {
        self.lock().keys().cloned().collect()
    }
}

fn state_name(s: BgJobState) -> &'static str {
    match s {
        BgJobState::Queued => "queued",
        BgJobState::Running => "running",
        BgJobState::Paused => "paused",
        BgJobState::Done => "done",
        BgJobState::Failed => "failed",
        BgJobState::Cancelled => "cancelled",
    }
}

impl Engine {
    /// Submits and resolves with the result on `BgJobDone`; a job that fails or is cancelled is
    /// `EngineError::Job`. No timeout; an events reconnect re-checks it (`resync_jobs`).
    pub async fn run_job(
        &self,
        req: &JobRequest,
        on_progress: Option<Progress>,
    ) -> Result<JobResult, EngineError> {
        let id = self.submit_job(req).await?;
        self.wait_job(id, req, on_progress).await
    }

    /// Waits for a job already submitted (`submit_job`), for callers that need its id to cancel it.
    pub async fn wait_job(
        &self,
        id: String,
        req: &JobRequest,
        on_progress: Option<Progress>,
    ) -> Result<JobResult, EngineError> {
        let (done, ended) = oneshot::channel();
        self.inner
            .jobs
            .lock()
            .entry(id.clone())
            .or_default()
            .push(Waiter {
                done,
                progress: on_progress,
            });
        // It may have ended between the POST and the registration above.
        let engine = self.clone();
        tokio::spawn(async move { engine.check_job(&id).await });
        let end = ended
            .await
            .map_err(|_| EngineError::Other("engine job waiter dropped".into()))??;
        match (end.state, end.result) {
            (BgJobState::Done, Some(result)) => Ok(result),
            (state, _) => Err(EngineError::Job {
                state: state_name(state).to_owned(),
                what: end.error.unwrap_or_else(|| req.kind.name().to_owned()),
            }),
        }
    }

    pub(super) fn job_progress(&self, id: &str, pct: f64) {
        let callbacks: Vec<Progress> = self
            .inner
            .jobs
            .lock()
            .get(id)
            .into_iter()
            .flatten()
            .filter_map(|w| w.progress.clone())
            .collect();
        callbacks.iter().for_each(|f| f(pct));
    }

    pub(super) fn job_ended(
        &self,
        id: &str,
        state: BgJobState,
        result: Option<JobResult>,
        error: Option<String>,
    ) {
        let waiters = self.inner.jobs.lock().remove(id).unwrap_or_default();
        for w in waiters {
            let _ = w.done.send(Ok(JobEnd {
                state,
                result: result.clone(),
                error: error.clone(),
            }));
        }
    }

    /// After an events (re)connect: a `BgJobDone` may have been missed while disconnected.
    pub(super) async fn resync_jobs(&self) {
        let mut checks = JoinSet::new();
        for id in self.inner.jobs.pending() {
            let engine = self.clone();
            checks.spawn(async move { engine.check_job(&id).await });
        }
        while checks.join_next().await.is_some() {}
    }

    /// 404 rejects every waiter of the job; an ended state settles them; anything else (a thrown
    /// error included) leaves them for the next resync.
    pub(super) async fn check_job(&self, id: &str) {
        match self.get_job(id).await {
            Ok(None) => {
                let lost = self.inner.jobs.lock().remove(id).unwrap_or_default();
                for w in lost {
                    let _ = w
                        .done
                        .send(Err(EngineError::Other(format!("engine lost job {id}"))));
                }
            }
            Ok(Some(s)) if s.state.ended() => self.job_ended(id, s.state, s.result, s.error),
            _ => {}
        }
    }
}

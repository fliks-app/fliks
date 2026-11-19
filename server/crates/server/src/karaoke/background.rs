//! The engine feed, the sweep and the background pass (`docs/spec/karaoke.md` rules 6, 15-17).
use super::{Shared, aligner, flag, gpu_provider, run, store, verified_providers};
use crate::{engine::Feed, state::AppState};
use fliks_engine_core::api::{EngineEvent, JobPriority, ModelKind, ModelState};
use std::{sync::atomic::Ordering, time::Duration};

const WAKE_EVERY: Duration = Duration::from_secs(600);
const PER_WAKE: i64 = 20;

/// Where the pass sends `Separate`: to the optimization workers when one takes it, else to the main engine.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    Workers,
    Local,
}

/// Rule 16, minus the budget: where the pass runs now, `None` when it must not.
pub async fn route(st: &AppState) -> Option<Route> {
    if !flag(st, "karaoke.enabled", false).await
        || !flag(st, "karaoke.background", true).await
        || !super::caps(st).await.separate
    {
        return None;
    }
    if super::remote::eligible_workers(st).await > 0 {
        return Some(Route::Workers);
    }
    let features = st.engine.engine_features();
    let local = flag(st, "karaoke.background_cpu", false).await
        || gpu_provider(&features, &verified_providers(st).await).is_some();
    (local && !st.karaoke.stopped.load(Ordering::Relaxed)).then_some(Route::Local)
}

pub async fn allowed(st: &AppState) -> bool {
    route(st).await.is_some()
}

pub fn spawn(st: &AppState) {
    let sweeper = st.clone();
    tokio::spawn(async move {
        if let Err(e) = store::drop_missing(&sweeper.db).await {
            tracing::warn!("karaoke rows of missing files not dropped: {e}");
        }
        if let Err(e) = store::sweep(&sweeper).await {
            tracing::warn!("karaoke sweep failed: {e}");
        }
    });
    tokio::spawn(follow(st.clone()));
    tokio::spawn(pass_loop(st.clone()));
}

/// Re-emits the engine's model events and drops stems of a replaced separation model.
async fn follow(st: AppState) {
    let mut feed = st.engine.subscribe();
    loop {
        let event = match feed.recv().await {
            Ok(Feed::Event(e)) => e,
            Ok(Feed::Resync(..)) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                continue;
            }
            Err(_) => return,
        };
        let EngineEvent::ModelChanged { model } = &*event else {
            continue;
        };
        if let Ok(v) = serde_json::to_value(model) {
            super::emit_model(&st, v).await;
        }
        if model.kind == ModelKind::Separation
            && model.state == ModelState::Installed
            && let Ok(all) = st.engine.models().await
            && let Some(sep) = run::installed_model(&all.models, ModelKind::Separation)
            && let Err(e) = store::invalidate_stale_models(&st.db, &sep.id, &sep.version).await
        {
            tracing::warn!("karaoke model invalidation failed: {e}");
        }
    }
}

async fn pass_loop(st: AppState) {
    let mut adopted = st.engine.adoptions();
    loop {
        tokio::select! {
            () = tokio::time::sleep(WAKE_EVERY) => {}
            changed = adopted.changed() => {
                if changed.is_err() { return }
                st.karaoke.stopped.store(false, Ordering::Relaxed);
            }
            () = st.karaoke.wake.notified() => {
                st.karaoke.stopped.store(false, Ordering::Relaxed);
            }
            () = st.karaoke.kick.notified() => {}
        }
        aligner::auto_download(&st).await;
        if let Err(e) = pass(&st).await {
            tracing::warn!("karaoke background pass failed: {e}");
        }
    }
}

/// Rules 16 and 17: up to 20 tracks without stems, newest first, until a run reports an unwanted CPU.
async fn pass(st: &AppState) -> Result<(), sqlx::Error> {
    match route(st).await {
        None => Ok(()),
        Some(Route::Workers) => pass_workers(st).await,
        Some(Route::Local) => {
            // A job no worker took runs here now.
            sqlx::query("DELETE FROM jobs WHERE kind = 'separate' AND state = 'queued'")
                .execute(&st.db)
                .await?;
            crate::queue::watch::changed();
            pass_local(st).await
        }
    }
}

/// Deletes queued `separate` jobs of another profile than `profile`; how many.
pub async fn drop_stale_separations(db: &sqlx::PgPool, profile: &str) -> sqlx::Result<u64> {
    let n = sqlx::query(
        r#"DELETE FROM jobs WHERE kind = 'separate' AND state = 'queued' AND "profileHash" <> $1"#,
    )
    .bind(profile)
    .execute(db)
    .await?
    .rows_affected();
    if n > 0 {
        crate::queue::watch::changed();
    }
    Ok(n)
}

/// Queues the tracks for the workers, keeping at most `PER_WAKE` separation jobs active.
async fn pass_workers(st: &AppState) -> Result<(), sqlx::Error> {
    let Some(current) = super::remote::current_model(st).await else {
        return Ok(());
    };
    let profile = super::remote::profile_of(&current);
    // A job of an older model version would fail `model` on every up-to-date worker.
    drop_stale_separations(&st.db, &profile).await?;
    let budget = super::budget_bytes(st).await;
    let mut active: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM jobs WHERE kind = 'separate' AND state IN ('queued', 'leased')",
    )
    .fetch_one(&st.db)
    .await?;
    for item in store::unprepared(&st.db, &fail_list(&st.karaoke), PER_WAKE, &profile).await? {
        // A local run took the track over: queueing it again would separate it twice.
        if st
            .karaoke
            .runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&item)
            .is_some_and(run::RunState::active)
        {
            continue;
        }
        if active >= PER_WAKE || store::total(&st.db).await? >= budget / 10 * 9 {
            break;
        }
        match super::remote::enqueue(st, item).await {
            Ok(queued) => active += i64::from(queued),
            Err(e) => {
                tracing::warn!("karaoke separation of item #{item} not queued: {e}");
                st.karaoke
                    .failed
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(item);
            }
        }
    }
    Ok(())
}

async fn pass_local(st: &AppState) -> Result<(), sqlx::Error> {
    let budget = super::budget_bytes(st).await;
    let failed: Vec<i32> = fail_list(&st.karaoke);
    let profile = super::remote::current_model(st)
        .await
        .map(|m| super::remote::profile_of(&m))
        .unwrap_or_default();
    let tracks = store::unprepared(&st.db, &failed, PER_WAKE, &profile).await?;
    for item in tracks {
        if store::total(&st.db).await? >= budget / 10 * 9 || route(st).await != Some(Route::Local) {
            break;
        }
        let opts = run::Opts {
            align: true,
            melody: true,
            force: false,
        };
        let run::Start::Started(handle) = run::start(st, item, opts, JobPriority::Low, None).await
        else {
            continue;
        };
        match handle.await {
            Ok(Ok(out))
                if out.provider.as_deref() == Some("cpu")
                    && !flag(st, "karaoke.background_cpu", false).await =>
            {
                st.karaoke.stopped.store(true, Ordering::Relaxed);
                tracing::info!("karaoke background pass stopped: the engine ran on the CPU");
            }
            Ok(Ok(_)) => {}
            _ => {
                st.karaoke
                    .failed
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(item);
            }
        }
    }
    Ok(())
}

fn fail_list(k: &Shared) -> Vec<i32> {
    k.failed
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .copied()
        .collect()
}

async fn may_separate_here(st: &AppState) -> bool {
    route(st).await == Some(Route::Local)
        && store::total(&st.db).await.unwrap_or(i64::MAX) < super::budget_bytes(st).await / 10 * 9
}

/// Rule 41: re-aligns the stale items one track at a time; a row is replaced only by a new one.
pub(super) async fn realign(st: AppState, items: Vec<aligner::Stale>) {
    st.karaoke
        .realign_total
        .store(items.len(), Ordering::SeqCst);
    st.karaoke.realign_done.store(0, Ordering::SeqCst);
    for stale in items {
        let item = stale.item;
        let opts = run::Opts {
            align: true,
            melody: true,
            force: true,
        };
        // Without stems a re-alignment separates on the main engine: only where the local pass may.
        let outcome = if !run::stems_valid(&st, item).await && !may_separate_here(&st).await {
            None
        } else {
            match run::start(&st, item, opts, JobPriority::Low, None).await {
                run::Start::Started(handle) => {
                    Some(handle.await.unwrap_or_else(|e| Err(e.to_string().into())))
                }
                _ => None,
            }
        };
        st.karaoke
            .realign_results
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(item, aligner::result_of(outcome, &stale));
        st.karaoke.realign_done.fetch_add(1, Ordering::SeqCst);
    }
    st.karaoke.realign_total.store(0, Ordering::SeqCst);
    st.karaoke.realign_done.store(0, Ordering::SeqCst);
    st.karaoke.realigning.store(false, Ordering::SeqCst);
}

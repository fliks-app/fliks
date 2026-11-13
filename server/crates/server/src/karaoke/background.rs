//! The engine feed, the sweep and the background pass (`docs/spec/karaoke.md` rules 6, 15-17).
use super::{Shared, aligner, flag, gpu_provider, run, store, verified_providers};
use crate::{engine::Feed, state::AppState};
use fliks_engine_core::api::{EngineEvent, JobPriority, ModelKind, ModelState};
use std::{sync::atomic::Ordering, time::Duration};

const WAKE_EVERY: Duration = Duration::from_secs(600);
const PER_WAKE: i64 = 20;

/// Rule 16, minus the budget: the pass may run now.
pub async fn allowed(st: &AppState) -> bool {
    if !flag(st, "karaoke.enabled", false).await
        || !flag(st, "karaoke.background", true).await
        || st.karaoke.stopped.load(Ordering::Relaxed)
    {
        return false;
    }
    let features = st.engine.engine_features();
    gpu_provider(&features, &verified_providers(st).await).is_some()
        && super::caps(st).await.separate
}

pub fn spawn(st: &AppState) {
    let sweeper = st.clone();
    tokio::spawn(async move {
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
        }
        aligner::auto_download(&st).await;
        if let Err(e) = pass(&st).await {
            tracing::warn!("karaoke background pass failed: {e}");
        }
    }
}

/// Rules 16 and 17: up to 20 tracks without stems, newest first, until a run reports the CPU.
async fn pass(st: &AppState) -> Result<(), sqlx::Error> {
    if !allowed(st).await {
        return Ok(());
    }
    let budget = super::budget_bytes(st).await;
    let failed: Vec<i32> = fail_list(&st.karaoke);
    let tracks = store::unprepared(&st.db, &failed, PER_WAKE).await?;
    for item in tracks {
        if store::total(&st.db).await? >= budget / 10 * 9 || !allowed(st).await {
            break;
        }
        let opts = run::Opts {
            align: true,
            melody: true,
            realign: false,
        };
        let run::Start::Started(handle) = run::start(st, item, opts, JobPriority::Low, None).await
        else {
            continue;
        };
        match handle.await {
            Ok(Ok(out)) if out.provider.as_deref() == Some("cpu") => {
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
            realign: true,
        };
        let outcome = match run::start(&st, item, opts, JobPriority::Low, None).await {
            run::Start::Started(handle) => {
                Some(handle.await.map_err(|e| e.to_string()).and_then(|r| r))
            }
            _ => None,
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

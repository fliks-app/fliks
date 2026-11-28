//! The engine feed, the sweep and the background pass (`docs/spec/karaoke.md` rules 6, 15-17).
use super::{Shared, aligner, gpu_provider, run, store, verified_providers};
use crate::sync::MutexExt;
use crate::{engine::Feed, settings, state::AppState};
use fliks_engine_core::api::{EngineEvent, JobPriority};
use std::{sync::atomic::Ordering, time::Duration};

const WAKE_EVERY: Duration = Duration::from_secs(600);
const PER_WAKE: i64 = 20;
/// Programme rows prepared ahead of the playing one while the party's karaoke display is open.
const UPCOMING: usize = 5;

/// Where the pass sends `Separate`: to the optimization workers when one takes it, else to the main engine.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Route {
    Workers,
    Local,
}

/// Rule 16, minus the budget: where the pass runs now, `None` when it must not (queue pause included).
pub async fn route(st: &AppState) -> Option<Route> {
    if !settings::flag(&st.db, "karaoke.enabled", false).await
        || !settings::flag(&st.db, "karaoke.background", true).await
        || !super::caps(st).await.separate
    {
        return None;
    }
    match crate::queue::settings::load(&st.db).await {
        Ok(q) if !q.paused && q.open_now() => {}
        _ => return None,
    }
    if super::remote::eligible_workers(st).await > 0 {
        return Some(Route::Workers);
    }
    let features = st.engine.engine_features();
    let local = settings::flag(&st.db, "karaoke.background_cpu", false).await
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

/// Re-emits the engine's model events; any of them, or a gap in the feed, drops the cached models.
async fn follow(st: AppState) {
    let mut feed = st.engine.subscribe();
    loop {
        let event = match feed.recv().await {
            Ok(Feed::Event(e)) => e,
            Ok(Feed::Resync(..)) => {
                super::forget_models(&st);
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                tracing::debug!("karaoke model feed lagged by {n} events");
                super::forget_models(&st);
                continue;
            }
            Err(_) => return,
        };
        let EngineEvent::ModelChanged { model } = &*event else {
            continue;
        };
        super::forget_models(&st);
        if let Ok(v) = serde_json::to_value(model) {
            super::emit_model(&st, v).await;
        }
    }
}

async fn pass_loop(st: AppState) {
    let mut adopted = st.engine.adoptions();
    let timed = !crate::jobs::cron_disabled();
    let mut again = false;
    loop {
        if !again {
            tokio::select! {
                () = tokio::time::sleep(WAKE_EVERY), if timed => {}
                changed = adopted.changed() => {
                    if changed.is_err() { return }
                    super::forget_models(&st);
                    restart(&st.karaoke);
                }
                () = st.karaoke.wake.notified() => restart(&st.karaoke),
                () = st.karaoke.kick.notified() => {}
            }
            aligner::auto_download(&st).await;
        }
        // A batch that prepared a track is followed by the next one at once.
        again = match pass(&st).await {
            Ok(n) => n > 0,
            Err(e) => {
                tracing::warn!("karaoke background pass failed: {e}");
                false
            }
        };
    }
}

/// An adoption or a settings change: the CPU stop and the skipped tracks start over.
fn restart(k: &Shared) {
    k.stopped.store(false, Ordering::Relaxed);
    k.skipped.lock_clean().clear();
}

/// Rules 16 and 17: one batch until a run reports an unwanted CPU; the tracks it prepared locally.
async fn pass(st: &AppState) -> Result<usize, sqlx::Error> {
    match route(st).await {
        None => Ok(0),
        Some(Route::Workers) => pass_workers(st).await.map(|()| 0),
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
    for item in
        store::unprepared(&st.db, &skip_list(&st.karaoke), PER_WAKE, &current, false).await?
    {
        // A local run took the track over: queueing it again would separate it twice.
        if st.karaoke.runs.lock_clean().contains_key(&item) {
            continue;
        }
        if active >= PER_WAKE || store::total(&st.db).await? >= budget / 10 * 9 {
            break;
        }
        match super::remote::enqueue(st, item).await {
            Ok(true) => active += 1,
            Ok(false) => {
                st.karaoke.skipped.lock_clean().insert(item);
            }
            Err(e) => {
                tracing::warn!("karaoke separation of item #{item} not queued: {e}");
                st.karaoke.skipped.lock_clean().insert(item);
            }
        }
    }
    Ok(())
}

async fn pass_local(st: &AppState) -> Result<usize, sqlx::Error> {
    let budget = super::budget_bytes(st).await;
    let Some(current) = super::remote::current_model(st).await else {
        return Ok(0);
    };
    let sync = super::caps(st).await.align;
    let tracks =
        store::unprepared(&st.db, &skip_list(&st.karaoke), PER_WAKE, &current, sync).await?;
    let mut prepared = 0;
    for item in tracks {
        if store::total(&st.db).await? >= budget / 10 * 9 || route(st).await != Some(Route::Local) {
            break;
        }
        let run::Start::Started(handle) =
            run::start(st, item, run::Opts::ALL, JobPriority::Low, None).await
        else {
            st.karaoke.skipped.lock_clean().insert(item);
            continue;
        };
        match handle.await {
            Ok(Ok(out))
                if out.provider.as_deref() == Some("cpu")
                    && !settings::flag(&st.db, "karaoke.background_cpu", false).await =>
            {
                st.karaoke.stopped.store(true, Ordering::Relaxed);
                tracing::info!("karaoke background pass stopped: the engine ran on the CPU");
                return Ok(prepared);
            }
            Ok(Ok(_)) => prepared += 1,
            // A lasting failure is recorded and leaves `unprepared`; a passing one waits for the next wake.
            _ => {
                st.karaoke.skipped.lock_clean().insert(item);
            }
        }
    }
    Ok(prepared)
}

fn skip_list(k: &Shared) -> Vec<i32> {
    k.skipped.lock_clean().iter().copied().collect()
}

/// Rule 37: prepares the next programme tracks while the party's karaoke display is open.
pub async fn prepare_upcoming(st: &AppState, party: i32) {
    if !st.relay.has_display(party) || !settings::flag(&st.db, "karaoke.enabled", false).await {
        st.karaoke.upcoming.lock_clean().remove(&party);
        return;
    }
    let items = match upcoming_tracks(st, party).await {
        Ok(items) => items,
        Err(e) => return tracing::warn!("karaoke programme of party #{party} not read: {e}"),
    };
    {
        let mut last = st.karaoke.upcoming.lock_clean();
        if last.get(&party) == Some(&items) {
            return;
        }
        last.insert(party, items.clone());
    }
    for item in items {
        if let run::Start::Refused(r) =
            run::start(st, item, run::Opts::ALL, JobPriority::Normal, None).await
        {
            tracing::debug!("karaoke of programme item #{item} not started: {r:?}");
        }
    }
}

/// The track items of the programme after the playing row, at most [`UPCOMING`].
async fn upcoming_tracks(st: &AppState, party: i32) -> sqlx::Result<Vec<i32>> {
    let ids = crate::party::upcoming_items(st, party).await?;
    sqlx::query_scalar(
        r#"SELECT t.id FROM unnest($1::int[]) WITH ORDINALITY t(id, n)
           JOIN track_details td ON td."itemId" = t.id ORDER BY t.n LIMIT $2"#,
    )
    .bind(&ids)
    .bind(UPCOMING as i64)
    .fetch_all(&st.db)
    .await
}

async fn may_separate_here(st: &AppState) -> bool {
    route(st).await == Some(Route::Local)
        && store::total(&st.db).await.unwrap_or(i64::MAX) < super::budget_bytes(st).await / 10 * 9
}

/// Rule 41: re-processes the outdated tracks one at a time; a result is replaced only by a new one.
pub(super) async fn realign(st: AppState, items: Vec<aligner::Stale>) {
    st.karaoke
        .realign_total
        .store(items.len(), Ordering::SeqCst);
    st.karaoke.realign_done.store(0, Ordering::SeqCst);
    for stale in items {
        let item = stale.item;
        // Stems are separated again on the main engine only where the local pass may.
        let opts = run::Opts {
            separate: may_separate_here(&st).await,
            ..run::Opts::ALL
        };
        let outcome = if !opts.separate && !run::stems_present(&st, item).await {
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
            .lock_clean()
            .insert(item, aligner::result_of(outcome));
        st.karaoke.realign_done.fetch_add(1, Ordering::SeqCst);
    }
    st.karaoke.realign_total.store(0, Ordering::SeqCst);
    st.karaoke.realign_done.store(0, Ordering::SeqCst);
    st.karaoke.realigning.store(false, Ordering::SeqCst);
}

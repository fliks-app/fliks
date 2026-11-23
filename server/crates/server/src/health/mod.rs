//! The health checks job (`docs/spec/system.md` section F): one evaluation at boot and every 5 minutes,
//! the only producer of `health.issue`; the open checks live in `health_checks`.
mod checks;
mod db;
mod routes;

use crate::{
    libraries::path::probe,
    notifications::{self, payload},
    queue,
    state::AppState,
};
use checks::Check;
use db::{Kind, Transition};
use serde_json::Value;
use std::{
    collections::HashSet,
    sync::atomic::{AtomicI64, Ordering},
};
use tokio::sync::Mutex;

pub use routes::*;

/// One evaluation at a time: the cron tick, the boot run and `POST /checks/run` share the stored rows.
static RUN: Mutex<()> = Mutex::const_new(());
/// Unix milliseconds of the last finished evaluation; 0 before the first.
static CHECKED: AtomicI64 = AtomicI64::new(0);

async fn gather(st: &AppState) -> sqlx::Result<Vec<Check>> {
    let mut out = vec![];
    let plugins: Vec<(String, Value, String)> = sqlx::query_as(
        r#"SELECT "pluginId", COALESCE(manifest->'name', 'null'::jsonb), status::text
           FROM plugin_packages WHERE enabled AND manifest->>'kind' = 'process'"#,
    )
    .fetch_all(&st.db)
    .await?;
    for (id, name, status) in plugins {
        let name = name.as_str().unwrap_or(&id);
        out.extend(checks::plugin(
            &id,
            name,
            status == "failed",
            st.plugins.state_of(&id),
        ));
    }

    let floor = queue::settings::load(&st.db).await?.trash_min_free_gb;
    let folders: Vec<(i32, i32, String, String, bool)> = sqlx::query_as(
        r#"SELECT l.id, lf.id, l.name, lf.path,
             EXISTS (SELECT 1 FROM media_files f WHERE f."folderId" = lf.id)
           FROM libraries l JOIN library_folders lf ON lf."libraryId" = l.id
           ORDER BY l.name, l.id, lf.position, lf.id"#,
    )
    .fetch_all(&st.db)
    .await?;
    let mut seen = HashSet::new();
    for (library, folder, name, path, had_files) in folders {
        let p = probe(&path).await;
        let reach = p.as_ref().map(|p| (p.writable, p.empty));
        out.extend(checks::folder(
            library, folder, &name, &path, reach, had_files,
        ));
        if let Some(p) = p.filter(|p| p.fs.is_none_or(|f| seen.insert(f))) {
            let link = format!("/admin/settings/libraries/{library}");
            out.extend(checks::space(
                &format!("folder:{folder}"),
                &name,
                p.avail,
                floor,
                &link,
            ));
        }
    }
    let data = crate::paths::data_dir().to_string_lossy().into_owned();
    if let Some(p) = probe(&data)
        .await
        .filter(|p| p.fs.is_none_or(|f| seen.insert(f)))
    {
        out.extend(checks::space(
            "data",
            "data",
            p.avail,
            floor,
            "/admin/system",
        ));
    }

    out.extend(checks::storage(
        crate::jwt_secret::conf_persistent(),
        crate::paths::data_persistent(),
    ));

    let failed: Vec<String> = sqlx::query_scalar(
        r#"SELECT name FROM (
             SELECT DISTINCT ON (name) name, status FROM commands
             WHERE status IN ('completed', 'failed') ORDER BY name, "endedOn" DESC NULLS LAST, id DESC) last
           WHERE status = 'failed' ORDER BY name"#,
    )
    .fetch_all(&st.db)
    .await?;
    out.extend(
        failed
            .iter()
            .filter(|n| crate::jobs::is_core(n))
            .map(|n| checks::job(n)),
    );
    out.extend(checks::accounts_differ_by_case(
        &crate::users::names_differing_by_case(&st.db).await?,
    ));
    Ok(out)
}

fn announce(st: &AppState, t: Transition) {
    let (state, text) = match t.kind {
        Kind::Broken => ("broken", checks::text(&t.code, &t.params)),
        Kind::Fixed => (
            "fixed",
            format!("Resolved: {}", checks::text(&t.code, &t.params)),
        ),
    };
    crate::push::health_event(st, &t.key, matches!(t.kind, Kind::Broken), &text);
    notifications::dispatch(
        &st.db,
        "health.issue",
        payload!({ "check": t.key, "state": state, "message": text }),
    );
}

/// Open errors: `systemAttention` of `/api/counts`.
pub async fn error_count(db: &sqlx::PgPool) -> sqlx::Result<i64> {
    sqlx::query_scalar(r#"SELECT count(*) FROM health_checks WHERE "state" = 'error'"#)
        .fetch_one(db)
        .await
}

async fn evaluate(st: &AppState) -> sqlx::Result<()> {
    let now = gather(st).await?;
    for t in db::reconcile(&st.db, &now).await? {
        announce(st, t);
    }
    CHECKED.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
    Ok(())
}

/// Evaluates every check, stores the open ones and notifies each error that opened or closed.
/// Waits for a run in progress; each probe is bounded, so the wait is too.
pub async fn run(st: &AppState) -> sqlx::Result<()> {
    let _one = RUN.lock().await;
    evaluate(st).await
}

/// A tick skips when a run is in progress instead of queuing behind it.
async fn tick(st: AppState) {
    if let Some(Err(e)) = skip_if_running(&RUN, || evaluate(&st)).await {
        tracing::warn!("health checks failed: {e}");
    }
}

/// Runs `f` unless `lock` is held; `None` when skipped.
async fn skip_if_running<T, F: Future<Output = T>>(
    lock: &Mutex<()>,
    f: impl FnOnce() -> F,
) -> Option<T> {
    let _one = lock.try_lock().ok()?;
    Some(f().await)
}

/// A run now, then every 5 minutes; the cron timer dies with the runtime.
pub fn spawn(st: &AppState) {
    if crate::jobs::cron_disabled() {
        return;
    }
    tokio::spawn(tick(st.clone()));
    let st = st.clone();
    crate::jobs::spawn_cron(
        "*/5 * * * *",
        crate::jobs::server_tz(),
        chrono::Utc::now,
        move || {
            tokio::spawn(tick(st.clone()));
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_tick_skips_while_a_run_holds_the_lock_and_runs_after() {
        let lock = Mutex::new(());
        let held = lock.lock().await;
        assert_eq!(skip_if_running(&lock, || async { 1 }).await, None);
        drop(held);
        assert_eq!(skip_if_running(&lock, || async { 1 }).await, Some(1));
    }
}

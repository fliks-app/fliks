//! Job state changes, for the tracking page (SSE) and the optimizer notifications.
use crate::{events::SseEvent, notifications, state::AppState};
use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::Row;
use std::{collections::HashMap, time::Duration};
use tokio::sync::Notify;

// Rust writers wake the watcher; the fallback covers the `jobs` writes of DB triggers.
const FALLBACK: Duration = Duration::from_secs(60);

pub(super) static CHANGED: Notify = Notify::const_new();

/// A job was created or changed state: the watcher sweeps.
pub(crate) fn changed() {
    CHANGED.notify_waiters();
}

pub fn spawn(st: &AppState) {
    spawn_with_fallback(st, FALLBACK);
}

pub(super) fn spawn_with_fallback(st: &AppState, fallback: Duration) {
    let st = st.clone();
    tokio::spawn(async move {
        // Only what changes after boot is announced.
        let Ok(mut since) = sqlx::query_scalar::<_, DateTime<Utc>>("SELECT now()")
            .fetch_one(&st.db)
            .await
        else {
            return;
        };
        // ponytail: grows with the jobs touched since boot; prune finished ids if that ever matters.
        let mut seen: HashMap<i64, String> = HashMap::new();
        loop {
            let next = CHANGED.notified();
            tokio::pin!(next);
            // Armed before the sweep, so a change committed during it wakes the next one.
            next.as_mut().enable();
            match sweep(&st, since, &mut seen).await {
                Ok(Some(latest)) => since = latest,
                Ok(None) => {}
                Err(e) => tracing::warn!("job watch failed: {e}"),
            }
            let _ = tokio::time::timeout(fallback, next).await;
        }
    });
}

async fn sweep(
    st: &AppState,
    since: DateTime<Utc>,
    seen: &mut HashMap<i64, String>,
) -> sqlx::Result<Option<DateTime<Utc>>> {
    let rows = sqlx::query(
        r#"SELECT j.id, j.kind, j.state, j.error, j."mediaFileId" AS file, j."inSize", j."outSize", j."updatedAt",
                  COALESCE(m.title, regexp_replace(COALESCE(j."inPath", ''), '^.*/', '')) AS title
           FROM jobs j LEFT JOIN media_files f ON f.id = j."mediaFileId" LEFT JOIN media m ON m.id = f."mediaId"
           WHERE j."updatedAt" >= $1 ORDER BY j."updatedAt""#,
    )
    // Overlaps the last sweep: a transaction that began before it may commit after it.
    .bind(since - chrono::Duration::seconds(5))
    .fetch_all(&st.db)
    .await?;
    let mut latest = None;
    for r in rows {
        latest = Some(r.get::<DateTime<Utc>, _>("updatedAt"));
        let (id, state): (i64, String) = (r.get("id"), r.get("state"));
        if seen.insert(id, state.clone()).as_deref() == Some(&state) {
            continue;
        }
        super::emit_managers(
            st,
            SseEvent::OptimizeJobChanged {
                job_id: id,
                state: state.clone(),
            },
        )
        .await;
        let error: Option<Value> = r.get("error");
        let class = error
            .as_ref()
            .and_then(|e| e["class"].as_str())
            .unwrap_or("");
        let optimize = r.get::<String, _>("kind") == "optimize";
        // An optimize job that starts at once defers the file's sprites to its commit.
        if optimize
            && matches!(state.as_str(), "failed" | "cancelled" | "skipped")
            && let Some(f) = r.get::<Option<i32>, _>("file")
        {
            let st = st.clone();
            tokio::spawn(
                async move { crate::ingest::post_import::sprite_if_missing(&st, f).await },
            );
        }
        let mut p = Map::new();
        p.insert("title".into(), r.get::<String, _>("title").into());
        p.insert("jobId".into(), id.into());
        let event = match state.as_str() {
            "done" if optimize => {
                let (a, b): (Option<i64>, Option<i64>) = (r.get("inSize"), r.get("outSize"));
                if let (Some(a), Some(b)) = (a, b) {
                    p.insert("savedBytes".into(), (a - b).into());
                }
                "optimize.completed"
            }
            "failed" if matches!(class, "corrupt" | "damaged") => {
                if !first_corrupt(st, id, r.get("file")).await? {
                    continue;
                }
                "health.corrupt"
            }
            "failed" if optimize => {
                p.insert(
                    "error".into(),
                    error.unwrap_or(json!({}))["message"].clone(),
                );
                "optimize.failed"
            }
            _ => continue,
        };
        if let Err(e) = notifications::dispatch(&st.db, event, &p).await {
            tracing::warn!("notification {event} not sent: {e}");
        }
    }
    Ok(latest)
}

/// Marks the job and tells whether no job of the file reported its corruption before.
async fn first_corrupt(st: &AppState, job: i64, file: Option<i32>) -> sqlx::Result<bool> {
    let already: bool = sqlx::query_scalar(
        r#"SELECT EXISTS (SELECT 1 FROM jobs WHERE "mediaFileId" = $1 AND result ? 'corruptNotifiedAt')"#,
    )
    .bind(file)
    .fetch_one(&st.db)
    .await?;
    sqlx::query(
        r#"UPDATE jobs SET result = COALESCE(result, '{}'::jsonb) || jsonb_build_object('corruptNotifiedAt', now())
           WHERE id = $1 AND NOT (COALESCE(result, '{}'::jsonb) ? 'corruptNotifiedAt')"#,
    )
    .bind(job)
    .execute(&st.db)
    .await?;
    Ok(!already)
}

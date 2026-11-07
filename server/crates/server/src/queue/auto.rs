//! The automatic part: source verification (on demand and scheduled) and the hourly review of new files.
use super::{
    enqueue::{self, Queued},
    settings,
};
use crate::{events::SseEvent, state::AppState};
use fliks_engine_core::api::VerifyPayload;
use serde_json::json;

/// Below optimizations in the queue: a verification only reads.
const VERIFY_PRIORITY: i32 = -10;
/// New files are reviewed again for this long (hard-linked ones become ours once the seeding ends).
const REVIEW_DAYS: i32 = 30;

/// Queues a full read and software decode of each file; the worker reports `corrupt` or `damaged`.
pub async fn queue_verify(st: &AppState, ids: &[i32], priority: i32) -> sqlx::Result<Vec<Queued>> {
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        out.push(match enqueue::load(st, id, false).await? {
            Ok(l) => {
                let payload = json!(VerifyPayload {
                    info: l.info.clone()
                });
                enqueue::insert_job(st, "verify", &l, payload, "verify", priority, 0).await?
            }
            Err(o) => enqueue::done(id, o),
        });
    }
    st.queue.wake.notify_waiters();
    st.hub.emit(SseEvent::OptimizeQueueChanged {});
    Ok(out)
}

/// The files whose last verification is the oldest, or missing, beyond the interval.
async fn due(st: &AppState, days: u32, limit: u32) -> sqlx::Result<Vec<i32>> {
    sqlx::query_scalar(
        r#"SELECT f.id FROM media_files f
           WHERE f."streamInfo" IS NOT NULL AND f."streamInfo"->>'error' IS NULL
             AND jsonb_array_length(COALESCE(f."streamInfo"->'video', '[]'::jsonb)) > 0
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j."mediaFileId" = f.id
                               AND j.state IN ('queued', 'leased', 'staged', 'committing'))
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j."mediaFileId" = f.id AND j.state = 'failed'
                               AND j.error->>'class' IN ('corrupt', 'damaged')
                               AND j."inSize" = f.size AND j."inMtimeMs" IS NOT DISTINCT FROM f."mtimeMs")
             AND COALESCE((SELECT max(j."finishedAt") FROM jobs j WHERE j."mediaFileId" = f.id
                             AND j.kind = 'verify' AND j.state IN ('done', 'failed')), 'epoch')
                 < now() - make_interval(days => $1::int)
           ORDER BY COALESCE((SELECT max(j."finishedAt") FROM jobs j WHERE j."mediaFileId" = f.id
                                AND j.kind = 'verify' AND j.state IN ('done', 'failed')), 'epoch'), f.id
           LIMIT $2"#,
    )
    .bind(days as i32)
    .bind(i64::from(limit))
    .fetch_all(&st.db)
    .await
}

/// Scheduled verification, when the setting is on.
pub async fn schedule_verify(st: &AppState) -> sqlx::Result<usize> {
    let conf = settings::load(&st.db).await?;
    if conf.verify_interval_days == 0 {
        return Ok(0);
    }
    let ids = due(st, conf.verify_interval_days, conf.verify_batch).await?;
    queue_verify(st, &ids, VERIFY_PRIORITY).await?;
    Ok(ids.len())
}

/// Files per review pass; the next pass continues after the last one reviewed.
const REVIEW_BATCH: i64 = 200;

/// New files of the optimizing libraries without an optimize job, and the hard-linked ones `settled()`
/// marked `shared`: looked at again, whatever the pass before decided. One batch after `after`; returns
/// the last id seen, `None` once the end is reached.
pub async fn review_new(st: &AppState, after: i32) -> sqlx::Result<(usize, Option<i32>)> {
    let ids: Vec<i32> = sqlx::query_scalar(
        r#"SELECT f.id FROM media_files f JOIN media m ON m.id = f."mediaId"
           JOIN libraries l ON l.id = m."libraryId"
           WHERE f.id > $3 AND l."optimizeNewFiles" AND f."createdAt" >= l."optimizeNewFilesSince" AND (
             (f."createdAt" > now() - make_interval(days => $1)
              AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j."mediaFileId" = f.id AND j.kind = 'optimize'))
             OR (EXISTS (SELECT 1 FROM jobs j WHERE j."mediaFileId" = f.id AND j.state = 'skipped'
                           AND j.error->>'class' = 'shared')
                 AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j."mediaFileId" = f.id AND j.kind = 'optimize'
                                   AND NOT (j.state = 'skipped' AND j.error->>'class' = 'shared'))))
           ORDER BY f.id LIMIT $2"#,
    )
    .bind(REVIEW_DAYS)
    .bind(REVIEW_BATCH)
    .bind(after)
    .fetch_all(&st.db)
    .await?;
    let last = (ids.len() as i64 == REVIEW_BATCH)
        .then(|| ids.last().copied())
        .flatten();
    let mut cache = enqueue::Cache::new();
    let mut queued = 0;
    for id in ids {
        if enqueue::queue_new_cached(st, id, &mut cache).await?.outcome == enqueue::Outcome::Queued
        {
            queued += 1;
        }
    }
    Ok((queued, last))
}

/// The hourly sweep, in its own task: review batches until the end, then the scheduled verification.
pub async fn hourly(st: &AppState) {
    let mut after = 0;
    loop {
        match review_new(st, after).await {
            Ok((_, Some(last))) => after = last,
            Ok((_, None)) => break,
            Err(e) => {
                tracing::warn!("new files review failed: {e}");
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    }
    if let Err(e) = schedule_verify(st).await {
        tracing::warn!("scheduled verification failed: {e}");
    }
}

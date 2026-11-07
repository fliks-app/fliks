//! Queueing: "Queue", "Optimize…", "Force re-encode" and "Retry" write resolved jobs (plan and codec included).
use crate::{
    ingest::fsx,
    optimize::{diff, select},
    state::AppState,
};
use fliks_engine_core::api::{MediaInfo, OptimizePayload, OptimizePlan};
use serde::Serialize;
use serde_json::json;
use sqlx::Row;
use std::time::UNIX_EPOCH;

/// What the diff of a file against its profile decided.
pub struct Resolved {
    pub plan: OptimizePlan,
    pub profile_hash: String,
}

/// The file's difference with its library's profile, as the plan the engine executes; none when
/// the library has no profile or nothing is due. `force` is the "Force re-encode" action.
pub async fn resolve(st: &AppState, file_id: i32, force: bool) -> Option<Resolved> {
    let row = sqlx::query(
        r#"SELECT m."libraryId" AS library, l."allowRename" AS allow_rename, p.document
           FROM media_files f JOIN media m ON m.id = f."mediaId"
           JOIN libraries l ON l.id = m."libraryId"
           JOIN optimize_profiles p ON p.id = l."optimizeProfileId" WHERE f.id = $1"#,
    )
    .bind(file_id)
    .fetch_optional(&st.db)
    .await
    .ok()??;
    let profile = serde_json::from_value(row.get("document")).ok()?;
    let mut ctx = select::Context::load(&st.db, profile, row.get("allow_rename"))
        .await
        .ok()?;
    ctx.force = force;
    let mut found = None;
    select::analyze(&st.db, row.get("library"), Some(&[file_id]), &ctx, |c| {
        found = Some(c.outcome)
    })
    .await
    .ok()?;
    let Some(diff::Outcome::Diff(d)) = found else {
        return None;
    };
    let plan = d.plan()?;
    let json = serde_json::to_string(&d.changes).ok()?;
    Some(Resolved {
        profile_hash: crate::device_tokens::hash(&json)[..16].to_owned(),
        plan,
    })
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Queued,
    /// An active job already exists for the file.
    Active,
    /// No such file, or not readable on disk.
    Missing,
    /// The file has no probe, so no plan.
    Unprobed,
    /// Nothing to resolve: the file already matches.
    NothingToDo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queued {
    pub media_file_id: i32,
    pub outcome: Outcome,
    pub job_id: Option<i64>,
}

fn done(media_file_id: i32, outcome: Outcome) -> Queued {
    Queued {
        media_file_id,
        outcome,
        job_id: None,
    }
}

pub struct Snapshot {
    pub path: String,
    pub size: i64,
    pub mtime_ms: i64,
    pub dev: Option<i64>,
    pub ino: Option<i64>,
}

/// The identity the worker checks again before it swaps anything (`stale`).
pub async fn snapshot(abs: std::path::PathBuf) -> Option<Snapshot> {
    tokio::task::spawn_blocking(move || stat(&abs)).await.ok()?
}

fn stat(abs: &std::path::Path) -> Option<Snapshot> {
    let (real, meta) = fsx::regular_source(abs).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    #[cfg(unix)]
    let (dev, ino) = {
        use std::os::unix::fs::MetadataExt;
        (Some(meta.dev() as i64), Some(meta.ino() as i64))
    };
    #[cfg(not(unix))]
    let (dev, ino) = (None, None);
    Some(Snapshot {
        path: real.to_string_lossy().into_owned(),
        size: meta.len() as i64,
        mtime_ms,
        dev,
        ino,
    })
}

/// Queues one job per file, a file at a time so one failure does not hide the rest.
pub async fn queue_files(
    st: &AppState,
    ids: &[i32],
    force: bool,
    priority: i32,
) -> sqlx::Result<Vec<Queued>> {
    let mut out = Vec::with_capacity(ids.len());
    for &id in ids {
        out.push(queue_one(st, id, force, priority).await?);
    }
    st.queue.wake.notify_waiters();
    Ok(out)
}

async fn queue_one(st: &AppState, id: i32, force: bool, priority: i32) -> sqlx::Result<Queued> {
    let row = sqlx::query(
        r#"SELECT f."relativePath" AS rel, f."streamInfo" AS info, lf.path AS folder
           FROM media_files f JOIN library_folders lf ON lf.id = f."folderId" WHERE f.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?;
    let Some(row) = row else {
        return Ok(done(id, Outcome::Missing));
    };
    let info = row
        .get::<Option<serde_json::Value>, _>("info")
        .and_then(|v| serde_json::from_value::<MediaInfo>(v).ok());
    let Some(info) = info else {
        return Ok(done(id, Outcome::Unprobed));
    };
    let (folder, rel): (String, String) = (row.get("folder"), row.get("rel"));
    let snap = match fsx::locate(&folder, &rel) {
        Some(abs) => snapshot(abs).await,
        None => None,
    };
    let Some(snap) = snap else {
        return Ok(done(id, Outcome::Missing));
    };
    let Some(resolved) = resolve(st, id, force).await else {
        return Ok(done(id, Outcome::NothingToDo));
    };
    let payload = json!(OptimizePayload {
        info,
        plan: resolved.plan
    });
    let job = sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO jobs (kind, "mediaFileId", payload, "profileHash", priority, "inPath", "inSize",
             "inMtimeMs", "inDev", "inIno")
           VALUES ('optimize', $1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT ("mediaFileId") WHERE "mediaFileId" IS NOT NULL
             AND state IN ('queued', 'leased', 'staged', 'committing') DO NOTHING
           RETURNING id"#,
    )
    .bind(id)
    .bind(payload)
    .bind(&resolved.profile_hash)
    .bind(priority)
    .bind(&snap.path)
    .bind(snap.size)
    .bind(snap.mtime_ms)
    .bind(snap.dev)
    .bind(snap.ino)
    .fetch_optional(&st.db)
    .await?;
    Ok(match job {
        Some(j) => Queued {
            media_file_id: id,
            outcome: Outcome::Queued,
            job_id: Some(j),
        },
        None => done(id, Outcome::Active),
    })
}

/// "Retry": a `failed` or `skipped` job goes back to the queue with a fresh source snapshot, or `None` when it
/// is not retryable (or another job of the file is active).
pub async fn retry(st: &AppState, id: i64) -> sqlx::Result<Option<()>> {
    let row = sqlx::query(
        r#"SELECT "inPath" FROM jobs WHERE id = $1 AND state IN ('failed', 'skipped')"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let snap = match row.get::<Option<String>, _>("inPath") {
        Some(p) => snapshot(p.into()).await,
        None => None,
    };
    let res = sqlx::query(
        r#"UPDATE jobs SET state = 'queued', failures = 0, error = NULL, "notBefore" = now(),
             "workerId" = NULL, "deviceId" = NULL, "leaseUntil" = NULL, progress = 0, "finishedAt" = NULL,
             "inSize" = COALESCE($2, "inSize"), "inMtimeMs" = COALESCE($3, "inMtimeMs"),
             "inDev" = COALESCE($4, "inDev"), "inIno" = COALESCE($5, "inIno"), "updatedAt" = now()
           WHERE id = $1 AND state IN ('failed', 'skipped')"#,
    )
    .bind(id)
    .bind(snap.as_ref().map(|s| s.size))
    .bind(snap.as_ref().map(|s| s.mtime_ms))
    .bind(snap.as_ref().and_then(|s| s.dev))
    .bind(snap.as_ref().and_then(|s| s.ino))
    .execute(&st.db)
    .await;
    match res {
        Ok(r) if r.rows_affected() > 0 => {
            st.queue.wake.notify_waiters();
            Ok(Some(()))
        }
        Ok(_) => Ok(None),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => Ok(None),
        Err(e) => Err(e),
    }
}

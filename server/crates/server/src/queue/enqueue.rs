//! Queueing: "Queue", "Optimize…", "Force re-encode" and "Retry" write resolved jobs (plan and codec included).
use super::ocr;
use crate::{
    events::SseEvent,
    ingest::fsx,
    optimize::{diff, select},
    state::AppState,
};
use fliks_engine_core::api::{MediaInfo, OptimizePayload, OptimizePlan};
use serde::Serialize;
use serde_json::json;
use sqlx::Row;
use std::time::UNIX_EPOCH;

/// The library's profile as a comparison context; none when it has no profile.
async fn context(st: &AppState, library: i32) -> Option<select::Context> {
    let row = sqlx::query(
        r#"SELECT l."allowRename" AS allow_rename, p.document FROM libraries l
           JOIN optimize_profiles p ON p.id = l."optimizeProfileId" WHERE l.id = $1"#,
    )
    .bind(library)
    .fetch_optional(&st.db)
    .await
    .ok()??;
    let profile = serde_json::from_value(row.get("document")).ok()?;
    select::Context::load(
        &st.db,
        profile,
        row.get("allow_rename"),
        &st.queue.capabilities(),
    )
    .await
    .ok()
}

/// The plan of a difference, with the OCR it needs (`OcrPending` while that runs), and the hash of what it changes.
async fn planned(
    st: &AppState,
    ctx: &select::Context,
    l: &Loaded,
    d: &diff::Diff,
) -> Result<(OptimizePlan, String), Outcome> {
    let extra = if d
        .changes
        .iter()
        .any(|c| matches!(c, diff::Change::Ocr { .. }))
    {
        let o = ocr::extra_subtitles(st, &l.folder, &l.info, l.id, ctx.force).await;
        if o.pending {
            return Err(Outcome::OcrPending);
        }
        o.done
    } else {
        vec![]
    };
    let plan = d
        .plan(&ctx.profile, &l.info, &ctx.audio_playable, &extra)
        .ok_or(Outcome::NothingToDo)?;
    let json = serde_json::to_string(&d.changes).map_err(|_| Outcome::NothingToDo)?;
    Ok((plan, crate::device_tokens::hash(&json)[..16].to_owned()))
}

pub(super) struct Loaded {
    pub id: i32,
    pub info: MediaInfo,
    folder: String,
    snap: Snapshot,
}

pub(super) async fn load(
    st: &AppState,
    id: i32,
    skip_hardlinked: bool,
) -> sqlx::Result<Result<Loaded, Outcome>> {
    let row = sqlx::query(
        r#"SELECT f."relativePath" AS rel, f."streamInfo" AS info, lf.path AS folder, f.size, f."mtimeMs" AS mtime
           FROM media_files f JOIN library_folders lf ON lf.id = f."folderId" WHERE f.id = $1"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?;
    let Some(row) = row else {
        return Ok(Err(Outcome::Missing));
    };
    let info = row
        .get::<Option<serde_json::Value>, _>("info")
        .and_then(|v| serde_json::from_value::<MediaInfo>(v).ok());
    let Some(info) = info else {
        return Ok(Err(Outcome::Unprobed));
    };
    let (folder, rel): (String, String) = (row.get("folder"), row.get("rel"));
    let snap = match fsx::locate(&folder, &rel) {
        Some(abs) => snapshot(abs).await,
        None => None,
    };
    let (size, mtime): (i64, Option<i64>) = (row.get("size"), row.get("mtime"));
    Ok(match snap {
        Some(snap) if snap.symlink || (skip_hardlinked && snap.nlink > 1) => Err(Outcome::Shared),
        Some(snap) if snap.size != size || mtime.is_some_and(|m| m != snap.mtime_ms) => {
            Err(Outcome::Stale)
        }
        Some(snap) => Ok(Loaded {
            id,
            info,
            folder,
            snap,
        }),
        None => Err(Outcome::Missing),
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
    /// A symlink, or a hard-linked file the profile leaves alone: an external tool owns the bytes.
    Shared,
    /// The file on disk is not the one the probe describes: a rescan first.
    Stale,
    /// The OCR of its image tracks is running: queue the file again once it is done.
    OcrPending,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queued {
    pub media_file_id: i32,
    pub outcome: Outcome,
    pub job_id: Option<i64>,
}

pub(super) fn done(media_file_id: i32, outcome: Outcome) -> Queued {
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
    pub nlink: u64,
    /// The library entry itself is a symlink.
    pub symlink: bool,
}

/// The identity the worker checks again before it swaps anything (`stale`).
pub async fn snapshot(abs: std::path::PathBuf) -> Option<Snapshot> {
    tokio::task::spawn_blocking(move || stat(&abs)).await.ok()?
}

fn stat(abs: &std::path::Path) -> Option<Snapshot> {
    let symlink = std::fs::symlink_metadata(abs).is_ok_and(|m| m.file_type().is_symlink());
    let (real, meta) = fsx::regular_source(abs).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    #[cfg(unix)]
    let (dev, ino, nlink) = {
        use std::os::unix::fs::MetadataExt;
        (
            Some(meta.dev() as i64),
            Some(meta.ino() as i64),
            meta.nlink(),
        )
    };
    #[cfg(not(unix))]
    let (dev, ino, nlink) = (None, None, 1);
    Some(Snapshot {
        path: real.to_string_lossy().into_owned(),
        size: meta.len() as i64,
        mtime_ms,
        dev,
        ino,
        nlink,
        symlink,
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
        out.push(queue_one(st, id, force, priority, false).await?);
    }
    st.queue.wake.notify_waiters();
    st.hub.emit(SseEvent::OptimizeQueueChanged {});
    Ok(out)
}

/// A new file of a library that optimizes them: queued now, to start once it is `min_age_days` old.
pub async fn queue_new(st: &AppState, id: i32) -> sqlx::Result<Queued> {
    let q = queue_one(st, id, false, 0, true).await?;
    if q.outcome == Outcome::Queued {
        st.queue.wake.notify_waiters();
        st.hub.emit(SseEvent::OptimizeQueueChanged {});
    }
    Ok(q)
}

async fn queue_one(
    st: &AppState,
    id: i32,
    force: bool,
    priority: i32,
    new_file: bool,
) -> sqlx::Result<Queued> {
    let library: Option<i32> = sqlx::query_scalar(
        r#"SELECT m."libraryId" FROM media_files f JOIN media m ON m.id = f."mediaId"
           JOIN libraries l ON l.id = m."libraryId"
           WHERE f.id = $1 AND (NOT $2 OR l."optimizeNewFiles")"#,
    )
    .bind(id)
    .bind(new_file)
    .fetch_optional(&st.db)
    .await?;
    let Some(library) = library else {
        return Ok(done(id, Outcome::Missing));
    };
    let Some(mut ctx) = context(st, library).await else {
        return Ok(done(id, Outcome::NothingToDo));
    };
    ctx.force = force;
    // The age gate becomes the job's `notBefore`: the file is queued now and waits.
    let min_age = if new_file {
        std::mem::take(&mut ctx.profile.eligible.min_age_days)
    } else {
        0
    };
    let l = match load(st, id, ctx.profile.eligible.skip_hardlinked).await? {
        Ok(l) => l,
        Err(o) => return Ok(done(id, o)),
    };
    let mut found = None;
    select::analyze(&st.db, library, Some(&[id]), &ctx, |c| {
        found = Some(c.outcome)
    })
    .await?;
    let Some(diff::Outcome::Diff(d)) = found else {
        return Ok(done(id, Outcome::NothingToDo));
    };
    insert(st, &ctx, &l, &d, priority, min_age).await
}

/// Every file of a library with a difference, from one pass: the count, and the queueing that
/// follows in the background (the OCR of image tracks can take long).
pub async fn queue_library(st: &AppState, library: i32, priority: i32) -> sqlx::Result<usize> {
    let Some(ctx) = context(st, library).await else {
        return Ok(0);
    };
    let mut found: Vec<(i32, diff::Diff)> = vec![];
    select::analyze(&st.db, library, None, &ctx, |c| {
        if let diff::Outcome::Diff(d) = c.outcome {
            found.push((c.media_file_id, d));
        }
    })
    .await?;
    let n = found.len();
    let st = st.clone();
    tokio::spawn(async move {
        for (id, d) in found {
            let queued = match load(&st, id, ctx.profile.eligible.skip_hardlinked).await {
                Ok(Ok(l)) => insert(&st, &ctx, &l, &d, priority, 0).await,
                Ok(Err(o)) => Ok(done(id, o)),
                Err(e) => Err(e),
            };
            if let Err(e) = queued {
                tracing::warn!(file = id, "library queueing: {e}");
            }
        }
        st.queue.wake.notify_waiters();
        st.hub.emit(SseEvent::OptimizeQueueChanged {});
    });
    Ok(n)
}

async fn insert(
    st: &AppState,
    ctx: &select::Context,
    l: &Loaded,
    d: &diff::Diff,
    priority: i32,
    min_age_days: u32,
) -> sqlx::Result<Queued> {
    let (plan, hash) = match planned(st, ctx, l, d).await {
        Ok(p) => p,
        Err(o) => return Ok(done(l.id, o)),
    };
    let payload = json!(OptimizePayload {
        info: l.info.clone(),
        plan,
        staged_path: None,
        input_url: None,
        input_token: None,
    });
    insert_job(st, "optimize", l, payload, &hash, priority, min_age_days).await
}

/// The one write of a job: a no-op while another job of the file is active. `notBefore` is the file's
/// creation plus `min_age_days`.
pub(super) async fn insert_job(
    st: &AppState,
    kind: &str,
    l: &Loaded,
    payload: serde_json::Value,
    hash: &str,
    priority: i32,
    min_age_days: u32,
) -> sqlx::Result<Queued> {
    let (id, snap) = (l.id, &l.snap);
    let job = sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO jobs (kind, "mediaFileId", payload, "profileHash", priority, "inPath", "inSize",
             "inMtimeMs", "inDev", "inIno", "notBefore")
           VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9,
             CASE WHEN $11 > 0 THEN (SELECT "createdAt" FROM media_files WHERE id = $1) + make_interval(days => $11)
                  ELSE now() END)
           ON CONFLICT ("mediaFileId") WHERE "mediaFileId" IS NOT NULL
             AND state IN ('queued', 'leased', 'staged', 'committing') DO NOTHING
           RETURNING id"#,
    )
    .bind(id)
    .bind(payload)
    .bind(hash)
    .bind(priority)
    .bind(&snap.path)
    .bind(snap.size)
    .bind(snap.mtime_ms)
    .bind(snap.dev)
    .bind(snap.ino)
    .bind(kind)
    .bind(min_age_days as i32)
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
        r#"SELECT "inPath", "inSize", "inMtimeMs" FROM jobs WHERE id = $1 AND state IN ('failed', 'skipped')"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?;
    let Some(row) = row else { return Ok(None) };
    let snap = match row.get::<Option<String>, _>("inPath") {
        Some(p) => snapshot(p.into()).await,
        None => None,
    };
    // The plan addresses streams by index: a replaced file needs a new job, not this one.
    let unchanged = snap.as_ref().is_some_and(|s| {
        row.get::<Option<i64>, _>("inSize") == Some(s.size)
            && row.get::<Option<i64>, _>("inMtimeMs") == Some(s.mtime_ms)
    });
    if !unchanged {
        return Ok(None);
    }
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

#[cfg(all(test, unix))]
mod tests {
    use super::stat;

    #[test]
    fn a_symlink_and_a_hard_link_are_seen_before_anything_is_queued() {
        let dir = std::env::temp_dir().join(format!("fliks-snap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (real, link, hard) = (dir.join("a.mkv"), dir.join("s.mkv"), dir.join("h.mkv"));
        std::fs::write(&real, b"x").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        std::fs::hard_link(&real, &hard).unwrap();
        assert!(stat(&link).unwrap().symlink);
        let plain = stat(&hard).unwrap();
        assert!(!plain.symlink && plain.nlink == 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

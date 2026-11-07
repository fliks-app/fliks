//! The `jobs` table: take, fencing, results and the sweeps. Every state change of a leased job is
//! conditioned on `(id, attempt, workerId)`, so a stale worker can never move a re-leased job.
use crate::libraries::path::disk;
use chrono::{DateTime, Utc};
use fliks_engine_core::api::{JobError, JobErrorClass};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction, postgres::PgRow};
use std::path::Path;

pub const LEASE_S: u32 = 60;
pub const HEARTBEAT_S: u32 = 15;
pub const LONG_POLL_S: u32 = 30;
/// Real failures (`engine`, `network`) before a job is `failed`.
pub const MAX_FAILURES: i32 = 3;
/// A restart gives each live lease this long to be heartbeated again.
const BOOT_GRACE_S: i64 = 120;
const STDERR_MAX: usize = 64 * 1024;

/// Leases survive a server restart: a restart must not throw away hours of encoding.
pub async fn boot(pool: &PgPool) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE jobs SET "leaseUntil" = now() + make_interval(secs => $1)
           WHERE state = 'leased'"#,
    )
    .bind(BOOT_GRACE_S as f64)
    .execute(pool)
    .await
    .map(drop)
}

/// Expired leases go back to the queue; a lost worker is not a failure.
pub async fn expire(pool: &PgPool) -> sqlx::Result<u64> {
    let r = sqlx::query(
        r#"UPDATE jobs SET state = 'queued', "workerId" = NULL, "deviceId" = NULL, "leaseUntil" = NULL,
             progress = 0, "updatedAt" = now() WHERE state = 'leased' AND "leaseUntil" < now()"#,
    )
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

/// Leases of a revoked token's instances go back at once.
pub async fn release_token(pool: &PgPool, token_id: i32) -> sqlx::Result<u64> {
    let r = sqlx::query(
        r#"UPDATE jobs SET state = 'queued', "workerId" = NULL, "deviceId" = NULL, "leaseUntil" = NULL,
             progress = 0, "updatedAt" = now() WHERE state = 'leased' AND "workerId" LIKE $1"#,
    )
    .bind(format!("t{token_id}:%"))
    .execute(pool)
    .await?;
    Ok(r.rows_affected())
}

/// What the lease needs to know about the asking device.
pub struct Want<'a> {
    pub key: &'a str,
    pub device: &'a str,
    /// Codecs the device encodes in hardware, in software, and the software ones no registered device
    /// encodes in hardware (a hardware-planned job falls back to those only).
    pub hw: &'a [String],
    pub sw: &'a [String],
    pub fallback: &'a [String],
    pub max_jobs: u32,
    /// The worker reads the library by path; only then can the server check the target disk.
    pub local: bool,
}

pub struct Taken {
    pub id: i64,
    pub attempt: i32,
    pub kind: String,
    pub payload: Value,
    pub in_path: Option<String>,
    pub staged_path: Option<String>,
    /// The previous attempt's staging file, to delete.
    pub old_staged: Option<String>,
}

/// The staging file of an attempt, beside the source on the same filesystem.
pub fn staged_name(id: i64, attempt: i32) -> String {
    format!(".fliks-opt-{id}-{attempt}.tmp")
}

/// Whether `path` is exactly the staging file `staged_name` makes for job `id`, whatever the attempt.
pub fn is_staged_of(path: &Path, id: i64) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let Some(n) = name
        .strip_prefix(&format!(".fliks-opt-{id}-"))
        .and_then(|r| r.strip_suffix(".tmp"))
    else {
        return false;
    };
    !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())
}

fn parent_of(path: &str) -> Option<&Path> {
    Path::new(path)
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
}

/// Bytes still held by originals in the trash: `done` jobs whose result names a `trashPath` that is not
/// purged yet (written by the commit).
pub async fn unpurged_trash(pool: &PgPool) -> sqlx::Result<i64> {
    sqlx::query_scalar(
        r#"SELECT COALESCE(sum("inSize"), 0)::bigint FROM jobs
           WHERE state = 'done' AND result ? 'trashPath' AND NOT (result ? 'trashPurgedAt')"#,
    )
    .fetch_one(pool)
    .await
}

/// `FOR UPDATE SKIP LOCKED` on the best queued job this device may run: its codec is encodable, `notBefore`
/// passed, the target disk has room for the source plus the unpurged trash.
pub async fn take(pool: &PgPool, w: &Want<'_>) -> sqlx::Result<Option<Taken>> {
    let mut tx = pool.begin().await?;
    let running: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM jobs WHERE state = 'leased' AND "workerId" = $1 AND "deviceId" = $2"#,
    )
    .bind(w.key)
    .bind(w.device)
    .fetch_one(&mut *tx)
    .await?;
    if running >= i64::from(w.max_jobs) {
        return Ok(None);
    }
    let rows = sqlx::query(
        r#"SELECT id, kind, "inPath", "inSize" FROM jobs
           WHERE state = 'queued' AND "notBefore" <= now()
             AND (payload #>> '{plan,codec}' IS NULL OR CASE
                    WHEN payload #>> '{plan,software}' = 'true' THEN payload #>> '{plan,codec}' = ANY($2)
                    ELSE payload #>> '{plan,codec}' = ANY($1) OR payload #>> '{plan,codec}' = ANY($3) END)
           ORDER BY priority DESC, id LIMIT 16 FOR UPDATE SKIP LOCKED"#,
    )
    .bind(w.hw)
    .bind(w.sw)
    .bind(w.fallback)
    .fetch_all(&mut *tx)
    .await?;
    let mut trash: Option<i64> = None;
    let mut chosen = None;
    for r in rows {
        let (id, kind): (i64, String) = (r.get("id"), r.get("kind"));
        let in_path: Option<String> = r.get("inPath");
        if w.local && kind == "optimize" {
            let need: i64 = r.get::<Option<i64>, _>("inSize").unwrap_or(0);
            let held = match trash {
                Some(t) => t,
                None => {
                    let t = unpurged_trash(pool).await?;
                    trash = Some(t);
                    t
                }
            };
            let dir = in_path.as_deref().and_then(parent_of);
            if let Some(dir) = dir {
                let d = disk(&dir.to_string_lossy()).await;
                if d.accessible && d.free_space - held < need {
                    continue;
                }
            }
        }
        chosen = Some((id, kind, in_path));
        break;
    }
    let Some((id, kind, in_path)) = chosen else {
        return Ok(None);
    };
    let row = sqlx::query(
        r#"WITH old AS (SELECT "stagedPath" FROM jobs WHERE id = $1)
           UPDATE jobs SET state = 'leased', attempt = attempt + 1, "workerId" = $2, "deviceId" = $3,
             "leaseUntil" = now() + make_interval(secs => $4), "startedAt" = COALESCE("startedAt", now()),
             progress = 0, paused = false, "updatedAt" = now()
           WHERE id = $1 RETURNING attempt, payload, (SELECT "stagedPath" FROM old) AS old"#,
    )
    .bind(id)
    .bind(w.key)
    .bind(w.device)
    .bind(f64::from(LEASE_S))
    .fetch_one(&mut *tx)
    .await?;
    let attempt: i32 = row.get("attempt");
    let staged = match (
        w.local && kind == "optimize",
        in_path.as_deref().and_then(parent_of),
    ) {
        (true, Some(dir)) => Some(
            dir.join(staged_name(id, attempt))
                .to_string_lossy()
                .into_owned(),
        ),
        _ => None,
    };
    sqlx::query(r#"UPDATE jobs SET "stagedPath" = $2 WHERE id = $1"#)
        .bind(id)
        .bind(&staged)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let old: Option<String> = row.get("old");
    Ok(Some(Taken {
        id,
        attempt,
        kind,
        payload: row.get("payload"),
        in_path,
        old_staged: old.filter(|o| Some(o) != staged.as_ref()),
        staged_path: staged,
    }))
}

/// Instance hello: leases of `key` not in `held` go back to the queue; `held` entries the queue does not
/// know as leased to this instance are returned to abandon, the others get a fresh lease.
pub async fn hello(pool: &PgPool, key: &str, held: &[(i64, i32)]) -> sqlx::Result<Vec<i64>> {
    let mut tx = pool.begin().await?;
    let leased = sqlx::query(
        r#"SELECT id, attempt FROM jobs WHERE state = 'leased' AND "workerId" = $1 FOR UPDATE"#,
    )
    .bind(key)
    .fetch_all(&mut *tx)
    .await?;
    let leased: Vec<(i64, i32)> = leased
        .iter()
        .map(|r| (r.get("id"), r.get("attempt")))
        .collect();
    let drop_ids: Vec<i64> = leased
        .iter()
        .filter(|j| !held.contains(j))
        .map(|j| j.0)
        .collect();
    sqlx::query(
        r#"UPDATE jobs SET state = 'queued', "workerId" = NULL, "deviceId" = NULL, "leaseUntil" = NULL,
             progress = 0, "updatedAt" = now() WHERE id = ANY($1)"#,
    )
    .bind(&drop_ids)
    .execute(&mut *tx)
    .await?;
    let keep: Vec<i64> = held
        .iter()
        .filter(|j| leased.contains(j))
        .map(|j| j.0)
        .collect();
    sqlx::query(
        r#"UPDATE jobs SET "leaseUntil" = now() + make_interval(secs => $2) WHERE id = ANY($1)"#,
    )
    .bind(&keep)
    .bind(f64::from(LEASE_S))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(held
        .iter()
        .filter(|j| !leased.contains(j))
        .map(|j| j.0)
        .collect())
}

pub struct Beat {
    pub lease_until: DateTime<Utc>,
    pub cancel: bool,
}

/// `None` is the 409: `attempt` or `workerId` no longer match, or the job left the lease.
pub async fn heartbeat(
    pool: &PgPool,
    id: i64,
    key: &str,
    attempt: i32,
    progress: f64,
    paused: bool,
) -> sqlx::Result<Option<Beat>> {
    let row = sqlx::query(
        r#"UPDATE jobs SET progress = $4, paused = $5, "updatedAt" = now(),
             "leaseUntil" = CASE WHEN state = 'leased' THEN now() + make_interval(secs => $6)
                                 ELSE "leaseUntil" END
           WHERE id = $1 AND "workerId" = $2 AND attempt = $3 AND state IN ('leased', 'cancelled')
           RETURNING state, COALESCE("leaseUntil", now()) AS lease"#,
    )
    .bind(id)
    .bind(key)
    .bind(attempt)
    .bind(progress.clamp(0.0, 1.0) as f32)
    .bind(paused)
    .bind(f64::from(LEASE_S))
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| Beat {
        lease_until: r.get("lease"),
        cancel: r.get::<String, _>("state") == "cancelled",
    }))
}

/// What a `result` call did to the job.
#[derive(Debug, PartialEq, Eq)]
pub enum Settled {
    /// Fencing mismatch.
    Stale,
    Done,
}

/// How a failed job proceeds: the state it lands in, a retry delay, and whether it counts as a failure.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Fail,
    Skip,
    Retry { delay_s: i64 },
}

pub fn next_after(class: JobErrorClass, failures: i32) -> Next {
    match class {
        JobErrorClass::Access
        | JobErrorClass::Io
        | JobErrorClass::Corrupt
        | JobErrorClass::Damaged
        | JobErrorClass::Verify => Next::Fail,
        JobErrorClass::Stale => Next::Skip,
        JobErrorClass::Nospace => Next::Retry { delay_s: 900 },
        JobErrorClass::Busy => Next::Retry { delay_s: 300 },
        JobErrorClass::Engine | JobErrorClass::Network if failures + 1 >= MAX_FAILURES => {
            Next::Fail
        }
        JobErrorClass::Engine | JobErrorClass::Network => Next::Retry {
            delay_s: 60 << failures.clamp(0, 6),
        },
    }
}

fn class_name(c: JobErrorClass) -> String {
    serde_json::to_value(c)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn error_json(e: &JobError) -> Value {
    let mut tail = e.stderr_tail.clone().unwrap_or_default();
    if tail.len() > STDERR_MAX {
        let mut from = tail.len() - STDERR_MAX;
        while !tail.is_char_boundary(from) {
            from += 1;
        }
        tail = tail.split_off(from);
    }
    json!({ "class": class_name(e.class), "message": e.message, "stderr": tail })
}

/// The row of a leased job, locked, when `(attempt, workerId)` still match.
async fn lock_fenced(
    tx: &mut Transaction<'_, Postgres>,
    id: i64,
    key: &str,
    attempt: i32,
) -> sqlx::Result<Option<PgRow>> {
    sqlx::query(
        r#"SELECT state, kind, failures, "stagedPath" FROM jobs
           WHERE id = $1 AND "workerId" = $2 AND attempt = $3 FOR UPDATE"#,
    )
    .bind(id)
    .bind(key)
    .bind(attempt)
    .fetch_optional(&mut **tx)
    .await
}

/// A successful result: a `Verify` is `done`, an `Optimize` waits `staged` for the commit.
/// A repeated result of the same attempt (its answer was lost) answers the same.
pub async fn succeed(
    pool: &PgPool,
    id: i64,
    key: &str,
    attempt: i32,
    out_size: i64,
    out_sha256: Option<&str>,
    result: Option<Value>,
) -> sqlx::Result<Settled> {
    let mut tx = pool.begin().await?;
    let Some(row) = lock_fenced(&mut tx, id, key, attempt).await? else {
        return Ok(Settled::Stale);
    };
    if row.get::<String, _>("state") != "leased" {
        return Ok(Settled::Done);
    }
    let state = if row.get::<String, _>("kind") == "verify" {
        "done"
    } else {
        "staged"
    };
    sqlx::query(
        r#"UPDATE jobs SET state = $2, progress = 1, "outSize" = $3, "outSha256" = $4, result = $5,
             "leaseUntil" = NULL, "finishedAt" = CASE WHEN $2 = 'done' THEN now() END,
             "encodedAt" = now(), "updatedAt" = now() WHERE id = $1"#,
    )
    .bind(id)
    .bind(state)
    .bind(out_size)
    .bind(out_sha256)
    .bind(result)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Settled::Done)
}

/// A failed result, routed by its class (`next_after`).
pub async fn fail(
    pool: &PgPool,
    id: i64,
    key: &str,
    attempt: i32,
    err: &JobError,
) -> sqlx::Result<Settled> {
    let mut tx = pool.begin().await?;
    let Some(row) = lock_fenced(&mut tx, id, key, attempt).await? else {
        return Ok(Settled::Stale);
    };
    if row.get::<String, _>("state") != "leased" {
        return Ok(Settled::Done);
    }
    let failures: i32 = row.get("failures");
    let error = error_json(err);
    let (state, delay) = match next_after(err.class, failures) {
        Next::Fail => ("failed", 0),
        Next::Skip => ("skipped", 0),
        Next::Retry { delay_s } => ("queued", delay_s),
    };
    let real = i32::from(matches!(
        err.class,
        JobErrorClass::Engine | JobErrorClass::Network
    ));
    sqlx::query(
        r#"UPDATE jobs SET state = $2, error = $3, failures = failures + $4,
             "notBefore" = CASE WHEN $2 = 'queued' THEN now() + make_interval(secs => $5) ELSE "notBefore" END,
             "workerId" = CASE WHEN $2 = 'queued' THEN NULL ELSE "workerId" END,
             "deviceId" = CASE WHEN $2 = 'queued' THEN NULL ELSE "deviceId" END,
             "leaseUntil" = NULL, progress = 0,
             "finishedAt" = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END, "updatedAt" = now()
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(state)
    .bind(error)
        .bind(real)
    .bind(delay as f64)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Settled::Done)
}

/// The `stagedPath` of a job the worker reports on, for the size check of a local result.
pub async fn staged_of(pool: &PgPool, id: i64) -> sqlx::Result<Option<String>> {
    Ok(
        sqlx::query_scalar(r#"SELECT "stagedPath" FROM jobs WHERE id = $1"#)
            .bind(id)
            .fetch_optional(pool)
            .await?
            .flatten(),
    )
}

/// Cancels a job that is not being committed; whether it was.
pub async fn cancel(pool: &PgPool, id: i64) -> sqlx::Result<bool> {
    let n = sqlx::query(
        r#"UPDATE jobs SET state = 'cancelled', "finishedAt" = now(), "updatedAt" = now(),
             error = '{"class":"cancelled","message":"cancelled by an admin"}'::jsonb
           WHERE id = $1 AND state IN ('queued', 'leased', 'staged')"#,
    )
    .bind(id)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_staging_files_of_the_job_match() {
        let p = |s: &str| Path::new(s).to_path_buf();
        assert!(is_staged_of(&p("/m/a/.fliks-opt-7-2.tmp"), 7));
        assert!(!is_staged_of(&p("/m/a/.fliks-opt-7-2.tmp"), 8));
        assert!(!is_staged_of(&p("/m/a/.fliks-opt-7-x.tmp"), 7));
        assert!(!is_staged_of(&p("/m/a/movie.mkv"), 7));
        assert_eq!(staged_name(7, 2), ".fliks-opt-7-2.tmp");
    }

    #[test]
    fn errors_are_routed_by_class() {
        use JobErrorClass::*;
        assert_eq!(next_after(Corrupt, 0), Next::Fail);
        assert_eq!(next_after(Stale, 0), Next::Skip);
        assert_eq!(next_after(Busy, 2), Next::Retry { delay_s: 300 });
        assert_eq!(next_after(Engine, 0), Next::Retry { delay_s: 60 });
        assert_eq!(next_after(Engine, 1), Next::Retry { delay_s: 120 });
        assert_eq!(next_after(Network, 2), Next::Fail);
    }
}

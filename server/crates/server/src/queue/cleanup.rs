//! `staged` cleanup: a staging file is deleted by its exact name, never by a pattern (plan, "Cleanup and space").
use super::store::is_staged_of;
use sqlx::{PgPool, Row};
use std::path::PathBuf;

/// A `staged` job nobody committed for this long is abandoned.
const STAGED_MAX_DAYS: f64 = 7.0;

/// Removes the staging file of job `id`; anything else at `path` is left alone.
pub async fn remove_staged(id: i64, path: String) -> bool {
    let p = PathBuf::from(path);
    if !is_staged_of(&p, id) {
        return false;
    }
    match tokio::fs::remove_file(&p).await {
        Ok(()) => true,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(e) => {
            tracing::warn!(job = id, path = %p.display(), "staged file not removed: {e}");
            false
        }
    }
}

/// Staging files of jobs that ended otherwise than `done` or went back to the queue, and of jobs left `staged`
/// for a week (which end `failed`).
pub async fn staged(pool: &PgPool) {
    if let Err(e) = run(pool).await {
        tracing::warn!("staged cleanup failed: {e}");
    }
}

async fn run(pool: &PgPool) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE jobs SET state = 'failed', "finishedAt" = now(), "updatedAt" = now(),
             error = '{"class":"stale","message":"staged output never committed"}'::jsonb
           WHERE state = 'staged' AND "updatedAt" < now() - make_interval(days => $1)"#,
    )
    .bind(STAGED_MAX_DAYS as i32)
    .execute(pool)
    .await?;
    let rows = sqlx::query(
        r#"SELECT id, "stagedPath" FROM jobs
           WHERE "stagedPath" IS NOT NULL AND state IN ('queued', 'failed', 'skipped', 'cancelled')"#,
    )
    .fetch_all(pool)
    .await?;
    for r in rows {
        let (id, path): (i64, String) = (r.get("id"), r.get("stagedPath"));
        if remove_staged(id, path.clone()).await {
            sqlx::query(
                r#"UPDATE jobs SET "stagedPath" = NULL WHERE id = $1 AND "stagedPath" = $2"#,
            )
            .bind(id)
            .bind(path)
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

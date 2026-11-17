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

/// `(job, attempt)` of a `<job>-<attempt>-<stem>.part` upload file, parsed strictly.
fn upload_of(name: &str) -> Option<(i64, i32)> {
    let rest = name.strip_suffix(".part")?;
    let (id, rest) = rest.split_once('-')?;
    let (attempt, stem) = rest.split_once('-')?;
    fliks_engine_core::api::STEM_NAMES
        .contains(&stem)
        .then_some(())?;
    Some((id.parse().ok()?, attempt.parse().ok()?))
}

/// Karaoke stem uploads of attempts that no longer hold a lease.
async fn uploads(pool: &PgPool) -> sqlx::Result<()> {
    let Ok(mut dir) = tokio::fs::read_dir(crate::karaoke::store::dir().join(".uploads")).await
    else {
        return Ok(());
    };
    while let Ok(Some(e)) = dir.next_entry().await {
        let Some((id, attempt)) = e.file_name().to_str().and_then(upload_of) else {
            continue;
        };
        let held: bool = sqlx::query_scalar(
            r#"SELECT EXISTS (SELECT 1 FROM jobs WHERE id = $1 AND attempt = $2 AND state = 'leased')"#,
        )
        .bind(id)
        .bind(attempt)
        .fetch_one(pool)
        .await?;
        if !held {
            let _ = tokio::fs::remove_file(e.path()).await;
        }
    }
    Ok(())
}

async fn run(pool: &PgPool) -> sqlx::Result<()> {
    uploads(pool).await?;
    let stale = sqlx::query(
        r#"UPDATE jobs SET state = 'failed', "finishedAt" = now(), "updatedAt" = now(),
             error = '{"class":"stale","message":"staged output never committed"}'::jsonb
           WHERE state = 'staged' AND "updatedAt" < now() - make_interval(days => $1)"#,
    )
    .bind(STAGED_MAX_DAYS as i32)
    .execute(pool)
    .await?;
    if stale.rows_affected() > 0 {
        super::watch::changed();
    }
    let rows = sqlx::query(
        r#"SELECT id, "stagedPath" FROM jobs
           WHERE "stagedPath" IS NOT NULL AND state IN ('queued', 'done', 'failed', 'skipped', 'cancelled')"#,
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

#[cfg(test)]
mod tests {
    use super::upload_of;

    #[test]
    fn only_stem_uploads_parse() {
        assert_eq!(upload_of("7-2-vocals.part"), Some((7, 2)));
        assert_eq!(upload_of("7-2-guide.part"), Some((7, 2)));
        assert_eq!(upload_of("7-2-other.part"), None);
        assert_eq!(upload_of("7-x-vocals.part"), None);
        assert_eq!(upload_of("7-2-vocals.opus"), None);
    }
}

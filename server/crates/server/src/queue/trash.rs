//! The trash of originals: purged after the retention, and oldest first under the free-space threshold.
use super::settings;
use crate::{ingest::fsx, libraries::path::disk};
use sqlx::{PgPool, Row};
use std::path::{Path, PathBuf};

const GIB: i64 = 1 << 30;

struct Held {
    id: i64,
    /// Absent under the `keep` and `delete` policies, which still trash OCR SRTs.
    path: Option<PathBuf>,
    /// SRTs moved out of the library by the job.
    ocr: Vec<PathBuf>,
    /// Past the retention.
    expired: bool,
}

/// Purges what the retention or the free-space threshold calls for, and records `trashPurgedAt`.
pub async fn purge(pool: &PgPool) {
    if let Err(e) = run(pool).await {
        tracing::warn!("trash purge failed: {e}");
    }
}

async fn run(pool: &PgPool) -> sqlx::Result<()> {
    let s = settings::load(pool).await?;
    let rows = sqlx::query(
        r#"SELECT id, result ->> 'trashPath' AS path, result -> 'ocrTrash' AS ocr,
             "finishedAt" < now() - make_interval(days => $1) AS expired
           FROM jobs WHERE state = 'done' AND (result ? 'trashPath' OR result ? 'ocrTrash') AND NOT (result ? 'trashPurgedAt')
             AND (NOT (result ? 'restore') OR result ? 'restoredAt')
           ORDER BY "finishedAt", id"#,
    )
    .bind(s.trash_retention_days as i32)
    .fetch_all(pool)
    .await?;
    let held: Vec<Held> = rows
        .iter()
        .map(|r| Held {
            id: r.get("id"),
            path: r.get::<Option<String>, _>("path").map(PathBuf::from),
            ocr: r
                .get::<Option<serde_json::Value>, _>("ocr")
                .and_then(|v| serde_json::from_value::<Vec<(PathBuf, PathBuf)>>(v).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|(_, t)| t)
                .collect(),
            expired: r.get::<Option<bool>, _>("expired").unwrap_or(false),
        })
        .collect();
    let threshold = i64::from(s.trash_min_free_gb) * GIB;
    for h in held {
        let dir = h
            .path
            .as_deref()
            .or(h.ocr.first().map(PathBuf::as_path))
            .and_then(Path::parent);
        let low = match dir {
            Some(d) => {
                let d = disk(&d.to_string_lossy()).await;
                d.accessible && d.free_space < threshold
            }
            None => false,
        };
        if !(h.expired || low) {
            // Oldest first: the next ones are younger and the disk is not low.
            continue;
        }
        // The row lock orders the unlink against a restore, which writes `restore` under the same row.
        let mut tx = pool.begin().await?;
        let free: Option<i64> = sqlx::query_scalar(
            r#"SELECT id FROM jobs WHERE id = $1 AND state = 'done' AND NOT (result ? 'trashPurgedAt')
                 AND (NOT (result ? 'restore') OR result ? 'restoredAt') FOR UPDATE"#,
        )
        .bind(h.id)
        .fetch_optional(&mut *tx)
        .await?;
        if free.is_none() {
            continue;
        }
        let kept = match &h.path {
            Some(p) => !remove(p).await,
            None => false,
        };
        if kept {
            continue;
        }
        for p in &h.ocr {
            remove(p).await;
        }
        sqlx::query(
            r#"UPDATE jobs SET result = result || jsonb_build_object('trashPurgedAt', now()),
                 "updatedAt" = now() WHERE id = $1"#,
        )
        .bind(h.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    Ok(())
}

/// The trash file is `<root>/.fliks-trash/<job>.bak`; the root bounds the unlink.
async fn remove(path: &Path) -> bool {
    let Some(root) = path.parent().and_then(|p| p.parent()).map(PathBuf::from) else {
        return false;
    };
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let Ok(root) = fsx::Root::open(&root.to_string_lossy()) else {
            return false;
        };
        match fsx::unlink_contained(&root, &path) {
            Ok(_) => true,
            Err(e) => {
                tracing::warn!("trash file {} not removed: {e}", path.display());
                false
            }
        }
    })
    .await
    .unwrap_or(false)
}

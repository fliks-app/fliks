//! The trash of originals: purged after the retention, and oldest first under the free-space threshold.
use super::settings;
use crate::{ingest::fsx, libraries::path::disk};
use sqlx::{PgPool, Row};
use std::path::PathBuf;

const GIB: i64 = 1 << 30;

struct Held {
    id: i64,
    path: PathBuf,
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
        r#"SELECT id, result ->> 'trashPath' AS path,
             "finishedAt" < now() - make_interval(days => $1) AS expired
           FROM jobs WHERE state = 'done' AND result ? 'trashPath' AND NOT (result ? 'trashPurgedAt')
           ORDER BY "finishedAt", id"#,
    )
    .bind(s.trash_retention_days as i32)
    .fetch_all(pool)
    .await?;
    let held: Vec<Held> = rows
        .iter()
        .map(|r| Held {
            id: r.get("id"),
            path: PathBuf::from(r.get::<String, _>("path")),
            expired: r.get::<Option<bool>, _>("expired").unwrap_or(false),
        })
        .collect();
    let threshold = i64::from(s.trash_min_free_gb) * GIB;
    for h in held {
        let low = match h.path.parent() {
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
        if remove(&h.path).await {
            sqlx::query(
                r#"UPDATE jobs SET result = result || jsonb_build_object('trashPurgedAt', now()),
                     "updatedAt" = now() WHERE id = $1"#,
            )
            .bind(h.id)
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

/// The trash file is `<root>/.fliks-trash/<job>.bak`; the root bounds the unlink.
async fn remove(path: &PathBuf) -> bool {
    let Some(root) = path.parent().and_then(|p| p.parent()).map(PathBuf::from) else {
        return false;
    };
    let path = path.clone();
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

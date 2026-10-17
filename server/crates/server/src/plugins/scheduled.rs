//! Durable scheduled calls (plugins.md rule 55): rows in `plugin_scheduled_calls`.

use sqlx::PgPool;
use std::time::Duration;

pub const MAX_KEY: usize = 128;
pub const MAX_DELAY_MS: u64 = 30 * 24 * 3600 * 1000;
pub const MAX_PAYLOAD: usize = 64 * 1024;
pub const MAX_PENDING: i64 = 10_000;
pub const MAX_TOTAL: i64 = 16 << 20;
pub const MAX_ATTEMPTS: i32 = 20;

pub struct Claimed {
    pub key: String,
    pub payload: String,
    pub attempt: i32,
    pub version: i64,
}

pub async fn schedule(
    core: &PgPool,
    plugin: &str,
    key: &str,
    delay_ms: u64,
    payload: &str,
) -> Result<(), (&'static str, String)> {
    let n = key.chars().count();
    if n == 0 || n > MAX_KEY {
        return Err(("ERR_VALIDATION", "key must be 1-128 chars".into()));
    }
    if delay_ms > MAX_DELAY_MS {
        return Err(("ERR_VALIDATION", "delay over 30 days".into()));
    }
    if payload.len() > MAX_PAYLOAD {
        return Err(("ERR_VALIDATION", "payload over 64 KiB".into()));
    }
    let db = |e: sqlx::Error| ("ERR", e.to_string());
    let (count, total): (i64, i64) = sqlx::query_as(
        r#"SELECT count(*), coalesce(sum(length(payload)), 0)::bigint FROM plugin_scheduled_calls
           WHERE "pluginId" = $1 AND key <> $2"#,
    )
    .bind(plugin)
    .bind(key)
    .fetch_one(core)
    .await
    .map_err(db)?;
    if count >= MAX_PENDING || total + payload.len() as i64 > MAX_TOTAL {
        return Err(("ERR_VALIDATION", "too many pending calls".into()));
    }
    sqlx::query(
        r#"INSERT INTO plugin_scheduled_calls ("pluginId", key, "runAt", payload, attempt, version)
           VALUES ($1, $2, now() + $3 * interval '1 millisecond', $4, 0,
                   nextval('plugin_scheduled_calls_version_seq'))
           ON CONFLICT ("pluginId", key) DO UPDATE SET "runAt" = EXCLUDED."runAt",
             payload = EXCLUDED.payload, attempt = 0, version = EXCLUDED.version"#,
    )
    .bind(plugin)
    .bind(key)
    .bind(delay_ms as f64)
    .bind(payload)
    .execute(core)
    .await
    .map_err(db)?;
    Ok(())
}

pub async fn cancel(core: &PgPool, plugin: &str, key: &str) -> sqlx::Result<bool> {
    let r = sqlx::query(r#"DELETE FROM plugin_scheduled_calls WHERE "pluginId" = $1 AND key = $2"#)
        .bind(plugin)
        .bind(key)
        .execute(core)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Claims up to `limit` due rows, pushing their `runAt` past the call's deadline (the lease).
pub async fn claim(
    core: &PgPool,
    plugin: &str,
    limit: usize,
    lease: Duration,
) -> sqlx::Result<Vec<Claimed>> {
    let rows: Vec<(String, String, i32, i64)> = sqlx::query_as(
        r#"UPDATE plugin_scheduled_calls c
           SET attempt = c.attempt + 1, "runAt" = now() + $3 * interval '1 millisecond'
           FROM (SELECT "pluginId", key FROM plugin_scheduled_calls
                 WHERE "pluginId" = $1 AND "runAt" <= now()
                 ORDER BY "runAt" LIMIT $2 FOR UPDATE SKIP LOCKED) d
           WHERE c."pluginId" = d."pluginId" AND c.key = d.key
           RETURNING c.key, c.payload, c.attempt, c.version"#,
    )
    .bind(plugin)
    .bind(limit as i64)
    .bind(lease.as_millis() as f64)
    .fetch_all(core)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(key, payload, attempt, version)| Claimed {
            key,
            payload,
            attempt,
            version,
        })
        .collect())
}

/// Deletes the row only if no newer `schedule-call` replaced it meanwhile.
pub async fn done(core: &PgPool, plugin: &str, key: &str, version: i64) -> sqlx::Result<()> {
    sqlx::query(
        r#"DELETE FROM plugin_scheduled_calls WHERE "pluginId" = $1 AND key = $2 AND version = $3"#,
    )
    .bind(plugin)
    .bind(key)
    .bind(version)
    .execute(core)
    .await?;
    Ok(())
}

/// Undoes a claim the runner could not honour (a restore began): due again at once.
pub async fn release(core: &PgPool, plugin: &str, key: &str, version: i64) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE plugin_scheduled_calls SET attempt = attempt - 1, "runAt" = now()
           WHERE "pluginId" = $1 AND key = $2 AND version = $3"#,
    )
    .bind(plugin)
    .bind(key)
    .bind(version)
    .execute(core)
    .await
    .map(drop)
}

pub async fn next_due(
    core: &PgPool,
    plugins: &[String],
) -> sqlx::Result<Option<chrono::DateTime<chrono::Utc>>> {
    sqlx::query_scalar(
        r#"SELECT min("runAt") FROM plugin_scheduled_calls WHERE "pluginId" = ANY($1)"#,
    )
    .bind(plugins)
    .fetch_one(core)
    .await
}

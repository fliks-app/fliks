//! The `commands` table and the audit wrapper (`scheduler.md` rules 1-7, 20, 21, 26).
use crate::{events::SseEvent, http::json::iso_ms, state::AppState};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use std::{collections::HashMap, fmt::Display, future::Future};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Trigger {
    Manual,
    Scheduled,
    /// Only marker detection after an import.
    Auto,
}

impl Trigger {
    fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Scheduled => "scheduled",
            Self::Auto => "auto",
        }
    }
}

/// A row as `GET /commands` lists it: every key present.
#[derive(Debug, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: i32,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    #[sqlx(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub status: String,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "startedOn")]
    pub started_on: Option<DateTime<Utc>>,
    #[serde(with = "iso_ms::opt")]
    #[sqlx(rename = "endedOn")]
    pub ended_on: Option<DateTime<Utc>>,
    pub trigger: String,
    pub body: Option<Value>,
}

pub async fn insert_running(db: &PgPool, name: &str, trigger: Trigger) -> sqlx::Result<i32> {
    sqlx::query_scalar(
        r#"INSERT INTO commands (name, status, trigger, "startedOn") VALUES ($1, 'running', $2, now()) RETURNING id"#,
    )
    .bind(name)
    .bind(trigger.as_str())
    .fetch_one(db)
    .await
}

pub async fn insert_queued(db: &PgPool, name: &str) -> sqlx::Result<Command> {
    insert_queued_with_body(db, name, Trigger::Manual, None).await
}

/// A queued row of a job that runs detached (`detectSeason`), with its `body` as the caller reads it back.
pub async fn insert_queued_with_body(
    db: &PgPool,
    name: &str,
    trigger: Trigger,
    body: Option<Value>,
) -> sqlx::Result<Command> {
    sqlx::query_as(
        r#"INSERT INTO commands (name, status, trigger, body) VALUES ($1, 'queued', $2, $3)
           RETURNING id, "createdAt", "updatedAt", name, status, "startedOn", "endedOn", trigger, body"#,
    )
    .bind(name)
    .bind(trigger.as_str())
    .bind(body)
    .fetch_one(db)
    .await
}

pub async fn mark_running(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE commands SET status = 'running', "startedOn" = now() WHERE id = $1"#)
        .bind(id)
        .execute(db)
        .await
        .map(drop)
}

/// `status` is `completed` or `failed`.
pub async fn finish(db: &PgPool, id: i32, status: &str) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE commands SET status = $2, "endedOn" = now() WHERE id = $1"#)
        .bind(id)
        .bind(status)
        .execute(db)
        .await
        .map(drop)
}

/// Rule 7 and the restore sweep: every unfinished row becomes failed.
pub async fn sweep(db: &PgPool) -> sqlx::Result<u64> {
    let n = sqlx::query(
        r#"UPDATE commands SET status = 'failed', "endedOn" = now() WHERE status IN ('running', 'queued')"#,
    )
    .execute(db)
    .await?
    .rows_affected();
    if n > 0 {
        tracing::warn!("Marked {n} stale command(s) as failed on startup");
    }
    Ok(n)
}

pub async fn any_active(db: &PgPool) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM commands WHERE status IN ('running', 'queued'))",
    )
    .fetch_one(db)
    .await
}

/// Rule 26: `720 hours`, not calendar days, like 4.x (`Date.now() - 30 * 24 h`).
pub async fn prune(db: &PgPool) -> sqlx::Result<u64> {
    let n = sqlx::query(r#"DELETE FROM commands WHERE "createdAt" < now() - interval '720 hours'"#)
        .execute(db)
        .await?
        .rows_affected();
    tracing::info!("PruneOldCommands: deleted {n} command(s) older than 30 days");
    Ok(n)
}

pub async fn clear_history(db: &PgPool) -> sqlx::Result<u64> {
    let n = sqlx::query("DELETE FROM commands WHERE status NOT IN ('running', 'queued')")
        .execute(db)
        .await?
        .rows_affected();
    tracing::info!("Command history cleared — {n} row(s) deleted");
    Ok(n)
}

pub async fn page(db: &PgPool, offset: i64, limit: i64) -> sqlx::Result<(Vec<Command>, i64)> {
    let rows = sqlx::query_as(
        r#"SELECT id, "createdAt", "updatedAt", name, status, "startedOn", "endedOn", trigger, body
           FROM commands ORDER BY "createdAt" DESC, id DESC OFFSET $1 LIMIT $2"#,
    )
    .bind(offset)
    .bind(limit)
    .fetch_all(db)
    .await?;
    let total = sqlx::query_scalar("SELECT count(*) FROM commands")
        .fetch_one(db)
        .await?;
    Ok((rows, total))
}

/// `startedOn` and `status` of the newest row per name (rule 12).
pub async fn last_runs(
    db: &PgPool,
    names: &[String],
) -> sqlx::Result<HashMap<String, (Option<DateTime<Utc>>, String)>> {
    let rows: Vec<(String, Option<DateTime<Utc>>, String)> = sqlx::query_as(
        r#"SELECT DISTINCT ON (name) name, "startedOn", status FROM commands
           WHERE name = ANY($1) ORDER BY name, "createdAt" DESC, id DESC"#,
    )
    .bind(names)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|(n, s, st)| (n, (s, st))).collect())
}

/// Runs an already inserted row from `running` to its end (rules 4, 6); the error is logged, never returned.
pub async fn execute<E: Display>(
    st: &AppState,
    id: i32,
    name: &str,
    failed: &str,
    work: impl Future<Output = Result<(), E>>,
) {
    st.hub.emit(SseEvent::CommandStarted { name: name.into() });
    let status = match work.await {
        Ok(()) => "completed",
        Err(e) => {
            tracing::error!("Command {name} {failed}: {e}");
            "failed"
        }
    };
    if let Err(e) = finish(&st.db, id, status).await {
        tracing::error!("Command {name}: cannot record {status}: {e}");
    }
    st.hub.emit(SseEvent::CommandCompleted {
        name: name.into(),
        status: status.into(),
    });
}

/// Every in-process audited job runs here, so its `commands` row and events follow one lifecycle.
/// Without a row the work does not run and the answer is `false`.
pub async fn run_audited<E: Display>(
    st: &AppState,
    name: &str,
    trigger: Trigger,
    work: impl Future<Output = Result<(), E>>,
) -> bool {
    match insert_running(&st.db, name, trigger).await {
        Ok(id) => {
            execute(st, id, name, "error", work).await;
            true
        }
        Err(e) => {
            tracing::error!("Command {name}: cannot insert its row: {e}");
            false
        }
    }
}

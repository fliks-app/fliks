//! Remote worker tokens: shown once at creation, stored as a SHA-256, revocable.
use crate::{config::random_hex, device_tokens::hash, http::json::iso_ms};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgPool, Row};

const PREFIX: &str = "fkw_";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerToken {
    pub id: i32,
    pub name: String,
    pub enabled: bool,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms::opt")]
    pub last_seen_at: Option<DateTime<Utc>>,
}

/// The id of the live token this secret belongs to.
pub async fn find(pool: &PgPool, token: &str) -> sqlx::Result<Option<i32>> {
    if !token.starts_with(PREFIX) {
        return Ok(None);
    }
    sqlx::query_scalar(
        r#"SELECT id FROM worker_tokens WHERE "tokenHash" = $1 AND enabled AND "revokedAt" IS NULL"#,
    )
    .bind(hash(token))
    .fetch_optional(pool)
    .await
}

/// A new token and its row; the plaintext is not recoverable afterwards.
pub async fn create(pool: &PgPool, name: &str) -> sqlx::Result<(WorkerToken, String)> {
    let token = format!("{PREFIX}{}", random_hex(32));
    let row = sqlx::query(
        r#"INSERT INTO worker_tokens (name, "tokenHash") VALUES ($1, $2)
           RETURNING id, "createdAt""#,
    )
    .bind(name)
    .bind(hash(&token))
    .fetch_one(pool)
    .await?;
    let t = WorkerToken {
        id: row.get("id"),
        name: name.to_owned(),
        enabled: true,
        created_at: row.get("createdAt"),
        last_seen_at: None,
    };
    Ok((t, token))
}

pub async fn list(pool: &PgPool) -> sqlx::Result<Vec<WorkerToken>> {
    let rows = sqlx::query(
        r#"SELECT id, name, enabled, "createdAt", "lastSeenAt" FROM worker_tokens
           WHERE "revokedAt" IS NULL ORDER BY id"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| WorkerToken {
            id: r.get("id"),
            name: r.get("name"),
            enabled: r.get("enabled"),
            created_at: r.get("createdAt"),
            last_seen_at: r.get("lastSeenAt"),
        })
        .collect())
}

/// Whether a live token was revoked.
pub async fn revoke(pool: &PgPool, id: i32) -> sqlx::Result<bool> {
    let n = sqlx::query(
        r#"UPDATE worker_tokens SET "revokedAt" = now() WHERE id = $1 AND "revokedAt" IS NULL"#,
    )
    .bind(id)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(n > 0)
}

pub async fn touch(pool: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE worker_tokens SET "lastSeenAt" = now() WHERE id = $1"#)
        .bind(id)
        .execute(pool)
        .await
        .map(drop)
}

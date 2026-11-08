//! Remote worker tokens: shown once at creation, stored as a SHA-256, revocable.
use crate::{config::random_hex, device_tokens::hash, http::json::iso_ms};
use chrono::{DateTime, Utc};
use fliks_engine_core::api::PathMapping;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Row};

const PREFIX: &str = "fkw_";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerToken {
    pub id: i32,
    pub name: String,
    pub enabled: bool,
    /// `shared`: the worker mounts the library; `none`: it reads over HTTP and uploads its output.
    pub path_access: String,
    pub path_mappings: Vec<PathMapping>,
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
        path_access: "none".into(),
        path_mappings: vec![],
        created_at: row.get("createdAt"),
        last_seen_at: None,
    };
    Ok((t, token))
}

pub async fn list(pool: &PgPool) -> sqlx::Result<Vec<WorkerToken>> {
    let rows = sqlx::query(
        r#"SELECT id, name, enabled, "pathAccess", "pathMappings", "createdAt", "lastSeenAt" FROM worker_tokens
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
            path_access: r.get("pathAccess"),
            path_mappings: serde_json::from_value(r.get("pathMappings")).unwrap_or_default(),
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

/// How a token's worker reaches the library: by path through `mappings`, or not at all.
pub struct Access {
    pub shared: bool,
    pub mappings: Vec<PathMapping>,
}

pub async fn access(pool: &PgPool, id: i32) -> sqlx::Result<Access> {
    let row =
        sqlx::query(r#"SELECT "pathAccess", "pathMappings" FROM worker_tokens WHERE id = $1"#)
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map_or(
        Access {
            shared: false,
            mappings: vec![],
        },
        |r| Access {
            shared: r.get::<String, _>("pathAccess") == "shared",
            mappings: serde_json::from_value(r.get("pathMappings")).unwrap_or_default(),
        },
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub path_access: Option<String>,
    pub path_mappings: Option<Vec<PathMapping>>,
}

/// `None` without a live token, else whether the patch ended the terms of its leases (disabled, or another
/// access or mapping).
pub async fn update(pool: &PgPool, id: i32, p: &Patch) -> sqlx::Result<Option<bool>> {
    sqlx::query_scalar(
        r#"WITH old AS (SELECT "pathAccess", "pathMappings" FROM worker_tokens WHERE id = $1 AND "revokedAt" IS NULL)
           UPDATE worker_tokens SET name = COALESCE($2, name), enabled = COALESCE($3, enabled),
             "pathAccess" = COALESCE($4, "pathAccess"), "pathMappings" = COALESCE($5, "pathMappings")
           WHERE id = $1 AND "revokedAt" IS NULL
           RETURNING (NOT enabled OR "pathAccess" IS DISTINCT FROM (SELECT "pathAccess" FROM old)
             OR "pathMappings" IS DISTINCT FROM (SELECT "pathMappings" FROM old))"#,
    )
    .bind(id)
    .bind(&p.name)
    .bind(p.enabled)
    .bind(&p.path_access)
    .bind(p.path_mappings.as_ref().map(|m| serde_json::json!(m)))
    .fetch_optional(pool)
    .await
}

//! `plugin_packages`, `plugin_registrations` and `plugin_sources` rows (`plugins.md` SQL section).
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::{FromRow, PgPool};

#[derive(Debug, Clone, FromRow)]
pub struct Package {
    pub id: i32,
    #[sqlx(rename = "pluginId")]
    pub plugin_id: String,
    pub version: String,
    pub archive: Vec<u8>,
    pub origin: String,
    pub signature: String,
    #[sqlx(rename = "verifiedByKeyId")]
    pub verified_by_key_id: Option<String>,
    pub manifest: Value,
    pub enabled: bool,
    pub status: String,
    #[sqlx(rename = "statusReason")]
    pub status_reason: Option<String>,
    #[sqlx(rename = "networkInternal")]
    pub network_internal: bool,
    /// An update the unattended path did not install: `{version, reason, detail}`.
    #[sqlx(rename = "heldUpdate")]
    pub held_update: Option<Value>,
}

impl Package {
    pub fn is_process(&self) -> bool {
        self.manifest["kind"] == "process"
    }
}

const COLUMNS: &str = r#"id, "pluginId", version, archive, origin::text AS origin, signature, "verifiedByKeyId",
    manifest, enabled, status::text AS status, "statusReason", "networkInternal", "heldUpdate""#;

pub async fn all(db: &PgPool) -> sqlx::Result<Vec<Package>> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM plugin_packages ORDER BY id"
    ))
    .fetch_all(db)
    .await
}

pub async fn find(db: &PgPool, id: &str) -> sqlx::Result<Option<Package>> {
    sqlx::query_as(&format!(
        r#"SELECT {COLUMNS} FROM plugin_packages WHERE "pluginId" = $1"#
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

/// `status`/`statusReason` of one registration attempt.
pub async fn set_status(db: &PgPool, id: &str, reason: Option<&str>) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE plugin_packages SET status = $2::plugin_packages_status_enum, "statusReason" = $3,
             "updatedAt" = now() WHERE "pluginId" = $1"#,
    )
    .bind(id)
    .bind(if reason.is_some() { "failed" } else { "active" })
    .bind(reason)
    .execute(db)
    .await
    .map(drop)
}

pub async fn set_enabled(db: &PgPool, id: &str, enabled: bool) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE plugin_packages SET enabled = $2, "updatedAt" = now() WHERE "pluginId" = $1"#,
    )
    .bind(id)
    .bind(enabled)
    .execute(db)
    .await
    .map(drop)
}

pub struct Upsert<'a> {
    pub plugin_id: &'a str,
    pub version: &'a str,
    pub archive: &'a [u8],
    pub origin: &'a str,
    pub signature: &'a str,
    pub verified_by: Option<&'a str>,
    pub manifest: &'a Value,
    pub network_internal: bool,
}

/// Rule 19 (4)-(5): a fresh install is enabled, an upgrade keeps the admin's choice.
pub async fn upsert(db: &PgPool, u: Upsert<'_>) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"INSERT INTO plugin_packages ("pluginId", version, archive, origin, signature, "verifiedByKeyId",
             manifest, status, "statusReason", enabled, "networkInternal")
           VALUES ($1, $2, $3, $4::plugin_packages_origin_enum, $5, $6, $7, 'active', NULL, true, $8)
           ON CONFLICT ("pluginId") DO UPDATE SET version = EXCLUDED.version, archive = EXCLUDED.archive,
             origin = EXCLUDED.origin, signature = EXCLUDED.signature, "verifiedByKeyId" = EXCLUDED."verifiedByKeyId",
             manifest = EXCLUDED.manifest, status = 'active', "statusReason" = NULL,
             "networkInternal" = EXCLUDED."networkInternal", "cwasmSha256" = NULL, "cwasmEngine" = NULL,
             "heldUpdate" = NULL, "updatedAt" = now()
           RETURNING enabled"#,
    )
    .bind(u.plugin_id)
    .bind(u.version)
    .bind(u.archive)
    .bind(u.origin)
    .bind(u.signature)
    .bind(u.verified_by)
    .bind(u.manifest)
    .bind(u.network_internal)
    .fetch_one(db)
    .await
}

/// Records why `version` was not installed unattended; an install of any version clears it.
pub async fn hold_update(
    db: &PgPool,
    id: &str,
    version: &str,
    reason: &str,
    detail: &str,
) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE plugin_packages SET "heldUpdate" = $2 WHERE "pluginId" = $1"#)
        .bind(id)
        .bind(serde_json::json!({"version": version, "reason": reason, "detail": detail}))
        .execute(db)
        .await
        .map(drop)
}

pub async fn delete(db: &PgPool, id: &str) -> sqlx::Result<()> {
    sqlx::query(r#"DELETE FROM plugin_packages WHERE "pluginId" = $1"#)
        .bind(id)
        .execute(db)
        .await
        .map(drop)
}

/// The scopes an admin consented to; `None` before the first activation.
pub async fn granted_scopes(db: &PgPool, id: &str) -> sqlx::Result<Option<Vec<String>>> {
    sqlx::query_scalar(r#"SELECT scopes FROM plugin_registrations WHERE "pluginId" = $1"#)
        .bind(id)
        .fetch_optional(db)
        .await
}

/// A confirmed install is the consent to the manifest's scopes, wider or narrower than before.
pub async fn grant_scopes(db: &PgPool, id: &str, m: &Value) -> sqlx::Result<()> {
    let scopes: Vec<String> = m["scopes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    sqlx::query(r#"UPDATE plugin_registrations SET scopes = $2 WHERE "pluginId" = $1"#)
        .bind(id)
        .bind(scopes)
        .execute(db)
        .await
        .map(drop)
}

/// Created at the first activation with `scopes` and `ingestRoots`; an existing row keeps its
/// scopes (only a confirmed install changes them, `grant_scopes`) and re-reads `ingestRoots` and the manifest (rule 19 (5)).
pub async fn upsert_registration(db: &PgPool, id: &str, m: &Value) -> sqlx::Result<()> {
    let strs = |k: &str| -> Vec<String> {
        m[k].as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    };
    sqlx::query(
        r#"INSERT INTO plugin_registrations ("pluginId", "ingestRoots", scopes, manifest) VALUES ($1, $2, $3, $4)
           ON CONFLICT ("pluginId") DO UPDATE SET "ingestRoots" = EXCLUDED."ingestRoots",
             manifest = EXCLUDED.manifest, "updatedAt" = now()"#,
    )
    .bind(id)
    .bind(strs("ingestRoots"))
    .bind(strs("scopes"))
    .bind(m)
    .execute(db)
    .await
    .map(drop)
}

pub async fn delete_registration(db: &PgPool, id: &str) -> sqlx::Result<()> {
    sqlx::query(r#"DELETE FROM plugin_registrations WHERE "pluginId" = $1"#)
        .bind(id)
        .execute(db)
        .await
        .map(drop)
}

#[derive(Debug, Clone, FromRow)]
pub struct Source {
    pub id: i32,
    pub url: String,
    pub enabled: bool,
    #[sqlx(rename = "publicKey")]
    pub public_key: Option<Vec<u8>>,
    #[sqlx(rename = "lastRefreshedAt")]
    pub last_refreshed_at: Option<DateTime<Utc>>,
    #[sqlx(rename = "lastRefreshError")]
    pub last_refresh_error: Option<String>,
    #[sqlx(rename = "cachedCatalog")]
    pub cached_catalog: Option<Value>,
}

const SOURCE_COLUMNS: &str =
    r#"id, url, enabled, "publicKey", "lastRefreshedAt", "lastRefreshError", "cachedCatalog""#;

pub async fn sources(db: &PgPool, enabled_only: bool) -> sqlx::Result<Vec<Source>> {
    sqlx::query_as(&format!(
        "SELECT {SOURCE_COLUMNS} FROM plugin_sources WHERE NOT $1 OR enabled ORDER BY id"
    ))
    .bind(enabled_only)
    .fetch_all(db)
    .await
}

pub async fn source(db: &PgPool, id: i32) -> sqlx::Result<Option<Source>> {
    sqlx::query_as(&format!(
        "SELECT {SOURCE_COLUMNS} FROM plugin_sources WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

pub async fn source_by_url(db: &PgPool, url: &str) -> sqlx::Result<Option<Source>> {
    sqlx::query_as(&format!(
        "SELECT {SOURCE_COLUMNS} FROM plugin_sources WHERE url = $1 ORDER BY id LIMIT 1"
    ))
    .bind(url)
    .fetch_optional(db)
    .await
}

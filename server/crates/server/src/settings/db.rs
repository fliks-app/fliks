use crate::http::json::iso_ms;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};

/// The saved `AppSetting` entity.
#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
#[sqlx(rename_all = "camelCase")]
pub struct Setting {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub key: String,
    pub value: Option<String>,
}

const COLUMNS: &str = r#""id", "createdAt", "updatedAt", "key", "value""#;

pub async fn list(pool: &PgPool) -> sqlx::Result<Vec<(String, Option<String>)>> {
    sqlx::query_as(r#"SELECT "key", "value" FROM app_settings ORDER BY "key""#)
        .fetch_all(pool)
        .await
}

pub async fn get(pool: &PgPool, key: &str) -> sqlx::Result<Option<Setting>> {
    sqlx::query_as(&format!(
        r#"SELECT {COLUMNS} FROM app_settings WHERE "key" = $1"#
    ))
    .bind(key)
    .fetch_optional(pool)
    .await
}

/// Upsert, so two first writes of one key cannot race on the unique constraint.
pub async fn set(
    tx: &mut Transaction<'_, Postgres>,
    key: &str,
    value: Option<&str>,
) -> sqlx::Result<Setting> {
    sqlx::query_as(&format!(
        r#"INSERT INTO app_settings ("key", "value") VALUES ($1, $2)
           ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
           RETURNING {COLUMNS}"#
    ))
    .bind(key)
    .bind(value)
    .fetch_one(&mut **tx)
    .await
}

pub async fn manifests(pool: &PgPool) -> sqlx::Result<Vec<(String, serde_json::Value)>> {
    sqlx::query_as(r#"SELECT "pluginId", "manifest" FROM plugin_packages"#)
        .fetch_all(pool)
        .await
}

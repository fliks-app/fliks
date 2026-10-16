//! `media_servers` rows (`docs/spec/media-servers.md` SQL 1-2).
use crate::http::{AppError, json::iso_ms};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgPool, types::Json};

/// The entity as Nest serialises it, `apiKey` in clear (rule 7).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub r#type: String,
    pub url: String,
    pub api_key: Option<String>,
    pub events: Json<Vec<String>>,
    pub enabled: bool,
}

/// Columns a create or update writes.
pub struct Write<'a> {
    pub name: &'a str,
    pub r#type: &'a str,
    pub url: &'a str,
    pub api_key: Option<&'a str>,
    pub events: &'a [String],
    pub enabled: bool,
}

pub async fn list(db: &PgPool) -> sqlx::Result<Vec<Server>> {
    sqlx::query_as!(
        Server,
        r#"SELECT id, "createdAt" AS "created_at!", "updatedAt" AS "updated_at!", name,
                  type::text AS "type!", url, "apiKey" AS api_key,
                  events AS "events!: Json<Vec<String>>", enabled
           FROM media_servers ORDER BY name, id"#
    )
    .fetch_all(db)
    .await
}

pub async fn enabled(db: &PgPool) -> sqlx::Result<Vec<Server>> {
    sqlx::query_as!(
        Server,
        r#"SELECT id, "createdAt" AS "created_at!", "updatedAt" AS "updated_at!", name,
                  type::text AS "type!", url, "apiKey" AS api_key,
                  events AS "events!: Json<Vec<String>>", enabled
           FROM media_servers WHERE enabled ORDER BY id"#
    )
    .fetch_all(db)
    .await
}

pub async fn find(db: &PgPool, id: i32) -> sqlx::Result<Option<Server>> {
    sqlx::query_as!(
        Server,
        r#"SELECT id, "createdAt" AS "created_at!", "updatedAt" AS "updated_at!", name,
                  type::text AS "type!", url, "apiKey" AS api_key,
                  events AS "events!: Json<Vec<String>>", enabled
           FROM media_servers WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await
}

pub async fn insert(db: &PgPool, w: &Write<'_>) -> sqlx::Result<i32> {
    sqlx::query_scalar!(
        r#"INSERT INTO media_servers (name, type, url, "apiKey", events, enabled)
           VALUES ($1, $2::text::media_servers_type_enum, $3, $4, $5, $6) RETURNING id"#,
        w.name,
        w.r#type,
        w.url,
        w.api_key,
        serde_json::json!(w.events),
        w.enabled
    )
    .fetch_one(db)
    .await
}

pub async fn update(db: &PgPool, id: i32, w: &Write<'_>) -> sqlx::Result<()> {
    sqlx::query!(
        r#"UPDATE media_servers SET name = $2, type = $3::text::media_servers_type_enum, url = $4,
           "apiKey" = $5, events = $6, enabled = $7, "updatedAt" = now() WHERE id = $1"#,
        id,
        w.name,
        w.r#type,
        w.url,
        w.api_key,
        serde_json::json!(w.events),
        w.enabled
    )
    .execute(db)
    .await
    .map(drop)
}

pub async fn delete(db: &PgPool, id: i32) -> sqlx::Result<()> {
    sqlx::query!("DELETE FROM media_servers WHERE id = $1", id)
        .execute(db)
        .await
        .map(drop)
}

pub fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("MediaServer #{id} not found"))
}

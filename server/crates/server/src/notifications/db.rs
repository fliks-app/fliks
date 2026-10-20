use chrono::{DateTime, Utc};
use fliks_domain::notifications::redact;
use serde_json::{Map, Value, json};
use sqlx::{PgPool, types::Json};

pub struct Connection {
    pub id: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub typ: String,
    pub settings: Json<Map<String, Value>>,
    pub events: Json<Vec<String>>,
    pub enabled: bool,
}

impl Connection {
    /// `ConnectionJSON`: settings redacted (F5, F28).
    pub fn json(&self) -> Value {
        let ms = |t: &DateTime<Utc>| fliks_domain::js::iso(*t);
        json!({
            "id": self.id,
            "createdAt": ms(&self.created_at),
            "updatedAt": ms(&self.updated_at),
            "name": self.name,
            "type": self.typ,
            "settings": redact(&self.typ, &self.settings),
            "events": self.events.0,
            "enabled": self.enabled,
        })
    }
}

pub struct Write {
    pub name: String,
    pub typ: String,
    pub settings: Map<String, Value>,
    pub events: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

pub async fn list(pool: &PgPool) -> sqlx::Result<Vec<Connection>> {
    sqlx::query_as!(
        Connection,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, type AS typ,
                  settings AS "settings: Json<Map<String, Value>>",
                  events AS "events: Json<Vec<String>>", enabled
           FROM notification_connections ORDER BY name ASC"#
    )
    .fetch_all(pool)
    .await
}

pub async fn find(pool: &PgPool, id: i32) -> sqlx::Result<Option<Connection>> {
    sqlx::query_as!(
        Connection,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, type AS typ,
                  settings AS "settings: Json<Map<String, Value>>",
                  events AS "events: Json<Vec<String>>", enabled
           FROM notification_connections WHERE id = $1"#,
        id
    )
    .fetch_optional(pool)
    .await
}

/// Enabled connections subscribed to `event`.
pub async fn subscribed(pool: &PgPool, event: &str) -> sqlx::Result<Vec<Connection>> {
    sqlx::query_as!(
        Connection,
        r#"SELECT id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, type AS typ,
                  settings AS "settings: Json<Map<String, Value>>",
                  events AS "events: Json<Vec<String>>", enabled
           FROM notification_connections WHERE enabled AND jsonb_exists(events, $1)"#,
        event
    )
    .fetch_all(pool)
    .await
}

pub async fn insert(pool: &PgPool, w: Write) -> sqlx::Result<Connection> {
    sqlx::query_as!(
        Connection,
        r#"INSERT INTO notification_connections (name, type, settings, events, enabled)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, type AS typ,
                     settings AS "settings: Json<Map<String, Value>>",
                     events AS "events: Json<Vec<String>>", enabled"#,
        w.name,
        w.typ,
        Value::Object(w.settings),
        json!(w.events.unwrap_or_default()),
        w.enabled.unwrap_or(true),
    )
    .fetch_one(pool)
    .await
}

pub async fn update(pool: &PgPool, id: i32, w: Write) -> sqlx::Result<Option<Connection>> {
    sqlx::query_as!(
        Connection,
        r#"UPDATE notification_connections
           SET name = $2, type = $3, settings = $4, events = COALESCE($5, events),
               enabled = COALESCE($6, enabled), "updatedAt" = now()
           WHERE id = $1
           RETURNING id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, type AS typ,
                     settings AS "settings: Json<Map<String, Value>>",
                     events AS "events: Json<Vec<String>>", enabled"#,
        id,
        w.name,
        w.typ,
        Value::Object(w.settings),
        w.events.map(|e| json!(e)),
        w.enabled,
    )
    .fetch_optional(pool)
    .await
}

pub async fn delete(pool: &PgPool, id: i32) -> sqlx::Result<bool> {
    let r = sqlx::query!("DELETE FROM notification_connections WHERE id = $1", id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

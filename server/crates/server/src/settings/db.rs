use crate::http::json::iso_ms;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgExecutor, PgPool, Postgres, Transaction};
use std::collections::HashMap;

/// The saved `AppSetting` entity.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub key: String,
    pub value: Option<String>,
}

pub async fn all(pool: &PgPool) -> sqlx::Result<Vec<(String, Option<String>)>> {
    let rows = sqlx::query!(r#"SELECT "key", "value" FROM app_settings ORDER BY "key""#)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| (r.key, r.value)).collect())
}

/// The text of one setting, `None` for a missing key or a null value.
pub async fn text(db: impl PgExecutor<'_>, key: &str) -> sqlx::Result<Option<String>> {
    Ok(
        sqlx::query_scalar!(r#"SELECT value FROM app_settings WHERE key = $1"#, key)
            .fetch_optional(db)
            .await?
            .flatten(),
    )
}

/// The rows of `keys` holding a value; a missing row and a NULL are the same.
pub async fn texts(db: &PgPool, keys: &[&str]) -> sqlx::Result<HashMap<String, String>> {
    let keys: Vec<String> = keys.iter().map(|k| (*k).to_owned()).collect();
    let rows = sqlx::query!(
        r#"SELECT "key", "value" FROM app_settings WHERE "key" = ANY($1)"#,
        &keys
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| Some((r.key, r.value?)))
        .collect())
}

/// Every row whose key starts with `prefix`, by key.
pub async fn with_prefix(
    db: impl PgExecutor<'_>,
    prefix: &str,
) -> sqlx::Result<Vec<(String, Option<String>)>> {
    sqlx::query_as(
        r#"SELECT "key"::text, "value" FROM app_settings WHERE starts_with("key", $1) ORDER BY "key""#,
    )
    .bind(prefix)
    .fetch_all(db)
    .await
}

/// The base URL the server is reached on, trimmed and without a trailing slash.
pub async fn public_url(db: impl PgExecutor<'_>) -> sqlx::Result<Option<String>> {
    Ok(text(db, "public_url")
        .await?
        .map(|u| u.trim().trim_end_matches('/').to_owned())
        .filter(|u| !u.is_empty()))
}

/// A read that falls back to the default: the error is logged, never the caller's problem.
async fn lenient(db: &PgPool, key: &str) -> Option<String> {
    text(db, key)
        .await
        .inspect_err(|e| tracing::warn!("setting {key}: {e}"))
        .ok()
        .flatten()
}

/// `true` or `false` exactly, else `default`.
pub async fn flag(db: &PgPool, key: &str, default: bool) -> bool {
    parse_flag(lenient(db, key).await.as_deref(), default)
}

/// `flag` for a caller that answers a database failure instead of reading it as the default.
pub async fn try_flag(db: &PgPool, key: &str, default: bool) -> sqlx::Result<bool> {
    Ok(parse_flag(text(db, key).await?.as_deref(), default))
}

fn parse_flag(raw: Option<&str>, default: bool) -> bool {
    match raw {
        Some("true") => true,
        Some("false") => false,
        _ => default,
    }
}

/// JS `Number(value)` when finite; unset, blank or not a number is `default`.
pub async fn number(db: &PgPool, key: &str, default: f64) -> f64 {
    number_of(lenient(db, key).await.as_deref(), default)
}

/// A JSON array of strings, empty when unset or not one.
pub async fn list(db: &PgPool, key: &str) -> Vec<String> {
    lenient(db, key)
        .await
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default()
}

pub fn number_of(raw: Option<&str>, default: f64) -> f64 {
    raw.filter(|v| !v.trim().is_empty())
        .and_then(fliks_domain::media::query::js_number)
        .filter(|n| n.is_finite())
        .unwrap_or(default)
}

pub async fn get(pool: &PgPool, key: &str) -> sqlx::Result<Option<Setting>> {
    sqlx::query_as!(
        Setting,
        r#"SELECT "id", "createdAt" AS created_at, "updatedAt" AS updated_at, "key", "value"
           FROM app_settings WHERE "key" = $1"#,
        key
    )
    .fetch_optional(pool)
    .await
}

/// Upsert, so two first writes of one key cannot race on the unique constraint.
pub async fn set(
    tx: &mut Transaction<'_, Postgres>,
    key: &str,
    value: Option<&str>,
) -> sqlx::Result<Setting> {
    sqlx::query_as!(
        Setting,
        r#"INSERT INTO app_settings ("key", "value") VALUES ($1, $2)
           ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
           RETURNING "id", "createdAt" AS created_at, "updatedAt" AS updated_at, "key", "value""#,
        key,
        value
    )
    .fetch_one(&mut **tx)
    .await
}

pub async fn manifests(pool: &PgPool) -> sqlx::Result<Vec<(String, serde_json::Value)>> {
    let rows = sqlx::query!(r#"SELECT "pluginId", "manifest" FROM plugin_packages"#)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| (r.pluginId, r.manifest)).collect())
}

/// The text 4.x wrote for a non-null JSON value, passed through untyped.
// ponytail: object keys follow serde_json's sorted map, not JS insertion order; preserve_order if it matters.
pub fn pg_text(v: &serde_json::Value) -> String {
    use serde_json::Value;
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => fliks_domain::js::number_string(n),
        Value::Array(a) => {
            let item = |v: &Value| match v {
                Value::Null => "NULL".into(),
                Value::Array(_) => pg_text(v),
                v => format!(
                    "\"{}\"",
                    pg_text(v).replace('\\', "\\\\").replace('"', "\\\"")
                ),
            };
            format!("{{{}}}", a.iter().map(item).collect::<Vec<_>>().join(","))
        }
        Value::Object(_) | Value::Null => js_json(v),
    }
}

/// `JSON.stringify`.
fn js_json(v: &serde_json::Value) -> String {
    use serde_json::Value;
    let join = |items: Vec<String>| items.join(",");
    match v {
        Value::Number(n) => fliks_domain::js::number_string(n),
        Value::Array(a) => format!("[{}]", join(a.iter().map(js_json).collect())),
        Value::Object(o) => {
            let pairs = o
                .iter()
                .map(|(k, v)| format!("{}:{}", Value::from(k.as_str()), js_json(v)));
            format!("{{{}}}", join(pairs.collect()))
        }
        v => v.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    #[test]
    fn pg_text_matches_node_pg() {
        let cases = [
            (json!(1.0), "1"),
            (json!(0.1), "0.1"),
            (json!(1e21), "1e+21"),
            (json!(1.5e-7), "1.5e-7"),
            (json!(1e-6), "0.000001"),
            (json!(-0.0), "0"),
            (json!(-1e21), "-1e+21"),
            (json!(9007199254740993u64), "9007199254740992"),
            (json!(1e20), "100000000000000000000"),
            (json!(true), "true"),
            (
                json!({"a": [1.0, "x\"y", null], "b": 1}),
                r#"{"a":[1,"x\"y",null],"b":1}"#,
            ),
            (
                json!([1, "a\"b\\c", null, [true, {"k": 2}]]),
                r#"{"1","a\"b\\c",NULL,{"true","{\"k\":2}"}}"#,
            ),
        ];
        for (v, want) in cases {
            assert_eq!(super::pg_text(&v), want, "{v}");
        }
    }

    #[test]
    fn a_blank_or_unparsable_number_is_the_default() {
        use super::number_of;
        assert_eq!(number_of(Some("85"), 90.0), 85.0);
        assert_eq!(number_of(Some(""), 90.0), 90.0);
        assert_eq!(number_of(Some("  "), 90.0), 90.0);
        assert_eq!(number_of(Some("NaN"), 90.0), 90.0);
        assert_eq!(number_of(None, 90.0), 90.0);
    }
}

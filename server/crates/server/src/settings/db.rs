use crate::http::json::iso_ms;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgPool, Postgres, Transaction};

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

pub async fn list(pool: &PgPool) -> sqlx::Result<Vec<(String, Option<String>)>> {
    let rows = sqlx::query!(r#"SELECT "key", "value" FROM app_settings ORDER BY "key""#)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|r| (r.key, r.value)).collect())
}

/// The text of one setting, `None` for a missing key or a null value.
pub async fn value(pool: &PgPool, key: &str) -> sqlx::Result<Option<String>> {
    Ok(
        sqlx::query_scalar!(r#"SELECT value FROM app_settings WHERE key = $1"#, key)
            .fetch_optional(pool)
            .await?
            .flatten(),
    )
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

/// The text node-pg's `prepareValue` writes for a non-null JSON value Nest passes through untyped.
// ponytail: object keys follow serde_json's sorted map, not JS insertion order; preserve_order if it matters.
pub fn pg_text(v: &serde_json::Value) -> String {
    use serde_json::Value;
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n),
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
        Value::Number(n) => js_number(n),
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

/// JS `Number.prototype.toString`: plain decimal in [1e-6, 1e21), exponent with an explicit sign otherwise.
fn js_number(n: &serde_json::Number) -> String {
    let x = n.as_f64().unwrap_or_default();
    if x == 0.0 {
        "0".into()
    } else if (1e-6..1e21).contains(&x.abs()) {
        x.to_string()
    } else {
        format!("{x:e}").replace('e', "e+").replace("e+-", "e-")
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
}

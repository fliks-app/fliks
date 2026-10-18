//! The `app_settings` rows the engine glue owns or reads (`engine_*`, `streaming_*`).
use fliks_engine_core::api::PathMapping;
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;

pub const URL_KEY: &str = "engine_url";
pub const TOKEN_KEY: &str = "engine_token";
pub const MAPPINGS_KEY: &str = "engine_path_mappings";

/// Rows holding a value; a missing row and a NULL are the same here.
pub async fn values(db: &PgPool, keys: &[&str]) -> sqlx::Result<HashMap<String, String>> {
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

/// Saved engine URL and token (empty when unset) and the parsed path mappings.
pub async fn engine_settings(db: &PgPool) -> sqlx::Result<(String, String, Vec<PathMapping>)> {
    let mut v = values(db, &[URL_KEY, TOKEN_KEY, MAPPINGS_KEY]).await?;
    let mappings = parse_path_mappings(v.get(MAPPINGS_KEY).map(String::as_str));
    Ok((
        v.remove(URL_KEY).unwrap_or_default(),
        v.remove(TOKEN_KEY).unwrap_or_default(),
        mappings,
    ))
}

/// A write of the saved token: blank keeps, `null` clears, text sets (F5).
pub enum TokenWrite {
    Keep,
    Set(Option<String>),
}

/// The three engine keys in one transaction, `None` clearing.
pub async fn write_engine_settings(
    db: &PgPool,
    url: &str,
    token: TokenWrite,
    mappings: &[PathMapping],
) -> sqlx::Result<()> {
    let json =
        (!mappings.is_empty()).then(|| serde_json::to_string(mappings).expect("path mappings"));
    let mut rows = vec![(URL_KEY, Some(url.to_owned()))];
    if let TokenWrite::Set(t) = token {
        rows.push((TOKEN_KEY, t));
    }
    rows.push((MAPPINGS_KEY, json));
    let mut tx = db.begin().await?;
    for (key, value) in &rows {
        sqlx::query!(
            r#"INSERT INTO app_settings ("key", "value") VALUES ($1, $2)
               ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()"#,
            *key,
            value.as_deref()
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// `[{from, to}]` JSON text: entries with a non-string or blank side are dropped, anything else is `[]`.
pub fn parse_path_mappings(raw: Option<&str>) -> Vec<PathMapping> {
    let Some(Value::Array(items)) = raw
        .filter(|r| !r.trim().is_empty())
        .and_then(|r| serde_json::from_str(r).ok())
    else {
        return vec![];
    };
    let side = |m: &Value, k: &str| m.get(k)?.as_str().map(|s| s.trim().to_owned());
    sanitize(items.iter().filter_map(|m| {
        Some(PathMapping {
            from: side(m, "from")?,
            to: side(m, "to")?,
        })
    }))
}

/// Trimmed sides, blank entries dropped.
pub fn sanitize(mappings: impl IntoIterator<Item = PathMapping>) -> Vec<PathMapping> {
    mappings
        .into_iter()
        .map(|m| PathMapping {
            from: m.from.trim().to_owned(),
            to: m.to.trim().to_owned(),
        })
        .filter(|m| !m.from.is_empty() && !m.to.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(from: &str, to: &str) -> PathMapping {
        PathMapping {
            from: from.into(),
            to: to.into(),
        }
    }

    #[test]
    fn path_mappings_parse_like_the_host_did() {
        let raw = r#"[{"from":" /a ","to":"/b"},{"from":"/c"},{"from":1,"to":"x"},{"from":"","to":"y"},null]"#;
        assert_eq!(parse_path_mappings(Some(raw)), [m("/a", "/b")]);
        for bad in [None, Some(""), Some("  "), Some("{}"), Some("nope")] {
            assert!(parse_path_mappings(bad).is_empty());
        }
        assert_eq!(sanitize([m(" a", "b "), m("", "c")]), [m("a", "b")]);
    }
}

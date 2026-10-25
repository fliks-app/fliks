//! Which settings keys are secret, and the one redact/merge pair GET and PUT share.
use super::db;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::HashSet;

/// Secret keys held in `plugin_packages.manifest` form fields; the static ones need no lookup.
#[derive(Default)]
pub struct Secrets(HashSet<String>);

/// What a PUT does with one secret-aware key.
#[derive(Debug, PartialEq)]
pub enum Write {
    Keep,
    Set(Option<String>),
}

/// The incoming value as sent: absent, explicit `null`, or text.
pub enum Incoming {
    Absent,
    Null,
    Text(String),
}

impl Secrets {
    /// Reads manifests only when a key is a plugin key.
    pub async fn load<'a>(
        pool: &PgPool,
        keys: impl IntoIterator<Item = &'a str>,
    ) -> sqlx::Result<Self> {
        if !keys.into_iter().any(|k| k.starts_with("plugin.")) {
            return Ok(Self::default());
        }
        let manifests = db::manifests(pool).await?;
        Ok(Self(
            manifests
                .iter()
                .flat_map(|(id, m)| plugin_secret_keys(id, m))
                .collect(),
        ))
    }

    pub fn is_secret(&self, key: &str) -> bool {
        key == "engine_token"
            || key == "seerr_api_key"
            || key == "radarr_api_key"
            || key == "sonarr_api_key"
            || (key.starts_with("subtitle_translation_") && key.ends_with("_api_key"))
            || self.0.contains(key)
    }

    /// Flat object without secret keys plus `secretsSet` (full keys holding a value), absent when none.
    pub fn redact_all(&self, rows: Vec<(String, Option<String>)>) -> Value {
        let mut out = Map::new();
        let mut set = Vec::new();
        for (key, value) in rows {
            if !self.is_secret(&key) {
                out.insert(key, value.into());
            } else if value.is_some_and(|v| !v.is_empty()) {
                set.push(key);
            }
        }
        if !set.is_empty() {
            out.insert("secretsSet".into(), set.into());
        }
        Value::Object(out)
    }

    pub fn redact_one(&self, key: &str, value: Option<&str>) -> Value {
        if self.is_secret(key) {
            json!({"key": key, "value": null, "secretSet": value.is_some_and(|v| !v.is_empty())})
        } else {
            json!({"key": key, "value": value})
        }
    }

    /// Secret: blank or absent keeps the stored value, `null` clears. Plain: absent and `null` clear.
    pub fn merge(&self, key: &str, incoming: Incoming) -> Write {
        match (incoming, self.is_secret(key)) {
            (Incoming::Text(v), true) if v.is_empty() => Write::Keep,
            (Incoming::Absent, true) => Write::Keep,
            (Incoming::Text(v), _) => Write::Set(Some(v)),
            _ => Write::Set(None),
        }
    }
}

/// `plugin.<id>.<field>` for every `secret: true` field of the manifest's form pages (groups included).
pub fn plugin_secret_keys(id: &str, manifest: &Value) -> Vec<String> {
    let pages = manifest
        .pointer("/ui/configPages")
        .and_then(Value::as_array);
    let is_form = |p: &&Value| p.get("kind").is_none_or(|k| k == "form");
    let items = pages.into_iter().flatten().filter(is_form).flat_map(|p| {
        p.get("fields")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
    });
    let fields = items.flat_map(|item| match item.get("kind").and_then(Value::as_str) {
        Some("group") => item
            .get("fields")
            .and_then(Value::as_array)
            .map_or(vec![], |f| f.iter().collect()),
        Some("caption" | "status") => vec![],
        _ => vec![item],
    });
    fields
        .filter(|f| f.get("secret") == Some(&Value::Bool(true)))
        .filter_map(|f| f.get("key").and_then(Value::as_str))
        .map(|k| format!("plugin.{id}.{k}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secrets() -> Secrets {
        let m = json!({"ui": {"configPages": [
            {"id": "a", "fields": [
                {"key": "token", "secret": true}, {"key": "name"},
                {"kind": "group", "fields": [{"key": "deep", "secret": true}]},
                {"kind": "caption", "key": "token2", "secret": true}]},
            {"id": "b", "kind": "table", "fields": [{"key": "nope", "secret": true}]}]}});
        Secrets(plugin_secret_keys("p", &m).into_iter().collect())
    }

    #[test]
    fn plugin_manifest_rule() {
        let s = secrets();
        assert!(s.is_secret("plugin.p.token") && s.is_secret("plugin.p.deep"));
        assert!(!s.is_secret("plugin.p.name") && !s.is_secret("plugin.p.token2"));
        assert!(!s.is_secret("plugin.p.nope") && !s.is_secret("plugin.q.token"));
        assert!(s.is_secret("subtitle_translation_gemini_api_key"));
        assert!(!s.is_secret("subtitle_translation_gemini_model"));
    }

    #[test]
    fn redact_and_merge() {
        let s = secrets();
        let rows = vec![
            ("engine_token".into(), Some("t".into())),
            ("seerr_api_key".into(), Some("".into())),
            ("a".into(), None),
        ];
        assert_eq!(
            s.redact_all(rows),
            json!({"a": null, "secretsSet": ["engine_token"]})
        );
        assert_eq!(s.redact_all(vec![("a".into(), None)]), json!({"a": null}));
        assert_eq!(
            s.redact_one("engine_token", Some("t")),
            json!({"key": "engine_token", "value": null, "secretSet": true})
        );
        assert_eq!(s.merge("engine_token", Incoming::Absent), Write::Keep);
        assert_eq!(
            s.merge("engine_token", Incoming::Text(String::new())),
            Write::Keep
        );
        assert_eq!(s.merge("engine_token", Incoming::Null), Write::Set(None));
        assert_eq!(s.merge("x", Incoming::Absent), Write::Set(None));
        assert_eq!(
            s.merge("x", Incoming::Text(String::new())),
            Write::Set(Some(String::new()))
        );
    }
}

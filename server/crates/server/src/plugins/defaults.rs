//! Fliks defaults a plugin reads (`provider-plugins.md` rules 34-39). No route serves a value.
use fliks_domain::external_id::ExternalProvider;
use serde_json::Value;

type Table = [(ExternalProvider, &'static str, Option<&'static str>)];

/// Empty in a local build.
pub const DEFAULTS: &Table = &[
    (
        ExternalProvider::Tmdb,
        "apiKey",
        option_env!("FLIKS_DEFAULT_TMDB_API_KEY"),
    ),
    (
        ExternalProvider::Tvdb,
        "apiKey",
        option_env!("FLIKS_DEFAULT_TVDB_API_KEY"),
    ),
];

/// Every form field of the config pages, groups flattened.
fn fields(manifest: &Value) -> impl Iterator<Item = &Value> {
    manifest["ui"]["configPages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|p| p["fields"].as_array().into_iter().flatten())
        .flat_map(|i| match i["kind"].as_str() {
            Some("group") => i["fields"].as_array().map(|f| f.iter().collect()),
            _ => Some(vec![i]),
        })
        .flatten()
}

/// Rule 36: the entry named by a `fliks:<name>` field, for an official plugin of its namespace.
fn lookup<'a>(
    table: &'a Table,
    manifest: &Value,
    official: bool,
    field: &Value,
) -> Option<&'a str> {
    let name = field["default"].as_str()?.strip_prefix("fliks:")?;
    if field["secret"] != true {
        return None;
    }
    let first = manifest["provider"]["namespaces"][0]["name"].as_str()?;
    if !official {
        return None;
    }
    table
        .iter()
        .find(|(p, n, _)| p.as_str() == first && *n == name)
        .and_then(|(_, _, v)| *v)
        .filter(|v| !v.is_empty())
}

fn resolved(table: &Table, manifest: &Value, official: bool) -> Vec<(String, String)> {
    fields(manifest)
        .filter_map(|f| {
            let v = lookup(table, manifest, official, f)?;
            Some((f["key"].as_str()?.to_owned(), v.to_owned()))
        })
        .collect()
}

/// The (field key, value) defaults of a plugin.
pub fn for_plugin(manifest: &Value, official: bool) -> Vec<(String, String)> {
    resolved(DEFAULTS, manifest, official)
}

/// Rule 36: warn for each `fliks:` field that resolves to nothing.
pub fn warn_unresolved(plugin_id: &str, manifest: &Value, official: bool) {
    for f in fields(manifest) {
        let unresolved = f["default"]
            .as_str()
            .is_some_and(|d| d.starts_with("fliks:"))
            && lookup(DEFAULTS, manifest, official, f).is_none();
        if unresolved {
            tracing::warn!(
                "plugin \"{plugin_id}\": field \"{}\" has no Fliks default",
                f["key"].as_str().unwrap_or_default()
            );
        }
    }
}

/// Rule 35: a stored non-empty value wins, the default fills the rest.
pub fn overlay(config: &mut Vec<(String, String)>, defaults: &[(String, String)]) {
    for (k, v) in defaults {
        match config.iter_mut().find(|(ck, _)| ck == k) {
            Some((_, cv)) if cv.is_empty() => *cv = v.clone(),
            Some(_) => {}
            None => config.push((k.clone(), v.clone())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T: &Table = &[(ExternalProvider::Tmdb, "apiKey", Some("k-tmdb"))];

    fn manifest(ns: &str) -> Value {
        json!({
            "provider": {"namespaces": [{"name": ns}]},
            "ui": {"configPages": [{"id": "p", "fields": [
                {"kind": "group", "fields": [{"key": "apiKey", "secret": true, "default": "fliks:apiKey"}]},
                {"key": "other", "secret": true, "default": "fliks:other"},
                {"key": "plain", "default": "fliks:apiKey"}
            ]}]}
        })
    }

    #[test]
    fn only_an_official_plugin_of_the_namespace_resolves() {
        let want = vec![("apiKey".to_owned(), "k-tmdb".to_owned())];
        assert_eq!(resolved(T, &manifest("tmdb"), true), want);
        assert!(resolved(T, &manifest("tmdb"), false).is_empty());
        assert!(resolved(T, &manifest("tvdb"), true).is_empty());
        assert!(resolved(T, &manifest("org.example.x:id"), true).is_empty());
    }

    #[test]
    fn a_third_party_plugin_reads_no_default() {
        let mut m = manifest("org.example.x:id");
        m["provider"]["namespaces"] = json!([{"name": "tmdb"}]);
        assert!(resolved(T, &m, false).is_empty());
    }

    #[test]
    fn a_stored_value_wins_and_an_empty_one_yields() {
        let d = vec![("apiKey".to_owned(), "dflt".to_owned())];
        let mut c = vec![("apiKey".to_owned(), "mine".to_owned())];
        overlay(&mut c, &d);
        assert_eq!(c[0].1, "mine");
        let mut c = vec![("apiKey".to_owned(), String::new())];
        overlay(&mut c, &d);
        assert_eq!(c[0].1, "dflt");
        let mut c = vec![];
        overlay(&mut c, &d);
        assert_eq!(c, d);
    }

    #[test]
    fn a_local_build_has_no_default() {
        assert!(
            resolved(
                &[(ExternalProvider::Tmdb, "apiKey", None)],
                &manifest("tmdb"),
                true
            )
            .is_empty()
        );
    }
}

//! The `provider` manifest block and plugin id namespaces (`docs/spec/provider-plugins.md`).
use regex::{Regex, RegexBuilder};
use serde_json::{Map, Value};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// The component export of a provider.
pub const EXPORT: &str = "fliks:plugin/metadata-provider@3.0.0";
/// The kinds of work a provider may serve (the documented set of the WIT `kind`).
pub const KINDS: [&str; 5] = ["movie", "series", "book", "comic", "album"];
/// The capabilities a kind lists, one per `metadata-provider` function family.
pub const CAPABILITIES: [&str; 10] = [
    "search",
    "work",
    "children",
    "childStubs",
    "edition",
    "chapters",
    "person",
    "credits",
    "findBy",
    "lists",
];
/// The resources `snapshotTtlSecs` may name.
pub const RESOURCES: [&str; 5] = ["work", "children", "edition", "person", "chapters"];

/// The longest `snapshotTtlSecs` value: ten years.
const MAX_TTL_SECS: u64 = 315_360_000;

const BLOCK_KEYS: [&str; 10] = [
    "namespaces",
    "kinds",
    "findBy",
    "editionNamespaces",
    "chapterNamespaces",
    "limits",
    "requestTimeoutMs",
    "snapshotTtlSecs",
    "imageHosts",
    "requires",
];

/// Where a namespace name belongs: the core's bare names or a plugin's `<pluginId>:<name>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class<'a> {
    Core(&'a str),
    Plugin { plugin_id: &'a str, name: &'a str },
}

/// `^[a-z][a-z0-9]{1,31}$` (core) or `<plugin id>:^[a-z][a-z0-9-]{0,31}$`; anything else is no namespace.
pub fn classify(name: &str) -> Option<Class<'_>> {
    match name.split_once(':') {
        None => {
            let ok = (2..=32).contains(&name.len())
                && name.as_bytes()[0].is_ascii_lowercase()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
            ok.then_some(Class::Core(name))
        }
        Some((plugin_id, local)) => {
            let ok = (1..=32).contains(&local.len())
                && local.as_bytes()[0].is_ascii_lowercase()
                && local
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                && super::legal_plugin_id(plugin_id);
            ok.then_some(Class::Plugin {
                plugin_id,
                name: local,
            })
        }
    }
}

fn is_uint(v: &Value, min: u64, max: u64) -> bool {
    v.as_u64().is_some_and(|n| (min..=max).contains(&n))
}

fn unique_strings(v: &Value, ok: impl Fn(&str) -> bool) -> Option<Vec<&str>> {
    let items: Vec<&str> = v
        .as_array()?
        .iter()
        .map(|s| s.as_str().filter(|s| ok(s)))
        .collect::<Option<_>>()?;
    let mut seen = items.clone();
    seen.sort_unstable();
    seen.dedup();
    (seen.len() == items.len()).then_some(items)
}

fn closed(o: &Map<String, Value>, keys: &[&str]) -> bool {
    o.keys().all(|k| keys.contains(&k.as_str()))
}

fn host_name(h: &str) -> bool {
    h.len() <= 253
        && h.contains('.')
        && h.split('.').all(|l| {
            (1..=63).contains(&l.len())
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn config_key(k: &str) -> bool {
    (1..=64).contains(&k.len())
        && k.as_bytes()[0].is_ascii_alphabetic()
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn namespace_entry(v: &Value) -> Option<&str> {
    let o = v.as_object()?;
    if !closed(o, &["name", "label", "idPattern", "case"]) {
        return None;
    }
    let name = o.get("name")?.as_str()?;
    match classify(name)? {
        Class::Core(_) => (o.len() == 1).then_some(name),
        Class::Plugin { .. } => {
            let label = o.get("label")?.as_str()?;
            let case_ok = o
                .get("case")
                .is_none_or(|c| matches!(c.as_str(), Some("preserve" | "lower" | "upper")));
            ((1..=64).contains(&label.chars().count())
                && o.get("idPattern").is_some_and(Value::is_string)
                && case_ok)
                .then_some(name)
        }
    }
}

fn limits_shaped(v: &Value) -> bool {
    v.as_object().is_some_and(|o| {
        closed(o, &["ratePerSec", "burst", "dailyQuota", "backgroundShare"])
            && o.get("ratePerSec")
                .and_then(Value::as_f64)
                .is_some_and(|r| r > 0.0 && r <= 1000.0)
            && o.get("burst").is_some_and(|b| is_uint(b, 1, 1000))
            && o.get("dailyQuota")
                .is_none_or(|q| q.is_null() || is_uint(q, 1, u32::MAX.into()))
            && o.get("backgroundShare")
                .is_none_or(|s| s.as_f64().is_some_and(|s| s > 0.0 && s <= 1.0))
    })
}

/// The shape of a manifest's `provider` block; `Err` is the log detail of `PLUGIN_BAD_MANIFEST`.
pub fn validate_block(b: &Value) -> Result<(), &'static str> {
    let o = b.as_object().ok_or("provider must be an object")?;
    if !closed(o, &BLOCK_KEYS) {
        return Err("provider has an unknown key");
    }
    let mut names = o
        .get("namespaces")
        .and_then(Value::as_array)
        .filter(|a| (1..=8).contains(&a.len()))
        .and_then(|a| a.iter().map(namespace_entry).collect::<Option<Vec<_>>>())
        .ok_or("provider.namespaces must hold 1 to 8 well-formed entries")?;
    let declared = names.len();
    names.sort_unstable();
    names.dedup();
    if names.len() != declared {
        return Err("provider.namespaces repeats a name");
    }
    let kinds_ok = o.get("kinds").and_then(Value::as_object).is_some_and(|k| {
        !k.is_empty()
            && k.iter().all(|(kind, caps)| {
                KINDS.contains(&kind.as_str())
                    && unique_strings(caps, |c| CAPABILITIES.contains(&c))
                        .is_some_and(|c| !c.is_empty())
            })
    });
    if !kinds_ok {
        return Err("provider.kinds must map documented kinds to non-empty capability sets");
    }
    for key in ["findBy", "editionNamespaces", "chapterNamespaces"] {
        if let Some(v) = o.get(key)
            && unique_strings(v, |n| classify(n).is_some()).is_none()
        {
            return Err(
                "provider.findBy, editionNamespaces and chapterNamespaces must list namespace names",
            );
        }
    }
    if !o.get("limits").is_some_and(limits_shaped) {
        return Err("provider.limits needs ratePerSec and burst within bounds");
    }
    if o.get("requestTimeoutMs")
        .is_some_and(|t| !is_uint(t, 1000, 60_000))
    {
        return Err("provider.requestTimeoutMs must be 1000 to 60000");
    }
    if let Some(t) = o.get("snapshotTtlSecs")
        && !t.as_object().is_some_and(|t| {
            closed(t, &RESOURCES)
                && t.values()
                    .all(|v| v.is_null() || is_uint(v, 0, MAX_TTL_SECS))
        })
    {
        return Err("provider.snapshotTtlSecs must map resources to seconds or null");
    }
    if let Some(h) = o.get("imageHosts")
        && !unique_strings(h, host_name).is_some_and(|h| h.len() <= 16)
    {
        return Err("provider.imageHosts must list at most 16 lowercase host names");
    }
    if let Some(r) = o.get("requires")
        && unique_strings(r, config_key).is_none()
    {
        return Err("provider.requires must list config keys");
    }
    Ok(())
}

/// A plugin namespace's `idPattern`, compiled once per namespace: a full match, in linear time.
pub struct IdRule {
    re: Regex,
    case: Case,
}

#[derive(Clone, Copy)]
enum Case {
    Preserve,
    Lower,
    Upper,
}

static FORMAT_CHAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Cf}").expect("static"));

impl IdRule {
    /// `None` unless `pattern` is at most 256 characters, anchored (`^` first, an unescaped `$`
    /// last) and compiles within the size limits.
    pub fn new(pattern: &str, case: &str) -> Option<Self> {
        let escapes = pattern
            .bytes()
            .rev()
            .skip(1)
            .take_while(|&b| b == b'\\')
            .count();
        let anchored = pattern.starts_with('^') && pattern.ends_with('$') && escapes % 2 == 0;
        if pattern.chars().count() > 256 || !anchored {
            return None;
        }
        let re = RegexBuilder::new(&format!("^(?:{pattern})$"))
            .size_limit(1 << 20)
            .dfa_size_limit(1 << 20)
            .nest_limit(32)
            .build()
            .ok()?;
        let case = match case {
            "lower" => Case::Lower,
            "upper" => Case::Upper,
            _ => Case::Preserve,
        };
        Some(Self { re, case })
    }

    /// A plugin id as the core stores it: trimmed, NFC, cased by `case`, 1 to 128 characters
    /// without a control, format or whitespace character or a `:`, and a full match of the pattern.
    pub fn normalize(&self, value: &str) -> Option<String> {
        let v: String = value.trim().nfc().collect();
        let v = match self.case {
            Case::Lower => v.to_lowercase(),
            Case::Upper => v.to_uppercase(),
            Case::Preserve => v,
        };
        let ok = (1..=128).contains(&v.chars().count())
            && !v
                .chars()
                .any(|c| c.is_control() || c.is_whitespace() || c == ':')
            && !FORMAT_CHAR.is_match(&v)
            && self.re.is_match(&v);
        ok.then_some(v)
    }
}

/// Registration checks of the declared namespaces, in manifest order: the reason of the first
/// failure. `is_core` tells whether a bare name is a core namespace, `official` whether the
/// package is signed by a compiled-in key.
pub fn check_namespaces(
    plugin_id: &str,
    block: &Value,
    official: bool,
    is_core: impl Fn(&str) -> bool,
) -> Result<(), &'static str> {
    for ns in block["namespaces"].as_array().into_iter().flatten() {
        let name = ns["name"].as_str().unwrap_or_default();
        match classify(name) {
            Some(Class::Core(n)) if !is_core(n) => return Err("unknown-provider-namespace"),
            Some(Class::Core(_)) if !official => return Err("core-namespace-not-official"),
            Some(Class::Core(_)) => {}
            Some(Class::Plugin { plugin_id: p, .. }) => {
                if p != plugin_id {
                    return Err("namespace-not-owned");
                }
                if IdRule::new(ns["idPattern"].as_str().unwrap_or_default(), "preserve").is_none() {
                    return Err("invalid-namespace-pattern");
                }
            }
            None => return Err("unknown-provider-namespace"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classes() {
        assert_eq!(classify("tmdb"), Some(Class::Core("tmdb")));
        assert_eq!(
            classify("org.example.anime:aid"),
            Some(Class::Plugin {
                plugin_id: "org.example.anime",
                name: "aid"
            })
        );
        for bad in ["t", "Tmdb", "tm-db", "a:b:c", ":aid", "x:Aid", "ui.x:"] {
            assert_eq!(classify(bad), None, "{bad}");
        }
    }

    #[test]
    fn ids_follow_their_pattern() {
        let id = |p: &str, case: &str, v: &str| IdRule::new(p, case).and_then(|r| r.normalize(v));
        let num = "^[1-9][0-9]{0,8}$";
        assert_eq!(id(num, "preserve", " 42 "), Some("42".into()));
        assert_eq!(id(num, "preserve", "042"), None);
        assert_eq!(id("^[a-z]+$", "lower", "AbC"), Some("abc".into()));
        assert_eq!(id("^.+$", "preserve", "a:b"), None);
        assert!(IdRule::new("[a-z]+", "preserve").is_none());
        assert!(IdRule::new(r"^a\$", "preserve").is_none());
        assert!(IdRule::new(r"^a\\$", "preserve").is_some());
        let nested = IdRule::new("^(a+)+$", "preserve").unwrap();
        assert_eq!(nested.normalize(&format!("{}!", "a".repeat(100))), None);
    }

    #[test]
    fn a_plugin_owns_only_its_prefix() {
        let b = json!({"namespaces": [{"name": "a.b:x", "label": "X", "idPattern": "^.+$"}]});
        assert_eq!(check_namespaces("a.b", &b, false, |_| false), Ok(()));
        assert_eq!(
            check_namespaces("a.c", &b, false, |_| false),
            Err("namespace-not-owned")
        );
    }
}

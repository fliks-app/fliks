//! The `provider` manifest block and plugin id namespaces (`docs/spec/provider-plugins.md`).
use crate::{
    external_id::{ExternalProvider, Namespace, Namespaces},
    metadata::field::Field,
};
use regex::{Regex, RegexBuilder};
use serde_json::{Map, Value};
use std::sync::LazyLock;
use unicode_normalization::UnicodeNormalization;

/// The component export of a provider.
pub const EXPORT: &str = "fliks:plugin/metadata-provider@3.0.0";
/// The kinds of work a provider may serve (the documented set of the WIT `kind`).
pub const KINDS: [&str; 5] = ["movie", "series", "book", "comic", "album"];
/// The capabilities a kind lists, one per `metadata-provider` function family.
pub const CAPABILITIES: [&str; 11] = [
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
    "scene",
];
/// The resources `snapshotTtlSecs` may name.
pub const RESOURCES: [&str; 6] = [
    "work", "children", "edition", "person", "chapters", "credits",
];

/// The longest `snapshotTtlSecs` value: ten years.
const MAX_TTL_SECS: u64 = 315_360_000;

const BLOCK_KEYS: [&str; 11] = [
    "namespaces",
    "kinds",
    "findBy",
    "sceneNamespaces",
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

/// The longest name a plugin namespace has after its `<plugin id>:`.
pub const MAX_NAMESPACE_NAME: usize = 32;

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
            let ok = (1..=MAX_NAMESPACE_NAME).contains(&local.len())
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
        && !h
            .rsplit('.')
            .next()
            .is_some_and(|t| t.bytes().all(|b| b.is_ascii_digit()))
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
        closed(
            o,
            &[
                "ratePerSec",
                "burst",
                "dailyQuota",
                "backgroundShare",
                "maxPauseSecs",
            ],
        ) && o
            .get("ratePerSec")
            .and_then(Value::as_f64)
            .is_some_and(|r| r > 0.0 && r <= 1000.0)
            && o.get("burst").is_some_and(|b| is_uint(b, 1, 1000))
            && o.get("dailyQuota")
                .is_none_or(|q| q.is_null() || is_uint(q, 1, u32::MAX.into()))
            && o.get("backgroundShare")
                .is_none_or(|s| s.as_f64().is_some_and(|s| s > 0.0 && s <= 1.0))
            && o.get("maxPauseSecs")
                .is_none_or(|m| is_uint(m, 300, 86_400))
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
    // `person-credits` takes no kind: a music provider is told by `credits` under `album`, so no other kind may declare it.
    if let Some(k) = o.get("kinds").and_then(Value::as_object) {
        let credits = |caps: &Value| {
            caps.as_array()
                .is_some_and(|c| c.iter().any(|c| c == "credits"))
        };
        if k.get("album").is_some_and(credits)
            && k.iter()
                .any(|(kind, caps)| kind != "album" && credits(caps))
        {
            return Err(
                "provider.kinds: credits under album cannot go with credits under another kind",
            );
        }
    }
    let scene = o.get("kinds").and_then(Value::as_object).is_some_and(|k| {
        k.values()
            .filter_map(Value::as_array)
            .flatten()
            .any(|c| c == "scene")
    });
    match (scene, o.get("sceneNamespaces")) {
        (true, Some(n))
            if unique_strings(n, |n| matches!(classify(n), Some(Class::Core(_))))
                .is_some_and(|n| !n.is_empty()) => {}
        (false, None) => {}
        _ => {
            return Err(
                "provider.sceneNamespaces must list core namespaces, and go with the scene capability",
            );
        }
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

/// Rule 14: at most this many namespaces under a record's `ids`, and values under one of them.
pub const MAX_IDS_NAMESPACES: usize = 32;
pub const MAX_IDS_PER_NAMESPACE: usize = 16;

/// The arrays of a record whose elements are records too.
const NESTED: [&str; 4] = ["cast", "crew", "seasons", "episodes"];

/// Rules 14, 26 and 28 on a record and its nested records: `ids` keeps the namespaces the provider
/// may write, normalised; a third-party one writes no core id (`tmdbId`, `tvdbId`, `imdbId`, collection keys).
pub fn sanitize_ids(
    rec: &mut Map<String, Value>,
    official: bool,
    own: &[&str],
    known: &Namespaces,
) -> usize {
    let mut dropped = 0;
    if !official {
        let core = Field::Ids
            .keys()
            .iter()
            .chain(Field::Collection.keys())
            .copied();
        dropped += core.filter(|k| rec.remove(*k).is_some()).count();
    }
    for key in NESTED {
        if let Some(Value::Array(items)) = rec.get_mut(key) {
            for item in items.iter_mut().filter_map(Value::as_object_mut) {
                dropped += sanitize_ids(item, official, own, known);
            }
        }
    }
    let Some(ids) = rec.remove("ids") else {
        return dropped;
    };
    let Value::Object(ids) = ids else {
        return dropped + 1;
    };
    dropped += ids.len().saturating_sub(MAX_IDS_NAMESPACES);
    let mut kept = Map::new();
    for (name, v) in ids.into_iter().take(MAX_IDS_NAMESPACES) {
        let ns = known
            .parse(&name)
            .filter(|n| official || own.contains(&n.as_str()));
        let Some(ns) = ns else {
            dropped += 1;
            continue;
        };
        let raw: Vec<&Value> = match &v {
            Value::Array(a) => a.iter().take(MAX_IDS_PER_NAMESPACE).collect(),
            one => vec![one],
        };
        let ok: Vec<Value> = raw
            .into_iter()
            .filter_map(|x| known.normalize(ns, x.as_str()?).map(Value::String))
            .collect();
        dropped += usize::from(ok.is_empty());
        if !ok.is_empty() {
            kept.insert(
                name,
                if v.is_array() {
                    Value::Array(ok)
                } else {
                    ok[0].clone()
                },
            );
        }
    }
    rec.insert("ids".into(), Value::Object(kept));
    dropped
}

/// An id a provider answers (`find-by`) in `ns`, as stored: OpenLibrary keys may be paths and
/// are works only; Audible and Audnexus answer ASINs.
pub fn answered_id(known: &Namespaces, ns: Namespace, value: &str) -> Option<String> {
    match ns {
        Namespace::OPENLIBRARY => ExternalProvider::OpenLibrary
            .normalize(value.trim().rsplit('/').next()?)
            .filter(|v| v.ends_with('W')),
        Namespace::AUDIBLE | Namespace::AUDNEXUS => ExternalProvider::Asin.normalize(value),
        _ => known.normalize(ns, value),
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
    fn a_numeric_last_label_is_not_a_host_name() {
        assert!(host_name("covers.example.org") && host_name("a1.b2-c.io"));
        assert!(!host_name("0.1") && !host_name("cdn.example.123") && !host_name("localhost"));
    }

    #[test]
    fn ids_of_a_third_party_record_keep_only_its_own_and_non_unique_namespaces() {
        let mut known = Namespaces::default();
        known.declare("org.ids.t:aid", "T", "^[1-9][0-9]*$", "preserve");
        let rec = |v: Value| v.as_object().unwrap().clone();
        let input = json!({"tmdbId": 5, "title": "t", "tmdbCollectionId": 9, "tmdbCollectionName": "c",
            "tvdbId": 3, "imdbId": "tt2",
            "cast": [{"externalId": 1, "tmdbId": 2, "imdbId": "nm1", "ids": {"tmdb": "1", "imdb": "nm1"}}], "ids": {
            "tmdb": "603", "imdb": "tt1", "org.ids.t:aid": ["7", "x"], "org.ids.t:nope": "1",
            "tvdb": "012", "openlibrary": "OL1W"}});
        let mut third = rec(input.clone());
        assert_eq!(
            sanitize_ids(&mut third, false, &["org.ids.t:aid"], &known),
            14
        );
        assert_eq!(third["ids"], json!({"org.ids.t:aid": ["7"]}));
        assert!(!third.contains_key("tmdbId") && third.contains_key("title"));
        assert!(
            !third.contains_key("tmdbCollectionId") && !third.contains_key("tmdbCollectionName")
        );
        assert_eq!(third["cast"], json!([{"externalId": 1, "ids": {}}]));
        let mut official = rec(input);
        sanitize_ids(&mut official, true, &[], &known);
        assert_eq!(official["ids"]["tmdb"], "603");
        assert!(official.contains_key("tmdbId") && official.contains_key("tmdbCollectionId"));
        let many: Map<String, Value> = (0..40).map(|i| (format!("n{i:02}"), json!("1"))).collect();
        let mut over = rec(json!({"ids": many}));
        assert_eq!(sanitize_ids(&mut over, false, &[], &known), 40);
        let mut bad = rec(json!({"ids": ["x"]}));
        assert_eq!(sanitize_ids(&mut bad, false, &[], &known), 1);
        assert!(!bad.contains_key("ids"));
    }

    #[test]
    fn answered_ids_are_normalised_by_their_namespace() {
        let known = Namespaces::default();
        let ol = |v| answered_id(&known, Namespace::OPENLIBRARY, v);
        assert_eq!(ol("OL45883W").as_deref(), Some("OL45883W"));
        assert_eq!(ol(" /works/OL45883W ").as_deref(), Some("OL45883W"));
        assert_eq!(ol("ol45883w"), None);
        assert_eq!(ol("OL1M"), None, "a work only");
        for ns in [Namespace::AUDIBLE, Namespace::AUDNEXUS] {
            assert_eq!(
                answered_id(&known, ns, "B002V0QK4C").as_deref(),
                Some("B002V0QK4C")
            );
            assert_eq!(answered_id(&known, ns, "b002v0qk4c"), None);
        }
        assert_eq!(
            answered_id(&known, Namespace::TMDB, "603").as_deref(),
            Some("603")
        );
    }

    #[test]
    fn credits_under_album_exclude_credits_under_another_kind() {
        let block = |kinds: Value| {
            json!({"namespaces": [{"name": "musicbrainz"}], "kinds": kinds,
                   "limits": {"ratePerSec": 1, "burst": 1}})
        };
        assert_eq!(
            validate_block(&block(json!({"album": ["search", "credits"]}))),
            Ok(())
        );
        assert_eq!(
            validate_block(&block(json!({"album": ["credits"], "movie": ["search"]}))),
            Ok(())
        );
        assert!(
            validate_block(&block(json!({"album": ["credits"], "movie": ["credits"]}))).is_err()
        );
        assert_eq!(
            validate_block(&block(json!({"movie": ["credits"], "series": ["credits"]}))),
            Ok(())
        );
    }

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

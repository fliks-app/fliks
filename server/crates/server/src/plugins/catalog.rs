//! The signed catalog document (`plugins.md` rules 21, 27): parse, filter, denylist.
use super::manifest::{SUPPORTED_PLUGIN_API_VERSIONS, range_version};
use nodejs_semver::{Range, Version};
use serde_json::{Map, Value, json};

fn deny_entry(v: &Value) -> bool {
    v.is_object()
        && v["pluginId"].as_str().is_some_and(|s| !s.is_empty())
        && (v.get("version").is_none() || v["version"].is_string())
        && (v.get("sha256").is_none() || v["sha256"].is_string())
        && v["reason"].as_str().is_some_and(|s| !s.is_empty())
}

fn version_entry(v: &Value) -> bool {
    v.is_object()
        && v["version"].as_str().is_some_and(|s| !s.is_empty())
        && v["pluginApi"].is_number()
        && v["fliks"].as_str().is_some_and(|r| Range::parse(r).is_ok())
}

fn plugin_entry(v: &Value) -> bool {
    v.is_object()
        && v["id"].as_str().is_some_and(|s| !s.is_empty())
        && v["name"].is_string()
        && v["description"].is_string()
        && v["author"].is_string()
        && (v["kind"] == "data" || v["kind"] == "process")
        && (v.get("logo").is_none() || v["logo"].is_string())
        && v["versions"]
            .as_array()
            .is_some_and(|a| !a.is_empty() && a.iter().all(version_entry))
}

/// `None` when the (already verified) bytes are not a catalog; a garbled deny entry is dropped.
pub fn parse(bytes: &[u8]) -> Option<Value> {
    let j: Value = serde_json::from_str(&String::from_utf8_lossy(bytes)).ok()?;
    let plugins = j["plugins"].as_array()?;
    if !j.is_object() || !plugins.iter().all(plugin_entry) {
        return None;
    }
    let mut doc = json!({ "plugins": plugins });
    if let Some(d) = j["denyList"].as_array() {
        doc["denyList"] = Value::Array(d.iter().filter(|e| deny_entry(e)).cloned().collect());
    }
    Some(doc)
}

fn satisfies(range: &str, running: &str) -> bool {
    match (Range::parse(range), Version::parse(range_version(running))) {
        (Ok(r), Ok(v)) => r.satisfies(&v),
        _ => false,
    }
}

fn verifiable(v: &Value) -> bool {
    let sha = v["sha256"].as_str().unwrap_or_default();
    v["zipUrl"].as_str().is_some_and(|u| !u.is_empty())
        && sha.len() == 64
        && sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && sha != "0".repeat(64)
}

fn installable(v: &Value, running: &str, skip_range: bool) -> bool {
    v["pluginApi"].as_f64().is_some_and(|a| {
        SUPPORTED_PLUGIN_API_VERSIONS
            .iter()
            .any(|s| f64::from(*s) == a)
    }) && (skip_range || satisfies(v["fliks"].as_str().unwrap_or_default(), running))
        && verifiable(v)
}

fn hidden(hidden: &[&Value], running: &str) -> Value {
    if hidden.is_empty() {
        return Value::Null;
    }
    let current = Version::parse(running.trim()).ok();
    let lowest = hidden
        .iter()
        .filter(|v| !satisfies(v["fliks"].as_str().unwrap_or_default(), running))
        .filter_map(|v| Range::parse(v["fliks"].as_str()?).ok()?.min_version())
        .filter(|m| current.as_ref().is_some_and(|c| m > c))
        .min();
    json!({ "count": hidden.len(), "minFliksVersion": lowest.map(|v| v.to_string()) })
}

/// What the cache stores (without `signedByKeyId`): installable oldest to newest, the rest summarised.
pub fn filter(doc: &Value, running: &str, skip_range: bool) -> Value {
    let plugins: Vec<Value> = doc["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            let all: Vec<&Value> = p["versions"].as_array().into_iter().flatten().collect();
            let (mut ok, no): (Vec<&Value>, Vec<&Value>) = all
                .iter()
                .partition(|v| installable(v, running, skip_range));
            ok.sort_by(|a, b| {
                let (x, y) = (
                    Version::parse(a["version"].as_str().unwrap_or("")),
                    Version::parse(b["version"].as_str().unwrap_or("")),
                );
                match (x, y) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    _ => std::cmp::Ordering::Equal,
                }
            });
            let mut e = Map::new();
            for k in ["id", "name", "description", "author", "kind"] {
                e.insert(k.into(), p[k].clone());
            }
            if let Some(l) = p.get("logo") {
                e.insert("logo".into(), l.clone());
            }
            e.insert(
                "installable".into(),
                Value::Array(ok.into_iter().cloned().collect()),
            );
            e.insert("hidden".into(), hidden(&no, running));
            Value::Object(e)
        })
        .collect();
    json!({ "plugins": plugins, "denyList": doc.get("denyList").cloned().unwrap_or(json!([])) })
}

/// One source's denylist and the key that verified its catalog.
pub fn deny_list_of(cached: Option<&Value>) -> (Vec<Value>, Option<String>) {
    let Some(c) = cached else {
        return (vec![], None);
    };
    let list = c["denyList"]
        .as_array()
        .map(|a| a.iter().filter(|e| deny_entry(e)).cloned().collect());
    (
        list.unwrap_or_default(),
        c["signedByKeyId"].as_str().map(str::to_owned),
    )
}

pub struct Denied<'a> {
    pub plugin_id: &'a str,
    pub version: &'a str,
    pub sha256: &'a str,
    pub verified_by: Option<&'a str>,
}

/// Revocation authority is signing authority: only the key that verified the catalog denies.
pub fn find_denial(p: &Denied<'_>, sources: &[(Vec<Value>, Option<String>)]) -> Option<String> {
    let key = p.verified_by?;
    for (list, signed) in sources {
        if signed.as_deref() != Some(key) {
            continue;
        }
        for e in list {
            if e["pluginId"] != p.plugin_id {
                continue;
            }
            if e.get("version").is_some_and(|v| v != p.version)
                || e.get("sha256").is_some_and(|v| v != p.sha256)
            {
                continue;
            }
            return e["reason"].as_str().map(str::to_owned);
        }
    }
    None
}

/// The newest `installable` version of `id` the cache offers.
pub fn newest(cached: Option<&Value>, id: &str) -> Option<String> {
    let entry = cached?["plugins"]
        .as_array()?
        .iter()
        .find(|p| p["id"] == id)?;
    let v = entry["installable"].as_array()?.last()?["version"].as_str()?;
    Version::parse(v).is_ok().then(|| v.to_owned())
}

pub fn version_entry_of<'a>(
    cached: Option<&'a Value>,
    id: &str,
    version: &str,
) -> Option<&'a Value> {
    let entry = cached?["plugins"]
        .as_array()?
        .iter()
        .find(|p| p["id"] == id)?;
    entry["installable"]
        .as_array()?
        .iter()
        .find(|v| v["version"] == version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(version: &str, api: u32, fliks: &str, sha: &str) -> Value {
        json!({"version": version, "pluginApi": api, "fliks": fliks, "zipUrl": "https://x/a.fkplugin", "sha256": sha})
    }

    #[test]
    fn filter_and_hidden() {
        let ok = "a".repeat(64);
        let doc = json!({"plugins": [{"id":"p","name":"P","description":"","author":"a","kind":"process",
            "versions":[v("1.1.0",2,">=5.0.0 <6.0.0",&ok), v("1.0.0",2,">=5.0.0 <6.0.0",&ok),
                        v("0.9.0",1,">=4.0.0 <5.0.0",&ok), v("2.0.0",2,">=6.0.0 <7.0.0",&ok),
                        v("1.2.0",2,">=5.0.0 <6.0.0",&"0".repeat(64))]}]});
        let doc = parse(&serde_json::to_vec(&doc).unwrap()).unwrap();
        let f = filter(&doc, "5.0.0", false);
        let p = &f["plugins"][0];
        let got: Vec<&str> = p["installable"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["version"].as_str().unwrap())
            .collect();
        assert_eq!(got, ["1.0.0", "1.1.0"]);
        assert_eq!(p["hidden"], json!({"count": 3, "minFliksVersion": "6.0.0"}));
        assert!(p.get("logo").is_none());
        assert_eq!(f["denyList"], json!([]));
        assert_eq!(newest(Some(&f), "p").as_deref(), Some("1.1.0"));
    }

    #[test]
    fn denial_authority() {
        let list = vec![json!({"pluginId":"p","version":"1.0.0","reason":"bad"})];
        let sources = vec![(list, Some("release-2026".to_owned()))];
        let mk = |by: Option<&'static str>, version: &'static str| Denied {
            plugin_id: "p",
            version,
            sha256: "x",
            verified_by: by,
        };
        assert_eq!(
            find_denial(&mk(Some("release-2026"), "1.0.0"), &sources).as_deref(),
            Some("bad")
        );
        assert_eq!(
            find_denial(&mk(Some("release-2026"), "1.0.1"), &sources),
            None
        );
        assert_eq!(find_denial(&mk(Some("other"), "1.0.0"), &sources), None);
        assert_eq!(find_denial(&mk(None, "1.0.0"), &sources), None);
    }

    #[test]
    fn garbled_documents() {
        assert!(parse(b"{}").is_none());
        assert!(parse(br#"{"plugins":[{"id":"p"}]}"#).is_none());
        let d =
            parse(br#"{"plugins":[],"denyList":[{"pluginId":"p"},{"pluginId":"q","reason":"r"}]}"#)
                .unwrap();
        assert_eq!(d["denyList"].as_array().unwrap().len(), 1);
    }
}

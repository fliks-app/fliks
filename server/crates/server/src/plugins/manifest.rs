//! `plugin.json` (`plugins.md` rules 1-5, 12, 16) and the inspect pipeline over an archive.
use super::archive::{self, Archive, Refusal, refuse};
use super::trust::{self, Keys, Trust};
use nodejs_semver::{Range, Version};
use serde_json::{Map, Value};

pub const SUPPORTED_PLUGIN_API_VERSIONS: [u32; 1] = [3];

/// The kinds and levels a `ui.releasePicker` may name (`plugins.md` rule 5).
const PICKER_KINDS: [&str; 6] = ["movie", "series", "book", "comic", "album", "artist"];
const PICKER_LEVELS: [&str; 3] = ["work", "group", "item"];

/// Every `(kind, level, pair)` of a `ui.releasePicker`.
pub fn picker_pairs(rp: &Value) -> impl Iterator<Item = (&str, &str, &Value)> {
    rp.as_object()
        .into_iter()
        .flatten()
        .flat_map(|(kind, levels)| {
            levels
                .as_object()
                .into_iter()
                .flatten()
                .map(move |(level, pair)| (kind.as_str(), level.as_str(), pair))
        })
}

fn shaped_picker(rp: &Value) -> bool {
    let Some(kinds) = rp.as_object().filter(|k| !k.is_empty()) else {
        return false;
    };
    kinds.iter().all(|(kind, levels)| {
        PICKER_KINDS.contains(&kind.as_str())
            && levels.as_object().is_some_and(|l| {
                !l.is_empty()
                    && l.iter().all(|(level, pair)| {
                        PICKER_LEVELS.contains(&level.as_str())
                            && pair["search"].is_string()
                            && pair["grab"].is_string()
                    })
            })
    })
}
const RESERVED_IDS: [&str; 4] = ["ui", "metrics", "sources", "import"];
const BASE_KEYS: [&str; 14] = [
    "id",
    "pluginApi",
    "name",
    "version",
    "fliks",
    "author",
    "description",
    "license",
    "logo",
    "homepage",
    "ui",
    "events",
    "i18n",
    "kind",
];
const PROCESS_KEYS: [&str; 11] = [
    "runtime",
    "memoryMb",
    "files",
    "database",
    "routes",
    "scopes",
    "ingestRoots",
    "jobs",
    "permissions",
    "checklist",
    "network",
];
pub const SCOPES: [&str; 6] = [
    "media:read",
    "acquisition:candidates",
    "releases:score",
    "ingest:write",
    "events:emit",
    "config:rw",
];

fn s(v: &Value) -> Option<&str> {
    v.as_str()
}

fn non_empty(v: &Value) -> bool {
    s(v).is_some_and(|x| !x.is_empty())
}

fn string_record(v: &Value) -> bool {
    v.as_object()
        .is_some_and(|o| o.values().all(Value::is_string))
}

fn branch_conflict(keys: &[&String]) -> bool {
    keys.iter().enumerate().any(|(i, k)| {
        keys.iter()
            .enumerate()
            .any(|(j, o)| i != j && o.starts_with(&format!("{k}.")))
    })
}

fn i18n_one_root(i18n: &Map<String, Value>) -> bool {
    let mut roots = std::collections::BTreeSet::new();
    for dict in i18n.values() {
        let keys: Vec<&String> = dict
            .as_object()
            .map(|o| o.keys().collect())
            .unwrap_or_default();
        if branch_conflict(&keys) {
            return false;
        }
        for k in keys {
            let root = k.split('.').next().unwrap_or_default();
            if root.is_empty() || root == k {
                return false;
            }
            roots.insert(root.to_owned());
        }
    }
    roots.len() <= 1
}

/// The root branch the i18n keys sit under (the first key of the first locale).
pub fn i18n_root(m: &Value) -> Option<String> {
    let first = m["i18n"]
        .as_object()?
        .values()
        .next()?
        .as_object()?
        .keys()
        .next()?;
    first.split('.').next().map(str::to_owned)
}

fn posix_normalize(p: &str) -> String {
    let abs = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut out: Vec<&str> = vec![];
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|l| *l != "..") {
                    out.pop();
                } else if !abs {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut s = out.join("/");
    if s.is_empty() && !abs {
        s.push('.');
    }
    if trailing && !s.is_empty() {
        s.push('/');
    }
    if abs { format!("/{s}") } else { s }
}

fn posix_dirname(p: &str) -> String {
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return if p.starts_with('/') {
            "/".into()
        } else {
            ".".into()
        };
    }
    match t.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => t[..i].trim_end_matches('/').to_owned(),
        None => ".".into(),
    }
}

/// Absolute, normalised, never a volume root; Windows-flavoured when it starts with a drive.
fn valid_ingest_root(root: &str) -> bool {
    let b = root.as_bytes();
    if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
    {
        if b[2] == b'/' || root.contains('/') {
            return false;
        }
        let segs: Vec<&str> = root[3..].split('\\').collect();
        let body = match segs.split_last() {
            Some((last, head)) if last.is_empty() && !head.is_empty() => head,
            _ => &segs[..],
        };
        return body
            .iter()
            .all(|s| !s.is_empty() && *s != "." && *s != "..");
    }
    root.starts_with('/') && posix_normalize(root) == root && posix_dirname(root) != root
}

fn route_array(v: &Value) -> bool {
    v.as_array().is_some_and(|a| {
        a.iter().all(|r| {
            r.is_object()
                && r["method"].is_string()
                && r["path"].is_string()
                && r["policy"].is_string()
                && (r.get("objectGuard").is_none() || r["objectGuard"].is_string())
        })
    })
}

/// Rule 3 ceiling of `memoryMb`.
const MEMORY_MB_MAX: f64 = 1024.0;

/// Rule 3 `database.secrets`: `{table, column, jsonPath?}` entries, `jsonPath` dotted object keys with `*` for array elements.
fn secrets_shaped(db: &Value) -> bool {
    let name = |v: &Value| v.as_str().is_some_and(|s| !s.is_empty());
    let path = |v: &Value| {
        v.as_str().is_some_and(|p| {
            let segs: Vec<&str> = p.split('.').collect();
            segs.iter().all(|s| !s.is_empty()) && segs.last() != Some(&"*")
        })
    };
    match db.get("secrets") {
        None => true,
        Some(a) => a.as_array().is_some_and(|a| {
            a.iter().all(|e| {
                e.as_object().is_some_and(|o| {
                    o.keys()
                        .all(|k| ["table", "column", "jsonPath"].contains(&k.as_str()))
                        && name(&e["table"])
                        && name(&e["column"])
                        && o.get("jsonPath").is_none_or(path)
                })
            })
        }),
    }
}

fn process_fields(j: &Value) -> bool {
    j["runtime"] == "wasm"
        && j["memoryMb"].as_f64().is_some_and(|m| m <= MEMORY_MB_MAX)
        && string_record(&j["files"])
        && j["database"].is_object()
        && j["database"]["schema"].is_boolean()
        && secrets_shaped(&j["database"])
        && j["database"]["coreRefs"]
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
        && route_array(&j["routes"])
        && j["scopes"].as_array().is_some_and(|a| {
            !a.is_empty()
                && a.iter()
                    .all(|s| s.as_str().is_some_and(|s| SCOPES.contains(&s)))
        })
        && j["ingestRoots"]
            .as_array()
            .is_some_and(|a| a.iter().all(|r| r.as_str().is_some_and(valid_ingest_root)))
        && match j.get("network") {
            None => true,
            Some(n) => n
                .as_object()
                .is_some_and(|o| o.len() == 1 && o.get("internal") == Some(&Value::Bool(true))),
        }
}

/// Structural validation only (rule 1-3); `None` is `PLUGIN_BAD_MANIFEST`.
pub fn parse(bytes: &[u8]) -> Option<Value> {
    let j: Value = serde_json::from_str(&String::from_utf8_lossy(bytes)).ok()?;
    let o = j.as_object()?;
    let base = non_empty(&j["id"])
        && j["pluginApi"].is_number()
        && non_empty(&j["name"])
        && non_empty(&j["version"])
        && non_empty(&j["fliks"])
        && j["author"].is_string()
        && j["description"].is_string()
        && j["license"].is_string()
        && j["logo"].is_string()
        && (o.get("homepage").is_none() || j["homepage"].is_string());
    if !base {
        return None;
    }
    if let Some(i18n) = o.get("i18n") {
        let dict = i18n.as_object()?;
        if !dict.values().all(string_record) || !i18n_one_root(dict) {
            return None;
        }
    }
    match j["kind"].as_str()? {
        "data" => o
            .keys()
            .all(|k| BASE_KEYS.contains(&k.as_str()))
            .then_some(j),
        "process" => {
            let legal = o
                .keys()
                .all(|k| BASE_KEYS.contains(&k.as_str()) || PROCESS_KEYS.contains(&k.as_str()));
            (legal && process_fields(&j)).then_some(j)
        }
        _ => None,
    }
}

fn shaped_contribution(v: &Value) -> bool {
    v.is_object()
        && v["id"].is_string()
        && v["slot"].is_string()
        && v["weight"].is_number()
        && v["labelKey"].is_string()
        && v["action"].is_object()
        && v["action"]["kind"].is_string()
}

fn shaped_field(v: &Value) -> bool {
    v.is_object()
        && (v.get("kind").is_none() || v["kind"] == "field")
        && v["key"].is_string()
        && v["type"].is_string()
        && v["labelKey"].is_string()
}

fn shaped_form_item(v: &Value) -> bool {
    if !v.is_object() {
        return false;
    }
    match v.get("kind").and_then(Value::as_str) {
        Some("caption") => v["textKey"].is_string(),
        Some("group") => {
            v["labelKey"].is_string()
                && v["fields"]
                    .as_array()
                    .is_some_and(|f| f.iter().all(shaped_field))
        }
        Some("status") => v["settingKey"].is_string() && v["labelKey"].is_string(),
        _ => shaped_field(v),
    }
}

fn shaped_page(v: &Value) -> bool {
    if !v.is_object() || !v["id"].is_string() || !v["labelKey"].is_string() {
        return false;
    }
    match v.get("kind").and_then(Value::as_str) {
        Some("table") => v["list"].is_string() && v["columns"].is_array(),
        Some("providers") => v["list"].is_string() && v["implementations"].is_string(),
        _ => v["fields"]
            .as_array()
            .is_some_and(|f| f.iter().all(shaped_form_item)),
    }
}

fn all_shaped(v: Option<&Value>, f: fn(&Value) -> bool) -> bool {
    v.is_none_or(|v| v.as_array().is_some_and(|a| a.iter().all(f)))
}

/// Rule 5: the nested `ui` and `events` shapes, before capabilities are derived.
pub fn validate_shape(m: &Value) -> Result<(), Refusal> {
    if let Some(ui) = m.get("ui") {
        if !ui.is_object() {
            return Err(refuse("PLUGIN_BAD_UI", "manifest.ui must be an object"));
        }
        if !all_shaped(ui.get("contributions"), shaped_contribution) {
            return Err(refuse(
                "PLUGIN_BAD_UI_CONTRIBUTIONS",
                "ui.contributions must be an array of {id, slot, weight, labelKey, action} entries",
            ));
        }
        if !all_shaped(ui.get("configPages"), shaped_page) {
            return Err(refuse(
                "PLUGIN_BAD_UI_CONFIG_PAGES",
                "ui.configPages must be an array of pages carrying the keys their kind requires",
            ));
        }
        if let Some(rp) = ui.get("releasePicker")
            && !shaped_picker(rp)
        {
            return Err(refuse(
                "PLUGIN_BAD_UI_RELEASE_PICKER",
                "ui.releasePicker must map kinds to levels (work, group, item) of {search, grab} routes",
            ));
        }
    }
    let event = |v: &Value| v.is_object() && v["event"].is_string() && v["webhook"].is_string();
    if !all_shaped(m.get("events"), event) {
        return Err(refuse(
            "PLUGIN_BAD_EVENTS",
            "events must be an array of {event, webhook} entries",
        ));
    }
    Ok(())
}

fn strs(v: &Value) -> impl Iterator<Item = &str> {
    v.as_array().into_iter().flatten().filter_map(Value::as_str)
}

/// Rule 12's capability list, in order.
pub fn capabilities(m: &Value, network_newly_requested: bool) -> Vec<String> {
    let ui = &m["ui"];
    let mut caps: Vec<String> = ui["contributions"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| format!("ui:{}", c["slot"].as_str().unwrap_or_default()))
        .collect();
    caps.extend(
        ui["configPages"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| format!("config:{}", p["id"].as_str().unwrap_or_default())),
    );
    if m["events"].as_array().is_some_and(|e| !e.is_empty()) {
        caps.push("webhook".into());
    }
    if m["kind"] == "process" {
        caps.extend(strs(&m["scopes"]).map(|s| format!("scope:{s}")));
        caps.extend(strs(&m["ingestRoots"]).map(|r| format!("ingestroot:{r}")));
        caps.extend(
            m["jobs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|j| format!("job:{}", j["name"].as_str().unwrap_or_default())),
        );
        if network_newly_requested {
            caps.push("network:internal".into());
        }
    }
    caps
}

pub fn requests_network(m: &Value) -> bool {
    m["network"]["internal"] == Value::Bool(true)
}

/// `semver.valid`.
pub fn valid_version(v: &str) -> bool {
    v.len() <= 256 && Version::parse(v.trim()).is_ok()
}

/// The version a `fliks` range is matched against: a pre-release counts as its release.
pub fn range_version(v: &str) -> String {
    match Version::parse(v.trim()) {
        Ok(p) => format!("{}.{}.{}", p.major(), p.minor(), p.patch()),
        Err(_) => v.to_owned(),
    }
}

/// `semver.satisfies(fliksRangeVersion(running), range)`; an unparsable range satisfies nothing.
pub fn fliks_satisfied(range: &str, running: &str) -> bool {
    match (Range::parse(range), Version::parse(range_version(running))) {
        (Ok(r), Ok(v)) => r.satisfies(&v),
        _ => false,
    }
}

pub fn api_supported(m: &Value) -> bool {
    m["pluginApi"]
        .as_f64()
        .is_some_and(|a| SUPPORTED_PLUGIN_API_VERSIONS.iter().any(|s| *s as f64 == a))
}

/// What a successful inspect knows about the archive.
#[derive(Debug, Clone)]
pub struct Inspected {
    pub archive: Archive,
    pub manifest: Value,
    pub id: String,
    pub version: String,
    pub signature: Trust,
    pub signed_by: Option<String>,
}

impl Inspected {
    pub fn kind(&self) -> &str {
        self.manifest["kind"].as_str().unwrap_or_default()
    }
}

/// The signature bytes of `plugin.json.sig`, decoded as rule 15 says.
fn signature_of(a: &Archive) -> Result<Option<Vec<u8>>, Refusal> {
    let Some(raw) = a.get("plugin.json.sig") else {
        return Ok(None);
    };
    let bytes = trust::decode(&String::from_utf8_lossy(raw)).unwrap_or_default();
    if bytes.len() != 64 {
        return Err(refuse(
            "PLUGIN_BAD_SIGNATURE",
            format!("signature is {} bytes, expected 64", bytes.len()),
        ));
    }
    Ok(Some(bytes))
}

/// V1-V7: archive guards, signature, manifest, tier and file set; nothing touches disk.
pub fn inspect(buf: &[u8], allow_unsigned: bool, keys: &Keys) -> Result<Inspected, Refusal> {
    let archive = archive::read(buf)?;
    let manifest_bytes = archive.get("plugin.json").unwrap_or_default().to_vec();
    let sig = signature_of(&archive)?;
    let (signature, signed_by) = trust::resolve(&manifest_bytes, sig.as_deref(), keys);
    let manifest = parse(&manifest_bytes).ok_or_else(|| {
        refuse(
            "PLUGIN_BAD_MANIFEST",
            "plugin.json failed structural validation",
        )
    })?;
    let id = manifest["id"].as_str().unwrap_or_default().to_owned();
    if !fliks_domain::plugins::legal_plugin_id(&id) || RESERVED_IDS.contains(&id.as_str()) {
        return Err(refuse(
            "PLUGIN_BAD_ID",
            format!("id {} is not a legal plugin id", Value::String(id.clone())),
        ));
    }
    let version = manifest["version"].as_str().unwrap_or_default().to_owned();
    if !valid_version(&version) {
        return Err(refuse(
            "PLUGIN_BAD_VERSION",
            format!(
                "version {} is not valid semver",
                Value::String(version.clone())
            ),
        ));
    }
    validate_shape(&manifest)?;
    let wasm = archive.get("plugin.wasm");
    let process = manifest["kind"] == "process";
    if !process && wasm.is_some() {
        return Err(refuse(
            "PLUGIN_TIER_VIOLATION",
            "a data-tier archive may not carry plugin.wasm",
        ));
    }
    if process && wasm.is_none() {
        return Err(refuse(
            "PLUGIN_TIER_VIOLATION",
            "a process-tier archive must carry plugin.wasm",
        ));
    }
    if process {
        if signature != Trust::Official && !allow_unsigned {
            return Err(refuse(
                "PLUGIN_UNSIGNED",
                "process-tier plugins must carry a trusted signature unless unsigned plugins are allowed",
            ));
        }
        let code: std::collections::BTreeSet<&str> = archive
            .order
            .iter()
            .map(String::as_str)
            .filter(|n| *n == "plugin.wasm" || n.starts_with("logo."))
            .collect();
        let declared: std::collections::BTreeSet<&str> = manifest["files"]
            .as_object()
            .map(|o| o.keys().map(String::as_str).collect())
            .unwrap_or_default();
        if code != declared {
            return Err(refuse(
                "PLUGIN_FILE_SET_MISMATCH",
                "archive entries and manifest.files disagree",
            ));
        }
        if !wasm.is_some_and(|w| w.starts_with(&archive::PREAMBLE)) {
            return Err(refuse(
                "PLUGIN_BAD_WASM",
                "plugin.wasm is not a WebAssembly component",
            ));
        }
    }
    Ok(Inspected {
        archive,
        manifest,
        id,
        version,
        signature,
        signed_by,
    })
}

/// Rule 16 at install and every load: each file's sha256 against `manifest.files`, logos sniffed.
pub fn check_files(i: &Inspected) -> Result<(), Refusal> {
    for (name, content) in &i.archive.entries {
        if name.starts_with("logo.")
            && let Some(r) = archive::sniff_logo(name, content)
        {
            return Err(r);
        }
        if let Some(want) = i.manifest["files"][name].as_str() {
            let got = archive::sha256_hex(content);
            if got != want {
                return Err(refuse(
                    "PLUGIN_HASH_MISMATCH",
                    format!("{name}: expected {want}, got {got}"),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The client declares, non-optional, every field the rule-5 shape checks require (no codegen:
    /// the host validates shapes, it holds no typed UI contract to generate from).
    #[test]
    fn client_ui_types_carry_what_the_host_requires() {
        let ts = include_str!("../../../../../client/src/app/core/plugin-ui/ui-contribution.ts");
        let required = |iface: &str, fields: &[&str]| {
            let start = ts
                .find(&format!("interface {iface} "))
                .unwrap_or_else(|| panic!("interface {iface} missing"));
            let body = &ts[start..start + ts[start..].find("\n}\n").expect("closed")];
            for f in fields {
                assert!(
                    body.contains(&format!("\n  {f}:")),
                    "{iface}.{f} missing or optional"
                );
            }
        };
        required(
            "UiContribution",
            &["id", "slot", "weight", "labelKey", "action"],
        );
        required("FieldDef", &["key", "type", "labelKey"]);
        required("FormCaption", &["kind", "textKey"]);
        required("FormGroup", &["kind", "labelKey", "fields"]);
        required("FormStatus", &["kind", "labelKey", "settingKey"]);
        required("ConfigPageBase", &["id", "labelKey"]);
        required("TableConfigPage", &["kind", "list", "columns"]);
        required("ProvidersConfigPage", &["kind", "list", "implementations"]);
        required("ReleasePickerPair", &["search", "grab"]);
        required("ReleasePickerRoutes", &["byKind"]);
        assert!(
            ts.contains("export const SECRETS_SET_KEY = 'secretsSet';"),
            "the settings read key"
        );
    }

    use super::*;
    use serde_json::json;

    fn data() -> Value {
        json!({"id":"acme.hello","pluginApi":3,"name":"Hello","version":"1.0.0","fliks":">=5.0.0 <6.0.0",
               "author":"a","description":"d","license":"MIT","logo":"logo.svg","kind":"data"})
    }

    #[test]
    fn structure() {
        let b = |v: &Value| serde_json::to_vec(v).unwrap();
        assert!(parse(&b(&data())).is_some());
        let mut extra = data();
        extra["routes"] = json!([]);
        assert!(parse(&b(&extra)).is_none());
        let mut i18n = data();
        i18n["i18n"] = json!({"en": {"hello.a": "x", "hello.b": "y"}});
        assert!(parse(&b(&i18n)).is_some());
        i18n["i18n"] = json!({"en": {"hello": "x"}});
        assert!(parse(&b(&i18n)).is_none());
        let mut p = data();
        p["kind"] = "process".into();
        for (k, v) in [
            ("runtime", json!("wasm")),
            ("memoryMb", json!(64)),
            ("files", json!({})),
            ("database", json!({"schema": false, "coreRefs": []})),
            ("routes", json!([])),
            ("scopes", json!(["config:rw"])),
            ("ingestRoots", json!(["/downloads"])),
        ] {
            p[k] = v;
        }
        assert!(parse(&b(&p)).is_some());
        p["memoryMb"] = json!(1024);
        assert!(parse(&b(&p)).is_some());
        p["memoryMb"] = json!(1025);
        assert!(parse(&b(&p)).is_none());
        p["memoryMb"] = json!(64);
        p["network"] = json!({"internal": true});
        assert!(parse(&b(&p)).is_some());
        p["network"] = json!({"internal": false});
        assert!(parse(&b(&p)).is_none());
        p["network"] = json!({"internal": true});
        p["runtime"] = "node".into();
        assert!(parse(&b(&p)).is_none());
    }

    #[test]
    fn ingest_roots() {
        for ok in ["/downloads", "/a/b/", "C:\\data"] {
            assert!(valid_ingest_root(ok), "{ok}");
        }
        for bad in [
            "/", "relative", "/a/../b", "//a", "/a/./b", "C:/data", "C:\\",
        ] {
            assert!(!valid_ingest_root(bad), "{bad}");
        }
    }

    #[test]
    fn semver() {
        assert!(fliks_satisfied(">=5.0.0 <6.0.0", "5.0.0-rc.1"));
        assert!(!fliks_satisfied(">=5.0.0 <6.0.0", "4.5.0"));
        assert!(!fliks_satisfied("not a range", "5.0.0"));
        assert!(valid_version("1.2.3") && valid_version("1.2.3-beta.1") && !valid_version("1.2"));
    }
}

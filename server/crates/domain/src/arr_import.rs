//! Pure helpers of the Radarr / Sonarr / Seerr importers (`docs/spec/importers.md` rules 7-8, 15-17, 19, 32, 43).
use crate::{
    js::trim,
    language::APP_LANGUAGES,
    release::parsing::quality::{APP_QUALITIES, AppQuality},
};
use serde::Deserialize;
use serde_json::{Value, json};

/// One row of the path-mapping wizard.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathMapping {
    pub remote_path: String,
    pub local_library_id: Option<i32>,
    pub ignore: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mapped {
    Library {
        library_id: i32,
        folder_name: String,
    },
    Ignore,
}

/// POSIX `path.normalize`.
fn node_normalize(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let absolute = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => match out.last() {
                Some(&last) if last != ".." => {
                    out.pop();
                }
                _ if absolute => {}
                _ => out.push(".."),
            },
            s => out.push(s),
        }
    }
    let mut body = out.join("/");
    if body.is_empty() {
        return match (absolute, p.ends_with('/')) {
            (true, _) => "/".into(),
            (false, true) => "./".into(),
            (false, false) => ".".into(),
        };
    }
    if p.ends_with('/') {
        body.push('/');
    }
    if absolute { format!("/{body}") } else { body }
}

/// `trim`, `normalize`, strip trailing separators, then `\` to `/`: the order keeps Windows paths one segment.
pub fn normalize_path(p: &str) -> String {
    let n = node_normalize(trim(p));
    n.trim_end_matches(['/', '\\']).replace('\\', "/")
}

/// POSIX `path.basename`.
fn basename(p: &str) -> &str {
    let t = p.trim_end_matches('/');
    t.rsplit('/').next().unwrap_or("")
}

/// POSIX `path.extname`.
pub fn extname(p: &str) -> &str {
    let base = basename(p);
    match base.rfind('.') {
        Some(i) if i > 0 && base != ".." => &base[i..],
        _ => "",
    }
}

/// `path.basename(p, path.extname(p))`.
fn stem(p: &str) -> &str {
    let (base, ext) = (basename(p), extname(p));
    if ext.is_empty() || base == ext {
        base
    } else {
        &base[..base.len() - ext.len()]
    }
}

/// Longest remote prefix wins; the folder is the first segment under it (rule 8).
pub fn apply_path_mapping(full: Option<&str>, mappings: &[PathMapping]) -> Option<Mapped> {
    let full = full.filter(|f| !trim(f).is_empty())?;
    if mappings.is_empty() {
        return None;
    }
    let full = normalize_path(full);
    let mut sorted: Vec<(String, &PathMapping)> = mappings
        .iter()
        .map(|m| (normalize_path(&m.remote_path), m))
        .collect();
    // JS `length` counts UTF-16 units; the stable sort keeps the mapping order on ties.
    sorted.sort_by_key(|(r, _)| std::cmp::Reverse(r.encode_utf16().count()));
    for (remote, m) in sorted {
        if remote.is_empty() {
            continue;
        }
        let prefix = format!("{remote}/");
        if full != remote && !full.starts_with(&prefix) {
            continue;
        }
        if m.ignore {
            return Some(Mapped::Ignore);
        }
        let library_id = m.local_library_id?;
        let rest = if full == remote {
            ""
        } else {
            &full[prefix.len()..]
        };
        let folder = rest.split('/').next().unwrap_or("");
        let folder = if folder.is_empty() {
            basename(&full)
        } else {
            folder
        };
        if folder.is_empty() {
            return None;
        }
        return Some(Mapped::Library {
            library_id,
            folder_name: folder.to_owned(),
        });
    }
    None
}

/// The wizard's pre-selected library for a remote root: a unique tail match, else a unique basename match.
pub fn suggest_local_library_id(remote: &str, libs: &[(i32, Option<String>)]) -> Option<i32> {
    if trim(remote).is_empty() || libs.is_empty() {
        return None;
    }
    let norm = normalize_path(remote);
    let remote_base = basename(&norm);
    if remote_base.is_empty() {
        return None;
    }
    let paths: Vec<(i32, String)> = libs
        .iter()
        .filter_map(|(id, p)| {
            p.as_deref()
                .filter(|p| !p.is_empty())
                .map(|p| (*id, normalize_path(p)))
        })
        .collect();
    let suffix = format!("/{remote_base}");
    let unique = |hits: Vec<i32>| (hits.len() == 1).then(|| hits[0]);
    unique(
        paths
            .iter()
            .filter(|(_, p)| p.ends_with(&suffix))
            .map(|(id, _)| *id)
            .collect(),
    )
    .or_else(|| {
        unique(
            paths
                .iter()
                .filter(|(_, p)| basename(p) == remote_base)
                .map(|(id, _)| *id)
                .collect(),
        )
    })
}

pub const SUBTITLE_EXTENSIONS: [&str; 5] = [".srt", ".ass", ".ssa", ".sub", ".vtt"];

const LANG_CODES: [&str; 38] = [
    "en", "fr", "de", "es", "it", "pt", "nl", "ja", "ko", "zh", "ru", "ar", "pl", "sv", "da", "no",
    "fi", "eng", "fra", "fre", "deu", "ger", "spa", "ita", "por", "nld", "dut", "jpn", "kor",
    "zho", "chi", "rus", "ara", "pol", "swe", "dan", "nor", "fin",
];

/// The last dot-separated part of the name that is a known language code, else `und`.
pub fn parse_language_from_path(relative: &str) -> String {
    stem(relative)
        .split('.')
        .rev()
        .map(str::to_lowercase)
        .find(|p| LANG_CODES.contains(&p.as_str()))
        .unwrap_or_else(|| "und".into())
}

/// Substring tests, no word boundary (rule 19).
pub fn parse_subtitle_tags(relative: &str) -> Vec<&'static str> {
    let base = stem(relative).to_lowercase();
    let mut tags = vec![];
    if base.contains("forced") {
        tags.push("forced");
    }
    if base.contains("sdh") {
        tags.push("sdh");
    }
    if base.contains(".cc") || base.contains("_cc") {
        tags.push("cc");
    }
    if base.contains(".hi") || base.contains("_hi") {
        tags.push("hi");
    }
    tags
}

pub fn hearing_impaired_from_tags(tags: &[&str]) -> bool {
    tags.iter().any(|t| ["sdh", "cc", "hi"].contains(t))
}

/// A Radarr `language.name` (`English`) as the ISO 639-1 code `APP_LANGUAGES` names it; unknown names pass through.
pub fn language_from_name(name: &str) -> String {
    let lower = name.to_lowercase();
    APP_LANGUAGES
        .iter()
        .find(|l| l.name.to_lowercase() == lower)
        .map_or(lower, |l| l.iso_code.to_owned())
}

/// `{quality:{id,name}, allowed, items?}` of a remote profile; absent members are tolerated like in Nest.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RemoteItem {
    #[serde(default, deserialize_with = "lenient")]
    pub quality: Option<RemoteQuality>,
    #[serde(default, deserialize_with = "lenient_bool")]
    pub allowed: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub items: Option<Vec<RemoteItem>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct RemoteQuality {
    #[serde(default, deserialize_with = "lenient")]
    pub id: Option<i64>,
    #[serde(default, deserialize_with = "lenient")]
    pub name: Option<String>,
}

/// Any other JSON type reads as absent.
fn lenient<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Ok(Option::<Value>::deserialize(d)?.and_then(|v| serde_json::from_value(v).ok()))
}

fn lenient_bool<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(matches!(
        Option::<Value>::deserialize(d)?,
        Some(Value::Bool(true))
    ))
}

fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '-' | '_'))
        .collect::<String>()
        .to_lowercase()
}

/// Matches after removing spaces, `-` and `_` and lower-casing (rule 16).
pub fn find_local_quality(name: &str) -> Option<&'static AppQuality> {
    let n = squash(name);
    APP_QUALITIES.iter().find(|q| squash(q.name) == n)
}

fn quality_json(q: &AppQuality) -> Value {
    json!({"id": q.id, "name": q.name, "resolution": q.resolution, "source": q.source})
}

/// Local profile items for a remote profile (rule 15): groups flattened one level, the rest appended not allowed.
pub fn map_remote_items(remote: &[RemoteItem]) -> Vec<Value> {
    let mut items: Vec<Value> = vec![];
    let mut present: Vec<u32> = vec![];
    let mut add = |name: &str, allowed: bool, items: &mut Vec<Value>| {
        if let Some(q) = find_local_quality(name) {
            let mut v = json!({"quality": quality_json(q), "allowed": allowed});
            v["sortOrder"] = items.len().into();
            items.push(v);
            present.push(q.id);
        }
    };
    for item in remote {
        if let Some(n) = item
            .quality
            .as_ref()
            .and_then(|q| q.name.as_deref())
            .filter(|n| !n.is_empty())
        {
            add(n, item.allowed, &mut items);
        }
        for sub in item.items.iter().flatten() {
            if let Some(n) = sub
                .quality
                .as_ref()
                .and_then(|q| q.name.as_deref())
                .filter(|n| !n.is_empty())
            {
                add(n, sub.allowed, &mut items);
            }
        }
    }
    for q in APP_QUALITIES.iter().filter(|q| !present.contains(&q.id)) {
        let mut v = json!({"quality": quality_json(q), "allowed": false});
        v["sortOrder"] = items.len().into();
        items.push(v);
    }
    items
}

/// Local id of the quality the remote cutoff names; 16 (WEBDL-1080p) when unknown (rule 17).
pub fn resolve_cutoff(remote_cutoff: Option<i64>, items: &[RemoteItem]) -> u32 {
    fn find(id: Option<i64>, items: &[RemoteItem]) -> Option<&str> {
        for item in items {
            if let Some(q) = &item.quality
                && q.id == id
                && id.is_some()
            {
                return q.name.as_deref();
            }
            if let Some(found) = item.items.as_deref().and_then(|s| find(id, s)) {
                return Some(found);
            }
        }
        None
    }
    find(remote_cutoff, items)
        .filter(|n| !n.is_empty())
        .and_then(find_local_quality)
        .map_or(16, |q| q.id)
}

/// Availability wins over the request status (rule 32).
pub fn map_status(request: Option<i64>, media: Option<i64>) -> &'static str {
    match (media, request) {
        (Some(5), _) => "available",
        (Some(3 | 4), _) => "processing",
        (_, Some(2)) => "approved",
        (_, Some(3)) => "declined",
        (_, Some(4)) => "failed",
        _ => "pending",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(remote: &str, lib: Option<i32>, ignore: bool) -> PathMapping {
        PathMapping {
            remote_path: remote.into(),
            local_library_id: lib,
            ignore,
        }
    }

    fn lib(id: i32, folder: &str) -> Mapped {
        Mapped::Library {
            library_id: id,
            folder_name: folder.into(),
        }
    }

    #[test]
    fn normalizes_like_node() {
        assert_eq!(normalize_path(" /movies/ "), "/movies");
        assert_eq!(normalize_path("D:\\Movies\\X\\"), "D:/Movies/X");
        assert_eq!(normalize_path("/"), "");
        assert_eq!(normalize_path("/a/../b//c/."), "/b/c");
        assert_eq!(normalize_path("/movies/..\\x"), "/movies/../x");
        assert_eq!(normalize_path(""), ".");
    }

    #[test]
    fn longest_prefix_wins() {
        let maps = [m("/data", Some(1), false), m("/data/tv", Some(2), false)];
        assert_eq!(
            apply_path_mapping(Some("/data/tv/Show (2020)"), &maps),
            Some(lib(2, "Show (2020)"))
        );
        assert_eq!(
            apply_path_mapping(Some("/data/movies/X"), &maps),
            Some(lib(1, "movies"))
        );
        assert_eq!(apply_path_mapping(Some("/other/x"), &maps), None);
        assert_eq!(
            apply_path_mapping(Some("/data/tvx/y"), &maps),
            Some(lib(1, "tvx"))
        );
    }

    #[test]
    fn ignore_null_library_and_root() {
        let maps = [
            m("/a/b", None, false),
            m("/a", Some(1), false),
            m("/z", Some(1), true),
            m("/", Some(1), false),
        ];
        assert_eq!(apply_path_mapping(Some("/a/b/x"), &maps), None);
        assert_eq!(
            apply_path_mapping(Some("/z/x"), &maps),
            Some(Mapped::Ignore)
        );
        assert_eq!(
            apply_path_mapping(Some("/a/b"), &maps[1..2]),
            Some(lib(1, "b"))
        );
        assert_eq!(
            apply_path_mapping(Some("/a"), &maps[1..2]),
            Some(lib(1, "a"))
        );
        assert_eq!(apply_path_mapping(Some("/q/x"), &maps[3..]), None);
        assert_eq!(apply_path_mapping(Some("  "), &maps), None);
        assert_eq!(apply_path_mapping(None, &maps), None);
    }

    #[test]
    fn windows_and_traversal_paths_are_recorded_as_node_yields_them() {
        let maps = [
            m("D:\\Movies", Some(1), false),
            m("/movies", Some(2), false),
        ];
        assert_eq!(
            apply_path_mapping(Some("D:\\Movies\\X (1999)"), &maps),
            Some(lib(1, "X (1999)"))
        );
        assert_eq!(
            apply_path_mapping(Some("/movies/..\\x"), &maps),
            Some(lib(2, ".."))
        );
        assert_eq!(
            apply_path_mapping(Some("/movies/.\\x"), &maps),
            Some(lib(2, "."))
        );
    }

    #[test]
    fn suggests_unique_tail_then_basename() {
        let libs = vec![
            (1, Some("/media/movies".to_owned())),
            (2, Some("/media/tv".to_owned())),
            (3, None),
        ];
        assert_eq!(suggest_local_library_id("/data/movies", &libs), Some(1));
        assert_eq!(suggest_local_library_id("/data/anime", &libs), None);
        let dup = vec![(1, Some("/a/tv".to_owned())), (2, Some("/b/tv".to_owned()))];
        assert_eq!(suggest_local_library_id("/x/tv", &dup), None);
        assert_eq!(suggest_local_library_id("tv", &libs), Some(2));
        assert_eq!(suggest_local_library_id("  ", &libs), None);
    }

    #[test]
    fn subtitle_names() {
        assert_eq!(parse_language_from_path("Movie.fra.forced.srt"), "fra");
        assert_eq!(parse_language_from_path("Movie.EN.srt"), "en");
        assert_eq!(parse_language_from_path("Movie.srt"), "und");
        assert_eq!(parse_language_from_path("a/b/Movie.en.fr.srt"), "fr");
        assert_eq!(parse_subtitle_tags("M.en.forced.srt"), ["forced"]);
        assert_eq!(parse_subtitle_tags("M.en.SDH.srt"), ["sdh"]);
        assert_eq!(parse_subtitle_tags("M.en.hi.srt"), ["hi"]);
        assert!(parse_subtitle_tags("Archive.srt").is_empty());
        assert!(hearing_impaired_from_tags(&["cc"]));
        assert!(!hearing_impaired_from_tags(&["forced"]));
        assert_eq!(language_from_name("English"), "en");
        assert_eq!(language_from_name("Klingon"), "klingon");
    }

    #[test]
    fn status_mapping() {
        assert_eq!(map_status(Some(1), Some(5)), "available");
        assert_eq!(map_status(Some(3), Some(4)), "processing");
        assert_eq!(map_status(Some(2), None), "approved");
        assert_eq!(map_status(Some(3), Some(1)), "declined");
        assert_eq!(map_status(Some(4), None), "failed");
        assert_eq!(map_status(Some(9), None), "pending");
    }

    fn items(v: Value) -> Vec<RemoteItem> {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn profile_items_flatten_groups_and_fill_the_rest() {
        let remote = items(json!([
            {"quality": {"id": 1, "name": "WEBDL-1080p"}, "allowed": true},
            {"name": "group", "allowed": false, "items": [
                {"quality": {"id": 2, "name": "Bluray 720p"}, "allowed": true},
                {"quality": {"id": 3, "name": "Nope"}, "allowed": true}]},
        ]));
        let out = map_remote_items(&remote);
        assert_eq!(out.len(), 24);
        assert_eq!(out[0]["quality"]["id"], 16);
        assert_eq!(out[0]["allowed"], true);
        assert_eq!(out[1]["quality"]["id"], 14);
        assert_eq!(out[1]["sortOrder"], 1);
        assert_eq!(out[2]["allowed"], false);
        assert_eq!(out[23]["sortOrder"], 23);
    }

    #[test]
    fn cutoff_resolution() {
        let remote = items(json!([
            {"quality": {"id": 7, "name": "Bluray-1080p"}, "allowed": true},
            {"items": [{"quality": {"id": 9, "name": "HDTV-720p"}}]}
        ]));
        assert_eq!(resolve_cutoff(Some(7), &remote), 18);
        assert_eq!(resolve_cutoff(Some(9), &remote), 11);
        assert_eq!(resolve_cutoff(Some(99), &remote), 16);
        assert_eq!(resolve_cutoff(None, &remote), 16);
    }
}

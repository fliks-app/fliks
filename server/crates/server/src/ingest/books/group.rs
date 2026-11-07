//! Files into works, editions and versions (`docs/spec/book-ingest.md` rules 1-4). Pure.
use fliks_domain::{
    books::filename::parse_path,
    media::{AUDIO_EXTS, TEXT_EXTS, family::Family},
};
use regex::Regex;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::LazyLock;

/// The family and format (extension without the dot) of a book file name.
pub fn classify(name: &str) -> Option<(Family, String)> {
    let dot = name.rfind('.').filter(|d| *d > 0)?;
    let ext = name[dot..].to_lowercase();
    let family = if TEXT_EXTS.contains(&ext.as_str()) {
        Family::Text
    } else if AUDIO_EXTS.contains(&ext.as_str()) {
        Family::Audio
    } else {
        return None;
    };
    Some((family, ext[1..].to_owned()))
}

/// One alternative of an item: its files are the positions in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Version {
    pub family: Family,
    pub format: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub dir: String,
    pub name_path: String,
    pub versions: Vec<Version>,
}

fn is_disc(seg: &str) -> bool {
    let s = seg.to_lowercase();
    ["cd", "disc", "disk", "disque"].iter().any(|p| {
        s.strip_prefix(p)
            .is_some_and(|n| !n.trim().is_empty() && n.trim().bytes().all(|b| b.is_ascii_digit()))
    })
}

/// The folder of a file, the disc folders off.
pub(super) fn work_dir(path: &str) -> String {
    let mut segs: Vec<&str> = path.split('/').collect();
    segs.pop();
    while segs.last().is_some_and(|s| is_disc(s)) {
        segs.pop();
    }
    segs.join("/")
}

/// The stem of a file name and its trailing ` (fr)` language, when it has one.
fn split_language(name: &str) -> (&str, Option<&str>) {
    let stem = name.rfind('.').map_or(name, |d| &name[..d]);
    if let Some(i) = stem.rfind(" (")
        && i > 0
        && let Some(l) = stem[i + 2..].strip_suffix(')')
        && (2..=3).contains(&l.len())
        && l.bytes().all(|b| b.is_ascii_lowercase())
    {
        return (&stem[..i], Some(l));
    }
    (stem, None)
}

/// The language a file name says with a trailing ` (fr)`.
pub fn name_language(path: &str) -> Option<String> {
    split_language(path.rsplit('/').next().unwrap_or(path))
        .1
        .map(str::to_owned)
}

/// The stem without its language: the files of one work in several languages share a key.
fn stem_key(path: &str) -> String {
    split_language(path.rsplit('/').next().unwrap_or(path))
        .0
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Digit runs compare as numbers, so `2` sorts before `10`.
fn natural(s: &str) -> Vec<(u64, String)> {
    let mut out = vec![];
    let mut rest = s.to_lowercase();
    while !rest.is_empty() {
        let digits = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        if digits > 0 {
            let n = rest[..digits].parse().unwrap_or(u64::MAX);
            out.push((n, String::new()));
            rest = rest[digits..].to_owned();
        } else {
            let text = rest
                .find(|c: char| c.is_ascii_digit())
                .unwrap_or(rest.len());
            out.push((0, rest[..text].to_owned()));
            rest = rest[text..].to_owned();
        }
    }
    out
}

fn alnum(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn re(p: &str) -> Regex {
    Regex::new(p).expect("static")
}

static BRACKETS: LazyLock<Regex> = LazyLock::new(|| re(r"\([^)]*\)|\[[^\]]*\]"));
static DISC_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(?:cd|disc|disk|disque|part|pt|partie|teil)\s*\d+\b"));
static DISC_TRACK: LazyLock<Regex> = LazyLock::new(|| re(r"^(.+?)[\s\x{2013}-]+\d+[-.]\d+$"));
static OF_N: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\s+of\s+\d+$"));
static TITLE_PART: LazyLock<Regex> = LazyLock::new(|| re(r"^(.+?)\s*[-\x{2013}]\s*0*\d+$"));
static GENERIC_LEAD: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)^(?:chapter|chapitre|chap|kapitel|track|piste|part|partie|pt|teil|disc|disk|disque|cd)\b",
    )
});

fn stem_of(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rfind('.').map_or(name, |d| &name[..d])
}

/// The book a part says it belongs to: the title of `Title - 01`, `None` for a track-first or generic name.
fn title_key(path: &str) -> Option<String> {
    let s = BRACKETS.replace_all(stem_of(path), "");
    let s = DISC_TOKEN.replace_all(&s, "");
    let s = OF_N.replace(&s, "");
    let s = s.trim();
    let trim = |t: &str| {
        t.trim_matches(|c: char| c.is_whitespace() || "-_.\u{2013}".contains(c))
            .to_owned()
    };
    let head = DISC_TRACK.captures(s).or_else(|| TITLE_PART.captures(s))?[1].to_owned();
    let mut title = trim(&head);
    // `Title - 01 - 01`: a disc number then the track.
    if let Some(c) = TITLE_PART.captures(&title) {
        title = trim(&c[1]);
    }
    let title = title.as_str();
    let numeric = title.bytes().all(|b| b.is_ascii_digit());
    if GENERIC_LEAD.is_match(title) || (numeric && title.starts_with('0')) {
        return None;
    }
    Some(alnum(title)).filter(|k| !k.is_empty())
}

/// Two keys that differ by a typo or one is the start of the other: the same book, not two.
/// Keys differing only by digits (`Book 2`, `Book 3`) are two books.
fn alike(a: &str, b: &str) -> bool {
    let strip = |k: &str| {
        k.chars()
            .filter(|c| !c.is_ascii_digit())
            .collect::<Vec<_>>()
    };
    let (a, b) = (strip(a), strip(b));
    if a == b || a.len().min(b.len()) < 4 {
        return false;
    }
    if a.starts_with(&b) || b.starts_with(&a) {
        return true;
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, x) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, y) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = (prev + usize::from(x != y)).min(row[j] + 1).min(cur + 1);
            prev = cur;
        }
    }
    row[b.len()] <= 2
}

/// The books of a folder's audio by file (`""` stays with the folder's work); a folder splits only
/// on two clearly different books: m4b names or `Title - 01` groups of at least two parts.
fn audio_keys(dir: &str, files: &[(String, String)]) -> HashMap<String, String> {
    let folder = dir
        .rsplit('/')
        .find(|s| !super::merge::GENERIC.contains(&s.to_lowercase().as_str()))
        .map(alnum);
    let mut whole: HashMap<&str, String> = HashMap::new();
    let mut parts: HashMap<&str, String> = HashMap::new();
    for (p, f) in files {
        if f == "m4b" {
            let k = alnum(&DISC_TOKEN.replace_all(&BRACKETS.replace_all(stem_of(p), ""), ""));
            if !k.is_empty() && Some(&k) != folder.as_ref() {
                whole.insert(p, k);
            }
        } else if let Some(k) = title_key(p) {
            parts.insert(p, k);
        }
    }
    let mut books: BTreeSet<String> = whole.values().cloned().collect();
    if books.len() < 2 {
        whole.clear();
        books.clear();
    }
    let mut count: HashMap<&str, usize> = HashMap::new();
    for k in parts.values() {
        *count.entry(k).or_default() += 1;
    }
    books.extend(
        count
            .into_iter()
            .filter(|(_, n)| *n >= 2)
            .map(|(k, _)| k.to_owned()),
    );
    if books.len() < 2
        || books
            .iter()
            .any(|a| books.iter().any(|b| a < b && alike(a, b)))
    {
        return HashMap::new();
    }
    parts.retain(|_, k| books.contains(k));
    whole
        .into_iter()
        .chain(parts)
        .map(|(p, k)| (p.to_owned(), k))
        .collect()
}

struct Acc {
    dir: String,
    text: Vec<(String, String)>,
    audio: Vec<(String, String)>,
}

/// The works of `paths`, relative to one folder root and `/`-separated.
pub fn group(paths: &[String]) -> Vec<Work> {
    group_by(paths, true)
}

/// `group` with the audio of a folder always one work: the files of a media that already exists.
pub fn group_whole(paths: &[String]) -> Vec<Work> {
    group_by(paths, false)
}

fn group_by(paths: &[String], split_books: bool) -> Vec<Work> {
    // Key: (dir, stem key) for text and for a root audio file, (dir, "") or (dir, book) for the audio of a folder.
    let mut works: BTreeMap<(String, String), Acc> = BTreeMap::new();
    let mut loose_audio: Vec<(String, String, String)> = vec![];
    for p in paths {
        let Some((family, format)) = classify(p.rsplit('/').next().unwrap_or(p)) else {
            continue;
        };
        let dir = work_dir(p);
        match family {
            Family::Text => works
                .entry((dir.clone(), stem_key(p)))
                .or_insert_with(|| Acc {
                    dir,
                    text: vec![],
                    audio: vec![],
                })
                .text
                .push((p.clone(), format)),
            _ => loose_audio.push((dir, p.clone(), format)),
        }
    }
    let text_in = |works: &BTreeMap<(String, String), Acc>, dir: &str| -> Vec<(String, String)> {
        works
            .keys()
            .filter(|(d, k)| d == dir && !k.starts_with('\u{1}'))
            .cloned()
            .collect()
    };
    let mut by_dir: BTreeMap<&str, Vec<(String, String)>> = BTreeMap::new();
    for (dir, p, f) in &loose_audio {
        by_dir.entry(dir).or_default().push((p.clone(), f.clone()));
    }
    let split: HashMap<String, String> = by_dir
        .iter()
        .filter(|(d, _)| split_books && !d.is_empty())
        .flat_map(|(d, files)| audio_keys(d, files))
        .collect();
    for (dir, p, format) in loose_audio {
        let book = split.get(&p).map_or(String::new(), |k| format!("\u{1}{k}"));
        let key = if dir.is_empty() {
            let stem = stem_key(&p);
            if works.contains_key(&(String::new(), stem.clone())) {
                (dir.clone(), stem)
            } else {
                (dir.clone(), format!("\u{0}{}", p.to_lowercase()))
            }
        } else {
            match text_in(&works, &dir).as_slice() {
                _ if !book.is_empty() => (dir.clone(), book),
                [only] => only.clone(),
                _ => (dir.clone(), String::new()),
            }
        };
        works
            .entry(key)
            .or_insert_with(|| Acc {
                dir,
                text: vec![],
                audio: vec![],
            })
            .audio
            .push((p, format));
    }
    let mut out: Vec<Work> = works.into_values().map(finish).collect();
    out.sort_by(|a, b| (&a.dir, &a.name_path).cmp(&(&b.dir, &b.name_path)));
    out
}

fn finish(a: Acc) -> Work {
    let mut versions: Vec<Version> = vec![];
    let mut text = a.text;
    text.sort_by_key(|(p, f)| (f.clone(), natural(p)));
    for (p, f) in text {
        versions.push(Version {
            family: Family::Text,
            format: f,
            files: vec![p],
        });
    }
    let mut by_format: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut whole: Vec<(String, String)> = vec![];
    for (p, f) in a.audio {
        if f == "m4b" {
            whole.push((p, f));
        } else {
            by_format.entry(f).or_default().push(p);
        }
    }
    whole.sort_by_key(|(p, _)| natural(p));
    let mut audio: Vec<Version> = whole
        .into_iter()
        .map(|(p, f)| Version {
            family: Family::Audio,
            format: f,
            files: vec![p],
        })
        .collect();
    for (format, mut files) in by_format {
        files.sort_by_key(|p| {
            let part = parse_path(p).part;
            (
                part.as_ref().and_then(|x| x.disc).unwrap_or(u32::MAX),
                part.as_ref().and_then(|x| x.number).unwrap_or(u32::MAX),
                natural(p),
            )
        });
        audio.push(Version {
            family: Family::Audio,
            format,
            files,
        });
    }
    audio.sort_by(|x, y| (&x.format, &x.files[0]).cmp(&(&y.format, &y.files[0])));
    versions.extend(audio);
    let name_path = versions
        .iter()
        .find(|v| v.family == Family::Text)
        .or_else(|| versions.iter().find(|v| v.format == "m4b"))
        .or_else(|| versions.first())
        .map(|v| v.files[0].clone())
        .unwrap_or_default();
    Work {
        dir: a.dir,
        name_path,
        versions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn classify_reads_the_extension() {
        assert_eq!(classify("A.EPUB"), Some((Family::Text, "epub".into())));
        assert_eq!(classify("a/b.m4b"), Some((Family::Audio, "m4b".into())));
        assert_eq!(classify("cover.jpg"), None);
        assert_eq!(classify(".epub"), None);
    }

    #[test]
    fn the_files_of_an_existing_media_group_without_the_split() {
        let p = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let two = p(&[
            "F/Book One.m4b",
            "F/Book Two.m4b",
            "F/A - 01.mp3",
            "F/A - 02.mp3",
        ]);
        assert_eq!(group_whole(&two).len(), 1);
        let parts = p(&["F/Title Part 1.m4b", "F/Title Part 2.m4b"]);
        assert_eq!(group(&parts).len(), 1);
        let renamed = p(&[
            "F/Old Title - 01.mp3",
            "F/Old Title - 02.mp3",
            "F/New Title - 01.flac",
            "F/New Title - 02.flac",
        ]);
        assert_eq!(group_whole(&renamed).len(), 1);
        assert_eq!(group(&renamed).len(), 2);
    }

    #[test]
    fn grouping_reproduces_expected() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/books-grouping/cases.json"
        );
        let mut fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let bless = std::env::var("BLESS").is_ok_and(|v| v == "1");
        let cases = fx["cases"].as_array().unwrap().clone();
        assert_eq!(cases.len(), 28);
        for (i, c) in cases.iter().enumerate() {
            let paths: Vec<String> = c["input"]["paths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap().to_owned())
                .collect();
            let got = json!(group(&paths));
            if bless {
                fx["cases"][i]["expected"] = got;
            } else {
                assert_eq!(got, c["expected"], "case {}", c["name"]);
            }
        }
        if bless {
            let mut out = String::from("{\"cases\":[\n");
            let list = fx["cases"].as_array().unwrap();
            for (i, c) in list.iter().enumerate() {
                out += &c.to_string();
                out += if i + 1 < list.len() { ",\n" } else { "\n" };
            }
            out += "]}\n";
            std::fs::write(path, out).unwrap();
        }
    }
}

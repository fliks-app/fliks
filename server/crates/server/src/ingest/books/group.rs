//! Files into works, editions and versions (`docs/spec/book-ingest.md` rules 1-4). Pure.
use fliks_domain::media::{AUDIO_EXTS, TEXT_EXTS, family::Family};
use regex::Regex;
use serde::Serialize;
use std::{collections::BTreeMap, sync::LazyLock};

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

fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

static DISC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(?:cd|disc|disk|disque)\s*0*(\d+)\b").unwrap());
static NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\(?\b(?:cd|disc|disk|disque)\s*\d+\b\)?|\bof\s+\d+\b").unwrap()
});

fn stem_of(path: &str) -> &str {
    split_language(path.rsplit('/').next().unwrap_or(path)).0
}

fn last_digits(s: &str) -> Option<(usize, u32)> {
    let end = s.rfind(|c: char| c.is_ascii_digit())? + 1;
    let start = s[..end]
        .trim_end_matches(|c: char| c.is_ascii_digit())
        .len();
    Some((start, s[start..end].parse().unwrap_or(u32::MAX)))
}

/// The disc and part number of an audio file: the disc from a `CD1` folder or a `Disc 1` in the name,
/// the part the last number of the name once the disc and ` of N` are off. Orders parts and guards merges.
pub(super) fn part_numbers(path: &str) -> (Option<u32>, Option<u32>) {
    let stem = stem_of(path);
    let mut segs: Vec<&str> = path.split('/').collect();
    segs.pop();
    let folder = segs.iter().rev().take_while(|s| is_disc(s)).find_map(|s| {
        s.trim_start_matches(|c: char| !c.is_ascii_digit())
            .trim()
            .parse::<u32>()
            .ok()
    });
    let disc = folder.or_else(|| DISC.captures(stem)?[1].parse().ok());
    let number = last_digits(&NOISE.replace_all(stem, " ")).map(|(_, n)| n);
    (disc, number)
}

/// The folder name a merged m4b is named after: the nearest one that is not a format name.
fn book_folder(dir: &str) -> &str {
    dir.rsplit('/')
        .find(|s| !super::merge::GENERIC.contains(&s.to_lowercase().as_str()))
        .unwrap_or("")
}

/// What tells the books of a folder apart: an `m4b` is its whole stem (empty when it is the folder's
/// name), a part is its stem before its last number (empty for a bare or generic one).
fn audio_key(path: &str, format: &str, dir: &str) -> String {
    if format == "m4b" {
        let key = norm(stem_of(path));
        return if key == norm(book_folder(dir)) {
            String::new()
        } else {
            key
        };
    }
    let stem = NOISE.replace_all(stem_of(path), " ");
    let Some((start, _)) = last_digits(&stem) else {
        return String::new();
    };
    let key = norm(&stem[..start]);
    let generic = [
        "track", "part", "partie", "chapter", "chapitre", "piste", "disc", "cd",
    ];
    if generic.contains(&key.as_str()) {
        String::new()
    } else {
        key
    }
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

struct Acc {
    dir: String,
    text: Vec<(String, String)>,
    audio: Vec<(String, String)>,
}

/// The works of `paths`, relative to one folder root and `/`-separated.
pub fn group(paths: &[String]) -> Vec<Work> {
    // Key: (dir, stem key) for text and for a root audio file, (dir, "") for the bare-numbered audio of a folder, (dir, "\0" + title) for the titled one.
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
    let texts: Vec<(String, String)> = works.keys().cloned().collect();
    let text_in = |dir: &str| -> Vec<(String, String)> {
        texts.iter().filter(|(d, _)| d == dir).cloned().collect()
    };
    let mut titles: BTreeMap<&str, std::collections::BTreeSet<String>> = BTreeMap::new();
    for (dir, p, format) in &loose_audio {
        let k = audio_key(p, format, dir);
        if !k.is_empty() {
            titles.entry(dir).or_default().insert(k);
        }
    }
    let several: Vec<String> = titles
        .into_iter()
        .filter(|(_, k)| k.len() > 1)
        .map(|(d, _)| d.to_owned())
        .collect();
    for (dir, p, format) in loose_audio {
        let key = if dir.is_empty() {
            let stem = stem_key(&p);
            if works.contains_key(&(String::new(), stem.clone())) {
                (dir.clone(), stem)
            } else {
                (dir.clone(), format!("\u{0}{}", p.to_lowercase()))
            }
        } else {
            match text_in(&dir).as_slice() {
                [only] => only.clone(),
                _ => match audio_key(&p, &format, &dir) {
                    k if k.is_empty() || !several.contains(&dir) => (dir.clone(), String::new()),
                    k => (dir.clone(), format!("\u{0}{k}")),
                },
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
            let (disc, number) = part_numbers(p);
            (
                disc.unwrap_or(u32::MAX),
                number.unwrap_or(u32::MAX),
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
    fn grouping_reproduces_expected() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/books-grouping/cases.json"
        );
        let mut fx: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let bless = std::env::var("BLESS").is_ok_and(|v| v == "1");
        let cases = fx["cases"].as_array().unwrap().clone();
        assert_eq!(cases.len(), 24);
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

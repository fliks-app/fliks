//! The volume and the issue number a comic path says (`comics.md` rules 16 and 31).
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicName {
    /// The volume: the folder holding the file, else the file name without its number.
    pub volume: String,
    pub year: Option<i32>,
    /// The volume number a `v2` or `Vol. 2` token says (folder first, then file name).
    pub volume_no: Option<i32>,
    /// The printed number (`"1"`, `"1.5"`), else the file stem.
    pub label: String,
    /// The decimal text of the sort key (`"1"`, `"-1"`); `None` when the name has no number, so a
    /// file named `Prologue` is never mistaken for issue `0`.
    pub sort: Option<String>,
    /// `issue`, `annual` or `special` (`comic_issues.kind`).
    pub kind: &'static str,
}

static GROUPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\([^)]*\)|\[[^\]]*\]").unwrap());
static YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(((?:19|20)\d\d)\)").unwrap());
static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\s#_-])(-?\d{1,4}(?:\.\d{1,2})?)(?:$|[\s_])").unwrap());
static VOL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[\s_])v(?:ol(?:ume)?\.?\s?)?(\d{1,3})(?:$|[\s_])").unwrap()
});
static OF_TOTAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s+of\s+\d{1,4}\s*$").unwrap());
static ANNUAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(annual|special)\b").unwrap());

fn tidy(s: &str) -> String {
    let s = GROUPS.replace_all(s, " ");
    s.replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn stem(file: &str) -> &str {
    file.rfind('.')
        .filter(|d| *d > 0)
        .map_or(file, |d| &file[..d])
}

/// The text with its `v2` / `Vol. 2` tokens blanked.
fn no_volume(s: &str) -> String {
    VOL.replace_all(s, " ").into_owned()
}

/// `001.50` is `1.5`, `-1` is `-1`; `-001` is `1` (a dash before a zero-padded number is a separator).
pub fn canonical(n: &str) -> Option<String> {
    let (neg, digits) = n.strip_prefix('-').map_or((false, n), |d| (true, d));
    let (int, frac) = digits.split_once('.').unwrap_or((digits, ""));
    let neg = neg && !int.starts_with('0');
    let int = int.trim_start_matches('0');
    let frac = frac.trim_end_matches('0');
    let int = if int.is_empty() { "0" } else { int };
    let out = if frac.is_empty() {
        int.to_owned()
    } else {
        format!("{int}.{frac}")
    };
    (out != "0" || !neg).then(|| if neg { format!("-{out}") } else { out })
}

/// `path` is relative to the library folder, `/` separated.
pub fn parse_path(path: &str) -> ComicName {
    let mut segs: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let file = segs.pop().unwrap_or("");
    let file_stem = stem(file);
    let bare = GROUPS.replace_all(file_stem, " ");
    let volume_no = |s: &str| VOL.captures(s).and_then(|c| c[1].parse().ok());
    let bare = no_volume(OF_TOTAL.replace(bare.trim_end(), "").as_ref());
    let found = NUMBER
        .captures_iter(&format!("{bare} "))
        .last()
        .and_then(|c| c.get(1))
        .map(|m| (m.start(), m.as_str().to_owned()))
        .and_then(|(at, n)| canonical(&n).map(|c| (at, c)));
    let (label, sort) = match &found {
        Some((_, n)) => (n.clone(), Some(n.clone())),
        None => (tidy(file_stem), None),
    };
    let label = if label.is_empty() {
        file.to_owned()
    } else {
        label
    };
    let from_file = || {
        let t = match found.as_ref() {
            Some((at, _)) => bare[..*at].to_owned(),
            None => bare.clone(),
        };
        let t = tidy(&ANNUAL.replace_all(&t, " "));
        t.trim_end_matches(['#', '-', ' ']).to_owned()
    };
    let (source, year_src) = match segs.last() {
        Some(dir) => (no_volume(dir), *dir),
        None => (from_file(), file_stem),
    };
    let volume = match segs.last() {
        Some(_) => tidy(&source),
        None => source,
    };
    let year = YEAR
        .captures(year_src)
        .or_else(|| YEAR.captures(file_stem))
        .and_then(|c| c[1].parse().ok());
    ComicName {
        volume: if volume.is_empty() {
            tidy(&no_volume(file_stem))
        } else {
            volume
        },
        year,
        volume_no: segs
            .last()
            .and_then(|d| volume_no(d))
            .or_else(|| volume_no(file_stem)),
        label,
        sort,
        kind: match ANNUAL.captures(file_stem) {
            Some(c) if c[1].eq_ignore_ascii_case("special") => "special",
            Some(_) => "annual",
            None => "issue",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_volumes() {
        let n = parse_path("Star Gardens (2016)/Star Gardens 001 (2016) (Digital).cbz");
        assert_eq!(
            (n.volume.as_str(), n.year, n.label.as_str()),
            ("Star Gardens", Some(2016), "1")
        );
        let n = parse_path("Vol/Star Gardens #1.5.cbz");
        assert_eq!((n.label.as_str(), n.sort.as_deref()), ("1.5", Some("1.5")));
        let n = parse_path("Vol/Star Gardens -1.cbz");
        assert_eq!(n.sort.as_deref(), Some("-1"));
        let n = parse_path("Vol/Star Gardens Annual 02.cbz");
        assert!(n.kind == "annual" && n.label == "2");
        let n = parse_path("Vol/Prologue.cbz");
        assert_eq!((n.label.as_str(), n.sort.as_deref()), ("Prologue", None));
        let n = parse_path("Moon Tales 12.cbz");
        assert_eq!((n.volume.as_str(), n.label.as_str()), ("Moon Tales", "12"));
    }
}

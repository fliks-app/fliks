//! Helpers shared by the provider parsers.
use super::{ParseError, Series};
use crate::language::normalize_language_code;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

pub fn json(body: &str) -> Result<Value, ParseError> {
    serde_json::from_str(body).map_err(|e| ParseError::Malformed(e.to_string()))
}

/// Trimmed text, `None` when blank.
pub fn clean(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

pub fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).and_then(clean)
}

/// A string or an array of strings, blanks dropped.
pub fn texts(v: &Value, key: &str) -> Vec<String> {
    match v.get(key) {
        Some(Value::String(s)) => clean(s).into_iter().collect(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .filter_map(clean)
            .collect(),
        _ => vec![],
    }
}

pub fn uint(v: &Value, key: &str) -> Option<u32> {
    v.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

pub fn push_unique(list: &mut Vec<String>, s: String) {
    if !list.contains(&s) {
        list.push(s);
    }
}

pub fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// ISBN-13 of an ISBN-10 or ISBN-13; `None` when the check digit fails.
pub fn isbn13(raw: &str) -> Option<String> {
    crate::books::isbn::parse(raw).map(|i| i.isbn13)
}

pub fn add_isbn(list: &mut Vec<String>, raw: &str) {
    if let Some(i) = isbn13(raw) {
        push_unique(list, i);
    }
}

/// Language name (as Audible sends it) or ISO 639 code to the app's code; `None` for undetermined.
pub fn language(raw: &str) -> Option<String> {
    let l = raw.trim().to_lowercase();
    let by_name = NAMES.iter().find(|(n, _)| *n == l).map(|(_, c)| *c);
    let code = by_name.map_or_else(|| normalize_language_code(Some(&l)), String::from);
    let ok = (2..=3).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_lowercase());
    (ok && code != "und" && code != "zxx").then_some(code)
}

const NAMES: &[(&str, &str)] = &[
    ("english", "en"),
    ("french", "fr"),
    ("german", "de"),
    ("spanish", "es"),
    ("castilian", "es"),
    ("italian", "it"),
    ("portuguese", "pt"),
    ("dutch", "nl"),
    ("japanese", "ja"),
    ("chinese", "zh"),
    ("russian", "ru"),
    ("polish", "pl"),
    ("swedish", "sv"),
    ("danish", "da"),
    ("norwegian", "no"),
    ("finnish", "fi"),
    ("hindi", "hi"),
    ("korean", "ko"),
    ("turkish", "tr"),
    ("arabic", "ar"),
    ("hebrew", "he"),
    ("czech", "cs"),
    ("greek", "el"),
    ("hungarian", "hu"),
    ("catalan", "ca"),
];

static ISO_DATE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?").unwrap());
static YEAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|\D)([12]\d{3})(?:\D|$)").unwrap());

/// Month prefixes, English and French, after accent folding.
const MONTHS: &[(&str, u32)] = &[
    ("jan", 1),
    ("feb", 2),
    ("fev", 2),
    ("mar", 3),
    ("apr", 4),
    ("avr", 4),
    ("may", 5),
    ("mai", 5),
    ("jun", 6),
    ("juin", 6),
    ("jul", 7),
    ("juil", 7),
    ("aug", 8),
    ("aou", 8),
    ("sep", 9),
    ("oct", 10),
    ("nov", 11),
    ("dec", 12),
];

fn valid_day(y: i32, m: u32, d: u32) -> bool {
    chrono::NaiveDate::from_ymd_opt(y, m, d).is_some()
}

/// `2019`, `March 2019`, `September 17, 1999`, `17 sept. 1999`, `2019-03-05T00:00:00Z`, `[2019?]` to `YYYY[-MM[-DD]]`.
pub fn partial_date(raw: &str) -> Option<String> {
    if let Some(c) = ISO_DATE.captures(raw) {
        let y: i32 = c[1].parse().ok()?;
        let m: u32 = c[2].parse().ok()?;
        if (1..=12).contains(&m) {
            let d = c.get(3).and_then(|d| d.as_str().parse::<u32>().ok());
            return Some(match d {
                Some(d) if valid_day(y, m, d) => format!("{y:04}-{m:02}-{d:02}"),
                _ => format!("{y:04}-{m:02}"),
            });
        }
    }
    let year: i32 = YEAR.captures(raw)?[1].parse().ok()?;
    let folded = raw
        .to_lowercase()
        .replace(['é', 'è'], "e")
        .replace('û', "u")
        .replace('ô', "o");
    let words = || folded.split(|c: char| !c.is_alphanumeric());
    let Some(month) = words().find_map(|w| {
        MONTHS
            .iter()
            .filter(|(p, _)| w.starts_with(p) && w.chars().all(|c| c.is_alphabetic()))
            .max_by_key(|(p, _)| p.len())
            .map(|(_, m)| *m)
    }) else {
        return Some(format!("{year:04}"));
    };
    let day = words()
        .filter(|w| w.len() <= 2)
        .find_map(|w| w.parse::<u32>().ok())
        .filter(|d| valid_day(year, month, *d));
    Some(match day {
        Some(d) => format!("{year:04}-{month:02}-{d:02}"),
        None => format!("{year:04}-{month:02}"),
    })
}

static LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(.+?)\s*(?:;|,|\s#)\s*(?:#|n°|no\.?|vol\.?|book|tome)?\s*(\d+(?:\.\d+)?)\s*$")
        .unwrap()
});

/// A free-text series statement (`Name ; 3`, `Name, #2`) to name and position; the whole text is the name otherwise.
pub fn series_label(label: &str) -> Option<Series> {
    let label = label.trim();
    let (name, position) = match LABEL.captures(label) {
        Some(c) => (c[1].trim().to_string(), Some(c[2].to_string())),
        None => (label.to_string(), None),
    };
    (!name.is_empty()).then_some(Series {
        name,
        position,
        id: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_dates() {
        let d = |s| partial_date(s);
        assert_eq!(d("2019").as_deref(), Some("2019"));
        assert_eq!(d("March 2019").as_deref(), Some("2019-03"));
        assert_eq!(d("September 17, 1999").as_deref(), Some("1999-09-17"));
        assert_eq!(d("17 déc. 2001").as_deref(), Some("2001-12-17"));
        assert_eq!(d("[2019?]").as_deref(), Some("2019"));
        assert_eq!(d("c1999").as_deref(), Some("1999"));
        assert_eq!(d("2017-05-11T00:00:00.000Z").as_deref(), Some("2017-05-11"));
        assert_eq!(d("2019-13").as_deref(), Some("2019"));
        assert_eq!(d("unknown"), None);
    }

    #[test]
    fn series_labels() {
        let s = |l| series_label(l).map(|s| (s.name, s.position));
        assert_eq!(s("Saga ; 3"), Some(("Saga".into(), Some("3".into()))));
        assert_eq!(s("Saga, #2.5"), Some(("Saga".into(), Some("2.5".into()))));
        assert_eq!(
            s("Marlowe classics"),
            Some(("Marlowe classics".into(), None))
        );
    }

    #[test]
    fn languages() {
        assert_eq!(language("french").as_deref(), Some("fr"));
        assert_eq!(language("fre").as_deref(), Some("fr"));
        assert_eq!(language("en-US").as_deref(), Some("en"));
        assert_eq!(language("und"), None);
        assert_eq!(language("klingonese"), None);
    }
}

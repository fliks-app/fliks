//! Title expectations against release titles (`release-rejection.helper.ts`).
use crate::js::{rx, trim};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

const STOPWORDS: [&str; 27] = [
    "a", "au", "aux", "de", "des", "du", "la", "le", "les", "l", "un", "une", "et", "ou", "en",
    "d", "s", "the", "an", "of", "and", "or", "in", "on", "at", "to", "for",
];

/// NFD, combining marks U+0300-U+036F dropped, lower-cased.
fn fold_case(s: &str) -> String {
    s.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
}

fn tokenize(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
        .collect()
}

/// Apostrophe removed, then apostrophe as a separator: `X's` and `d'eau` both match.
fn title_readings(title: &str) -> [Vec<String>; 2] {
    let folded = fold_case(title);
    let glued: String = folded.chars().filter(|c| !"'‘’ʼ".contains(*c)).collect();
    [tokenize(&glued), tokenize(&folded)]
}

fn significant_tokens(tokens: &[String]) -> Vec<String> {
    let kept: Vec<String> = tokens
        .iter()
        .filter(|t| t.len() > 1 && !STOPWORDS.contains(&t.as_str()))
        .cloned()
        .collect();
    if kept.is_empty() {
        tokens.to_vec()
    } else {
        kept
    }
}

/// NFKC, lower-cased, letters and digits only.
fn fold_title(s: &str) -> String {
    let lower = s.nfkc().collect::<String>().to_lowercase();
    rx!(r"[^\p{L}\p{N}]").replace_all(&lower, "").into_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TitleExpectationIndex {
    pub readings: Vec<Vec<String>>,
    pub numbers: BTreeSet<String>,
    pub vacuous: bool,
    pub folded: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WhenUnreadable {
    Match,
    NoMatch,
}

pub fn index_title_expectations(expected: &[String]) -> TitleExpectationIndex {
    let candidates: Vec<&String> = expected.iter().filter(|s| !trim(s).is_empty()).collect();
    if candidates.is_empty() {
        return TitleExpectationIndex {
            readings: vec![],
            numbers: BTreeSet::new(),
            vacuous: true,
            folded: vec![],
        };
    }
    let (mut readings, mut numbers) = (vec![], BTreeSet::new());
    for cand in &candidates {
        for reading in title_readings(cand) {
            numbers.extend(
                reading
                    .iter()
                    .filter(|t| t.bytes().all(|b| b.is_ascii_digit()))
                    .cloned(),
            );
            let tokens = significant_tokens(&reading);
            if !tokens.is_empty() {
                readings.push(tokens);
            }
        }
    }
    TitleExpectationIndex {
        readings,
        numbers,
        vacuous: false,
        folded: candidates
            .iter()
            .map(|c| fold_title(c))
            .filter(|f| !f.is_empty())
            .collect(),
    }
}

/// Whether the folded form of any expected title occurs in the release title (fallback for unreadable titles).
pub(super) fn folded_contains(index: &TitleExpectationIndex, release_title: &str) -> bool {
    let folded = fold_title(release_title);
    index.folded.iter().any(|f| folded.contains(f.as_str()))
}

pub fn release_title_tokens(title: &str) -> BTreeSet<String> {
    title_readings(title).into_iter().flatten().collect()
}

pub fn matches_indexed_expectation(
    tokens: &BTreeSet<String>,
    index: &TitleExpectationIndex,
    when_unreadable: WhenUnreadable,
) -> bool {
    index.vacuous
        || index
            .readings
            .iter()
            .any(|r| r.iter().all(|t| tokens.contains(t)))
        || (index.readings.is_empty() && when_unreadable == WhenUnreadable::Match)
}

/// Index of the release token after the expected tokens, found in order with gaps allowed.
fn token_after_expectation(release: &[String], expected: &[String]) -> Option<usize> {
    let mut at = 0;
    for token in expected {
        at += release.get(at..)?.iter().position(|t| t == token)? + 1;
    }
    Some(at)
}

fn is_sequel_number(t: &str) -> bool {
    let b = t.as_bytes();
    matches!(t, "ii" | "iii" | "iv" | "vi" | "vii" | "viii" | "ix")
        || (b.len() == 1 && (b'2'..=b'9').contains(&b[0]))
        || (b.len() == 2 && (b'1'..=b'9').contains(&b[0]) && b[1].is_ascii_digit())
}

/// The sequel number a release appends to the expected title (`Nova Skyline 2`), if every reading agrees.
pub fn appended_sequel_number(
    release_title: &str,
    index: &TitleExpectationIndex,
) -> Option<String> {
    if index.vacuous || index.readings.is_empty() {
        return None;
    }
    let mut found: Option<String> = None;
    for release in title_readings(release_title) {
        for expected in &index.readings {
            let Some(at) = token_after_expectation(&release, expected) else {
                continue;
            };
            match release.get(at) {
                Some(next)
                    if is_sequel_number(next)
                        && !expected.contains(next)
                        && !index.numbers.contains(next) =>
                {
                    found.get_or_insert_with(|| next.clone());
                }
                _ => return None,
            }
        }
    }
    found
}

pub fn collection_pack_word(release_title: &str, index: &TitleExpectationIndex) -> Option<String> {
    const WORDS: [&str; 11] = [
        "collection",
        "collections",
        "duology",
        "trilogy",
        "quadrilogy",
        "tetralogy",
        "pentalogy",
        "hexalogy",
        "anthology",
        "saga",
        "filmography",
    ];
    title_readings(release_title)
        .into_iter()
        .flatten()
        .find(|t| WORDS.contains(&t.as_str()) && !index.readings.iter().flatten().any(|e| e == t))
}

/// Years 1900-2099 on an ASCII word boundary; `1080p` and `x264` never read as one.
pub fn release_years(title: &str) -> Vec<u32> {
    rx!(r"\b(?:19|20)\d{2}\b")
        .find_iter(title)
        .map(|m| m.as_str().parse().expect("4 digits"))
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMedia {
    #[serde(default)]
    pub original_title: Option<String>,
    pub title: String,
    #[serde(default)]
    pub alternative_titles: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTitles {
    pub search_title: String,
    pub expected_titles: Vec<String>,
}

pub fn resolve_search_titles(media: &SearchMedia, custom_query: Option<&str>) -> SearchTitles {
    let custom = custom_query.map(trim).filter(|c| !c.is_empty());
    if let Some(c) = custom {
        return SearchTitles {
            search_title: c.to_owned(),
            expected_titles: vec![c.to_owned()],
        };
    }
    let expected_titles: Vec<String> = media
        .original_title
        .iter()
        .chain([&media.title])
        .chain(media.alternative_titles.iter().flatten())
        .filter(|t| !t.is_empty())
        .cloned()
        .collect();
    let search_title = expected_titles
        .iter()
        .find(|t| {
            !index_title_expectations(std::slice::from_ref(t))
                .readings
                .is_empty()
        })
        .cloned()
        .unwrap_or_else(|| {
            media
                .original_title
                .clone()
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| media.title.clone())
        });
    SearchTitles {
        search_title,
        expected_titles,
    }
}

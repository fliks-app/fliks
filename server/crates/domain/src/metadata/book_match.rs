//! How well a provider's work fits a book's hints (`book-metadata.md` rule 12).
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

/// The least score a title and author search may link on.
pub const MIN_CONFIDENCE: u8 = 85;

const STOPWORDS: [&str; 14] = [
    "le", "la", "les", "l", "un", "une", "des", "de", "du", "the", "a", "an", "of", "and",
];

fn words(s: &str, drop: impl Fn(&str) -> bool) -> BTreeSet<String> {
    s.nfd()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .collect::<String>()
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && !drop(w))
        .map(String::from)
        .collect()
}

fn title_words(s: &str) -> BTreeSet<String> {
    words(s, |w| STOPWORDS.contains(&w))
}

/// Initials (`K.`) are dropped so `Ursula K. Le Guin` equals `Ursula Le Guin`.
fn name_words(s: &str) -> BTreeSet<String> {
    words(s, |w| w.chars().count() < 2)
}

/// Words in common over words in either; 0 when either side is empty.
fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> f64 {
    let all = a.union(b).count();
    if a.is_empty() || b.is_empty() {
        0.0
    } else {
        a.intersection(b).count() as f64 / all as f64
    }
}

/// What a file or tag says of the book.
pub struct Hints<'a> {
    pub title: &'a str,
    pub authors: &'a [String],
    pub year: Option<i32>,
}

/// What a provider says of a work.
pub struct Candidate<'a> {
    pub title: &'a str,
    pub subtitle: Option<&'a str>,
    pub authors: &'a [String],
    pub year: Option<i32>,
}

/// 0 to 100: the title up to 60 (the better of the title and `title: subtitle`), the authors up to 30
/// (the share of the hinted ones the work lists; 15 when none is hinted), the year 10 within a year of
/// the hint, 5 when either is unknown.
pub fn score(h: &Hints, c: &Candidate) -> u8 {
    let wanted = title_words(h.title);
    let full = c.subtitle.map(|s| title_words(&format!("{} {s}", c.title)));
    let title = [Some(title_words(c.title)), full]
        .into_iter()
        .flatten()
        .map(|t| jaccard(&wanted, &t))
        .fold(0.0, f64::max);
    let listed: Vec<_> = c.authors.iter().map(|a| name_words(a)).collect();
    let authors = if h.authors.is_empty() {
        0.5
    } else {
        let found = h
            .authors
            .iter()
            .filter(|a| {
                let a = name_words(a);
                !a.is_empty() && listed.contains(&a)
            })
            .count();
        found as f64 / h.authors.len() as f64
    };
    let year = match (h.year, c.year) {
        (Some(a), Some(b)) if (a - b).abs() <= 1 => 10,
        (Some(_), Some(_)) => 0,
        _ => 5,
    };
    (title * 60.0 + authors * 30.0).round() as u8 + year
}

#[cfg(test)]
mod tests {
    use super::*;

    type Hint<'a> = (&'a str, &'a [&'a str], Option<i32>);

    fn s(
        title: &str,
        subtitle: Option<&str>,
        authors: &[&str],
        year: Option<i32>,
        hint: Hint,
    ) -> u8 {
        let owned = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (ha, ca) = (owned(hint.1), owned(authors));
        score(
            &Hints {
                title: hint.0,
                authors: &ha,
                year: hint.2,
            },
            &Candidate {
                title,
                subtitle,
                authors: &ca,
                year,
            },
        )
    }

    #[test]
    fn a_title_and_an_author_link_and_a_title_alone_does_not() {
        let ok = s(
            "Le Premier Livre",
            None,
            &["Jean de Alpha-Beta"],
            Some(1943),
            ("Premier livre", &["Jean de Alpha Beta"], None),
        );
        assert!(ok >= MIN_CONFIDENCE, "{ok}");
        let bare = s(
            "Le Premier Livre",
            None,
            &["A"],
            Some(1943),
            ("Premier livre", &[], None),
        );
        assert!(bare < MIN_CONFIDENCE, "{bare}");
    }

    #[test]
    fn another_title_or_author_stays_below() {
        let hint: Hint = ("Alpha", &["Jane Roe"], Some(1965));
        assert!(s("Alpha Two", None, &["Jane Roe"], Some(1969), hint) < MIN_CONFIDENCE);
        assert!(s("Alpha", None, &["John Roe"], Some(1965), hint) < MIN_CONFIDENCE);
        assert!(s("Alpha", None, &["Jane Roe"], Some(1965), hint) >= MIN_CONFIDENCE);
    }

    #[test]
    fn a_subtitle_and_initials_are_forgiven() {
        let hint: Hint = ("A Tale of Alpha: The Cycle", &["Una Roe"], None);
        let got = s(
            "A Tale of Alpha",
            Some("The Cycle"),
            &["Una K. Roe"],
            None,
            hint,
        );
        assert!(got >= MIN_CONFIDENCE, "{got}");
    }
}

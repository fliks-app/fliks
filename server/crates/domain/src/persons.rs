//! Person search and refresh rules (`docs/spec/persons.md`).
use crate::media::kind::MediaKind;

/// A person is refreshed when never refreshed or older than 7 days (rule 10).
pub const REFRESH_AFTER_MS: i64 = 7 * 86_400_000;

pub fn needs_refresh(refreshed_at_ms: Option<i64>, now_ms: i64) -> bool {
    refreshed_at_ms.is_none_or(|t| now_ms - t > REFRESH_AFTER_MS)
}

/// `to_tsquery('simple', ..)` text for `q`: every letter/digit/`-`/`_` run is a quoted prefix term, all ANDed.
/// `None` when no usable word is left; operators in `q` are never interpreted.
pub fn tsquery(q: &str) -> Option<String> {
    let runs: Vec<String> = q
        .split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'))
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .map(|w| format!("'{w}':*"))
        .collect();
    (!runs.is_empty()).then(|| runs.join(" & "))
}

const PARTICLES: [&str; 16] = [
    "de", "du", "des", "del", "della", "di", "da", "van", "von", "der", "den", "ter", "la", "le",
    "el", "al",
];

/// The sort form of a name: `Le Guin, Ursula K.` for `Ursula K. Le Guin`, a lowercase particle after
/// the given names (`La Fontaine, Jean de`). `None` for one word or a name that already has a comma.
pub fn sort_name(name: &str) -> Option<String> {
    let words: Vec<&str> = name.split_whitespace().collect();
    if words.len() < 2 || name.contains(',') {
        return None;
    }
    let particle = |w: &str| PARTICLES.contains(&w.to_lowercase().as_str());
    let mut start = words.len() - 1;
    while start > 1 && particle(words[start - 1]) {
        start -= 1;
    }
    let (given, family) = words.split_at(start);
    let lead = family[..family.len() - 1]
        .iter()
        .take_while(|w| w.chars().next().is_some_and(char::is_lowercase))
        .count();
    let (tail, family) = family.split_at(lead);
    let rest: Vec<&str> = given.iter().chain(tail).copied().collect();
    Some(format!("{}, {}", family.join(" "), rest.join(" ")))
}

/// A media row a credit can link to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owned {
    pub id: i32,
    pub kind: MediaKind,
    pub external_id: i64,
}

/// The owned media of a credit, matched on `(type, id)`; the last row wins.
pub fn link(owned: &[Owned], external_id: i64, kind: MediaKind) -> Option<i32> {
    owned
        .iter()
        .rfind(|m| m.external_id == external_id && m.kind == kind)
        .map(|m| m.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_boundary() {
        let now = 10 * REFRESH_AFTER_MS;
        assert!(needs_refresh(None, now));
        assert!(!needs_refresh(Some(now - REFRESH_AFTER_MS), now));
        assert!(needs_refresh(Some(now - REFRESH_AFTER_MS - 1), now));
        assert!(!needs_refresh(Some(now), now));
    }

    #[test]
    fn sort_names() {
        for (name, want) in [
            ("Victor Hugo", Some("Hugo, Victor")),
            ("Ursula K. Le Guin", Some("Le Guin, Ursula K.")),
            ("Jean de La Fontaine", Some("La Fontaine, Jean de")),
            ("Ludwig van Beethoven", Some("Beethoven, Ludwig van")),
            ("bell hooks", Some("hooks, bell")),
            ("Homer", None),
            ("Hugo, Victor", None),
            ("  ", None),
        ] {
            assert_eq!(sort_name(name).as_deref(), want, "{name}");
        }
    }

    #[test]
    fn tsquery_words() {
        for (q, want) in [
            ("cla", Some("'cla':*")),
            ("  Jean   Luc ", Some("'Jean':* & 'Luc':*")),
            ("o'brien", Some("'o':* & 'brien':*")),
            ("jean-luc", Some("'jean-luc':*")),
            ("a&", Some("'a':*")),
            ("a|b", Some("'a':* & 'b':*")),
            ("!a", Some("'a':*")),
            ("(", None),
            ("'", None),
            (":", None),
            ("", None),
            ("   ", None),
            ("a\\b", Some("'a':* & 'b':*")),
            ("Amélie", Some("'Amélie':*")),
            ("a<->b", Some("'a':* & 'b':*")),
            ("-", None),
            ("_-_", None),
        ] {
            assert_eq!(tsquery(q).as_deref(), want, "{q:?}");
        }
    }

    #[test]
    fn links_by_type_and_id() {
        let owned = [
            Owned {
                id: 1,
                kind: MediaKind::Movie,
                external_id: 603,
            },
            Owned {
                id: 2,
                kind: MediaKind::Series,
                external_id: 603,
            },
            Owned {
                id: 3,
                kind: MediaKind::Series,
                external_id: 603,
            },
        ];
        assert_eq!(link(&owned, 603, MediaKind::Movie), Some(1));
        assert_eq!(link(&owned, 603, MediaKind::Series), Some(3));
        assert_eq!(link(&owned, 7, MediaKind::Series), None);
        assert_eq!(link(&[], 603, MediaKind::Movie), None);
    }
}

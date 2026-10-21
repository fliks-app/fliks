//! Person search and refresh rules (`docs/spec/persons.md`).

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

/// A media row a credit can link to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owned {
    pub id: i32,
    pub is_series: bool,
    pub external_id: i64,
}

/// The owned media of a credit, matched on `(type, id)`; the last row wins.
pub fn link(owned: &[Owned], external_id: i64, is_series: bool) -> Option<i32> {
    owned
        .iter()
        .rfind(|m| m.external_id == external_id && m.is_series == is_series)
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
                is_series: false,
                external_id: 603,
            },
            Owned {
                id: 2,
                is_series: true,
                external_id: 603,
            },
            Owned {
                id: 3,
                is_series: true,
                external_id: 603,
            },
        ];
        assert_eq!(link(&owned, 603, false), Some(1));
        assert_eq!(link(&owned, 603, true), Some(3));
        assert_eq!(link(&owned, 7, true), None);
        assert_eq!(link(&[], 603, false), None);
    }
}

//! The id namespaces an entity is known by outside Fliks, as stored in `media_external_ids.provider`.
use std::fmt;

use crate::{books::isbn, js::rx};

/// The largest id of a numeric provider: nine digits, as `media_external_ids` checks.
pub const MAX_NUMERIC_ID: i32 = 999_999_999;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExternalProvider {
    Tmdb,
    Tvdb,
    Imdb,
    OpenLibrary,
    GoogleBooks,
    Bnf,
    Audible,
    Audnexus,
    Isbn,
    Asin,
    /// Provenance of a value read from a file; never stored as an id.
    File,
}

impl ExternalProvider {
    pub const ALL: [Self; 11] = [
        Self::Tmdb,
        Self::Tvdb,
        Self::Imdb,
        Self::OpenLibrary,
        Self::GoogleBooks,
        Self::Bnf,
        Self::Audible,
        Self::Audnexus,
        Self::Isbn,
        Self::Asin,
        Self::File,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tmdb => "tmdb",
            Self::Tvdb => "tvdb",
            Self::Imdb => "imdb",
            Self::OpenLibrary => "openlibrary",
            Self::GoogleBooks => "googlebooks",
            Self::Bnf => "bnf",
            Self::Audible => "audible",
            Self::Audnexus => "audnexus",
            Self::Isbn => "isbn",
            Self::Asin => "asin",
            Self::File => "file",
        }
    }

    /// The provider as messages name it.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Tmdb => "TMDB",
            Self::Tvdb => "TVDB",
            Self::Imdb => "IMDb",
            Self::OpenLibrary => "Open Library",
            Self::GoogleBooks => "Google Books",
            Self::Bnf => "BnF",
            Self::Audible => "Audible",
            Self::Audnexus => "Audnexus",
            Self::Isbn => "ISBN",
            Self::Asin => "ASIN",
            Self::File => "file",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == s)
    }

    /// Whether the provider's ids are positive integers (`media_external_ids` checks it).
    pub const fn is_numeric(self) -> bool {
        matches!(self, Self::Tmdb | Self::Tvdb)
    }

    /// Whether one id names at most one media of a kind: TMDB and OpenLibrary do, the others do not
    /// (TMDB splits a TVDB show into several, and a title can be catalogued twice).
    pub const fn is_unique(self) -> bool {
        matches!(self, Self::Tmdb | Self::OpenLibrary)
    }

    /// `value` as stored for this provider, or `None` when it is not an id of it.
    pub fn normalize(self, value: &str) -> Option<String> {
        let ok = match self {
            Self::Tmdb | Self::Tvdb => {
                (1..=9).contains(&value.len())
                    && !value.starts_with('0')
                    && value.bytes().all(|b| b.is_ascii_digit())
            }
            Self::Imdb => !value.is_empty(),
            Self::Isbn => return isbn::parse(value).map(|i| i.isbn13),
            Self::Asin => rx!(r"^[0-9A-Z]{10}$").is_match(value),
            Self::OpenLibrary => rx!(r"^OL[1-9][0-9]*[WMA]$").is_match(value),
            Self::Bnf => rx!(r"^cb[0-9a-z]+$").is_match(value),
            Self::GoogleBooks => rx!(r"^[A-Za-z0-9_-]{1,32}$").is_match(value),
            Self::Audible | Self::Audnexus | Self::File => false,
        };
        ok.then(|| value.to_owned())
    }
}

impl fmt::Display for ExternalProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::ExternalProvider as P;

    #[test]
    fn names_round_trip() {
        for p in P::ALL {
            assert_eq!(P::parse(p.as_str()), Some(p));
        }
        assert_eq!(P::parse("TMDB"), None);
        assert_eq!(P::Imdb.label(), "IMDb");
    }

    #[test]
    fn only_tmdb_and_openlibrary_are_unique() {
        let unique: Vec<_> = P::ALL.into_iter().filter(|p| p.is_unique()).collect();
        assert_eq!(unique, [P::Tmdb, P::OpenLibrary]);
    }

    #[test]
    fn book_ids_are_normalized_per_namespace() {
        assert_eq!(
            P::Isbn.normalize("0-306-40615-2").as_deref(),
            Some("9780306406157")
        );
        assert_eq!(P::Isbn.normalize("9780306406158"), None);
        assert_eq!(
            P::Asin.normalize("B002V0QK4C").as_deref(),
            Some("B002V0QK4C")
        );
        for bad in ["b002v0qk4c", "B002V0QK4", "B002V0QK4CC"] {
            assert_eq!(P::Asin.normalize(bad), None, "{bad}");
        }
        for ok in ["OL45883W", "OL7353617M", "OL26320A"] {
            assert_eq!(P::OpenLibrary.normalize(ok).as_deref(), Some(ok));
        }
        for bad in ["OL0W", "OL12", "ol12W", "OL12X"] {
            assert_eq!(P::OpenLibrary.normalize(bad), None, "{bad}");
        }
        assert_eq!(
            P::Bnf.normalize("cb123456789").as_deref(),
            Some("cb123456789")
        );
        assert_eq!(P::Bnf.normalize("CB1"), None);
        assert_eq!(P::GoogleBooks.normalize("a-Z_9").as_deref(), Some("a-Z_9"));
        assert_eq!(P::GoogleBooks.normalize(&"a".repeat(33)), None);
        for p in [P::Audible, P::Audnexus, P::File] {
            assert_eq!(p.normalize("B002V0QK4C"), None, "{p}");
        }
    }

    #[test]
    fn numeric_ids_are_canonical_positive_integers() {
        assert_eq!(P::Tmdb.normalize("603").as_deref(), Some("603"));
        for bad in ["", "0", "012", "-1", "1.5", "1234567890", "tt1"] {
            assert_eq!(P::Tvdb.normalize(bad), None, "{bad}");
        }
        assert_eq!(P::Imdb.normalize("tt0133093").as_deref(), Some("tt0133093"));
        assert_eq!(P::Imdb.normalize(""), None);
    }
}

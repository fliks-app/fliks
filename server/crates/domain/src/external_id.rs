//! The id namespaces an entity is known by outside Fliks, as stored in `media_external_ids.provider`.
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExternalProvider {
    Tmdb,
    Tvdb,
    Imdb,
}

impl ExternalProvider {
    pub const ALL: [Self; 3] = [Self::Tmdb, Self::Tvdb, Self::Imdb];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Tmdb => "tmdb",
            Self::Tvdb => "tvdb",
            Self::Imdb => "imdb",
        }
    }

    /// The provider as messages name it.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Tmdb => "TMDB",
            Self::Tvdb => "TVDB",
            Self::Imdb => "IMDb",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.as_str() == s)
    }

    /// Whether the provider's ids are positive integers (`media_external_ids` checks it).
    pub const fn is_numeric(self) -> bool {
        match self {
            Self::Tmdb | Self::Tvdb => true,
            Self::Imdb => false,
        }
    }

    /// Whether one id names at most one media of a kind: TMDB does, TVDB and IMDb do not (TMDB
    /// splits a TVDB show into several, and a title can be catalogued twice).
    pub const fn is_unique(self) -> bool {
        match self {
            Self::Tmdb => true,
            Self::Tvdb | Self::Imdb => false,
        }
    }

    /// `value` as stored for this provider, or `None` when it is not an id of it.
    pub fn normalize(self, value: &str) -> Option<String> {
        let ok = !self.is_numeric()
            || ((1..=9).contains(&value.len())
                && !value.starts_with('0')
                && value.bytes().all(|b| b.is_ascii_digit()));
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
    fn only_tmdb_is_unique() {
        let unique: Vec<_> = P::ALL.into_iter().filter(|p| p.is_unique()).collect();
        assert_eq!(unique, [P::Tmdb]);
    }

    #[test]
    fn numeric_ids_are_canonical_positive_integers() {
        assert_eq!(P::Tmdb.normalize("603").as_deref(), Some("603"));
        for bad in ["", "0", "012", "-1", "1.5", "1234567890", "tt1"] {
            assert_eq!(P::Tvdb.normalize(bad), None, "{bad}");
        }
        assert_eq!(P::Imdb.normalize("tt0133093").as_deref(), Some("tt0133093"));
        assert_eq!(P::Imdb.normalize("").as_deref(), Some(""));
    }
}

//! The id namespaces an entity is known by outside Fliks, as stored in `media_external_ids.provider`.
use std::{
    collections::HashMap,
    fmt,
    sync::{Arc, LazyLock, RwLock},
};

use crate::{
    books::isbn,
    js::rx,
    plugins::provider::{Class, IdRule, classify},
};

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

/// A plugin's `<pluginId>:<name>`, interned when its manifest or `provider_namespaces` row declares it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PluginNamespace(&'static str);

/// The id namespaces of declared plugins; names are leaked once, bounded by what manifests declare.
static PLUGIN: LazyLock<RwLock<HashMap<&'static str, Arc<IdRule>>>> =
    LazyLock::new(Default::default);

/// An id namespace: one the core knows, or one a plugin declared (`provider-plugins.md` rule 23).
/// `Copy`, so registry keys and orders carry it as they carried `ExternalProvider`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Namespace {
    Core(ExternalProvider),
    Plugin(PluginNamespace),
}

impl Namespace {
    pub const TMDB: Self = Self::Core(ExternalProvider::Tmdb);
    pub const TVDB: Self = Self::Core(ExternalProvider::Tvdb);
    pub const IMDB: Self = Self::Core(ExternalProvider::Imdb);
    pub const OPENLIBRARY: Self = Self::Core(ExternalProvider::OpenLibrary);
    pub const GOOGLEBOOKS: Self = Self::Core(ExternalProvider::GoogleBooks);
    pub const BNF: Self = Self::Core(ExternalProvider::Bnf);
    pub const AUDIBLE: Self = Self::Core(ExternalProvider::Audible);
    pub const AUDNEXUS: Self = Self::Core(ExternalProvider::Audnexus);
    pub const ISBN: Self = Self::Core(ExternalProvider::Isbn);
    pub const ASIN: Self = Self::Core(ExternalProvider::Asin);
    pub const FILE: Self = Self::Core(ExternalProvider::File);

    /// Declares a plugin namespace (or refreshes its pattern); `None` for a name that is no plugin
    /// namespace or a pattern `IdRule` refuses.
    pub fn declare(name: &str, id_pattern: &str, case: &str) -> Option<Self> {
        let Some(Class::Plugin { .. }) = classify(name) else {
            return None;
        };
        let rule = Arc::new(IdRule::new(id_pattern, case)?);
        let mut map = PLUGIN.write().unwrap_or_else(|e| e.into_inner());
        let key = match map.get_key_value(name) {
            Some((k, _)) => *k,
            None => Box::leak(name.to_owned().into_boxed_str()),
        };
        map.insert(key, rule);
        Some(Self::Plugin(PluginNamespace(key)))
    }

    /// A core name, or a plugin namespace already declared.
    pub fn parse(s: &str) -> Option<Self> {
        if let Some(p) = ExternalProvider::parse(s) {
            return Some(Self::Core(p));
        }
        let map = PLUGIN.read().unwrap_or_else(|e| e.into_inner());
        map.get_key_value(s)
            .map(|(k, _)| Self::Plugin(PluginNamespace(k)))
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Core(p) => p.as_str(),
            Self::Plugin(p) => p.0,
        }
    }

    /// The namespace as messages name it; a plugin's `label` is stored, not kept here.
    pub const fn label(self) -> &'static str {
        match self {
            Self::Core(p) => p.label(),
            Self::Plugin(p) => p.0,
        }
    }

    pub const fn core(self) -> Option<ExternalProvider> {
        match self {
            Self::Core(p) => Some(p),
            Self::Plugin(_) => None,
        }
    }

    /// A plugin namespace is never unique (`provider-plugins.md` rule 25).
    pub const fn is_unique(self) -> bool {
        match self {
            Self::Core(p) => p.is_unique(),
            Self::Plugin(_) => false,
        }
    }

    /// `value` as stored: the core's rule, or the plugin's `idPattern` (`provider-plugins.md` rule 28).
    pub fn normalize(self, value: &str) -> Option<String> {
        match self {
            Self::Core(p) => p.normalize(value),
            Self::Plugin(p) => {
                let rule = PLUGIN
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(p.0)
                    .cloned()?;
                rule.normalize(value)
            }
        }
    }
}

impl From<ExternalProvider> for Namespace {
    fn from(p: ExternalProvider) -> Self {
        Self::Core(p)
    }
}

impl fmt::Display for Namespace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
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
    fn plugin_namespaces_parse_once_declared_and_are_never_unique() {
        use super::Namespace as N;
        assert_eq!(N::parse("tmdb"), Some(N::TMDB));
        assert_eq!(N::parse("org.ns.test:aid"), None);
        let ns = N::declare("org.ns.test:aid", "^[1-9][0-9]{0,8}$", "preserve").unwrap();
        assert_eq!(N::parse("org.ns.test:aid"), Some(ns));
        assert!(!ns.is_unique());
        assert_eq!(ns.normalize(" 42 ").as_deref(), Some("42"));
        assert_eq!(ns.normalize("042"), None);
        assert_eq!(N::declare("tmdb", "^.+$", "preserve"), None);
        assert_eq!(
            N::declare("org.ns.test:bad", "no anchors", "preserve"),
            None
        );
        assert_eq!(N::TMDB.normalize("603").as_deref(), Some("603"));
    }

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

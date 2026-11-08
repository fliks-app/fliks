//! The id namespaces an entity is known by outside Fliks, as stored in `media_external_ids.provider`.
use std::{collections::HashMap, fmt, sync::Arc};

use crate::{
    books::isbn,
    js::rx,
    plugins::{
        MAX_PLUGIN_ID,
        provider::{Class, IdRule, MAX_NAMESPACE_NAME, classify},
    },
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
    MusicBrainz,
    Isrc,
    Spotify,
    Deezer,
    FanartTv,
    /// Provenance of a value read from a file; never stored as an id.
    File,
}

impl ExternalProvider {
    pub const ALL: [Self; 16] = [
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
        Self::MusicBrainz,
        Self::Isrc,
        Self::Spotify,
        Self::Deezer,
        Self::FanartTv,
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
            Self::MusicBrainz => "musicbrainz",
            Self::Isrc => "isrc",
            Self::Spotify => "spotify",
            Self::Deezer => "deezer",
            Self::FanartTv => "fanarttv",
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
            Self::MusicBrainz => "MusicBrainz",
            Self::Isrc => "ISRC",
            Self::Spotify => "Spotify",
            Self::Deezer => "Deezer",
            Self::FanartTv => "Fanart.tv",
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
        matches!(self, Self::Tmdb | Self::OpenLibrary | Self::MusicBrainz)
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
            // A MusicBrainz id is a UUID, stored in lower case; Fanart.tv keys its images by it.
            Self::MusicBrainz | Self::FanartTv => {
                return rx!(
                    r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"
                )
                .is_match(value)
                .then(|| value.to_ascii_lowercase());
            }
            Self::Isrc => {
                let v: String = value
                    .chars()
                    .filter(|c| *c != '-')
                    .map(|c| c.to_ascii_uppercase())
                    .collect();
                return rx!(r"^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$")
                    .is_match(&v)
                    .then_some(v);
            }
            Self::Spotify => rx!(r"^[0-9A-Za-z]{22}$").is_match(value),
            Self::Deezer => rx!(r"^[1-9][0-9]{0,17}$").is_match(value),
            Self::Asin => rx!(r"^[0-9A-Z]{10}$").is_match(value),
            Self::OpenLibrary => rx!(r"^OL[1-9][0-9]*[WMA]$").is_match(value),
            Self::Bnf => rx!(r"^cb[0-9a-z]+$").is_match(value),
            Self::GoogleBooks => rx!(r"^[A-Za-z0-9_-]{1,32}$").is_match(value),
            Self::Audible | Self::Audnexus | Self::File => false,
        };
        ok.then(|| value.to_owned())
    }
}

/// The longest `<pluginId>:<name>`.
const PLUGIN_NAME_MAX: usize = MAX_PLUGIN_ID + 1 + MAX_NAMESPACE_NAME;
const _: () = assert!(PLUGIN_NAME_MAX <= u8::MAX as usize);

/// A plugin's `<pluginId>:<name>`, as `classify` accepts it; stored inline so `Namespace` stays `Copy`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct PluginNamespace {
    len: u8,
    buf: [u8; PLUGIN_NAME_MAX],
}

impl PluginNamespace {
    fn new(name: &str) -> Option<Self> {
        let Some(Class::Plugin { .. }) = classify(name) else {
            return None;
        };
        let mut buf = [0; PLUGIN_NAME_MAX];
        buf.get_mut(..name.len())?.copy_from_slice(name.as_bytes());
        Some(Self {
            len: name.len() as u8,
            buf,
        })
    }

    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.buf[..self.len as usize]).unwrap_or_default()
    }
}

impl fmt::Debug for PluginNamespace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.as_str(), f)
    }
}

/// An id namespace: one the core knows, or a plugin's (`provider-plugins.md` rule 23). Parsing is
/// syntactic; whether a plugin namespace is declared, and its label and rule, are `Namespaces`'.
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
    pub const MUSICBRAINZ: Self = Self::Core(ExternalProvider::MusicBrainz);
    pub const FILE: Self = Self::Core(ExternalProvider::File);

    /// The namespace the ids this provider answers are stored in: Audible and Audnexus answer ASINs.
    pub fn id_namespace(self) -> Self {
        match self {
            Self::AUDIBLE | Self::AUDNEXUS => Self::ASIN,
            n => n,
        }
    }

    /// A core name, or a well-formed plugin namespace, declared or not.
    pub fn parse(s: &str) -> Option<Self> {
        match ExternalProvider::parse(s) {
            Some(p) => Some(Self::Core(p)),
            None => PluginNamespace::new(s).map(Self::Plugin),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Core(p) => p.as_str(),
            Self::Plugin(p) => p.as_str(),
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
}

/// What a declared plugin namespace is stored with.
#[derive(Clone)]
struct Declared {
    rule: Arc<IdRule>,
    label: String,
}

/// The plugin namespaces declared by a manifest or a `provider_namespaces` row, with their label
/// and `idPattern`. One that is not declared (deleted since) has no rule: no id of it normalises.
#[derive(Clone, Default)]
pub struct Namespaces(HashMap<PluginNamespace, Declared>);

impl Namespaces {
    /// Declares a plugin namespace (or refreshes its label and pattern); `None` for a name that is no
    /// plugin namespace or a pattern `IdRule` refuses.
    pub fn declare(
        &mut self,
        name: &str,
        label: &str,
        id_pattern: &str,
        case: &str,
    ) -> Option<Namespace> {
        let ns = PluginNamespace::new(name)?;
        let rule = Arc::new(IdRule::new(id_pattern, case)?);
        self.0.insert(
            ns,
            Declared {
                rule,
                label: label.to_owned(),
            },
        );
        Some(Namespace::Plugin(ns))
    }

    /// Forgets a plugin namespace (its data is deleted); a core one stays.
    pub fn forget(&mut self, name: &str) {
        if let Some(ns) = PluginNamespace::new(name) {
            self.0.remove(&ns);
        }
    }

    /// A core name, or a plugin namespace declared here.
    pub fn parse(&self, s: &str) -> Option<Namespace> {
        Namespace::parse(s).filter(|n| match n {
            Namespace::Core(_) => true,
            Namespace::Plugin(p) => self.0.contains_key(p),
        })
    }

    /// The namespace as messages name it: a plugin's stored `label`, its name once deleted.
    pub fn label(&self, ns: Namespace) -> String {
        match ns {
            Namespace::Core(p) => p.label().to_owned(),
            Namespace::Plugin(p) => self
                .0
                .get(&p)
                .map_or_else(|| p.as_str().to_owned(), |d| d.label.clone()),
        }
    }

    /// `value` as stored: the core's rule, or the plugin's `idPattern` (`provider-plugins.md` rule 28).
    pub fn normalize(&self, ns: Namespace, value: &str) -> Option<String> {
        match ns {
            Namespace::Core(p) => p.normalize(value),
            Namespace::Plugin(p) => self.0.get(&p)?.rule.normalize(value),
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
    fn plugin_namespaces_parse_by_shape_and_declared_ones_carry_rule_and_label() {
        use super::{MAX_NAMESPACE_NAME, MAX_PLUGIN_ID, Namespace as N, Namespaces};
        let mut known = Namespaces::default();
        assert_eq!(known.parse("tmdb"), Some(N::TMDB));
        assert_eq!(known.parse("org.ns.test:aid"), None);
        let ns = known
            .declare(
                "org.ns.test:aid",
                "Test aid",
                "^[1-9][0-9]{0,8}$",
                "preserve",
            )
            .unwrap();
        assert_eq!(known.parse("org.ns.test:aid"), Some(ns));
        assert_eq!(N::parse("org.ns.test:aid"), Some(ns));
        assert_eq!(ns.as_str(), "org.ns.test:aid");
        assert!(!ns.is_unique());
        assert_eq!(known.normalize(ns, " 42 ").as_deref(), Some("42"));
        assert_eq!(known.normalize(ns, "042"), None);
        assert_eq!(known.declare("tmdb", "T", "^.+$", "preserve"), None);
        assert_eq!(
            known.declare("org.ns.test:bad", "Bad", "no anchors", "preserve"),
            None
        );
        assert_eq!(known.label(ns), "Test aid");
        let gone = N::parse("org.ns.test:gone").unwrap();
        assert_eq!(
            (known.parse("org.ns.test:gone"), known.normalize(gone, "1")),
            (None, None)
        );
        assert_eq!(known.label(gone), "org.ns.test:gone");
        known.forget("org.ns.test:aid");
        assert_eq!(
            (known.parse("org.ns.test:aid"), known.normalize(ns, "42")),
            (None, None)
        );
        assert_eq!(N::parse("nope"), None);
        assert_eq!(N::parse("org.ns.test:Bad"), None);
        let longest = format!(
            "{}:{}",
            "a".repeat(MAX_PLUGIN_ID),
            "b".repeat(MAX_NAMESPACE_NAME)
        );
        assert_eq!(
            N::parse(&longest).map(|n| n.as_str().to_owned()),
            Some(longest)
        );
        assert_eq!(known.label(N::TMDB), "TMDB");
        assert_eq!(known.normalize(N::TMDB, "603").as_deref(), Some("603"));
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
    fn only_tmdb_openlibrary_and_musicbrainz_are_unique() {
        let unique: Vec<_> = P::ALL.into_iter().filter(|p| p.is_unique()).collect();
        assert_eq!(unique, [P::Tmdb, P::OpenLibrary, P::MusicBrainz]);
    }

    #[test]
    fn music_ids_are_normalized_per_namespace() {
        let mbid = "5B11F4CE-A62D-471E-81FC-A69A8278C7DA";
        let lower = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
        for p in [P::MusicBrainz, P::FanartTv] {
            assert_eq!(p.normalize(mbid).as_deref(), Some(lower));
            for bad in [
                &lower[1..],
                "5b11f4cea62d471e81fca69a8278c7da",
                "5b11f4ce-a62d-471e-81fc-a69a8278c7dg",
            ] {
                assert_eq!(p.normalize(bad), None, "{bad}");
            }
        }
        assert_eq!(
            P::Isrc.normalize("us-rc1-76-07839").as_deref(),
            Some("USRC17607839")
        );
        assert_eq!(P::Isrc.normalize("USRC1760783"), None);
        assert_eq!(P::Isrc.normalize("USRC1760783X"), None);
        assert_eq!(
            P::Spotify.normalize("4uLU6hMCjMI75M1A2tKUQC").as_deref(),
            Some("4uLU6hMCjMI75M1A2tKUQC")
        );
        assert_eq!(P::Spotify.normalize("4uLU6hMCjMI75M1A2tKUQ"), None);
        assert_eq!(P::Deezer.normalize("3135556").as_deref(), Some("3135556"));
        for bad in ["0", "03135556", "x", ""] {
            assert_eq!(P::Deezer.normalize(bad), None, "{bad}");
        }
        assert!(!P::MusicBrainz.is_numeric());
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

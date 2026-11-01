//! Book metadata providers: pure request builders and response parsers (`docs/spec/book-providers.md`).
pub mod audible;
pub mod audnexus;
pub mod bnf;
pub mod googlebooks;
pub mod openlibrary;
mod util;

use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    OpenLibrary,
    GoogleBooks,
    Bnf,
    Audible,
    Audnexus,
}

/// What a record describes: an OpenLibrary work groups editions; every other provider returns editions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Work,
    Edition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Ebook,
    Print,
    Audio,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIds {
    pub work: Option<String>,
    pub edition: Option<String>,
    pub asin: Option<String>,
    /// Normalised ISBN-13, ISBN-10 converted, deduplicated, provider order.
    pub isbn13: Vec<String>,
    /// ISBN-13 of the editions a work groups (OpenLibrary search); a work has no ISBN of its own.
    pub edition_isbn13: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Person {
    /// `None` when the provider only gives a reference (OpenLibrary work and edition authors).
    pub name: Option<String>,
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Series {
    pub name: String,
    /// Text: a position can be `1.5` or `II`.
    pub position: Option<String>,
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Rating {
    /// Out of 5, two decimals.
    pub average: f64,
    pub count: Option<u32>,
}

/// One book as one provider describes it; every field a provider lacks stays empty.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookRecord {
    pub provider: Provider,
    pub level: Level,
    pub ids: ProviderIds,
    pub title: String,
    pub subtitle: Option<String>,
    /// Primary series first.
    pub series: Vec<Series>,
    pub authors: Vec<Person>,
    pub narrators: Vec<Person>,
    pub translators: Vec<Person>,
    /// ISO 639-1 when one exists, else the ISO 639-2 code.
    pub language: Option<String>,
    pub publisher: Option<String>,
    /// `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
    pub published: Option<String>,
    /// As the provider sends it, HTML included.
    pub description: Option<String>,
    pub subjects: Vec<String>,
    pub page_count: Option<u32>,
    pub duration_secs: Option<u32>,
    /// Largest first.
    pub covers: Vec<String>,
    pub rating: Option<Rating>,
    pub format: Option<Format>,
}

impl BookRecord {
    pub(crate) fn new(provider: Provider, level: Level, title: String) -> Self {
        Self {
            provider,
            level,
            ids: ProviderIds::default(),
            title,
            subtitle: None,
            series: vec![],
            authors: vec![],
            narrators: vec![],
            translators: vec![],
            language: None,
            publisher: None,
            published: None,
            description: None,
            subjects: vec![],
            page_count: None,
            duration_secs: None,
            covers: vec![],
            rating: None,
            format: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub total: Option<u64>,
    pub records: Vec<BookRecord>,
}

/// An author or other person entity (OpenLibrary author, Audnexus author).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonRecord {
    pub provider: Provider,
    pub id: String,
    pub name: String,
    pub alternate_names: Vec<String>,
    pub bio: Option<String>,
    pub birth_date: Option<String>,
    pub death_date: Option<String>,
    pub photos: Vec<String>,
    /// Ids on other services (`viaf`, `isni`, `wikidata`...).
    pub remote_ids: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    /// Not the expected JSON/XML, or a required field is missing.
    Malformed(String),
    /// The provider answered, but has no such item (or no usable one).
    NotFound,
    /// OpenLibrary merged or removed the item; the target key when there is one.
    Moved(Option<String>),
    /// Quota or rate limit: skip the provider, retry later.
    RateLimited,
    /// Any other error body the provider sent.
    Api(String),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed(m) => write!(f, "malformed: {m}"),
            Self::NotFound => f.write_str("not found"),
            Self::Moved(Some(k)) => write!(f, "moved to {k}"),
            Self::Moved(None) => f.write_str("moved"),
            Self::RateLimited => f.write_str("rate limited"),
            Self::Api(m) => write!(f, "api error: {m}"),
        }
    }
}

impl std::error::Error for ParseError {}

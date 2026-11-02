//! The one surface the server asks a metadata provider through (`metadata-orchestrator.md` rules 1-7).
use super::{Credits, PersonDetails, Upstream};
use fliks_domain::{
    external_id::ExternalProvider,
    media::kind::MediaKind,
    metadata::{
        language::Resolved,
        limiter::{Limits, Priority},
    },
};
use futures_util::future::BoxFuture;
use serde_json::Value;
use std::time::Duration;

pub type Call<'a, T> = BoxFuture<'a, Result<T, Upstream>>;

/// A title search; `year` is already dropped when it is not truthy (`metadata.md` rule 5).
pub struct Search<'a> {
    pub kind: MediaKind,
    pub query: &'a str,
    pub year: Option<i64>,
    pub title: Option<&'a str>,
    pub author: Option<&'a str>,
    pub author_id: Option<&'a str>,
    pub isbn: Option<&'a str>,
    pub language: Option<&'a str>,
    pub page: u32,
}

impl<'a> Search<'a> {
    /// A free-text search, the only form TMDB and TVDB read.
    pub fn text(kind: MediaKind, query: &'a str, year: Option<i64>) -> Self {
        Self {
            kind,
            query,
            year,
            title: None,
            author: None,
            author_id: None,
            isbn: None,
            language: None,
            page: 1,
        }
    }
}

/// An edition named by an id namespace: `(Isbn, "978...")`, `(Asin, "B0...")`, `(OpenLibrary, "OL...M")`.
pub struct EditionRef<'a> {
    pub namespace: ExternalProvider,
    pub value: &'a str,
}

pub trait MetadataProvider: Send + Sync {
    /// The registry key, as `preferredProvider` stores it.
    fn id(&self) -> ExternalProvider;
    fn supports(&self, kind: MediaKind) -> bool;
    /// Whether `fetch_person` and `person_credits` are answered.
    fn has_persons(&self) -> bool;
    fn limits(&self) -> Limits;
    /// Whether a call can be made now: a built-in always, a plugin while it is up.
    fn available(&self) -> bool {
        true
    }
    /// How long a fetched `resource` (`work`, `children`, `edition`) answers without a call; `None` never expires.
    fn snapshot_ttl(&self, _resource: &str) -> Option<Duration> {
        Some(Duration::ZERO)
    }
    fn search<'a>(
        &'a self,
        q: &'a Search<'a>,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>>;
    fn fetch_work<'a>(
        &'a self,
        kind: MediaKind,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Value>;
    /// Every season of a series with its episodes.
    fn fetch_children<'a>(
        &'a self,
        kind: MediaKind,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>>;
    /// Season numbers and episode counts in one call.
    fn child_stubs<'a>(
        &'a self,
        kind: MediaKind,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>>;
    /// The id and kind this provider knows the work of `source`'s `id` by.
    fn find_by<'a>(
        &'a self,
        source: ExternalProvider,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Option<(String, MediaKind)>>;
    fn fetch_person<'a>(
        &'a self,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, PersonDetails>;
    fn person_credits<'a>(
        &'a self,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Credits>;
    /// One edition record (`book-metadata.md` rule 4 keys); `None` for a namespace the provider cannot look up, without a call.
    fn fetch_edition<'a>(
        &'a self,
        _e: &'a EditionRef<'a>,
        _lang: &'a Resolved,
        _p: Priority,
    ) -> Call<'a, Option<Value>> {
        Box::pin(async { Ok(None) })
    }
    /// Chapters of an audio edition (`audnexus::Chapters` JSON); `None` when unsupported.
    fn fetch_chapters<'a>(
        &'a self,
        _asin: &'a str,
        _lang: &'a Resolved,
        _p: Priority,
    ) -> Call<'a, Option<Value>> {
        Box::pin(async { Ok(None) })
    }
}

/// A numeric provider id; callers validate it first, so a failure here never reaches a response.
pub fn numeric(id: &str) -> Result<i64, Upstream> {
    id.parse()
        .map_err(|_| Upstream::new(None, "provider id is not a number"))
}

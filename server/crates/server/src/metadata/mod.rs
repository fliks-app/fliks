//! TMDB / TVDB clients and `/api/metadata/*` (`docs/spec/metadata.md`); other domains call `Metadata` in process.
mod http;
mod language;
mod map;
mod routes;
pub mod tmdb;
pub mod tvdb;
mod types;

pub use http::Upstream;
pub use language::{LanguageCache, Override};
pub use routes::*;
pub use types::{Credits, MediaKind, MetaError, PersonDetails, Provider};

use crate::config::MetadataConfig;
use fliks_domain::metadata::language::Resolved;
use serde_json::Value;
use sqlx::PgPool;
use std::{future::Future, time::Duration};

const TMDB_TIMEOUT: Duration = Duration::from_secs(10);
const TVDB_TIMEOUT: Duration = Duration::from_secs(15);

/// What the import, refresh, request and person code needs from the providers.
pub trait MetadataFetch: Send + Sync {
    fn details(
        &self,
        p: Provider,
        kind: MediaKind,
        id: i64,
        lang: &Resolved,
    ) -> impl Future<Output = Result<Value, Upstream>> + Send;
    fn season_stubs(
        &self,
        p: Provider,
        id: i64,
        lang: &Resolved,
    ) -> impl Future<Output = Result<Vec<Value>, Upstream>> + Send;
    fn seasons(
        &self,
        p: Provider,
        id: i64,
        lang: &Resolved,
    ) -> impl Future<Output = Result<Vec<Value>, Upstream>> + Send;
    /// `(external id, is series)` of an IMDb or TVDB id.
    fn find_by_external_id(
        &self,
        p: Provider,
        source: &str,
        id: &str,
        lang: &Resolved,
    ) -> impl Future<Output = Result<Option<(String, bool)>, Upstream>> + Send;
    fn person_details(
        &self,
        p: Provider,
        id: i64,
        lang: &Resolved,
    ) -> impl Future<Output = Result<PersonDetails, Upstream>> + Send;
    fn person_credits(
        &self,
        p: Provider,
        id: i64,
        lang: &Resolved,
    ) -> impl Future<Output = Result<Credits, Upstream>> + Send;
    /// The provider named, if its key is configured, else TMDB (`registry.resolve`).
    fn resolve(&self, name: Option<&str>) -> Provider;
    /// The other provider when it is configured.
    fn fallback(&self, p: Provider) -> Option<Provider>;
}

pub struct Metadata {
    pub lang: LanguageCache,
    pub tmdb: tmdb::Tmdb,
    pub tvdb: tvdb::Tvdb,
    tmdb_on: bool,
    tvdb_on: bool,
}

impl Metadata {
    pub fn new(db: PgPool, c: &MetadataConfig) -> Self {
        Self {
            lang: LanguageCache::new(db),
            tmdb: tmdb::Tmdb::new(&c.tmdb_url, &c.tmdb_image_url, &c.tmdb_key, TMDB_TIMEOUT),
            tvdb: tvdb::Tvdb::new(&c.tvdb_url, &c.tvdb_key, TVDB_TIMEOUT),
            tmdb_on: !c.tmdb_key.is_empty(),
            tvdb_on: !c.tvdb_key.is_empty(),
        }
    }

    pub fn available(&self, p: Provider) -> bool {
        match p {
            Provider::Tmdb => self.tmdb_on,
            Provider::Tvdb => self.tvdb_on,
        }
    }

    pub async fn search(
        &self,
        p: Provider,
        tv: bool,
        query: &str,
        year: Option<i64>,
        lang: &Resolved,
    ) -> Result<Vec<Value>, Upstream> {
        match p {
            Provider::Tmdb => self.tmdb.search(tv, query, year, lang).await,
            Provider::Tvdb => self.tvdb.search(tv, query, year, lang).await,
        }
    }
}

impl MetadataFetch for Metadata {
    async fn details(
        &self,
        p: Provider,
        kind: MediaKind,
        id: i64,
        lang: &Resolved,
    ) -> Result<Value, Upstream> {
        match p {
            Provider::Tmdb => self.tmdb.details(kind.is_tv(), id, lang).await,
            Provider::Tvdb => self.tvdb.details(kind.is_tv(), id, lang).await,
        }
    }

    async fn season_stubs(
        &self,
        p: Provider,
        id: i64,
        lang: &Resolved,
    ) -> Result<Vec<Value>, Upstream> {
        match p {
            Provider::Tmdb => self.tmdb.season_stubs(id, lang).await,
            Provider::Tvdb => self.tvdb.season_stubs(id).await,
        }
    }

    async fn seasons(&self, p: Provider, id: i64, lang: &Resolved) -> Result<Vec<Value>, Upstream> {
        match p {
            Provider::Tmdb => self.tmdb.seasons(id, lang).await,
            Provider::Tvdb => self.tvdb.seasons(id, lang).await,
        }
    }

    async fn find_by_external_id(
        &self,
        p: Provider,
        source: &str,
        id: &str,
        lang: &Resolved,
    ) -> Result<Option<(String, bool)>, Upstream> {
        match p {
            Provider::Tmdb => self.tmdb.find_by_external_id(source, id, lang).await,
            Provider::Tvdb => self.tvdb.find_by_external_id(id).await,
        }
    }

    async fn person_details(
        &self,
        p: Provider,
        id: i64,
        lang: &Resolved,
    ) -> Result<PersonDetails, Upstream> {
        match p {
            Provider::Tmdb => self.tmdb.person_details(id, lang).await,
            Provider::Tvdb => self.tvdb.person_details(id, lang).await,
        }
    }

    async fn person_credits(
        &self,
        p: Provider,
        id: i64,
        lang: &Resolved,
    ) -> Result<Credits, Upstream> {
        match p {
            Provider::Tmdb => self.tmdb.person_credits(id, lang).await,
            Provider::Tvdb => self.tvdb.person_credits(id).await,
        }
    }

    fn resolve(&self, name: Option<&str>) -> Provider {
        match name.and_then(Provider::parse) {
            Some(p) if self.available(p) => p,
            _ => Provider::Tmdb,
        }
    }

    fn fallback(&self, p: Provider) -> Option<Provider> {
        let other = match p {
            Provider::Tmdb => Provider::Tvdb,
            Provider::Tvdb => Provider::Tmdb,
        };
        self.available(other).then_some(other)
    }
}

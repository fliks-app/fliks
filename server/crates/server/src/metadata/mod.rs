//! TMDB / TVDB clients and `/api/metadata/*` (`docs/spec/metadata.md`); other domains call `Metadata` in process.
pub mod books;
mod credits;
mod http;
mod language;
mod map;
mod orchestrator;
mod provider;
mod routes;
pub mod service;
#[cfg(test)]
mod stub;
pub mod tmdb;
pub mod tvdb;
mod types;

pub use http::{Guarded, Observed, Upstream};
pub use language::{LanguageCache, Override};
pub use orchestrator::{Key, prune_snapshots};
pub use provider::{EditionRef, MetadataProvider, Search};
pub use routes::*;
pub use types::{Credits, MetaError, PersonDetails};

use crate::config::MetadataConfig;
use fliks_domain::{external_id::ExternalProvider, media::kind::MediaKind};
use std::{collections::HashMap, sync::Arc, time::Duration};

const TMDB_TIMEOUT: Duration = Duration::from_secs(10);
const TVDB_TIMEOUT: Duration = Duration::from_secs(15);

struct Entry {
    /// Its key is configured (`metadata.md` rule 20).
    on: bool,
    provider: Arc<dyn MetadataProvider>,
}

/// The providers by registry key (`metadata-orchestrator.md` rules 8-9).
pub struct Metadata {
    pub lang: LanguageCache,
    /// TMDB's lists (trending, popular, upcoming, genres, discover) are not part of the trait.
    pub tmdb: Arc<tmdb::Tmdb>,
    providers: HashMap<ExternalProvider, Entry>,
    db: sqlx::PgPool,
    flights: orchestrator::Flights,
}

impl Metadata {
    pub fn new(db: sqlx::PgPool, c: &MetadataConfig) -> Self {
        let tmdb = Arc::new(tmdb::Tmdb::new(
            &c.tmdb_url,
            &c.tmdb_image_url,
            &c.tmdb_key,
            TMDB_TIMEOUT,
        ));
        let tvdb = Arc::new(tvdb::Tvdb::new(&c.tvdb_url, &c.tvdb_key, TVDB_TIMEOUT));
        let entry = |on: bool, provider: Arc<dyn MetadataProvider>| Entry { on, provider };
        Self {
            lang: LanguageCache::new(db.clone()),
            db,
            flights: Default::default(),
            providers: HashMap::from([
                (
                    ExternalProvider::Tmdb,
                    entry(!c.tmdb_key.is_empty(), tmdb.clone()),
                ),
                (ExternalProvider::Tvdb, entry(!c.tvdb_key.is_empty(), tvdb)),
            ]),
            tmdb,
        }
    }

    /// Registers a provider under its own id, available (tests).
    #[cfg(test)]
    pub(crate) fn register(&mut self, provider: Arc<dyn MetadataProvider>) {
        self.providers
            .insert(provider.id(), Entry { on: true, provider });
    }

    /// The provider registered under `id`, available or not.
    pub fn get(&self, id: ExternalProvider) -> Option<&dyn MetadataProvider> {
        self.providers.get(&id).map(|e| &*e.provider)
    }

    /// A provider `resolve` or `fallback` returned.
    pub fn of(&self, id: ExternalProvider) -> &dyn MetadataProvider {
        self.get(id).expect("a registered provider")
    }

    pub fn available(&self, id: ExternalProvider) -> bool {
        self.providers.get(&id).is_some_and(|e| e.on)
    }

    /// The provider named, if its key is configured, else TMDB (`registry.resolve`).
    pub fn resolve(&self, name: Option<&str>) -> ExternalProvider {
        match name.and_then(ExternalProvider::parse) {
            Some(p) if self.available(p) => p,
            _ => ExternalProvider::Tmdb,
        }
    }

    fn other(
        &self,
        id: ExternalProvider,
        wanted: impl Fn(&dyn MetadataProvider) -> bool,
    ) -> Option<ExternalProvider> {
        ExternalProvider::ALL
            .into_iter()
            .find(|o| *o != id && self.available(*o) && wanted(self.of(*o)))
    }

    /// The other provider that is configured and supports `kind`.
    pub fn fallback(&self, id: ExternalProvider, kind: MediaKind) -> Option<ExternalProvider> {
        self.other(id, |p| p.supports(kind))
    }

    /// The other provider that is configured and describes people.
    pub fn person_fallback(&self, id: ExternalProvider) -> Option<ExternalProvider> {
        self.other(id, |p| p.has_persons())
    }
}

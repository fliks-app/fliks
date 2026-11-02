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
pub use provider::{Call, EditionRef, MetadataProvider, Search};
pub use routes::*;
pub use types::{Credits, MetaError, PersonDetails};

use crate::config::MetadataConfig;
use crate::sync::RwLockExt;
use fliks_domain::{
    external_id::ExternalProvider, media::kind::MediaKind, metadata::merge::FieldOrder,
};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
    time::Duration,
};

const TMDB_TIMEOUT: Duration = Duration::from_secs(10);
const TVDB_TIMEOUT: Duration = Duration::from_secs(15);
const ORDER_PREFIX: &str = "metadata.provider_order.";

struct Entry {
    /// Its key is configured (`metadata.md` rule 20).
    on: bool,
    provider: Arc<dyn MetadataProvider>,
}

/// The providers of provider plugins and the admin's order per kind.
#[derive(Default)]
struct Dynamic {
    providers: HashMap<ExternalProvider, Arc<dyn MetadataProvider>>,
    /// Plugin keys in registration order: they follow the default order of their kinds.
    added: Vec<ExternalProvider>,
    orders: HashMap<MediaKind, Vec<ExternalProvider>>,
}

/// The providers by registry key (`metadata-orchestrator.md` rules 8-10).
pub struct Metadata {
    pub lang: LanguageCache,
    /// TMDB's lists (trending, popular, upcoming, genres, discover) are not part of the trait.
    pub tmdb: Arc<tmdb::Tmdb>,
    builtin: HashMap<ExternalProvider, Entry>,
    dynamic: RwLock<Dynamic>,
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
            builtin: HashMap::from([
                (
                    ExternalProvider::Tmdb,
                    entry(!c.tmdb_key.is_empty(), tmdb.clone()),
                ),
                (ExternalProvider::Tvdb, entry(!c.tvdb_key.is_empty(), tvdb)),
            ]),
            dynamic: RwLock::default(),
            tmdb,
        }
    }

    /// Registers a built-in under its own id, available (tests).
    #[cfg(test)]
    pub(crate) fn register(&mut self, provider: Arc<dyn MetadataProvider>) {
        self.builtin
            .insert(provider.id(), Entry { on: true, provider });
    }

    /// Registers the provider of a plugin that turned `ready`, replacing the one it registered before.
    pub fn add_plugin(&self, provider: Arc<dyn MetadataProvider>) {
        let mut d = self.dynamic.write_clean();
        let id = provider.id();
        if !d.added.contains(&id) {
            d.added.push(id);
        }
        d.providers.insert(id, provider);
    }

    /// The provider that answers for `id` and whether it is available: a plugin's while it is, else
    /// the built-in, else a plugin's that went away (its calls fail 503).
    fn slot(&self, id: ExternalProvider) -> Option<(bool, Arc<dyn MetadataProvider>)> {
        let plugin = self.dynamic.read_clean().providers.get(&id).cloned();
        match (plugin, self.builtin.get(&id)) {
            (Some(p), _) if p.available() => Some((true, p)),
            (_, Some(e)) => Some((e.on && e.provider.available(), e.provider.clone())),
            (gone, None) => gone.map(|p| (false, p)),
        }
    }

    /// The provider registered under `id`, available or not.
    pub fn get(&self, id: ExternalProvider) -> Option<Arc<dyn MetadataProvider>> {
        self.slot(id).map(|(_, p)| p)
    }

    /// A provider `resolve` or `fallback` returned.
    pub fn of(&self, id: ExternalProvider) -> Arc<dyn MetadataProvider> {
        self.get(id).expect("a registered provider")
    }

    pub fn available(&self, id: ExternalProvider) -> bool {
        self.slot(id).is_some_and(|(on, _)| on)
    }

    /// The providers of `kind`, first to last: the admin's setting, else the default order then the plugins.
    pub fn order(&self, kind: MediaKind) -> Vec<ExternalProvider> {
        let d = self.dynamic.read_clean();
        if let Some(o) = d.orders.get(&kind) {
            return o.clone();
        }
        let mut order = FieldOrder::new(kind, &[]).providers().to_vec();
        let plugins: Vec<_> = d
            .added
            .iter()
            .filter(|p| !order.contains(p) && d.providers[*p].supports(kind))
            .copied()
            .collect();
        order.extend(plugins);
        order
    }

    /// The first available provider of `order` that `wanted` accepts, the one named first.
    fn pick(
        &self,
        name: Option<&str>,
        order: Vec<ExternalProvider>,
        wanted: impl Fn(&dyn MetadataProvider) -> bool,
    ) -> Option<ExternalProvider> {
        let usable = |p: &ExternalProvider| self.available(*p) && wanted(&*self.of(*p));
        name.and_then(ExternalProvider::parse)
            .filter(usable)
            .or_else(|| order.into_iter().find(usable))
    }

    /// The providers that may describe people: every kind's order, each provider once.
    fn person_order(&self) -> Vec<ExternalProvider> {
        let mut all = vec![];
        for p in MediaKind::ALL.into_iter().flat_map(|k| self.order(k)) {
            if !all.contains(&p) {
                all.push(p);
            }
        }
        all
    }

    /// The named provider iff it is available and supports `kind`, else the first of the kind's order.
    pub fn resolve(&self, name: Option<&str>, kind: MediaKind) -> Option<ExternalProvider> {
        self.pick(name, self.order(kind), |p| p.supports(kind))
    }

    /// The named provider iff it is available and describes people, else the first that does.
    pub fn resolve_person(&self, name: Option<&str>) -> Option<ExternalProvider> {
        self.pick(name, self.person_order(), |p| p.has_persons())
    }

    /// The first other provider of the kind's order that is available and supports `kind`.
    pub fn fallback(&self, id: ExternalProvider, kind: MediaKind) -> Option<ExternalProvider> {
        let order = self.order(kind);
        self.pick(
            None,
            order.into_iter().filter(|o| *o != id).collect(),
            |p| p.supports(kind),
        )
    }

    /// The first other provider, over the orders of every kind, that is available and describes people.
    pub fn person_fallback(&self, id: ExternalProvider) -> Option<ExternalProvider> {
        let order = self.person_order();
        self.pick(
            None,
            order.into_iter().filter(|o| *o != id).collect(),
            |p| p.has_persons(),
        )
    }

    /// Reads `metadata.provider_order.<kind>` of every kind; an entry that names no known provider is skipped.
    pub async fn load_orders(&self) -> sqlx::Result<()> {
        let rows: Vec<(String, Option<String>)> = sqlx::query_as(
            r#"SELECT "key"::text, "value" FROM app_settings WHERE starts_with("key", $1)"#,
        )
        .bind(ORDER_PREFIX)
        .fetch_all(&self.db)
        .await?;
        let orders = rows
            .into_iter()
            .filter_map(|(k, v)| {
                let kind = MediaKind::parse(k.strip_prefix(ORDER_PREFIX)?)?;
                let names: Vec<String> = serde_json::from_str(&v?).ok()?;
                let mut order: Vec<ExternalProvider> = vec![];
                for p in names.iter().filter_map(|n| ExternalProvider::parse(n)) {
                    if !order.contains(&p) {
                        order.push(p);
                    }
                }
                Some((kind, order))
            })
            .collect();
        self.dynamic.write_clean().orders = orders;
        Ok(())
    }

    pub async fn settings_changed(&self, keys: &[String]) {
        if keys.iter().any(|k| k.starts_with(ORDER_PREFIX))
            && let Err(e) = self.load_orders().await
        {
            tracing::warn!("metadata provider order not reloaded: {e}");
        }
    }
}

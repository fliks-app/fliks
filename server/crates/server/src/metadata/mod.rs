//! The provider registry and `/api/metadata/*` (`docs/spec/metadata.md`); other domains call `Metadata` in process.
pub mod books;
mod credits;
mod language;
mod lists;
mod orchestrator;
mod provider;
mod routes;
pub mod service;
#[cfg(test)]
pub(crate) mod stub;
mod types;

pub use language::{LanguageCache, Override};
pub use orchestrator::{Key, prune_snapshots};
use provider::Absent;
pub use provider::{Call, EditionRef, MetadataProvider, Search};
pub use routes::*;
pub use types::{Credits, MetaError, PersonDetails, Upstream};

use crate::{http::AppError, sync::RwLockExt};
use axum::http::StatusCode;
use fliks_domain::{external_id::Namespace, media::kind::MediaKind, metadata::merge::FieldOrder};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, RwLock},
};

const ORDER_PREFIX: &str = "metadata.provider_order.";

/// The providers of provider plugins and the admin's order per kind.
#[derive(Default)]
struct Dynamic {
    providers: HashMap<Namespace, Arc<dyn MetadataProvider>>,
    /// Plugin keys in registration order: they follow the default order of their kinds.
    added: Vec<Namespace>,
    orders: HashMap<MediaKind, Vec<Namespace>>,
}

/// The providers by registry key (`metadata-orchestrator.md` rules 8-10).
pub struct Metadata {
    pub lang: LanguageCache,
    dynamic: RwLock<Dynamic>,
    db: sqlx::PgPool,
    flights: orchestrator::Flights,
    /// Last good copy of each global list (rule 17); never expires.
    stale: Mutex<HashMap<String, serde_json::Value>>,
}

impl Metadata {
    pub fn new(db: sqlx::PgPool) -> Self {
        Self {
            lang: LanguageCache::new(db.clone()),
            db,
            flights: Default::default(),
            stale: Mutex::default(),
            dynamic: RwLock::default(),
        }
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

    /// The provider of `id` and whether it is available: a plugin that went away stays, its calls fail 503.
    fn slot(&self, id: Namespace) -> Option<(bool, Arc<dyn MetadataProvider>)> {
        let p = self.dynamic.read_clean().providers.get(&id).cloned()?;
        Some((p.available(), p))
    }

    /// The first available provider, in registration order, that declares the scene capability.
    pub fn scene_provider(&self) -> Option<Arc<dyn MetadataProvider>> {
        let d = self.dynamic.read_clean();
        d.added
            .iter()
            .filter_map(|id| d.providers.get(id))
            .find(|p| p.available() && p.has_scene())
            .cloned()
    }

    /// The provider registered under `id`, available or not.
    pub fn get(&self, id: Namespace) -> Option<Arc<dyn MetadataProvider>> {
        self.slot(id).map(|(_, p)| p)
    }

    /// A provider `resolve` or `fallback` returned; one that is not registered answers every call 503.
    pub fn of(&self, id: Namespace) -> Arc<dyn MetadataProvider> {
        self.get(id).unwrap_or_else(|| Arc::new(Absent(id)))
    }

    pub fn available(&self, id: Namespace) -> bool {
        self.slot(id).is_some_and(|(on, _)| on)
    }

    /// The providers of `kind`, first to last: the admin's setting, else the default order then the plugins.
    pub fn order(&self, kind: MediaKind) -> Vec<Namespace> {
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
        order: Vec<Namespace>,
        wanted: impl Fn(&dyn MetadataProvider) -> bool,
    ) -> Option<Namespace> {
        let usable = |p: &Namespace| self.available(*p) && wanted(&*self.of(*p));
        name.and_then(Namespace::parse)
            .filter(usable)
            .or_else(|| order.into_iter().find(usable))
    }

    /// The providers that may describe people: every kind's order, each provider once.
    fn person_order(&self) -> Vec<Namespace> {
        let mut all = vec![];
        for p in MediaKind::ALL.into_iter().flat_map(|k| self.order(k)) {
            if !all.contains(&p) {
                all.push(p);
            }
        }
        all
    }

    /// The named provider iff it is available and supports `kind`, else the first of the kind's order.
    pub fn resolve(&self, name: Option<&str>, kind: MediaKind) -> Option<Namespace> {
        self.pick(name, self.order(kind), |p| p.supports(kind))
    }

    /// The named provider iff it is available.
    pub fn named(&self, name: Option<&str>) -> Option<Namespace> {
        name.and_then(Namespace::parse)
            .filter(|p| self.available(*p))
    }

    /// The named provider (TMDB when unnamed): 400 when unknown, 503 naming it when not available.
    pub fn require(&self, name: Option<&str>) -> Result<Namespace, AppError> {
        let name = name.unwrap_or(Namespace::TMDB.as_str());
        let ns = Namespace::parse(name)
            .ok_or_else(|| AppError::bad_request(format!("Unknown provider: {name}")))?;
        match self.available(ns) {
            true => Ok(ns),
            false => Err(AppError::with_message(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("The {} provider is not available", ns.as_str()),
            )),
        }
    }

    /// The first other provider of the kind's order that is available and supports `kind`.
    pub fn fallback(&self, id: Namespace, kind: MediaKind) -> Option<Namespace> {
        let order = self.order(kind);
        self.pick(
            None,
            order.into_iter().filter(|o| *o != id).collect(),
            |p| p.supports(kind),
        )
    }

    /// The first other provider, over the orders of every kind, that is available and describes people.
    pub fn person_fallback(&self, id: Namespace) -> Option<Namespace> {
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
                let mut order: Vec<Namespace> = vec![];
                for p in names.iter().filter_map(|n| Namespace::parse(n)) {
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

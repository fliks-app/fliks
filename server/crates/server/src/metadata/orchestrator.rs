//! The snapshot cache and single-flight in front of the providers (`metadata-orchestrator.md` rules 29-33).
use super::{EditionRef, MetaError, Metadata, Upstream};
use fliks_domain::{
    external_id::ExternalProvider,
    media::kind::MediaKind,
    metadata::{language::Resolved, limiter::Priority},
};
use futures_util::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

/// What one provider answer is stored and shared under.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Key {
    pub provider: ExternalProvider,
    pub resource: &'static str,
    pub kind: MediaKind,
    pub id: String,
    pub language: String,
}

type Call = BoxFuture<'static, Result<Value, Upstream>>;
type FlightKey = (Key, Priority);
pub(super) type Flights = Arc<Mutex<HashMap<FlightKey, Shared<Call>>>>;

/// Takes a flight out of the map when its task ends, by completion or by a panic.
struct Release {
    flights: Flights,
    key: FlightKey,
}

impl Drop for Release {
    fn drop(&mut self) {
        let mut flights = self.flights.lock().unwrap_or_else(PoisonError::into_inner);
        flights.remove(&self.key);
    }
}

impl Metadata {
    fn key(
        &self,
        p: ExternalProvider,
        resource: &'static str,
        kind: MediaKind,
        id: &str,
        lang: &Resolved,
    ) -> Key {
        Key {
            provider: p,
            resource,
            kind,
            id: id.to_owned(),
            language: lang.tmdb_locale.clone(),
        }
    }

    /// The work record of `id`, from its snapshot or the provider.
    pub async fn work(
        &self,
        p: ExternalProvider,
        kind: MediaKind,
        id: &str,
        lang: &Resolved,
        prio: Priority,
    ) -> Result<Value, MetaError> {
        let provider = self.providers[&p].provider.clone();
        let ttl = provider.snapshot_ttl();
        let (id_owned, lang_owned) = (id.to_owned(), lang.clone());
        let call = move || {
            async move {
                provider
                    .fetch_work(kind, &id_owned, &lang_owned, prio)
                    .await
            }
            .boxed()
        };
        self.snapshot(self.key(p, "work", kind, id, lang), prio, ttl, call)
            .await
    }

    /// Every season of a series with its episodes, from its snapshot or the provider.
    pub async fn children(
        &self,
        p: ExternalProvider,
        id: &str,
        lang: &Resolved,
        prio: Priority,
    ) -> Result<Vec<Value>, MetaError> {
        let provider = self.providers[&p].provider.clone();
        let ttl = provider.snapshot_ttl();
        let (id_owned, lang_owned) = (id.to_owned(), lang.clone());
        let call = move || {
            async move {
                let all = provider
                    .fetch_children(MediaKind::Series, &id_owned, &lang_owned, prio)
                    .await?;
                Ok(Value::Array(all))
            }
            .boxed()
        };
        let key = self.key(p, "children", MediaKind::Series, id, lang);
        match self.snapshot(key, prio, ttl, call).await? {
            Value::Array(all) => Ok(all),
            _ => Ok(vec![]),
        }
    }

    /// The edition `e` names as `p` records it, from its snapshot or the provider; `None` when `p` cannot
    /// look the namespace up. A foreign namespace is keyed `<namespace>:<value>` (`book-metadata.md` rule 6).
    pub async fn edition(
        &self,
        p: ExternalProvider,
        e: (ExternalProvider, &str),
        lang: &Resolved,
        prio: Priority,
    ) -> Result<Option<Value>, MetaError> {
        let provider = self.providers[&p].provider.clone();
        let ttl = provider.snapshot_ttl();
        let (namespace, value) = (e.0, e.1.to_owned());
        let id = if namespace == p {
            value.clone()
        } else {
            format!("{namespace}:{value}")
        };
        let lang_owned = lang.clone();
        let call = move || {
            async move {
                let e = EditionRef {
                    namespace,
                    value: &value,
                };
                let found = provider.fetch_edition(&e, &lang_owned, prio).await?;
                Ok(found.unwrap_or(Value::Null))
            }
            .boxed()
        };
        let key = self.key(p, "edition", MediaKind::Book, &id, lang);
        Ok(match self.snapshot(key, prio, ttl, call).await? {
            Value::Null => None,
            v => Some(v),
        })
    }

    /// A record not expired answers without a call; else `fetch` runs once, in its own task, for every
    /// concurrent caller of `key` and `prio`, and the task stores the answer unless `ttl` is zero
    /// (`None`: never expires).
    pub async fn snapshot(
        &self,
        key: Key,
        prio: Priority,
        ttl: Option<Duration>,
        fetch: impl FnOnce() -> Call,
    ) -> Result<Value, MetaError> {
        let store_it = ttl != Some(Duration::ZERO);
        if store_it && let Some(body) = self.cached(&key).await? {
            return Ok(body);
        }
        let flight = {
            let mut flights = self.flights.lock().unwrap_or_else(PoisonError::into_inner);
            flights
                .entry((key.clone(), prio))
                .or_insert_with(|| {
                    let (flights, db, call) = (self.flights.clone(), self.db.clone(), fetch());
                    let task = tokio::spawn(async move {
                        let _release = Release {
                            flights,
                            key: (key.clone(), prio),
                        };
                        let r = call.await;
                        if let Ok(body) = &r
                            && store_it
                            && let Err(e) = store(&db, &key, body, ttl).await
                        {
                            tracing::warn!("metadata snapshot of {}: {e}", key.id);
                        }
                        r
                    });
                    async move {
                        task.await.unwrap_or_else(|e| {
                            tracing::warn!("metadata provider call: {e}");
                            Err(Upstream::new(None, "provider call aborted"))
                        })
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        Ok(flight.await?)
    }

    async fn cached(&self, k: &Key) -> sqlx::Result<Option<Value>> {
        sqlx::query_scalar!(
            r#"SELECT body AS "body!" FROM metadata_snapshots
               WHERE provider = $1 AND resource = $2 AND kind = $3 AND "externalId" = $4 AND language = $5
                 AND ("expiresAt" IS NULL OR "expiresAt" > now())"#,
            k.provider.as_str(),
            k.resource,
            k.kind.as_str(),
            k.id,
            k.language
        )
        .fetch_optional(&self.db)
        .await
    }
}

async fn store(
    db: &sqlx::PgPool,
    k: &Key,
    body: &Value,
    ttl: Option<Duration>,
) -> sqlx::Result<()> {
    sqlx::query!(
        r#"INSERT INTO metadata_snapshots (provider, resource, kind, "externalId", language, body, "expiresAt")
               VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
               ON CONFLICT (provider, resource, kind, "externalId", language) DO UPDATE
               SET body = EXCLUDED.body, "fetchedAt" = now(), "expiresAt" = EXCLUDED."expiresAt""#,
        k.provider.as_str(),
        k.resource,
        k.kind.as_str(),
        k.id,
        k.language,
        body,
        ttl.map(|t| t.as_secs_f64())
    )
    .execute(db)
    .await?;
    Ok(())
}

/// Deletes the snapshots expired for more than 30 days (`metadata-orchestrator.md` rule 33).
pub async fn prune_snapshots(db: &sqlx::PgPool) -> sqlx::Result<u64> {
    let r = sqlx::query!(
        r#"DELETE FROM metadata_snapshots WHERE "expiresAt" < now() - interval '30 days'"#
    )
    .execute(db)
    .await?;
    Ok(r.rows_affected())
}

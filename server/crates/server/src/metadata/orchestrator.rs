//! The snapshot cache and single-flight in front of the providers (`metadata-orchestrator.md` rules 29-33).
use super::{MetaError, Metadata, Upstream};
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
    sync::{Arc, Mutex},
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
pub(super) type Flights = Arc<Mutex<HashMap<Key, Shared<Call>>>>;

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
        self.snapshot(self.key(p, "work", kind, id, lang), ttl, call)
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
        match self.snapshot(key, ttl, call).await? {
            Value::Array(all) => Ok(all),
            _ => Ok(vec![]),
        }
    }

    /// A record not expired answers without a call; else `fetch` runs once for every concurrent
    /// caller of `key`, and its answer is stored with `ttl` (`None`: never expires).
    pub async fn snapshot(
        &self,
        key: Key,
        ttl: Option<Duration>,
        fetch: impl FnOnce() -> Call,
    ) -> Result<Value, MetaError> {
        if ttl != Some(Duration::ZERO)
            && let Some(body) = self.cached(&key).await?
        {
            return Ok(body);
        }
        let flight = {
            let mut flights = self.flights.lock().unwrap();
            flights
                .entry(key.clone())
                .or_insert_with(|| {
                    let (flights, k, call) = (self.flights.clone(), key.clone(), fetch());
                    async move {
                        let r = call.await;
                        flights.lock().unwrap().remove(&k);
                        r
                    }
                    .boxed()
                    .shared()
                })
                .clone()
        };
        let body = flight.await?;
        self.store(&key, &body, ttl).await?;
        Ok(body)
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

    async fn store(&self, k: &Key, body: &Value, ttl: Option<Duration>) -> sqlx::Result<()> {
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
        .execute(&self.db)
        .await?;
        Ok(())
    }
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

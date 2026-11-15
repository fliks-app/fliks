//! The list routes' provider and stale-while-error cache (`provider-plugins.md` rule 44).
use super::{Metadata, Upstream};
use crate::sync::MutexExt;
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{language::Resolved, limiter::Priority},
};
use serde_json::Value;
use std::time::{Duration, SystemTime};

/// A stored list younger than this answers without calling the provider.
const FRESH: Duration = Duration::from_secs(3600);

impl Metadata {
    /// The first available provider of the kind's order that serves lists.
    pub fn lister(&self, kind: MediaKind) -> Option<Namespace> {
        self.pick(None, self.order(kind), |p| p.has_lists(kind))
    }

    /// `name` of `id` for `kind`, except `discover`: a copy younger than [`FRESH`] answers without a call,
    /// and the last good copy answers when the live call fails.
    pub async fn list(
        &self,
        id: Namespace,
        kind: MediaKind,
        name: &str,
        params: &[(String, String)],
        lang: &Resolved,
        p: Priority,
    ) -> Result<Value, (Namespace, Upstream)> {
        if name == "discover" {
            return self
                .of(id)
                .list(kind, name, params, lang, p)
                .await
                .map_err(|e| (id, e));
        }
        let key = format!(
            "{}:{name}:{}:{params:?}:{}:{}",
            id.as_str(),
            kind.as_str(),
            lang.tmdb_locale,
            lang.region
        );
        // Off with the search cache, so a parity run counts every provider call.
        let fresh = super::search_cache::enabled()
            .then(|| {
                let stale = self.stale.lock_clean();
                let (at, v) = stale.get(&key)?;
                at.elapsed().is_ok_and(|age| age < FRESH).then(|| v.clone())
            })
            .flatten();
        if let Some(v) = fresh {
            return Ok(v);
        }
        match self.of(id).list(kind, name, params, lang, p).await {
            Ok(v) => {
                self.stale
                    .lock_clean()
                    .insert(key, (SystemTime::now(), v.clone()));
                Ok(v)
            }
            Err(e) => match self.stale.lock_clean().get(&key) {
                Some((_, v)) => {
                    tracing::warn!("{key} unavailable, serving last cached copy");
                    Ok(v.clone())
                }
                None => Err((id, e)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{Call, Credits, MetadataProvider, PersonDetails, Search};
    use fliks_domain::metadata::limiter::Limits;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    /// A TMDB-keyed provider whose lists fail on demand, counting its calls.
    struct Lists(AtomicBool, AtomicUsize);

    impl MetadataProvider for Lists {
        fn id(&self) -> Namespace {
            Namespace::TMDB
        }
        fn supports(&self, _: MediaKind) -> bool {
            true
        }
        fn has_persons(&self) -> bool {
            false
        }
        fn limits(&self) -> Limits {
            Limits {
                rate_per_sec: 1.0,
                burst: 1,
                daily_quota: None,
                background_share: 0.75,
            }
        }
        fn has_lists(&self, _: MediaKind) -> bool {
            true
        }
        fn list<'a>(
            &'a self,
            _: MediaKind,
            name: &'a str,
            _: &'a [(String, String)],
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Value> {
            Box::pin(async move {
                self.1.fetch_add(1, Ordering::SeqCst);
                if self.0.load(Ordering::SeqCst) {
                    Err(Upstream::new(Some(503), "down"))
                } else {
                    Ok(serde_json::json!([{ "title": name }]))
                }
            })
        }
        fn search<'a>(
            &'a self,
            _: &'a Search<'a>,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Vec<Value>> {
            unreachable!()
        }
        fn fetch_work<'a>(
            &'a self,
            _: MediaKind,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Value> {
            unreachable!()
        }
        fn fetch_children<'a>(
            &'a self,
            _: MediaKind,
            _: &'a str,
            _: Option<u32>,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Vec<Value>> {
            unreachable!()
        }
        fn child_stubs<'a>(
            &'a self,
            _: MediaKind,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Vec<Value>> {
            unreachable!()
        }
        fn find_by<'a>(
            &'a self,
            _: Namespace,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Option<(String, MediaKind)>> {
            unreachable!()
        }
        fn fetch_person<'a>(
            &'a self,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, PersonDetails> {
            unreachable!()
        }
        fn person_credits<'a>(
            &'a self,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Credits> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn a_fresh_list_skips_the_provider_and_a_failed_one_serves_its_last_copy() {
        let pool = sqlx::PgPool::connect_lazy("postgres://unused").unwrap();
        let md = Metadata::new(pool);
        let down = Arc::new(Lists(AtomicBool::new(false), AtomicUsize::new(0)));
        md.add_plugin(down.clone());
        let lang = fliks_domain::metadata::language::resolve(None, None);
        let ask = |name: &'static str, params: Vec<(String, String)>| {
            let (md, lang) = (&md, &lang);
            async move {
                md.list(
                    Namespace::TMDB,
                    MediaKind::Movie,
                    name,
                    &params,
                    lang,
                    Priority::Interactive,
                )
                .await
            }
        };
        let day = vec![("window".to_owned(), "day".to_owned())];
        ask("trending", day.clone()).await.unwrap();
        ask("trending", day.clone()).await.unwrap();
        assert_eq!(down.1.load(Ordering::SeqCst), 1, "the fresh copy answered");
        ask("discover", vec![]).await.unwrap();
        ask("discover", vec![]).await.unwrap();
        assert_eq!(down.1.load(Ordering::SeqCst), 3, "discover is never stored");
        down.0.store(true, Ordering::SeqCst);
        for (at, _) in md.stale.lock_clean().values_mut() {
            *at -= FRESH;
        }
        assert_eq!(ask("trending", day).await.unwrap()[0]["title"], "trending");
        let week = vec![("window".to_owned(), "week".to_owned())];
        assert!(ask("trending", week).await.is_err(), "another key is cold");
        assert!(ask("discover", vec![]).await.is_err());
    }
}

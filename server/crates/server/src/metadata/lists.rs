//! The list routes' provider and stale-while-error cache (`provider-plugins.md` rule 44).
use super::{Metadata, Upstream};
use crate::sync::MutexExt;
use fliks_domain::{
    external_id::ExternalProvider,
    media::kind::MediaKind,
    metadata::{language::Resolved, limiter::Priority},
};
use serde_json::Value;

impl Metadata {
    /// The first available provider of the kind's order that serves lists, else TMDB.
    pub fn lister(&self, kind: MediaKind) -> ExternalProvider {
        self.pick(None, self.order(kind), |p| p.has_lists(kind))
            .unwrap_or(ExternalProvider::Tmdb)
    }

    /// `name` for `kind`; the last good copy answers when the live call fails, except for `discover`.
    pub async fn list(
        &self,
        kind: MediaKind,
        name: &str,
        params: &[(String, String)],
        lang: &Resolved,
        p: Priority,
    ) -> Result<Value, (ExternalProvider, Upstream)> {
        let id = self.lister(kind);
        let live = self.of(id).list(kind, name, params, lang, p).await;
        if name == "discover" {
            return live.map_err(|e| (id, e));
        }
        let key = format!(
            "{}:{name}:{}:{params:?}:{}:{}",
            id.as_str(),
            kind.as_str(),
            lang.tmdb_locale,
            lang.region
        );
        match live {
            Ok(v) => {
                self.stale.lock_clean().insert(key, v.clone());
                Ok(v)
            }
            Err(e) => match self.stale.lock_clean().get(&key) {
                Some(v) => {
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
        atomic::{AtomicBool, Ordering},
    };

    /// A TMDB-keyed provider whose lists fail on demand.
    struct Lists(AtomicBool);

    impl MetadataProvider for Lists {
        fn id(&self) -> ExternalProvider {
            ExternalProvider::Tmdb
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
            _: ExternalProvider,
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
    async fn a_failed_list_serves_its_last_copy_but_discover_never() {
        let pool = sqlx::PgPool::connect_lazy("postgres://unused").unwrap();
        let cfg = crate::config::MetadataConfig {
            tmdb_key: String::new(),
            tvdb_key: String::new(),
            tmdb_url: String::new(),
            tvdb_url: String::new(),
            tmdb_image_url: String::new(),
        };
        let mut md = Metadata::new(pool, &cfg);
        let down = Arc::new(Lists(AtomicBool::new(false)));
        md.register(down.clone());
        let lang = fliks_domain::metadata::language::resolve(None, None);
        let ask = |name: &'static str, params: Vec<(String, String)>| {
            let (md, lang) = (&md, &lang);
            async move {
                md.list(MediaKind::Movie, name, &params, lang, Priority::Interactive)
                    .await
            }
        };
        let day = vec![("window".to_owned(), "day".to_owned())];
        ask("trending", day.clone()).await.unwrap();
        ask("discover", vec![]).await.unwrap();
        down.0.store(true, Ordering::SeqCst);
        assert_eq!(ask("trending", day).await.unwrap()[0]["title"], "trending");
        let week = vec![("window".to_owned(), "week".to_owned())];
        assert!(ask("trending", week).await.is_err(), "another key is cold");
        assert!(ask("discover", vec![]).await.is_err());
    }
}

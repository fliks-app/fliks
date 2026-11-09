//! Acquisition providers (`plugins.md` section K): sources, provider order, request arbitration.
use super::Plugins;
use super::imports::host_err;
use super::runtime::{HostError, State};
use crate::state::AppState;
use crate::sync::MutexExt;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

pub const REQUESTED: &str = "media.acquisition.requested";
pub const NO_RELEASE: &str = "no-release";
pub const ORDER_KEY: &str = "acquisition.providerOrder";
pub const FALLBACK_KEY: &str = "acquisition.fallback";

const MAX_SOURCES: usize = 200;
const CHAIN_TTL: Duration = Duration::from_secs(3600);

#[derive(Clone, Debug, PartialEq)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub kinds: Vec<String>,
}

impl Source {
    pub fn json(&self) -> Value {
        json!({"id": self.id, "name": self.name, "kinds": self.kinds})
    }
}

/// The providers one request has gone through; the last is the one holding it.
struct Chain {
    tried: Vec<String>,
    reason: Value,
    at: Instant,
}

#[derive(Default)]
pub struct Pickers {
    sources: Mutex<HashMap<String, Vec<Source>>>,
    order: Mutex<Vec<String>>,
    fallback_off: AtomicBool,
    chains: Mutex<HashMap<i32, Chain>>,
}

impl Pickers {
    /// Replaces the plugin's sources; whether the list changed.
    pub fn set_sources(&self, id: &str, list: Vec<Source>) -> Result<bool, HostError> {
        if list.len() > MAX_SOURCES {
            return Err(host_err(
                "ERR_VALIDATION",
                format!("at most {MAX_SOURCES} sources"),
            ));
        }
        for (i, s) in list.iter().enumerate() {
            let bad =
                |what: &str| host_err("ERR_VALIDATION", format!("source \"{}\": {what}", s.id));
            if s.id.is_empty() || s.id.chars().count() > 128 {
                return Err(bad("id must be 1-128 characters"));
            }
            if s.name.is_empty() || s.name.chars().count() > 200 {
                return Err(bad("name must be 1-200 characters"));
            }
            if list[..i].iter().any(|o| o.id == s.id) {
                return Err(bad("duplicate id"));
            }
        }
        let mut g = self.sources.lock_clean();
        if g.get(id).map_or(list.is_empty(), |old| *old == list) {
            return Ok(false);
        }
        if list.is_empty() {
            g.remove(id);
        } else {
            g.insert(id.to_owned(), list);
        }
        Ok(true)
    }

    pub fn sources_of(&self, id: &str) -> Vec<Source> {
        self.sources
            .lock_clean()
            .get(id)
            .cloned()
            .unwrap_or_default()
    }

    /// Drops the plugin's sources; whether it had any.
    pub fn forget(&self, id: &str) -> bool {
        self.sources.lock_clean().remove(id).is_some()
    }

    fn serves(&self, id: &str, kind: &str) -> bool {
        self.sources
            .lock_clean()
            .get(id)
            .is_some_and(|l| l.iter().any(|s| s.kinds.iter().any(|k| k == kind)))
    }

    pub fn configure(&self, order: Vec<String>, fallback: bool) {
        *self.order.lock_clean() = order;
        self.fallback_off.store(!fallback, Ordering::Relaxed);
    }

    /// The admin's order first (unknown ids ignored), then the rest by id.
    pub fn ordered(&self, mut ids: Vec<String>) -> Vec<String> {
        ids.sort();
        let order = self.order.lock_clean();
        let mut out: Vec<String> = vec![];
        for id in order.iter() {
            if ids.contains(id) && !out.contains(id) {
                out.push(id.clone());
            }
        }
        let rest: Vec<String> = ids.into_iter().filter(|i| !out.contains(i)).collect();
        out.extend(rest);
        out
    }

    /// A new request for the media, held by `provider`.
    pub fn open(&self, media: i32, reason: Value, provider: &str) {
        let mut g = self.chains.lock_clean();
        g.retain(|_, c| c.at.elapsed() < CHAIN_TTL);
        g.insert(
            media,
            Chain {
                tried: vec![provider.to_owned()],
                reason,
                at: Instant::now(),
            },
        );
    }

    /// Rule 66: opens a chain per served media and answers one event per provider (the unserved first, as sent).
    pub fn plan(
        &self,
        payload: &Value,
        kinds: &HashMap<i32, String>,
        eligible: impl Fn(&str) -> Vec<String>,
    ) -> Vec<Value> {
        let mut groups: BTreeMap<Option<String>, Vec<i32>> = BTreeMap::new();
        let ids = payload["mediaIds"].as_array().into_iter().flatten();
        for id in ids.filter_map(|v| i32::try_from(v.as_i64()?).ok()) {
            let provider = kinds.get(&id).and_then(|k| eligible(k).into_iter().next());
            if let Some(p) = &provider {
                self.open(id, payload["reason"].clone(), p);
            }
            groups.entry(provider).or_default().push(id);
        }
        groups
            .into_iter()
            .map(|(provider, media)| {
                let mut ev = payload.clone();
                ev["mediaIds"] = json!(media);
                if let Some(p) = provider {
                    ev["provider"] = json!(p);
                }
                ev
            })
            .collect()
    }

    /// `plugin` found no release: the next of `eligible` not yet asked, with the request's reason.
    /// Only the provider holding the request moves it, so a repeated answer asks no one twice.
    pub fn advance(
        &self,
        media: i32,
        plugin: &str,
        eligible: &[String],
    ) -> Option<(String, Value)> {
        let mut g = self.chains.lock_clean();
        let chain = g.get_mut(&media)?;
        if chain.tried.last().map(String::as_str) != Some(plugin) {
            return None;
        }
        let next = (!self.fallback_off.load(Ordering::Relaxed))
            .then(|| eligible.iter().find(|p| !chain.tried.contains(p)))
            .flatten()
            .cloned();
        match next {
            Some(n) => {
                chain.tried.push(n.clone());
                Some((n, chain.reason.clone()))
            }
            None => {
                g.remove(&media);
                None
            }
        }
    }
}

impl Plugins {
    /// Ready plugins declaring a release picker, in provider order.
    pub fn providers(&self) -> Vec<String> {
        let ready = self
            .registry
            .release_picker_ids()
            .into_iter()
            .filter(|id| self.state_of(id) == Some(State::Ready))
            .collect();
        self.pickers.ordered(ready)
    }

    /// The providers with a source for `kind`, in order.
    pub fn eligible(&self, kind: &str) -> Vec<String> {
        let mut p = self.providers();
        p.retain(|id| self.pickers.serves(id, kind));
        p
    }

    /// Reads the order and fallback settings.
    pub async fn load_acquisition_settings(&self) {
        let get = |k: &'static str| async move {
            crate::settings::setting_value(&self.db, k)
                .await
                .ok()
                .flatten()
        };
        let order = get(ORDER_KEY)
            .await
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default();
        let fallback = get(FALLBACK_KEY).await.as_deref() != Some("false");
        self.pickers.configure(order, fallback);
    }

    pub(super) fn push_to_plugins(&self, name: &str, payload: &Value) {
        let text = payload.to_string();
        for rt in self.live() {
            rt.push_event(name, &text);
        }
    }

    /// Rule 66: one rewritten event per provider; the media nobody serves keep the plain event.
    pub(super) async fn arbitrate(&self, st: &AppState, payload: Value) {
        let ids: Vec<i32> = payload["mediaIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| i32::try_from(v.as_i64()?).ok())
            .collect();
        let kinds: HashMap<i32, String> =
            sqlx::query_as("SELECT id, type FROM media WHERE id = ANY($1)")
                .bind(&ids)
                .fetch_all(&st.db)
                .await
                .unwrap_or_default()
                .into_iter()
                .collect();
        for ev in self.pickers.plan(&payload, &kinds, |k| self.eligible(k)) {
            self.push_to_plugins(REQUESTED, &ev);
        }
    }

    /// `acquisition.failed {reason: no-release}` from `plugin` for `media_id`.
    pub async fn no_release(&self, st: &AppState, plugin: &str, media_id: i32) {
        let kind: Option<String> = sqlx::query_scalar("SELECT type FROM media WHERE id = $1")
            .bind(media_id)
            .fetch_optional(&st.db)
            .await
            .ok()
            .flatten();
        let eligible = kind.map(|k| self.eligible(&k)).unwrap_or_default();
        if let Some((next, reason)) = self.pickers.advance(media_id, plugin, &eligible) {
            let ev = json!({"type": REQUESTED, "mediaIds": [media_id], "reason": reason, "provider": next});
            self.push_to_plugins(REQUESTED, &ev);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn src(id: &str, kinds: &[&str]) -> Source {
        Source {
            id: id.into(),
            name: id.into(),
            kinds: kinds.iter().map(|k| (*k).into()).collect(),
        }
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn sources_report_changes_and_refuse_bad_lists() {
        let p = Pickers::default();
        assert!(!p.set_sources("a", vec![]).unwrap());
        assert!(p.set_sources("a", vec![src("1", &["movie"])]).unwrap());
        assert!(!p.set_sources("a", vec![src("1", &["movie"])]).unwrap());
        assert!(p.serves("a", "movie") && !p.serves("a", "album") && !p.serves("b", "movie"));
        assert!(
            p.set_sources("a", vec![src("1", &[]), src("1", &[])])
                .is_err()
        );
        assert!(p.set_sources("a", vec![src("", &[])]).is_err());
        assert!(
            p.set_sources("a", (0..201).map(|i| src(&i.to_string(), &[])).collect())
                .is_err()
        );
        assert_eq!(
            p.sources_of("a").len(),
            1,
            "a refused list keeps the old one"
        );
        assert!(p.forget("a") && !p.forget("a"));
    }

    #[test]
    fn the_order_lists_known_ids_first_then_the_rest_by_id() {
        let p = Pickers::default();
        p.configure(ids(&["c", "ghost", "a", "c"]), true);
        assert_eq!(
            p.ordered(ids(&["b", "a", "c", "d"])),
            ids(&["c", "a", "b", "d"])
        );
        p.configure(vec![], true);
        assert_eq!(p.ordered(ids(&["b", "a"])), ids(&["a", "b"]));
    }

    #[test]
    fn a_request_visits_each_provider_once_then_ends() {
        let p = Pickers::default();
        p.configure(vec![], true);
        let all = ids(&["a", "b", "c"]);
        p.open(1, json!("r"), "a");
        assert_eq!(p.advance(1, "b", &all), None, "b does not hold it");
        assert_eq!(p.advance(1, "a", &all), Some(("b".into(), json!("r"))));
        assert_eq!(p.advance(1, "a", &all), None, "a already answered");
        assert_eq!(p.advance(1, "b", &all), Some(("c".into(), json!("r"))));
        assert_eq!(p.advance(1, "c", &all), None);
        assert_eq!(p.advance(1, "c", &all), None, "the chain ended");
        assert_eq!(p.advance(2, "a", &all), None, "no open request");
    }

    #[test]
    fn fallback_off_ends_the_request_at_the_first_answer() {
        let p = Pickers::default();
        p.configure(vec![], false);
        p.open(1, json!("r"), "a");
        assert_eq!(p.advance(1, "a", &ids(&["a", "b"])), None);
        p.configure(vec![], true);
        assert_eq!(
            p.advance(1, "a", &ids(&["a", "b"])),
            None,
            "the request is gone"
        );
    }

    #[test]
    fn a_new_request_restarts_the_chain() {
        let p = Pickers::default();
        p.configure(vec![], true);
        let all = ids(&["a", "b"]);
        p.open(1, json!("r1"), "a");
        assert!(p.advance(1, "a", &all).is_some());
        p.open(1, json!("r2"), "a");
        assert_eq!(p.advance(1, "a", &all), Some(("b".into(), json!("r2"))));
    }

    #[test]
    fn concurrent_no_release_answers_ask_the_next_provider_once() {
        let p = Arc::new(Pickers::default());
        p.configure(vec![], true);
        let all = ids(&["a", "b", "c"]);
        for media in 0..50 {
            p.open(media, json!("r"), "a");
        }
        let hits: usize = (0..8)
            .map(|_| {
                let (p, all) = (p.clone(), all.clone());
                std::thread::spawn(move || {
                    (0..50)
                        .filter(|m| p.advance(*m, "a", &all).is_some())
                        .count()
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .sum();
        assert_eq!(
            hits, 50,
            "one fallback per media, whatever the racing answers"
        );
    }

    #[test]
    fn a_request_is_split_per_provider_and_opens_one_chain_per_served_media() {
        let p = Pickers::default();
        p.configure(vec![], true);
        let kinds: HashMap<i32, String> = [(1, "movie"), (2, "album"), (3, "book")]
            .map(|(i, k)| (i, k.to_owned()))
            .into();
        let eligible = |k: &str| match k {
            "movie" => ids(&["a", "b"]),
            "album" => ids(&["b"]),
            _ => vec![],
        };
        let ev = json!({"type": REQUESTED, "mediaIds": [1, 2, 3, 4], "reason": "r"});
        let out = p.plan(&ev, &kinds, eligible);
        assert_eq!(
            out,
            [
                json!({"type": REQUESTED, "mediaIds": [3, 4], "reason": "r"}),
                json!({"type": REQUESTED, "mediaIds": [1], "reason": "r", "provider": "a"}),
                json!({"type": REQUESTED, "mediaIds": [2], "reason": "r", "provider": "b"}),
            ]
        );
        assert_eq!(
            p.advance(1, "a", &ids(&["a", "b"])).map(|n| n.0),
            Some("b".into())
        );
        assert_eq!(p.advance(2, "b", &ids(&["b"])), None);
        assert_eq!(
            p.advance(3, "a", &ids(&["a"])),
            None,
            "an unserved media opens nothing"
        );
    }
}

//! Acquisition providers (`plugins.md` section K): sources and provider order.
use super::Plugins;
use super::imports::host_err;
use super::runtime::{HostError, State};
use crate::sync::MutexExt;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Mutex;

pub const REQUESTED: &str = "media.acquisition.requested";
pub const ORDER_KEY: &str = "acquisition.providerOrder";
pub const INTERVAL_KEY: &str = "acquisition.sweepInterval";
pub const DEFAULT_INTERVAL_MINUTES: i64 = 360;

const MAX_SOURCES: usize = 200;

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

#[derive(Default)]
pub struct Pickers {
    sources: Mutex<HashMap<String, Vec<Source>>>,
    order: Mutex<Vec<String>>,
}

/// `acquisition.providerOrder` must be a JSON-encoded array of strings.
pub fn validate_order(value: &str) -> Result<(), &'static str> {
    serde_json::from_str::<Vec<String>>(value)
        .map(|_| ())
        .map_err(
            |_| "acquisition.providerOrder must be a JSON array of plugin ids, sent as a string",
        )
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

    pub fn configure(&self, order: Vec<String>) {
        *self.order.lock_clean() = order;
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

    /// Reads the provider order setting.
    pub async fn load_acquisition_settings(&self) {
        let order = crate::settings::setting_value(&self.db, ORDER_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default();
        self.pickers.configure(order);
    }

    pub(super) fn push_to_plugins(&self, name: &str, payload: &Value) {
        let text = payload.to_string();
        for rt in self.live() {
            rt.push_event(name, &text);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        p.configure(ids(&["c", "ghost", "a", "c"]));
        assert_eq!(
            p.ordered(ids(&["b", "a", "c", "d"])),
            ids(&["c", "a", "b", "d"])
        );
        p.configure(vec![]);
        assert_eq!(p.ordered(ids(&["b", "a"])), ids(&["a", "b"]));
    }

    #[test]
    fn the_order_setting_must_be_a_json_array_of_strings() {
        assert!(validate_order(r#"["a","b"]"#).is_ok() && validate_order("[]").is_ok());
        for bad in [r#"{"a","b"}"#, "a,b", r#"{"a":1}"#, "[1]", ""] {
            assert!(validate_order(bad).is_err(), "{bad}");
        }
    }
}

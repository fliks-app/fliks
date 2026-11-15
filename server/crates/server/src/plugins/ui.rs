//! `GET /api/plugins/ui` (`plugins.md` rule 48): the in-memory registry cut to the viewer.
use super::Plugins;
use super::registry::Registered;
use super::runtime::State;
use fliks_domain::acl::{Action, Permissions, Subject};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// The client's `fallbackLang`: a `lang` cut always keeps it.
const FALLBACK_LANG: &str = "en";

#[derive(serde::Deserialize, utoipa::IntoParams)]
pub struct UiQuery {
    /// Keeps each plugin's `i18n` to this locale and the fallback one; every locale without it.
    pub lang: Option<String>,
}

fn i18n_in(i18n: Option<&Value>, lang: Option<&str>) -> Value {
    let kept = i18n
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(l, _)| lang.is_none_or(|lang| *l == lang || *l == FALLBACK_LANG))
        .map(|(l, d)| (l.clone(), d.clone()));
    Value::Object(kept.collect())
}

fn i18n_keys(r: &Registered) -> BTreeSet<String> {
    r.manifest["i18n"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
        .filter_map(Value::as_object)
        .flat_map(|d| d.keys().cloned())
        .collect()
}

fn conflict(a: &str, b: &str) -> bool {
    a == b || a.starts_with(&format!("{b}.")) || b.starts_with(&format!("{a}."))
}

/// Official signatures first, then by id; a plugin whose keys collide is dropped.
fn without_collisions(plugins: Vec<Registered>) -> Vec<Registered> {
    let mut ordered = plugins.clone();
    ordered.sort_by(|a, b| {
        (b.signature == "official")
            .cmp(&(a.signature == "official"))
            .then_with(|| a.plugin_id.cmp(&b.plugin_id))
    });
    let mut accepted: Vec<(String, BTreeSet<String>)> = vec![];
    for p in ordered {
        let keys = i18n_keys(&p);
        let hit = accepted.iter().find_map(|(other, theirs)| {
            theirs.iter().find_map(|e| {
                keys.iter()
                    .find(|k| conflict(k, e))
                    .map(|k| (other.clone(), k.clone()))
            })
        });
        match hit {
            Some((other, key)) => tracing::warn!(
                "plugin \"{}\" refused from /plugins/ui: i18n key \"{key}\" collides with \"{other}\"",
                p.plugin_id
            ),
            None => accepted.push((p.plugin_id.clone(), keys)),
        }
    }
    plugins
        .into_iter()
        .filter(|p| accepted.iter().any(|(id, _)| *id == p.plugin_id))
        .collect()
}

/// Rule 39: every field carries `hasDefault`; a `fliks:` default is dropped, never sent.
fn mark_defaults(page: &mut Value, p: &Registered) {
    let keys: Vec<String> = super::defaults::for_plugin(&p.manifest, p.signature == "official")
        .into_iter()
        .map(|(k, _)| k)
        .collect();
    let requires: Vec<String> = p.manifest["provider"]["requires"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect();
    fn walk(items: &mut Value, keys: &[String], requires: &[String]) {
        for i in items.as_array_mut().into_iter().flatten() {
            if i["kind"] == "group" {
                walk(&mut i["fields"], keys, requires);
            } else if let Some(k) = i["key"].as_str() {
                let (has, req) = (keys.iter().any(|d| d == k), requires.iter().any(|d| d == k));
                if i["default"]
                    .as_str()
                    .is_some_and(|d| d.starts_with("fliks:"))
                {
                    i.as_object_mut().map(|o| o.remove("default"));
                }
                i["hasDefault"] = json!(has);
                i["requiredByProvider"] = json!(req);
            }
        }
    }
    walk(&mut page["fields"], &keys, &requires);
}

impl Plugins {
    fn may_read(&self, id: &str, page: &Value, perms: &Permissions) -> bool {
        let kind = page["kind"].as_str();
        if kind != Some("table") && kind != Some("providers") {
            // A form page edits settings, which only the admin area (`settings.access`) shows.
            return perms.can(Action::Manage, &Subject::Settings);
        }
        let list = page["list"].as_str().unwrap_or_default();
        self.registry
            .resolve(id, "GET", list)
            .is_some_and(|r| self.registry.allows(id, &r.route.policy, perms))
    }

    pub fn ui(&self, perms: &Permissions, lang: Option<&str>) -> Vec<Value> {
        let active: Vec<Registered> = self
            .registry
            .list()
            .into_iter()
            .filter(|p| !p.is_process() || self.state_of(&p.plugin_id) == Some(State::Ready))
            .collect();
        let entries: Vec<Value> = without_collisions(active)
            .into_iter()
            .map(|p| {
                let ui = &p.manifest["ui"];
                let id = &p.plugin_id;
                let mut hidden = BTreeSet::new();
                let pages: Vec<Value> = ui["configPages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|page| {
                        let ok = self.may_read(id, page, perms);
                        if !ok {
                            let pid = page["id"].as_str().unwrap_or_default();
                            hidden.insert(format!("/plugins/{id}/{pid}"));
                            hidden.insert(format!("/admin/settings/plugins/{id}/{pid}"));
                        }
                        ok
                    })
                    .cloned()
                    .map(|mut page| {
                        mark_defaults(&mut page, &p);
                        page
                    })
                    .collect();
                let contributions: Vec<Value> = ui["contributions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|c| {
                        c["action"]["kind"] != "route"
                            || !hidden.contains(c["action"]["path"].as_str().unwrap_or_default())
                    })
                    .cloned()
                    .collect();
                let mut e = Map::new();
                e.insert("pluginId".into(), json!(id));
                e.insert("name".into(), p.manifest["name"].clone());
                e.insert("contributions".into(), Value::Array(contributions));
                e.insert("configPages".into(), Value::Array(pages));
                e.insert("i18n".into(), i18n_in(p.manifest.get("i18n"), lang));
                if let Some(block) = p.manifest.get("provider") {
                    let names: Vec<_> = block["namespaces"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|n| n["name"].clone())
                        .collect();
                    let kinds: Vec<_> = block["kinds"]
                        .as_object()
                        .map(|o| o.keys().collect())
                        .unwrap_or_default();
                    let lyrics = block["kinds"]["album"]
                        .as_array()
                        .is_some_and(|c| c.iter().any(|c| c == "lyrics"));
                    e.insert(
                        "provider".into(),
                        json!({"namespaces": names, "kinds": kinds, "lyrics": lyrics}),
                    );
                }
                Value::Object(e)
            })
            .collect();
        self.with_providers(entries)
    }

    /// Rule 48: provider entries first in provider order, each with `acquisition`; the first keeps `releasePicker`.
    fn with_providers(&self, mut entries: Vec<Value>) -> Vec<Value> {
        let order = self.providers();
        let pos = |e: &Value| order.iter().position(|id| e["pluginId"] == *id);
        entries.sort_by_key(|e| pos(e).unwrap_or(usize::MAX));
        let mut first = true;
        for e in entries.iter_mut() {
            let id = e["pluginId"].as_str().unwrap_or_default().to_owned();
            let Some(rp) = pos(e).and(self.registry.release_picker_of(&id)) else {
                continue;
            };
            let routes = json!({"byKind": rp});
            let sources: Vec<Value> = self
                .pickers
                .sources_of(&id)
                .iter()
                .map(|s| s.json())
                .collect();
            e["acquisition"] = json!({"order": pos(e), "routes": routes, "sources": sources});
            if std::mem::take(&mut first) {
                e["releasePicker"] = routes;
            }
        }
        entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lang_keeps_that_locale_and_the_fallback_one() {
        let i18n = json!({"en": {"a.b": "B"}, "fr": {"a.b": "Bé"}, "de": {"a.b": "Be"}});
        assert_eq!(i18n_in(Some(&i18n), None), i18n);
        assert_eq!(
            i18n_in(Some(&i18n), Some("fr")),
            json!({"en": {"a.b": "B"}, "fr": {"a.b": "Bé"}})
        );
        assert_eq!(
            i18n_in(Some(&i18n), Some("it")),
            json!({"en": {"a.b": "B"}})
        );
        assert_eq!(i18n_in(None, Some("fr")), json!({}));
    }

    #[test]
    fn marking_adds_a_flag_and_no_value() {
        let manifest = json!({"provider": {"namespaces": [{"name": "tmdb"}]}});
        let reg = |signature: &str| Registered {
            plugin_id: "fliks.tmdb".into(),
            version: "1".into(),
            manifest: manifest.clone(),
            signature: signature.into(),
            archive: Default::default(),
        };
        let page =
            json!({"fields": [{"key": "apiKey", "secret": true, "default": "fliks:apiKey"}]});
        for sig in ["official", "unsigned"] {
            let mut p = page.clone();
            mark_defaults(&mut p, &reg(sig));
            assert!(p["fields"][0]["hasDefault"].is_boolean());
            assert!(p["fields"][0].get("default").is_none());
            assert!(!p.to_string().contains("FLIKS_DEFAULT"));
        }
    }
}

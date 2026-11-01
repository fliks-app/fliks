//! `GET /api/plugins/ui` (`plugins.md` rule 48): the in-memory registry cut to the viewer.
use super::Plugins;
use super::registry::Registered;
use super::runtime::State;
use fliks_domain::acl::Permissions;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

/// `byKind` as declared, plus the `movie`, `season` and `episode` pairs installed apps read.
fn picker_entry(rp: Value) -> Value {
    let pair = |kind: &str, level: &str| Some(rp[kind][level].clone()).filter(Value::is_object);
    let pairs = (
        pair("movie", "work"),
        pair("series", "group"),
        pair("series", "item"),
    );
    let mut out = Map::new();
    if let (Some(movie), Some(season), Some(episode)) = pairs {
        out.extend([
            ("movie".to_owned(), movie),
            ("season".to_owned(), season),
            ("episode".to_owned(), episode),
        ]);
    }
    out.insert("byKind".into(), rp);
    Value::Object(out)
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

impl Plugins {
    fn may_read(&self, id: &str, page: &Value, perms: &Permissions) -> bool {
        let kind = page["kind"].as_str();
        if kind != Some("table") && kind != Some("providers") {
            return true;
        }
        let list = page["list"].as_str().unwrap_or_default();
        self.registry
            .resolve(id, "GET", list)
            .is_some_and(|r| self.registry.allows(id, &r.route.policy, perms))
    }

    pub fn ui(&self, perms: &Permissions) -> Vec<Value> {
        let active: Vec<Registered> = self
            .registry
            .list()
            .into_iter()
            .filter(|p| !p.is_process() || self.state_of(&p.plugin_id) == Some(State::Ready))
            .collect();
        without_collisions(active)
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
                e.insert(
                    "i18n".into(),
                    p.manifest.get("i18n").cloned().unwrap_or(json!({})),
                );
                if let Some(rp) = self.registry.release_picker_for(id) {
                    e.insert("releasePicker".into(), picker_entry(rp));
                }
                Value::Object(e)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_entry_serves_by_kind_and_the_three_pairs() {
        let pair = json!({"search": "/s", "grab": "/g"});
        let all = json!({"movie": {"work": pair}, "series": {"group": pair, "item": pair}});
        let e = picker_entry(all.clone());
        assert_eq!(e["byKind"], all);
        assert_eq!(
            (&e["movie"], &e["season"], &e["episode"]),
            (&pair, &pair, &pair)
        );
        let movie_only = picker_entry(json!({"movie": {"work": pair}}));
        assert_eq!(
            movie_only.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["byKind"]
        );
    }
}

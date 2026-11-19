//! Notification text: the `push` branch of the client's `i18n/<lang>.json`, English constants as fallback.
use crate::sync::MutexExt;
use fliks_domain::push::{english, interpolate, locale};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// A piece of text: a core key rendered from the client files, or a table of the plugin that sends it.
#[derive(Debug, Clone)]
pub enum Msg {
    Core {
        path: String,
        params: Map<String, Value>,
    },
    Table {
        by_locale: BTreeMap<String, String>,
        params: Map<String, Value>,
    },
}

impl Msg {
    pub fn core(path: impl Into<String>, params: &Map<String, Value>) -> Self {
        Self::Core {
            path: path.into(),
            params: params.clone(),
        }
    }
}

pub struct Texts {
    dir: Option<PathBuf>,
    cache: Mutex<HashMap<&'static str, Arc<Value>>>,
}

impl Texts {
    pub fn new(static_dir: Option<&std::path::Path>) -> Self {
        Self {
            dir: static_dir.map(|d| d.join("i18n")),
            cache: Mutex::default(),
        }
    }

    fn file(&self, lang: &'static str) -> Arc<Value> {
        let mut g = self.cache.lock_clean();
        g.entry(lang)
            .or_insert_with(|| {
                let read = self
                    .dir
                    .as_ref()
                    .and_then(|d| std::fs::read(d.join(format!("{lang}.json"))).ok());
                Arc::new(
                    read.and_then(|b| serde_json::from_slice(&b).ok())
                        .unwrap_or(Value::Null),
                )
            })
            .clone()
    }

    fn lookup(&self, lang: &'static str, path: &str) -> Option<String> {
        let file = self.file(lang);
        let mut at = file.get("push")?;
        for part in path.split('.') {
            at = at.get(part)?;
        }
        at.as_str().map(str::to_owned)
    }

    pub fn render(&self, msg: &Msg, tag: &str) -> String {
        let lang = locale(tag);
        match msg {
            Msg::Core { path, params } => {
                let template = self
                    .lookup(lang, path)
                    .or_else(|| self.lookup("en", path))
                    .or_else(|| english(path).map(str::to_owned))
                    .unwrap_or_default();
                interpolate(&template, params)
            }
            Msg::Table { by_locale, params } => {
                let template = by_locale
                    .get(lang)
                    .or_else(|| by_locale.get("en"))
                    .or_else(|| by_locale.values().next())
                    .cloned()
                    .unwrap_or_default();
                interpolate(&template, params)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params() -> Map<String, Value> {
        json!({"title": "A"}).as_object().cloned().unwrap()
    }

    #[test]
    fn reads_the_client_file_then_english_then_the_constant() {
        let dir =
            std::env::temp_dir().join(format!("fliks-push-text-{}", crate::config::random_hex(4)));
        std::fs::create_dir_all(dir.join("i18n")).unwrap();
        std::fs::write(
            dir.join("i18n/fr.json"),
            json!({"push": {"request_approved": {"title": "Demande acceptee", "body": "{{title}} accepte"}}}).to_string(),
        )
        .unwrap();
        let t = Texts::new(Some(&dir));
        let title = Msg::core("request_approved.title", &params());
        let body = Msg::core("request_approved.body", &params());
        assert_eq!(t.render(&title, "fr-CA"), "Demande acceptee");
        assert_eq!(t.render(&body, "fr"), "A accepte");
        // no german file: the English constant
        assert_eq!(t.render(&body, "de"), "A was approved");
        assert_eq!(Texts::new(None).render(&title, "fr"), "Request approved");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_plugin_table_falls_back_to_english() {
        let by = BTreeMap::from([
            ("en".to_owned(), "Hi {{title}}".to_owned()),
            ("fr".to_owned(), "Salut {{title}}".to_owned()),
        ]);
        let m = Msg::Table {
            by_locale: by,
            params: params(),
        };
        let t = Texts::new(None);
        assert_eq!(t.render(&m, "fr"), "Salut A");
        assert_eq!(t.render(&m, "it"), "Hi A");
    }
}

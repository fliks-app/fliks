//! `notify.users` (`plugins.md` rule 76): a plugin's notification through the push pipeline.
use super::events::{media_row, recipients, viewers};
use super::imports::host_err;
use super::runtime::HostError;
use super::runtime::fliks::plugin::notify as w;
use crate::push::{self, ActionSpec, Msg, Notification, media_url, poster};
use crate::state::AppState;
use crate::sync::MutexExt;
use fliks_domain::push::{LOCALES, PLUGIN_PREFIX};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const PER_HOUR: usize = 10;
const WINDOW: Duration = Duration::from_secs(3600);
const DAY: u32 = 86_400;
const MAX_USERS: usize = 500;
const MAX_PARAMS: usize = 16;
const MAX_TEXT: usize = 500;

/// Sends of each plugin in the last hour, one entry per call whatever its audience.
#[derive(Default)]
pub struct Limiter(Mutex<HashMap<String, VecDeque<Instant>>>);

impl Limiter {
    pub fn take(&self, plugin: &str) -> bool {
        let now = Instant::now();
        let mut all = self.0.lock_clean();
        let sent = all.entry(plugin.to_owned()).or_default();
        while sent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= WINDOW)
        {
            sent.pop_front();
        }
        if sent.len() >= PER_HOUR {
            return false;
        }
        sent.push_back(now);
        true
    }
}

fn invalid(m: impl Into<String>) -> HostError {
    host_err("ERR_VALIDATION", m)
}

/// `path` must stay on this server: absolute, not protocol-relative, no control character.
fn local_path(what: &str, path: &str) -> Result<(), HostError> {
    let ok = path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= MAX_TEXT
        && !path.chars().any(char::is_control);
    ok.then_some(()).ok_or_else(|| {
        invalid(format!(
            "notify.users: {what} must be a path of this server"
        ))
    })
}

/// The texts of `key` in each language of the manifest `i18n`, by base language.
fn table(manifest: &Value, key: &str) -> Result<BTreeMap<String, String>, HostError> {
    let mut by_locale = BTreeMap::new();
    for (tag, dict) in manifest["i18n"].as_object().into_iter().flatten() {
        let base = tag
            .split(['-', '_'])
            .next()
            .unwrap_or_default()
            .to_lowercase();
        if let (Some(lang), Some(text)) =
            (LOCALES.into_iter().find(|l| *l == base), dict[key].as_str())
        {
            by_locale.insert(lang.to_owned(), text.to_owned());
        }
    }
    if by_locale.is_empty() {
        return Err(invalid(format!(
            "notify.users: \"{key}\" is not in the manifest i18n"
        )));
    }
    Ok(by_locale)
}

pub async fn send(
    st: &AppState,
    id: &str,
    audience: w::NotifyAudience,
    n: w::Notification,
) -> Result<(), HostError> {
    if n.params.len() > MAX_PARAMS
        || n.params
            .iter()
            .any(|(k, v)| k.len() > 64 || v.len() > MAX_TEXT)
    {
        return Err(invalid("notify.users: too many or too long params"));
    }
    if let w::NotifyAudience::Users(u) = &audience
        && u.len() > MAX_USERS
    {
        return Err(invalid(format!("notify.users: at most {MAX_USERS} users")));
    }
    let manifest = st
        .plugins
        .registry
        .get(id)
        .ok_or_else(|| {
            host_err(
                "ERR_NOT_FOUND",
                format!("plugin \"{id}\" has no active registration"),
            )
        })?
        .manifest;
    let (title, body) = (
        table(&manifest, &n.title_key)?,
        table(&manifest, &n.body_key)?,
    );
    for (what, v) in [("url", &n.url), ("image", &n.image)] {
        if let Some(v) = v {
            local_path(what, v)?;
        }
    }
    let (mut url, mut image) = (n.url, n.image);
    if let Some(m) = n.media_id {
        let (_, kind) = media_row(st, m as i32)
            .await
            .ok_or_else(|| host_err("ERR_NOT_FOUND", format!("media {m} not found")))?;
        url.get_or_insert_with(|| media_url(m as i32, kind));
        image.get_or_insert_with(|| poster(m as i32));
    }
    if !st.plugins.notify.take(id) {
        return Err(host_err(
            "ERR_RATE_LIMITED",
            "notify.users: 10 notifications per hour",
        ));
    }
    let to = match audience {
        w::NotifyAudience::Users(u) => u.into_iter().map(|u| u as i32).collect(),
        w::NotifyAudience::Recipients(m) => recipients(st, Some(m as i32)).await,
        w::NotifyAudience::Viewers(m) => viewers(st, Some(m as i32)).await,
    };
    let params: Map<String, Value> = n
        .params
        .into_iter()
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    let url = url.unwrap_or_else(|| "/".into());
    push::notify(
        st,
        to,
        Notification {
            category: format!("{PLUGIN_PREFIX}{id}"),
            title: Msg::Table {
                by_locale: title,
                params: params.clone(),
            },
            body: Msg::Table {
                by_locale: body,
                params,
            },
            actions: vec![ActionSpec::Open {
                id: "open",
                url: url.clone(),
            }],
            url,
            image,
            ttl: DAY,
            urgent: false,
            tag: None,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ten_an_hour_per_plugin() {
        let l = Limiter::default();
        assert!((0..10).all(|_| l.take("a")));
        assert!(!l.take("a"));
        assert!(l.take("b"));
    }

    #[test]
    fn texts_come_from_the_manifest_by_base_language() {
        let m =
            json!({"i18n": {"en": {"a.t": "Hi"}, "fr-FR": {"a.t": "Salut"}, "xx": {"a.t": "?"}}});
        let t = table(&m, "a.t").unwrap();
        assert_eq!(t.get("fr").map(String::as_str), Some("Salut"));
        assert_eq!(t.len(), 2);
        assert!(table(&m, "a.missing").is_err());
    }

    #[test]
    fn urls_stay_on_the_server() {
        assert!(local_path("url", "/series/3").is_ok());
        for bad in ["//evil.example", "https://evil.example", "series", "/a\nb"] {
            assert!(local_path("url", bad).is_err(), "{bad}");
        }
    }
}

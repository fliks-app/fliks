//! Notification vocabulary, message formatting, channel requests and settings rules (`docs/spec/notifications.md`).
use crate::js::{js_string, trim};
use serde_json::{Map, Value, json};

pub const TYPES: [&str; 5] = ["discord", "slack", "webhook", "gotify", "ntfy"];

/// `NOTIFICATION_EVENTS`, in vocabulary order.
pub const EVENTS: [&str; 20] = [
    "request.created",
    "request.approved",
    "request.declined",
    "request.processing",
    "request.available",
    "request.delete.created",
    "request.delete.approved",
    "request.delete.declined",
    "grab.started",
    "download.complete",
    "health.issue",
    "subtitle.downloaded",
    "subtitle.upgraded",
    "subtitle.failed",
    "subtitle.synced",
    "livetv.account_expiring",
    "livetv.account_expired",
    "livetv.adult_guard_failed",
    "media.leaving_soon",
    "media.cleaned_up",
];

/// What `GET /notifications/events` lists: `health.issue` is only ever sent by the test route.
pub fn subscribable() -> impl Iterator<Item = &'static str> {
    EVENTS.into_iter().filter(|e| *e != "health.issue")
}

pub fn is_event(event: &str) -> bool {
    EVENTS.contains(&event)
}

/// Where each sender reads its endpoint; `None` for an unknown type.
pub fn endpoint_key(typ: &str) -> Option<&'static str> {
    match typ {
        "discord" | "slack" => Some("webhookUrl"),
        "webhook" | "gotify" | "ntfy" => Some("url"),
        _ => None,
    }
}

/// The settings keys redacted on read and merged on write.
pub fn secret_keys(typ: &str) -> &'static [&'static str] {
    match endpoint_key(typ) {
        Some("webhookUrl") => &["token", "webhookUrl"],
        _ => &["token"],
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(v ?? default)`.
fn text(v: Option<&Value>, default: &str) -> String {
    match v {
        None | Some(Value::Null) => default.into(),
        Some(v) => js_string(v),
    }
}

/// ` S02` or ` S02E05` for a season or episode scope, else empty.
fn scope(payload: &Map<String, Value>) -> String {
    let n = |k: &str| payload.get(k).and_then(Value::as_i64);
    match (n("seasonNumber"), n("episodeNumber")) {
        (Some(s), Some(e)) => format!(" S{s:02}E{e:02}"),
        (Some(s), None) => format!(" S{s:02}"),
        _ => String::new(),
    }
}

/// `formatMessage`.
pub fn format_message(event: &str, payload: &Map<String, Value>) -> String {
    let title = text(payload.get("title"), "");
    let lang = || text(payload.get("language"), "");
    let src = || text(payload.get("sourceName"), "");
    match event {
        "request.created" => format!("New request: {title}"),
        "request.approved" => format!("Request approved: {title}"),
        "request.declined" => format!("Request declined: {title}"),
        "request.delete.created" => format!("New deletion request: {title}"),
        "request.delete.approved" => format!("Deletion request approved: {title}"),
        "request.delete.declined" => format!("Deletion request declined: {title}"),
        "request.processing" => format!("Request downloading: {title}"),
        "request.available" => format!("Request available: {title}"),
        "grab.started" => format!("Grabbing: {title}"),
        "download.complete" => format!("Download complete: {title}"),
        "health.issue" => text(payload.get("message"), "Health issue detected"),
        "subtitle.downloaded" => format!("Subtitle downloaded: {title} [{}]", lang()),
        "subtitle.upgraded" => format!("Subtitle upgraded: {title} [{}]", lang()),
        "subtitle.failed" => format!("Subtitle download failed: {title} [{}]", lang()),
        "subtitle.synced" => format!("Subtitle synced [{}]", lang()),
        "livetv.account_expiring" => format!("Live TV source \"{}\" account expires soon", src()),
        "livetv.account_expired" => format!("Live TV source \"{}\" account has expired", src()),
        "livetv.adult_guard_failed" => format!(
            "Live TV source \"{}\" adult-group restriction pass failed",
            src()
        ),
        "media.leaving_soon" => {
            let left = match payload.get("daysLeft").and_then(Value::as_i64) {
                Some(1) => " (1 day)".to_owned(),
                Some(n) => format!(" ({n} days)"),
                None => String::new(),
            };
            format!("Leaving soon: {title}{}{left}", scope(payload))
        }
        "media.cleaned_up" => format!("Cleaned up: {title}{}", scope(payload)),
        _ => format!("{event}: {}", Value::Object(payload.clone())),
    }
}

#[derive(Debug, PartialEq)]
pub enum Body {
    Json(Value),
    Text(String),
}

/// One outbound POST.
#[derive(Debug, PartialEq)]
pub struct Request {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Body,
}

/// `encodeURIComponent`.
fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' => out.push(b as char),
            b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The request a connection sends for an event; `Ok(None)` for a type without a sender, `Err` for
/// missing config (the literal messages surface in the `test` response).
pub fn build_request(
    typ: &str,
    settings: &Map<String, Value>,
    event: &str,
    payload: &Map<String, Value>,
) -> Result<Option<Request>, String> {
    let endpoint = endpoint_key(typ).map_or_else(String::new, |k| text(settings.get(k), ""));
    let msg = || format_message(event, payload);
    let trimmed = || endpoint.strip_suffix('/').unwrap_or(&endpoint).to_owned();
    let req = match typ {
        "discord" => {
            if endpoint.is_empty() {
                return Err("webhookUrl not configured".into());
            }
            Request {
                url: endpoint,
                headers: vec![],
                body: Body::Json(json!({
                    "username": text(settings.get("username"), "Fliks"),
                    "content": msg(),
                    "allowed_mentions": {"parse": []},
                })),
            }
        }
        "slack" => {
            if endpoint.is_empty() {
                return Err("webhookUrl not configured".into());
            }
            Request {
                url: endpoint,
                headers: vec![],
                body: Body::Json(json!({"text": msg()})),
            }
        }
        "webhook" => {
            if endpoint.is_empty() {
                return Err("url not configured".into());
            }
            let mut headers = vec![];
            if let Some(t) = settings.get("token").filter(|t| truthy(Some(t))) {
                headers.push(("Authorization", format!("Bearer {}", js_string(t))));
            }
            let mut body = Map::new();
            body.insert("event".into(), event.into());
            body.extend(payload.clone());
            Request {
                url: endpoint,
                headers,
                body: Body::Json(Value::Object(body)),
            }
        }
        "gotify" => {
            let url = trimmed();
            let token = text(settings.get("token"), "");
            if url.is_empty() || token.is_empty() {
                return Err("url and token required".into());
            }
            Request {
                url: format!("{url}/message?token={}", encode_component(&token)),
                headers: vec![],
                body: Body::Json(json!({
                    "title": format!("Fliks \u{2014} {event}"),
                    "message": msg(),
                    "priority": 5,
                })),
            }
        }
        "ntfy" => {
            let url = trimmed();
            let topic = match settings.get("topic") {
                t if truthy(t) => js_string(t.unwrap_or(&Value::Null)),
                _ => "fliks".into(),
            };
            if url.is_empty() {
                return Err("url not configured".into());
            }
            let mut headers = vec![("Title", format!("Fliks - {event}"))];
            if let Some(Value::String(t)) = settings.get("token").filter(|t| truthy(Some(t))) {
                headers.push(("Authorization", format!("Bearer {t}")));
            }
            Request {
                url: format!("{url}/{topic}"),
                headers,
                body: Body::Text(msg()),
            }
        }
        _ => return Ok(None),
    };
    Ok(Some(req))
}

/// `mergeSecretFields`: a blank or absent secret keeps the stored one, `null` erases it, the
/// read-only `secretsSet` marker is dropped.
fn merge_secrets(
    existing: Option<&Map<String, Value>>,
    out: &mut Map<String, Value>,
    keys: &[&str],
) {
    out.remove("secretsSet");
    for key in keys {
        if out.get(*key) == Some(&Value::Null) {
            out.remove(*key);
        } else if !truthy(out.get(*key)) {
            match existing.and_then(|e| e.get(*key)) {
                Some(v) => out.insert((*key).into(), v.clone()),
                None => out.remove(*key),
            };
        }
    }
}

/// `normalizeSettings`: trim, fold the legacy `webhookUrl`, merge secrets with `existing` (the stored
/// settings when the type did not change).
pub fn normalize_settings(
    typ: &str,
    settings: &Map<String, Value>,
    existing: Option<&Map<String, Value>>,
) -> Result<Map<String, Value>, String> {
    let mut out: Map<String, Value> = settings
        .iter()
        .map(|(k, v)| match v {
            Value::String(s) => (k.clone(), trim(s).into()),
            v => (k.clone(), v.clone()),
        })
        .collect();
    if endpoint_key(typ) == Some("webhookUrl") {
        merge_secrets(existing, &mut out, secret_keys(typ));
        return Ok(out);
    }
    if let Some(legacy) = out.remove("webhookUrl")
        && !truthy(out.get("url"))
    {
        out.insert("url".into(), legacy);
    }
    merge_secrets(existing, &mut out, secret_keys(typ));
    if typ == "gotify" && !truthy(out.get("token")) {
        return Err("gotify requires a non-empty settings.token".into());
    }
    Ok(out)
}

/// Response settings: secrets removed, `secretsSet` lists the ones holding a value.
pub fn redact(typ: &str, settings: &Map<String, Value>) -> Map<String, Value> {
    let mut out = settings.clone();
    let mut set = vec![];
    for key in secret_keys(typ) {
        if truthy(out.get(*key)) {
            set.push(Value::from(*key));
        }
        out.remove(*key);
    }
    out.insert("secretsSet".into(), set.into());
    out
}

fn is_http_url(s: &str) -> bool {
    s.get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("http://"))
        || s.get(..8)
            .is_some_and(|p| p.eq_ignore_ascii_case("https://"))
}

/// The endpoint the DTO constraint checks; for `webhookUrl` types a blank or absent write counts as
/// the stored value and `null` as none.
fn effective_endpoint(typ: &str, settings: &Value, stored: Option<&Map<String, Value>>) -> String {
    let get = |k: &str| settings.get(k);
    let as_text = |v: Option<&Value>| match v {
        Some(Value::String(s)) => trim(s).to_owned(),
        _ => String::new(),
    };
    if endpoint_key(typ) == Some("url") {
        return as_text(if truthy(get("url")) {
            get("url")
        } else {
            get("webhookUrl")
        });
    }
    let kept = || as_text(stored.and_then(|s| s.get("webhookUrl")));
    match get("webhookUrl") {
        Some(Value::Null) => String::new(),
        Some(Value::String(s)) if !trim(s).is_empty() => trim(s).to_owned(),
        Some(v) if truthy(Some(v)) => String::new(),
        _ => kept(),
    }
}

/// `CreateNotificationConnectionDto` validation (same message order as 4.x); `stored`
/// is the saved settings of the connection being updated when its type is unchanged.
pub fn validate(body: &Value, stored: Option<&Map<String, Value>>) -> Vec<String> {
    let empty = Map::new();
    let obj = body.as_object().unwrap_or(&empty);
    let mut msgs: Vec<String> = obj
        .keys()
        .filter(|k| !["name", "type", "settings", "events", "enabled"].contains(&k.as_str()))
        .map(|k| format!("property {k} should not exist"))
        .collect();
    if !obj.get("name").is_some_and(Value::is_string) {
        msgs.push("name must be a string".into());
    }
    let typ = obj
        .get("type")
        .and_then(Value::as_str)
        .filter(|t| TYPES.contains(t));
    if typ.is_none() {
        msgs.push(format!(
            "type must be one of the following values: {}",
            TYPES.join(", ")
        ));
    }
    let settings = obj.get("settings").unwrap_or(&Value::Null);
    if let Some(typ) = typ {
        let key = endpoint_key(typ).unwrap_or("url");
        if !is_http_url(&effective_endpoint(typ, settings, stored)) {
            msgs.push(format!(
                "{typ} requires settings.{key} to be an http(s) URL"
            ));
        }
    }
    if !settings.is_object() {
        msgs.push("settings must be an object".into());
    }
    match obj.get("events") {
        None | Some(Value::Null) => {}
        Some(Value::Array(a)) => {
            if !a.iter().all(|e| e.as_str().is_some_and(is_event)) {
                msgs.push(events_msg());
            }
        }
        Some(v) => {
            if !v.as_str().is_some_and(is_event) {
                msgs.push(events_msg());
            }
            msgs.push("events must be an array".into());
        }
    }
    if !matches!(
        obj.get("enabled"),
        None | Some(Value::Null | Value::Bool(_))
    ) {
        msgs.push("enabled must be a boolean value".into());
    }
    msgs
}

fn events_msg() -> String {
    format!(
        "each value in events must be one of the following values: {}",
        EVENTS.join(", ")
    )
}

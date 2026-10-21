//! Xtream panel links and API answers (`livetv-sources.md` rules 17-21).
use crate::js::{self, encode_uri_component, js_string, rx};
use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use url::Url;

use super::names::normalize_group_name;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

/// `<protocol>//<host>`, the host keeping its port; any path prefix is dropped.
fn origin(u: &Url) -> String {
    let host = u.host_str().unwrap_or_default();
    match u.port() {
        Some(p) => format!("{}://{host}:{p}", u.scheme()),
        None => format!("{}://{host}", u.scheme()),
    }
}

/// A pasted `get.php`, `player_api.php` or `xmltv.php` link carries the panel's credentials.
pub fn detect_from_url(raw: &str) -> Option<Credentials> {
    let u = Url::parse(raw).ok()?;
    let path = u.path().to_lowercase();
    if !["/get.php", "/player_api.php", "/xmltv.php"]
        .iter()
        .any(|s| path.ends_with(s))
    {
        return None;
    }
    let pair = |k: &str| {
        u.query_pairs()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.into_owned())
    };
    let (username, password) = (pair("username")?, pair("password")?);
    (!username.is_empty() && !password.is_empty()).then(|| Credentials {
        base_url: origin(&u),
        username,
        password,
    })
}

/// The panel recognised from one stream url, `/live/<user>/<pass>/<id>.ts` (credentials stay percent-encoded).
pub fn detect_from_stream_url(raw: &str) -> Option<Credentials> {
    let u = Url::parse(raw).ok()?;
    let parts: Vec<&str> = u.path().split('/').filter(|p| !p.is_empty()).collect();
    let skip = parts
        .first()
        .is_some_and(|p| ["live", "movie", "series"].contains(&p.to_lowercase().as_str()));
    let [username, password, last, ..] = parts[usize::from(skip)..] else {
        return None;
    };
    rx!(r"^[^/]+\.[A-Za-z0-9]+$")
        .is_match(last)
        .then(|| Credentials {
            base_url: origin(&u),
            username: username.to_owned(),
            password: password.to_owned(),
        })
}

/// The self-refreshing playlist link equivalent to a downloaded copy.
pub fn playlist_url(c: &Credentials) -> String {
    format!(
        "{}/get.php?username={}&password={}&type=m3u_plus&output=ts",
        c.base_url,
        encode_uri_component(&c.username),
        encode_uri_component(&c.password)
    )
}

pub fn stream_url(c: &Credentials, stream_id: &str, format: &str) -> String {
    format!(
        "{}/live/{}/{}/{stream_id}.{format}",
        c.base_url,
        encode_uri_component(&c.username),
        encode_uri_component(&c.password)
    )
}

/// The guide link without its credentials; the password is added on the wire only.
pub fn guide_url_bare(c: &Credentials) -> String {
    format!("{}/xmltv.php", c.base_url)
}

pub fn guide_url(c: &Credentials) -> String {
    format!(
        "{}?username={}&password={}",
        guide_url_bare(c),
        encode_uri_component(&c.username),
        encode_uri_component(&c.password)
    )
}

/// `ts` plays widest; otherwise the panel's first offer.
pub fn pick_output_format(allowed: &[String]) -> String {
    if allowed.is_empty() || allowed.iter().any(|f| f == "ts") {
        "ts".into()
    } else {
        allowed[0].clone()
    }
}

/// `String(v)`: a missing key reads as `undefined`.
fn js_str(v: Option<&Value>) -> String {
    v.map_or_else(|| "undefined".into(), js_string)
}

/// `String(value ?? '')`.
fn text(v: Option<&Value>) -> String {
    v.filter(|v| !v.is_null())
        .map(js_string)
        .unwrap_or_default()
}

fn to_int(v: Option<&Value>) -> i64 {
    js::parse_int(&text(v)).unwrap_or(0)
}

fn to_string_or_null(v: Option<&Value>) -> Option<String> {
    let t = text(v);
    let t = js::trim(&t);
    (!t.is_empty()).then(|| t.to_owned())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub status: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub max_connections: i64,
    pub active_connections: i64,
    pub allowed_output_formats: Vec<String>,
}

/// `player_api.php` without an action: `user_info`, refused when absent or `auth` is `0`.
pub fn account(data: &Value) -> Result<Account, String> {
    let falsy = |v: &Value| match v {
        Value::Null | Value::Bool(false) => true,
        Value::String(s) => s.is_empty(),
        Value::Number(n) => n.as_f64() == Some(0.0),
        _ => false,
    };
    let Some(info) = data.get("user_info").filter(|i| !falsy(i)) else {
        return Err("authentication refused by the provider".into());
    };
    if info
        .get("auth")
        .filter(|a| !a.is_null())
        .map_or("1".into(), js_string)
        == "0"
    {
        return Err("authentication refused by the provider".into());
    }
    let exp = to_int(info.get("exp_date"));
    Ok(Account {
        status: to_string_or_null(info.get("status")),
        expires_at: (exp != 0)
            .then(|| Utc.timestamp_millis_opt(exp.saturating_mul(1000)).single())
            .flatten(),
        max_connections: to_int(info.get("max_connections")),
        active_connections: to_int(info.get("active_cons")),
        allowed_output_formats: info
            .get("allowed_output_formats")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|f| js_string(f).to_lowercase()).collect())
            .unwrap_or_default(),
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveStream {
    pub stream_id: String,
    pub name: String,
    pub number: Option<i32>,
    pub logo: Option<String>,
    pub guide_channel_id: Option<String>,
    pub category_name: String,
    pub direct_source: Option<String>,
}

fn list<'a>(v: &'a Value, what: &str) -> Result<&'a [Value], String> {
    match v {
        Value::Null => Ok(&[]),
        Value::Array(a) => Ok(a),
        _ => Err(format!("the provider's {what} answer is not a list")),
    }
}

/// `get_live_categories` and `get_live_streams` as the entries an import reads; a nameless stream is skipped.
pub fn live_streams(categories: &Value, streams: &Value) -> Result<Vec<LiveStream>, String> {
    let names: HashMap<String, String> = list(categories, "categories")?
        .iter()
        .map(|c| {
            (
                js_str(c.get("category_id")),
                js::trim(&text(c.get("category_name"))).to_owned(),
            )
        })
        .collect();
    Ok(list(streams, "streams")?
        .iter()
        .filter(|s| s.get("stream_id").is_some_and(|v| !v.is_null()))
        .filter_map(|s| {
            let name = js::trim(&text(s.get("name"))).to_owned();
            if name.is_empty() {
                return None;
            }
            let cat = names.get(&js_str(s.get("category_id")));
            Some(LiveStream {
                stream_id: js_string(&s["stream_id"]),
                name,
                number: Some(to_int(s.get("num")))
                    .filter(|n| *n != 0)
                    .and_then(|n| i32::try_from(n).ok()),
                logo: to_string_or_null(s.get("stream_icon")),
                guide_channel_id: to_string_or_null(s.get("epg_channel_id")),
                category_name: normalize_group_name(cat.map(String::as_str)),
                direct_source: to_string_or_null(s.get("direct_source")),
            })
        })
        .collect())
}

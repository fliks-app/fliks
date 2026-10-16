//! Request DTOs of the importer routes (`importers.md` rules 2-3), with class-validator's messages.
use crate::http::{AppError, validate::from_value};
use fliks_domain::arr_import::PathMapping;
use serde::Deserialize;
use serde_json::Value;

type Res<T> = Result<T, AppError>;

/// Raw JSON per field (`null` kept as `Some(Null)`) so each validator can word its own message.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawConnection {
    #[serde(default, deserialize_with = "present")]
    url: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    api_key: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawImport {
    #[serde(default, deserialize_with = "present")]
    url: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    api_key: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    mode: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    import_subtitles: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    target_library_id: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    path_mappings: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawMapping {
    #[serde(default, deserialize_with = "present")]
    remote_path: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    local_library_id: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    ignore: Option<Value>,
}

/// `url` and the optional key of `/test` and `/preview`.
pub struct Connection {
    pub url: String,
    pub api_key: Option<String>,
}

pub struct ImportBody {
    pub url: String,
    pub api_key: Option<String>,
    pub update: bool,
    pub subtitles: bool,
    pub target_library_id: i32,
    pub mappings: Vec<PathMapping>,
}

fn optional_string(v: Option<Value>, field: &str, msgs: &mut Vec<String>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s),
        None | Some(Value::Null) => None,
        _ => {
            msgs.push(format!("{field} must be a string"));
            None
        }
    }
}

/// `TestConnectionDto`: `url` any non-empty string (`test`), or a URL (`preview`).
pub fn connection(body: Value, test: bool) -> Res<Connection> {
    let raw: RawConnection = from_value(body)?;
    let mut msgs = vec![];
    let url = match raw.url {
        Some(Value::String(s)) if test && s.is_empty() => {
            msgs.push("url should not be empty".into());
            None
        }
        Some(Value::String(s)) if test || is_url(&s) => Some(s),
        other if test => {
            if matches!(other, None | Some(Value::Null)) {
                msgs.push("url should not be empty".into());
            }
            msgs.push("url must be a string".into());
            None
        }
        _ => {
            msgs.push("url must be a URL address".into());
            None
        }
    };
    let api_key = optional_string(raw.api_key, "apiKey", &mut msgs);
    match url {
        Some(url) if msgs.is_empty() => Ok(Connection { url, api_key }),
        _ => Err(AppError::bad_request(msgs)),
    }
}

/// JS `Number(v)` for the values `@Type(() => Number)` sees; `None` is NaN.
fn js_number(v: &Option<Value>) -> Option<f64> {
    match v {
        None => None,
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(b)) => Some(f64::from(u8::from(*b))),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => fliks_domain::media::query::js_number(s),
        Some(_) => None,
    }
}

fn int_at_least_one(n: Option<f64>, field: &str, msgs: &mut Vec<String>) -> Option<i32> {
    match n {
        Some(n) if n.fract() == 0.0 && n >= 1.0 => {
            // Beyond i32 no library exists; any id that large reads as unknown.
            Some(i32::try_from(n as i64).unwrap_or(i32::MAX))
        }
        Some(n) if n.fract() == 0.0 => {
            msgs.push(format!("{field} must not be less than 1"));
            None
        }
        _ => {
            msgs.push(format!("{field} must not be less than 1"));
            msgs.push(format!("{field} must be an integer number"));
            None
        }
    }
}

fn mapping(i: usize, v: &Value, msgs: &mut Vec<String>) -> Option<PathMapping> {
    let at = |f: &str| format!("pathMappings.{i}.{f}");
    let raw: RawMapping = match from_value(v.clone()) {
        Ok(r) => r,
        Err(_) => {
            msgs.push(format!("pathMappings.{i} must be an object"));
            return None;
        }
    };
    let remote_path = match raw.remote_path {
        Some(Value::String(s)) => Some(s),
        _ => {
            msgs.push(format!("{} must be a string", at("remotePath")));
            None
        }
    };
    let local_library_id = match raw.local_library_id {
        None | Some(Value::Null) => Some(None),
        Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f.fract() == 0.0 && f >= 1.0) => Some(
            Some(i32::try_from(n.as_i64().unwrap_or(i64::MAX)).unwrap_or(i32::MAX)),
        ),
        Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f.fract() == 0.0) => {
            msgs.push(format!("{} must not be less than 1", at("localLibraryId")));
            None
        }
        Some(_) => {
            msgs.push(format!("{} must not be less than 1", at("localLibraryId")));
            msgs.push(format!(
                "{} must be an integer number",
                at("localLibraryId")
            ));
            None
        }
    };
    let ignore = match raw.ignore {
        Some(Value::Bool(b)) => b,
        None | Some(Value::Null) => false,
        _ => {
            msgs.push(format!("{} must be a boolean value", at("ignore")));
            false
        }
    };
    Some(PathMapping {
        remote_path: remote_path?,
        local_library_id: local_library_id?,
        ignore,
    })
}

/// `ImportApiDto`.
pub fn import_body(body: Value) -> Res<ImportBody> {
    let raw: RawImport = from_value(body)?;
    let mut msgs = vec![];
    let url = match raw.url {
        Some(Value::String(s)) if is_url(&s) => Some(s),
        _ => {
            msgs.push("url must be a URL address".to_owned());
            None
        }
    };
    let api_key = optional_string(raw.api_key, "apiKey", &mut msgs);
    let update = match raw.mode {
        Some(Value::String(s)) if s == "skip" || s == "update" => s == "update",
        None | Some(Value::Null) => false,
        _ => {
            msgs.push("mode must be one of the following values: skip, update".into());
            false
        }
    };
    let subtitles = match raw.import_subtitles {
        Some(Value::Bool(b)) => b,
        None | Some(Value::Null) => false,
        _ => {
            msgs.push("importSubtitles must be a boolean value".into());
            false
        }
    };
    let target = int_at_least_one(
        js_number(&raw.target_library_id),
        "targetLibraryId",
        &mut msgs,
    );
    let mut mappings = vec![];
    match raw.path_mappings {
        Some(Value::Array(items)) => {
            for (i, v) in items.iter().enumerate() {
                mappings.extend(mapping(i, v, &mut msgs));
            }
        }
        other => {
            msgs.push("pathMappings must be an array".into());
            if other.is_some_and(|v| !v.is_null()) {
                msgs.push(
                    "each value in nested property pathMappings must be either object or array"
                        .into(),
                );
            }
        }
    }
    match (url, target) {
        (Some(url), Some(target_library_id)) if msgs.is_empty() => Ok(ImportBody {
            url,
            api_key,
            update,
            subtitles,
            target_library_id,
            mappings,
        }),
        _ => Err(AppError::bad_request(msgs)),
    }
}

/// `body` of an optional key, blank when absent (`provided?.trim()` of the controller).
pub fn usable_key(key: &Option<String>) -> Option<&str> {
    key.as_deref().filter(|k| {
        !k.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
            .is_empty()
    })
}

/// validator.js `isURL({require_tld: false, require_protocol: true})` with its other defaults.
pub fn is_url(s: &str) -> bool {
    if s.is_empty()
        || s.len() > 2083
        || s.contains(|c: char| c.is_whitespace() || c == '<' || c == '>')
    {
        return false;
    }
    let s = s.split('#').next().unwrap_or_default();
    let s = s.split('?').next().unwrap_or_default();
    let Some((proto, rest)) = s.split_once("://") else {
        return false;
    };
    if !["http", "https", "ftp"].contains(&proto.to_lowercase().as_str()) {
        return false;
    }
    let authority = rest.split('/').next().unwrap_or_default();
    let host_port = match authority.rsplit_once('@') {
        Some((auth, host)) => {
            if auth.matches(':').count() > 1 {
                return false;
            }
            host
        }
        None => authority,
    };
    let (host, port) = if let Some(inner) = host_port.strip_prefix('[') {
        match inner.split_once(']') {
            Some((v6, tail))
                if !v6.is_empty()
                    && v6
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.') =>
            {
                (v6, tail.strip_prefix(':'))
            }
            _ => return false,
        }
    } else {
        match host_port.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (host_port, None),
        }
    };
    if let Some(p) = port
        && (p.is_empty()
            || !p.bytes().all(|b| b.is_ascii_digit())
            || !matches!(p.parse::<u32>(), Ok(1..=65535)))
    {
        return false;
    }
    host_port.starts_with('[') || fqdn(host)
}

fn fqdn(host: &str) -> bool {
    !host.is_empty()
        && host.split('.').all(|part| {
            !part.is_empty()
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '-' || c > '\u{a0}')
                && !part.contains(|c: char| ('\u{ff01}'..='\u{ff5e}').contains(&c))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn url_rules_follow_validator() {
        for ok in [
            "http://localhost:7878",
            "https://radarr.example.com/path?x=1",
            "HTTP://127.0.0.1:7878/",
            "ftp://nas",
            "http://u:p@host:80",
            "http://[::1]:7878",
            "http://radarr",
        ] {
            assert!(is_url(ok), "{ok}");
        }
        for bad in [
            "radarr:7878",
            "localhost:7878",
            "",
            "http://",
            "http://a_b",
            "http://host:0",
            "http://host:99999",
            "http://ho st",
            "gopher://host",
            "http://a..b",
            "http://-a",
        ] {
            assert!(!is_url(bad), "{bad}");
        }
    }

    #[test]
    fn import_body_validates_like_class_validator() {
        let ok =
            import_body(json!({"url": "http://r", "targetLibraryId": "3", "pathMappings": []}))
                .unwrap();
        assert_eq!(
            (ok.target_library_id, ok.update, ok.subtitles),
            (3, false, false)
        );
        let err = |b: Value| match import_body(b) {
            Err(e) => format!("{e:?}"),
            Ok(_) => "ok".into(),
        };
        assert!(
            err(json!({"url": "x", "targetLibraryId": 1, "pathMappings": []}))
                .contains("url must be a URL address")
        );
        assert!(
            err(json!({"url": "http://r", "pathMappings": []}))
                .contains("targetLibraryId must be an integer")
        );
        assert!(
            err(json!({"url": "http://r", "targetLibraryId": 0, "pathMappings": []}))
                .contains("not be less than 1")
        );
        assert!(
            err(json!({"url": "http://r", "targetLibraryId": 1}))
                .contains("pathMappings must be an array")
        );
        assert!(
            err(json!({"url": "http://r", "targetLibraryId": 1, "pathMappings": [{}]}))
                .contains("pathMappings.0.remotePath")
        );
        assert!(
            err(json!({"url": "http://r", "targetLibraryId": 1, "mode": "x", "pathMappings": []}))
                .contains("mode must be one of")
        );
        let m = import_body(json!({"url": "http://r", "targetLibraryId": 1,
            "pathMappings": [{"remotePath": "", "localLibraryId": null, "ignore": true}]}))
        .unwrap();
        assert_eq!(m.mappings.len(), 1);
    }

    #[test]
    fn test_body_accepts_any_non_empty_url() {
        assert!(connection(json!({"url": "localhost:7878"}), true).is_ok());
        assert!(connection(json!({"url": ""}), true).is_err());
        assert!(connection(json!({"url": "localhost:7878"}), false).is_err());
        assert!(connection(json!({"url": "http://x", "apiKey": 3}), true).is_err());
    }
}

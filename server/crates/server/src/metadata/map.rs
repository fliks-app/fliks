//! JSON helpers for the provider mappings: JS `??`, `||` and "undefined is absent" on `serde_json::Value`.
use fliks_domain::media::query::js_parse_int;
use serde_json::{Map, Value, json};

pub fn get<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&Value::Null)
}

/// `v.k ?? null`.
pub fn nn(v: &Value, k: &str) -> Value {
    get(v, k).clone()
}

/// `v.k ?? default`.
pub fn or(v: &Value, k: &str, default: Value) -> Value {
    match get(v, k) {
        Value::Null => default,
        x => x.clone(),
    }
}

/// `v.k` kept only when the key exists (a JS `undefined` leaves the key out of the JSON).
pub fn put(out: &mut Map<String, Value>, key: &str, v: &Value, k: &str) {
    if let Some(x) = v.get(k) {
        out.insert(key.into(), x.clone());
    }
}

/// A non-empty string (JS truthy string).
pub fn text<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    get(v, k).as_str().filter(|s| !s.is_empty())
}

/// `v.k || null` for strings.
pub fn text_or_null(v: &Value, k: &str) -> Value {
    text(v, k).map_or(Value::Null, Value::from)
}

/// `v.k || null` for numbers: 0 is falsy.
pub fn num_or_null(v: &Value, k: &str) -> Value {
    match get(v, k) {
        Value::Number(n) if n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()) => {
            Value::Number(n.clone())
        }
        _ => Value::Null,
    }
}

pub fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `date ? parseInt(date) : null`; NaN is `null` in JSON.
pub fn year_of(v: &Value, k: &str) -> Value {
    text(v, k)
        .and_then(js_parse_int)
        .map_or(Value::Null, Value::from)
}

/// `<base>/<size><path>` for a truthy path, else `null`.
pub fn image(base: &str, size: &str, v: &Value, k: &str) -> Value {
    text(v, k).map_or(Value::Null, |p| json!(format!("{base}/{size}{p}")))
}

/// `list.map(item => item[key])`: a missing member is `null`.
pub fn pluck(list: &[Value], key: &str) -> Vec<Value> {
    list.iter().map(|i| nn(i, key)).collect()
}

/// JS number ordering key; a missing or null score is 0.
pub fn score(v: &Value, k: &str) -> f64 {
    get(v, k).as_f64().unwrap_or(0.0)
}

pub fn str_lower_or(v: &Value, k: &str, default: &str) -> String {
    get(v, k)
        .as_str()
        .map_or_else(|| default.to_owned(), str::to_lowercase)
}

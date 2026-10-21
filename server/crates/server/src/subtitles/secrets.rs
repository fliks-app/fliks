//! Secret settings of providers: redacted on read, kept on write.
use serde_json::{Map, Value};

pub const SECRETS_SET: &str = "secretsSet";

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(_) => true,
    }
}

fn object(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}

/// The settings without the secrets, plus `secretsSet` naming those that hold a value.
pub fn redact(settings: &Value, keys: &[&str]) -> Value {
    let mut out = object(settings);
    let set: Vec<Value> = keys
        .iter()
        .filter(|k| truthy(out.get(**k)))
        .map(|k| Value::String((*k).to_owned()))
        .collect();
    for k in keys {
        out.remove(*k);
    }
    out.insert(SECRETS_SET.into(), Value::Array(set));
    Value::Object(out)
}

/// A blank or absent secret keeps the stored one; an explicit `null` erases it.
pub fn merge(existing: Option<&Value>, incoming: &Value, keys: &[&str]) -> Value {
    let mut out = object(incoming);
    out.remove(SECRETS_SET);
    let old = existing.map(object).unwrap_or_default();
    for k in keys {
        if out.get(*k).is_some_and(Value::is_null) {
            out.remove(*k);
        } else if !truthy(out.get(*k)) {
            match old.get(*k) {
                Some(v) => out.insert((*k).to_owned(), v.clone()),
                None => out.remove(*k),
            };
        }
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_and_lists_the_secrets_that_are_set() {
        let r = redact(
            &json!({"username": "u", "password": "p", "apiKey": ""}),
            &["password", "apiKey"],
        );
        assert_eq!(r, json!({"username": "u", "secretsSet": ["password"]}));
    }

    #[test]
    fn merge_keeps_blank_and_erases_null() {
        let old = json!({"password": "old", "apiKey": "k"});
        let m = merge(
            Some(&old),
            &json!({"password": "", "apiKey": null, "username": "u", "secretsSet": ["x"]}),
            &["password", "apiKey"],
        );
        assert_eq!(m, json!({"password": "old", "username": "u"}));
        let m = merge(None, &json!({"password": "new"}), &["password", "apiKey"]);
        assert_eq!(m, json!({"password": "new"}));
    }
}

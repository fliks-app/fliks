//! The `subsonic-response` envelope in JSON, JSONP and XML (`docs/spec/opensubsonic.md` rules 2-6).
use axum::{
    http::{HeaderValue, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};

pub const API_VERSION: &str = "1.16.1";

pub type Obj = Map<String, Value>;

/// The answer of an endpoint: the keys the envelope adds, or a failure.
pub type Answer = Result<Obj, SubError>;

#[derive(Debug)]
pub struct SubError {
    pub code: u32,
    pub message: String,
}

impl SubError {
    pub fn new(code: u32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn missing(name: &str) -> Self {
        Self::new(10, format!("Required parameter is missing: {name}"))
    }

    pub fn not_found() -> Self {
        Self::new(70, "Data not found")
    }
}

impl From<sqlx::Error> for SubError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "subsonic query");
        Self::new(0, "Internal error")
    }
}

impl From<crate::http::AppError> for SubError {
    fn from(e: crate::http::AppError) -> Self {
        match e.status() {
            StatusCode::FORBIDDEN => {
                Self::new(50, "User is not authorized for the given operation")
            }
            StatusCode::NOT_FOUND => Self::not_found(),
            _ => {
                tracing::error!(error = ?e, "subsonic app error");
                Self::new(0, "Internal error")
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Format {
    Xml,
    Json,
    Jsonp(String),
}

impl Format {
    pub fn of(f: Option<&str>, callback: Option<&str>) -> Self {
        match f {
            Some("json") => Self::Json,
            Some("jsonp") => match callback {
                Some(c)
                    if !c.is_empty()
                        && c.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.') =>
                {
                    Self::Jsonp(c.to_owned())
                }
                _ => Self::Json,
            },
            _ => Self::Xml,
        }
    }
}

/// The `subsonic-response` object: status, versions and the answer's keys.
fn envelope(answer: Answer) -> Obj {
    let mut o = Obj::new();
    let ok = answer.is_ok();
    o.insert("status".into(), if ok { "ok" } else { "failed" }.into());
    o.insert("version".into(), API_VERSION.into());
    o.insert("type".into(), "fliks".into());
    o.insert("serverVersion".into(), env!("CARGO_PKG_VERSION").into());
    o.insert("openSubsonic".into(), true.into());
    match answer {
        Ok(body) => o.extend(body),
        Err(e) => {
            o.insert(
                "error".into(),
                json!({"code": e.code, "message": e.message}),
            );
        }
    }
    o
}

pub fn respond(format: &Format, answer: Answer) -> Response {
    let body = envelope(answer);
    match format {
        Format::Json => text(
            "application/json; charset=utf-8",
            json!({"subsonic-response": body}).to_string(),
        ),
        Format::Jsonp(cb) => text(
            "text/javascript; charset=utf-8",
            format!("{cb}({})", json!({"subsonic-response": body})),
        ),
        Format::Xml => {
            let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
            let mut root = body;
            root.insert("xmlns".into(), "http://subsonic.org/restapi".into());
            element(&mut out, "subsonic-response", &root);
            text("application/xml; charset=utf-8", out)
        }
    }
}

fn text(content_type: &'static str, body: String) -> Response {
    (
        StatusCode::OK,
        [(CONTENT_TYPE, HeaderValue::from_static(content_type))],
        body,
    )
        .into_response()
}

fn escape(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // XML 1.0 forbids the other control characters
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
}

fn scalar(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Scalars are attributes (`value` is the text), objects and arrays child elements (rule 5).
fn element(out: &mut String, name: &str, o: &Obj) {
    out.push('<');
    out.push_str(name);
    for (k, v) in o {
        if k == "value" {
            continue;
        }
        if let Some(s) = scalar(v) {
            out.push(' ');
            out.push_str(k);
            out.push_str("=\"");
            escape(&s, out);
            out.push('"');
        }
    }
    let text = o.get("value").and_then(scalar);
    let has_children = o
        .values()
        .any(|v| v.is_object() || v.as_array().is_some_and(|a| !a.is_empty()));
    if text.is_none() && !has_children {
        out.push_str("/>");
        return;
    }
    out.push('>');
    if let Some(t) = &text {
        escape(t, out);
    }
    for (k, v) in o {
        match v {
            Value::Object(c) => element(out, k, c),
            Value::Array(items) => {
                for item in items {
                    match item {
                        Value::Object(c) => element(out, k, c),
                        other => {
                            if let Some(s) = scalar(other) {
                                out.push('<');
                                out.push_str(k);
                                out.push('>');
                                escape(&s, out);
                                out.push_str("</");
                                out.push_str(k);
                                out.push('>');
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out.push_str("</");
    out.push_str(name);
    out.push('>');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn xml(v: Value) -> String {
        let mut s = String::new();
        element(&mut s, "x", v.as_object().unwrap());
        s
    }

    #[test]
    fn scalars_are_attributes_objects_and_arrays_are_elements() {
        assert_eq!(
            xml(
                json!({"a": 1, "b": "q\"<", "c": true, "d": {"n": 2}, "e": [{"n": 3}, {"n": 4}], "f": ["x", "y"], "g": [], "h": null})
            ),
            r#"<x a="1" b="q&quot;&lt;" c="true"><d n="2"/><e n="3"/><e n="4"/><f>x</f><f>y</f></x>"#
        );
    }

    #[test]
    fn a_value_key_is_the_text_of_the_element() {
        assert_eq!(
            xml(json!({"songCount": 3, "value": "Rock & Roll"})),
            r#"<x songCount="3">Rock &amp; Roll</x>"#
        );
    }

    #[test]
    fn the_envelope_carries_the_error_of_a_failure() {
        let ok = envelope(Ok(Obj::new()));
        assert_eq!(ok["status"], "ok");
        assert_eq!(ok["openSubsonic"], true);
        let failed = envelope(Err(SubError::new(40, "no")));
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["error"]["code"], 40);
    }

    #[test]
    fn a_callback_that_is_not_an_identifier_falls_back_to_json() {
        assert_eq!(
            Format::of(Some("jsonp"), Some("a.b_1")),
            Format::Jsonp("a.b_1".into())
        );
        assert_eq!(Format::of(Some("jsonp"), Some("a(1)")), Format::Json);
        assert_eq!(Format::of(None, None), Format::Xml);
    }
}

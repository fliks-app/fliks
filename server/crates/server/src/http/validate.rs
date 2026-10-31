//! Request validation with the 4.x error bodies.
use super::AppError;
use axum::{
    body::Bytes,
    extract::{FromRequest, FromRequestParts, RawPathParams, Request},
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE, request::Parts},
};
use fliks_domain::media::{kind::MediaKind, query::js_number};
use serde::Deserialize;
use serde::de::{
    DeserializeOwned, Deserializer, Error as DeError, IntoDeserializer, Visitor,
    value::{Error as ValueError, MapDeserializer, SeqDeserializer},
};
use serde_json::{Map, Value};

/// JSON body into `T` with the global pipe's semantics: unknown keys 400 (`#[serde(deny_unknown_fields)]`
/// on the DTO; leave it off for an `@AllowExtraProperties` one), JSON types strict, nothing coerced.
/// Only `application/json` bodies are read: any other content type or an empty body is `{}`.
pub struct ValidJson<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ValidJson<T> {
    type Rejection = AppError;

    async fn from_request(req: Request, state: &S) -> Result<Self, AppError> {
        let json = is_json(req.headers());
        let bytes = Bytes::from_request(req, state)
            .await
            .map_err(|e| AppError::plain(e.status(), "request entity too large"))?;
        let value = if json && !bytes.is_empty() {
            serde_json::from_slice(&bytes)
                .map_err(|e| AppError::plain(StatusCode::BAD_REQUEST, e.to_string()))?
        } else {
            Value::Object(Default::default())
        };
        from_value(value).map(Self)
    }
}

fn is_json(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| {
            ct.split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("application/json")
        })
}

/// Deserialize an already parsed body, failing with the 400 validation body.
pub fn from_value<T: DeserializeOwned>(value: Value) -> Result<T, AppError> {
    serde_path_to_error::deserialize(value).map_err(|e| {
        let field = e.path().to_string();
        AppError::bad_request(vec![message(&field, &e.inner().to_string())])
    })
}

/// class-validator style text for a serde error on `field` (`.` is the root).
fn message(field: &str, err: &str) -> String {
    let quoted = |s: &str| s.split('`').nth(1).map(str::to_owned);
    // serde_path_to_error may already end the path with the offending key.
    let join = |key: String| match field {
        "." => key,
        f if f == key || f.ends_with(&format!(".{key}")) => f.to_owned(),
        f => format!("{f}.{key}"),
    };
    if let Some(rest) = err.strip_prefix("unknown field ") {
        return format!(
            "property {} should not exist",
            join(quoted(rest).unwrap_or_default())
        );
    }
    if let Some(rest) = err.strip_prefix("missing field ") {
        return format!(
            "{} should not be empty",
            join(quoted(rest).unwrap_or_default())
        );
    }
    let field = if field == "." { "body" } else { field };
    let what = match err.rsplit("expected ").next().unwrap_or_default() {
        e if e.contains("string") => "a string",
        e if e.contains("bool") => "a boolean value",
        e if e.contains("sequence") || e.contains("array") => "an array",
        e if e.starts_with("i") || e.starts_with("u") => "an integer number",
        e if e.starts_with("f") || e.contains("number") => {
            "a number conforming to the specified constraints"
        }
        _ => return format!("{field} is invalid"),
    };
    format!("{field} must be {what}")
}

/// Path parameters with the 4.x 400 body on failure; use `PathParams<i32>` or a tuple.
/// Integers must be canonical (`7`, `-7`; never `007`, `+7`, ` 7 `, `0x7`).
pub struct PathParams<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned + Send> FromRequestParts<S> for PathParams<T> {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        let raw = RawPathParams::from_request_parts(parts, state)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "path extraction");
                AppError::plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            })?;
        let pairs: Vec<(&str, &str)> = raw.iter().collect();
        T::deserialize(Params(&pairs))
            .map(Self)
            .map_err(|_| AppError::bad_request("Validation failed (numeric string is expected)"))
    }
}

/// Canonical-integer check on one raw segment, for handlers that must run their policy check first.
pub fn int_param(raw: &str) -> Result<i32, AppError> {
    i32::deserialize(Val(raw))
        .map_err(|_| AppError::bad_request("Validation failed (numeric string is expected)"))
}

/// A query integer: absent or empty is `None`, a non-canonical string is 400, a huge one saturates.
pub fn int_query(raw: Option<&String>) -> Result<Option<i64>, AppError> {
    let Some(s) = raw.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if !canonical(s) {
        return Err(AppError::bad_request(
            "Validation failed (numeric string is expected)",
        ));
    }
    Ok(Some(s.parse().unwrap_or(if s.starts_with('-') {
        i64::MIN
    } else {
        i64::MAX
    })))
}

fn canonical(s: &str) -> bool {
    let digits = s.strip_prefix('-').unwrap_or(s);
    match digits.as_bytes() {
        [b'0'] => s.len() == 1,
        [b'1'..=b'9', rest @ ..] => rest.iter().all(u8::is_ascii_digit),
        _ => false,
    }
}

/// One raw value: strings as is, integers only in canonical form.
struct Val<'de>(&'de str);

macro_rules! int {
    ($($f:ident => $v:ident: $t:ty),*) => {$(
        fn $f<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
            match self.0.parse::<$t>() {
                Ok(n) if canonical(self.0) => vis.$v(n),
                _ => Err(DeError::custom("numeric string is expected")),
            }
        }
    )*};
}

impl<'de> Deserializer<'de> for Val<'de> {
    type Error = ValueError;
    int!(deserialize_i8 => visit_i8: i8, deserialize_i16 => visit_i16: i16,
        deserialize_i32 => visit_i32: i32, deserialize_i64 => visit_i64: i64,
        deserialize_u8 => visit_u8: u8, deserialize_u16 => visit_u16: u16,
        deserialize_u32 => visit_u32: u32, deserialize_u64 => visit_u64: u64);

    fn deserialize_any<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        vis.visit_str(self.0)
    }
    fn deserialize_option<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        vis.visit_some(self)
    }
    serde::forward_to_deserialize_any! {
        bool f32 f64 char str string bytes byte_buf unit unit_struct newtype_struct seq
        tuple tuple_struct map struct enum identifier ignored_any i128 u128
    }
}

impl<'de> IntoDeserializer<'de, ValueError> for Val<'de> {
    type Deserializer = Self;
    fn into_deserializer(self) -> Self {
        self
    }
}

/// axum's `Path` shapes: one value, a tuple/sequence in route order, or a struct/map by name.
struct Params<'de, 'b>(&'b [(&'de str, &'de str)]);

impl<'de, 'b> Deserializer<'de> for Params<'de, 'b> {
    type Error = ValueError;

    fn deserialize_any<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        match self.0 {
            [(_, v)] => Val(v).deserialize_any(vis),
            _ => self.deserialize_map(vis),
        }
    }
    fn deserialize_seq<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        vis.visit_seq(SeqDeserializer::new(self.0.iter().map(|(_, v)| Val(v))))
    }
    fn deserialize_tuple<V: Visitor<'de>>(self, _: usize, vis: V) -> Result<V::Value, ValueError> {
        self.deserialize_seq(vis)
    }
    fn deserialize_tuple_struct<V: Visitor<'de>>(
        self,
        _: &'static str,
        _: usize,
        vis: V,
    ) -> Result<V::Value, ValueError> {
        self.deserialize_seq(vis)
    }
    fn deserialize_map<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        vis.visit_map(MapDeserializer::new(
            self.0.iter().map(|(k, v)| (*k, Val(v))),
        ))
    }
    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _: &'static str,
        _: &'static [&'static str],
        vis: V,
    ) -> Result<V::Value, ValueError> {
        self.deserialize_map(vis)
    }
    fn deserialize_option<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        vis.visit_some(self)
    }
    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        _: &'static str,
        vis: V,
    ) -> Result<V::Value, ValueError> {
        vis.visit_newtype_struct(self)
    }

    // Single scalar: delegate so integer parsing stays strict.
    fn deserialize_i8<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        self.one()?.deserialize_i8(vis)
    }
    fn deserialize_i16<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        self.one()?.deserialize_i16(vis)
    }
    fn deserialize_i32<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        self.one()?.deserialize_i32(vis)
    }
    fn deserialize_i64<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        self.one()?.deserialize_i64(vis)
    }
    fn deserialize_u8<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        self.one()?.deserialize_u8(vis)
    }
    fn deserialize_u16<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        self.one()?.deserialize_u16(vis)
    }
    fn deserialize_u32<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        self.one()?.deserialize_u32(vis)
    }
    fn deserialize_u64<V: Visitor<'de>>(self, vis: V) -> Result<V::Value, ValueError> {
        self.one()?.deserialize_u64(vis)
    }
    serde::forward_to_deserialize_any! {
        bool f32 f64 char str string bytes byte_buf unit unit_struct enum identifier
        ignored_any i128 u128
    }
}

impl<'de> Params<'de, '_> {
    fn one(&self) -> Result<Val<'de>, ValueError> {
        match self.0 {
            [(_, v)] => Ok(Val(v)),
            _ => Err(DeError::custom("expected one path parameter")),
        }
    }
}

pub(crate) struct Check<'a> {
    pub(crate) o: &'a Map<String, Value>,
    prefix: &'a str,
    pub(crate) errs: Vec<String>,
}

pub(crate) fn object(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(o) => o,
        _ => Map::new(),
    }
}

/// `Number(x)` of a JSON value; `None` is NaN.
pub(crate) fn coerce(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => js_number(s),
        Value::Bool(b) => Some(f64::from(u8::from(*b))),
        _ => None,
    }
}

pub(crate) fn int4(n: f64) -> Option<i32> {
    (n.fract() == 0.0 && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&n))
        .then_some(n as i32)
}

impl<'a> Check<'a> {
    pub(crate) fn new(o: &'a Map<String, Value>, known: &[&str], prefix: &'a str) -> Self {
        let errs = o
            .keys()
            .filter(|k| !known.contains(&k.as_str()))
            .map(|k| format!("{prefix}property {k} should not exist"))
            .collect();
        Self { o, prefix, errs }
    }

    pub(crate) fn err(&mut self, key: &str, what: &str) {
        self.errs.push(format!("{}{key} {what}", self.prefix));
    }

    /// `@IsOptional`: absent and `null` skip every other validator.
    pub(crate) fn get(&self, key: &str) -> Option<&'a Value> {
        self.o.get(key).filter(|v| !v.is_null())
    }

    pub(crate) fn one_of(&mut self, key: &str, allowed: &[&str], optional: bool) -> Option<String> {
        let v = if optional {
            self.get(key)?
        } else {
            self.o.get(key).unwrap_or(&Value::Null)
        };
        match v.as_str().filter(|s| allowed.contains(s)) {
            Some(s) => Some(s.to_owned()),
            None => {
                self.err(
                    key,
                    &format!(
                        "must be one of the following values: {}",
                        allowed.join(", ")
                    ),
                );
                None
            }
        }
    }

    pub(crate) fn kind(&mut self, key: &str, optional: bool) -> Option<MediaKind> {
        self.one_of(key, &MediaKind::NAMES, optional)
            .and_then(|s| MediaKind::parse(&s))
    }

    /// `@IsInt` (with `@Type(() => Number)` when `coerced`) and the bounds, messages in validator order.
    pub(crate) fn int(
        &mut self,
        key: &str,
        v: &Value,
        coerced: bool,
        min: Option<i32>,
        max: Option<i32>,
    ) -> Option<i32> {
        let n = if coerced {
            coerce(v)
        } else {
            v.as_f64().filter(|_| v.is_number())
        };
        let above = max.filter(|m| n.is_none_or(|n| n > f64::from(*m)));
        let below = min.filter(|m| n.is_none_or(|n| n < f64::from(*m)));
        if let Some(m) = above {
            self.err(key, &format!("must not be greater than {m}"));
        }
        if let Some(m) = below {
            self.err(key, &format!("must not be less than {m}"));
        }
        match n.and_then(int4) {
            Some(i) if above.is_none() && below.is_none() => Some(i),
            Some(_) => None,
            // a whole number past int4 whose bound is already reported is not reported twice
            None if n.is_some_and(|n| n.fract() == 0.0) && (above.is_some() || below.is_some()) => {
                None
            }
            None => {
                self.err(key, "must be an integer number");
                None
            }
        }
    }

    /// `@IsArray @IsInt({ each: true })` (`@Type(() => Number)` when `coerced`).
    pub(crate) fn int_array(&mut self, key: &str, coerced: bool) -> Option<Vec<i64>> {
        let v = self.get(key)?;
        let Some(a) = v.as_array() else {
            self.err(key, "must be an array");
            return None;
        };
        let nums: Vec<Option<f64>> = a
            .iter()
            .map(|x| {
                if coerced {
                    coerce(x)
                } else {
                    x.as_f64().filter(|_| x.is_number())
                }
                .filter(|n| n.fract() == 0.0 && n.abs() <= 9.0e15)
            })
            .collect();
        if nums.iter().any(Option::is_none) {
            self.errs.push(format!(
                "{}each value in {key} must be an integer number",
                self.prefix
            ));
            return None;
        }
        Some(nums.into_iter().flatten().map(|n| n as i64).collect())
    }

    pub(crate) fn finish<T>(self, v: T) -> Result<T, AppError> {
        if self.errs.is_empty() {
            Ok(v)
        } else {
            Err(AppError::bad_request(self.errs))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, body::Body, routing::post};
    use serde::Deserialize;
    use serde_json::json;
    use tower::ServiceExt;

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct Dto {
        username: String,
        age: Option<i32>,
        ok: Option<bool>,
        tags: Option<Vec<String>>,
        nested: Option<Inner>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    #[allow(dead_code)]
    struct Inner {
        x: String,
    }

    async fn call(ct: Option<&str>, body: &str) -> (u16, Value) {
        let app = Router::new().route("/", post(|ValidJson(_): ValidJson<Dto>| async { "ok" }));
        let mut req = Request::post("/");
        if let Some(ct) = ct {
            req = req.header("content-type", ct);
        }
        let res = app
            .oneshot(req.body(Body::from(body.to_owned())).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn bad(msg: &str) -> (u16, Value) {
        (
            400,
            json!({"statusCode": 400, "message": [msg], "error": "Bad Request"}),
        )
    }

    #[tokio::test]
    async fn valid_body_passes() {
        let (s, _) = call(
            Some("application/json; charset=utf-8"),
            r#"{"username":"a","age":null}"#,
        )
        .await;
        assert_eq!(s, 200);
    }

    #[tokio::test]
    async fn messages_follow_class_validator() {
        let j = Some("application/json");
        assert_eq!(
            call(j, r#"{"username":"a","evil":1}"#).await,
            bad("property evil should not exist")
        );
        assert_eq!(call(j, r#"{}"#).await, bad("username should not be empty"));
        assert_eq!(
            call(j, r#"{"username":1}"#).await,
            bad("username must be a string")
        );
        assert_eq!(
            call(j, r#"{"username":"a","age":"3"}"#).await,
            bad("age must be an integer number")
        );
        assert_eq!(
            call(j, r#"{"username":"a","age":1.5}"#).await,
            bad("age must be an integer number")
        );
        assert_eq!(
            call(j, r#"{"username":"a","ok":"true"}"#).await,
            bad("ok must be a boolean value")
        );
        assert_eq!(
            call(j, r#"{"username":"a","tags":"x"}"#).await,
            bad("tags must be an array")
        );
        assert_eq!(
            call(j, r#"{"username":"a","tags":[1]}"#).await,
            bad("tags[0] must be a string")
        );
        assert_eq!(
            call(j, r#"{"username":"a","nested":{"y":1}}"#).await,
            bad("property nested.y should not exist")
        );
        assert_eq!(
            call(j, r#"{"username":"a","nested":{}}"#).await,
            bad("nested.x should not be empty")
        );
    }

    #[tokio::test]
    async fn only_application_json_is_parsed() {
        assert_eq!(
            call(None, r#"{"username":"a"}"#).await,
            bad("username should not be empty")
        );
        assert_eq!(
            call(Some("text/plain"), r#"{"username":"a"}"#).await,
            bad("username should not be empty")
        );
        assert_eq!(
            call(Some("application/json"), "").await,
            bad("username should not be empty")
        );
        let (s, b) = call(Some("application/json"), "{nope").await;
        assert_eq!(
            (s, b["statusCode"].clone(), b.get("error").cloned()),
            (400, json!(400), None)
        );
    }

    #[tokio::test]
    async fn path_int_failure_is_parse_int_pipe_400() {
        let app = Router::new().route(
            "/{id}",
            axum::routing::get(|PathParams(id): PathParams<i32>| async move { id.to_string() }),
        );
        for (uri, want) in [
            ("/12", 200),
            ("/-3", 200),
            ("/0", 200),
            ("/abc", 400),
            ("/1.5", 400),
            ("/99999999999", 400),
            ("/007", 400),
            ("/+7", 400),
            ("/-0", 400),
            ("/%207%20", 400),
            ("/0x10", 400),
            ("/1e1", 400),
        ] {
            let res = app
                .clone()
                .oneshot(Request::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status(), want, "{uri}");
            if want == 400 {
                let b = axum::body::to_bytes(res.into_body(), usize::MAX)
                    .await
                    .unwrap();
                assert_eq!(
                    serde_json::from_slice::<Value>(&b).unwrap(),
                    json!({"statusCode": 400, "message": "Validation failed (numeric string is expected)", "error": "Bad Request"})
                );
            }
        }
    }

    #[tokio::test]
    async fn only_integer_params_are_strict() {
        let app =
            Router::new().route(
                "/{id}/{key}",
                axum::routing::get(
                    |PathParams((id, key)): PathParams<(i32, String)>| async move {
                        format!("{id}:{key}")
                    },
                ),
            );
        for (uri, want) in [("/7/007", 200), ("/007/x", 400)] {
            let res = app
                .clone()
                .oneshot(Request::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(res.status(), want, "{uri}");
        }
        assert!(int_param("42").is_ok() && int_param("042").is_err());
    }
}

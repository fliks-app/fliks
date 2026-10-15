//! Request validation with Nest's error bodies (`ValidationPipe`, `ParseIntPipe`).
use super::AppError;
use axum::{
    body::Bytes,
    extract::{FromRequest, FromRequestParts, Path, Request, rejection::PathRejection},
    http::{HeaderMap, StatusCode, header::CONTENT_TYPE, request::Parts},
};
use serde::de::DeserializeOwned;
use serde_json::Value;

/// JSON body into `T` with the global pipe's semantics: unknown keys 400 (`#[serde(deny_unknown_fields)]`
/// on the DTO; leave it off for an `@AllowExtraProperties` one), JSON types strict, nothing coerced.
/// Only `application/json` bodies are read: any other content type or an empty body is `{}` like Express.
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

/// Path parameters with `ParseIntPipe`'s 400 body on failure; use `PathParams<i32>` or a tuple.
pub struct PathParams<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned + Send> FromRequestParts<S> for PathParams<T> {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        match Path::<T>::from_request_parts(parts, state).await {
            Ok(Path(v)) => Ok(Self(v)),
            Err(PathRejection::FailedToDeserializePathParams(_)) => Err(AppError::bad_request(
                "Validation failed (numeric string is expected)",
            )),
            Err(e) => {
                tracing::error!(error = %e, "path extraction");
                Err(AppError::plain(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                ))
            }
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
    async fn only_application_json_is_parsed_like_express() {
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
            ("/abc", 400),
            ("/1.5", 400),
            ("/99999999999", 400),
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
}

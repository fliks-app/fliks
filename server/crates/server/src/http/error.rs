use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

const GENERIC: &str = "Internal server error";

/// 4.x error body: `{statusCode, message}` when built bare, plus `error` when built with a message.
#[derive(Debug)]
pub struct AppError {
    status: StatusCode,
    message: Value,
    with_message: bool,
    /// A translation key and its params, beside `message` and never under `error`.
    key: Option<(String, Value)>,
    /// The body carries the generic text; `message` stays for logs, SSE `error` fields and job `errors[]`.
    hidden: bool,
}

impl AppError {
    /// Like `new NotFoundException()`: message is the status reason.
    pub fn bare(status: StatusCode) -> Self {
        Self {
            status,
            message: status.canonical_reason().unwrap_or_default().into(),
            with_message: false,
            key: None,
            hidden: false,
        }
    }

    /// Plain error (`{statusCode, message}`), e.g. body-parser's 413.
    pub fn plain(status: StatusCode, message: impl Into<Value>) -> Self {
        Self {
            status,
            message: message.into(),
            with_message: false,
            key: None,
            hidden: false,
        }
    }

    /// Like `new NotFoundException('msg')`; `message` may be a string or an array of strings.
    pub fn with_message(status: StatusCode, message: impl Into<Value>) -> Self {
        Self {
            status,
            message: message.into(),
            with_message: true,
            key: None,
            hidden: false,
        }
    }

    /// Adds `key` and `params` to the body: the client translates them, `message` stays the fallback.
    pub fn keyed(mut self, key: &str, params: Value) -> Self {
        self.key = Some((key.to_owned(), params));
        self
    }

    pub fn bad_request(message: impl Into<Value>) -> Self {
        Self::with_message(StatusCode::BAD_REQUEST, message)
    }
    pub fn unauthorized(message: impl Into<Value>) -> Self {
        Self::with_message(StatusCode::UNAUTHORIZED, message)
    }
    pub fn forbidden(message: impl Into<Value>) -> Self {
        Self::with_message(StatusCode::FORBIDDEN, message)
    }
    pub fn not_found(message: impl Into<Value>) -> Self {
        Self::with_message(StatusCode::NOT_FOUND, message)
    }
    pub fn conflict(message: impl Into<Value>) -> Self {
        Self::with_message(StatusCode::CONFLICT, message)
    }
    pub fn payload_too_large(message: impl Into<Value>) -> Self {
        Self::with_message(StatusCode::PAYLOAD_TOO_LARGE, message)
    }
    /// An unexpected fault: logged with its cause, answered with the generic body.
    pub fn internal(message: impl Into<Value>) -> Self {
        let mut e = Self::internal_shown(message);
        e.hidden = true;
        e
    }

    /// A fault the admin acts on (a missing tool, a path): the body keeps the text.
    pub fn internal_shown(message: impl Into<Value>) -> Self {
        let e = Self::with_message(StatusCode::INTERNAL_SERVER_ERROR, message);
        tracing::error!(error = %e.text(), "internal error");
        e
    }
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// The message when it is one string (SSE `error` fields, `errors[]` entries).
    pub fn text(&self) -> String {
        match &self.message {
            Value::String(s) => s.clone(),
            v => v.to_string(),
        }
    }
}

/// The `message` text, for logs.
impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        if self.hidden {
            return Self::plain(self.status, GENERIC).into_response();
        }
        let mut body = json!({"statusCode": self.status.as_u16(), "message": self.message});
        if self.with_message {
            body["error"] = self.status.canonical_reason().unwrap_or_default().into();
        }
        if let Some((key, params)) = self.key {
            body["key"] = key.into();
            body["params"] = params;
        }
        (self.status, Json(body)).into_response()
    }
}

/// The 4.x unknown-error body; the cause is logged, never returned.
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!(error = %e, "database error");
        Self::plain(StatusCode::INTERNAL_SERVER_ERROR, GENERIC)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body(e: AppError) -> (u16, Value) {
        let r = e.into_response();
        let status = r.status().as_u16();
        let bytes = axum::body::to_bytes(r.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn a_keyed_error_carries_key_and_params_beside_message() {
        let e = AppError::bad_request("Quota exceeded").keyed("requests.quota", json!({"n": 3}));
        let (s, b) = body(e).await;
        assert_eq!(
            (s, b),
            (
                400,
                json!({"statusCode": 400, "message": "Quota exceeded", "error": "Bad Request",
                       "key": "requests.quota", "params": {"n": 3}})
            )
        );
    }

    #[tokio::test]
    async fn bare_has_no_error_key() {
        let (s, b) = body(AppError::bare(StatusCode::NOT_FOUND)).await;
        assert_eq!(
            (s, b),
            (404, json!({"statusCode": 404, "message": "Not Found"}))
        );
    }

    #[tokio::test]
    async fn with_message_adds_error() {
        let (s, b) = body(AppError::conflict("taken")).await;
        assert_eq!(s, 409);
        assert_eq!(
            b,
            json!({"statusCode": 409, "message": "taken", "error": "Conflict"})
        );
        let (_, b) = body(AppError::bad_request(vec!["a must be a string"])).await;
        assert_eq!(b["message"], json!(["a must be a string"]));
        assert_eq!(b["error"], "Bad Request");
    }

    #[tokio::test]
    async fn an_internal_error_hides_its_cause_but_keeps_it_for_jobs() {
        let e = AppError::internal("open /srv/x: denied");
        assert_eq!(e.text(), "open /srv/x: denied");
        let (s, b) = body(e).await;
        assert_eq!(
            (s, b),
            (
                500,
                json!({"statusCode": 500, "message": "Internal server error"})
            )
        );
        let (_, b) = body(AppError::internal_shown("pg_dump is not available")).await;
        assert_eq!(b["message"], "pg_dump is not available");
    }

    #[tokio::test]
    async fn sqlx_error_does_not_leak() {
        let (s, b) = body(sqlx::Error::PoolTimedOut.into()).await;
        assert_eq!(
            (s, b),
            (
                500,
                json!({"statusCode": 500, "message": "Internal server error"})
            )
        );
    }
}

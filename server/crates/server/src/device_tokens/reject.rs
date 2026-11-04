//! The refusals shared by the routes that read a device token: OPDS and the Kobo sync.
use crate::{auth::LoginThrottle, http::AppError};
use axum::{
    http::{
        HeaderValue, StatusCode,
        header::{RETRY_AFTER, WWW_AUTHENTICATE},
    },
    response::{IntoResponse, Response},
};
use std::net::IpAddr;

pub enum Reject {
    /// `challenge`: answer with the Basic challenge a reader waits for.
    Unauthorized {
        challenge: bool,
    },
    Throttled,
    Forbidden,
    Fault(AppError),
}

impl Reject {
    /// A failed credential, counted on `key` of the login limiter (`auth.md` rule 39).
    pub fn failed(t: &LoginThrottle, ip: Option<IpAddr>, key: &str, challenge: bool) -> Self {
        if t.attempt(ip, key) {
            Self::Unauthorized { challenge }
        } else {
            Self::Throttled
        }
    }
}

impl From<sqlx::Error> for Reject {
    fn from(e: sqlx::Error) -> Self {
        Self::Fault(e.into())
    }
}

impl IntoResponse for Reject {
    fn into_response(self) -> Response {
        match self {
            Self::Unauthorized { challenge: true } => (
                StatusCode::UNAUTHORIZED,
                [(
                    WWW_AUTHENTICATE,
                    HeaderValue::from_static("Basic realm=\"Fliks\", charset=\"UTF-8\""),
                )],
            )
                .into_response(),
            Self::Unauthorized { challenge: false } => StatusCode::UNAUTHORIZED.into_response(),
            Self::Throttled => (
                StatusCode::TOO_MANY_REQUESTS,
                [(RETRY_AFTER, HeaderValue::from_static("900"))],
                "Too many failed attempts, try again later",
            )
                .into_response(),
            Self::Forbidden => AppError::forbidden("Forbidden resource").into_response(),
            Self::Fault(e) => e.into_response(),
        }
    }
}

//! The OPDS credential (`docs/spec/opds.md` rules 1-3): a Basic device token of kind `opds`.
use crate::{
    auth::client_ip,
    device_tokens,
    engine::resolve::basic,
    http::{AppError, auth::Authed},
    state::AppState,
};
use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{
        HeaderValue, StatusCode,
        header::{AUTHORIZATION, RETRY_AFTER, WWW_AUTHENTICATE},
        request::Parts,
    },
    response::{IntoResponse, Response},
};
use fliks_domain::acl::{Action, Subject};
use fliks_engine_core::api::ResolveCredentialSource as Source;
use std::net::SocketAddr;

/// No username can hold a NUL, so this bucket of the login limiter is never a user's.
const THROTTLE_KEY: &str = "\0opds";

pub struct OpdsAuthed(pub Authed);

pub enum Reject {
    Unauthorized,
    Throttled,
    Forbidden,
    Fault(AppError),
}

impl From<sqlx::Error> for Reject {
    fn from(e: sqlx::Error) -> Self {
        Self::Fault(e.into())
    }
}

impl IntoResponse for Reject {
    fn into_response(self) -> Response {
        match self {
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                [(
                    WWW_AUTHENTICATE,
                    HeaderValue::from_static("Basic realm=\"Fliks\", charset=\"UTF-8\""),
                )],
            )
                .into_response(),
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

impl FromRequestParts<AppState> for OpdsAuthed {
    type Rejection = Reject;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Reject> {
        // No header is the challenge round of a reader: free, and not a failure.
        let Some(header) = parts.headers.get(AUTHORIZATION) else {
            return Err(Reject::Unauthorized);
        };
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| &c.0);
        let ip = client_ip(&parts.headers, peer);
        let fail = || {
            if st.login_throttle.attempt(ip, THROTTLE_KEY) {
                Reject::Unauthorized
            } else {
                Reject::Throttled
            }
        };
        let secret = header
            .to_str()
            .ok()
            .and_then(basic)
            .map(|(_, password)| password)
            .filter(|s| device_tokens::well_formed(s))
            .ok_or_else(fail)?;
        let owner = device_tokens::lookup(&st.db, &secret, Source::Basic)
            .await?
            .ok_or_else(fail)?;
        let a = Authed::load(&st.db, owner)
            .await?
            .ok_or(Reject::Unauthorized)?;
        a.require(Action::Read, Subject::Media)
            .map_err(|_| Reject::Forbidden)?;
        Ok(Self(a))
    }
}

//! The OPDS credential (`docs/spec/opds.md` rules 1-3): a Basic device token of kind `opds`.
use crate::{
    auth::client_ip,
    device_tokens::{self, Reject},
    engine::resolve::basic,
    http::auth::Authed,
    state::AppState,
};
use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{header::AUTHORIZATION, request::Parts},
};
use fliks_domain::acl::{Action, Subject};
use fliks_engine_core::api::ResolveCredentialSource as Source;
use std::net::SocketAddr;

/// No username can hold a NUL, so this bucket of the login limiter is never a user's.
const THROTTLE_KEY: &str = "\0opds";

pub struct OpdsAuthed(pub Authed);

impl FromRequestParts<AppState> for OpdsAuthed {
    type Rejection = Reject;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Reject> {
        // No header is the challenge round of a reader: free, and not a failure.
        let Some(header) = parts.headers.get(AUTHORIZATION) else {
            return Err(Reject::Unauthorized { challenge: true });
        };
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| &c.0);
        let ip = client_ip(&parts.headers, peer);
        let fail = || Reject::failed(&st.login_throttle, ip, THROTTLE_KEY, true);
        let secret = header
            .to_str()
            .ok()
            .and_then(basic)
            .map(|(_, password)| password)
            .filter(|s| device_tokens::well_formed(s))
            .ok_or_else(fail)?;
        let (owner, _) = device_tokens::lookup(&st.db, &secret, Source::Basic)
            .await?
            .ok_or_else(fail)?;
        let a = Authed::load(&st.db, owner)
            .await?
            .ok_or(Reject::Unauthorized { challenge: true })?;
        a.require(Action::Read, Subject::Media)
            .map_err(|_| Reject::Forbidden)?;
        Ok(Self(a))
    }
}

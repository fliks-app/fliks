//! The worker guard: the local engine's `hostToken`, or a remote worker's own token (stored hashed).
use super::tokens;
use crate::{
    engine::resolve::{bearer_is, bearer_token},
    http::AppError,
    state::AppState,
};
use axum::{
    extract::FromRequestParts,
    http::{StatusCode, request::Parts},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Principal {
    /// The engine beside the server: reads the library by path.
    Local,
    /// A remote worker, by `worker_tokens.id`.
    Token(i32),
}

impl Principal {
    /// The `jobs.workerId` of an instance: a token's leases can never be fenced by another principal.
    pub fn owner_key(self, instance: &str) -> String {
        match self {
            Self::Local => instance.to_owned(),
            Self::Token(id) => format!("t{id}:{instance}"),
        }
    }
}

/// Distinct from `HostAuth`: only the worker routes take it.
pub struct WorkerAuth(pub Principal);

impl FromRequestParts<AppState> for WorkerAuth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, AppError> {
        if bearer_is(&parts.headers, st.engine.host_token()) {
            return Ok(Self(Principal::Local));
        }
        let unauthorized = || AppError::bare(StatusCode::UNAUTHORIZED);
        let token = bearer_token(&parts.headers).ok_or_else(unauthorized)?;
        match tokens::find(&st.db, token).await? {
            Some(id) => Ok(Self(Principal::Token(id))),
            None => Err(unauthorized()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Principal;

    #[test]
    fn a_token_scopes_the_instance_id() {
        assert_eq!(Principal::Local.owner_key("w1"), "w1");
        assert_ne!(
            Principal::Token(1).owner_key("w1"),
            Principal::Token(2).owner_key("w1")
        );
    }
}

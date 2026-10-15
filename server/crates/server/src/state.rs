//! Shared handler state (`State<AppState>`); no DI container, plain fields.
use crate::{auth_token::Jwt, bridge::Bridge, config::Config, engine::Engine, events::Hub, nest};
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub cfg: Arc<Config>,
    pub jwt: Arc<Jwt>,
    pub engine: Engine,
    pub bridge: Bridge,
    pub hub: Hub,
}

impl AppState {
    /// `jwt_secret` is the resolved secret (`jwt_secret::resolve`); TTLs and the bridge token come from `cfg`.
    pub fn new(db: PgPool, cfg: Config, jwt_secret: &str) -> Self {
        Self {
            jwt: Arc::new(Jwt::new(
                jwt_secret,
                cfg.jwt_ttl_secs,
                cfg.stream_token_ttl_secs,
            )),
            engine: Engine::new(&cfg.engine_url, &cfg.engine_token),
            bridge: Bridge::new(&nest::url(&cfg), &cfg.bridge_token),
            hub: Hub::new(),
            cfg: Arc::new(cfg),
            db,
        }
    }
}

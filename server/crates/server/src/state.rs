//! Shared handler state (`State<AppState>`); no DI container, plain fields.
use crate::{
    auth_token::Jwt, bridge::Bridge, config::Config, engine::Engine, events::Hub, nest,
    playback::Debounce, presence::Presence, qoe::Qoe, stream,
};
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
    pub presence: Presence,
    pub qoe: Qoe,
    pub debounce: Arc<Debounce>,
    pub stream: Arc<stream::Shared>,
}

impl AppState {
    /// `jwt_secret` is the resolved secret (`jwt_secret::resolve`); TTLs and the bridge token come from `cfg`.
    pub fn new(db: PgPool, cfg: Config, jwt_secret: &str) -> Self {
        let presence = Presence::default();
        let qoe = Qoe::new(db.clone());
        // Active transcodes (the engine's job set) are not counted on the host yet.
        let sessions = presence.clone();
        qoe.set_load_probe(move || (0, u32::try_from(sessions.size()).unwrap_or(u32::MAX)));
        Self {
            jwt: Arc::new(Jwt::new(
                jwt_secret,
                cfg.jwt_ttl_secs,
                cfg.stream_token_ttl_secs,
            )),
            engine: Engine::new(&cfg.engine_url, &cfg.engine_token),
            bridge: Bridge::new(&nest::url(&cfg), &cfg.bridge_token),
            hub: Hub::new(),
            presence,
            qoe,
            debounce: Arc::default(),
            stream: Arc::default(),
            cfg: Arc::new(cfg),
            db,
        }
    }
}

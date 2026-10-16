//! Shared handler state (`State<AppState>`); no DI container, plain fields.
use crate::{
    auth_token::Jwt, bridge::Bridge, config::Config, engine::Engine, events::Hub,
    images::ImageStore, jobs::Running, metadata::Metadata, nest, playback::Debounce,
    presence::Presence, qoe::Qoe, requests::Ports, stream, system,
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
    pub ingest: Arc<crate::ingest::Shared>,
    pub seams: crate::seams::Seams,
    pub metadata: Arc<Metadata>,
    pub images: Arc<ImageStore>,
    pub system: Arc<system::Shared>,
    pub jobs: Arc<Running>,
    /// The S5 services the request flows call; the integration replaces `requests::Unwired`.
    pub requests: Arc<dyn Ports>,
}

impl AppState {
    /// `jwt_secret` is the resolved secret (`jwt_secret::resolve`); TTLs and the bridge token come from `cfg`.
    pub fn new(db: PgPool, cfg: Config, jwt_secret: &str) -> Self {
        let presence = Presence::default();
        let qoe = Qoe::new(db.clone());
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
            ingest: Arc::default(),
            seams: crate::seams::Seams::default(),
            metadata: Arc::new(Metadata::new(db.clone(), &cfg.metadata)),
            images: Arc::new(ImageStore::new(&cfg.metadata.tmdb_image_url)),
            system: Arc::default(),
            jobs: Arc::default(),
            requests: Arc::new(crate::requests::Unwired),
            cfg: Arc::new(cfg),
            db,
        }
    }
}

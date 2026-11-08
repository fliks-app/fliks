//! Shared handler state (`State<AppState>`); no DI container, plain fields.
use crate::{
    auth_token::Jwt, config::Config, engine::Engine, events::Hub, images::ImageStore,
    jobs::Running, metadata::Metadata, playback::Debounce, presence::Presence, qoe::Qoe, stream,
    system,
};
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub cfg: Arc<Config>,
    pub jwt: Arc<Jwt>,
    pub engine: Engine,
    pub hub: Hub,
    pub presence: Presence,
    pub parties: crate::party::Parties,
    pub relay: crate::party::Relay,
    pub qoe: Qoe,
    pub debounce: Arc<Debounce>,
    pub stream: Arc<stream::Shared>,
    pub ingest: Arc<crate::ingest::Shared>,
    /// Read by ingest, relink and link; written by a folder path change or delete (libraries rule 59).
    pub folder_moves: Arc<tokio::sync::RwLock<()>>,
    pub busy: crate::busy::Busy,
    pub metadata: Arc<Metadata>,
    pub xem: Arc<crate::scene::Xem>,
    pub images: Arc<ImageStore>,
    pub system: Arc<system::Shared>,
    pub jobs: Arc<Running>,
    pub queue: Arc<crate::queue::Shared>,
    pub subtitles: Arc<crate::subtitles::Shared>,
    pub lyrics: Arc<crate::lyrics::queue::Queue>,
    pub livetv: Arc<crate::livetv::Shared>,
    pub plugins: Arc<crate::plugins::Plugins>,
    pub karaoke: Arc<crate::karaoke::Shared>,
    pub login_throttle: Arc<crate::auth::LoginThrottle>,
    /// Wrong pairing codes per approver, apart from login so no username can collide with its key.
    pub pairing_throttle: Arc<crate::auth::LoginThrottle>,
    /// OpenID Connect caches and outbound network; a test harness swaps the network.
    pub oidc: Arc<crate::auth::oidc::Oidc>,
    pub sse_tickets: Arc<crate::events::Tickets>,
    /// Base URL of the Kobo store the proxy forwards to; only a test harness sets another.
    pub kobo_store: Arc<str>,
    /// Where converted KEPUB files live; `None` is `<cache dir>/kepub`, only a test harness sets one.
    pub kepub_cache: Option<Arc<std::path::Path>>,
    /// Signs the read grants of remote workers, so they outlive a restart.
    pub grant_key: Arc<[u8]>,
    /// Encrypts the secrets of `subsonic` device tokens (`device-tokens.md` rule 15).
    pub subsonic_key: Arc<[u8]>,
}

impl AppState {
    /// The plugin namespaces declared now, to parse or normalise an id of one.
    pub fn namespaces(&self) -> Arc<fliks_domain::external_id::Namespaces> {
        self.plugins.namespaces.get()
    }

    /// `jwt_secret` is the resolved secret (`jwt_secret::resolve`); TTLs come from `cfg`.
    pub fn new(db: PgPool, cfg: Config, jwt_secret: &str) -> Self {
        let presence = Presence::default();
        let qoe = Qoe::new(db.clone());
        let jobs: Arc<Running> = Arc::default();
        let plugins = Arc::new(crate::plugins::Plugins::new(
            db.clone(),
            crate::plugins::Options::from_config(&cfg),
        ));
        Self {
            jwt: Arc::new(Jwt::new(
                jwt_secret,
                cfg.jwt_ttl_secs,
                cfg.stream_token_ttl_secs,
            )),
            engine: Engine::new(&cfg.engine_url, &cfg.engine_token),
            hub: Hub::new(),
            presence,
            parties: crate::party::Parties::default(),
            relay: crate::party::Relay::default(),
            qoe,
            debounce: Arc::default(),
            stream: Arc::default(),
            ingest: Arc::default(),
            folder_moves: Arc::default(),
            busy: crate::busy::Busy::default(),
            metadata: Arc::new(Metadata::new(db.clone())),
            images: Arc::new(ImageStore::new()),
            xem: Arc::default(),
            system: Arc::default(),
            jobs,
            queue: Arc::default(),
            subtitles: Arc::default(),
            lyrics: Arc::default(),
            livetv: Arc::default(),
            plugins,
            karaoke: Arc::default(),
            login_throttle: Arc::default(),
            pairing_throttle: Arc::default(),
            oidc: Arc::default(),
            sse_tickets: Arc::default(),
            kobo_store: crate::kobo::STORE.into(),
            kepub_cache: None,
            grant_key: <sha2::Sha256 as sha2::Digest>::digest(format!(
                "fliks-job-grants:{jwt_secret}"
            ))
            .to_vec()
            .into(),
            subsonic_key: <sha2::Sha256 as sha2::Digest>::digest(format!(
                "fliks-subsonic-secrets:{jwt_secret}"
            ))
            .to_vec()
            .into(),
            cfg: Arc::new(cfg),
            db,
        }
    }
}

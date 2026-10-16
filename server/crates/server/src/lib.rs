pub mod app;
pub mod auth;
pub mod auth_token;
pub mod bridge;
pub mod config;
pub mod db;
pub mod engine;
pub mod events;
pub mod fs;
pub mod http;
pub mod images;
pub mod jwt_secret;
pub mod libraries;
pub mod media;
pub mod nest;
pub mod notifications;
pub mod paths;
pub mod playback;
pub mod playlists;
pub mod presence;
pub mod profiles;
pub mod qoe;
pub mod remote;
pub mod roles;
pub mod settings;
pub mod social;
pub mod state;
pub mod stream;
pub mod system;
pub mod users;

use config::Config;
use fliks_engine::{gateway::Upstream, supervise};
use sqlx::{PgPool, postgres::PgPoolOptions};
use state::AppState;
use std::{net::SocketAddr, time::Duration};

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// Nest's TypeORM pool size (`bootstrap.md` rule 14).
const POOL_MAX: u32 = 30;

async fn connect(cfg: &Config) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(POOL_MAX)
        .connect_with(cfg.db.clone())
        .await
}

pub async fn migrate(cfg: &Config) -> Result<(), BoxError> {
    let pool = connect(cfg).await?;
    db::migrate(&pool).await?;
    pool.close().await;
    Ok(())
}

pub async fn serve(cfg: Config) -> Result<(), BoxError> {
    let pool = connect(&cfg).await?;
    db::migrate(&pool).await?;
    roles::seed(&pool).await?;
    profiles::seed_quality_definitions(&pool).await?;
    profiles::warn_invalid_regexes(&pool).await?;
    users::seed_admin(&pool)
        .await
        .map_err(|e| format!("seed admin: {e:?}"))?;
    let secret = jwt_secret::resolve(&cfg);
    let upstream = Upstream::parse(&nest::url(&cfg))?;
    let db = pool.clone();
    let state = AppState::new(pool, cfg, &secret);
    presence::spawn(
        state.presence.clone(),
        state.engine.clone(),
        state.qoe.clone(),
    );
    qoe::spawn(&state.qoe);
    stream::spawn(&state);
    state.engine.start(state.db.clone(), state.cfg.port).await;
    remote::init(&state);
    let cfg = state.cfg.clone();
    let hub = state.hub.clone();
    let qoe = state.qoe.clone();
    let app = app::router(
        state,
        upstream,
        cfg.serve_static_path.clone(),
        cfg.cast_dir.clone(),
        cfg.cors_origin.clone(),
    );
    // Bind before spawning Nest so a port clash cannot orphan it.
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await?;
    let nest = nest::spawn(&cfg, &secret);
    auth::spawn_jobs(db);
    tracing::info!("listening on {}", listener.local_addr()?);
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        supervise::shutdown_signal().await;
        hub.shutdown();
    })
    .await;
    qoe.flush_all().await;
    if let Some(nest) = nest {
        let _ = nest.await;
    }
    served.map_err(Into::into)
}

/// GET `/api/system/liveness` on loopback; true on a 2xx.
pub fn healthcheck(port: u16) -> bool {
    use std::io::{Read, Write};
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let t = Duration::from_secs(5);
    let Ok(mut s) = std::net::TcpStream::connect_timeout(&addr, t) else {
        return false;
    };
    let _ = (s.set_read_timeout(Some(t)), s.set_write_timeout(Some(t)));
    let req = "GET /api/system/liveness HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n";
    let mut head = [0u8; 12];
    s.write_all(req.as_bytes()).is_ok()
        && s.read_exact(&mut head).is_ok()
        && head.starts_with(b"HTTP/1.")
        && head[9] == b'2'
}

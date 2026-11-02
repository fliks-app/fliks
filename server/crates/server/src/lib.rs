pub mod app;
pub mod atomic_file;
pub mod auth;
pub mod auth_token;
pub mod books;
pub mod busy;
pub mod cleanup;
pub mod collections;
pub mod config;
pub mod db;
pub mod engine;
pub mod events;
pub mod fs;
pub mod http;
pub mod images;
pub mod importers;
pub mod ingest;
pub mod jobs;
pub mod jwt_secret;
pub mod libraries;
pub mod livetv;
pub mod markers;
pub mod media;
pub mod media_servers;
pub mod metadata;
pub mod net;
pub mod notifications;
pub mod outbound;
pub mod party;
pub mod paths;
pub mod persons;
pub mod playback;
pub mod playlists;
pub mod plugins;
pub mod presence;
pub mod profiles;
pub mod qoe;
pub mod remote;
pub mod requests;
pub mod roles;
pub mod settings;
pub mod social;
pub mod state;
pub mod stream;
pub mod subtitles;
pub mod sync;
pub mod system;
pub mod users;
pub mod vetted;

use config::Config;
use sqlx::{Connection, PgConnection, PgPool, postgres::PgPoolOptions};
use state::AppState;
use std::{net::SocketAddr, time::Duration};

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// The 4.x pool size (`bootstrap.md` rule 14).
pub(crate) const POOL_MAX: u32 = 30;

async fn connect(cfg: &Config) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(POOL_MAX)
        .connect_with(cfg.db.clone())
        .await
}

pub async fn migrate(cfg: &Config) -> Result<(), BoxError> {
    let pool = connect(cfg).await?;
    system::backup::before_migration(cfg, &pool).await?;
    db::migrate(&pool).await?;
    pool.close().await;
    Ok(())
}

pub async fn serve(cfg: Config) -> Result<(), BoxError> {
    // One direct attempt: the pool would retry a refused connection for its whole acquire timeout.
    let probe =
        tokio::time::timeout(Duration::from_secs(10), PgConnection::connect_with(&cfg.db)).await;
    match probe {
        Ok(Ok(c)) => c.close().await?,
        Ok(Err(e)) => return Err(format!("cannot reach the database: {e}").into()),
        Err(_) => return Err("cannot reach the database: no answer within 10 s".into()),
    }
    let pool = connect(&cfg).await?;
    system::backup::before_migration(&cfg, &pool).await?;
    db::migrate(&pool).await?;
    jobs::sweep(&pool).await?;
    subtitles::sweep(&pool).await?;
    roles::seed(&pool).await?;
    profiles::seed_quality_definitions(&pool).await?;
    profiles::warn_invalid_regexes(&pool).await?;
    let folders_db = pool.clone();
    tokio::spawn(async move {
        match tokio::time::timeout(
            Duration::from_secs(60),
            libraries::warn_overlapping_folders(&folders_db),
        )
        .await
        {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!("library folder overlap check failed: {e}"),
            Err(_) => tracing::warn!("library folder overlap check timed out"),
        }
    });
    let secret = jwt_secret::resolve(&cfg);
    let mut cfg = cfg;
    if !cfg.engine_url.is_empty() {
        cfg.engine_token = jwt_secret::resolve_engine_token(&cfg);
    }
    let db = pool.clone();
    let state = AppState::new(pool, cfg, &secret);
    // The plugin host keeps the state for the process lifetime (a cycle only `serve` may create).
    state.plugins.attach(&state);
    presence::spawn(
        state.presence.clone(),
        state.engine.clone(),
        state.qoe.clone(),
    );
    livetv::spawn(&state);
    qoe::spawn(&state.qoe);
    stream::spawn(&state);
    state.engine.start(state.db.clone(), state.cfg.port).await;
    remote::init(&state);
    party::boot(&state).await?;
    party::spawn(&state);
    requests::spawn(&state);
    requests::spawn_reconcile(&state);
    let cfg = state.cfg.clone();
    let system = state.system.clone();
    let hub = state.hub.clone();
    let qoe = state.qoe.clone();
    let app = app::router(
        state.clone(),
        cfg.serve_static_path.clone(),
        cfg.cast_dir.clone(),
        cfg.cors_origin.clone(),
    );
    let listener = tokio::net::TcpListener::bind((cfg.bind, cfg.port)).await?;
    auth::spawn_jobs(db);
    jobs::spawn(&state);
    subtitles::scheduler::spawn_tick(&state);
    state.plugins.spawn(&state);
    state.plugins.boot().await;
    tracing::info!("listening on {}", listener.local_addr()?);
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_signal().await;
        hub.shutdown();
    })
    .await;
    qoe.flush_all().await;
    state.plugins.shutdown().await;
    // Non-zero so the parent supervisor (or `Restart=on-failure`) starts us again.
    if system.restarting() {
        std::process::exit(1);
    }
    served.map_err(Into::into)
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
        tokio::select! { _ = term.recv() => {}, _ = int.recv() => {} }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await.expect("ctrl-c handler");
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

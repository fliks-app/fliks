pub mod account_session;
pub mod acquisition;
pub mod annotations;
pub mod app;
pub mod atomic_file;
pub mod auth;
pub mod auth_token;
pub mod books;
pub mod boot;
pub mod busy;
pub mod cleanup;
pub mod collections;
pub mod comics;
pub mod config;
pub mod db;
pub mod device_tokens;
pub mod email;
pub mod engine;
pub mod events;
pub mod fs;
pub mod http;
pub mod images;
pub mod importers;
pub mod ingest;
pub mod jobs;
pub mod jwt_secret;
pub mod karaoke;
pub mod kobo;
pub mod kosync;
pub mod libraries;
pub mod livetv;
pub mod lyrics;
pub mod markers;
pub mod media;
pub mod media_servers;
pub mod metadata;
pub mod music;
pub mod net;
pub mod notifications;
pub mod opds;
pub mod optimize;
pub mod outbound;
pub mod party;
pub mod paths;
pub mod pcm;
pub mod persons;
pub mod playback;
pub mod playlists;
pub mod plugins;
pub mod presence;
pub mod problems;
pub mod profiles;
pub mod push;
pub mod qoe;
pub mod queue;
pub mod remote;
pub mod requests;
pub mod roles;
pub mod scene;
pub mod settings;
pub mod social;
pub mod state;
pub mod stream;
pub mod subsonic;
pub mod subtitles;
pub mod sync;
pub mod system;
pub mod users;
pub mod vetted;
pub mod wanted;

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

/// Longest wait for open connections after a stop signal; the engine waits 25 s before it kills the
/// server, and the QoE, push and plugin flushes run after the drain.
const DRAIN: Duration = Duration::from_secs(15);

/// `fliks-server restore <file>` (`system.md` rule 40): the server is stopped, and nothing migrates.
pub async fn restore(cfg: &Config, file: &std::path::Path) -> Result<(), BoxError> {
    let file = std::path::absolute(file)?;
    if !tokio::fs::metadata(&file).await.is_ok_and(|m| m.is_file()) {
        return Err(format!("{} is not a file", file.display()).into());
    }
    // Held until the restore ends, so a server starting meanwhile sees it too.
    let mut lock = PgConnection::connect_with(&cfg.db).await?;
    if !system::instance::claim(&mut lock).await? {
        return Err("a Fliks server is running on this database: stop it before restoring".into());
    }
    let pool = connect(cfg).await?;
    let failed = system::restore::offline(cfg, &pool, &file).await;
    pool.close().await;
    lock.close().await?;
    let failed = failed.map_err(|e| e.to_string())?;
    for f in &failed {
        tracing::warn!("plugin schema {} not restored: {}", f.schema, f.message);
    }
    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("{} plugin schema(s) not restored, see above", failed.len()).into())
    }
}

pub async fn serve(cfg: Config) -> Result<(), BoxError> {
    let listener = tokio::net::TcpListener::bind((cfg.bind, cfg.port)).await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    let slot = boot::Slot::default();
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let mut http = tokio::spawn(
        axum::serve(
            listener,
            boot::gate(slot.clone()).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            let _ = stop.send(true);
        })
        .into_future(),
    );
    let booted = tokio::select! {
        r = boot(cfg) => r?,
        _ = stopped.wait_for(|s| *s) => return Ok(()),
        r = &mut http => return r?.map_err(Into::into),
    };
    let (state, app, _instance) = booted;
    let (system, hub, qoe) = (state.system.clone(), state.hub.clone(), state.qoe.clone());
    let _ = slot.set(app);
    let served = tokio::select! {
        r = &mut http => r?,
        _ = async {
            let _ = stopped.wait_for(|s| *s).await;
            hub.shutdown();
            tokio::time::sleep(DRAIN).await;
        } => {
            tracing::warn!("open connections still running after {DRAIN:?}, closing");
            Ok(())
        }
    };
    qoe.flush_all().await;
    push::flush_pending(&state).await;
    state.plugins.shutdown().await;
    // Non-zero so the parent supervisor (or `Restart=on-failure`) starts us again.
    if system.restarting() {
        std::process::exit(1);
    }
    served.map_err(Into::into)
}

/// Everything between the bound listener and the first request: probe, dump, migrations, seeds.
async fn boot(cfg: Config) -> Result<(AppState, axum::Router, PgConnection), BoxError> {
    // One direct attempt: the pool would retry a refused connection for its whole acquire timeout.
    let probe =
        tokio::time::timeout(Duration::from_secs(10), PgConnection::connect_with(&cfg.db)).await;
    let instance = match probe {
        Ok(Ok(mut c)) => {
            if !system::instance::claim(&mut c).await? {
                tracing::warn!("another Fliks server or restore is using this database");
            }
            c
        }
        Ok(Err(e)) => return Err(format!("cannot reach the database: {e}").into()),
        Err(_) => return Err("cannot reach the database: no answer within 10 s".into()),
    };
    let pool = connect(&cfg).await?;
    system::backup::before_migration(&cfg, &pool).await?;
    db::migrate(&pool).await?;
    jobs::sweep(&pool).await?;
    queue::boot(&pool).await?;
    email::sweep(&pool).await?;
    subtitles::sweep(&pool).await?;
    roles::seed(&pool).await?;
    profiles::seed_quality_definitions(&pool).await?;
    profiles::warn_invalid_regexes(&pool).await?;
    plugins::defaults::import_env(&pool).await;
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
    // Before any task that reads stored ids, settings or requests.
    if let Err(e) = plugins::namespaces::load(&state.db, &state.plugins.namespaces).await {
        tracing::warn!("provider namespaces not loaded: {e}");
    }
    lyrics::queue::spawn_sweep(state.clone());
    presence::spawn(&state);
    livetv::spawn(&state);
    qoe::spawn(&state.qoe);
    stream::spawn(&state);
    state.engine.start(state.db.clone(), state.cfg.port).await;
    remote::init(&state);
    push::init(&state);
    account_session::spawn(&state).await;
    media::write::recover(&state).await;
    ingest::books::backfill_unmatched(&state).await;
    ingest::books::merge::resume_backfills(&state).await;
    party::boot(&state).await?;
    party::spawn(&state);
    requests::spawn(&state);
    requests::spawn_reconcile(&state);
    problems::spawn(&state);
    let cfg = state.cfg.clone();
    let app = app::router(
        state.clone(),
        cfg.serve_static_path.clone(),
        cfg.cast_dir.clone(),
        cfg.cors_origin.clone(),
    );
    auth::spawn_jobs(db);
    jobs::spawn(&state);
    queue::spawn(&state);
    subtitles::scheduler::spawn_tick(&state);
    state.plugins.spawn(&state);
    karaoke::spawn(&state);
    if let Err(e) = state.metadata.load_orders(&state.namespaces()).await {
        tracing::warn!("metadata provider order not loaded: {e}");
    }
    state.plugins.boot().await;
    // The session holding the instance lock lives as long as the server.
    Ok((state, app, instance))
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

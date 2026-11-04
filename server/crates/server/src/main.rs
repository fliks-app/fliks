use fliks_server::config::Config;
use std::process::ExitCode;

// glibc keeps the peaks of a many-threaded server resident; musl malloc is slow under contention.
#[cfg(target_os = "linux")]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// The hidden subcommands run before any runtime exists: their children are limited in address
/// space, and runtime threads would eat it.
fn main() -> ExitCode {
    let first = std::env::args().nth(1);
    if first.as_deref() == Some(fliks_server::plugins::compile::SUBCOMMAND) {
        return fliks_server::plugins::compile::child_main();
    }
    #[cfg(target_os = "linux")]
    if first.as_deref() == Some(fliks_server::comics::sandbox::SUBCOMMAND) {
        return fliks_server::comics::sandbox::child_main();
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime")
        .block_on(run())
}

async fn run() -> ExitCode {
    use tracing_subscriber::prelude::*;
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::builder()
                .with_default_directive(tracing::Level::INFO.into())
                .from_env_lossy(),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(fliks_server::system::logs::RingLayer)
        .init();
    let cfg = Config::from_env();
    let result = match std::env::args().nth(1).as_deref() {
        None => fliks_server::serve(cfg).await,
        Some("migrate") => fliks_server::migrate(&cfg).await,
        Some("healthcheck") => {
            return if fliks_server::healthcheck(cfg.port) {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            };
        }
        Some("openapi") => {
            println!("{}", fliks_server::app::openapi().to_pretty_json().unwrap());
            return ExitCode::SUCCESS;
        }
        Some(other) => {
            eprintln!("unknown command {other:?}; expected migrate, healthcheck or openapi");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("{e}");
            ExitCode::FAILURE
        }
    }
}

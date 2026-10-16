use fliks_server::config::Config;
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
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

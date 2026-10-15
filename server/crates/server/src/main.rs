use fliks_server::config::Config;
use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("info".parse().unwrap()),
        )
        .with_writer(std::io::stderr)
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
            use utoipa::OpenApi;
            println!(
                "{}",
                fliks_server::app::ApiDoc::openapi()
                    .to_pretty_json()
                    .unwrap()
            );
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

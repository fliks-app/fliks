//! Nest child process: spawned and restarted by `fliks_engine::supervise` (strangler only, removed at S9).
use crate::config::Config;
use fliks_engine::supervise;
use tokio::task::JoinHandle;

pub fn url(cfg: &Config) -> String {
    cfg.nest_url
        .clone()
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", cfg.nest_port))
}

/// `None` when `FLIKS_NEST_URL` points at a Nest managed elsewhere.
pub fn spawn(cfg: &Config, jwt_secret: &str) -> Option<JoinHandle<u8>> {
    if cfg.nest_url.is_some() {
        return None;
    }
    let host = format!("http://127.0.0.1:{}", cfg.port);
    let env = [
        ("PORT", cfg.nest_port.to_string()),
        ("FLIKS_HOST_URL", host.clone()),
        ("FLIKS_SERVER_URL", host),
        ("FLIKS_BRIDGE_TOKEN", cfg.bridge_token.clone()),
        ("JWT_SECRET", jwt_secret.to_owned()),
    ];
    let (cmd, engine_url, engine_token) = (
        cfg.nest_cmd.clone(),
        cfg.engine_url.clone(),
        cfg.engine_token.clone(),
    );
    Some(tokio::spawn(async move {
        supervise::run(&cmd, &engine_url, &engine_token, &env).await
    }))
}

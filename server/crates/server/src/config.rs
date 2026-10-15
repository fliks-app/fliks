//! Environment configuration; defaults and parsing follow `docs/spec/config.md`.
use crate::auth_token::{positive_int_or, ttl_secs};
use sqlx::postgres::PgConnectOptions;
use std::path::PathBuf;

const DEFAULT_PORT: u16 = 4849;
const DEFAULT_NEST_CMD: &str = "node dist/main";
const DEFAULT_JWT_EXPIRATION_SECS: u64 = 3600;
const DEFAULT_STREAM_TOKEN_TTL_SECS: u64 = 12 * 3600;
const DEFAULT_REFRESH_TOKEN_TTL_DAYS: i64 = 60;

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub db: PgConnectOptions,
    pub cors_origin: Option<String>,
    pub serve_static_path: Option<PathBuf>,
    pub cast_dir: PathBuf,
    pub conf_dir: Option<PathBuf>,
    pub jwt_secret: Option<String>,
    /// `JWT_EXPIRATION` in whole seconds (`ms()` grammar, unitless is milliseconds).
    pub jwt_ttl_secs: u64,
    pub stream_token_ttl_secs: u64,
    pub refresh_token_ttl_days: i64,
    pub engine_url: String,
    pub engine_token: String,
    pub nest_url: Option<String>,
    pub nest_cmd: Vec<String>,
    pub nest_port: u16,
    pub bridge_token: String,
}

impl Config {
    pub fn from_env() -> Self {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let text = |k: &str| {
            get(k)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        // Nest's `Number(x) || default`: unparsable and 0 fall back.
        let number = |k: &str, default: u16| {
            get(k)
                .and_then(|v| v.trim().parse().ok())
                .filter(|n| *n != 0)
                .unwrap_or(default)
        };
        let port = number("PORT", DEFAULT_PORT);
        let db = PgConnectOptions::new_without_pgpass()
            .host(&get("DB_HOST").unwrap_or_else(|| "localhost".into()))
            .port(
                get("DB_PORT")
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(5432),
            )
            .username(&get("DB_USERNAME").unwrap_or_else(|| "fliks".into()))
            .password(&get("DB_PASSWORD").unwrap_or_else(|| "fliks".into()))
            .database(&get("DB_NAME").unwrap_or_else(|| "fliks".into()));
        let nest_cmd = match (text("FLIKS_NODE_BIN"), text("FLIKS_NEST_ENTRY")) {
            (Some(bin), Some(entry)) => vec![bin, entry],
            _ => text("FLIKS_NEST_CMD")
                .unwrap_or_else(|| DEFAULT_NEST_CMD.into())
                .split_whitespace()
                .map(str::to_owned)
                .collect(),
        };
        Self {
            port,
            db,
            cors_origin: text("CORS_ORIGIN"),
            serve_static_path: text("SERVE_STATIC_PATH").map(PathBuf::from),
            cast_dir: text("FLIKS_CAST_DIR").map_or_else(|| "public".into(), PathBuf::from),
            conf_dir: text("FLIKS_CONF_DIR").map(PathBuf::from),
            jwt_secret: get("JWT_SECRET").filter(|v| !v.is_empty()),
            jwt_ttl_secs: ttl_secs(
                "JWT_EXPIRATION",
                get("JWT_EXPIRATION").as_deref(),
                DEFAULT_JWT_EXPIRATION_SECS,
            ),
            stream_token_ttl_secs: ttl_secs(
                "STREAM_TOKEN_TTL",
                get("STREAM_TOKEN_TTL").as_deref(),
                DEFAULT_STREAM_TOKEN_TTL_SECS,
            ),
            refresh_token_ttl_days: positive_int_or(
                get("REFRESH_TOKEN_TTL_DAYS").as_deref(),
                DEFAULT_REFRESH_TOKEN_TTL_DAYS,
            ),
            engine_url: get("FLIKS_ENGINE_URL").unwrap_or_default(),
            engine_token: get("FLIKS_ENGINE_TOKEN").unwrap_or_default(),
            nest_url: text("FLIKS_NEST_URL"),
            nest_cmd,
            nest_port: number("FLIKS_NEST_PORT", port.saturating_add(1)),
            bridge_token: text("FLIKS_BRIDGE_TOKEN").unwrap_or_else(|| random_hex(32)),
        }
    }
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("os rng");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> Config {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|k| m.get(k).cloned())
    }

    #[test]
    fn defaults() {
        let c = cfg(&[]);
        assert_eq!((c.port, c.nest_port), (4849, 4850));
        assert_eq!(c.nest_cmd, ["node", "dist/main"]);
        assert_eq!(c.db.get_host(), "localhost");
        assert_eq!(c.db.get_port(), 5432);
        assert_eq!(c.db.get_username(), "fliks");
        assert_eq!(c.bridge_token.len(), 64);
        assert!(c.nest_url.is_none() && c.cors_origin.is_none() && c.jwt_secret.is_none());
        assert_eq!(
            (
                c.jwt_ttl_secs,
                c.stream_token_ttl_secs,
                c.refresh_token_ttl_days
            ),
            (3600, 43_200, 60)
        );
    }

    #[test]
    fn token_lifetimes_use_the_ms_grammar() {
        let c = cfg(&[
            ("JWT_EXPIRATION", "3600"),
            ("STREAM_TOKEN_TTL", "2 days"),
            ("REFRESH_TOKEN_TTL_DAYS", "14"),
        ]);
        assert_eq!(
            (
                c.jwt_ttl_secs,
                c.stream_token_ttl_secs,
                c.refresh_token_ttl_days
            ),
            (3, 172_800, 14)
        );
        assert_eq!(cfg(&[("JWT_EXPIRATION", "15m")]).jwt_ttl_secs, 900);
    }

    #[test]
    fn port_falls_back_like_number_or_default() {
        assert_eq!(cfg(&[("PORT", "abc")]).port, 4849);
        assert_eq!(cfg(&[("PORT", "0")]).port, 4849);
        let c = cfg(&[("PORT", "3001")]);
        assert_eq!((c.port, c.nest_port), (3001, 3002));
        assert_eq!(
            cfg(&[("PORT", "3001"), ("FLIKS_NEST_PORT", "9")]).nest_port,
            9
        );
    }

    #[test]
    fn node_bin_and_entry_win_over_nest_cmd_and_keep_spaces() {
        let c = cfg(&[
            ("FLIKS_NODE_BIN", "/a b/node"),
            ("FLIKS_NEST_ENTRY", "/c d/main.js"),
            ("FLIKS_NEST_CMD", "ignored"),
        ]);
        assert_eq!(c.nest_cmd, ["/a b/node", "/c d/main.js"]);
        assert_eq!(
            cfg(&[("FLIKS_NEST_CMD", " node  x.js ")]).nest_cmd,
            ["node", "x.js"]
        );
        assert_eq!(
            cfg(&[("FLIKS_NODE_BIN", "node")]).nest_cmd,
            ["node", "dist/main"]
        );
    }

    #[test]
    fn empty_values_are_unset() {
        let c = cfg(&[
            ("JWT_SECRET", ""),
            ("CORS_ORIGIN", " "),
            ("FLIKS_NEST_URL", ""),
        ]);
        assert!(c.jwt_secret.is_none() && c.cors_origin.is_none() && c.nest_url.is_none());
    }
}

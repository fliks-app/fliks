//! Config owner (`engine-glue.md` section C): the one process that `PUT /v1/config`s the engine.
use super::{Engine, EngineError, store};
use fliks_engine_core::{
    api::{EngineConfig, LifetimeConfig, LiveTvConfig, QsvPreset, StreamingConfig},
    jsnum,
};
use reqwest::Method;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::collections::HashMap;

/// The `livetv_*` settings the engine receives (`livetv-sessions.md` rule 32).
pub const LIVETV_KEYS: [&str; 5] = [
    "livetv_segment_seconds",
    "livetv_timeshift_minutes",
    "livetv_probe_seconds",
    "livetv_channel_idle_seconds",
    "livetv_fast_zap",
];

const STREAMING_KEYS: [&str; 12] = [
    "streaming_segment_duration",
    "streaming_qsv_preset",
    "streaming_tonemap_algo",
    "streaming_tonemap_curve",
    "streaming_cache_max_gb",
    "streaming_cache_ttl_hours",
    "streaming_ffmpeg_slots",
    "streaming_auto_quality_mode",
    "streaming_auto_crop_enabled",
    "streaming_gpu_render_node",
    "streaming_throttle_enabled",
    "streaming_throttle_threshold_seconds",
];
const GB: f64 = 1024.0 * 1024.0 * 1024.0;
const HOUR_MS: f64 = 3_600_000.0;
const DEFAULT_CACHE_MAX_BYTES: f64 = 20.0 * GB;
const DEFAULT_CACHE_TTL_MS: f64 = 4.0 * HOUR_MS;
const MIN_THROTTLE_THRESHOLD_SECONDS: f64 = 60.0;
const DEFAULT_THROTTLE_THRESHOLD_SECONDS: f64 = 90.0;
/// 409s on `PUT /v1/config` that refetch the revision before the push gives up.
const CONFLICT_ATTEMPTS: u32 = 5;

/// Where the engine reaches the resolver: `FLIKS_HOST_URL`, else the loopback port of this process.
pub fn host_url(port: u16) -> String {
    host_url_from(std::env::var("FLIKS_HOST_URL").ok(), port)
}

fn host_url_from(env: Option<String>, port: u16) -> String {
    env.filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("http://127.0.0.1:{port}"))
}

fn parse<T: DeserializeOwned>(raw: &str) -> Option<T> {
    serde_json::from_value(Value::String(raw.to_owned())).ok()
}

/// `StreamingConfig` from the `streaming_*` rows: every missing or unusable value takes its default.
pub fn streaming(raw: &HashMap<String, String>) -> StreamingConfig {
    let get = |k: &str| raw.get(k).map(String::as_str);
    let positive = |k: &str| get(k).and_then(jsnum::number).filter(|v| *v > 0.0);
    let d = StreamingConfig::default();
    StreamingConfig {
        segment_duration: jsnum::parse_float(get("streaming_segment_duration").unwrap_or("3"))
            .filter(|v| *v != 0.0 && v.is_finite())
            .unwrap_or(d.segment_duration),
        qsv_preset: get("streaming_qsv_preset")
            .and_then(parse)
            .unwrap_or(d.qsv_preset),
        tonemap_algo: get("streaming_tonemap_algo")
            .and_then(parse)
            .unwrap_or(d.tonemap_algo),
        tonemap_curve: get("streaming_tonemap_curve")
            .and_then(parse)
            .unwrap_or(d.tonemap_curve),
        cache_max_bytes: Some(
            positive("streaming_cache_max_gb")
                .map_or(DEFAULT_CACHE_MAX_BYTES, |gb| jsnum::round(gb * GB)),
        ),
        cache_ttl_ms: Some(
            positive("streaming_cache_ttl_hours")
                .map_or(DEFAULT_CACHE_TTL_MS, |h| jsnum::round(h * HOUR_MS)),
        ),
        ffmpeg_slots: positive("streaming_ffmpeg_slots")
            .filter(|n| n.fract() == 0.0 && *n <= f64::from(u32::MAX))
            .map(|n| n as u32),
        job_min_free_bytes: d.job_min_free_bytes,
        auto_quality_mode: get("streaming_auto_quality_mode")
            .and_then(parse)
            .unwrap_or(d.auto_quality_mode),
        auto_crop_enabled: get("streaming_auto_crop_enabled") != Some("false"),
        gpu_render_node: get("streaming_gpu_render_node")
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or("auto")
            .to_owned(),
        subtitle_prewarm: d.subtitle_prewarm,
        throttle_enabled: get("streaming_throttle_enabled") != Some("false"),
        throttle_threshold_seconds: jsnum::max(
            MIN_THROTTLE_THRESHOLD_SECONDS,
            positive("streaming_throttle_threshold_seconds")
                .unwrap_or(DEFAULT_THROTTLE_THRESHOLD_SECONDS),
        ),
    }
}

use fliks_domain::js::parse_int;

/// `LiveTvConfig` from the `livetv_*` rows: `intOr` defaults, the floors of the engine, `fastZap` only for `true`/`false`.
pub fn livetv(raw: &HashMap<String, String>) -> LiveTvConfig {
    let int = |k: &str, default: i32| {
        raw.get(k).and_then(|v| parse_int(v)).map_or(default, |n| {
            n.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
        })
    };
    LiveTvConfig {
        segment_seconds: int("livetv_segment_seconds", 2).max(1),
        timeshift_minutes: int("livetv_timeshift_minutes", 15).max(1),
        probe_seconds: int("livetv_probe_seconds", 3),
        channel_idle_seconds: int("livetv_channel_idle_seconds", 30),
        fast_zap: match raw.get("livetv_fast_zap").map(String::as_str) {
            Some("true") => Some(true),
            Some("false") => Some(false),
            _ => None,
        },
    }
}

/// `EngineConfig.lifetime` from the `STREAM_*` env: a positive integer, else the default.
pub fn lifetime(env: impl Fn(&str) -> Option<String>) -> LifetimeConfig {
    let d = LifetimeConfig::default();
    let int = |k: &str, default: u32| {
        env(k)
            .and_then(|raw| parse_int(&raw))
            .filter(|n| *n > 0)
            .and_then(|n| u32::try_from(n).ok())
            .unwrap_or(default)
    };
    LifetimeConfig {
        live_session_ttl_ms: int("STREAM_LIVE_SESSION_TTL_MS", d.live_session_ttl_ms),
        live_session_gc_interval_ms: int(
            "STREAM_LIVE_SESSION_GC_INTERVAL_MS",
            d.live_session_gc_interval_ms,
        ),
        session_revive_ttl_ms: int("STREAM_SESSION_REVIVE_TTL_MS", d.session_revive_ttl_ms),
        max_sessions_per_owner: int("STREAM_MAX_SESSIONS_PER_USER", d.max_sessions_per_owner),
        job_grace_ms: int("STREAM_JOB_GRACE_MS", d.job_grace_ms),
        job_fallback_timeout_ms: int("STREAM_JOB_FALLBACK_TIMEOUT_MS", d.job_fallback_timeout_ms),
        cache_gc_interval_ms: int("TRANSCODE_CACHE_GC_INTERVAL_MS", d.cache_gc_interval_ms),
        ..d
    }
}

/// The saved `streaming_*` settings, resolved like the config push does.
pub async fn load_streaming(db: &sqlx::PgPool) -> sqlx::Result<StreamingConfig> {
    Ok(streaming(&store::values(db, &STREAMING_KEYS).await?))
}

/// What the settings PUT must refuse: a stored value the engine would reject (and with it the whole config).
pub fn validate_streaming_setting(key: &str, value: Option<&str>) -> Result<(), String> {
    let Some(v) = value.filter(|v| !v.is_empty()) else {
        return Ok(());
    };
    match key {
        "streaming_qsv_preset" if parse::<QsvPreset>(v).is_none() => Err(format!(
            "{key} must be one of the following values: veryfast, faster, fast, medium, slow, slower, veryslow"
        )),
        "streaming_ffmpeg_slots" => match jsnum::number(v) {
            Some(n) if n > 0.0 && (n.fract() != 0.0 || n > f64::from(u32::MAX)) => {
                Err(format!("{key} must be a positive integer number"))
            }
            _ => Ok(()),
        },
        _ => Ok(()),
    }
}

impl Engine {
    /// A settings write: the `streaming_*` and `livetv_*` keys are the engine's, so they re-push.
    pub async fn settings_changed(&self, keys: &[String]) {
        if keys
            .iter()
            .any(|k| k.starts_with("streaming_") || LIVETV_KEYS.contains(&k.as_str()))
        {
            self.push_logged().await;
        }
    }

    /// The live TV segment length of the last config the engine was given (2 before the first).
    pub fn livetv_segment_seconds(&self) -> i32 {
        self.inner
            .segment_seconds
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    /// `PUT /v1/config` with the next revision when anything pushed changed; serialized, so two callers
    /// never race the revision. A 409 refetches the revision and retries a bounded number of times.
    pub async fn push_config(&self) -> Result<(), EngineError> {
        let mut pushed = self.inner.pushed.lock().await;
        let Some(client) = self.state().client.clone() else {
            return Ok(());
        };
        let streaming = match self.db() {
            Some(db) => {
                let raw = store::values(db, &STREAMING_KEYS).await?;
                streaming(&raw)
            }
            None => StreamingConfig::default(),
        };
        let livetv = match self.db() {
            Some(db) => livetv(&store::values(db, &LIVETV_KEYS).await?),
            None => LiveTvConfig::default(),
        };
        self.inner
            .segment_seconds
            .store(livetv.segment_seconds, std::sync::atomic::Ordering::Relaxed);
        let path_mappings = self.state().path_mappings.clone();
        let key =
            serde_json::to_string(&(&streaming, &livetv, &path_mappings)).expect("config key");
        if key == pushed.last_pushed {
            self.state().push_needed = false;
            return Ok(());
        }
        let mut config = EngineConfig {
            revision: 0,
            host_url: self.inner.host_url.get().cloned(),
            host_token: Some(self.inner.host_token.clone()),
            streaming,
            lifetime: lifetime(|k| std::env::var(k).ok()),
            livetv,
            path_mappings,
        };
        let backoff = self.timing().conflict_backoff;
        for attempt in 1..=CONFLICT_ATTEMPTS {
            config.revision = pushed.revision + 1;
            let reply = client.send(Method::PUT, "/v1/config", &config).await?;
            if reply.ok() {
                pushed.revision += 1;
                pushed.last_pushed = key;
                self.state().push_needed = false;
                tracing::info!("config pushed (revision {})", pushed.revision);
                return Ok(());
            }
            if reply.status != 409 || attempt == CONFLICT_ATTEMPTS {
                return Err(EngineError::http("PUT /v1/config", &reply));
            }
            tokio::time::sleep(backoff * 2u32.pow(attempt - 1)).await;
            let current = client.get("/v1/config", &[]).await?;
            let revision = current
                .ok()
                .then(|| current.body.as_ref()?.get("revision")?.as_u64())
                .flatten()
                .ok_or_else(|| EngineError::http("GET /v1/config", &current))?;
            pushed.revision = revision as u32;
        }
        unreachable!("the last attempt returns")
    }

    /// `push_config` for the callers with nobody to tell: a failure is logged and retried by the poll.
    pub(super) async fn push_logged(&self) {
        if let Err(e) = self.push_config().await {
            tracing::warn!("{e}: config not pushed, retrying with the poll");
            self.state().push_needed = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn streaming_defaults_and_parsing_follow_the_settings_cache() {
        let d = streaming(&raw(&[]));
        assert_eq!(d.segment_duration, 3.0);
        assert_eq!(d.cache_max_bytes, Some(21_474_836_480.0));
        assert_eq!(d.cache_ttl_ms, Some(14_400_000.0));
        assert_eq!(d.ffmpeg_slots, None);
        assert_eq!(d.throttle_threshold_seconds, 90.0);
        assert!(d.auto_crop_enabled && d.throttle_enabled);
        assert_eq!(d.gpu_render_node, "auto");
        let s = streaming(&raw(&[
            ("streaming_segment_duration", "2.5s"),
            ("streaming_qsv_preset", "slow"),
            ("streaming_tonemap_algo", "vaapi"),
            ("streaming_tonemap_curve", "bogus"),
            ("streaming_cache_max_gb", "1.5"),
            ("streaming_cache_ttl_hours", "0.5"),
            ("streaming_ffmpeg_slots", "4"),
            ("streaming_auto_quality_mode", "abr"),
            ("streaming_auto_crop_enabled", "false"),
            ("streaming_gpu_render_node", " /dev/dri/renderD129 "),
            ("streaming_throttle_enabled", "false"),
            ("streaming_throttle_threshold_seconds", "10"),
        ]));
        assert_eq!(s.segment_duration, 2.5);
        assert_eq!(format!("{:?}", s.qsv_preset), "Slow");
        assert_eq!(format!("{:?}", s.tonemap_algo), "Vaapi");
        assert_eq!(format!("{:?}", s.tonemap_curve), "Mobius");
        assert_eq!(s.cache_max_bytes, Some(1_610_612_736.0));
        assert_eq!(s.cache_ttl_ms, Some(1_800_000.0));
        assert_eq!(s.ffmpeg_slots, Some(4));
        assert!(!s.auto_crop_enabled && !s.throttle_enabled);
        assert_eq!(s.gpu_render_node, "/dev/dri/renderD129");
        assert_eq!(s.throttle_threshold_seconds, 60.0);
    }

    #[test]
    fn livetv_settings_default_floor_and_parse_like_the_host_did() {
        let d = livetv(&raw(&[]));
        assert_eq!(
            (
                d.segment_seconds,
                d.timeshift_minutes,
                d.probe_seconds,
                d.channel_idle_seconds
            ),
            (2, 15, 3, 30)
        );
        assert_eq!(d.fast_zap, None);
        let l = livetv(&raw(&[
            ("livetv_segment_seconds", "0"),
            ("livetv_timeshift_minutes", "-4"),
            ("livetv_probe_seconds", "1"),
            ("livetv_channel_idle_seconds", "12s"),
            ("livetv_fast_zap", "false"),
        ]));
        assert_eq!(
            (
                l.segment_seconds,
                l.timeshift_minutes,
                l.probe_seconds,
                l.channel_idle_seconds
            ),
            (1, 1, 1, 12)
        );
        assert_eq!(l.fast_zap, Some(false));
        let odd = livetv(&raw(&[
            ("livetv_segment_seconds", "x"),
            ("livetv_fast_zap", "TRUE"),
        ]));
        assert_eq!((odd.segment_seconds, odd.fast_zap), (2, None));
    }

    #[test]
    fn unset_means_blank_zero_or_not_a_number() {
        for v in ["", "0", "abc", "-1"] {
            let s = streaming(&raw(&[
                ("streaming_ffmpeg_slots", v),
                ("streaming_cache_max_gb", v),
                ("streaming_segment_duration", v),
            ]));
            assert_eq!(s.ffmpeg_slots, None, "{v:?}");
            assert_eq!(s.cache_max_bytes, Some(DEFAULT_CACHE_MAX_BYTES), "{v:?}");
            assert_eq!(
                s.segment_duration,
                if v == "-1" { -1.0 } else { 3.0 },
                "{v:?}"
            );
        }
        assert_eq!(
            streaming(&raw(&[("streaming_ffmpeg_slots", "2.5")])).ffmpeg_slots,
            None
        );
    }

    #[test]
    fn lifetime_reads_positive_integers_only() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        let d = LifetimeConfig::default();
        assert_eq!(lifetime(env(&[])), d);
        let l = lifetime(env(&[
            ("STREAM_LIVE_SESSION_TTL_MS", " 45000ms"),
            ("STREAM_LIVE_SESSION_GC_INTERVAL_MS", "0"),
            ("STREAM_SESSION_REVIVE_TTL_MS", "-5"),
            ("STREAM_MAX_SESSIONS_PER_USER", "abc"),
            ("STREAM_JOB_GRACE_MS", "99999999999"),
            ("TRANSCODE_CACHE_GC_INTERVAL_MS", "7"),
        ]));
        assert_eq!(l.live_session_ttl_ms, 45_000);
        assert_eq!(l.live_session_gc_interval_ms, d.live_session_gc_interval_ms);
        assert_eq!(l.session_revive_ttl_ms, d.session_revive_ttl_ms);
        assert_eq!(l.max_sessions_per_owner, d.max_sessions_per_owner);
        assert_eq!(l.job_grace_ms, d.job_grace_ms);
        assert_eq!(l.cache_gc_interval_ms, 7);
    }

    #[test]
    fn host_url_defaults_to_loopback_and_the_env_wins() {
        assert_eq!(host_url_from(None, 4849), "http://127.0.0.1:4849");
        assert_eq!(
            host_url_from(Some(String::new()), 4849),
            "http://127.0.0.1:4849"
        );
        assert_eq!(
            host_url_from(Some("http://nas:4848".into()), 4849),
            "http://nas:4848"
        );
    }

    #[test]
    fn the_settings_put_refuses_what_the_engine_would() {
        let ok = |k, v| validate_streaming_setting(k, v).is_ok();
        assert!(ok("streaming_qsv_preset", Some("veryslow")) && ok("streaming_qsv_preset", None));
        assert!(!ok("streaming_qsv_preset", Some("Fast")));
        assert!(ok("streaming_ffmpeg_slots", Some("4")) && ok("streaming_ffmpeg_slots", Some("0")));
        assert!(
            ok("streaming_ffmpeg_slots", Some("abc")) && ok("streaming_ffmpeg_slots", Some(""))
        );
        assert!(!ok("streaming_ffmpeg_slots", Some("2.5")));
        assert!(!ok("streaming_ffmpeg_slots", Some("99999999999")));
        assert!(ok("streaming_cache_max_gb", Some("whatever")));
    }
}

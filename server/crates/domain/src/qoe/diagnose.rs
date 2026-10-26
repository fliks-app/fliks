use super::types::*;

pub const MIN_WATCHED_MS: f64 = 60_000.0;
pub const STALLS_PER_10_MIN: f64 = 1.0;
pub const STALL_RATIO: f64 = 0.01;
pub const SERVER_SPEED_FLOOR: f64 = 1.0;
/// Live production is capped at 1x, so its jitter would trip the regular floor.
pub const LIVE_SERVER_SPEED_FLOOR: f64 = 0.9;
pub const STARVED_BUFFER_S: f64 = 1.0;
pub const BANDWIDTH_HEADROOM: f64 = 1.2;
pub const DROPPED_RATIO: f64 = 0.05;
/// Below this many decoded frames a dropped ratio is noise.
pub const MIN_DECODED_FRAMES: f64 = 300.0;

const TEN_MIN_MS: f64 = 600_000.0;

fn result(verdict: Verdict, confidence: Confidence, reasons: &[&str]) -> QoeDiagnosis {
    QoeDiagnosis {
        verdict,
        confidence,
        reasons: reasons.iter().map(|r| format!("qoe.reason.{r}")).collect(),
    }
}

/// A software decoder is a hint on a device verdict, never a verdict by itself (normal below 720p).
fn device(s: &QoeSessionSummary, confidence: Confidence, reason: &str) -> QoeDiagnosis {
    if s.hw_decoder == Some(false) && s.height.unwrap_or(0.0) >= 720.0 {
        result(Verdict::Device, confidence, &[reason, "software_decoder"])
    } else {
        result(Verdict::Device, confidence, &[reason])
    }
}

/// Session reason for each per-stall reason, so the two never tell different stories.
fn stall_reason(key: &str) -> Option<&'static str> {
    Some(match key {
        "qoe.stall.server_wait" => "stalls_server_slow",
        "qoe.stall.network_starved" | "qoe.stall.network_low_throughput" => {
            "stalls_starved_low_throughput"
        }
        "qoe.stall.network_unconfirmed" => "stalls_starved_bandwidth_ok",
        "qoe.stall.device_buffer_ahead" => "stalls_buffer_ahead",
        "qoe.stall.device_dropped_frames" => "dropped_frames",
        "qoe.stall.server_session_lost" => "session_lost",
        "qoe.stall.server_session_expired" => "session_expired",
        _ => return None,
    })
}

fn dominant_reason(s: &QoeSessionSummary, cause: &str, default: &'static str) -> &'static str {
    let prefix = format!("qoe.stall.{cause}_");
    let mut best: Option<&(String, f64)> = None;
    for e in s.stall_reason_ms.iter().flat_map(|r| &r.0) {
        if e.0.starts_with(&prefix) && best.is_none_or(|b| e.1 > b.1) {
            best = Some(e);
        }
    }
    best.and_then(|b| stall_reason(&b.0)).unwrap_or(default)
}

/// The cause holding most of the stalled time; `None` when stalls were not classified or unknown wins.
fn from_causes(s: &QoeSessionSummary) -> Option<QoeDiagnosis> {
    let ms = s.stall_cause_ms.as_ref()?;
    let total = ms.server + ms.network + ms.device + ms.unknown;
    let mut top = (StallCause::Server, ms.server);
    for c in [StallCause::Network, StallCause::Device, StallCause::Unknown] {
        if ms.get(c) > top.1 {
            top = (c, ms.get(c));
        }
    }
    let confidence = if top.1 / total > 0.5 {
        Confidence::High
    } else {
        Confidence::Low
    };
    match top.0 {
        StallCause::Unknown => None,
        StallCause::Device => Some(device(
            s,
            confidence,
            dominant_reason(s, "device", "stalls_buffer_ahead"),
        )),
        StallCause::Server => Some(result(
            Verdict::Server,
            confidence,
            &[dominant_reason(s, "server", "stalls_server_slow")],
        )),
        StallCause::Network => Some(result(
            Verdict::Network,
            confidence,
            &[dominant_reason(
                s,
                "network",
                "stalls_starved_low_throughput",
            )],
        )),
    }
}

/// First matching rule wins.
pub fn diagnose(s: &QoeSessionSummary, live: bool) -> QoeDiagnosis {
    let mut d = decide(s, live);
    // A claim with no CMCD on the wire is a hint, never a verdict.
    if s.cmcd_claimed && !s.cmcd {
        d.reasons.push("qoe.reason.cmcd_missing".into());
    }
    d
}

fn decide(s: &QoeSessionSummary, live: bool) -> QoeDiagnosis {
    if s.unrecovered_error {
        return result(Verdict::Error, Confidence::High, &["fatal_error"]);
    }
    let per_10_min = match s.watched_ms / TEN_MIN_MS {
        0.0 => f64::INFINITY,
        d => d,
    };
    let stalling = s.stall_count > 0.0
        && (s.stall_count / per_10_min >= STALLS_PER_10_MIN
            || s.stall_ms / s.watched_ms.max(1.0) >= STALL_RATIO);
    if stalling {
        if let Some(d) = from_causes(s) {
            return d;
        }
        let floor = if live {
            LIVE_SERVER_SPEED_FLOOR
        } else {
            SERVER_SPEED_FLOOR
        };
        if s.median_transcode_speed.is_some_and(|v| v < floor) {
            return result(Verdict::Server, Confidence::High, &["stalls_server_slow"]);
        }
        // A stall with no buffer report counts as starved, but only at low confidence.
        let buffer = s.stall_buffer_ahead_s;
        if buffer.is_none_or(|b| b < STARVED_BUFFER_S) {
            let tp = s
                .stall_bandwidth_bps
                .or(s.avg_bandwidth_bps)
                .or(s.cmcd_throughput_bps);
            let (Some(tp), Some(bitrate)) = (tp, s.avg_variant_bitrate) else {
                return result(
                    Verdict::Network,
                    Confidence::Low,
                    &["stalls_starved_no_throughput"],
                );
            };
            let conf = if buffer.is_some() {
                Confidence::High
            } else {
                Confidence::Low
            };
            return if tp < BANDWIDTH_HEADROOM * bitrate {
                result(Verdict::Network, conf, &["stalls_starved_low_throughput"])
            } else {
                result(
                    Verdict::Network,
                    Confidence::Low,
                    &["stalls_starved_bandwidth_ok"],
                )
            };
        }
        return device(s, Confidence::High, "stalls_buffer_ahead");
    }

    if let (Some(dropped), Some(decoded)) = (s.dropped_frames, s.decoded_frames)
        && decoded >= MIN_DECODED_FRAMES
        && dropped / decoded >= DROPPED_RATIO
    {
        return device(s, Confidence::High, "dropped_frames");
    }
    let conf = if s.watched_ms >= MIN_WATCHED_MS && (s.sample_count > 0.0 || s.cmcd) {
        Confidence::High
    } else {
        Confidence::Low
    };
    result(Verdict::Ok, conf, &["healthy"])
}

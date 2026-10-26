use super::types::{Engine, EventType, QoeEvent, QoeSample};
use serde_json::{Map, Value};

pub const MAX_EVENTS_PER_REQUEST: usize = 50;
const INT_MAX: f64 = 2147483647.0;
const DAY_MS: f64 = 86_400_000.0;

fn obj(v: &Value) -> Option<&Map<String, Value>> {
    v.as_object()
}

/// Finite number `>= 0`; `-0` becomes `0`.
fn num(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64()?;
    (n.is_finite() && n >= 0.0).then_some(n + 0.0)
}

/// JS `Math.round` on a non-negative value, capped for an int column.
fn int(v: Option<f64>) -> Option<f64> {
    v.map(|n| n.round().min(INT_MAX))
}

fn ms(v: Option<&Value>) -> Option<f64> {
    num(v).map(|n| n.min(DAY_MS))
}

/// NULs removed, truncated to `max` UTF-16 units (whole chars), `None` when empty.
fn text(v: Option<&Value>, max: usize) -> Option<String> {
    let mut out = String::new();
    let mut units = 0;
    for c in v?.as_str()?.chars().filter(|c| *c != '\0') {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    (!out.is_empty()).then_some(out)
}

pub fn parse_playback_id(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    let ok = (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then(|| s.to_owned())
}

pub fn parse_sent_at(v: &Value) -> Option<f64> {
    num(Some(v))
}

/// A heartbeat `qoe` block with unknown fields dropped; `None` when unusable.
pub fn parse_sample(raw: &Value) -> Option<QoeSample> {
    let o = obj(raw)?;
    let engine = Engine::parse(o.get("engine")?.as_str()?)?;
    let g = |k: &str| o.get(k);
    Some(QoeSample {
        engine,
        cmcd: g("cmcd") == Some(&Value::Bool(true)),
        dropped_frames: int(num(g("droppedFrames"))),
        decoded_frames: int(num(g("decodedFrames"))),
        bandwidth_bps: num(g("bandwidthBps")),
        buffer_ahead_s: num(g("bufferAheadS")),
        variant_bitrate: num(g("variantBitrate")),
        width: int(num(g("width"))),
        height: int(num(g("height"))),
        video_codec: text(g("videoCodec"), 64),
        decoder_name: text(g("decoderName"), 128),
        hw_decoder: g("hwDecoder").and_then(Value::as_bool),
        stall_count: int(num(g("stallCount"))).unwrap_or(0.0),
        stall_ms: int(ms(g("stallMs"))).unwrap_or(0.0),
        recovery_reloads: int(num(g("recoveryReloads"))).unwrap_or(0.0),
        playback_id: g("playbackId").and_then(parse_playback_id),
    })
}

fn event_type(s: &str) -> Option<EventType> {
    serde_json::from_value(s.into()).ok()
}

fn reason(o: &Map<String, Value>, allowed: &[&str]) -> String {
    match o.get("reason").and_then(Value::as_str) {
        Some(r) if allowed.contains(&r) => r.to_owned(),
        _ => "other".to_owned(),
    }
}

/// Valid events of a request body (at most 50), timestamps shifted by the client clock skew.
pub fn parse_events(raw: &Value, now: f64, sent_at: Option<f64>) -> Vec<QoeEvent> {
    let Some(items) = raw.as_array() else {
        return vec![];
    };
    let skew = match sent_at {
        Some(s) if (now - s).abs() <= DAY_MS => now - s,
        _ => 0.0,
    };
    let mut out = vec![];
    for e in items.iter().take(MAX_EVENTS_PER_REQUEST) {
        let Some(o) = obj(e) else { continue };
        let Some(kind) = o.get("type").and_then(Value::as_str).and_then(event_type) else {
            continue;
        };
        let g = |k: &str| o.get(k);
        let client_at = num(g("at")).map(|a| a + skew);
        let mut ev = QoeEvent {
            kind,
            at: client_at
                .filter(|a| (a - now).abs() <= DAY_MS)
                .unwrap_or(now),
            position: num(g("position")),
            duration_ms: ms(g("durationMs")),
            buffer_ahead_s: num(g("bufferAheadS")),
            bandwidth_bps: num(g("bandwidthBps")),
            code: g("code").and_then(Value::as_f64).filter(|c| c.is_finite()),
            message: text(g("message"), 300),
            category: text(g("category"), 64),
            from_bitrate: num(g("fromBitrate")),
            to_bitrate: num(g("toBitrate")),
            variant_bitrate: num(g("variantBitrate")),
            reason: None,
            from: None,
            to: None,
        };
        match kind {
            EventType::Recovery => {
                ev.reason = Some(reason(
                    o,
                    &["session_lost", "session_expired", "stall", "other"],
                ));
            }
            EventType::Reload => {
                let r = ["audio", "subtitles", "quality", "remux_fallback", "audio_fallback", "other"];
                ev.reason = Some(reason(o, &r));
                ev.from = text(g("from"), 80);
                ev.to = text(g("to"), 80);
            }
            _ => {}
        }
        out.push(ev);
    }
    out
}

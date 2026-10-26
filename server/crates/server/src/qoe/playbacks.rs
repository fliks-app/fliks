//! Playbacks: a user's sessions sharing a playbackId, merged and re-diagnosed (`qoe.md` rules 24-27).
use super::store::{QoeRow, SummaryRow};
use fliks_domain::qoe::{
    CauseMs, Engine, QoeDiagnosis, QoeSessionSummary, ReasonMs, diagnose, merge_summaries,
};
use serde_json::{Map, Value, json, to_value};
use std::collections::HashMap;

const DROPPED_KEYS: [&str; 7] = [
    "stallBufferAheadS",
    "stallBandwidthBps",
    "cmcdThroughputBps",
    "unrecoveredError",
    "sampleCount",
    "stallCauseMs",
    "stallReasonMs",
];
const MERGED_KEYS: [&str; 19] = [
    "engine",
    "cmcd",
    "cmcdClaimed",
    "videoCodec",
    "width",
    "height",
    "decoderName",
    "hwDecoder",
    "watchedMs",
    "stallCount",
    "stallMs",
    "droppedFrames",
    "decodedFrames",
    "avgBandwidthBps",
    "minBandwidthBps",
    "avgVariantBitrate",
    "recoveryReloads",
    "errorCount",
    "medianTranscodeSpeed",
];
const VERDICTS: [&str; 5] = ["ok", "network", "device", "server", "error"];

pub fn is_verdict(v: &str) -> bool {
    VERDICTS.contains(&v)
}

pub fn key(r: &QoeRow) -> String {
    match (r.userId, &r.playbackId) {
        (Some(u), Some(p)) => format!("{u}:{p}"),
        _ => r.sessionId.clone(),
    }
}

fn f(v: Option<i32>) -> Option<f64> {
    v.map(f64::from)
}

fn summary_of(r: &QoeRow) -> QoeSessionSummary {
    QoeSessionSummary {
        engine: r.engine.as_deref().and_then(Engine::parse),
        cmcd: r.cmcd,
        cmcd_claimed: r.cmcdClaimed,
        video_codec: r.videoCodec.clone(),
        width: f(r.width),
        height: f(r.height),
        decoder_name: r.decoderName.clone(),
        hw_decoder: r.hwDecoder,
        watched_ms: f64::from(r.watchedMs),
        stall_count: f64::from(r.stallCount),
        stall_ms: f64::from(r.stallMs),
        dropped_frames: f(r.droppedFrames),
        decoded_frames: f(r.decodedFrames),
        recovery_reloads: f64::from(r.recoveryReloads),
        error_count: f64::from(r.errorCount),
        unrecovered_error: r.unrecoveredError,
        bandwidth_bps: None,
        variant_bitrate: None,
        buffer_ahead_s: None,
        avg_bandwidth_bps: r.avgBandwidthBps,
        min_bandwidth_bps: r.minBandwidthBps,
        avg_variant_bitrate: r.avgVariantBitrate,
        stall_buffer_ahead_s: r.stallBufferAheadS,
        stall_bandwidth_bps: r.stallBandwidthBps,
        cmcd_throughput_bps: r.cmcdThroughputBps,
        median_transcode_speed: r.medianTranscodeSpeed,
        sample_count: f64::from(r.sampleCount),
        stall_cause_ms: r
            .stallCauseMs
            .clone()
            .and_then(|v| serde_json::from_value::<CauseMs>(v).ok()),
        stall_reason_ms: r
            .stallReasonMs
            .clone()
            .and_then(|v| serde_json::from_value::<ReasonMs>(v).ok()),
    }
}

pub struct Playback {
    /// The latest row, with the group's first start and last sighting.
    pub row: QoeRow,
    pub session_ids: Vec<String>,
    pub merged: QoeSessionSummary,
    pub diag: QoeDiagnosis,
}

/// Newest playback first.
pub fn merge_playbacks(rows: Vec<QoeRow>) -> Vec<Playback> {
    let mut order: Vec<String> = vec![];
    let mut groups: HashMap<String, Vec<QoeRow>> = HashMap::new();
    for r in rows {
        let k = key(&r);
        groups
            .entry(k.clone())
            .or_insert_with(|| {
                order.push(k);
                vec![]
            })
            .push(r);
    }
    let mut out: Vec<Playback> = order
        .into_iter()
        .map(|k| {
            let mut g = groups.remove(&k).unwrap_or_default();
            g.sort_by_key(|r| r.startedAt);
            let merged = merge_summaries(&g.iter().map(summary_of).collect::<Vec<_>>())
                .expect("a group has a row");
            let started = g[0].startedAt;
            let seen = g.iter().map(|r| r.lastSeenAt).max().unwrap_or(started);
            let session_ids = g.iter().map(|r| r.sessionId.clone()).collect();
            let mut row = g.pop().expect("a group has a row");
            let diag = diagnose(&merged, row.playMethod.as_deref() == Some("live"));
            (row.startedAt, row.lastSeenAt) = (started, seen);
            Playback {
                row,
                session_ids,
                merged,
                diag,
            }
        })
        .collect();
    out.sort_by_key(|p| std::cmp::Reverse(p.row.lastSeenAt));
    out
}

impl Playback {
    pub fn to_json(&self) -> Value {
        let mut v = to_value(&self.row).expect("row");
        let merged = to_value(&self.merged).expect("summary");
        let o = v.as_object_mut().expect("object");
        for k in DROPPED_KEYS {
            o.remove(k);
        }
        for k in MERGED_KEYS {
            o.insert(k.into(), merged[k].clone());
        }
        o.insert("sessionIds".into(), json!(self.session_ids));
        o.insert(
            "verdict".into(),
            to_value(self.diag.verdict).expect("verdict"),
        );
        o.insert(
            "confidence".into(),
            to_value(self.diag.confidence).expect("confidence"),
        );
        o.insert("reasons".into(), json!(self.diag.reasons));
        v
    }
}

fn dropped_pct(r: &SummaryRow) -> Option<f64> {
    match (r.dropped, r.decoded) {
        (Some(d), Some(n)) if n != 0 => Some(d as f64 / n as f64 * 100.0),
        _ => None,
    }
}

/// `rows` are the playbacks, newest first.
pub fn summary(rows: &[SummaryRow]) -> Value {
    let mut by_verdict: Map<String, Value> =
        VERDICTS.iter().map(|v| ((*v).into(), json!(0))).collect();
    let mut order: Vec<(String, String)> = vec![];
    let mut groups: HashMap<(String, String), Vec<&SummaryRow>> = HashMap::new();
    for r in rows {
        let v = r.verdict.clone().unwrap_or_default();
        if let Some(n) = by_verdict.get_mut(&v) {
            *n = json!(n.as_i64().unwrap_or(0) + 1);
        }
        let k = (
            r.device.clone().unwrap_or_default(),
            r.engine.clone().unwrap_or_default(),
        );
        groups
            .entry(k.clone())
            .or_insert_with(|| {
                order.push(k);
                vec![]
            })
            .push(r);
    }
    let mut devices: Vec<(usize, Value)> = order
        .into_iter()
        .map(|k| {
            let g = &groups[&k];
            let pcts: Vec<f64> = g.iter().filter_map(|r| dropped_pct(r)).collect();
            let hw: Vec<bool> = g.iter().filter_map(|r| r.hw).collect();
            let mut counts: Vec<(String, usize)> = vec![];
            for r in g {
                let v = r.verdict.clone().unwrap_or_default();
                match counts.iter_mut().find(|(n, _)| *n == v) {
                    Some((_, c)) => *c += 1,
                    None => counts.push((v, 1)),
                }
            }
            counts.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
            let top = counts.first().map(|(v, _)| v.clone());
            let first = g[0];
            (
                g.len(),
                json!({
                    "device": first.device,
                    "systemName": first.system_name,
                    "engine": first.engine,
                    "sessions": g.len(),
                    "stallSessions": g.iter().filter(|r| r.stalls.unwrap_or(0) > 0).count(),
                    "avgDroppedPct": (!pcts.is_empty()).then(|| pcts.iter().sum::<f64>() / pcts.len() as f64),
                    "hwDecoderPct": (!hw.is_empty())
                        .then(|| hw.iter().filter(|h| **h).count() as f64 / hw.len() as f64 * 100.0),
                    "topVerdict": top,
                }),
            )
        })
        .collect();
    devices.sort_by_key(|(n, _)| std::cmp::Reverse(*n));
    let by_device: Vec<Value> = devices.into_iter().map(|(_, v)| v).collect();
    json!({"byVerdict": by_verdict, "byDevice": by_device})
}

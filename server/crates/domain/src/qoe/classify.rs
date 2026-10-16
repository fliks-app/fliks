use super::diagnose::{LIVE_SERVER_SPEED_FLOOR, SERVER_SPEED_FLOOR};
use super::types::*;
use std::collections::BTreeMap;

/// Client and server clocks may differ; a match that needs this slack is low confidence.
pub const SKEW_MARGIN_MS: f64 = 5000.0;
pub const SERVER_WAIT_MS: f64 = 1000.0;
pub const STARVED_S: f64 = 1.0;
pub const HEADROOM: f64 = 1.2;
pub const DROPPED_BURST_RATIO: f64 = 0.1;
/// Below this many decoded frames between two samples a ratio is noise.
pub const MIN_BURST_FRAMES: f64 = 30.0;

type Evidence = BTreeMap<String, f64>;

fn speed_of(s: &StallSegment) -> f64 {
    s.segment_duration_s * 1000.0 / s.waited_ms.unwrap_or(1.0).max(1.0)
}

/// The slowest segment overlapping `[lo, hi]` if it explains a stall; live is judged by speed only.
fn server_hit(segments: &[StallSegment], lo: f64, hi: f64, live: bool) -> Option<(f64, f64)> {
    let hits: Vec<(&StallSegment, f64)> = segments
        .iter()
        .filter_map(|s| {
            let w = s.waited_ms?;
            (s.at >= lo && s.at - w <= hi).then_some((s, w))
        })
        .collect();
    let mut worst = *hits.first()?;
    for h in &hits[1..] {
        if h.1 > worst.1 {
            worst = *h;
        }
    }
    let mut speeds: Vec<f64> = hits.iter().map(|(s, _)| speed_of(s)).collect();
    speeds.sort_by(f64::total_cmp);
    let floor = if live {
        LIVE_SERVER_SPEED_FLOOR
    } else {
        SERVER_SPEED_FLOOR
    };
    let slow = speeds[speeds.len() >> 1] < floor;
    ((!live && worst.1 > SERVER_WAIT_MS) || slow).then(|| (worst.1, speed_of(worst.0)))
}

/// Facts that make a slow transcode plausible; they never change the decision.
fn server_hints(ctx: &StallContext, evidence: &mut Evidence) -> Vec<String> {
    let mut hints = vec![];
    if let Some(p) = &ctx.pipeline {
        if p.encode.as_ref().is_some_and(|e| !e.hw) {
            hints.push("software_encode");
        }
        if p.burn_in.as_deref().is_some_and(|b| !b.is_empty()) {
            hints.push("burn_in");
        }
        if p.tonemap.as_deref() == Some("cpu") {
            hints.push("cpu_tonemap");
        }
    }
    let busy = ctx.load.as_ref().map_or(0, |l| l.active_transcodes);
    if busy >= 2 {
        hints.push("busy");
        evidence.insert("activeTranscodes".into(), busy.into());
    }
    hints
        .into_iter()
        .map(|h| format!("qoe.stall.hint_{h}"))
        .collect()
}

fn dropped_burst(start: f64, ctx: &StallContext) -> Option<f64> {
    let before = ctx.samples.iter().rev().find(|s| s.at <= start)?;
    let after = ctx.samples.last()?;
    if after.at <= before.at {
        return None;
    }
    let decoded = after.decoded_frames? - before.decoded_frames?;
    let dropped = after.dropped_frames? - before.dropped_frames?;
    (decoded >= MIN_BURST_FRAMES && dropped >= 0.0).then(|| dropped / decoded)
}

/// Why one stall happened; the first matching rule wins.
pub fn classify_stall(stall: &StallInput, ctx: &StallContext) -> StallClassification {
    let start = stall.at - stall.duration_ms.unwrap_or(0.0);
    let buffer = stall.buffer_ahead_s.or(ctx.buffer_ahead_s);
    let bandwidth = stall.bandwidth_bps.or(ctx.bandwidth_bps);
    let bitrate = stall.variant_bitrate.or(ctx.variant_bitrate);
    let mut evidence = Evidence::new();
    for (k, v) in [
        ("bufferAheadS", buffer),
        ("bandwidthBps", bandwidth),
        ("variantBitrate", bitrate),
    ] {
        if let Some(v) = v {
            evidence.insert(k.into(), v);
        }
    }

    let strict = server_hit(&ctx.segments, start, stall.at, ctx.live);
    let wide = match strict {
        Some(_) => None,
        None => server_hit(
            &ctx.segments,
            start - SKEW_MARGIN_MS,
            stall.at + SKEW_MARGIN_MS,
            ctx.live,
        ),
    };
    // A wait with data buffered is ffmpeg paused ahead of the client, not a starved one.
    if let Some((waited, speed)) = strict.or(wide)
        && buffer.is_none_or(|b| b < STARVED_S)
    {
        evidence.insert("waitedMs".into(), waited);
        evidence.insert("transcodeSpeed".into(), speed);
        let conf = if strict.is_some() {
            Confidence::High
        } else {
            Confidence::Low
        };
        let hints = server_hints(ctx, &mut evidence);
        return StallClassification {
            cause: StallCause::Server,
            confidence: conf,
            reason: "qoe.stall.server_wait".into(),
            evidence,
            hints,
        };
    }

    let starved = buffer.is_some_and(|b| b < STARVED_S);
    let low_throughput = matches!((bandwidth, bitrate), (Some(bw), Some(br)) if bw < HEADROOM * br);
    let burst = dropped_burst(start, ctx).filter(|b| *b >= DROPPED_BURST_RATIO);
    let (cause, confidence, reason) = if starved && low_throughput {
        (StallCause::Network, Confidence::High, "network_starved")
    } else if let Some(b) = burst {
        evidence.insert("droppedPct".into(), b * 100.0);
        let c = if starved {
            Confidence::Low
        } else {
            Confidence::High
        };
        (StallCause::Device, c, "device_dropped_frames")
    } else if buffer.is_some() && !starved {
        (StallCause::Device, Confidence::High, "device_buffer_ahead")
    } else if starved {
        (StallCause::Network, Confidence::Low, "network_unconfirmed")
    } else if low_throughput {
        (
            StallCause::Network,
            Confidence::Low,
            "network_low_throughput",
        )
    } else {
        (StallCause::Unknown, Confidence::Low, "unknown")
    };
    StallClassification {
        cause,
        confidence,
        reason: format!("qoe.stall.{reason}"),
        evidence,
        hints: vec![],
    }
}

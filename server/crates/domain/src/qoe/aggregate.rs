use super::classify::classify_stall;
use super::cmcd::CmcdSnapshot;
use super::types::*;
use serde::{Deserialize, Serialize};

/// Longest gap between two samples still counted as watched time (3 missed beats).
const MAX_WATCH_GAP_MS: f64 = 30_000.0;
const MIN_SPEED_SAMPLES: usize = 3;
/// A sample this fresh still describes the buffer at a stall reported without one.
const MAX_SAMPLE_AGE_MS: f64 = 15_000.0;
const MAX_KEPT: usize = 200;
const MAX_SEGMENTS: usize = 300;
const MAX_SAMPLES: usize = 20;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StallLast {
    pub at: f64,
    pub duration_ms: f64,
    pub cause: StallCause,
    pub reason: String,
}

/// A cumulative counter that restarts from zero when the engine reloads.
#[derive(Default)]
struct ResettingCounter {
    base: f64,
    last: Option<f64>,
}

impl ResettingCounter {
    fn add(&mut self, v: Option<f64>) {
        let Some(v) = v else { return };
        if let Some(l) = self.last
            && v < l
        {
            self.base += l;
        }
        self.last = Some(v);
    }

    fn total(&self) -> Option<f64> {
        self.last.map(|l| self.base + l)
    }
}

fn median(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let mut s = xs.to_vec();
    s.sort_by(f64::total_cmp);
    let m = s.len() >> 1;
    Some(if s.len() % 2 == 1 {
        s[m]
    } else {
        (s[m - 1] + s[m]) / 2.0
    })
}

fn avg(xs: &[f64]) -> Option<f64> {
    (!xs.is_empty()).then(|| xs.iter().sum::<f64>() / xs.len() as f64)
}

fn push<T>(xs: &mut Vec<T>, v: T, cap: usize) {
    xs.push(v);
    if xs.len() > cap {
        xs.remove(0);
    }
}

/// Folds samples, events, segment metrics and CMCD reports into one session summary.
#[derive(Default)]
pub struct QoeAggregator {
    engine: Option<Engine>,
    cmcd_seen: bool,
    cmcd_claimed: bool,
    cmcd_buffer: Option<f64>,
    cmcd_buffer_at: Option<f64>,
    video_codec: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
    decoder_name: Option<String>,
    hw_decoder: Option<bool>,
    watched_ms: f64,
    last_sample_at: Option<f64>,
    sample_count: f64,
    dropped: ResettingCounter,
    decoded: ResettingCounter,
    stalls: ResettingCounter,
    stall_ms: ResettingCounter,
    reloads: ResettingCounter,
    bandwidth: Option<f64>,
    variant_bitrate: Option<f64>,
    buffer_ahead: Option<f64>,
    bandwidths: Vec<f64>,
    variant_bitrates: Vec<f64>,
    min_bandwidth: Option<f64>,
    buffer_ahead_at: Option<f64>,
    stall_buffers: Vec<f64>,
    stall_bandwidths: Vec<f64>,
    cmcd_mtp: Vec<f64>,
    speeds: Vec<f64>,
    segments: Vec<StallSegment>,
    samples: Vec<StallSample>,
    cmcd_bandwidth: Option<f64>,
    cause_ms: Option<CauseMs>,
    reason_ms: Option<ReasonMs>,
    last: Option<StallLast>,
    pipeline: Option<QoePipeline>,
    error_count: f64,
    /// An error with no recovery or sample after it, in arrival order.
    error_open: bool,
}

impl QoeAggregator {
    pub fn new() -> Self {
        Self::default()
    }

    /// `playing`: the session is not paused, so the gap since the last sample is watched time.
    pub fn add_sample(&mut self, s: &QoeSample, now: f64, playing: bool) {
        if let Some(l) = self.last_sample_at
            && playing
        {
            self.watched_ms += (now - l).min(MAX_WATCH_GAP_MS);
        }
        self.last_sample_at = Some(now);
        self.error_open = false;
        self.sample_count += 1.0;
        self.engine = Some(s.engine);
        self.cmcd_claimed |= s.cmcd;
        let sample = StallSample {
            at: now,
            dropped_frames: s.dropped_frames,
            decoded_frames: s.decoded_frames,
        };
        push(&mut self.samples, sample, MAX_SAMPLES);
        self.dropped.add(s.dropped_frames);
        self.decoded.add(s.decoded_frames);
        self.stalls.add(Some(s.stall_count));
        self.stall_ms.add(Some(s.stall_ms));
        self.reloads.add(Some(s.recovery_reloads));
        if s.video_codec.is_some() {
            self.video_codec.clone_from(&s.video_codec);
        }
        self.width = s.width.or(self.width);
        self.height = s.height.or(self.height);
        if s.decoder_name.is_some() {
            self.decoder_name.clone_from(&s.decoder_name);
        }
        self.hw_decoder = s.hw_decoder.or(self.hw_decoder);
        if let Some(b) = s.bandwidth_bps {
            self.bandwidth = Some(b);
            push(&mut self.bandwidths, b, MAX_KEPT);
            self.min_bandwidth = Some(self.min_bandwidth.map_or(b, |m| m.min(b)));
        }
        if let Some(v) = s.variant_bitrate {
            self.variant_bitrate = Some(v);
            push(&mut self.variant_bitrates, v, MAX_KEPT);
        }
        if let Some(b) = s.buffer_ahead_s {
            self.buffer_ahead = Some(b);
            self.buffer_ahead_at = Some(now);
        }
    }

    /// A stall (or a recovery that froze the picture) comes back classified from what the server knows now.
    pub fn add_event(
        &mut self,
        e: &QoeEvent,
        now: f64,
        live: bool,
        load: Option<&ServerLoad>,
    ) -> Option<StallClassification> {
        let mut classified = None;
        let recovery_wait = e.kind == EventType::Recovery && e.duration_ms.unwrap_or(0.0) > 0.0;
        if e.kind == EventType::Stall || recovery_wait {
            let fresh = |at: Option<f64>| at.is_some_and(|a| now - a <= MAX_SAMPLE_AGE_MS);
            let buffer = e
                .buffer_ahead_s
                .or(fresh(self.buffer_ahead_at)
                    .then_some(self.buffer_ahead)
                    .flatten())
                .or(fresh(self.cmcd_buffer_at)
                    .then_some(self.cmcd_buffer)
                    .flatten());
            if let Some(b) = buffer {
                push(&mut self.stall_buffers, b, MAX_KEPT);
            }
            if let Some(b) = e.bandwidth_bps {
                push(&mut self.stall_bandwidths, b, MAX_KEPT);
            }
            if recovery_wait {
                classified = recovery_cause(e);
            }
            let c = classified.get_or_insert_with(|| {
                let ctx = StallContext {
                    live,
                    load: load.cloned(),
                    pipeline: self.pipeline.clone(),
                    segments: self.segments.clone(),
                    samples: self.samples.clone(),
                    buffer_ahead_s: buffer,
                    bandwidth_bps: self.bandwidth.or(self.cmcd_bandwidth),
                    variant_bitrate: self.variant_bitrate,
                };
                classify_stall(&e.into(), &ctx)
            });
            // A low-confidence cause counts half, so a sure one outweighs a guess.
            let half = if c.confidence == Confidence::Low {
                0.5
            } else {
                1.0
            };
            let w = e.duration_ms.unwrap_or(0.0).max(1.0) * half;
            *self.cause_ms.get_or_insert_default().get_mut(c.cause) += w;
            self.reason_ms.get_or_insert_default().add(&c.reason, w);
            self.last = Some(StallLast {
                at: e.at,
                duration_ms: e.duration_ms.unwrap_or(0.0),
                cause: c.cause,
                reason: c.reason.clone(),
            });
        }
        match e.kind {
            EventType::Error => {
                self.error_count += 1.0;
                self.error_open = true;
            }
            EventType::Recovery => self.error_open = false,
            _ => {}
        }
        classified
    }

    pub fn set_pipeline(&mut self, p: Option<QoePipeline>) {
        self.pipeline = p;
    }

    pub fn pipeline(&self) -> Option<&QoePipeline> {
        self.pipeline.as_ref()
    }

    pub fn last_stall(&self) -> Option<&StallLast> {
        self.last.as_ref()
    }

    pub fn add_segment(&mut self, duration_s: f64, waited_ms: Option<f64>, now: f64) {
        let seg = StallSegment {
            at: now,
            segment_duration_s: duration_s,
            waited_ms,
        };
        push(&mut self.segments, seg, MAX_SEGMENTS);
        if let Some(w) = waited_ms
            && duration_s > 0.0
        {
            push(&mut self.speeds, duration_s * 1000.0 / w.max(1.0), MAX_KEPT);
        }
    }

    pub fn add_cmcd(&mut self, c: &CmcdSnapshot, now: f64) {
        self.cmcd_seen = true;
        // Audio buffers run deeper than video: only video or muxed objects say anything about a stall.
        if let Some(bl) = c.bl
            && c.ot.as_deref() != Some("a")
        {
            self.cmcd_buffer = Some(bl / 1000.0);
            self.cmcd_buffer_at = Some(now);
        }
        if let Some(mtp) = c.mtp {
            push(&mut self.cmcd_mtp, mtp * 1000.0, MAX_KEPT);
            self.cmcd_bandwidth = Some(mtp * 1000.0);
        }
        if let Some(br) = c.br
            && self.variant_bitrates.is_empty()
        {
            self.variant_bitrate = Some(br * 1000.0);
        }
    }

    pub fn summary(&self) -> QoeSessionSummary {
        QoeSessionSummary {
            engine: self.engine,
            cmcd: self.cmcd_seen,
            cmcd_claimed: self.cmcd_claimed,
            video_codec: self.video_codec.clone(),
            width: self.width,
            height: self.height,
            decoder_name: self.decoder_name.clone(),
            hw_decoder: self.hw_decoder,
            watched_ms: self.watched_ms,
            stall_count: self.stalls.total().unwrap_or(0.0),
            stall_ms: self.stall_ms.total().unwrap_or(0.0),
            dropped_frames: self.dropped.total(),
            decoded_frames: self.decoded.total(),
            recovery_reloads: self.reloads.total().unwrap_or(0.0),
            error_count: self.error_count,
            unrecovered_error: self.error_open,
            bandwidth_bps: self.bandwidth,
            variant_bitrate: self.variant_bitrate,
            buffer_ahead_s: self.buffer_ahead,
            avg_bandwidth_bps: avg(&self.bandwidths),
            min_bandwidth_bps: self.min_bandwidth,
            avg_variant_bitrate: avg(&self.variant_bitrates).or(self.variant_bitrate),
            stall_buffer_ahead_s: median(&self.stall_buffers),
            stall_bandwidth_bps: median(&self.stall_bandwidths),
            cmcd_throughput_bps: avg(&self.cmcd_mtp),
            median_transcode_speed: if self.speeds.len() >= MIN_SPEED_SAMPLES {
                median(&self.speeds)
            } else {
                None
            },
            sample_count: self.sample_count,
            stall_cause_ms: self.cause_ms.clone(),
            stall_reason_ms: self.reason_ms.clone(),
        }
    }
}

fn weighted(
    parts: &[QoeSessionSummary],
    pick: impl Fn(&QoeSessionSummary) -> Option<f64>,
    weight: impl Fn(&QoeSessionSummary) -> f64,
) -> Option<f64> {
    let (mut sum, mut w) = (0.0, 0.0);
    for p in parts {
        let Some(v) = pick(p) else { continue };
        let k = weight(p).max(1.0);
        sum += v * k;
        w += k;
    }
    (w != 0.0).then(|| sum / w)
}

/// One viewing split over several sids, `parts` oldest first: counters add, rates weigh by watch time.
pub fn merge_summaries(parts: &[QoeSessionSummary]) -> Option<QoeSessionSummary> {
    let last = parts.last()?;
    if parts.len() == 1 {
        return Some(last.clone());
    }
    let total = |f: fn(&QoeSessionSummary) -> f64| parts.iter().map(f).sum::<f64>();
    let by_watch = |s: &QoeSessionSummary| s.watched_ms;
    let by_stalls = |s: &QoeSessionSummary| s.stall_count;
    let both: Vec<_> = parts
        .iter()
        .filter_map(|p| Some((p.dropped_frames?, p.decoded_frames?)))
        .collect();
    let frames = |i: fn(&(f64, f64)) -> f64| (!both.is_empty()).then(|| both.iter().map(i).sum());
    let causes: Vec<&CauseMs> = parts
        .iter()
        .filter_map(|p| p.stall_cause_ms.as_ref())
        .collect();
    let cause_ms = (!causes.is_empty()).then(|| {
        let sum = |f: fn(&CauseMs) -> f64| causes.iter().map(|c| f(c)).sum();
        CauseMs {
            server: sum(|c| c.server),
            network: sum(|c| c.network),
            device: sum(|c| c.device),
            unknown: sum(|c| c.unknown),
        }
    });
    let mut reasons = ReasonMs::default();
    for (k, v) in parts
        .iter()
        .filter_map(|p| p.stall_reason_ms.as_ref())
        .flat_map(|r| &r.0)
    {
        reasons.add(k, *v);
    }
    Some(QoeSessionSummary {
        engine: parts.iter().rev().find_map(|p| p.engine),
        cmcd: parts.iter().any(|p| p.cmcd),
        cmcd_claimed: parts.iter().any(|p| p.cmcd_claimed),
        video_codec: parts.iter().rev().find_map(|p| p.video_codec.clone()),
        width: parts.iter().rev().find_map(|p| p.width),
        height: parts.iter().rev().find_map(|p| p.height),
        decoder_name: parts.iter().rev().find_map(|p| p.decoder_name.clone()),
        hw_decoder: parts.iter().rev().find_map(|p| p.hw_decoder),
        watched_ms: total(|p| p.watched_ms),
        stall_count: total(|p| p.stall_count),
        stall_ms: total(|p| p.stall_ms),
        dropped_frames: frames(|b| b.0),
        decoded_frames: frames(|b| b.1),
        recovery_reloads: total(|p| p.recovery_reloads),
        error_count: total(|p| p.error_count),
        // A later sid means the viewing carried on after the error.
        unrecovered_error: last.unrecovered_error,
        bandwidth_bps: last.bandwidth_bps,
        variant_bitrate: last.variant_bitrate,
        buffer_ahead_s: last.buffer_ahead_s,
        avg_bandwidth_bps: weighted(parts, |p| p.avg_bandwidth_bps, by_watch),
        min_bandwidth_bps: parts
            .iter()
            .filter_map(|p| p.min_bandwidth_bps)
            .reduce(f64::min),
        avg_variant_bitrate: weighted(parts, |p| p.avg_variant_bitrate, by_watch),
        stall_buffer_ahead_s: weighted(parts, |p| p.stall_buffer_ahead_s, by_stalls),
        stall_bandwidth_bps: weighted(parts, |p| p.stall_bandwidth_bps, by_stalls),
        cmcd_throughput_bps: weighted(parts, |p| p.cmcd_throughput_bps, by_watch),
        median_transcode_speed: weighted(parts, |p| p.median_transcode_speed, by_watch),
        sample_count: total(|p| p.sample_count),
        stall_cause_ms: cause_ms,
        stall_reason_ms: (!reasons.0.is_empty()).then_some(reasons),
    })
}

/// Recoveries the server explains itself (session forgotten or refused); a frozen picture is a stall.
fn recovery_cause(e: &QoeEvent) -> Option<StallClassification> {
    let (confidence, reason) = match e.reason.as_deref()? {
        "session_lost" => (Confidence::High, "qoe.stall.server_session_lost"),
        "session_expired" => (Confidence::Low, "qoe.stall.server_session_expired"),
        _ => return None,
    };
    Some(StallClassification {
        cause: StallCause::Server,
        confidence,
        reason: reason.into(),
        evidence: Default::default(),
        hints: vec![],
    })
}

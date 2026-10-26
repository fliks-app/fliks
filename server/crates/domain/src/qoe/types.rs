use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Shaka,
    Exoplayer,
    Avplayer,
    Mpv,
    Avplay,
    Webos,
    Cast,
}

impl Engine {
    pub fn parse(s: &str) -> Option<Self> {
        serde_json::from_value(s.into()).ok()
    }
}

/// Client heartbeat sample; counters are cumulative since the engine's last load.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QoeSample {
    pub engine: Engine,
    pub cmcd: bool,
    pub dropped_frames: Option<f64>,
    pub decoded_frames: Option<f64>,
    pub bandwidth_bps: Option<f64>,
    pub buffer_ahead_s: Option<f64>,
    pub variant_bitrate: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub video_codec: Option<String>,
    pub decoder_name: Option<String>,
    pub hw_decoder: Option<bool>,
    pub stall_count: f64,
    pub stall_ms: f64,
    pub recovery_reloads: f64,
    #[serde(default)]
    pub playback_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    Stall,
    Error,
    Recovery,
    QualitySwitch,
    Reload,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QoeEvent {
    #[serde(rename = "type")]
    pub kind: EventType,
    /// Epoch ms, client clock.
    pub at: f64,
    /// Always serialized (null allowed).
    #[serde(default)]
    pub position: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub buffer_ahead_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bandwidth_bps: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_bitrate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_bitrate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant_bitrate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StallCause {
    Server,
    Network,
    Device,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Low,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StallClassification {
    pub cause: StallCause,
    pub confidence: Confidence,
    /// i18n key, `qoe.stall.*`.
    pub reason: String,
    pub evidence: BTreeMap<String, f64>,
    /// i18n keys, `qoe.stall.hint_*`.
    pub hints: Vec<String>,
}

/// The `name` key is absent, null or a string, and round-trips as such.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PipelineStage {
    pub hw: bool,
    pub kind: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::js::present"
    )]
    pub name: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PipelineSource {
    pub codec: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub hdr: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PipelineOutput {
    pub codec: Option<String>,
    pub hdr: Option<String>,
    pub quality: Option<String>,
    pub bitrate: Option<f64>,
    pub requested: Option<String>,
}

/// What the server does to the stream of one session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QoePipeline {
    pub source: Option<PipelineSource>,
    pub output: Option<PipelineOutput>,
    pub decode: Option<PipelineStage>,
    pub encode: Option<PipelineStage>,
    pub tonemap: Option<String>,
    pub burn_in: Option<String>,
    pub crop: Option<bool>,
    pub audio_transcode: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerLoad {
    pub active_transcodes: u32,
    pub active_sessions: u32,
    pub load_avg1: Option<f64>,
    pub cpu_count: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StallSegment {
    pub at: f64,
    pub segment_duration_s: f64,
    pub waited_ms: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StallSample {
    pub at: f64,
    pub dropped_frames: Option<f64>,
    pub decoded_frames: Option<f64>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StallContext {
    pub live: bool,
    pub pipeline: Option<QoePipeline>,
    pub load: Option<ServerLoad>,
    pub segments: Vec<StallSegment>,
    pub samples: Vec<StallSample>,
    pub buffer_ahead_s: Option<f64>,
    pub bandwidth_bps: Option<f64>,
    pub variant_bitrate: Option<f64>,
}

/// The fields of an event that classification reads.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StallInput {
    pub at: f64,
    pub duration_ms: Option<f64>,
    pub buffer_ahead_s: Option<f64>,
    pub bandwidth_bps: Option<f64>,
    pub variant_bitrate: Option<f64>,
}

impl From<&QoeEvent> for StallInput {
    fn from(e: &QoeEvent) -> Self {
        Self {
            at: e.at,
            duration_ms: e.duration_ms,
            buffer_ahead_s: e.buffer_ahead_s,
            bandwidth_bps: e.bandwidth_bps,
            variant_bitrate: e.variant_bitrate,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Ok,
    Network,
    Device,
    Server,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct QoeDiagnosis {
    pub verdict: Verdict,
    pub confidence: Confidence,
    /// i18n keys, `qoe.reason.*`.
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CauseMs {
    pub server: f64,
    pub network: f64,
    pub device: f64,
    pub unknown: f64,
}

impl CauseMs {
    pub fn get(&self, c: StallCause) -> f64 {
        match c {
            StallCause::Server => self.server,
            StallCause::Network => self.network,
            StallCause::Device => self.device,
            StallCause::Unknown => self.unknown,
        }
    }

    pub fn get_mut(&mut self, c: StallCause) -> &mut f64 {
        match c {
            StallCause::Server => &mut self.server,
            StallCause::Network => &mut self.network,
            StallCause::Device => &mut self.device,
            StallCause::Unknown => &mut self.unknown,
        }
    }
}

/// Insertion-ordered map: ties in `diagnose` resolve to the first inserted reason, like a JS object.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReasonMs(pub Vec<(String, f64)>);

impl ReasonMs {
    pub fn add(&mut self, k: &str, w: f64) {
        match self.0.iter_mut().find(|(n, _)| n == k) {
            Some((_, v)) => *v += w,
            None => self.0.push((k.into(), w)),
        }
    }
}

impl Serialize for ReasonMs {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_map(self.0.iter().map(|(k, v)| (k, v)))
    }
}

impl<'de> Deserialize<'de> for ReasonMs {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> de::Visitor<'de> for V {
            type Value = ReasonMs;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a map of reason to ms")
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut m: A) -> Result<ReasonMs, A::Error> {
                let mut out = ReasonMs::default();
                while let Some((k, v)) = m.next_entry::<String, f64>()? {
                    out.add(&k, v);
                }
                Ok(out)
            }
        }
        d.deserialize_map(V)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QoeSessionSummary {
    pub engine: Option<Engine>,
    pub cmcd: bool,
    pub cmcd_claimed: bool,
    pub video_codec: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub decoder_name: Option<String>,
    pub hw_decoder: Option<bool>,
    pub watched_ms: f64,
    pub stall_count: f64,
    pub stall_ms: f64,
    pub dropped_frames: Option<f64>,
    pub decoded_frames: Option<f64>,
    pub recovery_reloads: f64,
    pub error_count: f64,
    pub unrecovered_error: bool,
    pub bandwidth_bps: Option<f64>,
    pub variant_bitrate: Option<f64>,
    pub buffer_ahead_s: Option<f64>,
    pub avg_bandwidth_bps: Option<f64>,
    pub min_bandwidth_bps: Option<f64>,
    pub avg_variant_bitrate: Option<f64>,
    pub stall_buffer_ahead_s: Option<f64>,
    pub stall_bandwidth_bps: Option<f64>,
    pub cmcd_throughput_bps: Option<f64>,
    pub median_transcode_speed: Option<f64>,
    pub sample_count: f64,
    pub stall_cause_ms: Option<CauseMs>,
    pub stall_reason_ms: Option<ReasonMs>,
}

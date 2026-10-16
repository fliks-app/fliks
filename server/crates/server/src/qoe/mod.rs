//! Playback QoE (`docs/spec/qoe.md`): in-memory trackers, the 30 s flush, the daily purge, the admin
//! reads and the live TV bridges (`docs/bridge.md` rows `/internal/qoe/*`).
mod playbacks;
mod routes;
mod store;
#[cfg(test)]
mod tests;

pub use routes::{
    __path_events, __path_session, __path_sessions, __path_summary, events, router, session,
    sessions, summary,
};

use crate::{events::event::PlayState, presence::LiveSession};
use chrono::{DateTime, Duration as Span, Local, NaiveDateTime, Utc};
use fliks_domain::qoe::{
    CmcdSnapshot, QoeAggregator, QoeDiagnosis, QoeEvent, QoePipeline, QoeSample, ServerLoad,
    StallLast, diagnose,
};
use fliks_engine_core::api::SessionKind;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};
use store::{EventRow, QoeRow};

const FLUSH_INTERVAL: Duration = Duration::from_secs(30);
const MAX_FLUSH_FAILURES: u32 = 5;
const MAX_EVENTS_PER_SESSION: usize = 200;
/// A shorter wait means the segment was already on disk: no production-speed signal.
const MIN_WAIT_MS: f64 = 20.0;
const DEFAULT_RETENTION_DAYS: f64 = 30.0;
const DAY_MS: f64 = 86_400_000.0;
const ENABLED_KEY: &str = "qoe_enabled";
const RETENTION_KEY: &str = "qoe_retention_days";

pub use crate::presence::now_ms;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Transcode,
    Remux,
    Directplay,
    Live,
}

/// A presence session, or any session shaped like one (live TV: no media file, kind `live`).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub session_id: String,
    pub user_id: Option<i32>,
    pub media_file_id: Option<i32>,
    pub media_title: Option<String>,
    pub started_at: f64,
    pub last_beat: f64,
    pub device_label: Option<String>,
    pub system_name: Option<String>,
    pub app_version: Option<String>,
    pub kind: Kind,
    pub quality: Option<String>,
    #[serde(default = "empty_array")]
    pub transcode_reasons: Value,
    #[serde(default = "playing")]
    pub state: PlayState,
    pub attributed_user_id: Option<i32>,
}

fn empty_array() -> Value {
    json!([])
}

fn playing() -> PlayState {
    PlayState::Playing
}

impl From<&LiveSession> for SessionRef {
    fn from(s: &LiveSession) -> Self {
        Self {
            session_id: s.session_id.clone(),
            user_id: s.user_id,
            media_file_id: i32::try_from(s.media_file_id).ok(),
            media_title: s.media_title.clone(),
            started_at: s.started_at,
            last_beat: s.last_beat,
            device_label: s.device_label.clone(),
            system_name: s.system_name.clone(),
            app_version: s.app_version.clone(),
            kind: match s.kind {
                SessionKind::Directplay => Kind::Directplay,
                SessionKind::Remux => Kind::Remux,
                SessionKind::Transcode => Kind::Transcode,
            },
            quality: s.quality.clone(),
            transcode_reasons: serde_json::to_value(&s.transcode_reasons)
                .unwrap_or_else(|_| json!([])),
            state: s.state.clone(),
            attributed_user_id: s.attributed_user_id,
        }
    }
}

/// Live view for the admin streams list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSummary {
    #[serde(flatten)]
    pub diagnosis: QoeDiagnosis,
    pub stall_count: f64,
    pub stall_ms: f64,
    pub dropped_pct: Option<f64>,
    pub bandwidth_bps: Option<f64>,
    pub variant_bitrate: Option<f64>,
    pub buffer_ahead_s: Option<f64>,
    pub hw_decoder: Option<bool>,
    pub decoder_name: Option<String>,
    pub transcode_speed: Option<f64>,
    pub engine: Option<fliks_domain::qoe::Engine>,
    pub cmcd: bool,
    pub cmcd_claimed: bool,
    pub playback_id: Option<String>,
    pub last_stall: Option<StallLast>,
}

struct Tracker {
    session: SessionRef,
    playback_id: Option<String>,
    agg: QoeAggregator,
    pending: Vec<EventRow>,
    event_count: usize,
    dirty: bool,
    /// A sample or event arrived: only then is the session worth a row.
    reported: bool,
    ended_at: Option<f64>,
    touched_at: f64,
    failures: u32,
    /// Serializes the flushes of one tracker; a call made during one runs after it.
    flush: Arc<tokio::sync::Mutex<()>>,
}

type LoadProbe = Arc<dyn Fn() -> (u32, u32) + Send + Sync>;

struct Inner {
    db: sqlx::PgPool,
    /// False until the setting is read: an unknown state records nothing.
    enabled: AtomicBool,
    trackers: Mutex<HashMap<String, Tracker>>,
    /// Outlives the engine's revive window (plus a sweep), so a revived sid keeps its aggregator.
    idle_ms: f64,
    live_transcodes: AtomicU32,
    load_probe: Mutex<Option<LoadProbe>>,
}

/// Cheap to clone; every clone shares the trackers.
#[derive(Clone)]
pub struct Qoe(Arc<Inner>);

fn at(ms: f64) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(ms as i64).unwrap_or_default()
}

fn clamp_int(x: f64) -> i32 {
    (x + 0.5).floor().clamp(0.0, f64::from(i32::MAX)) as i32
}

fn engine_name(e: Option<fliks_domain::qoe::Engine>) -> Option<String> {
    e.and_then(|e| serde_json::to_value(e).ok())
        .and_then(|v| v.as_str().map(str::to_owned))
}

#[cfg(not(unix))]
fn load_avg1() -> Option<f64> {
    // Node's os.loadavg() reports 0 on Windows.
    Some(0.0)
}

#[cfg(unix)]
fn load_avg1() -> Option<f64> {
    let mut l = [0f64; 1];
    // SAFETY: `l` holds the one sample asked for.
    (unsafe { libc::getloadavg(l.as_mut_ptr(), 1) } == 1).then_some(l[0])
}

impl Qoe {
    pub fn new(db: sqlx::PgPool) -> Self {
        let revive = crate::engine::lifetime(|k| std::env::var(k).ok()).session_revive_ttl_ms;
        Self(Arc::new(Inner {
            db,
            enabled: AtomicBool::new(false),
            trackers: Mutex::default(),
            idle_ms: f64::from(revive) + 2.0 * FLUSH_INTERVAL.as_millis() as f64,
            live_transcodes: AtomicU32::new(0),
            load_probe: Mutex::default(),
        }))
    }

    fn map(&self) -> MutexGuard<'_, HashMap<String, Tracker>> {
        self.0.trackers.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn enabled(&self) -> bool {
        self.0.enabled.load(Ordering::Relaxed)
    }

    /// Reads `qoe_enabled` (unset means on); a failed read keeps the previous state.
    pub async fn reload_enabled(&self) {
        match store::setting(&self.0.db, ENABLED_KEY).await {
            Ok(v) => self
                .0
                .enabled
                .store(v.as_deref() != Some("false"), Ordering::Relaxed),
            Err(e) => tracing::warn!(error = %e, "qoe_enabled read failed"),
        }
    }

    /// The settings write hook (`settings::routes`): `qoe_enabled` re-reads.
    pub async fn settings_changed(&self, keys: &[String]) {
        if keys.iter().any(|k| k == ENABLED_KEY) {
            self.reload_enabled().await;
        }
    }

    /// Supplies `(activeTranscodes, activeSessions)` for the server load of a stall; read on demand.
    pub fn set_load_probe(&self, probe: impl Fn() -> (u32, u32) + Send + Sync + 'static) {
        *self.0.load_probe.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(probe));
    }

    /// Running live TV transcodes (the bridge), added to the count.
    pub fn set_live_transcodes(&self, n: u32) {
        self.0.live_transcodes.store(n, Ordering::Relaxed);
    }

    fn with<R>(
        &self,
        s: &SessionRef,
        revive: bool,
        f: impl FnOnce(&mut Tracker) -> R,
    ) -> Option<R> {
        if !self.enabled() {
            return None;
        }
        let now = now_ms();
        let mut map = self.map();
        let t = map.entry(s.session_id.clone()).or_insert_with(|| Tracker {
            session: s.clone(),
            playback_id: None,
            agg: QoeAggregator::new(),
            pending: vec![],
            event_count: 0,
            dirty: false,
            reported: false,
            ended_at: None,
            touched_at: 0.0,
            failures: 0,
            flush: Arc::default(),
        });
        t.session = s.clone();
        if revive {
            t.ended_at = None;
        }
        t.dirty = true;
        t.touched_at = now;
        Some(f(t))
    }

    /// Starts tracking; nothing is stored until a sample or an event arrives.
    pub fn register(&self, s: &SessionRef) {
        self.with(s, true, |_| ());
    }

    /// What the server does to this session's stream; replaces a previous value.
    pub fn set_pipeline(&self, s: &SessionRef, p: QoePipeline) {
        self.with(s, false, |t| t.agg.set_pipeline(Some(p)));
    }

    pub fn record_sample(&self, s: &SessionRef, sample: &QoeSample) {
        self.with(s, true, |t| {
            t.reported = true;
            t.playback_id = sample.playback_id.clone().or(t.playback_id.take());
            t.agg
                .add_sample(sample, now_ms(), s.state != PlayState::Paused);
        });
    }

    fn server_load(&self) -> Option<ServerLoad> {
        let probe = self
            .0
            .load_probe
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let (transcodes, sessions) = probe.map_or((0, 0), |p| p());
        Some(ServerLoad {
            active_transcodes: transcodes + self.0.live_transcodes.load(Ordering::Relaxed),
            active_sessions: sessions,
            load_avg1: load_avg1(),
            cpu_count: std::thread::available_parallelism().map_or(1, |n| n.get() as u32),
        })
    }

    pub fn record_events(&self, s: &SessionRef, events: &[QoeEvent], playback_id: Option<String>) {
        let freeze = events.iter().any(|e| {
            use fliks_domain::qoe::EventType::*;
            e.kind == Stall || (e.kind == Recovery && e.duration_ms.unwrap_or(0.0) > 0.0)
        });
        let load = if freeze { self.server_load() } else { None };
        self.with(s, false, |t| {
            t.reported = true;
            t.playback_id = playback_id.or(t.playback_id.take());
            let now = now_ms();
            for e in events {
                let c = t.agg.add_event(e, now, s.kind == Kind::Live, load.as_ref());
                // The cap bounds stored rows only; every event still counts in the summary.
                if t.event_count >= MAX_EVENTS_PER_SESSION {
                    continue;
                }
                t.event_count += 1;
                let mut data = serde_json::to_value(e).unwrap_or_default();
                if let Some(o) = data.as_object_mut() {
                    o.remove("type");
                    o.remove("at");
                    if let Some(c) = c {
                        o.insert("cause".into(), json!(c.cause));
                        o.insert("causeConfidence".into(), json!(c.confidence));
                        o.insert("causeReason".into(), json!(c.reason));
                        o.insert("causeEvidence".into(), json!(c.evidence));
                        o.insert("causeHints".into(), json!(c.hints));
                        o.insert("serverLoad".into(), json!(load));
                    }
                }
                t.pending.push(EventRow {
                    session_id: s.session_id.clone(),
                    at: at(e.at),
                    kind: serde_json::to_value(e.kind)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default(),
                    data,
                });
            }
        });
    }

    /// The rung changed on a running session: only the output differs.
    pub fn update_pipeline_output(&self, sid: &str, quality: Option<&str>, bitrate: Option<f64>) {
        if !self.enabled() {
            return;
        }
        let mut map = self.map();
        let Some(t) = map.get_mut(sid) else { return };
        let Some(mut p) = t.agg.pipeline().cloned() else {
            return;
        };
        let Some(o) = p.output.as_mut() else { return };
        if o.quality.as_deref() == quality && o.bitrate == bitrate {
            return;
        }
        (o.quality, o.bitrate) = (quality.map(str::to_owned), bitrate);
        t.agg.set_pipeline(Some(p));
        t.dirty = true;
    }

    /// The rung the session is actually encoding, once segments are served.
    pub fn note_served_rung(&self, sid: &str, quality: &str, bitrate: Option<f64>) {
        if !self.enabled() || quality == "auto" {
            return;
        }
        let mut map = self.map();
        let Some(t) = map.get_mut(sid) else { return };
        let Some(mut p) = t.agg.pipeline().cloned() else {
            return;
        };
        let Some(o) = p.output.as_mut() else { return };
        if o.quality.as_deref() == Some(quality) && bitrate.is_none_or(|b| o.bitrate == Some(b)) {
            return;
        }
        o.quality = Some(quality.to_owned());
        o.bitrate = bitrate.or(o.bitrate);
        t.agg.set_pipeline(Some(p));
        t.dirty = true;
    }

    /// The run fell back from the GPU to the CPU (`hw_accel == "none"`): the pipeline follows it.
    pub fn note_hw_accel(&self, sid: &str, hw_accel: &str) {
        if !self.enabled() || hw_accel != "none" {
            return;
        }
        let mut map = self.map();
        let Some(t) = map.get_mut(sid) else { return };
        let Some(mut p) = t.agg.pipeline().cloned() else {
            return;
        };
        let hw = |s: &Option<fliks_domain::qoe::PipelineStage>| s.as_ref().is_some_and(|s| s.hw);
        if !hw(&p.encode) && !hw(&p.decode) {
            return;
        }
        let cpu = || {
            Some(fliks_domain::qoe::PipelineStage {
                hw: false,
                kind: "cpu".into(),
                name: Some(None),
            })
        };
        p.decode = p.decode.and(cpu());
        p.encode = p.encode.and(cpu());
        p.tonemap = p.tonemap.map(|_| "cpu".into());
        t.agg.set_pipeline(Some(p));
        t.dirty = true;
    }

    /// A segment served by the engine: its CMCD, if any, and the production wait.
    pub fn observe_served(
        &self,
        s: &SessionRef,
        cmcd: Option<&CmcdSnapshot>,
        segment_duration_s: f64,
        waited_ms: Option<f64>,
    ) {
        self.with(s, true, |t| {
            let now = now_ms();
            if let Some(c) = cmcd {
                t.agg.add_cmcd(c, now);
            }
            t.agg.add_segment(
                segment_duration_s,
                waited_ms.filter(|w| *w >= MIN_WAIT_MS),
                now,
            );
        });
    }

    pub fn live_summary(&self, sid: &str) -> Option<LiveSummary> {
        let map = self.map();
        let t = map.get(sid)?;
        let s = t.agg.summary();
        Some(LiveSummary {
            diagnosis: diagnose(&s, t.session.kind == Kind::Live),
            stall_count: s.stall_count,
            stall_ms: s.stall_ms,
            dropped_pct: match (s.dropped_frames, s.decoded_frames) {
                (Some(d), Some(n)) if n != 0.0 => Some(d / n * 100.0),
                _ => None,
            },
            bandwidth_bps: s.bandwidth_bps.or(s.cmcd_throughput_bps),
            variant_bitrate: s.variant_bitrate,
            buffer_ahead_s: s.buffer_ahead_s,
            hw_decoder: s.hw_decoder,
            decoder_name: s.decoder_name,
            transcode_speed: s.median_transcode_speed,
            engine: s.engine,
            cmcd: s.cmcd,
            cmcd_claimed: s.cmcd_claimed,
            playback_id: t.playback_id.clone(),
            last_stall: t.agg.last_stall().cloned(),
        })
    }

    /// The session of a tracker kept after its end, so late events can still be owned and stored.
    pub fn tracked_session(&self, sid: &str) -> Option<SessionRef> {
        self.map().get(sid).map(|t| t.session.clone())
    }

    /// The session left the engine: flush now. The tracker stays for late events and a revive.
    pub fn session_ended(&self, sid: &str) {
        if !self.mark_ended(sid) {
            return;
        }
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let (q, sid) = (self.clone(), sid.to_owned());
            rt.spawn(async move { q.flush(&sid).await });
        }
    }

    /// Request paths await the row so a following admin read sees the ended session.
    pub async fn end_session(&self, sid: &str) {
        if self.mark_ended(sid) {
            self.flush(sid).await;
        }
    }

    fn mark_ended(&self, sid: &str) -> bool {
        let mut map = self.map();
        let Some(t) = map.get_mut(sid).filter(|t| t.ended_at.is_none()) else {
            return false;
        };
        t.ended_at = Some(now_ms());
        t.dirty = true;
        true
    }

    fn to_row(t: &Tracker) -> QoeRow {
        let s = t.agg.summary();
        let live = t.session.kind == Kind::Live;
        let d = diagnose(&s, live);
        let ses = &t.session;
        let (v, c) = verdict_strs(&d);
        let last_seen = t.ended_at.unwrap_or(ses.last_beat.max(t.touched_at));
        let opt = |x: Option<f64>| x.map(clamp_int);
        QoeRow {
            sessionId: ses.session_id.clone(),
            playbackId: t.playback_id.clone(),
            userId: ses.user_id,
            mediaFileId: ses.media_file_id,
            mediaTitle: ses.media_title.clone(),
            startedAt: at(ses.started_at),
            lastSeenAt: at(last_seen),
            endedAt: t.ended_at.map(at),
            deviceLabel: ses.device_label.clone(),
            systemName: ses.system_name.clone(),
            appVersion: ses.app_version.clone(),
            engine: engine_name(s.engine),
            cmcd: s.cmcd,
            cmcdClaimed: s.cmcd_claimed,
            playMethod: serde_json::to_value(ses.kind)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned)),
            quality: ses.quality.clone().or_else(|| {
                t.agg
                    .pipeline()
                    .and_then(|p| p.output.as_ref())
                    .and_then(|o| o.requested.clone())
            }),
            transcodeReasons: ses.transcode_reasons.clone(),
            videoCodec: s.video_codec,
            width: opt(s.width),
            height: opt(s.height),
            decoderName: s.decoder_name,
            hwDecoder: s.hw_decoder,
            watchedMs: clamp_int(s.watched_ms),
            stallCount: clamp_int(s.stall_count),
            stallMs: clamp_int(s.stall_ms),
            droppedFrames: opt(s.dropped_frames),
            decodedFrames: opt(s.decoded_frames),
            avgBandwidthBps: s.avg_bandwidth_bps,
            minBandwidthBps: s.min_bandwidth_bps,
            avgVariantBitrate: s.avg_variant_bitrate,
            recoveryReloads: clamp_int(s.recovery_reloads),
            errorCount: clamp_int(s.error_count),
            medianTranscodeSpeed: s.median_transcode_speed,
            stallBufferAheadS: s.stall_buffer_ahead_s,
            stallBandwidthBps: s.stall_bandwidth_bps,
            cmcdThroughputBps: s.cmcd_throughput_bps,
            unrecoveredError: s.unrecovered_error,
            sampleCount: clamp_int(s.sample_count),
            stallCauseMs: s.stall_cause_ms.and_then(|c| serde_json::to_value(c).ok()),
            stallReasonMs: s.stall_reason_ms.and_then(|c| serde_json::to_value(c).ok()),
            pipeline: t.agg.pipeline().and_then(|p| serde_json::to_value(p).ok()),
            verdict: v.clone(),
            confidence: c.clone(),
            reasons: json!(d.reasons),
            playbackVerdict: v,
            playbackConfidence: c,
        }
    }

    /// Resolves once everything dirty at call time is written; a call during a flush runs after it.
    pub async fn flush(&self, sid: &str) {
        let Some(lock) = self.map().get(sid).map(|t| t.flush.clone()) else {
            return;
        };
        let _turn = lock.lock().await;
        let (row, events) = {
            let mut map = self.map();
            let Some(t) = map.get_mut(sid).filter(|t| t.dirty && t.reported) else {
                return;
            };
            t.dirty = false;
            (Self::to_row(t), std::mem::take(&mut t.pending))
        };
        let Err(e) = self.write(row, &events).await else {
            if let Some(t) = self.map().get_mut(sid) {
                t.failures = 0;
            }
            return;
        };
        let mut map = self.map();
        let Some(t) = map.get_mut(sid) else { return };
        // Bounded by the per-session event cap.
        t.pending.splice(0..0, events);
        t.dirty = true;
        t.failures += 1;
        if t.failures >= MAX_FLUSH_FAILURES {
            tracing::warn!(sid, error = %e, "qoe flush failed, tracker dropped after {} failures", t.failures);
            map.remove(sid);
        } else {
            tracing::warn!(sid, error = %e, "qoe flush failed");
        }
    }

    async fn write(&self, mut row: QoeRow, events: &[EventRow]) -> sqlx::Result<()> {
        let db = &self.0.db;
        let mut stale = false;
        if let (Some(user), Some(playback)) = (row.userId, row.playbackId.clone()) {
            let siblings = store::siblings(db, user, &playback, &row.sessionId).await?;
            if !siblings.is_empty() {
                let mut all = siblings.clone();
                all.push(row.clone());
                let p = playbacks::merge_playbacks(all).remove(0);
                let (v, c) = verdict_strs(&p.diag);
                stale = siblings
                    .iter()
                    .any(|o| o.playbackVerdict != v || o.playbackConfidence != c);
                (row.playbackVerdict, row.playbackConfidence) = (v, c);
            }
        }
        store::upsert(db, &row).await?;
        if stale {
            store::restate(db, &row).await?;
        }
        if !events.is_empty() {
            store::insert_events(db, events).await?;
        }
        Ok(())
    }

    /// Flushes what is dirty, then forgets the trackers idle past the revive window.
    pub async fn sweep(&self) {
        let sids: Vec<String> = self.map().keys().cloned().collect();
        for sid in sids {
            let dirty = self.map().get(&sid).is_some_and(|t| t.dirty);
            if dirty {
                self.flush(&sid).await;
            }
            let now = now_ms();
            let mut map = self.map();
            if map
                .get(&sid)
                .is_some_and(|t| now - t.touched_at > self.0.idle_ms && (!t.dirty || !t.reported))
            {
                map.remove(&sid);
            }
        }
    }

    /// Shutdown: every tracker's last state goes out.
    pub async fn flush_all(&self) {
        let sids: Vec<String> = self.map().keys().cloned().collect();
        for sid in sids {
            self.flush(&sid).await;
        }
    }

    /// Rows older than `qoe_retention_days` (30 when unset or not a positive number) go.
    pub async fn purge_old(&self) {
        let days = store::setting(&self.0.db, RETENTION_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .filter(|d| d.is_finite() && *d > 0.0)
            .unwrap_or(DEFAULT_RETENTION_DAYS);
        match store::purge(&self.0.db, at(now_ms() - days * DAY_MS)).await {
            Ok(0) => {}
            Ok(n) => tracing::info!("purged {n} qoe session(s)"),
            Err(e) => tracing::warn!(error = %e, "qoe purge failed"),
        }
    }
}

fn verdict_strs(d: &QoeDiagnosis) -> (String, String) {
    let s = |v: Value| v.as_str().unwrap_or_default().to_owned();
    (
        s(serde_json::to_value(d.verdict).unwrap_or_default()),
        s(serde_json::to_value(d.confidence).unwrap_or_default()),
    )
}

/// Boot: reads the enabled flag, then the 30 s sweep and the 04:00 purge run for the process.
pub fn spawn(qoe: &Qoe) {
    let q = qoe.clone();
    tokio::spawn(async move {
        q.reload_enabled().await;
        let mut tick =
            tokio::time::interval_at(tokio::time::Instant::now() + FLUSH_INTERVAL, FLUSH_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            q.sweep().await;
        }
    });
    let q = qoe.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(until_next(Local::now().naive_local())).await;
            q.purge_old().await;
            // Avoid re-firing within the same second.
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

/// Wait until the next 04:00 wall-clock; a DST change shifts one run by an hour at most.
fn until_next(now: NaiveDateTime) -> Duration {
    let mut next = now.date().and_hms_opt(4, 0, 0).expect("valid time");
    if next <= now {
        next += Span::days(1);
    }
    (next - now).to_std().unwrap_or_default()
}

//! The `LiveSession` shape, its defaults and the engine-side mappings (`presence.md` rules 2-9).
use crate::events::event::{PlayState, QualityRung};
use fliks_engine_core::api::{
    AudioPlan, BitrateHint, ClientInfo, Decision, PlayMethod, SessionKind, SessionSnapshot,
    TranscodeReason,
};
use std::collections::BTreeMap;

/// Who watches what on which SSE connection; `started_at`/`last_beat` are epoch ms.
#[derive(Debug, Clone, PartialEq)]
pub struct LiveSession {
    pub session_id: String,
    pub user_id: Option<i32>,
    pub username: Option<String>,
    pub media_file_id: u32,
    pub media_title: Option<String>,
    pub media_type: Option<String>,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
    pub profile_hash: Option<String>,
    pub quality: Option<String>,
    pub qualities: Option<Vec<QualityRung>>,
    /// The launcher's account when a remote control started this playback.
    pub attributed_user_id: Option<i32>,
    pub autoplay_blocked: bool,
    pub has_next: bool,
    pub kind: SessionKind,
    pub device_label: Option<String>,
    pub system_name: Option<String>,
    pub app_version: Option<String>,
    pub sse_connection_id: Option<String>,
    pub started_at: f64,
    pub last_beat: f64,
    pub position: f64,
    pub state: PlayState,
    pub episode_label: Option<String>,
    pub supports_volume: bool,
    pub subtitle_id: Option<String>,
    pub audio_track_index: Option<i32>,
    pub subtitle_track_index: Option<i32>,
    pub volume: Option<f64>,
    pub muted: Option<bool>,
    pub audio_plan: Option<AudioPlan>,
    pub source_fps: Option<f64>,
    pub bitrate_by_quality: Option<BTreeMap<String, BitrateHint>>,
    pub hdr_ladder: bool,
    pub transcode_reasons: Vec<TranscodeReason>,
    pub client_tonemap: bool,
}

/// What playback-info knows when it opens a session (`presenceInput`, rule 5).
pub struct Facts<'a> {
    pub session_id: &'a str,
    pub user_id: Option<i32>,
    pub media_file_id: u32,
    pub profile_hash: Option<&'a str>,
    pub quality: Option<&'a str>,
    pub kind: SessionKind,
    pub decision: &'a Decision,
    pub client: &'a ClientInfo,
    /// The tags sent to the engine at open ([`to_tags`]).
    pub tags: &'a BTreeMap<String, String>,
    pub position_s: f64,
}

/// `DirectPlay` -> directplay, `DirectStream` -> remux, else transcode.
pub fn kind_of(m: PlayMethod) -> SessionKind {
    match m {
        PlayMethod::DirectPlay => SessionKind::Directplay,
        PlayMethod::DirectStream => SessionKind::Remux,
        PlayMethod::Transcode => SessionKind::Transcode,
    }
}

/// The engine-opaque tags that survive a host restart (rule 6).
#[derive(Default)]
pub struct Tags {
    pub username: Option<String>,
    pub media_title: Option<String>,
    pub media_type: Option<String>,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
    pub sse_connection_id: Option<String>,
    pub attributed_user_id: Option<i32>,
}

/// Drops absent and empty values.
pub fn to_tags(t: &Tags) -> BTreeMap<String, String> {
    let attributed = t.attributed_user_id.map(|n| n.to_string());
    [
        ("username", t.username.clone()),
        ("mediaTitle", t.media_title.clone()),
        ("mediaType", t.media_type.clone()),
        ("posterUrl", t.poster_url.clone()),
        ("fanartUrl", t.fanart_url.clone()),
        ("sseConnectionId", t.sse_connection_id.clone()),
        ("attributedUserId", attributed),
    ]
    .into_iter()
    .filter_map(|(k, v)| v.filter(|v| !v.is_empty()).map(|v| (k.to_owned(), v)))
    .collect()
}

/// A client heartbeat: `Some` overwrites, `Some(None)` clears (a JSON `null`), `None` keeps.
#[derive(Debug, Default, Clone)]
pub struct Beat {
    pub position: Option<f64>,
    pub state: Option<PlayState>,
    pub quality: Option<Option<String>>,
    pub qualities: Option<Option<Vec<QualityRung>>>,
    pub autoplay_blocked: Option<bool>,
    pub has_next: Option<bool>,
    pub episode_label: Option<Option<String>>,
    pub supports_volume: Option<bool>,
    pub subtitle_id: Option<Option<String>>,
    pub audio_track_index: Option<Option<i32>>,
    pub subtitle_track_index: Option<Option<i32>>,
    /// A present value rebinds the session to that SSE connection (a reconnect re-attaches).
    pub sse_connection_id: Option<String>,
    pub volume: Option<Option<f64>>,
    pub muted: Option<Option<bool>>,
}

impl LiveSession {
    /// Defaults of rule 3 for everything the facts do not give.
    pub fn from_facts(f: &Facts, now: f64) -> Self {
        let r = &f.decision.response;
        let tag = |k: &str| f.tags.get(k).cloned();
        Self {
            session_id: f.session_id.to_owned(),
            user_id: f.user_id,
            username: tag("username"),
            media_file_id: f.media_file_id,
            media_title: tag("mediaTitle"),
            media_type: tag("mediaType"),
            poster_url: tag("posterUrl"),
            fanart_url: tag("fanartUrl"),
            profile_hash: f.profile_hash.map(str::to_owned),
            quality: f.quality.map(str::to_owned),
            qualities: None,
            attributed_user_id: tag("attributedUserId").and_then(|v| v.parse().ok()),
            autoplay_blocked: false,
            has_next: false,
            kind: f.kind,
            device_label: f.client.user_agent.clone(),
            system_name: f.client.system_name.clone(),
            app_version: f.client.app_version.clone(),
            sse_connection_id: tag("sseConnectionId"),
            started_at: now,
            last_beat: now,
            position: f.position_s,
            state: PlayState::Playing,
            episode_label: None,
            supports_volume: true,
            subtitle_id: None,
            audio_track_index: None,
            subtitle_track_index: None,
            volume: None,
            muted: None,
            audio_plan: Some(r.audio_plan.clone()),
            source_fps: r.source.frame_rate.as_deref().and_then(parse_source_fps),
            bitrate_by_quality: r.transcode_bitrate_by_quality.clone(),
            hdr_ladder: f.decision.use_hdr_ladder,
            transcode_reasons: r.transcode_reasons.clone(),
            client_tonemap: r.client_tonemap,
        }
    }

    /// `restorePresence`: the engine's clocks and state; the client-reported fields stay defaulted
    /// until the next heartbeat.
    pub fn from_snapshot(s: &SessionSnapshot) -> Self {
        let mut live = Self::from_facts(
            &Facts {
                session_id: &s.session_id,
                user_id: s.owner_id.as_deref().and_then(|o| o.parse().ok()),
                media_file_id: s.media_file_id,
                profile_hash: s.profile_hash.as_deref(),
                quality: s.quality.as_deref(),
                kind: s.kind,
                decision: &s.decision,
                client: &s.client,
                tags: &s.tags,
                position_s: s.position_s,
            },
            s.opened_at_ms,
        );
        live.last_beat = s.last_beat_ms;
        live.state = match s.state.as_str() {
            "paused" => PlayState::Paused,
            "buffering" => PlayState::Buffering,
            _ => PlayState::Playing,
        };
        live
    }

    pub(super) fn apply(&mut self, b: &Beat, now: f64) {
        self.last_beat = now;
        if let Some(v) = b.position {
            self.position = v;
        }
        if let Some(v) = &b.state {
            self.state = v.clone();
        }
        macro_rules! set {
            ($($f:ident),*) => {$(if let Some(v) = &b.$f { self.$f = v.clone(); })*};
        }
        set!(
            quality,
            qualities,
            autoplay_blocked,
            has_next,
            episode_label,
            supports_volume,
            subtitle_id,
            audio_track_index,
            subtitle_track_index,
            volume,
            muted
        );
        if let Some(c) = b.sse_connection_id.as_ref().filter(|c| !c.is_empty()) {
            self.sse_connection_id = Some(c.clone());
        }
    }
}

/// A decimal ("23.976") or a rational ("24000/1001") frame rate; `None` when unknown.
pub fn parse_source_fps(raw: &str) -> Option<f64> {
    if let Some((n, d)) = raw.split_once('/') {
        let (n, d) = (n.trim().parse::<f64>().ok()?, d.trim().parse::<f64>().ok()?);
        return (n > 0.0 && d > 0.0).then(|| n / d);
    }
    raw.trim()
        .parse::<f64>()
        .ok()
        .filter(|v| *v != 0.0 && v.is_finite())
}

//! The host's side of live TV (`livetv-sessions.md`): viewers and capacity holds over the engine's live
//! runtime, the three session routes, the engine events and the resolver's `live` purpose.
use super::{
    channels::{denied_for, not_found},
    dto::Body,
    net::DEFAULT_USER_AGENT,
};
use crate::{
    engine::EngineError,
    events::{Num, Subject},
    http::{
        AppError,
        auth::{Authed, SessionAuthed, load_enabled},
        validate::{PathParams, ValidJson},
    },
    presence::now_ms,
    qoe::{Kind, SessionRef},
    state::AppState,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header::USER_AGENT},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use fliks_domain::{
    acl::{Action, Subject as AclSubject},
    livetv::{
        capacity::{AtCapacity, Releases, sort_streams},
        sync::{AccountState, account_state},
    },
    qoe::{parse_sample, read_cmcd_raw},
};
use fliks_engine_core::api::{
    EngineEvent, LiveCaps, LiveMode, LiveSnapshot, LiveUpstream, OpenLiveRequest,
};
use serde_json::{Value, json};
use sqlx::{FromRow, PgPool};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Mutex,
    time::Instant,
};

#[derive(Debug, Clone)]
pub struct HSource {
    pub id: i32,
    pub name: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub account_status: Option<String>,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub max_streams: i32,
}

/// A stream of a channel with its source, as the open and the events read them.
#[derive(Debug, Clone)]
pub struct HStream {
    pub id: i32,
    pub url: String,
    pub priority: i32,
    pub user_agent: Option<String>,
    pub referer: Option<String>,
    pub probed_container: Option<String>,
    pub probed_video_codec: Option<String>,
    pub probed_audio_codec: Option<String>,
    pub last_error: Option<String>,
    pub last_ok_at: Option<DateTime<Utc>>,
    pub source: HSource,
}

#[derive(FromRow)]
struct StreamJoin {
    id: i32,
    url: String,
    priority: i32,
    #[sqlx(rename = "userAgent")]
    user_agent: Option<String>,
    referer: Option<String>,
    #[sqlx(rename = "probedContainer")]
    probed_container: Option<String>,
    #[sqlx(rename = "probedVideoCodec")]
    probed_video_codec: Option<String>,
    #[sqlx(rename = "probedAudioCodec")]
    probed_audio_codec: Option<String>,
    #[sqlx(rename = "lastError")]
    last_error: Option<String>,
    #[sqlx(rename = "lastOkAt")]
    last_ok_at: Option<DateTime<Utc>>,
    source_id: i32,
    source_name: String,
    source_expires_at: Option<DateTime<Utc>>,
    source_account_status: Option<String>,
    source_user_agent: Option<String>,
    source_referer: Option<String>,
    source_max_streams: i32,
}

impl From<StreamJoin> for HStream {
    fn from(r: StreamJoin) -> Self {
        Self {
            id: r.id,
            url: r.url,
            priority: r.priority,
            user_agent: r.user_agent,
            referer: r.referer,
            probed_container: r.probed_container,
            probed_video_codec: r.probed_video_codec,
            probed_audio_codec: r.probed_audio_codec,
            last_error: r.last_error,
            last_ok_at: r.last_ok_at,
            source: HSource {
                id: r.source_id,
                name: r.source_name,
                expires_at: r.source_expires_at,
                account_status: r.source_account_status,
                user_agent: r.source_user_agent,
                referer: r.source_referer,
                max_streams: r.source_max_streams,
            },
        }
    }
}

/// The streams of a channel on an enabled source (C136: a disabled source's channels are not playable); `restore`
/// reads them whatever the source says, for a hold rebuilt after a restart.
pub async fn load_streams(
    db: &PgPool,
    channel_id: i32,
    enabled_only: bool,
) -> sqlx::Result<Vec<HStream>> {
    let rows: Vec<StreamJoin> = sqlx::query_as(
        r#"SELECT s.id, s.url, s.priority, s."userAgent", s.referer, s."probedContainer", s."probedVideoCodec",
                  s."probedAudioCodec", s."lastError", s."lastOkAt", src.id AS source_id, src.name AS source_name,
                  src."expiresAt" AS source_expires_at, src."accountStatus" AS source_account_status,
                  src."userAgent" AS source_user_agent, src.referer AS source_referer,
                  src."maxStreams" AS source_max_streams
           FROM livetv_channel_streams s JOIN livetv_sources src ON src.id = s."sourceId"
           WHERE s."channelId" = $1 AND (NOT $2 OR src.enabled) ORDER BY s.priority, s.id"#,
    )
    .bind(channel_id)
    .bind(enabled_only)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

#[derive(Debug, Clone)]
struct Viewer {
    channel_id: i32,
    channel_name: String,
    user_id: Option<i32>,
    device: Option<String>,
    started_at: f64,
    capacity_token: String,
}

#[derive(Debug, Clone)]
struct Hold {
    source_id: i32,
    channel_id: i32,
    streams: Vec<HStream>,
    /// Position of the upstream feeding the session now.
    fed: Option<u32>,
    pending: bool,
    mode: Option<LiveMode>,
}

#[derive(Default)]
struct Inner {
    viewers: HashMap<String, Viewer>,
    holds: HashMap<String, Hold>,
    releases: Releases,
}

/// Process-wide live state: one mutex, never held across an `.await` (rule 1).
#[derive(Default)]
pub struct Live(Mutex<Inner>);

impl Live {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn transcodes(i: &Inner) -> u32 {
        i.holds
            .values()
            .filter(|h| h.mode == Some(LiveMode::Transcode))
            .count() as u32
    }
}

fn stream_at<'a>(hold: &'a Hold, url: &str, priority: i32) -> Option<&'a HStream> {
    hold.streams
        .iter()
        .find(|s| s.url == url && s.priority == priority)
}

fn grace_of(raw: Option<String>) -> f64 {
    raw.as_deref()
        .and_then(fliks_domain::js::parse_int)
        .unwrap_or(15) as f64
}

/// What a play refusal sends: an object body is sent verbatim (Nest's `ConflictException({..})`).
pub enum PlayError {
    Object(StatusCode, Value),
    App(AppError),
}

impl From<AppError> for PlayError {
    fn from(e: AppError) -> Self {
        Self::App(e)
    }
}

impl From<sqlx::Error> for PlayError {
    fn from(e: sqlx::Error) -> Self {
        Self::App(e.into())
    }
}

impl IntoResponse for PlayError {
    fn into_response(self) -> Response {
        match self {
            Self::Object(status, body) => (status, Json(body)).into_response(),
            Self::App(e) => e.into_response(),
        }
    }
}

fn unavailable(channel: &str) -> PlayError {
    PlayError::Object(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({"code": "livetv_channel_unavailable", "channelName": channel}),
    )
}

/// C139: the engine's refusals, as the client reads them (it treats every 5xx alike).
fn engine_failure(e: &EngineError) -> AppError {
    match e {
        EngineError::NotRunning | EngineError::NoLive => {
            AppError::with_message(StatusCode::SERVICE_UNAVAILABLE, e.to_string())
        }
        EngineError::Transport(_) => AppError::with_message(
            StatusCode::SERVICE_UNAVAILABLE,
            "The streaming engine did not answer",
        ),
        _ => AppError::plain(StatusCode::BAD_GATEWAY, "Bad Gateway"),
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct Caps {
    pub direct_play: bool,
    pub max_bitrate_bps: Option<f64>,
    pub use_ts: bool,
}

pub struct Opened {
    pub session_id: String,
    pub play_path: String,
    pub mode: LiveMode,
    pub dvr_window_seconds: f64,
    pub segment_seconds: f64,
}

/// A header value the entry or its source gives, entry first (C140).
fn pick(entry: &Option<String>, source: &Option<String>) -> Option<String> {
    [entry, source]
        .into_iter()
        .flatten()
        .find(|v| !v.is_empty())
        .cloned()
}

fn upstream(s: &HStream) -> LiveUpstream {
    let mut headers = BTreeMap::new();
    headers.insert(
        "User-Agent".to_owned(),
        pick(&s.user_agent, &s.source.user_agent).unwrap_or_else(|| DEFAULT_USER_AGENT.into()),
    );
    if let Some(r) = pick(&s.referer, &s.source.referer) {
        headers.insert("Referer".to_owned(), r);
    }
    LiveUpstream {
        url: s.url.clone(),
        priority: s.priority,
        headers,
        probed_container: s.probed_container.clone(),
        probed_video_codec: s.probed_video_codec.clone(),
        probed_audio_codec: s.probed_audio_codec.clone(),
    }
}

pub struct Who {
    pub id: i32,
    pub username: String,
}

/// Opens the channel on the engine: capacity verdict and hold in one critical section, then the engine call.
pub async fn open(
    st: &AppState,
    channel_id: i32,
    channel_name: &str,
    mut streams: Vec<HStream>,
    who: &Who,
    caps: Caps,
    device: Option<String>,
) -> Result<Opened, PlayError> {
    sort_streams(&mut streams, |s| {
        (
            s.priority,
            s.last_error.as_deref().is_some_and(|e| !e.is_empty()),
            s.last_ok_at.map_or(0, |t| t.timestamp_millis()),
        )
    });
    let Some(primary) = streams.first() else {
        return Err(unavailable(channel_name));
    };
    let grace =
        grace_of(crate::settings::setting_value(&st.db, "livetv_slot_release_seconds").await?);
    let token = super::playlist_file::uuid_v4();
    let verdict: Option<AtCapacity> = {
        let mut g = st.livetv.live.lock();
        let on_source = g
            .holds
            .values()
            .filter(|h| h.source_id == primary.source.id)
            .count();
        let v = g.releases.verdict(
            (
                primary.source.id,
                &primary.source.name,
                Some(primary.source.max_streams),
            ),
            grace,
            on_source,
            Instant::now(),
        );
        g.holds.insert(
            token.clone(),
            Hold {
                source_id: primary.source.id,
                channel_id,
                streams: streams.clone(),
                fed: None,
                pending: true,
                mode: None,
            },
        );
        v
    };
    let req = OpenLiveRequest {
        channel_id: channel_id.to_string(),
        upstreams: streams.iter().map(upstream).collect(),
        caps: LiveCaps {
            direct_play: caps.direct_play,
            max_bitrate_bps: caps.max_bitrate_bps,
            use_ts: caps.use_ts,
        },
        owner_id: Some(who.id.to_string()),
        capacity_token: token.clone(),
        at_capacity: verdict.is_some(),
        tags: BTreeMap::from([
            ("channelName".to_owned(), channel_name.to_owned()),
            ("username".to_owned(), who.username.clone()),
            ("device".to_owned(), device.clone().unwrap_or_default()),
        ]),
    };
    let res = match st.engine.open_live(&req).await {
        Ok(r) => r,
        Err(e) => return Err(open_failed(st, e, &token, channel_name, &streams, verdict).await),
    };
    let token_now = res.capacity_token.clone();
    {
        let mut g = st.livetv.live.lock();
        if token_now != token {
            g.holds.remove(&token);
        } else if let Some(h) = g.holds.get_mut(&token) {
            h.pending = false;
            h.mode = Some(res.mode);
        }
        g.viewers.insert(
            res.session_id.clone(),
            Viewer {
                channel_id,
                channel_name: channel_name.to_owned(),
                user_id: Some(who.id),
                device,
                started_at: now_ms(),
                capacity_token: token_now.clone(),
            },
        );
    }
    report_activity(st, &token_now);
    sync_transcodes(st);
    let sref = qoe_ref(st, &res.session_id);
    if let Some(r) = sref {
        st.qoe.register(&r);
        // The engine's report and the domain's are one JSON shape.
        if let Some(p) = serde_json::to_value(&res.qoe_pipeline)
            .ok()
            .and_then(|v| serde_json::from_value(v).ok())
        {
            st.qoe.set_pipeline(&r, p);
        }
    }
    Ok(Opened {
        session_id: res.session_id,
        play_path: res.play_path,
        mode: res.mode,
        dvr_window_seconds: res.dvr_window_seconds,
        segment_seconds: res.segment_seconds,
    })
}

/// The error of a refused open, after giving the hold back (rule 12).
async fn open_failed(
    st: &AppState,
    e: EngineError,
    token: &str,
    channel: &str,
    streams: &[HStream],
    verdict: Option<AtCapacity>,
) -> PlayError {
    let code = match &e {
        EngineError::Http { code, .. } => code.as_deref(),
        _ => None,
    };
    if code == Some("live_unavailable") {
        release(st, token, "failed").await;
        let expired = streams.iter().find(|s| {
            account_state(
                s.source.expires_at,
                s.source.account_status.as_deref(),
                Utc::now(),
            ) == AccountState::Expired
        });
        return match expired {
            Some(s) => PlayError::Object(
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"code": "livetv_account_expired", "channelName": channel, "sourceName": s.source.name}),
            ),
            None => unavailable(channel),
        };
    }
    st.livetv.live.lock().holds.remove(token);
    sync_transcodes(st);
    if code == Some("live_at_capacity")
        && let Some(v) = verdict
    {
        return PlayError::Object(
            StatusCode::CONFLICT,
            serde_json::to_value(v).expect("verdict"),
        );
    }
    tracing::warn!("Live TV open refused: {e}");
    PlayError::App(engine_failure(&e))
}

fn sync_transcodes(st: &AppState) {
    let n = Live::transcodes(&st.livetv.live.lock());
    st.qoe.set_live_transcodes(n);
}

/// The viewer as a QoE session (kind `live`, the channel as its title).
fn qoe_ref(st: &AppState, sid: &str) -> Option<SessionRef> {
    let g = st.livetv.live.lock();
    let v = g.viewers.get(sid)?;
    Some(SessionRef {
        session_id: sid.to_owned(),
        user_id: v.user_id,
        media_file_id: None,
        media_title: Some(v.channel_name.clone()),
        started_at: v.started_at,
        last_beat: now_ms(),
        device_label: v.device.clone(),
        system_name: None,
        app_version: None,
        kind: Kind::Live,
        quality: None,
        transcode_reasons: json!([]),
        state: crate::events::event::PlayState::Playing,
        attributed_user_id: None,
    })
}

/// `livetv:<token>` in the activity registry: gone with the last viewer of the token.
fn report_activity(st: &AppState, token: &str) {
    let mine: Vec<Viewer> = {
        let g = st.livetv.live.lock();
        let mut v: Vec<Viewer> = g
            .viewers
            .values()
            .filter(|v| v.capacity_token == token)
            .cloned()
            .collect();
        v.sort_by(|a, b| a.started_at.total_cmp(&b.started_at));
        v
    };
    let id = format!("livetv:{token}");
    match mine.first() {
        None => st.hub.activity().remove(&id),
        Some(first) => st.hub.activity().upsert_running(
            &id,
            "livetv.viewing",
            Some(Subject {
                title: first.channel_name.clone(),
                media_id: None,
                media_type: None,
                season_number: None,
                episode_number: None,
                episode_title: None,
                episode_id: None,
            }),
            Some(Num(mine.len() as f64)),
            None,
            None,
        ),
    }
}

/// Drops the viewer; `settle` waits for the QoE tracker to be finalised (the leave route).
async fn drop_viewer(st: &AppState, sid: &str, settle: bool) {
    let gone = st.livetv.live.lock().viewers.remove(sid);
    let Some(v) = gone else { return };
    if settle {
        st.qoe.end_session(sid).await;
    } else {
        st.qoe.session_ended(sid);
    }
    report_activity(st, &v.capacity_token);
}

/// `LiveReleased` and the internal release: the hold is gone, its provider connection lingers for the grace.
async fn release(st: &AppState, token: &str, reason: &str) {
    let hold = {
        let mut g = st.livetv.live.lock();
        let Some(h) = g.holds.remove(token) else {
            return;
        };
        g.releases.record(h.source_id, Instant::now(), 3600.0);
        h
    };
    sync_transcodes(st);
    st.hub.activity().remove(&format!("livetv:{token}"));
    if reason != "failed" {
        return;
    }
    let done = sqlx::query(
        r#"UPDATE livetv_channels SET "lastErrorAt" = now(), "consecutiveFailures" = "consecutiveFailures" + 1 WHERE id = $1"#,
    )
    .bind(hold.channel_id)
    .execute(&st.db)
    .await;
    if let Err(e) = done {
        tracing::warn!(
            "Live TV channel #{} failure not counted: {e}",
            hold.channel_id
        );
    }
    tracing::warn!(
        "Live TV channel #{} ended: every stream failed",
        hold.channel_id
    );
}

/// One upstream attempt of a session: its health, its probe, and where the hold sits (rule 23).
async fn attempt(st: &AppState, ev: &EngineEvent) {
    let EngineEvent::LiveAttempt {
        capacity_token,
        upstream,
        upstream_url,
        upstream_priority,
        error,
        probe,
    } = ev
    else {
        return;
    };
    let mut refresh = false;
    let (stream_id, expired) = {
        let mut g = st.livetv.live.lock();
        let Some(hold) = g.holds.get_mut(capacity_token) else {
            return;
        };
        let Some(stream) = stream_at(hold, upstream_url, *upstream_priority).cloned() else {
            return;
        };
        let expired = account_state(
            stream.source.expires_at,
            stream.source.account_status.as_deref(),
            Utc::now(),
        ) == AccountState::Expired;
        if error.is_none() {
            hold.source_id = stream.source.id;
            hold.fed = Some(*upstream);
            refresh = !hold.pending;
        }
        let fed_failed = error.is_some() && hold.fed == Some(*upstream);
        if fed_failed {
            hold.fed = None;
        }
        if fed_failed {
            g.releases.record(stream.source.id, Instant::now(), 3600.0);
        }
        (stream.id, expired)
    };
    if refresh {
        let st = st.clone();
        tokio::spawn(async move { refresh_modes(&st).await });
    }
    let probe = probe.clone().unwrap_or_default();
    let non_empty = |v: &Option<String>| v.clone().filter(|s| !s.is_empty());
    let last_error = error.as_ref().map(|e| {
        if expired {
            "account expired".to_owned()
        } else {
            e.clone()
        }
    });
    let done = sqlx::query(
        r#"UPDATE livetv_channel_streams SET
             "probedVideoCodec" = COALESCE($2, "probedVideoCodec"), "probedAudioCodec" = COALESCE($3, "probedAudioCodec"),
             "probedContainer" = COALESCE($4, "probedContainer"),
             "lastOkAt" = CASE WHEN $5::text IS NULL THEN now() ELSE "lastOkAt" END, "lastError" = $5
           WHERE id = $1"#,
    )
    .bind(stream_id)
    .bind(non_empty(&probe.video_codec))
    .bind(non_empty(&probe.audio_codec))
    .bind(non_empty(&probe.container))
    .bind(last_error)
    .execute(&st.db)
    .await;
    if let Err(e) = done {
        tracing::warn!("live attempt: {e}");
    }
    sync_transcodes(st);
}

/// A remux of a non-H.264 upstream becomes a transcode: the engine's snapshot has the verdict.
async fn refresh_modes(st: &AppState) {
    let Ok(snaps) = st.engine.list_live(None).await else {
        return;
    };
    {
        let mut g = st.livetv.live.lock();
        for s in snaps {
            if let Some(h) = g.holds.get_mut(&s.capacity_token) {
                h.mode = Some(s.mode);
            }
        }
    }
    sync_transcodes(st);
}

/// A viewer rebuilt from the engine's snapshot (a restart, or a request racing the boot resync).
fn viewer_of(s: &LiveSnapshot) -> Viewer {
    Viewer {
        channel_id: s.channel_id.parse().unwrap_or(0),
        channel_name: s.tags.get("channelName").cloned().unwrap_or_default(),
        user_id: s.owner_id.as_deref().and_then(|o| o.parse().ok()),
        device: s.tags.get("device").cloned().filter(|d| !d.is_empty()),
        started_at: s.opened_at_ms,
        capacity_token: s.capacity_token.clone(),
    }
}

/// After every events (re)connect and at boot: viewers and holds follow what the engine still runs (rule 28).
pub async fn resync(st: &AppState) -> Result<(), EngineError> {
    let listed_at = now_ms();
    let snaps = st.engine.list_live(None).await?;
    let tokens: std::collections::HashSet<&str> =
        snaps.iter().map(|s| s.capacity_token.as_str()).collect();
    restore_holds(st, &snaps).await;
    let (added, stale): (Vec<(String, String)>, Vec<String>) = {
        let mut g = st.livetv.live.lock();
        let known: std::collections::HashSet<&str> =
            snaps.iter().map(|s| s.session_id.as_str()).collect();
        let mut added = vec![];
        for s in &snaps {
            if !g.viewers.contains_key(&s.session_id) {
                g.viewers.insert(s.session_id.clone(), viewer_of(s));
                added.push((s.session_id.clone(), s.capacity_token.clone()));
            }
        }
        let stale = g
            .viewers
            .iter()
            .filter(|(sid, v)| !known.contains(sid.as_str()) && v.started_at < listed_at)
            .map(|(sid, _)| sid.clone())
            .collect();
        (added, stale)
    };
    for (_, token) in &added {
        report_activity(st, token);
    }
    for sid in stale {
        drop_viewer(st, &sid, false).await;
    }
    let gone: Vec<String> = st
        .livetv
        .live
        .lock()
        .holds
        .iter()
        .filter(|(t, h)| !tokens.contains(t.as_str()) && !h.pending)
        .map(|(t, _)| t.clone())
        .collect();
    for token in gone {
        release(st, &token, "shutdown").await;
    }
    sync_transcodes(st);
    Ok(())
}

async fn restore_holds(st: &AppState, snaps: &[LiveSnapshot]) {
    for s in snaps {
        let known = {
            let mut g = st.livetv.live.lock();
            match g.holds.get_mut(&s.capacity_token) {
                Some(h) => {
                    h.mode = h.mode.or(Some(s.mode));
                    true
                }
                None => false,
            }
        };
        if known {
            continue;
        }
        let channel_id: i32 = s.channel_id.parse().unwrap_or(0);
        let Ok(streams) = load_streams(&st.db, channel_id, false).await else {
            continue;
        };
        let Some(fed) = streams
            .iter()
            .find(|x| x.url == s.upstream_url && x.priority == s.upstream_priority)
            .cloned()
        else {
            continue;
        };
        let mut g = st.livetv.live.lock();
        g.holds.entry(s.capacity_token.clone()).or_insert(Hold {
            source_id: fed.source.id,
            channel_id,
            streams,
            fed: Some(s.upstream),
            pending: false,
            mode: Some(s.mode),
        });
    }
}

/// Follows the engine's events for the life of the process; subscribed before the engine starts.
pub fn spawn(st: &AppState) {
    let mut rx = st.engine.subscribe();
    let st = st.clone();
    tokio::spawn(async move {
        use crate::engine::Feed;
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match rx.recv().await {
                Ok(Feed::Resync(..)) => {
                    if !st.engine.engine_features().iter().any(|f| f == "live") {
                        continue;
                    }
                    if let Err(e) = resync(&st).await {
                        tracing::warn!("live TV resync failed: {e}");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        st.engine.resync_events();
                    }
                }
                Ok(Feed::Event(ev)) => on_event(&st, &ev).await,
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("live TV feed lagged by {n}, resyncing");
                    st.engine.resync_events();
                }
                Err(RecvError::Closed) => return,
            }
        }
    });
}

pub(super) async fn on_event(st: &AppState, ev: &EngineEvent) {
    match ev {
        EngineEvent::LiveAttempt { .. } => attempt(st, ev).await,
        EngineEvent::LiveReleased {
            capacity_token,
            reason,
        } => release(st, capacity_token, reason).await,
        EngineEvent::SessionEnded { session_id, .. } => drop_viewer(st, session_id, false).await,
        EngineEvent::SegmentServed {
            session_id,
            cmcd_raw,
            waited_ms,
            ..
        } => {
            if let Some(r) = qoe_ref(st, session_id) {
                let cmcd = cmcd_raw.as_deref().and_then(read_cmcd_raw);
                st.qoe.observe_served(
                    &r,
                    cmcd.as_ref(),
                    f64::from(st.engine.livetv_segment_seconds()),
                    Some(*waited_ms),
                );
            }
        }
        _ => {}
    }
}

// ---- routes ----------------------------------------------------------------------------------

fn read(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Read, AclSubject::LiveTvChannel)
}

#[utoipa::path(post, path = "/api/livetv/channels/{id}/play", responses((status = 201)))]
pub async fn play(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    headers: HeaderMap,
    id: PathParams<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), PlayError> {
    read(&a)?;
    let id = crate::http::validate::int_param(&id.0)?;
    let mut b = Body::new(&body, &["directPlay", "maxBitrateBps", "useTs"]);
    let direct = b.opt_bool("directPlay");
    let bitrate = b.opt_int("maxBitrateBps", Some(1));
    let use_ts = b.opt_bool("useTs");
    b.finish()?;
    let channel = find_playable(&st, &a, id).await?;
    let (name, streams) = channel.ok_or_else(|| not_found(id))?;
    let device = headers
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let who = Who {
        id: a.user.id,
        username: a.user.username.clone(),
    };
    let caps = Caps {
        direct_play: direct.val().unwrap_or(false),
        max_bitrate_bps: bitrate.val().map(|n| n as f64),
        use_ts: use_ts.val().unwrap_or(false),
    };
    let opened = open(&st, id, &name, streams, &who, caps, device).await?;
    let token = st.jwt.sign_stream(a.user.id, &a.user.username)?.token;
    let enc = crate::engine::enc(&token);
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "sessionId": opened.session_id,
            "channelId": id,
            "channelName": name,
            "url": format!("{}?token={enc}", opened.play_path),
            "mode": opened.mode,
            "isLive": true,
            "dvrWindowSeconds": num(opened.dvr_window_seconds),
            "segmentSeconds": num(opened.segment_seconds),
        })),
    ))
}

/// A whole float prints as an integer, as JS does.
fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

/// `findPlayable`: enabled, not in a denied group, with its streams; `None` is the one 404.
pub async fn find_playable(
    st: &AppState,
    a: &Authed,
    id: i32,
) -> sqlx::Result<Option<(String, Vec<HStream>)>> {
    let denied = denied_for(st, a).await?;
    playable(&st.db, id, &denied).await
}

async fn playable(
    db: &PgPool,
    id: i32,
    denied: &[String],
) -> sqlx::Result<Option<(String, Vec<HStream>)>> {
    let row: Option<(String,)> = sqlx::query_as(
        r#"SELECT c.name FROM livetv_channels c WHERE c.id = $1 AND c.enabled
           AND (cardinality($2::text[]) = 0 OR c."groupName" IS NULL
                OR lower(btrim(c."groupName")) <> ALL (SELECT lower(btrim(x)) FROM unnest($2::text[]) AS x))"#,
    )
    .bind(id)
    .bind(denied)
    .fetch_optional(db)
    .await?;
    let Some((name,)) = row else { return Ok(None) };
    let streams = load_streams(db, id, true).await?;
    Ok(Some((name, streams)))
}

#[utoipa::path(delete, path = "/api/livetv/sessions/{sessionId}", responses((status = 200)))]
pub async fn leave(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    sid: PathParams<String>,
) -> Result<Json<Value>, AppError> {
    read(&a)?;
    let sid = sid.0;
    // F74: only the owner, or whoever administers settings, ends a viewer.
    let known = st.livetv.live.lock().viewers.get(&sid).map(|v| v.user_id);
    let owner = match known {
        Some(o) => o,
        None => match st
            .engine
            .get_live(&sid)
            .await
            .map_err(|e| engine_failure(&e))?
        {
            Some(s) => s.owner_id.as_deref().and_then(|o| o.parse().ok()),
            // Not a live viewer: this route never ends an on-demand session.
            None => return Ok(Json(json!({"ok": true}))),
        },
    };
    if owner != Some(a.user.id) && !a.perms.can(Action::Manage, &AclSubject::Settings) {
        return Err(AppError::forbidden("Not your session"));
    }
    st.engine
        .delete_session(&sid, None)
        .await
        .map_err(|e| engine_failure(&e))?;
    drop_viewer(&st, &sid, true).await;
    Ok(Json(json!({"ok": true})))
}

#[utoipa::path(put, path = "/api/livetv/sessions/{sessionId}/state", responses((status = 200)))]
pub async fn heartbeat(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    sid: PathParams<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    read(&a)?;
    let mut r =
        qoe_ref(&st, &sid.0).ok_or_else(|| AppError::not_found("Live TV session not found"))?;
    if r.user_id != Some(a.user.id) {
        return Err(AppError::forbidden("Not your session"));
    }
    if let Some(q) = body.get("qoe").filter(|q| !q.is_null()) {
        r.state = if body.get("state").and_then(Value::as_str) == Some("paused") {
            crate::events::event::PlayState::Paused
        } else {
            crate::events::event::PlayState::Playing
        };
        if let Some(sample) = parse_sample(q) {
            st.qoe.record_sample(&r, &sample);
        }
    }
    Ok(Json(json!({"ok": true})))
}

/// C137: the live viewers of a user whose channel is no longer playable for them end now.
pub async fn revoke_lost_access(st: &AppState, user_id: i32) {
    let mine: Vec<(String, i32)> = {
        let g = st.livetv.live.lock();
        g.viewers
            .iter()
            .filter(|(_, v)| v.user_id == Some(user_id))
            .map(|(s, v)| (s.clone(), v.channel_id))
            .collect()
    };
    if mine.is_empty() {
        return;
    }
    let Ok(Some((user, role))) = load_enabled(&st.db, user_id).await else {
        return;
    };
    let perms = if user.is_admin {
        vec!["manage:all".to_owned()]
    } else {
        role.map(|r| r.permissions).unwrap_or_default()
    };
    let Ok(denied) = super::access::denied_groups(&st.db, user_id, &perms).await else {
        return;
    };
    for (sid, channel) in mine {
        match playable(&st.db, channel, &denied).await {
            Ok(Some((_, streams))) if !streams.is_empty() => {}
            Ok(_) => {
                if let Err(e) = st.engine.delete_session(&sid, Some("revoked")).await {
                    tracing::warn!("live viewer {sid} not ended after a grant change: {e}");
                    continue;
                }
                drop_viewer(st, &sid, false).await;
            }
            Err(e) => tracing::warn!("live access re-check failed: {e}"),
        }
    }
}

/// The resolver's `live` purpose (rule 30): may `user` read the data plane of `sid`?
pub async fn resolve_live(
    st: &AppState,
    sid: &str,
    user_id: i32,
    perms: &[String],
) -> Result<bool, AppError> {
    let mut viewer = st.livetv.live.lock().viewers.get(sid).cloned();
    if viewer.is_none() {
        // The engine only asks for sids it holds: a request racing the boot resync is not a denial.
        let found = st
            .engine
            .get_live(sid)
            .await
            .map_err(|e| engine_failure(&e))?;
        let Some(snap) = found else { return Ok(false) };
        let v = viewer_of(&snap);
        st.livetv
            .live
            .lock()
            .viewers
            .entry(sid.to_owned())
            .or_insert_with(|| v.clone());
        viewer = Some(v);
    }
    let Some(viewer) = viewer else {
        return Ok(false);
    };
    // F75: another user's credential is not a denial of the owner (the engine answers 403 by itself).
    if viewer.user_id != Some(user_id) {
        return Ok(true);
    }
    let denied = super::access::denied_groups(&st.db, user_id, perms).await?;
    Ok(matches!(playable(&st.db, viewer.channel_id, &denied).await?, Some((_, s)) if !s.is_empty()))
}

#[cfg(test)]
pub(super) type HoldView = (String, i32, bool, Option<LiveMode>);

/// What the host knows: viewer ids and `(token, source, pending, mode)` of each hold.
#[cfg(test)]
pub(super) fn peek(st: &AppState) -> (Vec<String>, Vec<HoldView>) {
    let g = st.livetv.live.lock();
    let mut viewers: Vec<String> = g.viewers.keys().cloned().collect();
    viewers.sort();
    let mut holds: Vec<_> = g
        .holds
        .iter()
        .map(|(t, h)| (t.clone(), h.source_id, h.pending, h.mode))
        .collect();
    holds.sort_by(|a, b| a.0.cmp(&b.0));
    (viewers, holds)
}

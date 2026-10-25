//! The host's side of live TV (`livetv-sessions.md`): viewers and capacity holds over the engine's live
//! runtime, the three session routes, the engine events and the resolver's `live` purpose.
use super::{
    channels::{denied_for, not_found},
    dto::Body,
    net::DEFAULT_USER_AGENT,
};
use crate::sync::MutexExt;
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
    pub url: String,
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
    source_url: String,
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
                url: r.source_url,
                expires_at: r.source_expires_at,
                account_status: r.source_account_status,
                user_agent: r.source_user_agent,
                referer: r.source_referer,
                max_streams: r.source_max_streams,
            },
        }
    }
}

/// The streams of a channel on an enabled source (a disabled source's channels are not playable); `restore`
/// reads them whatever the source says, for a hold rebuilt after a restart.
pub async fn load_streams(
    db: &PgPool,
    channel_id: i32,
    enabled_only: bool,
) -> sqlx::Result<Vec<HStream>> {
    let rows: Vec<StreamJoin> = sqlx::query_as(
        r#"SELECT s.id, s.url, s.priority, s."userAgent", s.referer, s."probedContainer", s."probedVideoCodec",
                  s."probedAudioCodec", s."lastError", s."lastOkAt", src.id AS source_id, src.name AS source_name, src.url AS source_url,
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
    /// Who an open in flight belongs to (`None` for a hold rebuilt from the engine).
    owner: Option<i32>,
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
        self.0.lock_clean()
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

/// What a play refusal sends: an object body is sent verbatim, as 4.x clients read it.
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

/// The engine's refusals, as the client reads them (it treats every 5xx alike).
fn engine_failure(e: &EngineError) -> AppError {
    match e {
        EngineError::NotRunning => {
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

/// A header value the entry or its source gives, entry first.
fn pick(entry: &Option<String>, source: &Option<String>) -> Option<String> {
    [entry, source]
        .into_iter()
        .flatten()
        .find(|v| !v.is_empty())
        .cloned()
}

fn upstream(s: &HStream, at_capacity: bool) -> LiveUpstream {
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
        at_capacity,
        vetted: super::lineup::provider_chosen(&s.source.url, &s.url),
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
    let cap = super::sync::setting_int(&st.db, "livetv_max_viewers_per_user", 0).await?;
    let token = crate::events::uuid_v4();
    let (verdict, vetoes): (Option<AtCapacity>, Vec<bool>) = {
        let mut g = st.livetv.live.lock();
        let held = g
            .viewers
            .values()
            .filter(|v| v.user_id == Some(who.id))
            .count()
            + g.holds
                .values()
                .filter(|h| h.pending && h.owner == Some(who.id))
                .count();
        if cap > 0 && held as i64 >= cap {
            return Err(PlayError::Object(
                StatusCode::CONFLICT,
                json!({"code": "livetv_user_at_capacity", "limit": cap}),
            ));
        }
        let now = Instant::now();
        let mut per_stream = Vec::with_capacity(streams.len());
        for s in &streams {
            let on_source = g
                .holds
                .values()
                .filter(|h| h.source_id == s.source.id)
                .count();
            per_stream.push(g.releases.verdict(
                (s.source.id, &s.source.name, Some(s.source.max_streams)),
                grace,
                on_source,
                now,
            ));
        }
        let vetoes: Vec<bool> = per_stream.iter().map(Option::is_some).collect();
        let feeding = vetoes
            .iter()
            .position(|v| !v)
            .map_or(primary, |i| &streams[i]);
        g.holds.insert(
            token.clone(),
            Hold {
                source_id: feeding.source.id,
                channel_id,
                streams: streams.clone(),
                fed: None,
                pending: true,
                mode: None,
                owner: Some(who.id),
            },
        );
        (per_stream.into_iter().next().flatten(), vetoes)
    };
    let req = OpenLiveRequest {
        channel_id: channel_id.to_string(),
        upstreams: streams
            .iter()
            .zip(vetoes)
            .map(|(s, v)| upstream(s, v))
            .collect(),
        caps: LiveCaps {
            direct_play: caps.direct_play,
            max_bitrate_bps: caps.max_bitrate_bps,
            use_ts: caps.use_ts,
        },
        owner_id: Some(who.id.to_string()),
        capacity_token: token.clone(),
        at_capacity: false,
        tags: BTreeMap::from([
            ("channelName".to_owned(), channel_name.to_owned()),
            ("username".to_owned(), who.username.clone()),
            ("device".to_owned(), device.clone().unwrap_or_default()),
        ]),
    };
    let mut guard = PendingHold {
        st,
        token: token.clone(),
    };
    let res = match st.engine.open_live(&req).await {
        Ok(r) => {
            guard.token.clear();
            r
        }
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

/// Removes a hold whose open was cancelled before the engine answered (a dropped request).
struct PendingHold<'a> {
    st: &'a AppState,
    token: String,
}

impl Drop for PendingHold<'_> {
    fn drop(&mut self) {
        if !self.token.is_empty() {
            self.st.livetv.live.lock().holds.remove(&self.token);
        }
    }
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

pub(super) mod events;
use events::*;
pub use events::{resync, spawn};

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
    let token = st
        .jwt
        .sign_live(a.user.id, &a.user.username, &opened.session_id)?
        .token;
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
    // Only the owner, or whoever administers settings, ends a viewer.
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

/// The live viewers of a user whose channel is no longer playable for them end now.
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
    // Another user's credential is not a denial of the owner (the engine answers 403 by itself).
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

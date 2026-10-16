//! `PUT /api/playback/media/{mediaId}/state` (`docs/spec/heartbeat.md`): the client's heartbeat.
use super::db::{self, Watch};
use crate::{
    engine::EngineError,
    events::event::{PlayState, QualityRung},
    http::{
        AppError,
        auth::SessionAuthed,
        validate::{PathParams, ValidJson},
    },
    presence::{Beat, LiveSession, now_ms},
    state::AppState,
};
use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use fliks_engine_core::api::{HeartbeatRequest, SessionKind};
use serde_json::{Map, Value, json};
use std::{collections::HashMap, sync::Mutex};

const DEBOUNCE_MS: i64 = 30_000;
const SEEK_SECONDS: f64 = 30.0;
const PRUNE_MS: i64 = DEBOUNCE_MS * 10;

/// Last history write per `user:media:episode`, per process and never persisted (rules 1, 13, 14).
#[derive(Default)]
pub struct Debounce(Mutex<HashMap<String, (i64, f64)>>);

impl Debounce {
    /// Decides and, on a flush, records the write before it happens, so a failed write still debounces.
    fn flush(&self, key: &str, now: i64, pos: f64, dur: f64, state_changed: bool) -> bool {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let last = map.get(key).copied();
        let seeked = last.is_none_or(|(_, p)| (pos - p).abs() > SEEK_SECONDS);
        let due = now - last.map_or(0, |(at, _)| at) >= DEBOUNCE_MS;
        let go = state_changed || db::completes(pos, dur) || seeked || due;
        if go {
            map.insert(key.to_owned(), (now, pos));
            map.retain(|_, (at, _)| *at >= now - PRUNE_MS);
        }
        go
    }
}

/// JS `x ?? undefined` for a number field; other types count as absent.
fn num(b: &Value, k: &str) -> Option<f64> {
    b.get(k).and_then(Value::as_f64)
}

fn int(b: &Value, k: &str) -> Option<i64> {
    b.get(k).and_then(Value::as_i64)
}

/// `undefined` is `None`, `null` is `Some(None)`; a value of another type is ignored.
fn nullable<T>(b: &Value, k: &str, get: impl Fn(&Value) -> Option<T>) -> Option<Option<T>> {
    match b.get(k)? {
        Value::Null => Some(None),
        v => get(v).map(Some),
    }
}

fn text(b: &Value, k: &str) -> Option<Option<String>> {
    nullable(b, k, |v| v.as_str().map(str::to_owned))
}

fn index(b: &Value, k: &str) -> Option<Option<i32>> {
    nullable(b, k, |v| v.as_i64().and_then(|n| i32::try_from(n).ok()))
}

/// `if (payload.state)`: any non-empty string, kept verbatim.
fn play_state(b: &Value) -> Option<PlayState> {
    let s = b.get("state")?.as_str().filter(|s| !s.is_empty())?;
    serde_json::from_value(Value::from(s)).ok()
}

fn presence_beat(b: &Value, sse: Option<String>) -> Beat {
    Beat {
        position: num(b, "positionSeconds"),
        state: play_state(b),
        quality: text(b, "quality"),
        qualities: nullable(b, "qualities", |v| {
            serde_json::from_value::<Vec<QualityRung>>(v.clone()).ok()
        }),
        autoplay_blocked: b.get("autoplayBlocked").and_then(Value::as_bool),
        has_next: b.get("hasNext").and_then(Value::as_bool),
        episode_label: text(b, "episodeLabel"),
        supports_volume: b.get("supportsVolume").and_then(Value::as_bool),
        subtitle_id: text(b, "subtitleId"),
        audio_track_index: index(b, "audioTrackIndex"),
        subtitle_track_index: index(b, "subtitleTrackIndex"),
        sse_connection_id: sse,
        volume: nullable(b, "volume", Value::as_f64),
        muted: nullable(b, "muted", Value::as_bool),
    }
}

/// Body field, else header, else `polled:<targetId>` (rule 2); `''` from the body wins and is ignored later.
fn sse_connection_id(b: &Value, headers: &HeaderMap) -> Option<String> {
    b.get("sseConnectionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            let h = headers.get("x-fliks-sse-connection")?;
            h.to_str().ok().map(str::to_owned)
        })
        .or_else(|| {
            let t = b.get("targetId")?.as_str().filter(|t| !t.is_empty())?;
            Some(format!("polled:{t}"))
        })
}

fn not_yours() -> AppError {
    AppError::forbidden("Not your session")
}

/// Rule 5: `Some(sessionLost)`, or `None` when the engine is off or could not be asked.
async fn engine_beat(
    st: &AppState,
    user: i32,
    sid: &str,
    b: &Value,
) -> Result<Option<bool>, AppError> {
    if !st.engine.runtime() {
        return Ok(None);
    }
    let known = st.presence.peek(sid);
    if known
        .as_ref()
        .is_some_and(|k| k.user_id.is_some_and(|u| u != user) && k.attributed_user_id != Some(user))
    {
        return Err(not_yours());
    }
    let owner = known.as_ref().and_then(|k| k.user_id).unwrap_or(user);
    let req = HeartbeatRequest {
        owner_id: Some(owner.to_string()),
        position_s: num(b, "positionSeconds"),
        state: b.get("state").and_then(Value::as_str).map(str::to_owned),
        quality: b.get("quality").and_then(Value::as_str).map(str::to_owned),
    };
    let asked = async {
        let lost = st.engine.heartbeat(sid, &req).await?.session_lost;
        if !lost && known.is_none() {
            st.presence.restore_sid(&st.engine, sid).await?;
        }
        Ok::<_, EngineError>(lost)
    };
    match asked.await {
        Ok(lost) => Ok(Some(lost)),
        Err(e) if e.status() == Some(403) => Err(not_yours()),
        Err(e) => {
            tracing::warn!("engine heartbeat failed: {e}");
            Ok(None)
        }
    }
}

/// `servedRungBitrate`: the video bitrate of the rung a transcode session is encoding.
fn served_rung_bitrate(s: &LiveSession) -> Option<f64> {
    if s.kind != SessionKind::Transcode {
        return None;
    }
    let (q, ladder) = (s.quality.as_deref()?, s.bitrate_by_quality.as_ref()?);
    let hdr = format!("{q}-hdr");
    let hint = (s.hdr_ladder && !q.ends_with("-hdr"))
        .then(|| ladder.get(&hdr))
        .flatten()
        .or_else(|| ladder.get(q))?;
    (hint.video_bitrate_bps != 0).then_some(f64::from(hint.video_bitrate_bps))
}

/// Rule 10.
fn record_qoe(st: &AppState, user: i32, s: &LiveSession, qoe: &Value) {
    if qoe.is_null() || (s.user_id != Some(user) && s.attributed_user_id != Some(user)) {
        return;
    }
    let Some(mut sample) = fliks_domain::qoe::parse_sample(qoe) else {
        return;
    };
    let rung = served_rung_bitrate(s);
    sample.variant_bitrate = sample.variant_bitrate.or(rung);
    let sref = crate::qoe::SessionRef::from(s);
    st.qoe.record_sample(&sref, &sample);
    if let (Some(rung), Some(q)) = (rung, s.quality.as_deref())
        && q != "auto"
        && q.encode_utf16().count() <= 32
    {
        st.qoe
            .update_pipeline_output(&s.session_id, Some(q), Some(rung));
    }
}

/// Rule 11.
fn emit_state(st: &AppState, user: i32, s: &LiveSession, media: i32, b: &Value) {
    let Some(target_id) = st.hub.target_id_for(s.sse_connection_id.as_deref()) else {
        tracing::debug!(session = %s.session_id, "remote.state without a target");
        return;
    };
    use crate::events::{SseEvent, event::Num};
    st.hub.emit_to_user(
        user,
        SseEvent::RemoteState {
            target_id,
            session_id: s.session_id.clone(),
            media_id: Some(i64::from(media)),
            media_file_id: int(b, "mediaFileId"),
            episode_id: int(b, "episodeId"),
            media_title: s.media_title.clone(),
            episode_label: s.episode_label.clone(),
            poster_url: s.poster_url.clone(),
            fanart_url: s.fanart_url.clone(),
            position_seconds: Num(s.position),
            duration_seconds: num(b, "durationSeconds").map(Num),
            state: s.state.clone(),
            volume: s.volume.map(Num),
            muted: s.muted,
            supports_volume: s.supports_volume,
            subtitle_id: s.subtitle_id.clone(),
            quality: s.quality.clone(),
            qualities: s.qualities.clone(),
            autoplay_blocked: s.autoplay_blocked,
            has_next: s.has_next,
            audio_track_index: s.audio_track_index.map(i64::from),
            subtitle_track_index: s.subtitle_track_index.map(i64::from),
            last_cmd_id: b
                .get("lastCmdId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
    );
}

/// Rule 17: the four bodies; `sessionLost` is only ever `true` in one.
fn reply(lost: bool, state: Option<Option<Value>>) -> Response {
    let mut body = Map::new();
    if lost {
        body.insert("sessionLost".into(), json!(true));
    }
    if let Some(s) = state {
        body.insert("state".into(), s.unwrap_or(Value::Null));
    }
    if body.is_empty() {
        StatusCode::OK.into_response()
    } else {
        Json(Value::Object(body)).into_response()
    }
}

#[utoipa::path(put, path = "/api/playback/media/{mediaId}/state", responses((status = 200), (status = 400), (status = 403)))]
pub async fn heartbeat(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(media): PathParams<i32>,
    headers: HeaderMap,
    ValidJson(body): ValidJson<Value>,
) -> Result<Response, AppError> {
    let user = a.user.id;
    let mut lost = false;
    let mut attributed = None;
    let mut state_changed = false;
    if let Some(sid) = body
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let engine_lost = engine_beat(&st, user, sid, &body).await?;
        let before = st.presence.peek(sid);
        let updated = match engine_lost {
            Some(true) => None,
            _ => st.presence.heartbeat(
                sid,
                &presence_beat(&body, sse_connection_id(&body, &headers)),
            ),
        };
        attributed = updated.as_ref().and_then(|u| u.attributed_user_id);
        state_changed = updated.is_some()
            && play_state(&body).is_some_and(|s| before.is_none_or(|b| b.state != s));
        lost = engine_lost.unwrap_or(updated.is_none());
        if let Some(u) = &updated {
            record_qoe(&st, user, u, body.get("qoe").unwrap_or(&Value::Null));
            emit_state(&st, user, u, media, &body);
        }
    }
    let episode = int(&body, "episodeId");
    let history_user = attributed.unwrap_or(user);
    let key = format!("{history_user}:{media}:{}", episode.unwrap_or(0));
    let (pos, dur) = (
        num(&body, "positionSeconds").unwrap_or(0.0),
        num(&body, "durationSeconds").unwrap_or(0.0),
    );
    if !st
        .debounce
        .flush(&key, now_ms() as i64, pos, dur, state_changed)
    {
        return Ok(reply(lost, None));
    }
    let file = int(&body, "mediaFileId")
        .and_then(|f| i32::try_from(f).ok())
        .filter(|f| *f != 0);
    let (true, Some(file)) = (media != 0, file) else {
        return Err(AppError::bad_request(
            "mediaId and mediaFileId are required",
        ));
    };
    let watch = Watch {
        position: pos,
        duration: dur,
        file,
        episode: episode.and_then(|e| i32::try_from(e).ok()),
    };
    let saved = db::record_watch(&st.db, history_user, media, &watch).await?;
    Ok(reply(lost, Some(saved)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn live() -> LiveSession {
        LiveSession {
            session_id: "s".into(),
            user_id: Some(1),
            username: None,
            media_file_id: 1,
            media_title: None,
            media_type: None,
            poster_url: None,
            fanart_url: None,
            profile_hash: None,
            quality: None,
            qualities: None,
            attributed_user_id: None,
            autoplay_blocked: false,
            has_next: false,
            kind: SessionKind::Transcode,
            device_label: None,
            system_name: None,
            app_version: None,
            sse_connection_id: None,
            started_at: 0.0,
            last_beat: 0.0,
            position: 0.0,
            state: PlayState::Playing,
            episode_label: None,
            supports_volume: true,
            subtitle_id: None,
            audio_track_index: None,
            subtitle_track_index: None,
            volume: None,
            muted: None,
            audio_plan: None,
            source_fps: None,
            bitrate_by_quality: None,
            hdr_ladder: false,
            transcode_reasons: vec![],
            client_tonemap: false,
        }
    }

    #[test]
    fn plain_ticks_debounce_and_seeks_state_changes_and_the_tail_flush() {
        let d = Debounce::default();
        assert!(d.flush("k", 1_000, 100.0, 3600.0, false), "first beat");
        assert!(!d.flush("k", 11_000, 110.0, 3600.0, false), "10 s tick");
        assert!(
            d.flush("k", 12_000, 141.0, 3600.0, false),
            "seek vs the last write"
        );
        assert!(d.flush("k", 13_000, 141.5, 3600.0, true), "state change");
        assert!(!d.flush("k", 14_000, 142.0, 3600.0, false));
        assert!(d.flush("k", 43_000, 150.0, 3600.0, false), "30 s elapsed");
        assert!(
            d.flush("k", 44_000, 3571.0, 3600.0, false),
            "completion zone"
        );
        assert!(
            d.flush("k", 45_000, 3572.0, 3600.0, false),
            "every beat in it"
        );
        assert!(
            d.flush("other", 45_000, 3.0, 0.0, false),
            "keys are independent"
        );
    }

    #[test]
    fn a_flush_is_recorded_before_the_write_and_old_keys_are_pruned() {
        let d = Debounce::default();
        d.flush("old", 0, 0.0, 0.0, false);
        assert!(d.flush("new", 300_001, 0.0, 0.0, false));
        let keys: Vec<_> = d.0.lock().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["new"]);
    }

    #[test]
    fn response_has_the_four_shapes() {
        let body = |r: Response| async {
            let (p, b) = r.into_parts();
            (
                p.status.as_u16(),
                axum::body::to_bytes(b, usize::MAX).await.unwrap(),
            )
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let st = Some(Some(json!({"id": 1})));
        rt.block_on(async {
            assert_eq!(body(reply(false, None)).await.1.len(), 0);
            assert_eq!(
                &body(reply(true, None)).await.1[..],
                br#"{"sessionLost":true}"#
            );
            assert_eq!(
                &body(reply(false, st.clone())).await.1[..],
                br#"{"state":{"id":1}}"#
            );
            assert_eq!(
                &body(reply(true, st)).await.1[..],
                br#"{"sessionLost":true,"state":{"id":1}}"#
            );
            assert_eq!(
                &body(reply(false, Some(None))).await.1[..],
                br#"{"state":null}"#
            );
        });
    }

    #[test]
    fn connection_id_prefers_body_then_header_then_polled_target() {
        let mut h = HeaderMap::new();
        h.insert("x-fliks-sse-connection", "hdr".parse().unwrap());
        let b = |v: Value| sse_connection_id(&v, &h);
        assert_eq!(
            b(json!({"sseConnectionId": "body", "targetId": "t"})).as_deref(),
            Some("body")
        );
        assert_eq!(b(json!({"sseConnectionId": ""})).as_deref(), Some(""));
        assert_eq!(b(json!({"targetId": "t"})).as_deref(), Some("hdr"));
        let none = HeaderMap::new();
        assert_eq!(
            sse_connection_id(&json!({"targetId": "t"}), &none).as_deref(),
            Some("polled:t")
        );
        assert_eq!(sse_connection_id(&json!({}), &none), None);
    }

    #[test]
    fn served_rung_needs_a_transcode_a_ladder_and_prefers_the_hdr_key() {
        use fliks_engine_core::api::BitrateHint;
        let hint = |v| BitrateHint {
            video_bitrate_bps: v,
            audio_bitrate_bps: 0,
            total_bitrate_bps: 0,
        };
        let mut s = live();
        s.kind = SessionKind::Transcode;
        s.quality = Some("720p".into());
        assert_eq!(served_rung_bitrate(&s), None, "no ladder");
        s.bitrate_by_quality = Some(
            [
                ("720p".into(), hint(4_000)),
                ("720p-hdr".into(), hint(6_000)),
            ]
            .into(),
        );
        s.hdr_ladder = false;
        assert_eq!(served_rung_bitrate(&s), Some(4_000.0));
        s.hdr_ladder = true;
        assert_eq!(served_rung_bitrate(&s), Some(6_000.0));
        s.quality = Some("720p-hdr".into());
        assert_eq!(
            served_rung_bitrate(&s),
            Some(6_000.0),
            "already hdr: plain lookup"
        );
        s.kind = SessionKind::Remux;
        assert_eq!(served_rung_bitrate(&s), None);
        s.kind = SessionKind::Transcode;
        s.quality = None;
        assert_eq!(served_rung_bitrate(&s), None);
        s.quality = Some("360p".into());
        s.bitrate_by_quality = Some([("360p".into(), hint(0))].into());
        assert_eq!(served_rung_bitrate(&s), None, "zero is absent");
    }
}

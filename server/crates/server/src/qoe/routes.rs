//! QoE routes: the admin reads and the client events ingest.
use super::{SessionRef, now_ms, playbacks, store};
use crate::{
    http::{
        AppError,
        auth::{Authed, SessionAuthed},
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use fliks_domain::{
    acl::{Action, Subject},
    qoe::{parse_events, parse_playback_id, parse_sent_at},
};
use serde_json::{Value, json, to_value};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/system/qoe/sessions", get(sessions))
        .route("/api/system/qoe/sessions/{sessionId}", get(session))
        .route("/api/system/qoe/summary", get(summary))
        .route("/api/playback/sessions/{sessionId}/events", post(events))
}

type Q = Query<Vec<(String, String)>>;

/// A parameter given once; a repeated one is an array in 4.x and reads as invalid.
fn scalar<'a>(q: &'a [(String, String)], key: &str) -> Option<&'a str> {
    let mut it = q.iter().filter(|(k, _)| k == key);
    match (it.next(), it.next()) {
        (Some((_, v)), None) => Some(v),
        _ => None,
    }
}

/// `Math.trunc(Number(v))` when `v` is non-empty and `Number(v)` is finite.
pub(super) fn int(v: Option<&str>) -> Option<i64> {
    let s = v.filter(|s| !s.is_empty())?.trim();
    let radix = |p: &str, r| {
        let (head, digits) = (s.get(..2)?, s.get(2..)?);
        (head.eq_ignore_ascii_case(p) && !digits.starts_with('+'))
            .then(|| u64::from_str_radix(digits, r).ok())
            .flatten()
    };
    let n = if s.is_empty() {
        0.0
    } else if let Some(n) = radix("0x", 16).or(radix("0o", 8)).or(radix("0b", 2)) {
        n as f64
    } else {
        s.parse::<f64>().ok()?
    };
    n.is_finite().then(|| n.trunc() as i64)
}

/// Repeated, not comma-joined: a user agent contains commas. A lone empty value is no filter.
pub(super) fn devices(q: &[(String, String)]) -> Vec<String> {
    if scalar(q, "device") == Some("") {
        return vec![];
    }
    q.iter()
        .filter(|(k, v)| k == "device" && v.encode_utf16().count() <= 512)
        .map(|(_, v)| v.clone())
        .take(50)
        .collect()
}

fn days(q: &[(String, String)]) -> i64 {
    int(scalar(q, "days")).unwrap_or(7).clamp(1, 3650)
}

/// `floor` leaves a day of slack so the `lastSeenAt` index bounds the scan without cutting a
/// playback's early rows.
fn since(days: i64, floor: bool) -> DateTime<Utc> {
    let ms = now_ms() - days as f64 * 86_400_000.0 - if floor { 86_400_000.0 } else { 0.0 };
    super::at(ms)
}

fn read_settings(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Read, Subject::Settings)
}

#[utoipa::path(get, path = "/api/system/qoe/sessions", responses((status = 200)))]
pub async fn sessions(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Q,
) -> Result<Json<Value>, AppError> {
    read_settings(&a)?;
    let d = days(&q);
    let verdict = scalar(&q, "verdict").filter(|v| playbacks::is_verdict(v));
    // An id outside the int column range matches nothing instead of failing the query.
    let user_id =
        int(scalar(&q, "userId")).map(|n| n.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32);
    let devices = devices(&q);
    let page = store::page(
        &st.db,
        &store::PageFilter {
            floor: since(d, true),
            since: since(d, false),
            verdict,
            user_id,
            devices: &devices,
            limit: int(scalar(&q, "limit")).unwrap_or(50).clamp(1, 200),
            offset: int(scalar(&q, "offset")).unwrap_or(0).max(0),
        },
    )
    .await?;
    let total = page.first().map_or(0, |p| p.total);
    if page.is_empty() {
        return Ok(Json(json!({"items": [], "total": 0})));
    }
    let keys: std::collections::HashSet<_> = page.iter().map(|p| p.key.clone()).collect();
    let grouped: Vec<_> = page
        .iter()
        .filter_map(|p| Some((p.uid?, p.pid.clone()?)))
        .collect();
    let rows = store::rows_of(
        &st.db,
        &page.iter().map(|p| p.key.clone()).collect::<Vec<_>>(),
        &grouped.iter().map(|g| g.0).collect::<Vec<_>>(),
        &grouped.iter().map(|g| g.1.clone()).collect::<Vec<_>>(),
    )
    .await?
    .into_iter()
    .filter(|r| keys.contains(&playbacks::key(r)))
    .collect();
    let items: Vec<Value> = playbacks::merge_playbacks(rows)
        .iter()
        .map(playbacks::Playback::to_json)
        .collect();
    Ok(Json(json!({"items": items, "total": total})))
}

#[utoipa::path(get, path = "/api/system/qoe/sessions/{sessionId}", responses((status = 200), (status = 404)))]
pub async fn session(
    State(st): State<AppState>,
    a: Authed,
    PathParams(sid): PathParams<String>,
) -> Result<Json<Value>, AppError> {
    read_settings(&a)?;
    let anchor = store::anchor(&st.db, &sid)
        .await?
        .ok_or_else(|| AppError::not_found("qoe_session_not_found"))?;
    let mut rows = match (anchor.userId, anchor.playbackId.clone()) {
        (Some(u), Some(p)) => store::playback_rows(&st.db, u, &p).await?,
        _ => vec![anchor],
    };
    rows.sort_by_key(|r| r.startedAt);
    let events = store::events_of(
        &st.db,
        &rows.iter().map(|r| r.sessionId.clone()).collect::<Vec<_>>(),
    )
    .await?;
    let sessions = to_value(&rows).expect("rows");
    let mut v = playbacks::merge_playbacks(rows).remove(0).to_json();
    v["sessions"] = sessions;
    v["events"] = to_value(events).expect("events");
    Ok(Json(v))
}

#[utoipa::path(get, path = "/api/system/qoe/summary", responses((status = 200)))]
pub async fn summary(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Q,
) -> Result<Json<Value>, AppError> {
    read_settings(&a)?;
    let d = days(&q);
    let rows = store::summary_rows(&st.db, since(d, true), since(d, false)).await?;
    Ok(Json(playbacks::summary(&rows)))
}

/// The session a client reports on: presence when it knows it, else the tracker kept after the end.
/// The one place the ownership rule reads, so presence stays the source of truth.
pub fn session_ref(st: &AppState, sid: &str) -> Option<SessionRef> {
    st.presence
        .peek(sid)
        .map(|s| SessionRef::from(&s))
        .or_else(|| st.qoe.tracked_session(sid))
}

#[utoipa::path(post, path = "/api/playback/sessions/{sessionId}/events", responses((status = 204), (status = 403)))]
pub async fn events(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(sid): PathParams<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<StatusCode, AppError> {
    if !st.qoe.enabled() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let Some(live) = session_ref(&st, &sid) else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let me = Some(a.user.id);
    if live.user_id != me && live.attributed_user_id != me {
        return Err(AppError::forbidden("Not your session"));
    }
    let field = |k: &str| body.get(k).cloned().unwrap_or(Value::Null);
    let events = parse_events(&field("events"), now_ms(), parse_sent_at(&field("sentAt")));
    st.qoe
        .record_events(&live, &events, parse_playback_id(&field("playbackId")));
    Ok(StatusCode::NO_CONTENT)
}

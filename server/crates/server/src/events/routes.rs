use super::{Bus, Hub, Identity, Num, Subject, activity::List, sse};
use crate::{
    http::{
        AppError,
        auth::{Authed, SessionAuthed},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
    routing::{get, post},
};
use fliks_domain::acl::{Action, Subject as Resource};
use futures_util::stream;
use serde::Deserialize;
use serde_json::{Value, json};
use std::convert::Infallible;
use tokio::sync::broadcast::error::RecvError;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/system/events", get(events))
        .route("/api/system/activity", get(activity))
        .route("/internal/events", post(internal_emit))
        .route("/internal/events/stream", get(internal_stream))
        .route("/internal/events/progress", get(internal_progress))
        .route("/internal/activity", post(internal_activity))
        .route("/internal/activity/claim", post(internal_claim))
}

/// Parsed after the bearer check so an unauthenticated caller learns nothing about the shapes.
fn parse<T: serde::de::DeserializeOwned>(body: &[u8]) -> Result<T, AppError> {
    serde_json::from_slice(body).map_err(|e| AppError::bad_request(e.to_string()))
}

fn param(q: &[(String, String)], key: &str) -> Option<String> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

// Auth runs once at connect: a later token expiry or disable does not close the stream.
#[utoipa::path(get, path = "/api/system/events", responses((status = 200)))]
pub async fn events(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    headers: HeaderMap,
    Query(q): Query<Vec<(String, String)>>,
) -> Response {
    let identity = Identity {
        target_id: param(&q, "device"),
        form_factor: param(&q, "ff"),
        tv_platform: param(&q, "tvPlatform"),
        device_name: param(&q, "name"),
        user_agent: headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned),
    };
    let conn = st.hub.connect(a.user.id, identity);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CONNECTION, "keep-alive"),
            (
                header::CACHE_CONTROL,
                "private, no-cache, no-store, must-revalidate, max-age=0, no-transform",
            ),
            (header::PRAGMA, "no-cache"),
            (header::HeaderName::from_static("expire"), "0"),
            (header::HeaderName::from_static("x-accel-buffering"), "no"),
        ],
        Body::from_stream(sse::stream(conn)),
    )
        .into_response()
}

// `Number.parseInt(x, 10)` accepted only when finite and positive, else the default.
fn positive(q: &[(String, String)], key: &str, default: usize) -> usize {
    let Some(raw) = q
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.trim_start())
    else {
        return default;
    };
    let digits = raw.strip_prefix(['+', '-']).unwrap_or(raw);
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let n = digits[..end]
        .parse::<usize>()
        .unwrap_or(if end > 0 { usize::MAX } else { 0 });
    if raw.starts_with('-') || n == 0 {
        default
    } else {
        n
    }
}

#[utoipa::path(get, path = "/api/system/activity", responses((status = 200)))]
pub async fn activity(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<List>, AppError> {
    a.require(Action::Read, Resource::Settings)?;
    Ok(Json(
        st.hub
            .activity()
            .list(positive(&q, "page", 1), positive(&q, "limit", 25)),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Emit {
    #[serde(flatten)]
    bus: Bus,
    user_id: Option<i32>,
    user_ids: Option<Vec<i32>>,
}

/// Nest's `emit*` land here: no audience is a broadcast, `userId` is `emitToUser` (with the household
/// hook), `userIds` is `emitToUsers`.
async fn internal_emit(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, AppError> {
    st.bridge.check(&headers)?;
    let e: Emit = parse(&body)?;
    let hub: &Hub = &st.hub;
    match (e.bus, e.user_id, e.user_ids) {
        (Bus::Sse(ev), None, None) => hub.emit(ev),
        (Bus::Sse(ev), Some(user), None) => hub.emit_to_user(user, ev),
        (Bus::Sse(ev), None, Some(users)) => hub.emit_to_users(&users, ev),
        (Bus::Raw(r), None, users) if r.r#type.starts_with("plugin.") => {
            hub.emit_raw(&r.r#type, r.payload, users.as_deref());
        }
        (Bus::Domain(ev), None, None) => hub.emit_domain(ev),
        _ => return Err(AppError::bad_request("unsupported event audience")),
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Every event of both kinds as `data: {"kind","event"}`, for Nest's in-process subscribers.
async fn internal_stream(
    State(st): State<AppState>,
    headers: HeaderMap,
) -> Result<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>, AppError> {
    st.bridge.check(&headers)?;
    let state = (st.hub.subscribe(), st.hub.down());
    let events = stream::unfold(state, |(mut rx, mut down)| async move {
        loop {
            let got = tokio::select! {
                got = rx.recv() => got,
                _ = down.changed() => return None,
            };
            match got {
                Ok(bus) => {
                    let data = serde_json::to_string(&*bus).expect("typed event");
                    return Some((Ok(Event::default().data(data)), (rx, down)));
                }
                Err(RecvError::Lagged(n)) => {
                    tracing::warn!("internal event stream lagged: {n} events lost")
                }
                Err(RecvError::Closed) => return None,
            }
        }
    });
    Ok(Sse::new(events).keep_alive(KeepAlive::default()))
}

/// The plugin host's read of the replay cache: the downloads last stated for a media.
async fn internal_progress(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Value>, AppError> {
    st.bridge.check(&headers)?;
    let id = param(&q, "mediaId")
        .and_then(|v| v.parse::<i64>().ok())
        .ok_or_else(|| AppError::bad_request("mediaId must be an integer number"))?;
    Ok(Json(json!({"downloads": st.hub.progress_current(id)})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Running {
    id: String,
    r#type: String,
    subject: Option<Subject>,
    current: Option<Num>,
    total: Option<Num>,
    parent_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", rename_all_fields = "camelCase")]
enum ActivityOp {
    Pending {
        id: String,
        r#type: String,
        subject: Option<Subject>,
        parent_id: Option<String>,
    },
    Running(Running),
    Remove {
        id: String,
    },
}

/// `ActivityRegistryService`'s mutations from the Nest producers.
async fn internal_activity(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, AppError> {
    st.bridge.check(&headers)?;
    let op: ActivityOp = parse(&body)?;
    let a = st.hub.activity();
    match op {
        ActivityOp::Pending {
            id,
            r#type,
            subject,
            parent_id,
        } => a.upsert_pending(&id, &r#type, subject, parent_id),
        ActivityOp::Running(r) => {
            a.upsert_running(&r.id, &r.r#type, r.subject, r.current, r.total, r.parent_id);
        }
        ActivityOp::Remove { id } => a.remove(&id),
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Registers the work as running, or 409 when it already is (a duplicate rescan, refresh or sync).
async fn internal_claim(
    State(st): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, AppError> {
    st.bridge.check(&headers)?;
    let r: Running = parse(&body)?;
    let a = st.hub.activity();
    if a.claim(&r.id, &r.r#type, r.subject, r.current, r.total, r.parent_id) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::bare(StatusCode::CONFLICT))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(k: &str, v: &str) -> Vec<(String, String)> {
        vec![(k.into(), v.into())]
    }

    #[test]
    fn page_and_limit_parse_like_number_parse_int() {
        let p = |v: &str| positive(&q("page", v), "page", 7);
        assert_eq!(
            [
                p("3"),
                p("0"),
                p("-3"),
                p("abc"),
                p(""),
                p("1e3"),
                p(" 5"),
                p("+4"),
                p("2x")
            ],
            [3, 7, 7, 7, 7, 1, 5, 4, 2]
        );
        assert_eq!(positive(&[], "page", 1), 1);
        assert_eq!(p("99999999999999999999999"), usize::MAX);
    }
}

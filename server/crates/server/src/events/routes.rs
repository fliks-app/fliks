use super::{Identity, activity::List, sse, ticket::TTL as TICKET_TTL};
use crate::{
    http::{
        AppError,
        auth::{Authed, SessionAuthed, load_enabled},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use fliks_domain::acl::{Action, Subject as Resource};
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/system/events", get(events))
        .route("/api/system/events/ticket", post(event_ticket))
        .route("/api/system/activity", get(activity))
}

fn param(q: &[(String, String)], key: &str) -> Option<String> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

/// One-time URL credential for the events stream: native clients cannot set a header on `EventSource`.
#[utoipa::path(post, path = "/api/system/events/ticket", responses((status = 201)))]
pub async fn event_ticket(State(st): State<AppState>, SessionAuthed(a): SessionAuthed) -> Response {
    (
        StatusCode::CREATED,
        Json(json!({"ticket": st.sse_tickets.mint(a.user.id), "expiresIn": TICKET_TTL.as_secs()})),
    )
        .into_response()
}

// Auth runs once at connect: a later token expiry or disable does not close the stream. `?ticket=` is the
// credential of native clients; the session token (cookie, Bearer or `?token=`) stays accepted for released ones.
#[utoipa::path(get, path = "/api/system/events", responses((status = 200)))]
pub async fn events(
    State(st): State<AppState>,
    session: Result<SessionAuthed, AppError>,
    headers: HeaderMap,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Response, AppError> {
    let user_id = match param(&q, "ticket") {
        Some(ticket) => {
            let unauthorized = || AppError::bare(StatusCode::UNAUTHORIZED);
            let id = st.sse_tickets.redeem(&ticket).ok_or_else(unauthorized)?;
            load_enabled(&st.db, id)
                .await?
                .ok_or_else(unauthorized)?
                .0
                .id
        }
        None => session?.0.user.id,
    };
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
    let conn = st.hub.connect(user_id, identity);
    Ok((
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
        .into_response())
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

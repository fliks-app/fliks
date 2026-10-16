use super::{db, recommend};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use fliks_domain::acl::{Action, Subject};
use serde::Deserialize;
use serde_json::{Map, Value, json};

type Q = Query<Vec<(String, String)>>;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/playback/recommendations", get(recommendations))
        .route(
            "/api/playback/recommendations/{mediaId}/dismiss",
            post(dismiss),
        )
        .route(
            "/api/playback/recommendations/dismissed/count",
            get(dismissed_count),
        )
        .route(
            "/api/playback/recommendations/dismissed",
            delete(dismissed_reset),
        )
        .route("/api/playback/watched-ids", get(watched_ids))
        .route("/api/playback/continue-watching", get(continue_watching))
        .route("/api/playback/history", get(history))
        .route(
            "/api/playback/media/{mediaId}/watched-episodes",
            get(watched_episodes),
        )
        .route(
            "/api/playback/media/{mediaId}/episode-progress",
            get(episode_progress),
        )
        .route("/api/playback/media/{mediaId}", get(resume_info))
        .route(
            "/api/playback/media/{mediaId}/state",
            get(get_state).put(super::heartbeat).delete(delete_state),
        )
        .route("/api/playback/hide/{mediaId}", delete(hide))
        .route(
            "/api/playback/media/{mediaId}/toggle-watched",
            post(toggle_watched),
        )
        .route(
            "/api/playback/media/{mediaId}/toggle-series-watched",
            post(toggle_series_watched),
        )
        .route(
            "/api/playback/media/{mediaId}/seasons/{seasonId}/toggle-watched",
            post(toggle_season_watched),
        )
        .route("/internal/playback/history", get(internal_history))
        .route(
            "/internal/playback/recommendations",
            get(internal_recommendations),
        )
        .route("/internal/playback/top-genres", get(internal_top_genres))
}

fn param<'a>(q: &'a [(String, String)], key: &str) -> Option<&'a str> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// JS `parseInt(s, 10)`: `None` for NaN.
fn parse_int(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let (neg, digits) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    let n: i64 = digits[..end].parse().ok()?;
    Some(if neg { -n } else { n })
}

/// JS `Number(s) || default`, then `clamp`; a fractional result is a 400 (C1).
fn number_or(
    q: &[(String, String)],
    key: &str,
    default: f64,
    clamp: impl Fn(f64) -> f64,
) -> Result<i64, AppError> {
    let n = param(q, key).map(|s| s.trim()).map_or(0.0, |s| {
        if s.is_empty() {
            0.0
        } else {
            s.parse().unwrap_or(f64::NAN)
        }
    });
    let n = clamp(if n == 0.0 || !n.is_finite() {
        default
    } else {
        n
    });
    if n.fract() != 0.0 {
        return Err(AppError::bad_request(vec![format!(
            "{key} must be an integer number"
        )]));
    }
    Ok(n as i64)
}

fn history_window(q: &[(String, String)]) -> Result<(i64, i64), AppError> {
    let page = number_or(q, "page", 1.0, |n| n.max(1.0))?;
    let limit = number_or(q, "limit", 25.0, |n| n.clamp(1.0, 100.0))?;
    Ok((page, limit))
}

fn limit_param(q: &[(String, String)]) -> Option<usize> {
    param(q, "limit")
        .filter(|s| !s.is_empty())
        .map(|s| parse_int(s).filter(|n| *n != 0).unwrap_or(15).clamp(1, 50) as usize)
}

/// `libraryId` narrows the scope to itself when accessible, else to nothing (rules 1-2).
fn scope(accessible: Vec<i32>, q: &[(String, String)]) -> Vec<i32> {
    match param(q, "libraryId")
        .filter(|s| !s.is_empty())
        .and_then(parse_int)
        .filter(|n| *n != 0)
    {
        Some(id) if accessible.iter().any(|a| i64::from(*a) == id) => vec![id as i32],
        Some(_) => vec![],
        None => accessible,
    }
}

async fn libraries(st: &AppState, a: &Authed) -> Result<Vec<i32>, AppError> {
    let all = a.user.is_admin || a.perms.can(Action::Manage, &Subject::All);
    Ok(db::accessible_libraries(&st.db, a.user.id, all).await?)
}

/// `parseInt(episodeId)` when non-empty; NaN and 0 select the movie row (rule 5).
fn episode_param(q: &[(String, String)]) -> Option<i32> {
    param(q, "episodeId")
        .and_then(parse_int)
        .filter(|n| *n != 0)
        .map(|n| i32::try_from(n).unwrap_or(-1))
}

fn empty() -> Response {
    StatusCode::OK.into_response()
}

#[utoipa::path(get, path = "/api/playback/recommendations", responses((status = 200)))]
pub async fn recommendations(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Q,
) -> Result<Response, AppError> {
    let libs = scope(libraries(&st, &a).await?, &q);
    let items = recommend::recommendations(&st.db, a.user.id, &libs, limit_param(&q)).await?;
    Ok(Json(items).into_response())
}

#[utoipa::path(post, path = "/api/playback/recommendations/{mediaId}/dismiss", responses((status = 204)))]
pub async fn dismiss(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    db::dismiss(&st.db, a.user.id, media).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(get, path = "/api/playback/recommendations/dismissed/count", responses((status = 200)))]
pub async fn dismissed_count(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Value>, AppError> {
    Ok(Json(
        json!({"count": db::count_dismissals(&st.db, a.user.id).await?}),
    ))
}

#[utoipa::path(delete, path = "/api/playback/recommendations/dismissed", responses((status = 200)))]
pub async fn dismissed_reset(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Value>, AppError> {
    Ok(Json(
        json!({"removed": db::reset_dismissals(&st.db, a.user.id).await?}),
    ))
}

#[utoipa::path(get, path = "/api/playback/watched-ids", responses((status = 200)))]
pub async fn watched_ids(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<i32>>, AppError> {
    let libs = libraries(&st, &a).await?;
    Ok(Json(db::watched_media_ids(&st.db, a.user.id, &libs).await?))
}

#[utoipa::path(get, path = "/api/playback/continue-watching", responses((status = 200)))]
pub async fn continue_watching(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Q,
) -> Result<Json<Vec<db::ContinueItem>>, AppError> {
    let libs = scope(libraries(&st, &a).await?, &q);
    Ok(Json(db::continue_watching(&st.db, a.user.id, &libs).await?))
}

#[utoipa::path(get, path = "/api/playback/history", responses((status = 200)))]
pub async fn history(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Q,
) -> Result<Json<db::History>, AppError> {
    let (page, limit) = history_window(&q)?;
    let libs = libraries(&st, &a).await?;
    Ok(Json(
        db::history(&st.db, a.user.id, page, limit, &libs).await?,
    ))
}

#[utoipa::path(get, path = "/api/playback/media/{mediaId}/watched-episodes", responses((status = 200)))]
pub async fn watched_episodes(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
) -> Result<Json<Vec<i32>>, AppError> {
    Ok(Json(db::watched_episodes(&st.db, a.user.id, media).await?))
}

#[utoipa::path(get, path = "/api/playback/media/{mediaId}/episode-progress", responses((status = 200)))]
pub async fn episode_progress(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
) -> Result<Json<Map<String, Value>>, AppError> {
    let mut rows = db::episode_progress(&st.db, a.user.id, media).await?;
    rows.sort_by_key(|(id, _)| *id);
    Ok(Json(
        rows.into_iter()
            .map(|(id, p)| (id.to_string(), json!(p)))
            .collect(),
    ))
}

#[utoipa::path(get, path = "/api/playback/media/{mediaId}", responses((status = 200)))]
pub async fn resume_info(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
) -> Result<Response, AppError> {
    Ok(match db::resume_info(&st.db, a.user.id, media).await? {
        Some(info) => Json(info).into_response(),
        None => empty(),
    })
}

#[utoipa::path(get, path = "/api/playback/media/{mediaId}/state", responses((status = 200)))]
pub async fn get_state(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
    Query(q): Q,
) -> Result<Response, AppError> {
    let row = db::find_state(&st.db, a.user.id, media, episode_param(&q)).await?;
    Ok(row.map_or_else(empty, |r| Json(r).into_response()))
}

#[utoipa::path(delete, path = "/api/playback/media/{mediaId}/state", responses((status = 200)))]
pub async fn delete_state(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
    Query(q): Q,
) -> Result<Response, AppError> {
    db::delete_state(&st.db, a.user.id, media, episode_param(&q)).await?;
    Ok(empty())
}

#[utoipa::path(delete, path = "/api/playback/hide/{mediaId}", responses((status = 200)))]
pub async fn hide(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
) -> Result<Response, AppError> {
    db::hide(&st.db, a.user.id, media).await?;
    Ok(empty())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToggleBody {
    media_file_id: Option<i32>,
    episode_id: Option<i32>,
}

#[derive(Deserialize)]
pub struct WatchedBody {
    #[serde(default)]
    watched: Value,
}

/// JS truthiness of `!!body.watched`.
impl WatchedBody {
    fn on(&self) -> bool {
        match &self.watched {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
            Value::String(s) => !s.is_empty(),
            _ => true,
        }
    }
}

#[utoipa::path(post, path = "/api/playback/media/{mediaId}/toggle-watched", responses((status = 201)))]
pub async fn toggle_watched(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
    ValidJson(body): ValidJson<ToggleBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let episode = body.episode_id.filter(|e| *e != 0);
    let saved = db::toggle_watched(&st.db, a.user.id, media, body.media_file_id, episode).await?;
    Ok((StatusCode::CREATED, Json(saved)))
}

#[utoipa::path(post, path = "/api/playback/media/{mediaId}/toggle-series-watched", responses((status = 201)))]
pub async fn toggle_series_watched(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
    ValidJson(body): ValidJson<WatchedBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    db::toggle_series_watched(&st.db, a.user.id, media, body.on()).await?;
    Ok((StatusCode::CREATED, Json(json!({"watched": body.on()}))))
}

#[utoipa::path(post, path = "/api/playback/media/{mediaId}/seasons/{seasonId}/toggle-watched", responses((status = 201)))]
pub async fn toggle_season_watched(
    State(st): State<AppState>,
    a: Authed,
    PathParams((media, season)): PathParams<(i32, i32)>,
    ValidJson(body): ValidJson<WatchedBody>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    if !db::media_exists(&st.db, media).await? {
        return Err(AppError::not_found("not_found"));
    }
    if db::season_media(&st.db, season)
        .await?
        .is_some_and(|m| m != Some(media))
    {
        return Err(AppError::not_found("not_found"));
    }
    db::toggle_season_watched(&st.db, a.user.id, media, season, body.on()).await?;
    Ok((StatusCode::CREATED, Json(json!({"watched": body.on()}))))
}

/// Nest social's reads (`docs/bridge.md`): `userId` and, where it scopes, `libraryIds` (comma list).
fn bridge_user(
    st: &AppState,
    headers: &HeaderMap,
    q: &[(String, String)],
) -> Result<i32, AppError> {
    st.bridge.check(headers)?;
    param(q, "userId")
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| AppError::bad_request("userId must be an integer number"))
}

fn bridge_libraries(q: &[(String, String)]) -> Result<Vec<i32>, AppError> {
    param(q, "libraryIds")
        .unwrap_or_default()
        .split(',')
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.parse()
                .map_err(|_| AppError::bad_request("libraryIds must be integers"))
        })
        .collect()
}

async fn internal_history(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Q,
) -> Result<Json<db::History>, AppError> {
    let user = bridge_user(&st, &headers, &q)?;
    let (page, limit) = history_window(&q)?;
    let libs = bridge_libraries(&q)?;
    Ok(Json(db::history(&st.db, user, page, limit, &libs).await?))
}

async fn internal_recommendations(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Q,
) -> Result<Response, AppError> {
    let user = bridge_user(&st, &headers, &q)?;
    let libs = bridge_libraries(&q)?;
    let items = recommend::recommendations(&st.db, user, &libs, limit_param(&q)).await?;
    Ok(Json(items).into_response())
}

async fn internal_top_genres(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Q,
) -> Result<Response, AppError> {
    let user = bridge_user(&st, &headers, &q)?;
    let limit = param(&q, "limit").and_then(|v| v.parse().ok()).unwrap_or(8);
    Ok(Json(recommend::top_genres(&st.db, user, limit).await?).into_response())
}

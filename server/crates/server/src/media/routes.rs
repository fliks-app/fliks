use super::{
    acl::{accessible_library_ids, assert_media_accessible, can_see_paths},
    aggregates, calendar as cal, hydrate, list,
    params::{Calendar, Recent, Search, bare},
    related, streams, tracking,
};
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use fliks_domain::{
    acl::{Action, Subject},
    media::query::js_number,
};
use serde_json::{Value, json};

type Pairs = Query<Vec<(String, String)>>;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/media", get(find))
        .route("/api/media/recently-added", get(recent))
        .route("/api/media/counts", get(count))
        .route("/api/media/counts-by-library", get(count_by_library))
        .route("/api/media/qualities", get(quality_table))
        .route("/api/media/genres", get(genre_list))
        .route("/api/media/collections", get(collection_list))
        .route("/api/media/calendar", get(calendar_entries))
        .route("/api/media/{id}", get(get_media))
        .route("/api/media/{id}/tracking", get(track))
        .route("/api/media/{id}/similar", get(similar_media))
        .route("/api/media/{id}/collection", get(media_collection))
        .route("/api/media/{id}/cast", get(media_cast))
        .route("/api/media/{id}/crew", get(media_crew))
        .route("/api/media/{id}/streams/{mediaFileId}", get(media_streams))
}

/// Guards run before the pipes: 401, then 403, then the id's 400, then the library ACL's 404.
async fn gate(
    st: &AppState,
    a: &Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<(i32, Vec<i32>), AppError> {
    a.require(Action::Read, Subject::Media)?;
    let PathParams(id) = id?;
    let ids = accessible_library_ids(&st.db, a).await?;
    assert_media_accessible(&st.db, id, &ids).await?;
    Ok((id, ids))
}

#[utoipa::path(get, path = "/api/media", responses((status = 200)))]
pub async fn find(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Pairs,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let p = Search::parse(&q)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    let page = list::find_all(&st.db, &p, &ids, a.user.id, can_see_paths(&a)).await?;
    Ok(Json(json!({"data": page.data, "total": page.total})))
}

#[utoipa::path(get, path = "/api/media/recently-added", responses((status = 200)))]
pub async fn recent(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Pairs,
) -> Result<Json<Vec<Value>>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let p = Recent::parse(&q)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    Ok(Json(
        list::recently_added(&st.db, &p, &ids, a.user.id, can_see_paths(&a)).await?,
    ))
}

#[utoipa::path(get, path = "/api/media/counts", responses((status = 200)))]
pub async fn count(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    Ok(Json(aggregates::counts(&st.db, &ids).await?))
}

#[utoipa::path(get, path = "/api/media/counts-by-library", responses((status = 200)))]
pub async fn count_by_library(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<aggregates::ByLibrary>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    Ok(Json(aggregates::counts_by_library(&st.db, &ids).await?))
}

#[utoipa::path(get, path = "/api/media/qualities", responses((status = 200)))]
pub async fn quality_table(a: Authed) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    Ok(Json(aggregates::qualities()))
}

#[utoipa::path(get, path = "/api/media/genres", responses((status = 200)))]
pub async fn genre_list(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Pairs,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    let scope = aggregates::scope(&ids, bare(&q, "libraryId").as_deref());
    if scope.is_empty() {
        return Ok(Json(json!([])));
    }
    Ok(Json(aggregates::genres(&st.db, &scope).await?))
}

#[utoipa::path(get, path = "/api/media/collections", responses((status = 200)))]
pub async fn collection_list(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Pairs,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    let scope = aggregates::scope(&ids, bare(&q, "libraryId").as_deref());
    if scope.is_empty() {
        return Ok(Json(json!([])));
    }
    Ok(Json(aggregates::collections(&st.db, &scope).await?))
}

#[utoipa::path(get, path = "/api/media/calendar", responses((status = 200)))]
pub async fn calendar_entries(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Pairs,
) -> Result<Json<Vec<Value>>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let p = Calendar::parse(&q)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    Ok(Json(cal::calendar(&st.db, &p, &ids, a.user.id).await?))
}

#[utoipa::path(get, path = "/api/media/{id}/tracking", responses((status = 200)))]
pub async fn track(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    let (id, _) = gate(&st, &a, id).await?;
    tracking::tracking(&st.db, id)
        .await?
        .map(Json)
        .ok_or_else(|| super::acl::not_found(id))
}

#[utoipa::path(get, path = "/api/media/{id}", responses((status = 200)))]
pub async fn get_media(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    let (id, _) = gate(&st, &a, id).await?;
    hydrate::detail(&st.db, id, can_see_paths(&a))
        .await?
        .map(Json)
        .ok_or_else(|| super::acl::not_found(id))
}

/// `Number(limit)`: finite and above 0 caps at 30, anything else is 12 (rule 53).
fn similar_limit(q: &[(String, String)]) -> usize {
    match bare(q, "limit")
        .and_then(|l| js_number(&l))
        .filter(|n| n.is_finite() && *n > 0.0)
    {
        Some(n) => n.min(30.0) as usize,
        None => 12,
    }
}

#[utoipa::path(get, path = "/api/media/{id}/similar", responses((status = 200)))]
pub async fn similar_media(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    Query(q): Pairs,
) -> Result<Json<Vec<Value>>, AppError> {
    let (id, _) = gate(&st, &a, id).await?;
    Ok(Json(related::similar(&st.db, id, similar_limit(&q)).await?))
}

#[utoipa::path(get, path = "/api/media/{id}/collection", responses((status = 200)))]
pub async fn media_collection(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Response, AppError> {
    let (id, _) = gate(&st, &a, id).await?;
    Ok(match related::collection(&st.db, id).await? {
        Some(c) => Json(c).into_response(),
        None => StatusCode::OK.into_response(),
    })
}

#[utoipa::path(get, path = "/api/media/{id}/cast", responses((status = 200)))]
pub async fn media_cast(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Vec<Value>>, AppError> {
    let (id, _) = gate(&st, &a, id).await?;
    Ok(Json(related::cast(&st.db, id).await?))
}

#[utoipa::path(get, path = "/api/media/{id}/crew", responses((status = 200)))]
pub async fn media_crew(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Vec<Value>>, AppError> {
    let (id, _) = gate(&st, &a, id).await?;
    Ok(Json(related::crew(&st.db, id).await?))
}

#[utoipa::path(get, path = "/api/media/{id}/streams/{mediaFileId}", responses((status = 200)))]
pub async fn media_streams(
    State(st): State<AppState>,
    a: Authed,
    ids: Result<PathParams<(i32, i32)>, AppError>,
) -> Result<Json<Vec<Value>>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let PathParams((id, file)) = ids?;
    let libs = accessible_library_ids(&st.db, &a).await?;
    assert_media_accessible(&st.db, id, &libs).await?;
    Ok(Json(streams::streams(&st, id, file).await?))
}

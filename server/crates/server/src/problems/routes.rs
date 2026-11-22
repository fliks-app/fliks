//! `/api/problems/*` and `POST /api/media/{id}/problems` handlers.
use super::flow::{self, Close, CommentBody, Create, Reopen, Res, Resolve};
use crate::{
    http::{
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use fliks_domain::acl::{Action, Subject};
use serde_json::Value;

type Pairs = Query<Vec<(String, String)>>;

fn created<T: serde::Serialize>(v: T) -> (StatusCode, Json<T>) {
    (StatusCode::CREATED, Json(v))
}

#[utoipa::path(post, path = "/api/media/{id}/problems", responses((status = 201), (status = 409)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
    ValidJson(body): ValidJson<Create>,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Read, Subject::Media)?;
    Ok(created(flow::create(&st, &a, media, body).await?))
}

#[utoipa::path(get, path = "/api/problems", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res<Json<Value>> {
    Ok(Json(flow::list(&st, &a, flow::list_query(&q)?).await?))
}

#[utoipa::path(get, path = "/api/problems/{id}", responses((status = 200), (status = 404)))]
pub async fn get_one(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Res<Json<Value>> {
    Ok(Json(flow::detail(&st, &a, id).await?))
}

#[utoipa::path(post, path = "/api/problems/{id}/resolve", responses((status = 201), (status = 409)))]
pub async fn resolve(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(body): ValidJson<Resolve>,
) -> Res<(StatusCode, Json<Value>)> {
    Ok(created(flow::resolve(&st, &a, id, body).await?))
}

#[utoipa::path(post, path = "/api/problems/{id}/close", responses((status = 201), (status = 409)))]
pub async fn close(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(body): ValidJson<Close>,
) -> Res<(StatusCode, Json<Value>)> {
    Ok(created(flow::close(&st, &a, id, body).await?))
}

#[utoipa::path(post, path = "/api/problems/{id}/reopen", responses((status = 201), (status = 409)))]
pub async fn reopen(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(body): ValidJson<Reopen>,
) -> Res<(StatusCode, Json<Value>)> {
    Ok(created(flow::reopen(&st, &a, id, body).await?))
}

#[utoipa::path(delete, path = "/api/problems/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Res<StatusCode> {
    flow::remove(&st, &a, id).await?;
    Ok(StatusCode::OK)
}

#[utoipa::path(get, path = "/api/problems/{id}/comments", responses((status = 200)))]
pub async fn comments_list(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Res<Json<Vec<Value>>> {
    Ok(Json(flow::comments(&st, &a, id).await?))
}

#[utoipa::path(post, path = "/api/problems/{id}/comments", responses((status = 201)))]
pub async fn comment_create(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(body): ValidJson<CommentBody>,
) -> Res<(StatusCode, Json<Value>)> {
    Ok(created(flow::comment_add(&st, &a, id, body).await?))
}

#[utoipa::path(delete, path = "/api/problems/comments/{commentId}", responses((status = 200)))]
pub async fn comment_remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Res<StatusCode> {
    flow::comment_remove(&st, &a, id).await?;
    Ok(StatusCode::OK)
}

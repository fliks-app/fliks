//! `/api/requests/*` handlers; the policy check comes first, then the pipes, then the flow.
use super::{
    dto,
    flow::{self, Res},
};
use crate::{
    http::{
        auth::Authed,
        validate::{PathParams, ValidJson, int_param},
    },
    state::AppState,
};
use axum::{
    Json,
    extract::{FromRequest, Query, Request, State},
    http::StatusCode,
};
use fliks_domain::acl::{Action, Subject};
use serde_json::Value;

type Pairs = Query<Vec<(String, String)>>;

/// Body parsing after the policy and id checks, as Nest's guards run before its pipes.
async fn body(req: Request) -> Res<Value> {
    let ValidJson(v) = ValidJson::<Value>::from_request(req, &()).await?;
    Ok(v)
}

fn created<T: serde::Serialize>(v: T) -> (StatusCode, Json<T>) {
    (StatusCode::CREATED, Json(v))
}

#[utoipa::path(post, path = "/api/requests", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Create, Subject::FliksRequest)?;
    let dto = dto::create_request(body(req).await?)?;
    Ok(created(flow::create(&st, &a, dto).await?))
}

#[utoipa::path(get, path = "/api/requests", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res<Json<Value>> {
    a.require(Action::Read, Subject::FliksRequest)?;
    Ok(Json(flow::list(&st, &a, dto::list(&q)?).await?))
}

#[utoipa::path(get, path = "/api/requests/title-state", responses((status = 200)))]
pub async fn title_state(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Pairs,
) -> Res<Json<Value>> {
    a.require(Action::Create, Subject::FliksRequest)?;
    let (tmdb_id, media_type) = dto::title_state(&q)?;
    Ok(Json(flow::title_state(&st, tmdb_id, &media_type).await?))
}

#[utoipa::path(get, path = "/api/requests/{id}", responses((status = 200)))]
pub async fn get_one(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<Json<Value>> {
    a.require(Action::Read, Subject::FliksRequest)?;
    let row = flow::gate(&st, &a, int_param(&id)?).await?;
    Ok(Json(Value::Object(flow::detail(&st, &a, &row).await?)))
}

#[utoipa::path(patch, path = "/api/requests/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
    req: Request,
) -> Res<Json<Value>> {
    a.require(Action::Update, Subject::FliksRequest)?;
    let id = int_param(&id)?;
    let dto = dto::update_request(body(req).await?)?;
    Ok(Json(flow::update(&st, &a, id, dto).await?))
}

#[utoipa::path(delete, path = "/api/requests/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<StatusCode> {
    a.require(Action::Delete, Subject::FliksRequest)?;
    flow::remove(&st, &a, int_param(&id)?).await?;
    Ok(StatusCode::OK)
}

#[utoipa::path(post, path = "/api/requests/{id}/approve", responses((status = 201)))]
pub async fn approve(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Approve, Subject::FliksRequest)?;
    Ok(created(flow::approve(&st, &a, int_param(&id)?).await?))
}

#[utoipa::path(post, path = "/api/requests/{id}/decline", responses((status = 201)))]
pub async fn decline(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
    req: Request,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Decline, Subject::FliksRequest)?;
    let id = int_param(&id)?;
    let reason = dto::decline(body(req).await?)?;
    Ok(created(flow::decline(&st, &a, id, reason).await?))
}

#[utoipa::path(post, path = "/api/requests/{id}/comments", responses((status = 201)))]
pub async fn comment_create(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
    req: Request,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Read, Subject::FliksRequest)?;
    let id = int_param(&id)?;
    let message = dto::comment(body(req).await?)?;
    Ok(created(flow::comment_add(&st, &a, id, &message).await?))
}

#[utoipa::path(get, path = "/api/requests/{id}/comments", responses((status = 200)))]
pub async fn comments_list(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<Json<Vec<Value>>> {
    a.require(Action::Read, Subject::FliksRequest)?;
    Ok(Json(flow::comments(&st, &a, int_param(&id)?).await?))
}

#[utoipa::path(delete, path = "/api/requests/comments/{commentId}", responses((status = 200)))]
pub async fn comment_remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<StatusCode> {
    a.require(Action::Read, Subject::FliksRequest)?;
    flow::comment_remove(&st, &a, int_param(&id)?).await?;
    Ok(StatusCode::OK)
}

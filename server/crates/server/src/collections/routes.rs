use super::service;
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    libraries::accessible_library_ids,
    media::{
        aggregates,
        params::{Reader, paging_of},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use fliks_domain::acl::{Action, Subject};
use serde_json::Value;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/collections", get(list))
        .route("/api/collections/{id}", get(detail))
}

#[utoipa::path(get, path = "/api/collections", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Vec<Value>>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let mut r = Reader::new(&q, &["libraryId", "kind", "q", "page", "limit"]);
    let (library, kind, name) = (r.int("libraryId"), r.kind("kind"), r.string("q"));
    let (page, limit) = (r.number("page"), r.number("limit"));
    r.finish()?;
    if page.is_some_and(|p| p < 1.0) {
        return Err(AppError::bad_request(vec![
            "page must not be less than 1".to_owned(),
        ]));
    }
    let paging = paging_of(page, limit, 0.0)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    let scope = aggregates::scope(&ids, library.map(|l| l.to_string()).as_deref());
    Ok(Json(
        service::list(&st.db, &scope, kind, name.as_deref(), paging).await?,
    ))
}

#[utoipa::path(get, path = "/api/collections/{id}", responses((status = 200)))]
pub async fn detail(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Media)?;
    let id = id?.0;
    let acl = accessible_library_ids(&st.db, &a).await?;
    service::detail(&st.db, id, a.user.id, &acl)
        .await?
        .map(Json)
        .ok_or_else(|| AppError::not_found(format!("Collection #{id} not found")))
}

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
use fliks_domain::{
    acl::{Action, Subject},
    persons::tsquery,
};
use serde_json::Value;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/persons", get(list))
        .route("/api/persons/search", get(search))
        .route("/api/persons/{id}", get(detail))
        .route("/api/persons/{id}/provider-credits", get(provider_credits))
        .route("/api/persons/{id}/works", get(works))
}

type Res = Result<Json<Value>, AppError>;

#[utoipa::path(get, path = "/api/persons/search", responses((status = 200)))]
pub async fn search(
    State(st): State<AppState>,
    _a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Res {
    let mut qs = q.iter().filter(|(k, _)| k == "q");
    let q = match (qs.next(), qs.next()) {
        (_, Some(_)) => return Err(AppError::bad_request(vec!["q must be a string"])),
        (Some((_, v)), None) => v.trim(),
        _ => "",
    };
    Ok(Json(Value::Array(service::search(&st.db, q).await?)))
}

#[utoipa::path(get, path = "/api/persons/{id}", responses((status = 200)))]
pub async fn detail(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    Ok(Json(service::detail(&st, &a, id?.0).await?))
}

#[utoipa::path(get, path = "/api/persons/{id}/provider-credits", responses((status = 200)))]
pub async fn provider_credits(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    Ok(Json(service::provider_credits(&st, &a, id?.0).await?))
}

const ROLES: [&str; 2] = ["author", "narrator"];

/// `role` is required: a missing one is the same 400 as a wrong one.
fn role_of(r: &mut Reader) -> Option<String> {
    let role = r.one_of("role", &ROLES);
    if r.all("role").is_empty() {
        r.errors.push(format!(
            "role must be one of the following values: {}",
            ROLES.join(", ")
        ));
    }
    role
}

#[utoipa::path(get, path = "/api/persons", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Res {
    a.require(Action::Read, Subject::Media)?;
    let mut r = Reader::new(&q, &["role", "libraryId", "q", "sortBy", "page", "limit"]);
    let role = role_of(&mut r);
    let (library, name) = (r.int("libraryId"), r.string("q"));
    let sort = r.one_of("sortBy", &["name", "works"]);
    let (page, limit) = (r.number("page"), r.number("limit"));
    r.finish()?;
    if page.is_some_and(|p| p < 1.0) {
        return Err(AppError::bad_request(vec![
            "page must not be less than 1".to_owned(),
        ]));
    }
    let (Some(role), paging) = (role, paging_of(page, limit, 0.0)?) else {
        return Ok(Json(Value::Array(vec![])));
    };
    let name = name.as_deref().map(str::trim).filter(|q| !q.is_empty());
    let tsq = name.map(tsquery);
    if matches!(tsq, Some(None)) {
        return Ok(Json(Value::Array(vec![])));
    }
    let acl = accessible_library_ids(&st.db, &a).await?;
    let scope = aggregates::scope(&acl, library.map(|l| l.to_string()).as_deref());
    let by_works = sort.as_deref() == Some("works");
    let tsq = tsq.flatten();
    Ok(Json(Value::Array(
        service::people(
            &st.db,
            &role,
            &scope,
            &acl,
            tsq.as_deref(),
            by_works,
            paging,
        )
        .await?,
    )))
}

#[utoipa::path(get, path = "/api/persons/{id}/works", responses((status = 200)))]
pub async fn works(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    Query(q): Query<Vec<(String, String)>>,
) -> Res {
    a.require(Action::Read, Subject::Media)?;
    let id = id?.0;
    let mut r = Reader::new(&q, &["role"]);
    let role = role_of(&mut r);
    r.finish()?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let role = role.unwrap_or_default();
    Ok(Json(
        service::works(&st.db, id, &role, a.user.id, &acl).await?,
    ))
}

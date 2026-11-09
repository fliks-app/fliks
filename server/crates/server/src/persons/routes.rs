use super::service;
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
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
    http::StatusCode,
    routing::{get, post},
};
use fliks_domain::{
    acl::{Action, Subject},
    external_id::Namespace,
    media::kind::MediaKind,
    persons::tsquery,
};
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/persons", get(list))
        .route("/api/persons/search", get(search))
        .route("/api/persons/resolve", post(resolve))
        .route("/api/persons/{id}", get(detail))
        .route("/api/persons/{id}/provider-credits", get(provider_credits))
        .route("/api/persons/{id}/bibliography", get(bibliography))
        .route("/api/persons/{id}/works", get(works))
        .route("/api/persons/{id}/discography", get(discography))
}

type Res = Result<Json<Value>, AppError>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveDto {
    provider: String,
    external_id: String,
}

/// `POST /api/persons/resolve` (`docs/spec/persons.md`): the person of a provider's artist, created when new.
#[utoipa::path(post, path = "/api/persons/resolve", responses((status = 200)))]
pub async fn resolve(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(dto): ValidJson<ResolveDto>,
) -> Res {
    a.require(Action::Create, Subject::Media)?;
    let known = st.namespaces();
    let ns = known
        .parse(&dto.provider)
        .filter(|n| {
            *n == Namespace::MUSICBRAINZ
                && !st
                    .metadata
                    .person_providers(MediaKind::Album, *n)
                    .is_empty()
        })
        .ok_or_else(|| {
            AppError::bad_request(format!(
                "provider must be one of the following values: {}",
                dto.provider
            ))
        })?;
    let id = known.normalize(ns, dto.external_id.trim()).ok_or_else(|| {
        AppError::bad_request(vec![format!("externalId is not a {} id", dto.provider)])
    })?;
    let artist = service::provider_artist(&st, &id).await?;
    let name = artist
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| {
            AppError::with_message(StatusCode::BAD_GATEWAY, "the provider named no artist")
        })?;
    let mut tx = st.db.begin().await?;
    let person = crate::metadata::music::people::person_of_id(
        &mut tx,
        name,
        &id,
        artist
            .sort_name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty()),
    )
    .await?;
    tx.commit().await?;
    Ok(Json(json!({"id": person})))
}

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

#[utoipa::path(get, path = "/api/persons/{id}/bibliography", responses((status = 200)))]
pub async fn bibliography(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    a.require(Action::Read, Subject::Media)?;
    Ok(Json(service::bibliography(&st, &a, id?.0).await?))
}

const ROLES: [&str; 2] = ["author", "narrator"];
const LIST_ROLES: [&str; 4] = ["author", "narrator", "artist", "composer"];

/// `role` is required: a missing one is the same 400 as a wrong one.
fn role_of(r: &mut Reader, roles: &[&str]) -> Option<String> {
    let role = r.one_of("role", roles);
    if r.all("role").is_empty() {
        r.errors.push(format!(
            "role must be one of the following values: {}",
            roles.join(", ")
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
    let role = role_of(&mut r, &LIST_ROLES);
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
    let music = matches!(role.as_str(), "artist" | "composer");
    if !a.kinds.has(if music {
        MediaKind::Album
    } else {
        MediaKind::Book
    }) {
        return Ok(Json(Value::Array(vec![])));
    }
    let acl = accessible_library_ids(&st.db, &a).await?;
    let scope = aggregates::scope(&acl, library.map(|l| l.to_string()).as_deref());
    let by_works = sort.as_deref() == Some("works");
    let tsq = tsq.flatten();
    if music {
        return Ok(Json(Value::Array(
            service::music_people(
                &st.db,
                &role,
                &scope,
                &acl,
                tsq.as_deref(),
                by_works,
                paging,
            )
            .await?,
        )));
    }
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
    let role = role_of(&mut r, &ROLES);
    r.finish()?;
    let acl = if a.kinds.has(MediaKind::Book) {
        accessible_library_ids(&st.db, &a).await?
    } else {
        vec![]
    };
    let role = role.unwrap_or_default();
    Ok(Json(
        service::works(&st.db, id, &role, a.user.id, &acl).await?,
    ))
}

#[utoipa::path(get, path = "/api/persons/{id}/discography", responses((status = 200)))]
pub async fn discography(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    a.require(Action::Read, Subject::Media)?;
    Ok(Json(service::discography(&st, &a, id?.0).await?))
}

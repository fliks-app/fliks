//! `/api/cleanup/*` and `GET /api/media/leaving-soon` (`cleanup.md` routes table).
use super::{
    db::{self, Scope},
    dto, job, rules,
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::{accessible_library_ids, assert_media_accessible, paths_visible},
    media::hydrate,
    state::AppState,
};
use axum::{
    Json,
    extract::{FromRequest, Query, Request, State},
    http::StatusCode,
};
use fliks_domain::acl::{Action, Subject};
use serde::Deserialize;
use serde_json::{Value, json};

type Res<T> = Result<T, AppError>;

fn rule_not_found(id: i32) -> AppError {
    AppError::not_found(format!("Rule #{id} not found"))
}

#[derive(Deserialize)]
pub struct ScopeQuery {
    #[serde(rename = "seasonId")]
    season_id: Option<i32>,
    #[serde(rename = "episodeId")]
    episode_id: Option<i32>,
}

async fn scope(st: &AppState, media_id: i32, q: &ScopeQuery) -> Res<Scope> {
    db::resolve_scope(&st.db, media_id, q.season_id, q.episode_id)
        .await?
        .ok_or_else(|| match q.episode_id {
            Some(e) => AppError::not_found(format!("Episode #{e} not found")),
            None => AppError::not_found(format!("Season #{} not found", q.season_id.unwrap_or(0))),
        })
}

async fn body(req: Request) -> Res<dto::Rule> {
    let ValidJson(v) = ValidJson::<Value>::from_request(req, &()).await?;
    dto::rule(v)
}

#[utoipa::path(get, path = "/api/cleanup/rules", responses((status = 200)))]
pub async fn rule_list(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Value>>> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(db::rule_list(&st.db).await?))
}

#[utoipa::path(post, path = "/api/cleanup/rules", responses((status = 201)))]
pub async fn rule_create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let r = body(req).await?;
    Ok((
        StatusCode::CREATED,
        Json(db::rule_insert(&st.db, &r).await?),
    ))
}

#[utoipa::path(get, path = "/api/cleanup/rules/{id}", responses((status = 200)))]
pub async fn rule_get(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Res<Json<Value>> {
    a.require(Action::Read, Subject::Settings)?;
    db::rule_find(&st.db, id)
        .await?
        .map(Json)
        .ok_or_else(|| rule_not_found(id))
}

#[utoipa::path(put, path = "/api/cleanup/rules/{id}", responses((status = 200)))]
pub async fn rule_update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    req: Request,
) -> Res<Json<Value>> {
    a.require(Action::Manage, Subject::Settings)?;
    let r = body(req).await?;
    db::rule_update(&st.db, id, &r)
        .await?
        .map(Json)
        .ok_or_else(|| rule_not_found(id))
}

#[utoipa::path(delete, path = "/api/cleanup/rules/{id}", responses((status = 200)))]
pub async fn rule_remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Res<StatusCode> {
    a.require(Action::Manage, Subject::Settings)?;
    if !db::rule_delete(&st.db, id).await? {
        return Err(rule_not_found(id));
    }
    Ok(StatusCode::OK)
}

#[utoipa::path(post, path = "/api/cleanup/rules/{id}/preview", responses((status = 200)))]
pub async fn rule_preview(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Res<Json<Value>> {
    a.require(Action::Manage, Subject::Settings)?;
    let r = db::rule_row(&st.db, id)
        .await?
        .ok_or_else(|| rule_not_found(id))?;
    let matches = rules::matched(&st.db, &r.criteria.0, &r.level, &r.action).await?;
    let total: i64 = matches.iter().map(|m| m.size).sum();
    Ok(Json(json!({"matches": matches, "totalSize": total})))
}

#[utoipa::path(get, path = "/api/cleanup/candidates", responses((status = 200)))]
pub async fn candidate_list(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Value>>> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(db::candidates(&st.db).await?))
}

#[utoipa::path(post, path = "/api/cleanup/candidates/{mediaId}/delete-now", responses((status = 200)))]
pub async fn candidate_delete_now(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media_id): PathParams<i32>,
    Query(q): Query<ScopeQuery>,
) -> Res<Json<Value>> {
    a.require(Action::Delete, Subject::Media)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    assert_media_accessible(&st.db, media_id, &ids).await?;
    let scope = scope(&st, media_id, &q).await?;
    let (action, delete_series_when_empty) = db::candidate_action(&st.db, media_id, scope)
        .await?
        .ok_or_else(|| dto::not_candidate(media_id))?;
    // a flag-only rule has no action of its own: an explicit delete-now removes the media
    let action = if action == "none" { "delete" } else { &action };
    job::act(&st, media_id, scope, action, delete_series_when_empty)
        .await
        .map_err(AppError::internal)?;
    Ok(Json(json!({"ok": true})))
}

#[utoipa::path(post, path = "/api/cleanup/exclusions/{mediaId}", responses((status = 201)))]
pub async fn exclusion_add(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media_id): PathParams<i32>,
    Query(q): Query<ScopeQuery>,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    assert_media_accessible(&st.db, media_id, &ids).await?;
    let scope = scope(&st, media_id, &q).await?;
    db::exclude(&st.db, media_id, scope, a.user.id).await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"mediaId": media_id, "seasonId": scope.season, "episodeId": scope.episode})),
    ))
}

#[utoipa::path(delete, path = "/api/cleanup/exclusions/{mediaId}", responses((status = 200)))]
pub async fn exclusion_remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media_id): PathParams<i32>,
    Query(q): Query<ScopeQuery>,
) -> Res<StatusCode> {
    a.require(Action::Manage, Subject::Settings)?;
    let scope = scope(&st, media_id, &q).await?;
    if !db::unexclude(&st.db, media_id, scope).await? {
        return Err(AppError::not_found(format!(
            "Media #{media_id} is not excluded"
        )));
    }
    Ok(StatusCode::OK)
}

#[utoipa::path(get, path = "/api/media/leaving-soon", responses((status = 200)))]
pub async fn leaving_soon(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Value>>> {
    a.require(Action::Read, Subject::Media)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    let rows: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT m.id, iso_ms(c."deleteAt") FROM cleanup_candidates c JOIN media m ON m.id = c."mediaId"
        WHERE c."deleteAt" IS NOT NULL AND c."seasonId" IS NULL AND m."libraryId" = ANY($1) ORDER BY c."deleteAt", m.id"#,
    )
    .bind(&ids)
    .fetch_all(&st.db)
    .await?;
    let page: Vec<i32> = rows.iter().map(|r| r.0).collect();
    let mut items = hydrate::items(&st.db, &page, paths_visible(&a.perms)).await?;
    for (item, (_, at)) in items.iter_mut().zip(&rows) {
        item["deleteAt"] = json!(at);
    }
    Ok(Json(items))
}

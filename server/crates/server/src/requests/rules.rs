//! Auto-approval rules: matching (rule 29) and `/api/auto-approval-rules` (rules 28, 30, 31).
use super::{
    db,
    dto::{self, CreateRequest},
    flow::Res,
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, int_param},
    },
    state::AppState,
};
use axum::{
    Json,
    extract::{FromRequest, Request, State},
    http::StatusCode,
};
use fliks_domain::acl::{Action, Subject};
use serde_json::Value;

/// What a rule is matched against.
pub struct Ctx {
    pub user_id: i32,
    pub role_id: Option<i32>,
    pub media_type: String,
    pub library_id: Option<i32>,
    pub genre_ids: Vec<i64>,
    pub year: Option<i64>,
    pub season_count: Option<i64>,
}

fn ints(c: &Value, key: &str) -> Vec<i64> {
    c[key]
        .as_array()
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

/// A criterion the context cannot answer fails the rule rather than being skipped.
pub fn matches(c: &Value, ctx: &Ctx) -> bool {
    let (users, roles) = (ints(c, "userIds"), ints(c, "roleIds"));
    if !(users.is_empty() && roles.is_empty()) {
        let targeted = users.contains(&i64::from(ctx.user_id))
            || ctx.role_id.is_some_and(|r| roles.contains(&i64::from(r)));
        if !targeted {
            return false;
        }
    }
    if c["mediaType"].as_str().is_some_and(|m| m != ctx.media_type) {
        return false;
    }
    let libraries = ints(c, "libraryIds");
    if !libraries.is_empty()
        && !ctx
            .library_id
            .is_some_and(|l| libraries.contains(&i64::from(l)))
    {
        return false;
    }
    let genres = ints(c, "genreIds");
    if !genres.is_empty() && !genres.iter().any(|g| ctx.genre_ids.contains(g)) {
        return false;
    }
    if let Some(max) = c["maxSeasons"].as_i64()
        && ctx.media_type == "series"
        && ctx.season_count.is_none_or(|n| n > max)
    {
        return false;
    }
    if let Some(from) = c["yearFrom"].as_i64()
        && ctx.year.is_none_or(|y| y < from)
    {
        return false;
    }
    if let Some(to) = c["yearTo"].as_i64()
        && ctx.year.is_none_or(|y| y > to)
    {
        return false;
    }
    true
}

fn reads_metadata(c: &Value, has_seasons: bool) -> bool {
    !ints(c, "genreIds").is_empty()
        || c["yearFrom"].as_i64().is_some()
        || c["yearTo"].as_i64().is_some()
        || (c["maxSeasons"].as_i64().is_some() && !has_seasons)
}

/// `shouldAutoApprove`: the first enabled rule that matches wins. An empty `seasons` is no scope (C112).
pub async fn should_auto_approve(
    st: &AppState,
    a: &Authed,
    dto: &CreateRequest,
    library_id: i32,
) -> Res<bool> {
    let rules = db::rules_enabled(&st.db).await?;
    if rules.is_empty() {
        return Ok(false);
    }
    let scoped = dto.seasons.as_deref().filter(|s| !s.is_empty());
    let facts = if rules
        .iter()
        .any(|r| reads_metadata(&r.criteria.0, scoped.is_some()))
    {
        match st
            .requests
            .title_facts(st, &dto.media_type, dto.tmdb_id)
            .await
        {
            Ok(f) => Some(f),
            Err(e) => {
                tracing::warn!(
                    "Auto-approval: metadata lookup failed for {} {}, genre/year/season criteria cannot match: {e}",
                    dto.media_type,
                    dto.tmdb_id
                );
                None
            }
        }
    } else {
        None
    };
    let ctx = Ctx {
        user_id: a.user.id,
        role_id: a.user.role_id,
        media_type: dto.media_type.clone(),
        library_id: Some(library_id),
        genre_ids: facts
            .as_ref()
            .map(|f| f.genre_ids.iter().map(|g| i64::from(*g)).collect())
            .unwrap_or_default(),
        year: facts.as_ref().and_then(|f| f.year).map(i64::from),
        season_count: scoped
            .map(|s| s.len() as i64)
            .or_else(|| facts.as_ref().and_then(|f| f.season_count).map(i64::from)),
    };
    let hit = rules.iter().find(|r| matches(&r.criteria.0, &ctx));
    if let Some(r) = hit {
        tracing::info!(
            "Auto-approving {} {} for user {}: rule \"{}\" (#{})",
            dto.media_type,
            dto.tmdb_id,
            a.user.id,
            r.name,
            r.id
        );
    }
    Ok(hit.is_some())
}

fn rule_not_found(id: i32) -> AppError {
    AppError::not_found(format!("Rule #{id} not found"))
}

async fn body(req: Request) -> Res<dto::Rule> {
    let ValidJson(v) = ValidJson::<Value>::from_request(req, &()).await?;
    dto::rule(v)
}

#[utoipa::path(get, path = "/api/auto-approval-rules", responses((status = 200)))]
pub async fn rule_list(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Value>>> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(db::rule_list(&st.db).await?))
}

#[utoipa::path(post, path = "/api/auto-approval-rules", responses((status = 201)))]
pub async fn rule_create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let r = body(req).await?;
    let saved = db::rule_insert(&st.db, &r.name, r.enabled, &r.criteria).await?;
    Ok((StatusCode::CREATED, Json(saved)))
}

#[utoipa::path(get, path = "/api/auto-approval-rules/{id}", responses((status = 200)))]
pub async fn rule_get(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<Json<Value>> {
    a.require(Action::Read, Subject::Settings)?;
    let id = int_param(&id)?;
    Ok(Json(
        db::rule_find(&st.db, id)
            .await?
            .ok_or_else(|| rule_not_found(id))?,
    ))
}

#[utoipa::path(put, path = "/api/auto-approval-rules/{id}", responses((status = 200)))]
pub async fn rule_update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
    req: Request,
) -> Res<Json<Value>> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = int_param(&id)?;
    let r = body(req).await?;
    let saved = db::rule_update(&st.db, id, &r.name, r.enabled, &r.criteria)
        .await?
        .ok_or_else(|| rule_not_found(id))?;
    Ok(Json(saved))
}

#[utoipa::path(delete, path = "/api/auto-approval-rules/{id}", responses((status = 200)))]
pub async fn rule_remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<StatusCode> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = int_param(&id)?;
    if !db::rule_delete(&st.db, id).await? {
        return Err(rule_not_found(id));
    }
    Ok(StatusCode::OK)
}

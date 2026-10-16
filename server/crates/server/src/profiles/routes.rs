use super::{
    db,
    dto::{self, Definitions},
    helpers::{format_not_found, language_not_found, quality_not_found},
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
use fliks_domain::{
    acl::{Action, Subject},
    language::APP_LANGUAGES,
    profiles::default_sizes,
    release::scoring::{self, CustomFormatMatch},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

type Res<T> = Result<T, AppError>;

/// Body parsing after the policy and id checks, as Nest's guards run before its pipes.
async fn body<T: DeserializeOwned>(req: Request) -> Res<T> {
    let ValidJson(dto) = ValidJson::<T>::from_request(req, &()).await?;
    Ok(dto)
}

fn created<T: serde::Serialize>(v: T) -> (StatusCode, Json<T>) {
    (StatusCode::CREATED, Json(v))
}

#[utoipa::path(get, path = "/api/profiles/quality", responses((status = 200)))]
pub async fn quality_list(
    State(st): State<AppState>,
    a: Authed,
) -> Res<Json<Vec<db::QualityProfile>>> {
    a.require(Action::Read, Subject::QualityProfile)?;
    Ok(Json(db::quality_list(&st.db).await?))
}

#[utoipa::path(post, path = "/api/profiles/quality", responses((status = 201)))]
pub async fn quality_create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<(StatusCode, Json<db::QualityProfile>)> {
    a.require(Action::Create, Subject::QualityProfile)?;
    let v = body::<dto::QualityProfile>(req).await?.validate()?;
    Ok(created(db::quality_insert(&st.db, v).await?))
}

#[utoipa::path(get, path = "/api/profiles/quality/{id}", responses((status = 200)))]
pub async fn quality_get(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<Json<db::QualityProfile>> {
    a.require(Action::Read, Subject::QualityProfile)?;
    let id = int_param(&id)?;
    let p = db::quality_find(&st.db, id).await?;
    Ok(Json(p.ok_or_else(|| quality_not_found(id))?))
}

#[utoipa::path(put, path = "/api/profiles/quality/{id}", responses((status = 200)))]
pub async fn quality_update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
    req: Request,
) -> Res<Json<db::QualityProfile>> {
    a.require(Action::Update, Subject::QualityProfile)?;
    let id = int_param(&id)?;
    let v = body::<dto::QualityProfile>(req).await?.validate()?;
    let p = db::quality_update(&st.db, id, v).await?;
    Ok(Json(p.ok_or_else(|| quality_not_found(id))?))
}

#[utoipa::path(delete, path = "/api/profiles/quality/{id}", responses((status = 200)))]
pub async fn quality_delete(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<StatusCode> {
    a.require(Action::Delete, Subject::QualityProfile)?;
    let id = int_param(&id)?;
    if !db::quality_delete(&st.db, id).await? {
        return Err(quality_not_found(id));
    }
    Ok(StatusCode::OK)
}

#[utoipa::path(get, path = "/api/profiles/language-definitions", responses((status = 200)))]
pub async fn language_definitions(a: Authed) -> Res<Json<Value>> {
    a.require(Action::Read, Subject::LanguageProfile)?;
    Ok(Json(json!(&APP_LANGUAGES[..])))
}

#[utoipa::path(get, path = "/api/profiles/language", responses((status = 200)))]
pub async fn language_list(
    State(st): State<AppState>,
    a: Authed,
) -> Res<Json<Vec<db::LanguageProfile>>> {
    a.require(Action::Read, Subject::LanguageProfile)?;
    Ok(Json(db::language_list(&st.db).await?))
}

#[utoipa::path(post, path = "/api/profiles/language", responses((status = 201)))]
pub async fn language_create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<(StatusCode, Json<db::LanguageProfile>)> {
    a.require(Action::Create, Subject::LanguageProfile)?;
    let v = body::<dto::LanguageProfile>(req).await?.validate();
    Ok(created(db::language_insert(&st.db, v).await?))
}

#[utoipa::path(get, path = "/api/profiles/language/{id}", responses((status = 200)))]
pub async fn language_get(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<Json<db::LanguageProfile>> {
    a.require(Action::Read, Subject::LanguageProfile)?;
    let id = int_param(&id)?;
    let p = db::language_find(&st.db, id).await?;
    Ok(Json(p.ok_or_else(|| language_not_found(id))?))
}

#[utoipa::path(put, path = "/api/profiles/language/{id}", responses((status = 200)))]
pub async fn language_update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
    req: Request,
) -> Res<Json<db::LanguageProfile>> {
    a.require(Action::Update, Subject::LanguageProfile)?;
    let id = int_param(&id)?;
    let v = body::<dto::LanguageProfile>(req).await?.validate();
    let p = db::language_update(&st.db, id, v).await?;
    Ok(Json(p.ok_or_else(|| language_not_found(id))?))
}

#[utoipa::path(delete, path = "/api/profiles/language/{id}", responses((status = 200)))]
pub async fn language_delete(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<StatusCode> {
    a.require(Action::Delete, Subject::LanguageProfile)?;
    let id = int_param(&id)?;
    if !db::language_delete(&st.db, id).await? {
        return Err(language_not_found(id));
    }
    Ok(StatusCode::OK)
}

/// Rule 21: the first `title_regex` that does not compile is a 400 naming it.
fn check_regexes(specs: &Value) -> Res<()> {
    let specs: Vec<scoring::CustomFormatSpec> =
        serde_json::from_value(specs.clone()).map_err(|_| AppError::bad_request("specs"))?;
    scoring::validate_title_regexes(&specs)
        .map_err(|v| AppError::bad_request(format!("Invalid regular expression: {v}")))
}

#[utoipa::path(get, path = "/api/custom-formats", responses((status = 200)))]
pub async fn format_list(
    State(st): State<AppState>,
    a: Authed,
) -> Res<Json<Vec<db::CustomFormat>>> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(db::format_list(&st.db).await?))
}

#[utoipa::path(post, path = "/api/custom-formats", responses((status = 201)))]
pub async fn format_create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<(StatusCode, Json<db::CustomFormat>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let v = body::<dto::CustomFormat>(req).await?.validate()?;
    check_regexes(&v.specs)?;
    Ok(created(db::format_insert(&st.db, v).await?))
}

#[utoipa::path(post, path = "/api/custom-formats/test", responses((status = 201)))]
pub async fn format_test(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<(StatusCode, Json<Vec<CustomFormatMatch>>)> {
    a.require(Action::Read, Subject::Settings)?;
    let t = body::<dto::TestFormat>(req).await?.validate()?;
    let formats: Vec<scoring::CustomFormat> =
        serde_json::from_value(json!(db::format_list(&st.db).await?))
            .map_err(|e| AppError::internal(e.to_string()))?;
    let flags = scoring::release_flags(&[], t.freeleech, t.download_volume_factor);
    Ok(created(scoring::test_release(&formats, &t.title, &flags)))
}

#[utoipa::path(get, path = "/api/custom-formats/{id}", responses((status = 200)))]
pub async fn format_get(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<Json<db::CustomFormat>> {
    a.require(Action::Read, Subject::Settings)?;
    let id = int_param(&id)?;
    let f = db::format_find(&st.db, id).await?;
    Ok(Json(f.ok_or_else(|| format_not_found(id))?))
}

#[utoipa::path(put, path = "/api/custom-formats/{id}", responses((status = 200)))]
pub async fn format_update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
    req: Request,
) -> Res<Json<db::CustomFormat>> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = int_param(&id)?;
    let v = body::<dto::CustomFormat>(req).await?.validate()?;
    // The 404 answers before the regex check, as in Nest.
    if db::format_find(&st.db, id).await?.is_none() {
        return Err(format_not_found(id));
    }
    check_regexes(&v.specs)?;
    let f = db::format_update(&st.db, id, v).await?;
    Ok(Json(f.ok_or_else(|| format_not_found(id))?))
}

#[utoipa::path(delete, path = "/api/custom-formats/{id}", responses((status = 200)))]
pub async fn format_delete(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Res<StatusCode> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = int_param(&id)?;
    if !db::format_delete(&st.db, id).await? {
        return Err(format_not_found(id));
    }
    Ok(StatusCode::OK)
}

#[utoipa::path(get, path = "/api/quality-definitions", responses((status = 200)))]
pub async fn definitions_list(
    State(st): State<AppState>,
    a: Authed,
) -> Res<Json<Vec<db::QualityDefinition>>> {
    a.require(Action::Read, Subject::Settings)?;
    db::seed_quality_definitions(&st.db).await?;
    Ok(Json(db::definition_list(&st.db).await?))
}

/// Computes the defaults only; the client saves them with `PUT` (rule 28).
#[utoipa::path(post, path = "/api/quality-definitions/reset", responses((status = 201)))]
pub async fn definitions_reset(
    State(st): State<AppState>,
    a: Authed,
) -> Res<(StatusCode, Json<Vec<db::QualityDefinition>>)> {
    a.require(Action::Update, Subject::Settings)?;
    db::seed_quality_definitions(&st.db).await?;
    let mut rows = db::definition_list(&st.db).await?;
    for r in &mut rows {
        let s = default_sizes(i64::from(r.quality_id));
        (r.min_size, r.preferred_size, r.max_size) = (s.min, s.preferred, s.max);
    }
    Ok(created(rows))
}

#[utoipa::path(put, path = "/api/quality-definitions", responses((status = 200)))]
pub async fn definitions_update(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<Json<Vec<db::QualityDefinition>>> {
    a.require(Action::Update, Subject::Settings)?;
    let items = body::<Definitions>(req).await?.validate()?;
    db::seed_quality_definitions(&st.db).await?;
    db::definitions_update(&st.db, items).await?;
    Ok(Json(db::definition_list(&st.db).await?))
}

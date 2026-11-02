use super::{
    accessible_library_ids,
    db::{self, Summary, not_found},
    path,
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
    response::{IntoResponse, Response},
};
use fliks_domain::{
    acl::{Action, Subject},
    media::{family::Family, kind::MediaKind},
};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use sqlx::{PgConnection, PgPool, QueryBuilder};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateDto {
    name: String,
    icon: Option<String>,
    color: Option<String>,
    media_types: Option<Vec<String>>,
    preferred_provider: Option<String>,
    metadata_language: Option<String>,
    metadata_region: Option<String>,
    default_quality_profile_id: Option<i32>,
    default_language_profile_id: Option<i32>,
    path: Option<String>,
    user_ids: Option<Vec<i32>>,
}

/// `None` = key absent, `Some(None)` = explicit `null`.
type Patch<T> = Option<Option<T>>;

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Patch<T>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateDto {
    #[serde(default, deserialize_with = "present")]
    name: Patch<String>,
    #[serde(default, deserialize_with = "present")]
    path: Patch<String>,
    #[serde(default, deserialize_with = "present")]
    icon: Patch<String>,
    #[serde(default, deserialize_with = "present")]
    color: Patch<String>,
    #[serde(default, deserialize_with = "present")]
    media_types: Patch<Vec<String>>,
    #[serde(default, deserialize_with = "present")]
    preferred_provider: Patch<String>,
    #[serde(default, deserialize_with = "present")]
    metadata_language: Patch<String>,
    #[serde(default, deserialize_with = "present")]
    metadata_region: Patch<String>,
    #[serde(default, deserialize_with = "present")]
    default_quality_profile_id: Patch<i32>,
    #[serde(default, deserialize_with = "present")]
    default_language_profile_id: Patch<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccessDto {
    user_ids: Vec<i32>,
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::bad_request(vec![msg.into()])
}

fn max_len(field: &str, v: Option<&str>, max: usize) -> Result<(), AppError> {
    match v {
        Some(s) if s.chars().count() > max => Err(bad(format!(
            "{field} must be shorter than or equal to {max} characters"
        ))),
        _ => Ok(()),
    }
}

fn check_media_types(v: &[String]) -> Result<(), AppError> {
    if v.iter().all(|t| MediaKind::parse(t).is_some()) {
        Ok(())
    } else {
        Err(bad(format!(
            "each value in mediaTypes {}",
            MediaKind::one_of_message()
        )))
    }
}

/// Empty string and `0` clear the override (rules 11-12).
fn or_null(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

fn profile(id: Option<i32>) -> Option<i32> {
    id.filter(|i| *i != 0)
}

/// Body parsing after the policy check, as 4.x runs guards before validation.
pub(super) async fn body<T: serde::de::DeserializeOwned>(req: Request) -> Result<T, AppError> {
    let ValidJson(dto) = ValidJson::<T>::from_request(req, &()).await?;
    Ok(dto)
}

pub(super) fn id_of(PathParams(raw): PathParams<String>) -> Result<i32, AppError> {
    int_param(&raw)
}

/// A caller whose accessible ids lack `id` gets the same 404 as for a missing library.
async fn reachable(db: &PgPool, a: &Authed, id: i32) -> Result<(), AppError> {
    if accessible_library_ids(db, a).await?.contains(&id) {
        Ok(())
    } else {
        Err(not_found(id))
    }
}

async fn one(db: &PgPool, a: &Authed, id: i32) -> Result<Value, AppError> {
    let lib = db::find(db, id).await?.ok_or_else(|| not_found(id))?;
    let mut rows = db::detail(db, vec![lib]).await?;
    Ok(rows.remove(0).json(db::paths_visible(&a.perms)))
}

#[utoipa::path(get, path = "/api/libraries/mine", responses((status = 200)))]
pub async fn mine(State(st): State<AppState>, a: Authed) -> Result<Json<Vec<Summary>>, AppError> {
    a.require(Action::Read, Subject::Library)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    if ids.is_empty() {
        return Ok(Json(vec![]));
    }
    Ok(Json(db::summaries(&st.db, &ids).await?))
}

#[utoipa::path(get, path = "/api/libraries", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed) -> Result<Json<Vec<Value>>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let ids = accessible_library_ids(&st.db, &a).await?;
    if ids.is_empty() {
        return Ok(Json(vec![]));
    }
    let rows = db::detail(&st.db, db::list(&st.db, &ids).await?).await?;
    let paths = db::paths_visible(&a.perms);
    Ok(Json(rows.into_iter().map(|r| r.json(paths)).collect()))
}

#[utoipa::path(get, path = "/api/libraries/{id}", responses((status = 200)))]
pub async fn get_one(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let id = id_of(id)?;
    reachable(&st.db, &a, id).await?;
    Ok(Json(one(&st.db, &a, id).await?))
}

#[utoipa::path(post, path = "/api/libraries", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Result<Response, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let dto: CreateDto = body(req).await?;
    max_len("icon", dto.icon.as_deref(), 48)?;
    max_len("color", dto.color.as_deref(), 32)?;
    max_len("metadataLanguage", dto.metadata_language.as_deref(), 8)?;
    max_len("metadataRegion", dto.metadata_region.as_deref(), 8)?;
    let media_types = dto.media_types.unwrap_or_else(|| {
        MediaKind::ALL
            .into_iter()
            .filter(|k| k.families().contains(&Family::Video))
            .map(|k| k.as_str().to_owned())
            .collect()
    });
    check_media_types(&media_types)?;
    let mut tx = st.db.begin().await?;
    let id = sqlx::query_scalar!(
        r#"INSERT INTO libraries (name, icon, color, "mediaTypes", "preferredProvider", "metadataLanguage",
        "metadataRegion", "defaultQualityProfileId", "defaultLanguageProfileId")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id"#,
        dto.name,
        dto.icon,
        dto.color,
        serde_json::json!(media_types),
        dto.preferred_provider,
        or_null(dto.metadata_language.as_deref()),
        or_null(dto.metadata_region.as_deref()),
        profile(dto.default_quality_profile_id),
        profile(dto.default_language_profile_id),
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(db::constraint)?;
    // Access before path: a rejected request must not leave a directory behind.
    if let Some(ids) = dto.user_ids.filter(|ids| !ids.is_empty()) {
        replace_access(&mut tx, id, &ids).await?;
    }
    if let Some(p) = dto.path.filter(|p| !p.is_empty()) {
        path::assign(&mut tx, id, &p).await?;
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(one(&st.db, &a, id).await?)).into_response())
}

#[utoipa::path(patch, path = "/api/libraries/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    req: Request,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = id_of(id)?;
    let dto: UpdateDto = body(req).await?;
    if dto.name == Some(None) {
        return Err(bad("name must be a string"));
    }
    if dto.path == Some(None) {
        return Err(bad("path must be a string"));
    }
    if dto.media_types == Some(None) {
        return Err(bad("mediaTypes must be an array"));
    }
    if let Some(Some(t)) = &dto.media_types {
        check_media_types(t)?;
    }
    max_len("icon", dto.icon.clone().flatten().as_deref(), 48)?;
    max_len("color", dto.color.clone().flatten().as_deref(), 32)?;
    max_len(
        "metadataLanguage",
        dto.metadata_language.clone().flatten().as_deref(),
        8,
    )?;
    max_len(
        "metadataRegion",
        dto.metadata_region.clone().flatten().as_deref(),
        8,
    )?;
    let mut tx = st.db.begin().await?;
    let exists = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM libraries WHERE id = $1) AS "e!""#,
        id
    )
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(not_found(id));
    }
    patch(&mut tx, id, &dto).await.map_err(db::constraint)?;
    if let Some(Some(p)) = &dto.path {
        path::assign(&mut tx, id, p).await?;
    }
    tx.commit().await?;
    Ok(Json(one(&st.db, &a, id).await?))
}

/// `UPDATE ... SET <given fields>, "updatedAt" = now()`, skipped when no field is given (rule 12).
async fn patch(c: &mut PgConnection, id: i32, dto: &UpdateDto) -> Result<(), sqlx::Error> {
    let mut q = QueryBuilder::new("UPDATE libraries SET ");
    let mut sets = q.separated(", ");
    macro_rules! set {
        ($col:literal, $v:expr) => {
            if let Some(v) = $v {
                sets.push(concat!("\"", $col, "\" = "));
                sets.push_bind_unseparated(v);
            }
        };
    }
    set!("name", dto.name.clone());
    set!("icon", dto.icon.clone());
    set!("color", dto.color.clone());
    set!(
        "mediaTypes",
        dto.media_types.clone().map(|t| serde_json::json!(t))
    );
    set!("preferredProvider", dto.preferred_provider.clone());
    set!(
        "metadataLanguage",
        dto.metadata_language
            .as_ref()
            .map(|v| or_null(v.as_deref()).map(str::to_owned))
    );
    set!(
        "metadataRegion",
        dto.metadata_region
            .as_ref()
            .map(|v| or_null(v.as_deref()).map(str::to_owned))
    );
    set!(
        "defaultQualityProfileId",
        dto.default_quality_profile_id.map(profile)
    );
    set!(
        "defaultLanguageProfileId",
        dto.default_language_profile_id.map(profile)
    );
    let given = dto.name.is_some()
        || dto.icon.is_some()
        || dto.color.is_some()
        || dto.media_types.is_some()
        || dto.preferred_provider.is_some()
        || dto.metadata_language.is_some()
        || dto.metadata_region.is_some()
        || dto.default_quality_profile_id.is_some()
        || dto.default_language_profile_id.is_some();
    if !given {
        return Ok(());
    }
    sets.push("\"updatedAt\" = now()");
    q.push(" WHERE id = ").push_bind(id);
    q.build().execute(c).await.map(drop)
}

/// Replace-all of a library's access rows; unknown or duplicate user ids are 400.
async fn replace_access(c: &mut PgConnection, id: i32, ids: &[i32]) -> Result<(), AppError> {
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(bad("userIds must not contain duplicate values"));
    }
    let known = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM users WHERE id = ANY($1)"#,
        ids
    )
    .fetch_one(&mut *c)
    .await?;
    if known != ids.len() as i64 {
        return Err(bad("userIds must reference existing users"));
    }
    sqlx::query!(
        r#"DELETE FROM library_user_access WHERE "libraryId" = $1"#,
        id
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"INSERT INTO library_user_access ("libraryId", "userId")
        SELECT $1, u FROM unnest($2::int[]) WITH ORDINALITY AS t(u, n) ORDER BY n"#,
        id,
        ids
    )
    .execute(c)
    .await?;
    Ok(())
}

#[utoipa::path(get, path = "/api/libraries/{id}/access", responses((status = 200)))]
pub async fn access_get(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Result<Json<Vec<i32>>, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = id_of(id)?;
    reachable(&st.db, &a, id).await?;
    Ok(Json(
        db::user_ids(&st.db, &[id])
            .await?
            .remove(&id)
            .unwrap_or_default(),
    ))
}

#[utoipa::path(put, path = "/api/libraries/{id}/access", responses((status = 200)))]
pub async fn access_put(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    req: Request,
) -> Result<StatusCode, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = id_of(id)?;
    let AccessDto { user_ids } = body(req).await?;
    let before = db::user_ids(&st.db, &[id])
        .await?
        .remove(&id)
        .unwrap_or_default();
    let mut tx = st.db.begin().await?;
    let exists = sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM libraries WHERE id = $1) AS "e!""#,
        id
    )
    .fetch_one(&mut *tx)
    .await?;
    if !exists {
        return Err(not_found(id));
    }
    replace_access(&mut tx, id, &user_ids).await?;
    tx.commit().await?;
    for removed in revoked(before, &user_ids) {
        let engine = st.engine.clone();
        tokio::spawn(async move { engine.revoke_owner(removed).await });
    }
    Ok(StatusCode::OK)
}

/// Rule 22: only users who lost access are revoked; kept and added ones are not.
fn revoked(before: Vec<i32>, after: &[i32]) -> Vec<i32> {
    before.into_iter().filter(|u| !after.contains(u)).collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn revokes_only_removed_users() {
        assert_eq!(super::revoked(vec![1, 2, 3], &[2, 4]), vec![1, 3]);
        assert!(super::revoked(vec![], &[1]).is_empty());
    }
}

//! `/api/optimize/*` and `/api/libraries/{id}/optimize/*` (`docs/spec/optimize.md`).
use super::profile::{Preset, Profile};
use super::select::{self, Context, Preview};
use crate::{
    http::{
        AppError,
        auth::Authed,
        json::iso_ms,
        validate::{PathParams, ValidJson, int_param},
    },
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Subject};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

#[derive(Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProfileOut {
    id: i32,
    name: String,
    document: Value,
    library_count: i64,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileDto {
    name: String,
    document: Value,
}

macro_rules! select {
    () => {
        r#"SELECT p.id, p.name, p.document, p."createdAt" AS created_at, p."updatedAt" AS updated_at,
    (SELECT count(*) FROM libraries l WHERE l."optimizeProfileId" = p.id) AS library_count
    FROM optimize_profiles p"#
    };
}

fn bad(msg: impl Into<String>) -> AppError {
    AppError::bad_request(vec![msg.into()])
}

/// The checked document and name of a request body.
fn checked(dto: ProfileDto) -> Result<(String, Profile), AppError> {
    let name = dto.name.trim().to_owned();
    if name.is_empty() || name.chars().count() > 120 {
        return Err(bad("name must be between 1 and 120 characters"));
    }
    let doc: Profile =
        serde_json::from_value(dto.document).map_err(|e| bad(format!("document: {e}")))?;
    let problems = doc.problems();
    if problems.is_empty() {
        Ok((name, doc))
    } else {
        Err(AppError::bad_request(problems))
    }
}

fn missing(id: i32) -> AppError {
    AppError::not_found(format!("Optimize profile #{id} not found"))
}

#[utoipa::path(get, path = "/api/optimize/presets", responses((status = 200)))]
pub async fn presets(a: Authed) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(
        Preset::ALL
            .map(|p| serde_json::json!({"key": p, "document": p.document()}))
            .to_vec()
            .into(),
    ))
}

#[utoipa::path(get, path = "/api/optimize/profiles", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<ProfileOut>>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let rows = sqlx::query_as(concat!(select!(), " ORDER BY p.name, p.id"))
        .fetch_all(&st.db)
        .await?;
    Ok(Json(rows))
}

async fn find(db: &PgPool, id: i32) -> Result<ProfileOut, AppError> {
    sqlx::query_as(concat!(select!(), " WHERE p.id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await?
        .ok_or_else(|| missing(id))
}

#[utoipa::path(get, path = "/api/optimize/profiles/{id}", responses((status = 200)))]
pub async fn get_one(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Result<Json<ProfileOut>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(find(&st.db, int_param(&id.0)?).await?))
}

#[utoipa::path(post, path = "/api/optimize/profiles", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(dto): ValidJson<ProfileDto>,
) -> Result<(StatusCode, Json<ProfileOut>), AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let (name, doc) = checked(dto)?;
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO optimize_profiles (name, document) VALUES ($1, $2) RETURNING id"#,
    )
    .bind(name)
    .bind(serde_json::to_value(doc).expect("profile serialises"))
    .fetch_one(&st.db)
    .await?;
    Ok((StatusCode::CREATED, Json(find(&st.db, id).await?)))
}

#[utoipa::path(put, path = "/api/optimize/profiles/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    ValidJson(dto): ValidJson<ProfileDto>,
) -> Result<Json<ProfileOut>, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = int_param(&id.0)?;
    let (name, doc) = checked(dto)?;
    let n = sqlx::query(r#"UPDATE optimize_profiles SET name = $2, document = $3, "updatedAt" = now() WHERE id = $1"#)
        .bind(id)
        .bind(name)
        .bind(serde_json::to_value(doc).expect("profile serialises"))
        .execute(&st.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(missing(id));
    }
    Ok(Json(find(&st.db, id).await?))
}

#[utoipa::path(delete, path = "/api/optimize/profiles/{id}", responses((status = 204)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = int_param(&id.0)?;
    let n = sqlx::query("DELETE FROM optimize_profiles WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(missing(id));
    }
    Ok(StatusCode::NO_CONTENT)
}

struct Lib {
    profile_id: Option<i32>,
    profile: Option<Profile>,
    allow_rename: bool,
    key: (Option<DateTime<Utc>>, Option<DateTime<Utc>>, i64),
}

/// The library's profile (or `profile_id` when given) and the stamp the counter cache is keyed on.
async fn library(
    st: &AppState,
    a: &Authed,
    id: i32,
    profile_id: Option<i32>,
) -> Result<Lib, AppError> {
    if !accessible_library_ids(&st.db, a).await?.contains(&id) {
        return Err(AppError::not_found(format!("Library #{id} not found")));
    }
    let (assigned, allow_rename, lib_stamp): (Option<i32>, bool, DateTime<Utc>) = sqlx::query_as(
        r#"SELECT "optimizeProfileId", "allowRename", "updatedAt" FROM libraries WHERE id = $1"#,
    )
    .bind(id)
    .fetch_one(&st.db)
    .await?;
    let profile_id = profile_id.or(assigned);
    let row: Option<(Value, DateTime<Utc>)> = match profile_id {
        Some(p) => {
            sqlx::query_as(r#"SELECT document, "updatedAt" FROM optimize_profiles WHERE id = $1"#)
                .bind(p)
                .fetch_optional(&st.db)
                .await?
        }
        None => None,
    };
    if profile_id.is_some() && row.is_none() {
        return Err(bad("profileId must reference an existing optimize profile"));
    }
    let (files, last): (i64, Option<DateTime<Utc>>) = sqlx::query_as(
        r#"SELECT count(*), max(mf."updatedAt") FROM media_files mf JOIN media m ON m.id = mf."mediaId" WHERE m."libraryId" = $1"#,
    )
    .bind(id)
    .fetch_one(&st.db)
    .await?;
    let profile = row
        .as_ref()
        .map(|(d, _)| {
            serde_json::from_value(d.clone())
                .map_err(|_| AppError::conflict("stored profile document is invalid"))
        })
        .transpose()?;
    Ok(Lib {
        profile_id,
        profile,
        allow_rename,
        key: (row.map(|r| r.1).max(Some(lib_stamp)), last, files),
    })
}

#[utoipa::path(get, path = "/api/libraries/{id}/optimize/preview", responses((status = 200)))]
pub async fn preview(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Preview>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let profile_id = crate::http::validate::int_query(q.get("profileId"))?
        .map(|v| i32::try_from(v).map_err(|_| bad("profileId is out of range")))
        .transpose()?;
    let lib = library(&st, &a, int_param(&id.0)?, profile_id).await?;
    let Some(profile) = lib.profile else {
        return Err(bad("the library has no optimize profile; pass profileId"));
    };
    let ctx = Context::load(&st.db, profile, lib.allow_rename).await?;
    Ok(Json(
        select::preview(&st.db, int_param(&id.0)?, &ctx).await?,
    ))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    profile_id: Option<i32>,
    files_with_difference: i64,
    #[serde(with = "iso_ms")]
    computed_at: DateTime<Utc>,
}

type Stamp = (Option<DateTime<Utc>>, Option<DateTime<Utc>>, i64);
// ponytail: in-process cache, recomputed when the profile, the library or a file row changed or
// after 15 minutes (devices and playback drift); a persisted counter if restarts must not recompute.
type Counters = HashMap<(i32, Option<i32>), (Stamp, Instant, Summary)>;
static COUNTERS: LazyLock<Mutex<Counters>> = LazyLock::new(Default::default);
const COUNTER_TTL: Duration = Duration::from_secs(900);

#[utoipa::path(get, path = "/api/libraries/{id}/optimize/summary", responses((status = 200)))]
pub async fn summary(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Result<Json<Summary>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let id = int_param(&id.0)?;
    let lib = library(&st, &a, id, None).await?;
    let slot = (id, lib.profile_id);
    let hit = COUNTERS
        .lock()
        .expect("counter cache")
        .get(&slot)
        .filter(|(k, at, _)| *k == lib.key && at.elapsed() < COUNTER_TTL)
        .map(|e| e.2.clone());
    if let Some(s) = hit {
        return Ok(Json(s));
    }
    let count = match lib.profile {
        Some(profile) => {
            let ctx = Context::load(&st.db, profile, lib.allow_rename).await?;
            select::preview(&st.db, id, &ctx).await?.with_difference
        }
        None => 0,
    };
    let s = Summary {
        profile_id: lib.profile_id,
        files_with_difference: count,
        computed_at: Utc::now(),
    };
    COUNTERS
        .lock()
        .expect("counter cache")
        .insert(slot, (lib.key, Instant::now(), s.clone()));
    Ok(Json(s))
}

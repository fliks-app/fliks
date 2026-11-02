use super::{Kind, issue};
use crate::{
    http::{
        AppError,
        auth::SessionAuthed,
        json::iso_ms,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{delete, get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

const MAX_PER_USER: i64 = 20;
const MAX_NAME: usize = 80;
const UNKNOWN: &str = "device_tokens.error_unknown";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/device-tokens", get(list).post(create))
        .route("/api/device-tokens/{id}", delete(remove))
        .route("/api/device-tokens/{id}/renew", post(renew))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceToken {
    id: i32,
    name: String,
    kind: String,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
    #[serde(with = "iso_ms::opt")]
    last_used_at: Option<DateTime<Utc>>,
}

/// The plaintext token, shown once.
#[derive(Serialize)]
pub struct Issued {
    #[serde(flatten)]
    row: DeviceToken,
    token: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateDto {
    name: String,
    kind: String,
}

#[utoipa::path(get, path = "/api/device-tokens", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
) -> Result<Json<Vec<DeviceToken>>, AppError> {
    let rows = sqlx::query_as!(
        DeviceToken,
        r#"SELECT id, name, kind::text AS "kind!", "createdAt" AS created_at, "lastUsedAt" AS last_used_at
           FROM device_tokens WHERE "userId" = $1 ORDER BY id"#,
        a.user.id
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

#[utoipa::path(post, path = "/api/device-tokens", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(dto): ValidJson<CreateDto>,
) -> Result<(StatusCode, Json<Issued>), AppError> {
    let name = dto.name.trim();
    let mut errs = vec![];
    if name.is_empty() {
        errs.push("name should not be empty".to_owned());
    } else if name.encode_utf16().count() > MAX_NAME {
        errs.push(format!(
            "name must be shorter than or equal to {MAX_NAME} characters"
        ));
    }
    let kind = Kind::parse(&dto.kind);
    if kind.is_none() {
        let all: Vec<_> = Kind::ALL.iter().map(|k| k.as_str()).collect();
        errs.push(format!(
            "kind must be one of the following values: {}",
            all.join(", ")
        ));
    }
    let Some(kind) = kind.filter(|_| errs.is_empty()) else {
        return Err(AppError::bad_request(errs));
    };
    let (token, stored) = issue(kind);
    let mut tx = st.db.begin().await?;
    // The user row serialises two creations, so the cap holds.
    sqlx::query_scalar!(
        r#"SELECT id FROM users WHERE id = $1 FOR UPDATE"#,
        a.user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    let held = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM device_tokens WHERE "userId" = $1"#,
        a.user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    if held >= MAX_PER_USER {
        return Err(AppError::bad_request("device_tokens.error_too_many"));
    }
    let row = sqlx::query_as!(
        DeviceToken,
        r#"INSERT INTO device_tokens ("userId", name, kind, "hash")
           VALUES ($1, $2, $3::text::device_token_kind, $4)
           RETURNING id, name, kind::text AS "kind!", "createdAt" AS created_at, "lastUsedAt" AS last_used_at"#,
        a.user.id,
        name,
        kind.as_str(),
        stored
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(Issued { row, token })))
}

#[utoipa::path(post, path = "/api/device-tokens/{id}/renew", responses((status = 201)))]
pub async fn renew(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> Result<(StatusCode, Json<Issued>), AppError> {
    let unknown = || AppError::not_found(UNKNOWN);
    let kind = sqlx::query_scalar!(
        r#"SELECT kind::text AS "kind!" FROM device_tokens WHERE id = $1 AND "userId" = $2"#,
        id,
        a.user.id
    )
    .fetch_optional(&st.db)
    .await?
    .and_then(|k| Kind::parse(&k))
    .ok_or_else(unknown)?;
    let (token, stored) = issue(kind);
    let row = sqlx::query_as!(
        DeviceToken,
        r#"UPDATE device_tokens SET "hash" = $3, "lastUsedAt" = NULL WHERE id = $1 AND "userId" = $2
           RETURNING id, name, kind::text AS "kind!", "createdAt" AS created_at, "lastUsedAt" AS last_used_at"#,
        id,
        a.user.id,
        stored
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(unknown)?;
    Ok((StatusCode::CREATED, Json(Issued { row, token })))
}

#[utoipa::path(delete, path = "/api/device-tokens/{id}", responses((status = 204)))]
pub async fn remove(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    let gone = sqlx::query!(
        r#"DELETE FROM device_tokens WHERE id = $1 AND "userId" = $2"#,
        id,
        a.user.id
    )
    .execute(&st.db)
    .await?
    .rows_affected();
    if gone == 0 {
        return Err(AppError::not_found(UNKNOWN));
    }
    Ok(StatusCode::NO_CONTENT)
}

use super::{config, message::parse_address};
use crate::{
    http::{
        AppError,
        auth::SessionAuthed,
        json::iso_ms,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

const MAX_PER_USER: i64 = 10;
const MAX_NAME: usize = 80;
const KINDS: [&str; 4] = ["kindle", "kobo", "pocketbook", "other"];
/// The text formats a book can be mailed in.
pub const FORMATS: [&str; 6] = ["epub", "pdf", "mobi", "azw3", "fb2", "cbz"];
const UNKNOWN: &str = "email_devices.error_unknown";

fn default_formats(kind: &str) -> Vec<String> {
    let f: &[&str] = match kind {
        "kobo" => &["epub"],
        _ => &["epub", "pdf"],
    };
    f.iter().map(|s| (*s).to_owned()).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailDevice {
    id: i32,
    name: String,
    kind: String,
    address: String,
    formats: Vec<String>,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    enabled: bool,
    max_bytes: Option<u64>,
    devices: Vec<EmailDevice>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceDto {
    name: String,
    kind: String,
    address: String,
    formats: Option<Vec<String>>,
}

struct Valid {
    name: String,
    kind: String,
    address: String,
    formats: Vec<String>,
}

fn validate(dto: DeviceDto) -> Result<Valid, AppError> {
    let name = dto.name.trim().to_owned();
    let mut errs = vec![];
    if name.is_empty() || name.chars().any(char::is_control) {
        errs.push("name should not be empty or contain control characters".to_owned());
    } else if name.encode_utf16().count() > MAX_NAME {
        errs.push(format!(
            "name must be shorter than or equal to {MAX_NAME} characters"
        ));
    }
    if !KINDS.contains(&dto.kind.as_str()) {
        errs.push(format!(
            "kind must be one of the following values: {}",
            KINDS.join(", ")
        ));
    }
    let address = parse_address(&dto.address).map(|a| a.to_string());
    if address.is_none() {
        errs.push("address must be an e-mail address".to_owned());
    }
    let formats = match dto.formats {
        None => default_formats(&dto.kind),
        Some(f) => f,
    };
    let mut sorted = formats.clone();
    sorted.sort();
    sorted.dedup();
    if formats.is_empty()
        || sorted.len() != formats.len()
        || !formats.iter().all(|f| FORMATS.contains(&f.as_str()))
    {
        errs.push(format!(
            "formats must be a non-empty list of distinct values among: {}",
            FORMATS.join(", ")
        ));
    }
    match address {
        Some(address) if errs.is_empty() => Ok(Valid {
            name,
            kind: dto.kind,
            address,
            formats,
        }),
        _ => Err(AppError::bad_request(errs)),
    }
}

#[utoipa::path(get, path = "/api/email-devices", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
) -> Result<Json<Devices>, AppError> {
    let smtp = config::load(&st.db).await?;
    let devices = sqlx::query_as!(
        EmailDevice,
        r#"SELECT id, name, kind, address, formats, "createdAt" AS created_at
           FROM email_devices WHERE "userId" = $1 ORDER BY id"#,
        a.user.id
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(Devices {
        enabled: smtp.is_some(),
        max_bytes: smtp.map(|s| s.max_bytes),
        devices,
    }))
}

#[utoipa::path(post, path = "/api/email-devices", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(dto): ValidJson<DeviceDto>,
) -> Result<(StatusCode, Json<EmailDevice>), AppError> {
    let v = validate(dto)?;
    let mut tx = st.db.begin().await?;
    // The user row serialises two creations, so the cap holds.
    sqlx::query_scalar!(
        r#"SELECT id FROM users WHERE id = $1 FOR UPDATE"#,
        a.user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    let held = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM email_devices WHERE "userId" = $1"#,
        a.user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    if held >= MAX_PER_USER {
        return Err(AppError::bad_request("email_devices.error_too_many"));
    }
    let row = sqlx::query_as!(
        EmailDevice,
        r#"INSERT INTO email_devices ("userId", name, kind, address, formats)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ("userId", name) DO NOTHING
           RETURNING id, name, kind, address, formats, "createdAt" AS created_at"#,
        a.user.id,
        v.name,
        v.kind,
        v.address,
        &v.formats
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::conflict("email_devices.error_name_taken"))?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(row)))
}

#[utoipa::path(put, path = "/api/email-devices/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(dto): ValidJson<DeviceDto>,
) -> Result<Json<EmailDevice>, AppError> {
    let v = validate(dto)?;
    sqlx::query_as!(
        EmailDevice,
        r#"UPDATE email_devices SET name = $3, kind = $4, address = $5, formats = $6
           WHERE id = $1 AND "userId" = $2
           RETURNING id, name, kind, address, formats, "createdAt" AS created_at"#,
        id,
        a.user.id,
        v.name,
        v.kind,
        v.address,
        &v.formats
    )
    .fetch_optional(&st.db)
    .await
    .map_err(|e| match e.as_database_error() {
        Some(d) if d.is_unique_violation() => AppError::conflict("email_devices.error_name_taken"),
        _ => e.into(),
    })?
    .map(Json)
    .ok_or_else(|| AppError::not_found(UNKNOWN))
}

#[utoipa::path(delete, path = "/api/email-devices/{id}", responses((status = 204)))]
pub async fn remove(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    let gone = sqlx::query!(
        r#"DELETE FROM email_devices WHERE id = $1 AND "userId" = $2"#,
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

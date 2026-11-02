//! KOReader progress sync (`docs/spec/kosync.md`), authenticated by a `kosync` device token.
use crate::{
    auth::client_ip,
    device_tokens,
    http::{
        AppError,
        auth::load_enabled,
        validate::{PathParams, ValidJson},
    },
    ingest::KeyedLocks,
    libraries,
    playback::{Watch, finish_context, record_watch},
    state::AppState,
};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Permissions, Subject};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::LazyLock};

const MAX_PROGRESS: usize = 4096;
const MAX_FIELD: usize = 255;
/// A key no username can equal, so a client cannot vary it to dodge the limiter.
const THROTTLE_KEY: &str = "\0kosync";

/// One writer per user: the state row is read then written, and KOReader can send two beats at once.
static WRITES: LazyLock<KeyedLocks<i32>> = LazyLock::new(KeyedLocks::default);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/kosync/users/auth", get(auth))
        .route("/kosync/users/create", post(create))
        .route("/kosync/syncs/progress", put(put_progress))
        .route("/kosync/syncs/progress/{document}", get(get_progress))
}

fn message(status: StatusCode, m: &str) -> Response {
    (status, Json(json!({ "message": m }))).into_response()
}

fn unauthorized() -> Response {
    message(StatusCode::UNAUTHORIZED, "Unauthorized")
}

/// The enabled owner of the `x-auth-key` and the libraries they read.
struct Caller {
    user: i32,
    libraries: Vec<i32>,
}

fn md5_hex(k: &str) -> bool {
    k.len() == 32 && k.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `Err` is the response to send: 401, or the 500 of a failed query.
async fn authenticate(st: &AppState, headers: &HeaderMap) -> Result<Caller, Box<Response>> {
    let key = headers
        .get("x-auth-key")
        .and_then(|v| v.to_str().ok())
        .filter(|k| md5_hex(k))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| Box::new(unauthorized()))?;
    let fail = |e: sqlx::Error| Box::new(AppError::from(e).into_response());
    let owner = device_tokens::kosync_owner(&st.db, &key)
        .await
        .map_err(fail)?
        .ok_or_else(|| Box::new(unauthorized()))?;
    let (user, role) = load_enabled(&st.db, owner)
        .await
        .map_err(fail)?
        .ok_or_else(|| Box::new(unauthorized()))?;
    let perms = Permissions::from(
        role.as_ref().map_or(&[][..], |r| &r.permissions),
        user.is_admin,
    );
    let libraries =
        libraries::library_ids_of(&st.db, user.id, perms.can(Action::Manage, &Subject::All))
            .await
            .map_err(fail)?;
    Ok(Caller {
        user: user.id,
        libraries,
    })
}

async fn auth(
    State(st): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
) -> Response {
    let ip = client_ip(&headers, peer.as_ref().map(|Extension(ConnectInfo(a))| a));
    if !st.login_throttle.attempt(ip, THROTTLE_KEY) {
        return message(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many failed attempts, try again later",
        );
    }
    match authenticate(&st, &headers).await {
        Ok(_) => {
            st.login_throttle.clear(ip, THROTTLE_KEY);
            Json(json!({"authorized": "OK"})).into_response()
        }
        Err(r) => *r,
    }
}

async fn create() -> Response {
    message(StatusCode::PAYMENT_REQUIRED, "Registration is disabled")
}

/// `progress`, `percentage`, `device`, `deviceId`, `syncedAt` of a stored row.
type Stored = (String, f64, String, Option<String>, DateTime<Utc>);

/// A text file a document names, with the item it is the part of.
struct Resolved {
    file: i32,
    item: i32,
    media: i32,
}

/// Spec rules 8-10: the lowest-id readable text file with this KOReader hash.
async fn resolve(
    st: &AppState,
    document: &str,
    libraries: &[i32],
) -> Result<Option<Resolved>, AppError> {
    if !md5_hex(document) || document.bytes().any(|b| b.is_ascii_uppercase()) {
        return Ok(None);
    }
    let row: Option<(i32, i32, i32)> = sqlx::query_as(
        r#"SELECT h."mediaFileId", i.id, i."mediaId"
           FROM media_file_hashes h
           JOIN item_parts ip ON ip."mediaFileId" = h."mediaFileId"
           JOIN items i ON i.id = ip."itemId"
           JOIN editions e ON e.id = i."editionId"
           JOIN media m ON m.id = i."mediaId"
           WHERE h.kind = 'koreader' AND h.hash = $1 AND e.family = 'text'
             AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
           ORDER BY h."mediaFileId" LIMIT 1"#,
    )
    .bind(document)
    .bind(libraries)
    .fetch_optional(&st.db)
    .await?;
    let Some((file, item, media)) = row else {
        return Ok(None);
    };
    Ok(libraries::assert_file_accessible(&st.db, file, libraries)
        .await
        .is_ok()
        .then_some(Resolved { file, item, media }))
}

/// The fields of a `PUT` body that pass spec rule 11.
struct Update {
    document: String,
    progress: String,
    percentage: f64,
    device: String,
    device_id: Option<String>,
}

fn parse(body: &Value) -> Option<Update> {
    let progress = match body.get("progress")? {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let device = body.get("device")?.as_str()?.trim();
    let device_id = match body.get("device_id") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.len() <= MAX_FIELD => Some(s.clone()),
        _ => return None,
    };
    Some(Update {
        document: body.get("document")?.as_str()?.to_owned(),
        percentage: body.get("percentage")?.as_f64().filter(|p| p.is_finite())?,
        device: (!device.is_empty() && device.len() <= MAX_FIELD).then(|| device.to_owned())?,
        progress: (progress.len() <= MAX_PROGRESS).then_some(progress)?,
        device_id,
    })
}

async fn put_progress(
    State(st): State<AppState>,
    headers: HeaderMap,
    ValidJson(body): ValidJson<Value>,
) -> Result<Response, AppError> {
    let caller = match authenticate(&st, &headers).await {
        Ok(c) => c,
        Err(r) => return Ok(*r),
    };
    let Some(u) = parse(&body) else {
        return Ok(message(StatusCode::BAD_REQUEST, "Invalid request"));
    };
    let now = Utc::now();
    let reply = |status| {
        (
            status,
            Json(json!({"document": u.document, "timestamp": now.timestamp()})),
        )
            .into_response()
    };
    let Some(r) = resolve(&st, &u.document, &caller.libraries).await? else {
        return Ok(reply(StatusCode::ACCEPTED));
    };
    let _one = WRITES.lock(caller.user).await;
    sqlx::query(
        r#"INSERT INTO kosync_progress
             ("userId", "document", "mediaFileId", "progress", "percentage", "device", "deviceId", "syncedAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT ("userId", "document") DO UPDATE SET
             "mediaFileId" = EXCLUDED."mediaFileId", "progress" = EXCLUDED."progress",
             "percentage" = EXCLUDED."percentage", "device" = EXCLUDED."device",
             "deviceId" = EXCLUDED."deviceId", "syncedAt" = EXCLUDED."syncedAt""#,
    )
    .bind(caller.user)
    .bind(&u.document)
    .bind(r.file)
    .bind(&u.progress)
    .bind(u.percentage)
    .bind(&u.device)
    .bind(&u.device_id)
    .bind(now)
    .execute(&st.db)
    .await?;
    let (family, last_chapter_start) = finish_context(&st.db, r.item, r.file).await?;
    let watch = Watch {
        position: 0.0,
        duration: 0.0,
        file: r.file,
        item: r.item,
        episode: None,
        client_played_at: None,
        family,
        last_chapter_start,
        progression: Some(u.percentage.clamp(0.0, 1.0)),
        locator: None,
    };
    record_watch(&st.db, caller.user, r.media, &watch).await?;
    sqlx::query(
        r#"UPDATE playback_states SET locator = NULL WHERE "userId" = $1 AND "itemId" = $2"#,
    )
    .bind(caller.user)
    .bind(r.item)
    .execute(&st.db)
    .await?;
    Ok(reply(StatusCode::OK))
}

async fn get_progress(
    State(st): State<AppState>,
    headers: HeaderMap,
    PathParams(document): PathParams<String>,
) -> Result<Response, AppError> {
    let caller = match authenticate(&st, &headers).await {
        Ok(c) => c,
        Err(r) => return Ok(*r),
    };
    let empty = || Json(json!({})).into_response();
    if resolve(&st, &document, &caller.libraries).await?.is_none() {
        return Ok(empty());
    }
    let row: Option<Stored> = sqlx::query_as(
        r#"SELECT "progress", "percentage", "device", "deviceId", "syncedAt"
           FROM kosync_progress WHERE "userId" = $1 AND "document" = $2"#,
    )
    .bind(caller.user)
    .bind(&document)
    .fetch_optional(&st.db)
    .await?;
    let Some((progress, percentage, device, device_id, at)) = row else {
        return Ok(empty());
    };
    let mut out = json!({
        "document": document, "progress": progress, "percentage": percentage,
        "device": device, "timestamp": at.timestamp(),
    });
    if let Some(id) = device_id {
        out["device_id"] = id.into();
    }
    Ok(Json(out).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_body_rules() {
        let ok = json!({"document": "a".repeat(32), "progress": "/body/DocFragment[3]/p[2]/text().0",
            "percentage": 0.25, "device": "Kobo", "device_id": "X"});
        assert_eq!(
            parse(&ok).unwrap().progress,
            "/body/DocFragment[3]/p[2]/text().0"
        );
        assert_eq!(
            parse(&json!({"document": "a", "progress": 12, "percentage": 1, "device": "d"}))
                .unwrap()
                .progress,
            "12"
        );
        for (k, v) in [
            ("percentage", json!("0.2")),
            ("device", json!("  ")),
            ("device_id", json!(3)),
            ("progress", json!(["x"])),
            ("progress", json!("x".repeat(MAX_PROGRESS + 1))),
        ] {
            let mut b = ok.clone();
            b[k] = v;
            assert!(parse(&b).is_none(), "{k}");
        }
        let mut b = ok.clone();
        b.as_object_mut().unwrap().remove("document");
        assert!(parse(&b).is_none());
        let mut b = ok;
        b["device_id"] = Value::Null;
        assert!(parse(&b).unwrap().device_id.is_none());
    }
}

use super::db::{self, Approval, Opened, PairingStatus, Refreshed};
use crate::{
    auth_token::Signed,
    events::SseEvent,
    http::{
        AppError,
        auth::{Authed, UserRow, load_enabled, logout_token},
        cookies::{access_cookie, clear_cookie},
        json::iso_ms,
        validate::{PathParams, ValidJson, from_value},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, Extension, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Subject};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::net::{IpAddr, SocketAddr};

const BCRYPT_COST: u32 = 12;
const SERVER_TYPES: [&str; 4] = ["local", "jellyfin", "emby", "plex"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/refresh", post(refresh))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/register", post(register))
        .route("/api/auth/setup", get(setup_status).post(setup))
        .route("/api/auth/me", get(me))
        .route("/api/auth/users-public", get(users_public))
        .route("/api/auth/cast-info", post(cast_info))
        .route("/api/auth/stream-token", post(stream_token))
        .route("/api/auth/pairing/request", post(pairing_request))
        .route("/api/auth/pairing/status", get(pairing_status))
        .route("/api/auth/pairing/pending", get(pairing_pending))
        .route("/api/auth/pairing/{id}/approve", post(pairing_approve))
        .route("/api/auth/pairing/{id}/deny", post(pairing_deny))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenPair {
    access_token: String,
    refresh_token: String,
    access_token_expires_at: i64,
    refresh_token_expires_at: i64,
}

fn pair(access: Signed, refresh: db::Issued) -> TokenPair {
    TokenPair {
        access_token: access.token,
        refresh_token: refresh.raw,
        access_token_expires_at: access.exp,
        refresh_token_expires_at: refresh.expires_at.timestamp(),
    }
}

#[derive(Serialize)]
struct LoginBody {
    #[serde(flatten)]
    pair: TokenPair,
    user: SafeUser,
}

/// `SafeUser` (auth.md rule 40).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SafeUser {
    #[serde(flatten)]
    user: UserRow,
    role: Option<String>,
    permissions: Vec<String>,
    library_ids: Vec<i32>,
    features: Vec<&'static str>,
}

async fn safe_user(
    st: &AppState,
    user: UserRow,
    role: Option<crate::http::auth::RoleRow>,
) -> SafeUser {
    let permissions = if user.is_admin {
        vec!["manage:all".to_owned()]
    } else {
        role.as_ref()
            .map(|r| r.permissions.clone())
            .unwrap_or_default()
    };
    SafeUser {
        role: role
            .map(|r| r.name)
            .or_else(|| user.is_admin.then(|| "Admin".to_owned())),
        permissions,
        library_ids: vec![],
        features: st.engine.features().await,
        user,
    }
}

fn internal() -> AppError {
    AppError::plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn user_agent(h: &HeaderMap) -> Option<&str> {
    h.get(header::USER_AGENT).and_then(|v| v.to_str().ok())
}

fn cookie(h: &HeaderMap, st: &AppState, token: &str) -> [(header::HeaderName, String); 1] {
    [(
        header::SET_COOKIE,
        access_cookie(h, token, st.jwt.access_ttl_secs),
    )]
}

fn non_empty(errs: &mut Vec<String>, field: &str, v: &str) {
    if v.is_empty() {
        errs.push(format!("{field} should not be empty"));
    }
}

fn check(errs: Vec<String>) -> Result<(), AppError> {
    if errs.is_empty() {
        Ok(())
    } else {
        Err(AppError::bad_request(errs))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct LoginDto {
    username: String,
    password: String,
    server_type: Option<String>,
}

/// The address the gateway appended to `X-Forwarded-For` (its last entry, the one a client cannot
/// forge), else the socket peer.
fn client_ip(headers: &HeaderMap, peer: Option<&SocketAddr>) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map_or_else(
            || peer.map(|a| a.ip().to_string()).unwrap_or_default(),
            str::to_owned,
        )
}

/// True when the peer and every address in `X-Forwarded-For` are private or loopback, so a
/// forged header or a public hop anywhere in the chain keeps the request out.
fn is_lan(headers: &HeaderMap, peer: Option<&SocketAddr>) -> bool {
    let local = |ip: IpAddr| match ip.to_canonical() {
        IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local(),
        IpAddr::V6(v) => v.is_loopback() || v.is_unique_local() || v.is_unicast_link_local(),
    };
    let hops = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let hops_ok = hops.into_iter().all(|h| h.parse().is_ok_and(local));
    hops_ok && peer.is_some_and(|a| local(a.ip()))
}

#[utoipa::path(post, path = "/api/auth/login", responses((status = 200)))]
pub(crate) async fn login(
    State(st): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    ValidJson(dto): ValidJson<LoginDto>,
) -> Result<Response, AppError> {
    let mut errs = vec![];
    non_empty(&mut errs, "username", &dto.username);
    non_empty(&mut errs, "password", &dto.password);
    if dto
        .server_type
        .as_deref()
        .is_some_and(|t| !SERVER_TYPES.contains(&t))
    {
        errs.push(format!(
            "serverType must be one of the following values: {}",
            SERVER_TYPES.join(", ")
        ));
    }
    check(errs)?;
    if let Some(t) = dto.server_type.as_deref().filter(|t| *t != "local") {
        return Err(AppError::unauthorized(format!(
            "Media server login for {t} not yet implemented"
        )));
    }
    let ip = client_ip(&headers, peer.as_ref().map(|Extension(ConnectInfo(a))| a));
    if st.login_throttle.blocked(&ip, &dto.username) {
        return Err(AppError::with_message(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many failed login attempts, try again later",
        ));
    }
    let invalid = || {
        st.login_throttle.fail(&ip, &dto.username);
        AppError::unauthorized("Invalid credentials")
    };
    let row = sqlx::query!(
        r#"SELECT id, "passwordHash" AS hash, enabled FROM users WHERE username = $1"#,
        dto.username
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(invalid)?;
    let stored = row.hash.ok_or_else(invalid)?;
    let password = dto.password.clone();
    let ok = tokio::task::spawn_blocking(move || bcrypt::verify(password, &stored))
        .await
        .map_err(|_| internal())?
        .unwrap_or(false);
    if !ok {
        return Err(invalid());
    }
    st.login_throttle.clear(&ip, &dto.username);
    if !row.enabled {
        return Err(AppError::unauthorized("Account disabled"));
    }
    let now = Utc::now();
    sqlx::query!(
        r#"UPDATE users SET "lastLogin" = $1 WHERE id = $2"#,
        now,
        row.id
    )
    .execute(&st.db)
    .await?;
    let (user, role) = load_enabled(&st.db, row.id)
        .await?
        .ok_or_else(|| AppError::unauthorized("Account disabled"))?;
    let access = st.jwt.sign_access(user.id, &user.username)?;
    let mut conn = st.db.acquire().await?;
    let refresh = db::issue(
        &mut conn,
        user.id,
        None,
        user_agent(&headers),
        st.cfg.refresh_token_ttl_days,
        now,
    )
    .await?;
    drop(conn);
    let set = cookie(&headers, &st, &access.token);
    let body = LoginBody {
        pair: pair(access, refresh),
        user: safe_user(&st, user, role).await,
    };
    Ok((StatusCode::CREATED, set, Json(body)).into_response())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefreshDto {
    refresh_token: Option<Value>,
}

#[utoipa::path(post, path = "/api/auth/refresh", responses((status = 200)))]
pub(crate) async fn refresh(
    State(st): State<AppState>,
    headers: HeaderMap,
    ValidJson(dto): ValidJson<RefreshDto>,
) -> Result<Response, AppError> {
    let raw = match dto.refresh_token {
        // Every JSON falsy value is a missing token (`!refreshToken`).
        None | Some(Value::Null | Value::Bool(false)) => None,
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(Value::String(s)) => Some(s),
        // A truthy non-string cannot be a token; 4.x answers 500 here.
        Some(_) => return Err(AppError::unauthorized("Invalid refresh token")),
    };
    let Some(raw) = raw else {
        tracing::info!(
            presented_user_agent = user_agent(&headers),
            "refresh refused: no token"
        );
        return Err(AppError::unauthorized("Missing refresh token"));
    };
    let r = db::refresh(
        &st.db,
        &raw,
        user_agent(&headers),
        st.cfg.refresh_token_ttl_days,
        Utc::now(),
    )
    .await?;
    let (user_id, username, issued) = match r {
        Refreshed::Ok {
            user_id,
            username,
            issued,
        } => (user_id, username, issued),
        Refreshed::Invalid => return Err(AppError::unauthorized("Invalid refresh token")),
        Refreshed::AlreadyRotated => {
            return Err(AppError::unauthorized("Refresh token already rotated"));
        }
        Refreshed::Reuse => return Err(AppError::unauthorized("Refresh token reuse detected")),
        Refreshed::Expired => return Err(AppError::unauthorized("Refresh token expired")),
        Refreshed::Disabled => return Err(AppError::unauthorized("Account disabled")),
    };
    let access = st.jwt.sign_access(user_id, &username)?;
    let set = cookie(&headers, &st, &access.token);
    Ok((StatusCode::CREATED, set, Json(pair(access, issued))).into_response())
}

#[utoipa::path(post, path = "/api/auth/logout", responses((status = 200)))]
pub(crate) async fn logout(
    State(st): State<AppState>,
    headers: HeaderMap,
    ValidJson(body): ValidJson<Value>,
) -> impl IntoResponse {
    let clear = [(header::SET_COOKIE, clear_cookie(&headers))];
    let text = |k: &str| {
        body.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    if let Some(raw) = text("refreshToken")
        && let Err(e) = db::revoke(&st.db, raw, Utc::now()).await
    {
        tracing::debug!(error = %e, "logout revoke failed");
    }
    let claims = logout_token(&headers).and_then(|t| st.jwt.verify(&t));
    if let Some(c) = claims {
        match text("targetId") {
            Some(target) => {
                st.hub.drop_connections_for_target(c.sub, target);
            }
            None => tracing::warn!(
                user = c.sub,
                "logout carried no targetId: other devices' streams untouched"
            ),
        }
    }
    (StatusCode::NO_CONTENT, clear)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegisterDto {
    username: String,
    password: String,
    email: Option<String>,
}

#[utoipa::path(post, path = "/api/auth/register", responses((status = 200)))]
pub(crate) async fn register(
    State(st): State<AppState>,
    authed: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<Response, AppError> {
    authed.require(Action::Manage, Subject::User)?;
    let dto: RegisterDto = from_value(body)?;
    let mut errs = vec![];
    non_empty(&mut errs, "username", &dto.username);
    non_empty(&mut errs, "password", &dto.password);
    check(errs)?;
    let taken = || AppError::conflict("Username already taken");
    let exists = sqlx::query_scalar!(
        r#"SELECT 1 AS "one!" FROM users WHERE username = $1"#,
        dto.username
    )
    .fetch_optional(&st.db)
    .await?;
    if exists.is_some() {
        return Err(taken());
    }
    let role_id =
        sqlx::query_scalar!(r#"SELECT id FROM roles WHERE "isDefault" = true ORDER BY id LIMIT 1"#)
            .fetch_optional(&st.db)
            .await?;
    let password = dto.password;
    let hash = tokio::task::spawn_blocking(move || bcrypt::hash(password, BCRYPT_COST))
        .await
        .map_err(|_| internal())?
        .map_err(|_| internal())?;
    let id = sqlx::query_scalar!(
        r#"INSERT INTO users (username, email, "passwordHash", "roleId", "isAdmin", "mediaServerType")
           VALUES ($1, $2, $3, $4, false, 'local') RETURNING id"#,
        dto.username,
        dto.email,
        hash,
        role_id
    )
    .fetch_one(&st.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => taken(),
        e => e.into(),
    })?;
    let (user, _) = load_enabled(&st.db, id).await?.ok_or_else(internal)?;
    // The saved entity has no loaded role: role/permissions follow `isAdmin` only (rule 37).
    Ok((StatusCode::CREATED, Json(safe_user(&st, user, None).await)).into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SetupDto {
    username: String,
    password: String,
}

#[utoipa::path(get, path = "/api/auth/setup", responses((status = 200)))]
pub(crate) async fn setup_status(State(st): State<AppState>) -> Result<Json<Value>, AppError> {
    let empty = sqlx::query_scalar!(r#"SELECT NOT EXISTS(SELECT 1 FROM users) AS "empty!""#)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(json!({ "required": empty })))
}

/// First-boot admin: allowed only while `users` is empty, serialised by an advisory lock.
#[utoipa::path(post, path = "/api/auth/setup", responses((status = 201)))]
pub(crate) async fn setup(
    State(st): State<AppState>,
    ValidJson(dto): ValidJson<SetupDto>,
) -> Result<StatusCode, AppError> {
    let mut errs = vec![];
    non_empty(&mut errs, "username", dto.username.trim());
    if dto.password.chars().count() < 8 {
        errs.push("password must be longer than or equal to 8 characters".into());
    }
    check(errs)?;
    if !setup_status(State(st.clone())).await?.0["required"]
        .as_bool()
        .unwrap_or(false)
    {
        return Err(AppError::conflict("Setup already completed"));
    }
    let password = dto.password;
    let hash = tokio::task::spawn_blocking(move || bcrypt::hash(password, BCRYPT_COST))
        .await
        .map_err(|_| internal())?
        .map_err(|_| internal())?;
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('first_admin_setup'))")
        .execute(&mut *tx)
        .await?;
    let empty = sqlx::query_scalar!(r#"SELECT NOT EXISTS(SELECT 1 FROM users) AS "empty!""#)
        .fetch_one(&mut *tx)
        .await?;
    if !empty {
        return Err(AppError::conflict("Setup already completed"));
    }
    sqlx::query!(
        r#"INSERT INTO users (username, "passwordHash", "isAdmin", enabled) VALUES ($1, $2, true, true)"#,
        dto.username.trim(),
        hash
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::CREATED)
}

#[utoipa::path(get, path = "/api/auth/me", responses((status = 200)))]
pub(crate) async fn me(State(st): State<AppState>, a: Authed) -> Result<Json<SafeUser>, AppError> {
    let stale = a
        .user
        .last_login
        .is_none_or(|t| (Utc::now() - t).num_milliseconds() >= 60_000);
    if stale {
        sqlx::query!(
            r#"UPDATE users SET "lastLogin" = $1 WHERE id = $2"#,
            Utc::now(),
            a.user.id
        )
        .execute(&st.db)
        .await?;
    }
    Ok(Json(safe_user(&st, a.user, a.role).await))
}

/// Picker roster visibility: `everyone` (default), `lan` or `hidden` (setting `users_public_mode`).
#[utoipa::path(get, path = "/api/auth/users-public", responses((status = 200)))]
pub(crate) async fn users_public(
    State(st): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
) -> Result<Json<Value>, AppError> {
    let mode =
        sqlx::query_scalar!(r#"SELECT value FROM app_settings WHERE key = 'users_public_mode'"#)
            .fetch_optional(&st.db)
            .await?
            .flatten();
    let shown = match mode.as_deref() {
        Some("hidden") => false,
        Some("lan") => is_lan(&headers, peer.as_ref().map(|Extension(ConnectInfo(a))| a)),
        _ => true,
    };
    if !shown {
        return Ok(Json(json!([])));
    }
    let rows = sqlx::query!(
        r#"SELECT id, username, avatar FROM users WHERE enabled = true ORDER BY username ASC"#
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.into_iter()
            .map(|r| json!({"id": r.id, "username": r.username, "avatar": r.avatar}))
            .collect(),
    ))
}

#[utoipa::path(post, path = "/api/auth/cast-info", responses((status = 200)))]
pub(crate) async fn cast_info(
    State(st): State<AppState>,
    a: Authed,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let token = st.jwt.sign_cast(a.user.id, &a.user.username)?.token;
    let public = sqlx::query_scalar!(r#"SELECT value FROM app_settings WHERE key = 'public_url'"#)
        .fetch_optional(&st.db)
        .await?
        .flatten()
        .filter(|u| !u.is_empty());
    let header_str = |n: &str| {
        headers
            .get(n)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
    };
    let base = match (public, header_str("host")) {
        (Some(u), _) => u.trim_end_matches('/').to_owned(),
        (None, Some(host)) => {
            format!(
                "{}://{host}",
                header_str("x-forwarded-proto").unwrap_or("http")
            )
        }
        (None, None) => format!("http://localhost:{}", st.cfg.port),
    };
    Ok((
        StatusCode::CREATED,
        Json(json!({"token": token, "streamBaseUrl": base})),
    )
        .into_response())
}

#[utoipa::path(post, path = "/api/auth/stream-token", responses((status = 200)))]
pub(crate) async fn stream_token(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Response, AppError> {
    let token = st.jwt.sign_stream(a.user.id, &a.user.username)?.token;
    let expires_at = Utc::now().timestamp_millis() + (st.jwt.stream_ttl_secs as i64) * 1000;
    Ok((
        StatusCode::CREATED,
        Json(json!({"streamToken": token, "expiresAt": expires_at})),
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct PairingRequestDto {
    user_id: i32,
    device_name: String,
    system_name: Option<String>,
}

fn device_id(h: &HeaderMap) -> Result<&str, AppError> {
    h.get("x-device-id")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::bad_request("Missing X-Device-Id header"))
}

#[utoipa::path(post, path = "/api/auth/pairing/request", responses((status = 200)))]
pub(crate) async fn pairing_request(
    State(st): State<AppState>,
    headers: HeaderMap,
    ValidJson(dto): ValidJson<PairingRequestDto>,
) -> Result<Response, AppError> {
    let mut errs = vec![];
    non_empty(&mut errs, "deviceName", &dto.device_name);
    if dto.device_name.chars().count() > 80 {
        errs.push("deviceName must be shorter than or equal to 80 characters".into());
    }
    if dto
        .system_name
        .as_deref()
        .is_some_and(|s| s.chars().count() > 60)
    {
        errs.push("systemName must be shorter than or equal to 60 characters".into());
    }
    check(errs)?;
    let device = device_id(&headers)?;
    let opened = db::open_pairing(
        &st.db,
        dto.user_id,
        device,
        &dto.device_name,
        dto.system_name.as_deref(),
        Utc::now(),
    )
    .await?;
    let id = match opened {
        Opened::Created(id) => id,
        Opened::NoUser => return Err(AppError::not_found("User not found")),
        Opened::TooMany => {
            return Err(AppError::bad_request(
                "Too many pending requests for this device",
            ));
        }
    };
    st.hub.emit_to_user(
        dto.user_id,
        SseEvent::PairingRequested {
            user_id: dto.user_id.into(),
            pairing_id: id.clone(),
            device_name: dto.device_name.clone(),
            device_id: device.to_owned(),
        },
    );
    Ok((
        StatusCode::CREATED,
        Json(json!({"pairingId": id, "expiresIn": db::PAIRING_TTL_SECS})),
    )
        .into_response())
}

#[utoipa::path(get, path = "/api/auth/pairing/status", responses((status = 200)))]
pub(crate) async fn pairing_status(
    State(st): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Response, AppError> {
    let id = q
        .iter()
        .find(|(k, _)| k == "pairingId")
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| AppError::bad_request("Missing pairingId"))?;
    let device = device_id(&headers)?;
    let s = db::pairing_status(
        &st.db,
        id,
        device,
        st.cfg.refresh_token_ttl_days,
        Utc::now(),
    )
    .await?
    .ok_or_else(|| AppError::not_found("Pairing request not found"))?;
    match s {
        PairingStatus::Status(status) => Ok(Json(json!({"status": status})).into_response()),
        PairingStatus::Claimed {
            user_id,
            username,
            issued,
        } => {
            let access = st.jwt.sign_access(user_id, &username)?;
            let set = cookie(&headers, &st, &access.token);
            let mut body = serde_json::to_value(pair(access, issued)).map_err(|_| internal())?;
            body["status"] = "approved".into();
            Ok((set, Json(body)).into_response())
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pending {
    pairing_id: String,
    device_id: String,
    device_name: String,
    system_name: Option<String>,
    #[serde(with = "iso_ms")]
    requested_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    expires_at: DateTime<Utc>,
}

#[utoipa::path(get, path = "/api/auth/pairing/pending", responses((status = 200)))]
pub(crate) async fn pairing_pending(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<Pending>>, AppError> {
    let rows = db::pending(&st.db, a.user.id, Utc::now()).await?;
    Ok(Json(
        rows.into_iter()
            .map(|p| Pending {
                pairing_id: p.public_id,
                device_id: p.device_id,
                device_name: p.device_name,
                system_name: p.system_name,
                requested_at: p.created_at,
                expires_at: p.expires_at,
            })
            .collect(),
    ))
}

#[utoipa::path(post, path = "/api/auth/pairing/{id}/approve", responses((status = 200)))]
pub(crate) async fn pairing_approve(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Result<StatusCode, AppError> {
    match db::approve(&st.db, &id, a.user.id, Utc::now()).await? {
        Approval::Approved => Ok(StatusCode::NO_CONTENT),
        Approval::NotFound => Err(AppError::not_found("Pairing request not found")),
        Approval::NotPending(s) => Err(AppError::bad_request(format!(
            "Cannot approve a {s} request"
        ))),
        Approval::Expired => Err(AppError::bad_request("Pairing request expired")),
    }
}

#[utoipa::path(post, path = "/api/auth/pairing/{id}/deny", responses((status = 200)))]
pub(crate) async fn pairing_deny(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Result<StatusCode, AppError> {
    if db::deny(&st.db, &id, a.user.id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::not_found("Pairing request not found"))
    }
}

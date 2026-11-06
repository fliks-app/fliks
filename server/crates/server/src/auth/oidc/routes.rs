//! The sign-in flow (`docs/spec/auth.md`): start, callback, exchange, logout, identities.
use super::{
    Oidc, ReturnTo, cut_users, db,
    sync::{self, Fail, Kind},
};
use crate::{
    auth::{
        db::OidcSession,
        routes::{SessionKind, client_ip, sign_in},
    },
    http::{
        AppError,
        auth::{SessionAuthed, session_from_headers},
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, Extension, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, net::SocketAddr};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/oidc", get(info))
        .route("/api/auth/oidc/exchange", post(exchange))
        .route("/api/auth/oidc/end-session", post(end_session))
        .route("/api/auth/oidc/identities", get(identities))
        .route("/api/auth/oidc/identities/{provider_id}", delete(unlink))
        .route("/api/auth/oidc/{id}/start", post(start))
        .route("/api/auth/oidc/{id}/callback", get(callback))
        .route(
            "/api/auth/oidc/{id}/backchannel-logout",
            post(backchannel_logout),
        )
}

/// The login throttle key of the start route: every start of a network counts, a success clears.
const THROTTLE_KEY: &str = "oidc:";
/// Starts per network and 15 minutes: a household behind one address signs in several times.
const START_LIMIT: u32 = 30;

fn random() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).expect("os rng");
    URL_SAFE_NO_PAD.encode(b)
}

fn unreachable_idp() -> AppError {
    AppError::with_message(StatusCode::BAD_GATEWAY, "Identity provider unreachable")
}

/// The scheme, host and port of `public_url`.
fn origin_of(public_url: &str) -> String {
    reqwest::Url::parse(public_url)
        .map(|u| u.origin().ascii_serialization())
        .ok()
        .filter(|o| o != "null")
        .unwrap_or_default()
}

#[derive(Serialize)]
struct Button {
    id: i32,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    providers: Vec<Button>,
    auto_launch: Option<i32>,
    password_login: &'static str,
    origin: String,
}

#[utoipa::path(get, path = "/api/auth/oidc", responses((status = 200)))]
pub(crate) async fn info(State(st): State<AppState>) -> Result<Json<Info>, AppError> {
    let providers: Vec<_> = db::list(&st.db)
        .await?
        .into_iter()
        .filter(|p| p.enabled)
        .collect();
    let setting = |k: &'static str| {
        sqlx::query_scalar!(r#"SELECT value FROM app_settings WHERE key = $1"#, k)
    };
    let auto: Option<i32> = setting("oidc_auto_launch")
        .fetch_optional(&st.db)
        .await?
        .flatten()
        .and_then(|v| v.trim().parse().ok())
        .filter(|id| providers.iter().any(|p| p.id == *id));
    let admins = db::password_login_admins_only(&st.db).await?;
    let origin = db::public_url(&st.db)
        .await?
        .map(|u| origin_of(&u))
        .unwrap_or_default();
    Ok(Json(Info {
        providers: providers
            .into_iter()
            .map(|p| Button {
                id: p.id,
                name: p.name,
            })
            .collect(),
        auto_launch: auto,
        password_login: if admins { "admins" } else { "everyone" },
        origin,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct StartDto {
    challenge: String,
    return_to: String,
    #[serde(default)]
    link: bool,
    prompt: Option<String>,
    expect_user_id: Option<i32>,
}

fn peer_ip(
    peer: &Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: &HeaderMap,
) -> Option<std::net::IpAddr> {
    client_ip(headers, peer.as_ref().map(|Extension(ConnectInfo(a))| a))
}

/// A base64url SHA-256 (the S256 challenge) or a 43 to 128 character verifier (RFC 7636 section 4.1).
fn is_challenge(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_verifier(s: &str) -> bool {
    (43..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

#[utoipa::path(post, path = "/api/auth/oidc/{id}/start", responses((status = 201)))]
pub(crate) async fn start(
    State(st): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    PathParams(id): PathParams<i32>,
    ValidJson(dto): ValidJson<StartDto>,
) -> Result<Response, AppError> {
    let p = db::get(&st.db, id)
        .await?
        .filter(|p| p.enabled)
        .ok_or_else(|| AppError::bare(StatusCode::NOT_FOUND))?;
    if !st
        .login_throttle
        .attempt_with(peer_ip(&peer, &headers), THROTTLE_KEY, START_LIMIT)
    {
        return Err(AppError::with_message(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many sign-in attempts, try again later",
        ));
    }
    let mut errs = vec![];
    let return_to = ReturnTo::parse(&dto.return_to);
    if return_to.is_none() {
        errs.push("returnTo must be web, app or a loopback URL".to_owned());
    }
    if !is_challenge(&dto.challenge) {
        errs.push("challenge must be a base64url SHA-256".to_owned());
    }
    if dto.prompt.as_deref().is_some_and(|p| p != "none") {
        errs.push("prompt must be none".to_owned());
    }
    if dto.expect_user_id.is_some() && (dto.prompt.is_none() || dto.link) {
        errs.push("expectUserId needs prompt none and no link".to_owned());
    }
    let (Some(return_to), true) = (return_to, errs.is_empty()) else {
        return Err(AppError::bad_request(errs));
    };
    // A silent run must not override an admin's `login` or `consent`: the client falls back to the login page.
    let silent = dto.prompt.is_some();
    if silent && !matches!(p.prompt.as_deref(), None | Some("select_account")) {
        return Err(AppError::conflict("Silent sign-in is not available"));
    }
    let link_user = if dto.link {
        Some(session_from_headers(&headers, &st).await?.user.id)
    } else {
        None
    };
    let public = db::public_url(&st.db)
        .await?
        .ok_or_else(|| AppError::conflict("public_url is not set"))?;
    let d = st.oidc.discover(&p).await.map_err(|e| {
        tracing::warn!(provider = p.id, reason = %e, "oidc discovery failed");
        unreachable_idp()
    })?;
    if !d.pkce {
        return Err(AppError::bad_request(
            "The provider does not support PKCE with S256",
        ));
    }
    let (state, nonce) = (random(), random());
    let login = db::Login {
        provider_id: p.id,
        nonce,
        return_to: return_to.as_text(),
        link_user_id: link_user,
        expect_user_id: dto.expect_user_id,
    };
    db::insert_login(&st.db, &state, &login, Utc::now()).await?;
    let mut url = reqwest::Url::parse(&d.authorization_endpoint).map_err(|_| unreachable_idp())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", &p.client_id)
            .append_pair(
                "redirect_uri",
                &format!("{public}/api/auth/oidc/{}/callback", p.id),
            )
            .append_pair("scope", &p.scope)
            .append_pair("state", &state)
            .append_pair("nonce", &login.nonce)
            .append_pair("code_challenge", &dto.challenge)
            .append_pair("code_challenge_method", "S256");
        if let Some(prompt) = dto.prompt.as_deref().or(p.prompt.as_deref()) {
            q.append_pair("prompt", prompt);
        }
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({"authorizeUrl": url.as_str(), "state": state})),
    )
        .into_response())
}

fn redirect(to: String) -> Response {
    let mut res = StatusCode::FOUND.into_response();
    if let Ok(v) = HeaderValue::from_str(&to) {
        res.headers_mut().insert(header::LOCATION, v);
    }
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    res
}

#[utoipa::path(get, path = "/api/auth/oidc/{id}/callback", responses((status = 302)))]
pub(crate) async fn callback(
    State(st): State<AppState>,
    PathParams(id): PathParams<i32>,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Response, AppError> {
    let public = db::public_url(&st.db).await?.unwrap_or_default();
    let state = q.get("state").map(String::as_str).unwrap_or_default();
    let fail = |rt: ReturnTo, kind: Kind| {
        let params: Vec<(&str, &str)> = [("error", kind.as_str())]
            .into_iter()
            .chain((!state.is_empty()).then_some(("state", state)))
            .collect();
        redirect(rt.redirect(&public, &params))
    };
    let row = if state.is_empty() {
        None
    } else {
        db::peek_login(&st.db, state, Utc::now()).await?
    };
    let Some(row) = row else {
        return Ok(fail(ReturnTo::Web, Kind::Expired));
    };
    let rt = ReturnTo::parse(&row.return_to).unwrap_or(ReturnTo::Web);
    let Some(p) = db::get(&st.db, id)
        .await?
        .filter(|p| p.id == row.provider_id)
    else {
        return Ok(fail(rt, Kind::Expired));
    };
    let iss_required = st.oidc.discover(&p).await.is_ok_and(|d| d.iss_param);
    match q.get("iss") {
        Some(iss) if *iss != p.issuer => return Ok(fail(rt, Kind::Expired)),
        None if iss_required => return Ok(fail(rt, Kind::Expired)),
        _ => {}
    }
    match q
        .get("code")
        .filter(|c| !c.is_empty() && !q.contains_key("error"))
    {
        Some(code) => Ok(redirect(
            rt.redirect(&public, &[("code", code), ("state", state)]),
        )),
        None => Ok(fail(rt, Kind::Idp)),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExchangeDto {
    state: String,
    code: String,
    verifier: String,
}

fn refusal(kind: Kind) -> Response {
    (kind.status(), Json(json!({"error": kind.as_str()}))).into_response()
}

fn refused(p: i32, kind: Kind, why: &str) -> Response {
    tracing::warn!(
        provider = p,
        kind = kind.as_str(),
        reason = why,
        "oidc exchange refused"
    );
    refusal(kind)
}

/// Claims the ID token lacks and the userinfo endpoint may hold: the groups, username and email.
async fn complete_claims(
    oidc: &Oidc,
    p: &super::Provider,
    d: &super::Discovery,
    access: Option<&str>,
    claims: &mut Value,
    linked: bool,
) -> Result<(), String> {
    let missing = |k: &str| super::claim_at(claims, k).is_none();
    let groups_missing = p.groups_claim.as_deref().is_some_and(missing);
    let unverified = p.match_by_email && missing("email_verified");
    if linked && !groups_missing {
        return Ok(());
    }
    if !(groups_missing || missing(&p.username_claim) || missing("email") || unverified) {
        return Ok(());
    }
    if d.userinfo_endpoint.is_none() {
        return if groups_missing {
            Err("groups claim missing and no userinfo endpoint".into())
        } else {
            Ok(())
        };
    }
    let Some(access) = access else {
        return if groups_missing {
            Err("no access token for userinfo".into())
        } else {
            Ok(())
        };
    };
    match oidc.userinfo(p, d, access).await {
        Ok(Value::Object(extra)) => {
            if extra.get("sub") != claims.get("sub") {
                return Err("userinfo subject mismatch".into());
            }
            if let Value::Object(own) = claims {
                for (k, v) in extra {
                    own.entry(k).or_insert(v);
                }
            }
            Ok(())
        }
        Ok(_) => Err("invalid userinfo".into()),
        Err(e) => Err(e),
    }
}

#[utoipa::path(post, path = "/api/auth/oidc/exchange", responses((status = 201)))]
pub(crate) async fn exchange(
    State(st): State<AppState>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    ValidJson(dto): ValidJson<ExchangeDto>,
) -> Result<Response, AppError> {
    let Some(row) = db::claim_login(&st.db, &dto.state, Utc::now()).await? else {
        return Ok(refusal(Kind::Expired));
    };
    let caller = match row.link_user_id {
        Some(owner) => {
            let a = session_from_headers(&headers, &st).await?;
            if a.user.id != owner {
                return Ok(refusal(Kind::Expired));
            }
            Some(owner)
        }
        None => None,
    };
    let Some(p) = db::get(&st.db, row.provider_id).await? else {
        return Ok(refusal(Kind::Expired));
    };
    if !p.enabled {
        return Ok(refusal(Kind::Expired));
    }
    if !is_verifier(&dto.verifier) || dto.code.is_empty() || dto.code.len() > 4096 {
        return Ok(refusal(Kind::Idp));
    }
    let Some(public) = db::public_url(&st.db).await? else {
        return Ok(refusal(Kind::Expired));
    };
    let idp = |why: String| refused(p.id, Kind::Idp, &why);
    let d = match st.oidc.discover(&p).await {
        Ok(d) => d,
        Err(e) => return Ok(idp(e)),
    };
    if !d.pkce {
        return Ok(refused(p.id, Kind::Pkce, "no S256"));
    }
    let redirect_uri = format!("{public}/api/auth/oidc/{}/callback", p.id);
    let tokens = match st
        .oidc
        .exchange_code(&p, &d, &redirect_uri, &dto.code, &dto.verifier)
        .await
    {
        Ok(t) => t,
        Err(e) => return Ok(idp(e)),
    };
    let Some(id_token) = tokens.id_token else {
        return Ok(idp("no id_token".into()));
    };
    let mut claims = match st.oidc.verify_id_token(&p, &d, &id_token, &row.nonce).await {
        Ok(c) => c,
        Err(e) => return Ok(idp(e)),
    };
    let linked = match claims.get("sub").and_then(Value::as_str) {
        Some(sub) => db::identity_user(&mut *st.db.acquire().await?, p.id, sub)
            .await?
            .is_some(),
        None => false,
    };
    if let Err(e) = complete_claims(
        &st.oidc,
        &p,
        &d,
        tokens.access_token.as_deref(),
        &mut claims,
        linked,
    )
    .await
    {
        return Ok(idp(e));
    }
    let prof = sync::profile(&p, &claims);
    let ip = peer_ip(&peer, &headers);
    let into = |f: Fail| match f {
        Fail::Kind(k) => Ok(refused(p.id, k, "refused")),
        Fail::Db(e) => Err(AppError::from(e)),
    };
    if let Some(user) = caller {
        return match sync::link(&st, &p, &prof, user).await {
            Ok(()) => {
                st.login_throttle.clear(ip, THROTTLE_KEY);
                Ok(StatusCode::NO_CONTENT.into_response())
            }
            Err(f) => into(f),
        };
    }
    let signed = match sync::login_user(&st, &p, &prof, row.expect_user_id).await {
        Ok(s) => s,
        Err(f) => return into(f),
    };
    if signed.access_changed {
        cut_users(&st, &[signed.user_id]);
    }
    st.login_throttle.clear(ip, THROTTLE_KEY);
    tracing::info!(
        user = signed.user_id,
        provider = p.id,
        sub = %hex_prefix(&prof.sub),
        "oidc sign-in"
    );
    let session = OidcSession {
        provider_id: p.id,
        subject: prof.sub,
        sid: claims.get("sid").and_then(Value::as_str).map(str::to_owned),
        id_token: Some(id_token),
    };
    sign_in(&st, &headers, signed.user_id, SessionKind::Oidc(session)).await
}

/// A subject as logs carry it: a hash prefix, not the identifier.
fn hex_prefix(sub: &str) -> String {
    Sha256::digest(sub.as_bytes())
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[utoipa::path(post, path = "/api/auth/oidc/end-session", responses((status = 200)))]
pub(crate) async fn end_session(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
) -> Result<Response, AppError> {
    let none = || Ok(StatusCode::NO_CONTENT.into_response());
    let Some((provider, id_token)) = db::session_provider(&st.db, a.session()?).await? else {
        return none();
    };
    let Some(p) = db::get(&st.db, provider)
        .await?
        .filter(|p| p.end_session_at_provider)
    else {
        return none();
    };
    let Ok(d) = st.oidc.discover(&p).await else {
        return none();
    };
    let Some(endpoint) = d.end_session_endpoint.as_deref() else {
        return none();
    };
    let Ok(mut url) = reqwest::Url::parse(endpoint) else {
        return none();
    };
    let public = db::public_url(&st.db).await?;
    {
        let mut q = url.query_pairs_mut();
        if let Some(t) = &id_token {
            q.append_pair("id_token_hint", t);
        }
        q.append_pair("client_id", &p.client_id);
        if let Some(public) = &public {
            q.append_pair(
                "post_logout_redirect_uri",
                &format!("{public}/login?autoLaunch=0"),
            );
        }
        q.append_pair("state", &random());
    }
    Ok(Json(json!({"url": url.as_str()})).into_response())
}

fn no_store(mut res: Response) -> Response {
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

#[utoipa::path(post, path = "/api/auth/oidc/{id}/backchannel-logout", responses((status = 200)))]
pub(crate) async fn backchannel_logout(
    State(st): State<AppState>,
    PathParams(id): PathParams<i32>,
    body: Bytes,
) -> Result<Response, AppError> {
    let bad = |why: &str| {
        tracing::warn!(
            provider = id,
            reason = why,
            "oidc back-channel logout refused"
        );
        Ok(no_store(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid_request"})),
            )
                .into_response(),
        ))
    };
    let Some(token) = url::form_urlencoded::parse(&body)
        .find(|(k, _)| k == "logout_token")
        .map(|(_, v)| v.into_owned())
    else {
        return bad("no logout_token");
    };
    let Some(p) = db::get(&st.db, id).await? else {
        return bad("unknown provider");
    };
    let d = match st.oidc.discover(&p).await {
        Ok(d) => d,
        Err(e) => return bad(&e),
    };
    // The signature is checked before any database work.
    let claims = match st.oidc.verify_logout_token(&p, &d, &token).await {
        Ok(c) => c,
        Err(e) => return bad(&e),
    };
    let text = |k: &str| {
        claims
            .get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let users = db::revoke_logged_out(&st.db, p.id, text("sid"), text("sub")).await?;
    cut_users(&st, &users);
    Ok(no_store(StatusCode::OK.into_response()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentityOut {
    provider_id: i32,
    name: String,
    email: Option<String>,
    account_url: Option<String>,
    #[serde(with = "crate::http::json::iso_ms::opt")]
    last_login_at: Option<chrono::DateTime<Utc>>,
}

#[utoipa::path(get, path = "/api/auth/oidc/identities", responses((status = 200)))]
pub(crate) async fn identities(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
) -> Result<Json<Value>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT i."providerId" AS provider_id, p.name, i.email, p."accountUrl" AS account_url,
                  i."lastLoginAt" AS last_login_at
           FROM user_identities i JOIN oidc_providers p ON p.id = i."providerId"
           WHERE i."userId" = $1 ORDER BY p.position, p.id"#,
        a.user.id
    )
    .fetch_all(&st.db)
    .await?;
    let has_password = sqlx::query_scalar!(
        r#"SELECT "passwordHash" IS NOT NULL AS "has!" FROM users WHERE id = $1"#,
        a.user.id
    )
    .fetch_one(&st.db)
    .await?;
    let has_password = has_password && password_usable(&st, &a).await?;
    let identities: Vec<IdentityOut> = rows
        .into_iter()
        .map(|r| IdentityOut {
            provider_id: r.provider_id,
            name: r.name,
            email: r.email,
            account_url: r.account_url,
            last_login_at: r.last_login_at,
        })
        .collect();
    Ok(Json(
        json!({"hasPassword": has_password, "identities": identities}),
    ))
}

/// A stored password is a way in unless `password_login` is `admins` and the caller is not one.
async fn password_usable(st: &AppState, a: &crate::http::auth::Authed) -> Result<bool, AppError> {
    Ok(a.user.is_admin || !db::password_login_admins_only(&st.db).await?)
}

#[utoipa::path(delete, path = "/api/auth/oidc/identities/{provider_id}", responses((status = 204)))]
pub(crate) async fn unlink(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(provider): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    let mut tx = st.db.begin().await?;
    let has_password = sqlx::query_scalar!(
        r#"SELECT "passwordHash" IS NOT NULL AS "has!" FROM users WHERE id = $1 FOR UPDATE"#,
        a.user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    let count = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM user_identities WHERE "userId" = $1"#,
        a.user.id
    )
    .fetch_one(&mut *tx)
    .await?;
    let has_password = has_password && password_usable(&st, &a).await?;
    if count == 1 && !has_password {
        return Err(AppError::bad_request("oidc.error_last_method"));
    }
    let gone = sqlx::query!(
        r#"DELETE FROM user_identities WHERE "userId" = $1 AND "providerId" = $2"#,
        a.user.id,
        provider
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if gone.rows_affected() == 0 {
        return Err(AppError::not_found("Identity not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

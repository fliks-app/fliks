//! Provider administration (`docs/spec/oidc-providers.md`). Admins only: `settings.access` is
//! grantable to a non-admin role, and these rows decide who can become an admin.
use super::{Provider, cut_users, db};
use crate::{
    http::{
        AppError,
        auth::{Authed, UserRow, load_users},
        validate::{PathParams, ValidJson, int_param},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgConnection;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/oidc-providers", get(list).post(create))
        .route("/api/oidc-providers/test", post(test))
        .route(
            "/api/oidc-providers/{id}",
            axum::routing::put(update).delete(remove),
        )
        .route("/api/users/{id}/oidc/{provider_id}", delete(unlink_user))
}

const PROMPTS: [&str; 4] = ["none", "login", "consent", "select_account"];

fn admin(a: &Authed) -> Result<(), AppError> {
    if a.user.is_admin {
        Ok(())
    } else {
        Err(AppError::forbidden("Forbidden resource"))
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Mapping {
    group: String,
    role_id: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderOut {
    id: i32,
    name: String,
    issuer: String,
    client_id: String,
    client_secret_set: bool,
    ca_pem: Option<String>,
    scope: String,
    prompt: Option<String>,
    username_claim: String,
    groups_claim: Option<String>,
    allowed_groups: Vec<String>,
    admin_groups: Vec<String>,
    role_mappings: Vec<Mapping>,
    auto_register: bool,
    match_by_email: bool,
    end_session_at_provider: bool,
    account_url: Option<String>,
    enabled: bool,
    position: i32,
    linked_users: i64,
}

async fn out(db: &sqlx::PgPool, p: Provider) -> Result<ProviderOut, sqlx::Error> {
    let role_mappings = db::role_mappings(db, p.id)
        .await?
        .into_iter()
        .map(|(group, role_id)| Mapping { group, role_id })
        .collect();
    let linked_users = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM user_identities WHERE "providerId" = $1"#,
        p.id
    )
    .fetch_one(db)
    .await?;
    Ok(ProviderOut {
        id: p.id,
        name: p.name,
        issuer: p.issuer,
        client_id: p.client_id,
        client_secret_set: p.client_secret.is_some_and(|s| !s.is_empty()),
        ca_pem: p.ca_pem,
        scope: p.scope,
        prompt: p.prompt,
        username_claim: p.username_claim,
        groups_claim: p.groups_claim,
        allowed_groups: p.allowed_groups,
        admin_groups: p.admin_groups,
        role_mappings,
        auto_register: p.auto_register,
        match_by_email: p.match_by_email,
        end_session_at_provider: p.end_session_at_provider,
        account_url: p.account_url,
        enabled: p.enabled,
        position: p.position,
        linked_users,
    })
}

#[utoipa::path(get, path = "/api/oidc-providers", responses((status = 200)))]
pub(crate) async fn list(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<ProviderOut>>, AppError> {
    admin(&a)?;
    let mut rows = vec![];
    for p in db::list(&st.db).await? {
        rows.push(out(&st.db, p).await?);
    }
    Ok(Json(rows))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ProviderIn {
    name: String,
    issuer: String,
    client_id: String,
    client_secret: Option<String>,
    ca_pem: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    prompt: Option<String>,
    #[serde(default)]
    username_claim: Option<String>,
    groups_claim: Option<String>,
    #[serde(default)]
    allowed_groups: Vec<String>,
    #[serde(default)]
    admin_groups: Vec<String>,
    #[serde(default)]
    role_mappings: Vec<Mapping>,
    #[serde(default)]
    auto_register: bool,
    #[serde(default)]
    match_by_email: bool,
    #[serde(default)]
    end_session_at_provider: bool,
    account_url: Option<String>,
    #[serde(default = "yes")]
    enabled: bool,
    position: Option<i32>,
}

fn yes() -> bool {
    true
}

fn blank(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

fn is_http_url(s: &str) -> bool {
    reqwest::Url::parse(s)
        .is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.host_str().is_some())
}

impl ProviderIn {
    /// Trims and checks every field; the groups parts need a groups claim to read.
    fn validate(&mut self) -> Result<(), AppError> {
        self.name = self.name.trim().to_owned();
        self.issuer = self.issuer.trim().to_owned();
        self.client_id = self.client_id.trim().to_owned();
        self.ca_pem = blank(self.ca_pem.take());
        self.prompt = blank(self.prompt.take());
        self.groups_claim = blank(self.groups_claim.take());
        self.account_url = blank(self.account_url.take());
        self.allowed_groups.retain(|g| !g.trim().is_empty());
        self.admin_groups.retain(|g| !g.trim().is_empty());
        let mut errs = vec![];
        if self.name.is_empty() || self.name.chars().count() > 100 {
            errs.push("name must be 1 to 100 characters");
        }
        if !is_http_url(&self.issuer)
            || reqwest::Url::parse(&self.issuer)
                .is_ok_and(|u| u.query().is_some() || u.fragment().is_some())
        {
            errs.push("issuer must be an http(s) URL");
        }
        if self.client_id.is_empty() {
            errs.push("clientId should not be empty");
        }
        if let Some(pem) = &self.ca_pem
            && !reqwest::Certificate::from_pem_bundle(pem.as_bytes()).is_ok_and(|c| !c.is_empty())
        {
            errs.push("caPem must hold at least one PEM certificate");
        }
        if self
            .prompt
            .as_deref()
            .is_some_and(|p| !PROMPTS.contains(&p))
        {
            errs.push(
                "prompt must be one of the following values: none, login, consent, select_account",
            );
        }
        if self
            .scope
            .as_deref()
            .is_some_and(|s| !s.split_whitespace().any(|t| t == "openid"))
        {
            errs.push("scope must include openid");
        }
        if self.account_url.as_deref().is_some_and(|u| !is_http_url(u)) {
            errs.push("accountUrl must be an http(s) URL");
        }
        let groups_used = !self.allowed_groups.is_empty()
            || !self.admin_groups.is_empty()
            || !self.role_mappings.is_empty();
        if groups_used && self.groups_claim.is_none() {
            errs.push("groupsClaim is required to use groups");
        }
        let mut seen = std::collections::HashSet::new();
        if !self
            .role_mappings
            .iter()
            .all(|m| !m.group.trim().is_empty() && seen.insert(m.group.clone()))
        {
            errs.push("roleMappings groups must be non-empty and unique");
        }
        if errs.is_empty() {
            Ok(())
        } else {
            Err(AppError::bad_request(errs))
        }
    }
}

/// An enabled provider needs `public_url` for its URIs and an IdP that enforces PKCE.
async fn check_enable(st: &AppState, p: &ProviderIn, ca: Option<&str>) -> Result<(), AppError> {
    if db::public_url(&st.db).await?.is_none() {
        return Err(AppError::bad_request(
            "public_url must be set before a provider can be enabled",
        ));
    }
    let d = st
        .oidc
        .discover_uncached(&p.issuer, ca)
        .await
        .map_err(|e| AppError::bad_request(format!("Provider discovery failed: {e}")))?;
    if !d.pkce {
        return Err(AppError::bad_request(
            "The provider does not support PKCE with S256",
        ));
    }
    Ok(())
}

/// With password login restricted to admins, the last enabled provider is the way in for everyone else.
async fn keep_one_provider(c: &mut PgConnection, leaving: i32) -> Result<(), AppError> {
    let admins =
        sqlx::query_scalar!(r#"SELECT value FROM app_settings WHERE key = 'password_login'"#)
            .fetch_optional(&mut *c)
            .await?
            .flatten()
            .as_deref()
            == Some("admins");
    let others = sqlx::query_scalar!(
        r#"SELECT count(*) AS "n!" FROM oidc_providers WHERE enabled AND id <> $1"#,
        leaving
    )
    .fetch_one(c)
    .await?;
    if admins && others == 0 {
        return Err(AppError::conflict(
            "Password login is restricted to admins: keep one provider enabled",
        ));
    }
    Ok(())
}

async fn write_mappings(c: &mut PgConnection, id: i32, m: &[Mapping]) -> Result<(), AppError> {
    sqlx::query!(
        r#"DELETE FROM oidc_role_mappings WHERE "providerId" = $1"#,
        id
    )
    .execute(&mut *c)
    .await?;
    for (i, m) in m.iter().enumerate() {
        let r = sqlx::query!(
            r#"INSERT INTO oidc_role_mappings ("providerId", "group", "roleId", position) VALUES ($1, $2, $3, $4)"#,
            id,
            m.group,
            m.role_id,
            i as i32
        )
        .execute(&mut *c)
        .await;
        match r {
            Err(sqlx::Error::Database(e)) if e.is_foreign_key_violation() => {
                return Err(AppError::bad_request(format!(
                    "Role #{} does not exist",
                    m.role_id
                )));
            }
            other => {
                other?;
            }
        }
    }
    Ok(())
}

#[utoipa::path(post, path = "/api/oidc-providers", responses((status = 201)))]
pub(crate) async fn create(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(mut dto): ValidJson<ProviderIn>,
) -> Result<(StatusCode, Json<ProviderOut>), AppError> {
    admin(&a)?;
    dto.validate()?;
    let secret = blank(dto.client_secret.take());
    if dto.enabled {
        check_enable(&st, &dto, dto.ca_pem.as_deref()).await?;
    }
    let mut tx = st.db.begin().await?;
    let position = match dto.position {
        Some(p) => p,
        None => {
            sqlx::query_scalar!(
                r#"SELECT COALESCE(max(position) + 1, 0) AS "p!" FROM oidc_providers"#
            )
            .fetch_one(&mut *tx)
            .await?
        }
    };
    let id = sqlx::query_scalar!(
        r#"INSERT INTO oidc_providers (name, issuer, "clientId", "clientSecret", "caPem", scope, prompt,
               "usernameClaim", "groupsClaim", "allowedGroups", "adminGroups", "autoRegister", "matchByEmail",
               "endSessionAtProvider", "accountUrl", enabled, position)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'openid profile email'), $7,
               COALESCE($8, 'preferred_username'), $9, $10, $11, $12, $13, $14, $15, $16, $17)
           RETURNING id"#,
        dto.name,
        dto.issuer,
        dto.client_id,
        secret,
        dto.ca_pem,
        blank(dto.scope.clone()),
        dto.prompt,
        blank(dto.username_claim.clone()),
        dto.groups_claim,
        &dto.allowed_groups,
        &dto.admin_groups,
        dto.auto_register,
        dto.match_by_email,
        dto.end_session_at_provider,
        dto.account_url,
        dto.enabled,
        position
    )
    .fetch_one(&mut *tx)
    .await?;
    write_mappings(&mut tx, id, &dto.role_mappings).await?;
    tx.commit().await?;
    let p = db::get(&st.db, id)
        .await?
        .ok_or_else(|| AppError::internal("Internal server error"))?;
    Ok((StatusCode::CREATED, Json(out(&st.db, p).await?)))
}

#[utoipa::path(put, path = "/api/oidc-providers/{id}", responses((status = 200)))]
pub(crate) async fn update(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
    ValidJson(mut dto): ValidJson<ProviderIn>,
) -> Result<Json<ProviderOut>, AppError> {
    admin(&a)?;
    let id = int_param(&id)?;
    dto.validate()?;
    let secret = blank(dto.client_secret.take());
    // The issuer is the identity of every linked account, so a new issuer is a new provider.
    let known = db::get(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found("Provider not found"))?;
    dto.issuer = known.issuer.clone();
    if dto.enabled && !known.enabled {
        check_enable(&st, &dto, dto.ca_pem.as_deref()).await?;
    }
    let mut tx = st.db.begin().await?;
    sqlx::query_scalar!(
        r#"SELECT id FROM oidc_providers WHERE id = $1 FOR UPDATE"#,
        id
    )
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found("Provider not found"))?;
    let before = db::get(&mut *tx, id)
        .await?
        .ok_or_else(|| AppError::not_found("Provider not found"))?;
    if !dto.enabled && before.enabled {
        keep_one_provider(&mut tx, id).await?;
    }
    sqlx::query!(
        r#"UPDATE oidc_providers SET name = $2, "clientId" = $3, "clientSecret" = COALESCE($4, "clientSecret"),
               "caPem" = $5, scope = COALESCE($6, scope), prompt = $7,
               "usernameClaim" = COALESCE($8, "usernameClaim"), "groupsClaim" = $9, "allowedGroups" = $10,
               "adminGroups" = $11, "autoRegister" = $12, "matchByEmail" = $13, "endSessionAtProvider" = $14,
               "accountUrl" = $15, enabled = $16, position = COALESCE($17, position), "updatedAt" = now()
           WHERE id = $1"#,
        id,
        dto.name,
        dto.client_id,
        secret,
        dto.ca_pem,
        blank(dto.scope.clone()),
        dto.prompt,
        blank(dto.username_claim.clone()),
        dto.groups_claim,
        &dto.allowed_groups,
        &dto.admin_groups,
        dto.auto_register,
        dto.match_by_email,
        dto.end_session_at_provider,
        dto.account_url,
        dto.enabled,
        dto.position
    )
    .execute(&mut *tx)
    .await?;
    write_mappings(&mut tx, id, &dto.role_mappings).await?;
    tx.commit().await?;
    st.oidc.invalidate(id);
    if !dto.enabled && before.enabled {
        let users = db::revoke_provider_sessions(&st.db, id).await?;
        cut_users(&st, &users);
    }
    let p = db::get(&st.db, id)
        .await?
        .ok_or_else(|| AppError::not_found("Provider not found"))?;
    Ok(Json(out(&st.db, p).await?))
}

#[utoipa::path(delete, path = "/api/oidc-providers/{id}", responses((status = 204)))]
pub(crate) async fn remove(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<String>,
) -> Result<StatusCode, AppError> {
    admin(&a)?;
    let id = int_param(&id)?;
    let mut tx = st.db.begin().await?;
    let p = db::get(&mut *tx, id)
        .await?
        .ok_or_else(|| AppError::not_found("Provider not found"))?;
    if p.enabled {
        keep_one_provider(&mut tx, id).await?;
    }
    let users = sqlx::query_scalar!(
        r#"SELECT DISTINCT "userId" FROM sessions WHERE "providerId" = $1 AND "revokedAt" IS NULL"#,
        id
    )
    .fetch_all(&mut *tx)
    .await?;
    // Tokens are locked before sessions, as a refresh does; the rows then go with the provider.
    sqlx::query!(
        r#"UPDATE refresh_tokens SET "revokedAt" = COALESCE("revokedAt", now())
           WHERE "sessionId" IN (SELECT id FROM sessions WHERE "providerId" = $1)"#,
        id
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(r#"DELETE FROM oidc_providers WHERE id = $1"#, id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    st.oidc.invalidate(id);
    cut_users(&st, &users);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct TestDto {
    issuer: String,
    ca_pem: Option<String>,
}

#[utoipa::path(post, path = "/api/oidc-providers/test", responses((status = 200)))]
pub(crate) async fn test(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(dto): ValidJson<TestDto>,
) -> Result<Json<Value>, AppError> {
    admin(&a)?;
    let issuer = dto.issuer.trim();
    let ca = blank(dto.ca_pem);
    let fail = |e: String| Ok(Json(json!({"ok": false, "error": e})));
    if !is_http_url(issuer) {
        return fail("invalid url".into());
    }
    if let Some(pem) = &ca
        && !reqwest::Certificate::from_pem_bundle(pem.as_bytes()).is_ok_and(|c| !c.is_empty())
    {
        return fail("invalid ca".into());
    }
    match st.oidc.discover_uncached(issuer, ca.as_deref()).await {
        Ok(d) => Ok(Json(json!({
            "ok": true,
            "issuer": issuer,
            "algs": d.algs.iter().map(|a| format!("{a:?}")).collect::<Vec<_>>(),
            "pkce": d.pkce,
            "endSession": d.end_session_endpoint.is_some(),
            "backchannel": d.backchannel,
        }))),
        Err(e) => fail(e),
    }
}

#[utoipa::path(delete, path = "/api/users/{id}/oidc/{provider_id}", responses((status = 204)))]
pub(crate) async fn unlink_user(
    State(st): State<AppState>,
    a: Authed,
    PathParams((user, provider)): PathParams<(String, String)>,
) -> Result<StatusCode, AppError> {
    a.require(
        fliks_domain::acl::Action::Manage,
        fliks_domain::acl::Subject::User,
    )?;
    let (user, provider) = (int_param(&user)?, int_param(&provider)?);
    let target: UserRow = load_users(&st.db, Some(user), false)
        .await?
        .pop()
        .map(|(u, _)| u)
        .ok_or_else(|| crate::users::not_found(user))?;
    if target.is_admin && !a.user.is_admin {
        return Err(AppError::bare(StatusCode::FORBIDDEN));
    }
    let gone = sqlx::query!(
        r#"DELETE FROM user_identities WHERE "userId" = $1 AND "providerId" = $2"#,
        user,
        provider
    )
    .execute(&st.db)
    .await?;
    if gone.rows_affected() == 0 {
        return Err(AppError::not_found("Identity not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

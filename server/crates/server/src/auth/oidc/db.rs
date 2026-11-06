//! Provider, login-row, identity and session queries of the OIDC flow.
use crate::auth::db as sessions;
use chrono::{DateTime, Duration, Utc};
use sqlx::{PgConnection, PgPool};

#[derive(Debug, Clone)]
pub struct Provider {
    pub id: i32,
    pub name: String,
    pub issuer: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub ca_pem: Option<String>,
    pub scope: String,
    pub prompt: Option<String>,
    pub username_claim: String,
    pub groups_claim: Option<String>,
    pub allowed_groups: Vec<String>,
    pub admin_groups: Vec<String>,
    pub auto_register: bool,
    pub match_by_email: bool,
    pub end_session_at_provider: bool,
    pub account_url: Option<String>,
    pub enabled: bool,
    pub position: i32,
}

pub async fn get(db: impl sqlx::PgExecutor<'_>, id: i32) -> Result<Option<Provider>, sqlx::Error> {
    sqlx::query_as!(
        Provider,
        r#"SELECT id, name, issuer, "clientId" AS client_id, "clientSecret" AS client_secret,
                  "caPem" AS ca_pem, scope, prompt, "usernameClaim" AS username_claim,
                  "groupsClaim" AS groups_claim, "allowedGroups" AS "allowed_groups!",
                  "adminGroups" AS "admin_groups!", "autoRegister" AS auto_register,
                  "matchByEmail" AS match_by_email, "endSessionAtProvider" AS end_session_at_provider,
                  "accountUrl" AS account_url, enabled, position
           FROM oidc_providers WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await
}

pub async fn list(db: impl sqlx::PgExecutor<'_>) -> Result<Vec<Provider>, sqlx::Error> {
    sqlx::query_as!(
        Provider,
        r#"SELECT id, name, issuer, "clientId" AS client_id, "clientSecret" AS client_secret,
                  "caPem" AS ca_pem, scope, prompt, "usernameClaim" AS username_claim,
                  "groupsClaim" AS groups_claim, "allowedGroups" AS "allowed_groups!",
                  "adminGroups" AS "admin_groups!", "autoRegister" AS auto_register,
                  "matchByEmail" AS match_by_email, "endSessionAtProvider" AS end_session_at_provider,
                  "accountUrl" AS account_url, enabled, position
           FROM oidc_providers ORDER BY position, id"#
    )
    .fetch_all(db)
    .await
}

/// `(group, role id)` of a provider, first match first.
pub async fn role_mappings(
    db: impl sqlx::PgExecutor<'_>,
    provider: i32,
) -> Result<Vec<(String, i32)>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT "group" AS grp, "roleId" AS role_id FROM oidc_role_mappings
           WHERE "providerId" = $1 ORDER BY position"#,
        provider
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.grp, r.role_id)).collect())
}

/// The base URL the provider's URIs are built on, without a trailing slash.
pub async fn public_url(db: impl sqlx::PgExecutor<'_>) -> Result<Option<String>, sqlx::Error> {
    Ok(
        sqlx::query_scalar!(r#"SELECT value FROM app_settings WHERE key = 'public_url'"#)
            .fetch_optional(db)
            .await?
            .flatten()
            .map(|u| u.trim().trim_end_matches('/').to_owned())
            .filter(|u| !u.is_empty()),
    )
}

pub async fn password_login_admins_only(db: &PgPool) -> Result<bool, sqlx::Error> {
    Ok(
        sqlx::query_scalar!(r#"SELECT value FROM app_settings WHERE key = 'password_login'"#)
            .fetch_optional(db)
            .await?
            .flatten()
            .as_deref()
            == Some("admins"),
    )
}

pub struct Login {
    pub provider_id: i32,
    pub nonce: String,
    pub return_to: String,
    pub link_user_id: Option<i32>,
    pub expect_user_id: Option<i32>,
}

pub const LOGIN_TTL: Duration = Duration::minutes(10);

pub async fn insert_login(
    db: &PgPool,
    provider: i32,
    state: &str,
    nonce: &str,
    return_to: &str,
    link_user: Option<i32>,
    expect_user: Option<i32>,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"INSERT INTO oidc_logins ("providerId", state, nonce, "returnTo", "linkUserId", "expectUserId", "expiresAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7)"#,
        provider,
        state,
        nonce,
        return_to,
        link_user,
        expect_user,
        now + LOGIN_TTL
    )
    .execute(db)
    .await
    .map(drop)
}

/// The row of an unexpired `state`, left in place (the callback only routes the redirect).
pub async fn peek_login(
    db: &PgPool,
    state: &str,
    now: DateTime<Utc>,
) -> Result<Option<Login>, sqlx::Error> {
    sqlx::query_as!(
        Login,
        r#"SELECT "providerId" AS provider_id, nonce, "returnTo" AS return_to, "linkUserId" AS link_user_id,
                  "expectUserId" AS expect_user_id
           FROM oidc_logins WHERE state = $1 AND "expiresAt" > $2"#,
        state,
        now
    )
    .fetch_optional(db)
    .await
}

/// Single use: whoever deletes the row owns the login.
pub async fn claim_login(
    db: &PgPool,
    state: &str,
    now: DateTime<Utc>,
) -> Result<Option<Login>, sqlx::Error> {
    sqlx::query_as!(
        Login,
        r#"DELETE FROM oidc_logins WHERE state = $1 AND "expiresAt" > $2
           RETURNING "providerId" AS provider_id, nonce, "returnTo" AS return_to, "linkUserId" AS link_user_id,
                     "expectUserId" AS expect_user_id"#,
        state,
        now
    )
    .fetch_optional(db)
    .await
}

/// Rows a login left behind (abandoned in the IdP's page) are gone an hour after they expired.
pub async fn cleanup_logins(db: &PgPool, now: DateTime<Utc>) -> Result<u64, sqlx::Error> {
    sqlx::query!(
        r#"DELETE FROM oidc_logins WHERE "expiresAt" < $1"#,
        now - Duration::hours(1)
    )
    .execute(db)
    .await
    .map(|r| r.rows_affected())
}

pub async fn identity_user(
    c: &mut PgConnection,
    provider: i32,
    subject: &str,
) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT "userId" FROM user_identities WHERE "providerId" = $1 AND subject = $2"#,
        provider,
        subject
    )
    .fetch_optional(c)
    .await
}

pub async fn insert_identity(
    c: &mut PgConnection,
    user: i32,
    provider: i32,
    subject: &str,
    email: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"INSERT INTO user_identities ("userId", "providerId", subject, email) VALUES ($1, $2, $3, $4)"#,
        user,
        provider,
        subject,
        email
    )
    .execute(c)
    .await
    .map(drop)
}

pub async fn touch_identity(
    db: &PgPool,
    provider: i32,
    subject: &str,
    email: Option<&str>,
) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"UPDATE user_identities SET "lastLoginAt" = now(), email = COALESCE($3, email)
           WHERE "providerId" = $1 AND subject = $2"#,
        provider,
        subject,
        email
    )
    .execute(db)
    .await
    .map(drop)
}

/// The users a verified email may be adopted by: accounts an admin created for SSO (no password, never
/// signed in, no identity), since `users.email` is self-set and proves nothing.
pub async fn adoptable_by_email(
    c: &mut PgConnection,
    email: &str,
) -> Result<Vec<i32>, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT u.id FROM users u WHERE lower(u.email) = lower($1) AND NOT u."isAdmin"
             AND u."passwordHash" IS NULL AND u."lastLogin" IS NULL
             AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i."userId" = u.id)
           ORDER BY u.id"#,
        email
    )
    .fetch_all(c)
    .await
}

pub async fn username_exists(c: &mut PgConnection, name: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS(SELECT 1 FROM users WHERE lower(username) = lower($1)) AS "taken!""#,
        name
    )
    .fetch_one(c)
    .await
}

pub async fn default_role(c: &mut PgConnection) -> Result<Option<i32>, sqlx::Error> {
    sqlx::query_scalar!(r#"SELECT id FROM roles WHERE "isDefault" ORDER BY id LIMIT 1"#)
        .fetch_optional(c)
        .await
}

/// The role, admin flag and library ids a user holds now.
pub async fn current_access(
    c: &mut PgConnection,
    user: i32,
) -> Result<(Option<i32>, bool, Vec<i32>), sqlx::Error> {
    let u = sqlx::query!(
        r#"SELECT "roleId" AS role_id, "isAdmin" AS is_admin FROM users WHERE id = $1"#,
        user
    )
    .fetch_one(&mut *c)
    .await?;
    let libs = sqlx::query_scalar!(
        r#"SELECT "libraryId" AS "library_id!" FROM library_user_access WHERE "userId" = $1 ORDER BY "libraryId""#,
        user
    )
    .fetch_all(c)
    .await?;
    Ok((u.role_id, u.is_admin, libs))
}

/// Revokes the live sessions picked by `ids`; returns their users.
async fn revoke_ids(db: &PgPool, ids: Vec<(i32, i32)>) -> Result<Vec<i32>, sqlx::Error> {
    let now = Utc::now();
    let mut tx = db.begin().await?;
    for (id, _) in &ids {
        sessions::revoke_session(&mut tx, *id, now).await?;
    }
    tx.commit().await?;
    let mut users: Vec<i32> = ids.into_iter().map(|(_, u)| u).collect();
    users.sort_unstable();
    users.dedup();
    Ok(users)
}

/// Signs every session opened at the provider out; returns the users to cut at the hub and engine.
pub async fn revoke_provider_sessions(db: &PgPool, provider: i32) -> Result<Vec<i32>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT id, "userId" AS user_id FROM sessions WHERE "providerId" = $1 AND "revokedAt" IS NULL"#,
        provider
    )
    .fetch_all(db)
    .await?;
    revoke_ids(db, rows.into_iter().map(|r| (r.id, r.user_id)).collect()).await
}

/// Back-channel logout: the provider's sessions with this `sid`, and those without one that have this subject.
pub async fn revoke_logged_out(
    db: &PgPool,
    provider: i32,
    sid: Option<&str>,
    subject: Option<&str>,
) -> Result<Vec<i32>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT id, "userId" AS user_id FROM sessions
           WHERE "providerId" = $1 AND "revokedAt" IS NULL
             AND (sid = $2 OR ((sid IS NULL OR $2::text IS NULL) AND subject = $3))"#,
        provider,
        sid,
        subject
    )
    .fetch_all(db)
    .await?;
    revoke_ids(db, rows.into_iter().map(|r| (r.id, r.user_id)).collect()).await
}

/// The provider session row an RP-initiated logout reads: `(provider id, id_token)`.
pub async fn session_provider(
    db: &PgPool,
    session: i32,
) -> Result<Option<(i32, Option<String>)>, sqlx::Error> {
    let r = sqlx::query!(
        r#"SELECT "providerId" AS provider_id, "idToken" AS id_token FROM sessions WHERE id = $1"#,
        session
    )
    .fetch_optional(db)
    .await?;
    Ok(r.and_then(|r| r.provider_id.map(|p| (p, r.id_token))))
}

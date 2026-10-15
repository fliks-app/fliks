//! Request authentication (`docs/spec/auth.md` section B): `Authed` and its variants.
//!
//! Every extractor reads the token from cookie `fliks_access`, else `Authorization: Bearer`, else `?token=`
//! (first non-empty wins, no fall-through on a bad one), then loads the user and role on every request.
use super::{
    AppError,
    cookies::{ACCESS_COOKIE, cookie_value},
    json::iso_ms,
};
use crate::{auth_token::TokenScope, state::AppState};
use axum::{
    extract::{FromRef, FromRequestParts, Query},
    http::{HeaderMap, StatusCode, header::AUTHORIZATION, request::Parts},
};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Permissions, Subject};
use serde::Serialize;
use sqlx::{PgPool, Row, postgres::PgRow, types::Json};

/// A `users` row without `passwordHash`; enums are read as text and JSON columns as typed lists.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
#[sqlx(rename_all = "camelCase")]
pub struct UserRow {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub username: String,
    pub email: Option<String>,
    pub role_id: Option<i32>,
    pub media_server_type: String,
    pub media_server_id: Option<String>,
    pub avatar: Option<String>,
    #[serde(with = "iso_ms::opt")]
    pub last_login: Option<DateTime<Utc>>,
    pub is_admin: bool,
    pub enabled: bool,
    pub require_password_change: bool,
    pub movie_quota_limit: i32,
    pub series_quota_limit: i32,
    pub quota_period_days: i32,
    pub library_order: Json<Vec<i32>>,
    pub hidden_library_ids: Json<Vec<i32>>,
    pub profile_visibility: String,
    pub share_tastes: bool,
    pub share_recommendations: bool,
    pub share_watch_history: bool,
    pub share_likes: bool,
    pub share_stats: bool,
    pub share_disabled: bool,
    pub hide_spoilers: bool,
    pub edl_enabled: bool,
    pub edl_auto_skip_commercials: bool,
    pub spoiler_hide_stills: bool,
    pub spoiler_hide_overviews: bool,
    pub spoiler_hide_titles: bool,
}

/// A `roles` row; `permissions` is the JSON text column parsed (an unparsable value is no permission).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleRow {
    pub id: i32,
    #[serde(with = "iso_ms")]
    pub created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub permissions: Vec<String>,
    pub is_default: bool,
}

/// Every `UserRow` column, enums cast to text; reuse in any query that returns a `UserRow`.
pub const USER_COLUMNS: &str = r#"u."id", u."createdAt", u."updatedAt", u."username", u."email", u."roleId",
    u."mediaServerType"::text AS "mediaServerType", u."mediaServerId", u."avatar", u."lastLogin",
    u."isAdmin", u."enabled", u."requirePasswordChange", u."movieQuotaLimit", u."seriesQuotaLimit",
    u."quotaPeriodDays", u."libraryOrder", u."hiddenLibraryIds", u."profileVisibility"::text AS "profileVisibility",
    u."shareTastes", u."shareRecommendations", u."shareWatchHistory", u."shareLikes", u."shareStats",
    u."shareDisabled", u."hideSpoilers", u."edlEnabled", u."edlAutoSkipCommercials",
    u."spoilerHideStills", u."spoilerHideOverviews", u."spoilerHideTitles""#;

/// The user (if any) of `id` with its role, only when enabled: one query, no caching.
pub async fn load_enabled(
    db: &PgPool,
    id: i32,
) -> Result<Option<(UserRow, Option<RoleRow>)>, sqlx::Error> {
    let sql = format!(
        r#"SELECT {USER_COLUMNS}, r."id" AS "roleRowId", r."createdAt" AS "roleCreatedAt",
              r."updatedAt" AS "roleUpdatedAt", r."name" AS "roleName",
              r."permissions" AS "rolePermissions", r."isDefault" AS "roleIsDefault"
           FROM users u LEFT JOIN roles r ON r."id" = u."roleId"
           WHERE u."id" = $1 AND u."enabled" = true LIMIT 1"#
    );
    let Some(row) = sqlx::query(&sql).bind(id).fetch_optional(db).await? else {
        return Ok(None);
    };
    let user = <UserRow as sqlx::FromRow<PgRow>>::from_row(&row)?;
    let role = match row.try_get::<Option<i32>, _>("roleRowId")? {
        None => None,
        Some(id) => Some(RoleRow {
            id,
            created_at: row.try_get("roleCreatedAt")?,
            updated_at: row.try_get("roleUpdatedAt")?,
            name: row.try_get("roleName")?,
            permissions: serde_json::from_str(&row.try_get::<String, _>("rolePermissions")?)
                .unwrap_or_default(),
            is_default: row.try_get("roleIsDefault")?,
        }),
    };
    Ok(Some((user, role)))
}

/// An authenticated, enabled user. Plain `Authed` refuses `scope` tokens (F8); see `StreamAuthed`.
#[derive(Debug, Clone)]
pub struct Authed {
    pub user: UserRow,
    pub role: Option<RoleRow>,
    pub perms: Permissions,
    pub scope: Option<TokenScope>,
}

impl Authed {
    /// The handler's first line: 403 with Nest's `PoliciesGuard` body unless the role grants it at class level.
    pub fn require(&self, action: Action, subject: Subject) -> Result<(), AppError> {
        if self.perms.can(action, &subject) {
            Ok(())
        } else {
            Err(AppError::forbidden("Forbidden resource"))
        }
    }
}

/// Like `Authed` but also accepts `scope: 'stream'` tokens: only for routes that deliver media.
#[derive(Debug, Clone)]
pub struct StreamAuthed(pub Authed);

/// `Authed` for routes behind Nest's `SessionTokenGuard`: a scoped token is 403 `session_token_required`.
#[derive(Debug, Clone)]
pub struct SessionAuthed(pub Authed);

/// No credentials at all is `None`; credentials that fail are still 401, never downgraded to anonymous.
#[derive(Debug, Clone)]
pub struct OptionalAuthed(pub Option<Authed>);

fn unauthorized() -> AppError {
    AppError::bare(StatusCode::UNAUTHORIZED)
}

/// `Authorization: Bearer <t>` as passport-jwt reads it: scheme case-insensitive, token the next word.
fn bearer(headers: &HeaderMap) -> Option<&str> {
    let mut words = headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .split_whitespace();
    let (scheme, token) = (words.next()?, words.next()?);
    scheme.eq_ignore_ascii_case("bearer").then_some(token)
}

fn query_token(parts: &Parts) -> Option<String> {
    let Query(pairs) = Query::<Vec<(String, String)>>::try_from_uri(&parts.uri).ok()?;
    pairs
        .into_iter()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v)
}

/// First non-empty of cookie, Bearer, `?token=`: an empty cookie is absent, a stale one shadows Bearer.
fn token_of(parts: &Parts) -> Option<String> {
    cookie_value(&parts.headers, ACCESS_COOKIE)
        .filter(|t| !t.is_empty())
        .or_else(|| bearer(&parts.headers).map(str::to_owned))
        .or_else(|| query_token(parts))
        .filter(|t| !t.is_empty())
}

/// The token `POST /auth/logout` attributes the SSE drop to (`auth.md` rule 50): the cookie even when
/// empty (which then suppresses Bearer), else a header starting exactly `Bearer `; never `?token=`.
pub fn logout_token(headers: &HeaderMap) -> Option<String> {
    cookie_value(headers, ACCESS_COOKIE).or_else(|| {
        let h = headers.get(AUTHORIZATION)?.to_str().ok()?;
        h.strip_prefix("Bearer ").map(str::to_owned)
    })
}

/// `Ok(None)`: no token. Any failure after a token is present is 401.
async fn authenticate(parts: &Parts, state: &AppState) -> Result<Option<Authed>, AppError> {
    let Some(token) = token_of(parts) else {
        return Ok(None);
    };
    let claims = state.jwt.verify(&token).ok_or_else(unauthorized)?;
    let (user, role) = load_enabled(&state.db, claims.sub)
        .await?
        .ok_or_else(unauthorized)?;
    let perms = Permissions::from(
        role.as_ref().map_or(&[][..], |r| &r.permissions),
        user.is_admin,
    );
    Ok(Some(Authed {
        user,
        role,
        perms,
        scope: claims.scope,
    }))
}

async fn required<S>(parts: &Parts, state: &S) -> Result<Authed, AppError>
where
    AppState: FromRef<S>,
{
    authenticate(parts, &AppState::from_ref(state))
        .await?
        .ok_or_else(unauthorized)
}

impl<S: Send + Sync> FromRequestParts<S> for Authed
where
    AppState: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        let a = required(parts, state).await?;
        if a.scope.is_some() {
            return Err(unauthorized());
        }
        Ok(a)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for StreamAuthed
where
    AppState: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        required(parts, state).await.map(Self)
    }
}

impl<S: Send + Sync> FromRequestParts<S> for SessionAuthed
where
    AppState: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        let a = required(parts, state).await?;
        if a.scope.is_some() {
            return Err(AppError::forbidden("session_token_required"));
        }
        Ok(Self(a))
    }
}

impl<S: Send + Sync> FromRequestParts<S> for OptionalAuthed
where
    AppState: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        match authenticate(parts, &AppState::from_ref(state)).await? {
            Some(a) if a.scope.is_some() => Err(unauthorized()),
            a => Ok(Self(a)),
        }
    }
}

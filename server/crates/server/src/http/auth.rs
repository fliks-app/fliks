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
use fliks_domain::{
    acl::{Action, Permissions, Subject},
    media::kind::MediaKind,
};
use serde::{Serialize, Serializer, ser::SerializeMap};
use sqlx::{PgPool, types::Json};
use std::collections::HashMap;

/// A user's request limit per media kind, written flat as `<kind>QuotaLimit`; no entry is 0.
#[derive(Debug, Clone, Default)]
pub struct Quotas(HashMap<MediaKind, i32>);

impl Quotas {
    pub fn limit(&self, kind: MediaKind) -> i32 {
        self.0.get(&kind).copied().unwrap_or(0)
    }
}

impl Serialize for Quotas {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(MediaKind::ALL.len()))?;
        for k in MediaKind::ALL {
            m.serialize_entry(&format!("{k}QuotaLimit"), &self.limit(k))?;
        }
        m.end()
    }
}

/// A `users` row without `passwordHash`; enums are read as text and JSON columns as typed lists.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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
    #[serde(flatten)]
    pub quotas: Quotas,
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

/// The user (if any) of `id` with its role, only when enabled: one query, no caching.
pub async fn load_enabled(
    db: &PgPool,
    id: i32,
) -> Result<Option<(UserRow, Option<RoleRow>)>, sqlx::Error> {
    Ok(load_users(db, Some(id), true).await?.pop())
}

/// The users (all, or one by id) with their role, optionally only enabled ones, ordered by username.
pub async fn load_users(
    db: impl sqlx::PgExecutor<'_>,
    id: Option<i32>,
    enabled_only: bool,
) -> Result<Vec<(UserRow, Option<RoleRow>)>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT
        u."id", u."createdAt" AS created_at, u."updatedAt" AS updated_at,
        u."username" AS username, u."email" AS email, u."roleId" AS role_id,
        u."mediaServerType"::text AS "media_server_type!",
        u."mediaServerId" AS media_server_id, u."avatar" AS avatar,
        u."lastLogin" AS last_login, u."isAdmin" AS is_admin, u."enabled" AS enabled,
        u."requirePasswordChange" AS require_password_change,
        COALESCE((SELECT jsonb_object_agg(q."kind", q."limit") FROM user_quotas q
            WHERE q."userId" = u."id"), '{}'::jsonb) AS "quotas!: Json<HashMap<MediaKind, i32>>",
        u."quotaPeriodDays" AS quota_period_days,
        u."libraryOrder" AS "library_order: Json<Vec<i32>>",
        u."hiddenLibraryIds" AS "hidden_library_ids: Json<Vec<i32>>",
        u."profileVisibility"::text AS "profile_visibility!",
        u."shareTastes" AS share_tastes, u."shareRecommendations" AS share_recommendations,
        u."shareWatchHistory" AS share_watch_history, u."shareLikes" AS share_likes,
        u."shareStats" AS share_stats, u."shareDisabled" AS share_disabled,
        u."hideSpoilers" AS hide_spoilers, u."edlEnabled" AS edl_enabled,
        u."edlAutoSkipCommercials" AS edl_auto_skip_commercials,
        u."spoilerHideStills" AS spoiler_hide_stills,
        u."spoilerHideOverviews" AS spoiler_hide_overviews,
        u."spoilerHideTitles" AS spoiler_hide_titles,
        r."id" AS "role_row_id?", r."createdAt" AS "role_created_at?", r."updatedAt" AS "role_updated_at?",
        r."name" AS "role_name?", r."permissions" AS "role_permissions?", r."isDefault" AS "role_is_default?"
    FROM users u LEFT JOIN roles r ON r."id" = u."roleId"
    WHERE ($1::int IS NULL OR u."id" = $1) AND (NOT $2 OR u."enabled")
    ORDER BY u."username" ASC"#,
        id,
        enabled_only
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let role = r.role_row_id.map(|id| RoleRow {
                id,
                created_at: r.role_created_at.unwrap_or_default(),
                updated_at: r.role_updated_at.unwrap_or_default(),
                name: r.role_name.unwrap_or_default(),
                permissions: serde_json::from_str(&r.role_permissions.unwrap_or_default())
                    .unwrap_or_default(),
                is_default: r.role_is_default.unwrap_or_default(),
            });
            let user = UserRow {
                id: r.id,
                created_at: r.created_at,
                updated_at: r.updated_at,
                username: r.username,
                email: r.email,
                role_id: r.role_id,
                media_server_type: r.media_server_type,
                media_server_id: r.media_server_id,
                avatar: r.avatar,
                last_login: r.last_login,
                is_admin: r.is_admin,
                enabled: r.enabled,
                require_password_change: r.require_password_change,
                quotas: Quotas(r.quotas.0),
                quota_period_days: r.quota_period_days,
                library_order: r.library_order,
                hidden_library_ids: r.hidden_library_ids,
                profile_visibility: r.profile_visibility,
                share_tastes: r.share_tastes,
                share_recommendations: r.share_recommendations,
                share_watch_history: r.share_watch_history,
                share_likes: r.share_likes,
                share_stats: r.share_stats,
                share_disabled: r.share_disabled,
                hide_spoilers: r.hide_spoilers,
                edl_enabled: r.edl_enabled,
                edl_auto_skip_commercials: r.edl_auto_skip_commercials,
                spoiler_hide_stills: r.spoiler_hide_stills,
                spoiler_hide_overviews: r.spoiler_hide_overviews,
                spoiler_hide_titles: r.spoiler_hide_titles,
            };
            (user, role)
        })
        .collect())
}

/// An authenticated, enabled user. Plain `Authed` refuses `scope` tokens; see `StreamAuthed`.
#[derive(Debug, Clone)]
pub struct Authed {
    pub user: UserRow,
    pub role: Option<RoleRow>,
    pub perms: Permissions,
    pub scope: Option<TokenScope>,
}

impl Authed {
    fn new(user: UserRow, role: Option<RoleRow>, scope: Option<TokenScope>) -> Self {
        let perms = Permissions::from(
            role.as_ref().map_or(&[][..], |r| &r.permissions),
            user.is_admin,
        );
        Self {
            user,
            role,
            perms,
            scope,
        }
    }

    /// The user `id` as a request of theirs would load them, with no token scope; `None` when
    /// disabled or gone.
    pub async fn load(db: &PgPool, id: i32) -> Result<Option<Self>, sqlx::Error> {
        Ok(load_enabled(db, id)
            .await?
            .map(|(user, role)| Self::new(user, role, None)))
    }

    /// The handler's first line: 403 with the 4.x policy body unless the role grants it at class level.
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

/// `Authed` for routes behind the session-token guard: a scoped token is 403 `session_token_required`.
#[derive(Debug, Clone)]
pub struct SessionAuthed(pub Authed);

/// `Authed` that also takes a file-bound stream token (`mf`); the route must check `bound_file`
/// against what the request touches. Unbound stream tokens are 401.
#[derive(Debug, Clone)]
pub struct FileBoundAuthed {
    pub auth: Authed,
    pub bound_file: Option<u32>,
}

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
    Ok(authenticate_bound(parts, state).await?.map(|(a, _)| a))
}

/// `authenticate` plus the media file the token is bound to (`mf`).
async fn authenticate_bound(
    parts: &Parts,
    state: &AppState,
) -> Result<Option<(Authed, Option<u32>)>, AppError> {
    let Some(token) = token_of(parts) else {
        return Ok(None);
    };
    let claims = state
        .jwt
        .verify(&token)
        .filter(|c| c.live.is_none())
        .ok_or_else(unauthorized)?;
    let (user, role) = load_enabled(&state.db, claims.sub)
        .await?
        .ok_or_else(unauthorized)?;
    Ok(Some((Authed::new(user, role, claims.scope), claims.mf)))
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

impl<S: Send + Sync> FromRequestParts<S> for FileBoundAuthed
where
    AppState: FromRef<S>,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, AppError> {
        let (auth, mf) = authenticate_bound(parts, &AppState::from_ref(state))
            .await?
            .ok_or_else(unauthorized)?;
        let Some(scope) = auth.scope else {
            return Ok(Self {
                auth,
                bound_file: None,
            });
        };
        let bound_file = (scope == TokenScope::Stream)
            .then_some(mf)
            .flatten()
            .ok_or_else(unauthorized)?;
        Ok(Self {
            auth,
            bound_file: Some(bound_file),
        })
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

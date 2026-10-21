//! Follow graph and discovery (`docs/spec/social.md` rules 8-22).
use super::{follows, require_user, user_not_found};
use crate::{
    events::SseEvent,
    http::{AppError, auth::Authed, validate::PathParams},
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

const SEARCH_LIMIT: i64 = 30;

/// `id, username, avatar` of a listed member.
pub struct Brief {
    pub id: i32,
    pub username: String,
    pub avatar: Option<String>,
    pub enabled: bool,
    pub share_disabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialUser {
    id: i32,
    username: String,
    avatar: Option<String>,
    is_following: bool,
    requested: bool,
    follows_you: bool,
}

/// The one predicate deciding whether a member may appear in a social list.
pub fn listable(enabled: bool, share_disabled: bool) -> bool {
    enabled && !share_disabled
}

/// `SocialUser`s in the input order, with the viewer's edges to and from each (rules 20, 57).
pub async fn decorate(
    db: &PgPool,
    me: i32,
    mut users: Vec<Brief>,
) -> sqlx::Result<Vec<SocialUser>> {
    users.retain(|u| listable(u.enabled, u.share_disabled));
    if users.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<i32> = users.iter().map(|u| u.id).collect();
    let out: HashMap<i32, String> = sqlx::query!(
        r#"SELECT "followingId" AS id, status::text AS "status!" FROM user_follows
           WHERE "followerId" = $1 AND "followingId" = ANY($2)"#,
        me,
        &ids
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|r| (r.id, r.status))
    .collect();
    let back: HashSet<i32> = sqlx::query_scalar!(
        r#"SELECT "followerId" FROM user_follows
           WHERE "followerId" = ANY($1) AND "followingId" = $2 AND status = 'accepted'"#,
        &ids,
        me
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();
    Ok(users
        .into_iter()
        .map(|u| SocialUser {
            is_following: out.get(&u.id).is_some_and(|s| s == "accepted"),
            requested: out.get(&u.id).is_some_and(|s| s == "pending"),
            follows_you: back.contains(&u.id),
            id: u.id,
            username: u.username,
            avatar: u.avatar,
        })
        .collect())
}

fn param<'a>(q: &'a [(String, String)], key: &str) -> Option<&'a str> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// Enabled, opted-in members other than the caller, `ILIKE` on the trimmed `q`, 30 by `lower(username), id` (rules 21-22).
async fn find_users(
    st: &AppState,
    a: &Authed,
    q: &[(String, String)],
    connectable: bool,
) -> Result<Vec<SocialUser>, AppError> {
    if a.user.share_disabled {
        return Ok(vec![]);
    }
    let pattern = param(q, "q")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let users = sqlx::query_as!(
        Brief,
        r#"SELECT u.id, u.username, u.avatar, u.enabled, u."shareDisabled" AS share_disabled FROM users u
           WHERE u.enabled = true AND u."shareDisabled" = false AND u.id <> $1
             AND ($2::text IS NULL OR u.username ILIKE $2)
             AND (NOT $3 OR u."profileVisibility" = 'public' OR EXISTS (
                   SELECT 1 FROM user_follows f
                   WHERE f."followerId" = $1 AND f."followingId" = u.id AND f.status = 'accepted'))
           ORDER BY lower(u.username) COLLATE "C", u.id
           LIMIT $4"#,
        a.user.id,
        pattern,
        connectable,
        SEARCH_LIMIT
    )
    .fetch_all(&st.db)
    .await?;
    Ok(decorate(&st.db, a.user.id, users).await?)
}

#[utoipa::path(get, path = "/api/social/search", responses((status = 200)))]
pub async fn search(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Vec<SocialUser>>, AppError> {
    Ok(Json(find_users(&st, &a, &q, false).await?))
}

#[utoipa::path(get, path = "/api/social/connectable", responses((status = 200)))]
pub async fn connectable(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Vec<SocialUser>>, AppError> {
    Ok(Json(find_users(&st, &a, &q, true).await?))
}

#[utoipa::path(get, path = "/api/social/requests", responses((status = 200)))]
pub async fn requests(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<SocialUser>>, AppError> {
    let users = sqlx::query_as!(
        Brief,
        r#"SELECT u.id, u.username, u.avatar, u.enabled, u."shareDisabled" AS share_disabled FROM user_follows uf
           JOIN users u ON u.id = uf."followerId"
           WHERE uf."followingId" = $1 AND uf.status = 'pending'
           ORDER BY uf.id"#,
        a.user.id
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(decorate(&st.db, a.user.id, users).await?))
}

fn disabled() -> AppError {
    AppError::bad_request("Sharing features are disabled")
}

#[utoipa::path(post, path = "/api/social/follow/{userId}", responses((status = 201)))]
pub async fn follow(
    State(st): State<AppState>,
    a: Authed,
    PathParams(target): PathParams<i32>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let me = &a.user;
    if me.id == target {
        return Err(AppError::bad_request("Cannot follow yourself"));
    }
    if me.share_disabled {
        return Err(disabled());
    }
    let t = require_user(&st.db, target).await?;
    if t.share_disabled {
        return Err(user_not_found(target));
    }
    let status = if t.public { "accepted" } else { "pending" };
    let inserted = sqlx::query_scalar!(
        r#"INSERT INTO user_follows ("followerId", "followingId", status)
           VALUES ($1, $2, $3::text::user_follows_status_enum)
           ON CONFLICT ("followerId", "followingId") DO NOTHING RETURNING id"#,
        me.id,
        target,
        status
    )
    .fetch_optional(&st.db)
    .await?;
    if inserted.is_none() {
        let existing = sqlx::query_scalar!(
            r#"SELECT status::text AS "status!" FROM user_follows
               WHERE "followerId" = $1 AND "followingId" = $2"#,
            me.id,
            target
        )
        .fetch_optional(&st.db)
        .await?
        // A concurrent unfollow removed the edge: same outcome as follow then unfollow.
        .unwrap_or_else(|| status.to_owned());
        return Ok((StatusCode::CREATED, Json(json!({"status": existing}))));
    }
    let (user_id, username, avatar) = (me.id.into(), me.username.clone(), me.avatar.clone());
    st.hub.emit_to_user(
        target,
        if t.public {
            SseEvent::SocialFollowed {
                user_id,
                username,
                avatar,
            }
        } else {
            SseEvent::SocialFollowRequest {
                user_id,
                username,
                avatar,
            }
        },
    );
    Ok((StatusCode::CREATED, Json(json!({"status": status}))))
}

#[utoipa::path(delete, path = "/api/social/follow/{userId}", responses((status = 200)))]
pub async fn unfollow(
    State(st): State<AppState>,
    a: Authed,
    PathParams(target): PathParams<i32>,
) -> Result<(), AppError> {
    sqlx::query!(
        r#"DELETE FROM user_follows WHERE "followerId" = $1 AND "followingId" = $2"#,
        a.user.id,
        target
    )
    .execute(&st.db)
    .await?;
    Ok(())
}

#[utoipa::path(post, path = "/api/social/requests/{userId}/accept", responses((status = 201)))]
pub async fn accept(
    State(st): State<AppState>,
    a: Authed,
    PathParams(requester): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    let done = sqlx::query_scalar!(
        r#"UPDATE user_follows SET status = 'accepted', "updatedAt" = now()
           WHERE "followerId" = $1 AND "followingId" = $2 AND status = 'pending' RETURNING id"#,
        requester,
        a.user.id
    )
    .fetch_optional(&st.db)
    .await?;
    if done.is_none() {
        return Err(AppError::not_found("Follow request not found"));
    }
    st.hub.emit_to_user(
        requester,
        SseEvent::SocialFollowAccepted {
            user_id: a.user.id.into(),
            username: a.user.username.clone(),
            avatar: a.user.avatar.clone(),
        },
    );
    Ok(StatusCode::CREATED)
}

#[utoipa::path(post, path = "/api/social/requests/{userId}/reject", responses((status = 201)))]
pub async fn reject(
    State(st): State<AppState>,
    a: Authed,
    PathParams(requester): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    sqlx::query!(
        r#"DELETE FROM user_follows
           WHERE "followerId" = $1 AND "followingId" = $2 AND status = 'pending'"#,
        requester,
        a.user.id
    )
    .execute(&st.db)
    .await?;
    Ok(StatusCode::CREATED)
}

/// The profile gate, then whether the viewer may see the connections (rule 18).
async fn connections_visible(st: &AppState, a: &Authed, target: i32) -> Result<bool, AppError> {
    let t = require_user(&st.db, target).await?;
    let is_self = a.user.id == target;
    if !is_self && (t.share_disabled || a.user.share_disabled) {
        return Err(user_not_found(target));
    }
    Ok(is_self || t.public || follows(&st.db, a.user.id, target).await?)
}

#[utoipa::path(get, path = "/api/social/users/{userId}/followers", responses((status = 200)))]
pub async fn followers(
    State(st): State<AppState>,
    a: Authed,
    PathParams(target): PathParams<i32>,
) -> Result<Json<Vec<SocialUser>>, AppError> {
    if !connections_visible(&st, &a, target).await? {
        return Ok(Json(vec![]));
    }
    let users = sqlx::query_as!(
        Brief,
        r#"SELECT u.id, u.username, u.avatar, u.enabled, u."shareDisabled" AS share_disabled FROM user_follows uf
           JOIN users u ON u.id = uf."followerId"
           WHERE uf."followingId" = $1 AND uf.status = 'accepted'
           ORDER BY uf.id"#,
        target
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(decorate(&st.db, a.user.id, users).await?))
}

#[utoipa::path(get, path = "/api/social/users/{userId}/following", responses((status = 200)))]
pub async fn following(
    State(st): State<AppState>,
    a: Authed,
    PathParams(target): PathParams<i32>,
) -> Result<Json<Vec<SocialUser>>, AppError> {
    if !connections_visible(&st, &a, target).await? {
        return Ok(Json(vec![]));
    }
    let users = sqlx::query_as!(
        Brief,
        r#"SELECT u.id, u.username, u.avatar, u.enabled, u."shareDisabled" AS share_disabled FROM user_follows uf
           JOIN users u ON u.id = uf."followingId"
           WHERE uf."followerId" = $1 AND uf.status = 'accepted'
           ORDER BY uf.id"#,
        target
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(decorate(&st.db, a.user.id, users).await?))
}

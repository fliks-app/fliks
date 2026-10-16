//! `/api/likes/*` and `/api/social/*` (`docs/spec/social.md`): likes, follow graph, discovery, profiles,
//! stats, recommendations and the leave-social teardown.
mod graph;
mod likes;
mod profile;
mod recommend;
mod stats;

use crate::{http::AppError, state::AppState};
use axum::{
    Router,
    routing::{get, post},
};
use sqlx::{PgConnection, PgPool};

pub use graph::*;
pub use likes::*;
pub use profile::*;
pub use recommend::*;
pub use stats::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/likes",
            get(likes::likes_list)
                .post(likes::like_add)
                .delete(likes::like_remove),
        )
        .route("/api/likes/state/{mediaId}", get(likes::like_state))
        .route("/api/social/search", get(graph::search))
        .route("/api/social/connectable", get(graph::connectable))
        .route(
            "/api/social/recommendations",
            get(recommend::following_popular),
        )
        .route("/api/social/recommend", post(recommend::recommend))
        .route(
            "/api/social/recommendations/received",
            get(recommend::received),
        )
        .route("/api/social/recommendations/sent", get(recommend::sent))
        .route(
            "/api/social/recommendations/{id}/dismiss",
            post(recommend::dismiss),
        )
        .route("/api/social/requests", get(graph::requests))
        .route(
            "/api/social/follow/{userId}",
            post(graph::follow).delete(graph::unfollow),
        )
        .route("/api/social/requests/{userId}/accept", post(graph::accept))
        .route("/api/social/requests/{userId}/reject", post(graph::reject))
        .route(
            "/api/social/users/{userId}/followers",
            get(graph::followers),
        )
        .route(
            "/api/social/users/{userId}/following",
            get(graph::following),
        )
        .route("/api/social/users/{userId}/profile", get(profile::profile))
        .route("/api/social/users/{userId}/stats", get(stats::stats))
}

/// A member as the social rules read them: card fields plus the opt-in flags.
pub struct Person {
    pub id: i32,
    pub username: String,
    pub avatar: Option<String>,
    pub public: bool,
    pub share_disabled: bool,
    pub share_tastes: bool,
    pub share_recommendations: bool,
    pub share_watch_history: bool,
    pub share_likes: bool,
    pub share_stats: bool,
}

pub fn user_not_found(id: i32) -> AppError {
    AppError::not_found(format!("User #{id} not found"))
}

/// An enabled member, else the 404 a missing one gets (`requireUser`, rule 17).
pub async fn require_user(db: &PgPool, id: i32) -> Result<Person, AppError> {
    sqlx::query_as!(
        Person,
        r#"SELECT id, username, avatar, "profileVisibility" = 'public' AS "public!",
                  "shareDisabled" AS share_disabled, "shareTastes" AS share_tastes,
                  "shareRecommendations" AS share_recommendations,
                  "shareWatchHistory" AS share_watch_history, "shareLikes" AS share_likes,
                  "shareStats" AS share_stats
           FROM users WHERE id = $1 AND enabled = true"#,
        id
    )
    .fetch_optional(db)
    .await?
    .ok_or_else(|| user_not_found(id))
}

/// Edge `from -> to` is accepted.
pub async fn follows(db: &PgPool, from: i32, to: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar!(
        r#"SELECT EXISTS (SELECT 1 FROM user_follows
           WHERE "followerId" = $1 AND "followingId" = $2 AND status = 'accepted') AS "e!""#,
        from,
        to
    )
    .fetch_one(db)
    .await
}

/// The media title, or 404 `<what> #<id> not found` for the first of media, season, episode that does not exist (C1).
pub async fn assert_targets(
    db: &PgPool,
    media: i32,
    season: Option<i32>,
    episode: Option<i32>,
) -> Result<String, AppError> {
    let r = sqlx::query!(
        r#"SELECT (SELECT title FROM media WHERE id = $1) AS title,
                  ($2::int IS NULL OR EXISTS (SELECT 1 FROM seasons WHERE id = $2)) AS "season!",
                  ($3::int IS NULL OR EXISTS (SELECT 1 FROM episodes WHERE id = $3)) AS "episode!""#,
        media,
        season,
        episode
    )
    .fetch_one(db)
    .await?;
    let missing = [
        (r.title.is_some(), "Media", Some(media)),
        (r.season, "Season", season),
        (r.episode, "Episode", episode),
    ];
    match (missing.into_iter().find(|(ok, ..)| !ok), r.title) {
        (Some((_, what, Some(id))), _) => {
            Err(AppError::not_found(format!("{what} #{id} not found")))
        }
        (_, title) => Ok(title.unwrap_or_default()),
    }
}

/// A target deleted between the check and the write is the same 404 (C1).
pub fn fk_missing(e: sqlx::Error) -> AppError {
    match &e {
        sqlx::Error::Database(d) if d.code().as_deref() == Some("23503") => {
            AppError::not_found("Not Found")
        }
        _ => e.into(),
    }
}

/// Leaving social (rule 46): the six statements in order, run in the caller's transaction (C14).
pub async fn leave_social(c: &mut PgConnection, user: i32) -> Result<(), sqlx::Error> {
    sqlx::query!(
        r#"DELETE FROM user_follows WHERE "followerId" = $1 OR "followingId" = $1"#,
        user
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(r#"DELETE FROM playlist_saves WHERE "userId" = $1"#, user)
        .execute(&mut *c)
        .await?;
    sqlx::query!(r#"DELETE FROM playlist_shares WHERE "userId" = $1"#, user)
        .execute(&mut *c)
        .await?;
    sqlx::query!(
        r#"DELETE FROM playlist_shares WHERE "playlistId" IN (SELECT id FROM playlists WHERE "ownerId" = $1)"#,
        user
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"UPDATE playlists SET visibility = 'private' WHERE "ownerId" = $1 AND visibility <> 'private'"#,
        user
    )
    .execute(&mut *c)
    .await?;
    sqlx::query!(
        r#"DELETE FROM content_recommendations WHERE "senderId" = $1 OR "recipientId" = $1"#,
        user
    )
    .execute(&mut *c)
    .await
    .map(drop)
}

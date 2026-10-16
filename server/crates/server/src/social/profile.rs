//! `GET /api/social/users/:userId/profile` (`docs/spec/social.md` rules 23-33).
use super::{likes::list_likes, require_user, user_not_found};
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    libraries::accessible_library_ids,
    playback, playlists,
    state::AppState,
};
use axum::{Json, extract::State};
use serde_json::{Value, json};

const TOP_GENRES: usize = 8;
const RECOMMENDATIONS: usize = 15;
const RECENT: i64 = 12;
const LIKES: i64 = 24;

#[utoipa::path(get, path = "/api/social/users/{userId}/profile", responses((status = 200)))]
pub async fn profile(
    State(st): State<AppState>,
    a: Authed,
    PathParams(target): PathParams<i32>,
) -> Result<Json<Value>, AppError> {
    let (db, me) = (&st.db, &a.user);
    let t = require_user(db, target).await?;
    let is_self = me.id == target;
    if !is_self && (t.share_disabled || me.share_disabled) {
        return Err(user_not_found(target));
    }
    let edge = if is_self {
        None
    } else {
        sqlx::query_scalar!(
            r#"SELECT status::text AS "status!" FROM user_follows
               WHERE "followerId" = $1 AND "followingId" = $2"#,
            me.id,
            target
        )
        .fetch_optional(db)
        .await?
    };
    let is_following = edge.as_deref() == Some("accepted");
    let follows_you = !is_self && super::follows(db, target, me.id).await?;
    let can_see = is_self || t.public || is_following;
    let mut out = json!({
        "id": t.id, "username": t.username, "avatar": t.avatar,
        "isFollowing": is_following, "requested": edge.as_deref() == Some("pending"),
        "followsYou": follows_you, "isSelf": is_self,
        "visibility": if t.public { "public" } else { "private" },
        "followerCount": 0, "followingCount": 0,
        "shown": {"playlists": false, "tastes": false, "recommendations": false,
                  "recentlyWatched": false, "likes": false, "stats": false},
        "playlists": [], "topGenres": [], "recommendations": [], "recentlyWatched": [], "likes": [],
    });
    if !can_see {
        return Ok(Json(out));
    }
    let counts = sqlx::query!(
        r#"SELECT COUNT(*) FILTER (WHERE "followingId" = $1) AS "followers!",
                  COUNT(*) FILTER (WHERE "followerId" = $1) AS "following!"
           FROM user_follows WHERE status = 'accepted' AND ("followingId" = $1 OR "followerId" = $1)"#,
        target
    )
    .fetch_one(db)
    .await?;
    let viewer = accessible_library_ids(db, &a).await?;
    let shown = [
        ("tastes", t.share_tastes),
        ("recommendations", t.share_recommendations),
        ("recentlyWatched", t.share_watch_history),
        ("likes", t.share_likes),
        ("stats", t.share_stats),
    ]
    .map(|(k, flag)| (k, is_self || flag));
    let on = |k: &str| shown.iter().any(|(s, v)| *s == k && *v);
    let (playlists, top_genres, recommendations, recent, likes) = tokio::try_join!(
        async {
            Ok(playlists::visible_for_owner(db, target, &viewer, is_self || is_following).await?)
        },
        async {
            Ok::<_, AppError>(if on("tastes") {
                playback::top_genres(db, target, TOP_GENRES, &viewer).await?
            } else {
                vec![]
            })
        },
        async {
            Ok::<_, AppError>(if on("recommendations") {
                let mut items =
                    playback::user_recommendations(db, target, &viewer, Some(RECOMMENDATIONS))
                        .await?;
                items.iter_mut().for_each(|i| i.because_title.clear());
                items
            } else {
                vec![]
            })
        },
        async {
            Ok::<_, AppError>(if on("recentlyWatched") {
                playback::user_history(db, target, 1, RECENT, &viewer)
                    .await?
                    .data
            } else {
                vec![]
            })
        },
        async {
            Ok::<_, AppError>(if on("likes") {
                list_likes(db, target, &viewer, None, Some(LIKES)).await?
            } else {
                vec![]
            })
        },
    )?;
    out["followerCount"] = counts.followers.into();
    out["followingCount"] = counts.following.into();
    out["shown"] = json!({"playlists": true});
    for (k, v) in shown {
        out["shown"][k] = v.into();
    }
    out["playlists"] = json!(playlists);
    out["topGenres"] = json!(top_genres);
    out["recommendations"] = json!(recommendations);
    out["recentlyWatched"] = json!(recent);
    out["likes"] = json!(likes);
    Ok(Json(out))
}

//! `UserStats` (`docs/spec/social.md` rules 34-36), shared with the admin `GET /api/users/:id/stats`.
use super::{follows, require_user, user_not_found};
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    state::AppState,
};
use axum::{Json, extract::State};
use fliks_domain::{js::iso, media::kind::MediaKind};
use serde_json::{Map, Value, json};
use sqlx::PgPool;

/// `None` when the user does not exist.
pub async fn user_stats(db: &PgPool, id: i32) -> sqlx::Result<Option<Value>> {
    let Some(user) = sqlx::query!(
        r#"SELECT "lastLogin", "createdAt" FROM users WHERE id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    let p = sqlx::query!(
        r#"SELECT ROUND(COALESCE(SUM(CASE WHEN ps."playedAt" IS NOT NULL THEN ps."positionSeconds" ELSE 0 END), 0)::numeric)::bigint AS "total_watch_time_seconds!",
                  COUNT(DISTINCT CASE WHEN ps.completed AND it."groupId" IS NOT NULL THEN it.id END) AS "episodes_watched!",
                  MAX(ps."lastPlayedAt") AS last_played_at
           FROM playback_states ps JOIN items it ON it.id = ps."itemId"
           WHERE ps."userId" = $1"#,
        id
    )
    .fetch_one(db)
    .await?;
    let completed = sqlx::query!(
        r#"SELECT media.type AS "kind!", COUNT(DISTINCT it."mediaId") AS "count!"
           FROM playback_states ps JOIN items it ON it.id = ps."itemId"
                JOIN media ON media.id = it."mediaId"
           WHERE ps."userId" = $1 AND ps.completed GROUP BY media.type"#,
        id
    )
    .fetch_all(db)
    .await?;
    let mut playback = Map::new();
    playback.insert(
        "totalWatchTimeSeconds".into(),
        p.total_watch_time_seconds.into(),
    );
    for k in MediaKind::ALL {
        let n = completed
            .iter()
            .find(|r| r.kind == k.as_str())
            .map_or(0, |r| r.count);
        playback.insert(k.completed_stat_key().into(), n.into());
    }
    playback.insert("episodesWatched".into(), p.episodes_watched.into());
    playback.insert("lastPlayedAt".into(), json!(p.last_played_at.map(iso)));
    let counts = sqlx::query!(
        r#"SELECT r.status::text AS "status!", COUNT(*) AS "count!" FROM requests r WHERE r."userId" = $1 GROUP BY r.status"#,
        id
    )
    .fetch_all(db)
    .await?;
    let n = |s: &str| counts.iter().find(|c| c.status == s).map_or(0, |c| c.count);
    Ok(Some(json!({
        "playback": playback,
        "requests": {"pending": n("pending"), "approved": n("approved"), "declined": n("declined")},
        "activity": {"lastActiveAt": user.lastLogin.map(iso), "memberSince": iso(user.createdAt)},
    })))
}

#[utoipa::path(get, path = "/api/social/users/{userId}/stats", responses((status = 200)))]
pub async fn stats(
    State(st): State<AppState>,
    a: Authed,
    PathParams(target): PathParams<i32>,
) -> Result<Json<Value>, AppError> {
    let t = require_user(&st.db, target).await?;
    if a.user.id != target {
        let seen = !t.share_disabled
            && !a.user.share_disabled
            && t.share_stats
            && (t.public || follows(&st.db, a.user.id, target).await?);
        if !seen {
            return Err(user_not_found(target));
        }
    }
    let mut stats = user_stats(&st.db, target)
        .await?
        .ok_or_else(|| user_not_found(target))?;
    if a.user.id != target
        && let Some(m) = stats["activity"].as_object_mut()
    {
        m.remove("lastActiveAt");
    }
    Ok(Json(stats))
}

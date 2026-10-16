//! Recommendations: popular among followed members and member-to-member (`docs/spec/social.md` rules 37-45).
use super::{
    assert_targets,
    likes::{label, like_key, liked_keys},
    require_user, user_not_found,
};
use crate::{
    events::SseEvent,
    http::{
        AppError,
        auth::Authed,
        json::iso_ms,
        validate::{PathParams, ValidJson},
    },
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use fliks_domain::recommend::{RecommendationItem, RecommendedMedia};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, types::Json as Jsonb};
use std::collections::HashMap;

const FOLLOWING_DEFAULT: i64 = 20;
const FOLLOWING_MAX: f64 = 50.0;
const CARDS_LIMIT: i64 = 60;
const MESSAGE_MAX: usize = 500;

type Q = Query<Vec<(String, String)>>;

fn param<'a>(q: &'a [(String, String)], key: &str) -> Option<&'a str> {
    q.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// `limit ? Math.min(+limit, 50) : 20`; anything but a non-negative integer is a 400 (rule 38, C1).
fn limit(q: &[(String, String)]) -> Result<i64, AppError> {
    let Some(raw) = param(q, "limit").filter(|s| !s.is_empty()) else {
        return Ok(FOLLOWING_DEFAULT);
    };
    let n = match raw.trim() {
        "" => 0.0,
        s => s.parse::<f64>().unwrap_or(f64::NAN),
    };
    if n.is_nan() || n < 0.0 || n.min(FOLLOWING_MAX).fract() != 0.0 {
        return Err(AppError::bad_request(vec![
            "limit must be a non-negative integer number".to_string(),
        ]));
    }
    Ok(n.min(FOLLOWING_MAX) as i64)
}

#[utoipa::path(get, path = "/api/social/recommendations", responses((status = 200)))]
pub async fn following_popular(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Q,
) -> Result<Json<Vec<RecommendationItem>>, AppError> {
    let limit = limit(&q)?;
    let me = a.user.id;
    let followed = sqlx::query_scalar!(
        r#"SELECT uf."followingId" FROM user_follows uf JOIN users u ON u.id = uf."followingId"
           WHERE uf."followerId" = $1 AND uf.status = 'accepted' AND u."shareWatchHistory""#,
        me
    )
    .fetch_all(&st.db)
    .await?;
    let accessible = accessible_library_ids(&st.db, &a).await?;
    if followed.is_empty() || accessible.is_empty() {
        return Ok(Json(vec![]));
    }
    let wanted = super::likes::library_filter(param(&q, "libraryId"));
    let libs = match wanted.and_then(|n| accessible.iter().find(|l| f64::from(**l) == n)) {
        Some(l) => vec![*l],
        None => accessible,
    };
    let ids = sqlx::query_scalar!(
        r#"SELECT ps."mediaId" AS "id!"
           FROM playback_states ps
           JOIN media m ON m.id = ps."mediaId"
           WHERE ps."userId" = ANY($1)
             AND ps.completed = true
             AND m."libraryId" = ANY($2)
             AND NOT EXISTS (
               SELECT 1 FROM playback_states mine
               WHERE mine."userId" = $3 AND mine."mediaId" = ps."mediaId"
             )
           GROUP BY ps."mediaId"
           ORDER BY COUNT(DISTINCT ps."userId") DESC, ps."mediaId" DESC
           LIMIT $4"#,
        &followed,
        &libs,
        me,
        limit
    )
    .fetch_all(&st.db)
    .await?;
    let mut media: HashMap<i32, RecommendedMedia> = sqlx::query!(
        r#"SELECT m.id, m.title, m.type::text AS "kind!", m.year, m."posterUrl" AS poster_url,
                  m."fanartUrl" AS fanart_url, m."additionalFanartUrls" AS additional_fanart_urls,
                  m.genres AS "genres: Jsonb<Vec<String>>"
           FROM media m WHERE m.id = ANY($1)"#,
        &ids
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|r| {
        (
            r.id,
            RecommendedMedia {
                id: r.id.into(),
                title: r.title,
                kind: r.kind,
                year: r.year.map(Into::into),
                poster_url: r.poster_url,
                fanart_url: r.fanart_url,
                additional_fanart_urls: r.additional_fanart_urls,
                genres: r.genres.map(|g| g.0).unwrap_or_default(),
                available: true,
            },
        )
    })
    .collect();
    Ok(Json(
        ids.iter()
            .filter_map(|id| media.remove(id))
            .map(|media| RecommendationItem {
                media,
                because_title: String::new(),
                score: 0.0,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecommendDto {
    recipient_id: i32,
    media_id: i32,
    season_id: Option<i32>,
    episode_id: Option<i32>,
    message: Option<String>,
}

#[utoipa::path(post, path = "/api/social/recommend", responses((status = 201)))]
pub async fn recommend(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(dto): ValidJson<RecommendDto>,
) -> Result<StatusCode, AppError> {
    let me = &a.user;
    if dto
        .message
        .as_deref()
        .is_some_and(|m| m.chars().count() > MESSAGE_MAX)
    {
        return Err(AppError::bad_request(vec![format!(
            "message must be shorter than or equal to {MESSAGE_MAX} characters"
        )]));
    }
    if me.id == dto.recipient_id {
        return Err(AppError::bad_request("Cannot recommend to yourself"));
    }
    if me.share_disabled {
        return Err(AppError::bad_request("Sharing features are disabled"));
    }
    let to = require_user(&st.db, dto.recipient_id).await?;
    if to.share_disabled || !(to.public || super::follows(&st.db, me.id, to.id).await?) {
        return Err(user_not_found(to.id));
    }
    let (season, episode) = (
        dto.season_id.filter(|i| *i != 0),
        dto.episode_id.filter(|i| *i != 0),
    );
    let title = assert_targets(&st.db, dto.media_id, season, episode).await?;
    let message = dto
        .message
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty());
    let mut tx = st.db.begin().await?;
    sqlx::query!(
        r#"DELETE FROM content_recommendations
           WHERE "senderId" = $1 AND "recipientId" = $2 AND "mediaId" = $3
             AND "seasonId" IS NOT DISTINCT FROM $4 AND "episodeId" IS NOT DISTINCT FROM $5"#,
        me.id,
        to.id,
        dto.media_id,
        season,
        episode
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query!(
        r#"INSERT INTO content_recommendations
             ("senderId", "recipientId", "mediaId", "seasonId", "episodeId", message, "dismissedAt")
           VALUES ($1, $2, $3, $4, $5, $6, NULL)"#,
        me.id,
        to.id,
        dto.media_id,
        season,
        episode,
        message
    )
    .execute(&mut *tx)
    .await
    .map_err(super::fk_missing)?;
    tx.commit().await?;
    st.hub.emit_to_user(
        to.id,
        SseEvent::SocialContentRecommended {
            user_id: me.id.into(),
            username: me.username.clone(),
            avatar: me.avatar.clone(),
            media_title: title,
        },
    );
    Ok(StatusCode::CREATED)
}

#[derive(Serialize)]
pub struct Member {
    id: i32,
    username: String,
    avatar: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    id: i32,
    message: Option<String>,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
    media_id: i32,
    media_type: String,
    title: String,
    poster_url: Option<String>,
    fanart_url: Option<String>,
    season_id: Option<i32>,
    episode_id: Option<i32>,
    label: Option<String>,
    still_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender: Option<Member>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recipient: Option<Member>,
    #[serde(skip_serializing_if = "Option::is_none")]
    liked: Option<bool>,
}

/// The newest 60 recommendations to (`received`) or from the caller, then the caller's library ACL (rules 42-44).
async fn cards(
    db: &PgPool,
    a: &Authed,
    received: bool,
    include_dismissed: bool,
) -> Result<Vec<(Card, Member)>, AppError> {
    let accessible = accessible_library_ids(db, a).await?;
    if accessible.is_empty() {
        return Ok(vec![]);
    }
    let rows = sqlx::query!(
        r#"SELECT cr.id, cr.message, cr."createdAt" AS created_at, cr."seasonId" AS season_id,
                  cr."episodeId" AS episode_id,
                  m.id AS "media_id?", m.type::text AS media_type, m.title AS "title?",
                  m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url, m."libraryId" AS library_id,
                  s."seasonNumber" AS "season_number?", e."episodeNumber" AS "episode_number?",
                  e.title AS episode_title, e."stillUrl" AS still_url,
                  es."seasonNumber" AS "episode_season_number?",
                  u.id AS other_id, u.username AS other_username, u.avatar AS other_avatar
           FROM content_recommendations cr
           JOIN users u ON u.id = CASE WHEN $2 THEN cr."senderId" ELSE cr."recipientId" END
           LEFT JOIN media m ON m.id = cr."mediaId"
           LEFT JOIN seasons s ON s.id = cr."seasonId"
           LEFT JOIN episodes e ON e.id = cr."episodeId"
           LEFT JOIN seasons es ON es.id = e."seasonId"
           WHERE (CASE WHEN $2 THEN cr."recipientId" ELSE cr."senderId" END) = $1
             AND ($3 OR cr."dismissedAt" IS NULL)
           ORDER BY cr."createdAt" DESC, cr.id
           LIMIT $4"#,
        a.user.id,
        received,
        include_dismissed,
        CARDS_LIMIT
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let (media_id, library_id) = (r.media_id?, r.library_id?);
            if !accessible.contains(&library_id) {
                return None;
            }
            let title = r.title?;
            let label = label(
                &title,
                r.season_number,
                r.episode_number.map(|n| (n, r.episode_title.as_deref())),
                r.episode_season_number,
            );
            let card = Card {
                id: r.id,
                message: r.message,
                created_at: r.created_at,
                media_id,
                media_type: r.media_type?,
                title,
                poster_url: r.poster_url,
                fanart_url: r.fanart_url,
                season_id: r.season_id,
                episode_id: r.episode_id,
                label,
                still_url: r.still_url,
                sender: None,
                recipient: None,
                liked: None,
            };
            let member = Member {
                id: r.other_id,
                username: r.other_username,
                avatar: r.other_avatar,
            };
            Some((card, member))
        })
        .collect())
}

#[utoipa::path(get, path = "/api/social/recommendations/received", responses((status = 200)))]
pub async fn received(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Q,
) -> Result<Json<Vec<Card>>, AppError> {
    let all = param(&q, "includeDismissed") == Some("true");
    let rows = cards(&st.db, &a, true, all).await?;
    let media: Vec<i32> = rows.iter().map(|r| r.0.media_id).collect();
    let liked = liked_keys(&st.db, a.user.id, &media).await?;
    Ok(Json(
        rows.into_iter()
            .map(|(mut card, member)| {
                card.liked =
                    Some(liked.contains(&like_key(card.media_id, card.season_id, card.episode_id)));
                card.sender = Some(member);
                card
            })
            .collect(),
    ))
}

#[utoipa::path(get, path = "/api/social/recommendations/sent", responses((status = 200)))]
pub async fn sent(State(st): State<AppState>, a: Authed) -> Result<Json<Vec<Card>>, AppError> {
    Ok(Json(
        cards(&st.db, &a, false, true)
            .await?
            .into_iter()
            .map(|(mut card, member)| {
                card.recipient = Some(member);
                card
            })
            .collect(),
    ))
}

#[utoipa::path(post, path = "/api/social/recommendations/{id}/dismiss", responses((status = 201)))]
pub async fn dismiss(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
) -> Result<StatusCode, AppError> {
    sqlx::query!(
        r#"UPDATE content_recommendations SET "dismissedAt" = now()
           WHERE id = $1 AND "recipientId" = $2 AND "dismissedAt" IS NULL"#,
        id,
        a.user.id
    )
    .execute(&st.db)
    .await?;
    Ok(StatusCode::CREATED)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(v: &str) -> Vec<(String, String)> {
        vec![("limit".into(), v.into())]
    }

    #[test]
    fn limit_follows_rule_38() {
        let ok = |v: &str| limit(&q(v)).unwrap();
        assert_eq!(limit(&[]).unwrap(), 20);
        assert_eq!(
            (ok(""), ok("0"), ok("7"), ok("500"), ok(" 3 "), ok("1e1")),
            (20, 0, 7, 50, 3, 10)
        );
        for bad in ["2.5", "-5", "abc", "NaN"] {
            assert!(limit(&q(bad)).is_err(), "{bad}");
        }
    }
}

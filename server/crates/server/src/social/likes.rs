//! `/api/likes/*` (`docs/spec/social.md` rules 1-7).
use super::{assert_targets, fk_missing};
use crate::{
    http::{
        AppError,
        auth::Authed,
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
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::HashSet;

const LIKES_LIMIT: i64 = 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetDto {
    media_id: i32,
    season_id: Option<i32>,
    episode_id: Option<i32>,
}

impl TargetDto {
    /// A falsy id (absent, `null`, `0`) is stored as NULL (rule 2).
    fn ids(&self) -> (Option<i32>, Option<i32>) {
        (
            self.season_id.filter(|i| *i != 0),
            self.episode_id.filter(|i| *i != 0),
        )
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LikedItem {
    media_id: i32,
    media_type: String,
    title: String,
    poster_url: Option<String>,
    fanart_url: Option<String>,
    season_id: Option<i32>,
    episode_id: Option<i32>,
    label: Option<String>,
    still_url: Option<String>,
}

/// Card label (rules 5, 42): `S<season>E<episode>[ · <title>]` for an episode, `<media> · S<season>` for a season.
pub fn label(
    media_title: &str,
    season: Option<i32>,
    episode: Option<(i32, Option<&str>)>,
    episode_season: Option<i32>,
) -> Option<String> {
    match (episode, season) {
        (Some((n, title)), _) => {
            let s = season
                .or(episode_season)
                .map_or("?".into(), |s| s.to_string());
            Some(match title.filter(|t| !t.is_empty()) {
                Some(t) => format!("S{s}E{n} · {t}"),
                None => format!("S{s}E{n}"),
            })
        }
        (None, Some(s)) => Some(format!("{media_title} · S{s}")),
        _ => None,
    }
}

/// JS `libraryId ? +libraryId : undefined`: NaN and 0 mean no filter.
pub fn library_filter(raw: Option<&str>) -> Option<f64> {
    raw.and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0)
}

/// The user's likes as cards, newest first; the limit applies before the ACL and library filters (rule 5).
pub async fn list_likes(
    db: &PgPool,
    user: i32,
    accessible: &[i32],
    library: Option<f64>,
    limit: Option<i64>,
) -> sqlx::Result<Vec<LikedItem>> {
    if accessible.is_empty() {
        return Ok(vec![]);
    }
    let rows = sqlx::query!(
        r#"SELECT l."seasonId" AS season_id, l."episodeId" AS episode_id,
                  m.id AS "media_id?", m.type::text AS media_type, m.title AS "title?",
                  m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url, m."libraryId" AS library_id,
                  s."seasonNumber" AS "season_number?", e."episodeNumber" AS "episode_number?",
                  e.title AS episode_title, e."stillUrl" AS still_url,
                  es."seasonNumber" AS "episode_season_number?"
           FROM likes l
           LEFT JOIN media m ON m.id = l."mediaId"
           LEFT JOIN seasons s ON s.id = l."seasonId"
           LEFT JOIN episodes e ON e.id = l."episodeId"
           LEFT JOIN seasons es ON es.id = e."seasonId"
           WHERE l."userId" = $1
           ORDER BY l."createdAt" DESC, l.id
           LIMIT $2"#,
        user,
        limit.unwrap_or(LIKES_LIMIT)
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let (media_id, library_id) = (r.media_id?, r.library_id?);
            let in_library = library.is_none_or(|n| f64::from(library_id) == n);
            if !accessible.contains(&library_id) || !in_library {
                return None;
            }
            let title = r.title?;
            let label = label(
                &title,
                r.season_number,
                r.episode_number.map(|n| (n, r.episode_title.as_deref())),
                r.episode_season_number,
            );
            Some(LikedItem {
                media_id,
                media_type: r.media_type?,
                title,
                poster_url: r.poster_url,
                fanart_url: r.fanart_url,
                season_id: r.season_id,
                episode_id: r.episode_id,
                label,
                still_url: r.still_url,
            })
        })
        .collect())
}

/// `mediaId:seasonId|'':episodeId|''` keys of the user's likes among `media` (rule 7).
pub async fn liked_keys(db: &PgPool, user: i32, media: &[i32]) -> sqlx::Result<HashSet<String>> {
    let rows = sqlx::query!(
        r#"SELECT l."mediaId" AS media_id, l."seasonId" AS season_id, l."episodeId" AS episode_id
           FROM likes l WHERE l."userId" = $1 AND l."mediaId" = ANY($2)"#,
        user,
        media
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| like_key(r.media_id, r.season_id, r.episode_id))
        .collect())
}

pub fn like_key(media: i32, season: Option<i32>, episode: Option<i32>) -> String {
    let id = |i: Option<i32>| i.map_or(String::new(), |i| i.to_string());
    format!("{media}:{}:{}", id(season), id(episode))
}

#[utoipa::path(get, path = "/api/likes", responses((status = 200)))]
pub async fn likes_list(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<Vec<(String, String)>>,
) -> Result<Json<Vec<LikedItem>>, AppError> {
    let raw = q
        .iter()
        .find(|(k, _)| k == "libraryId")
        .map(|(_, v)| v.as_str());
    let ids = accessible_library_ids(&st.db, &a).await?;
    Ok(Json(
        list_likes(&st.db, a.user.id, &ids, library_filter(raw), None).await?,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LikeState {
    media: bool,
    season_ids: Vec<i32>,
    episode_ids: Vec<i32>,
}

#[utoipa::path(get, path = "/api/likes/state/{mediaId}", responses((status = 200)))]
pub async fn like_state(
    State(st): State<AppState>,
    a: Authed,
    PathParams(media): PathParams<i32>,
) -> Result<Json<LikeState>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT l."seasonId" AS season_id, l."episodeId" AS episode_id
           FROM likes l WHERE l."userId" = $1 AND l."mediaId" = $2 ORDER BY l.id"#,
        a.user.id,
        media
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(LikeState {
        media: rows
            .iter()
            .any(|r| r.season_id.is_none() && r.episode_id.is_none()),
        season_ids: rows.iter().filter_map(|r| r.season_id).collect(),
        episode_ids: rows.iter().filter_map(|r| r.episode_id).collect(),
    }))
}

#[utoipa::path(post, path = "/api/likes", responses((status = 201)))]
pub async fn like_add(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(dto): ValidJson<TargetDto>,
) -> Result<StatusCode, AppError> {
    let (season, episode) = dto.ids();
    let accessible = accessible_library_ids(&st.db, &a).await?;
    assert_targets(&st.db, &accessible, dto.media_id, season, episode).await?;
    sqlx::query!(
        r#"INSERT INTO likes ("userId", "mediaId", "seasonId", "episodeId")
           VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING"#,
        a.user.id,
        dto.media_id,
        season,
        episode
    )
    .execute(&st.db)
    .await
    .map_err(fk_missing)?;
    Ok(StatusCode::CREATED)
}

/// The body must repeat the granularity used to like (rule 3).
#[utoipa::path(delete, path = "/api/likes", responses((status = 200)))]
pub async fn like_remove(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(dto): ValidJson<TargetDto>,
) -> Result<(), AppError> {
    let (season, episode) = dto.ids();
    sqlx::query!(
        r#"DELETE FROM likes WHERE "userId" = $1 AND "mediaId" = $2
           AND "seasonId" IS NOT DISTINCT FROM $3 AND "episodeId" IS NOT DISTINCT FROM $4"#,
        a.user.id,
        dto.media_id,
        season,
        episode
    )
    .execute(&st.db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_and_keys() {
        assert_eq!(label("T", None, None, None), None);
        assert_eq!(label("T", Some(2), None, None).as_deref(), Some("T · S2"));
        assert_eq!(
            label("T", None, Some((3, Some("Pilot"))), Some(1)).as_deref(),
            Some("S1E3 · Pilot")
        );
        assert_eq!(
            label("T", None, Some((3, Some(""))), None).as_deref(),
            Some("S?E3")
        );
        assert_eq!(
            label("T", Some(4), Some((1, None)), Some(1)).as_deref(),
            Some("S4E1")
        );
        assert_eq!(like_key(1, None, None), "1::");
        assert_eq!(like_key(1, Some(2), Some(3)), "1:2:3");
    }

    #[test]
    fn library_filter_follows_js_truthiness() {
        let f = |s| library_filter(Some(s));
        assert_eq!(
            (f("1"), f("abc"), f("0"), f(""), f(" 2 ")),
            (Some(1.0), None, None, None, Some(2.0))
        );
        assert_eq!(library_filter(None), None);
    }
}

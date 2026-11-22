//! Recommendation queries around `fliks_domain::recommend` (rules 19-29).
use crate::http::kinds::Kinds;
use fliks_domain::recommend::{
    Candidate, GenreWeight, HistoryMedia, RecommendationItem, Taste, rank_by_score, stratify,
};
use sqlx::{PgPool, types::Json};

/// The user's 15 most recent completed states, only those in `libs` when given; a state without
/// media still uses a slot unless scoped.
async fn window(
    db: &PgPool,
    user: i32,
    libs: Option<&[i32]>,
) -> sqlx::Result<Vec<Option<HistoryMedia>>> {
    let rows = sqlx::query!(
        r#"SELECT m.id AS "id?", m.title AS "title?", m.genres AS "genres?: Json<Vec<String>>"
           FROM playback_states ps
           JOIN items i ON i.id = ps."itemId"
           JOIN media m ON m.id = i."mediaId"
           WHERE ps."userId" = $1 AND ps.completed = true AND m.type <> 'album'
             AND ($2::int[] IS NULL OR m."libraryId" = ANY($2))
           ORDER BY ps."lastPlayedAt" DESC
           LIMIT 15"#,
        user,
        libs
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            Some(HistoryMedia {
                id: r.id?.into(),
                title: r.title?,
                genres: r.genres.map(|g| g.0),
            })
        })
        .collect())
}

/// Top genres of the user's history inside `libs` (the viewer's libraries).
pub async fn top_genres(
    db: &PgPool,
    user: i32,
    limit: usize,
    libs: &[i32],
) -> sqlx::Result<Vec<GenreWeight>> {
    let taste = Taste::from_history(&window(db, user, Some(libs)).await?);
    Ok(taste.map(|t| t.top_genres(limit)).unwrap_or_default())
}

pub async fn recommendations(
    db: &PgPool,
    user: i32,
    libs: &[i32],
    kinds: &Kinds,
    limit: Option<usize>,
) -> sqlx::Result<Vec<RecommendationItem>> {
    if libs.is_empty() {
        return Ok(vec![]);
    }
    let Some(taste) = Taste::from_history(&window(db, user, None).await?) else {
        return Ok(vec![]);
    };
    let kept: Vec<i32> = taste.kept_ids().map(|id| id as i32).collect();
    let candidates = sqlx::query!(
        r#"SELECT m.id, m.type AS "kind!", m.genres AS "genres: Json<Vec<String>>"
           FROM media m
           WHERE m.genres IS NOT NULL AND m.genres != '[]'::jsonb AND m.type <> 'album'
             AND m.id != ALL($1) AND m."libraryId" = ANY($2) AND m.type = ANY($3)
             AND NOT EXISTS (SELECT 1 FROM playback_states ps JOIN items i ON i.id = ps."itemId"
                             WHERE ps."userId" = $4 AND i."mediaId" = m.id)
             AND NOT EXISTS (SELECT 1 FROM recommendation_dismissals d
                             WHERE d."userId" = $4 AND d."mediaId" = m.id)"#,
        &kept,
        libs,
        &kinds.names(),
        user
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|r| Candidate {
        id: r.id.into(),
        title: String::new(),
        kind: r.kind,
        year: None,
        poster_url: None,
        fanart_url: None,
        additional_fanart_urls: None,
        genres: r.genres.map(|g| g.0),
    })
    .collect();
    let mut scored = taste.score(candidates);
    rank_by_score(&mut scored);
    let mut top = stratify(scored, limit);
    let ids: Vec<i32> = top.iter().map(|s| s.media.id as i32).collect();
    let cards = sqlx::query!(
        r#"SELECT m.id, m.title, m.year, m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url,
                  m."additionalFanartUrls" AS additional_fanart_urls
           FROM media m WHERE m.id = ANY($1)"#,
        &ids
    )
    .fetch_all(db)
    .await?;
    for s in &mut top {
        if let Some(r) = cards.iter().find(|r| i64::from(r.id) == s.media.id) {
            s.media.title.clone_from(&r.title);
            s.media.year = r.year.map(Into::into);
            s.media.poster_url.clone_from(&r.poster_url);
            s.media.fanart_url.clone_from(&r.fanart_url);
            s.media.additional_fanart_urls = Some(r.additional_fanart_urls.clone());
        }
    }
    let available = sqlx::query_scalar!(
        r#"SELECT mf."mediaId"
           FROM media_files mf
           WHERE mf."mediaId" = ANY($1)
           GROUP BY mf."mediaId""#,
        &ids
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .flatten()
    .map(i64::from)
    .collect();
    Ok(taste.items(top, &available))
}

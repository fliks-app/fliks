//! Recommendation queries around `fliks_domain::recommend` (rules 19-29).
use fliks_domain::recommend::{
    Candidate, GenreWeight, HistoryMedia, RecommendationItem, Taste, rank_by_score, stratify,
};
use sqlx::{PgPool, types::Json};
use std::collections::HashSet;

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
           LEFT JOIN media m ON m.id = ps."mediaId"
           WHERE ps."userId" = $1 AND ps.completed = true
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
    limit: Option<usize>,
) -> sqlx::Result<Vec<RecommendationItem>> {
    if libs.is_empty() {
        return Ok(vec![]);
    }
    let Some(taste) = Taste::from_history(&window(db, user, None).await?) else {
        return Ok(vec![]);
    };
    let mut excluded: HashSet<i32> = taste.kept_ids().map(|id| id as i32).collect();
    excluded.extend(
        sqlx::query_scalar!(
            r#"SELECT DISTINCT ps."mediaId" FROM playback_states ps WHERE ps."userId" = $1"#,
            user
        )
        .fetch_all(db)
        .await?
        .into_iter()
        .flatten(),
    );
    excluded.extend(
        sqlx::query_scalar!(
            r#"SELECT d."mediaId" FROM recommendation_dismissals d WHERE d."userId" = $1"#,
            user
        )
        .fetch_all(db)
        .await?,
    );
    let excluded: Vec<i32> = excluded.into_iter().collect();
    let candidates = sqlx::query!(
        r#"SELECT m.id, m.title, m.type::text AS "kind!", m.year, m."posterUrl" AS poster_url,
                  m."fanartUrl" AS fanart_url, m."additionalFanartUrls" AS additional_fanart_urls,
                  m.genres AS "genres: Json<Vec<String>>"
           FROM media m
           WHERE m.genres IS NOT NULL AND m.genres != '[]'::jsonb
             AND m.id != ALL($1) AND m."libraryId" = ANY($2)"#,
        &excluded,
        libs
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|r| Candidate {
        id: r.id.into(),
        title: r.title,
        kind: r.kind,
        year: r.year.map(Into::into),
        poster_url: r.poster_url,
        fanart_url: r.fanart_url,
        additional_fanart_urls: Some(r.additional_fanart_urls),
        genres: r.genres.map(|g| g.0),
    })
    .collect();
    let mut scored = taste.score(candidates);
    rank_by_score(&mut scored);
    let top = stratify(scored, limit);
    let ids: Vec<i32> = top.iter().map(|s| s.media.id as i32).collect();
    let available = sqlx::query_scalar!(
        r#"SELECT mf."mediaId"
           FROM media_files mf
           WHERE mf."mediaId" = ANY($1)
           GROUP BY mf."mediaId"
           UNION
           SELECT s."mediaId"
           FROM media_files mf
           JOIN episodes e ON e.id = mf."episodeId"
           JOIN seasons s ON s.id = e."seasonId"
           WHERE s."mediaId" = ANY($1)
           GROUP BY s."mediaId""#,
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

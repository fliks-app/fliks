//! Similar titles, collection, cast and crew (`media-query.md` rules 52-58).
use crate::http::AppError;
use crate::libraries::media_not_found;
use fliks_domain::media::kind::MediaKind;
use fliks_domain::media::similarity::{MIN_SCORE, Signals, score_similarity};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashSet;

fn strings(v: Option<Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a
            .into_iter()
            .filter_map(|x| x.as_str().map(str::to_owned))
            .collect(),
        _ => vec![],
    }
}

#[allow(clippy::too_many_arguments)]
fn item(
    id: i32,
    title: &str,
    year: Option<i32>,
    poster: Option<String>,
    fanart: Option<String>,
    rating: Option<f64>,
    genres: Vec<String>,
    has_file: bool,
) -> Value {
    json!({"id": id, "title": title, "year": year, "posterUrl": poster, "fanartUrl": fanart, "rating": rating,
        "genres": genres, "hasFile": has_file})
}

pub async fn similar(db: &PgPool, id: i32, limit: usize) -> Result<Vec<Value>, AppError> {
    let Some(src) = sqlx::query!(
        r#"SELECT m.type AS "kind!", m."libraryId" AS library_id, m.genres, m.year, coll.tmdb_id AS "collection_id?",
                  mm.keywords AS "keywords?"
           FROM media m LEFT JOIN movie_details mm ON mm."mediaId" = m.id
           LEFT JOIN LATERAL (SELECT c.id AS cid, x.value::int AS tmdb_id, NULLIF(c.name, '') AS name
             FROM collection_entries e JOIN collections c ON c.id = e."collectionId"
             JOIN collection_external_ids x ON x."collectionId" = c.id AND x.provider = 'tmdb'
             WHERE e."mediaId" = m.id AND e."itemId" IS NULL ORDER BY c.id LIMIT 1) coll ON true WHERE m.id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    else {
        return Err(media_not_found(id));
    };
    let library = match crate::db::kind(&src.kind)? {
        MediaKind::Movie => src.library_id,
        MediaKind::Series | MediaKind::Book => None,
    };
    let Some(library) = library else {
        return Ok(vec![]);
    };
    let genres = strings(src.genres.clone());
    let keywords = strings(src.keywords.clone());
    let directors = sqlx::query_scalar!(
        r#"SELECT "personId" AS "person_id!" FROM media_credits WHERE "mediaId" = $1 AND role = 'crew' AND job = 'Director'"#,
        id
    )
    .fetch_all(db)
    .await?;
    let same_director: Vec<i32> = if directors.is_empty() {
        vec![]
    } else {
        sqlx::query_scalar!(
            r#"SELECT DISTINCT "mediaId" AS "media_id!" FROM media_credits
               WHERE "personId" = ANY($1) AND role = 'crew' AND job = 'Director' AND "mediaId" != $2"#,
            &directors,
            id
        )
        .fetch_all(db)
        .await?
    };
    if genres.is_empty() && keywords.is_empty() && same_director.is_empty() {
        return Ok(vec![]);
    }
    let rows = sqlx::query!(
        r#"SELECT m.id AS "id!", m.title AS "title!", m.year, m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url,
       m.rating, m.genres, meta.keywords AS "keywords?",
       EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id) AS "has_file!"
FROM media m LEFT JOIN movie_details meta ON meta."mediaId" = m.id
WHERE m."libraryId" = $1 AND m.type = $7 AND m.id != $2
  AND ((cardinality($3::text[]) > 0 AND jsonb_exists_any(m.genres, $3))
       OR (cardinality($4::text[]) > 0 AND jsonb_exists_any(meta.keywords, $4))
       OR m.id = ANY($5))
  AND ($6::int IS NULL OR NOT EXISTS (
        SELECT 1 FROM collection_entries e JOIN collection_external_ids x
          ON x."collectionId" = e."collectionId" AND x.provider = 'tmdb'
        WHERE e."mediaId" = m.id AND e."itemId" IS NULL AND x.value = $6::int::text))
ORDER BY m.id"#,
        library,
        id,
        &genres,
        &keywords,
        &same_director,
        src.collection_id,
        src.kind
    )
    .fetch_all(db)
    .await?;
    let directors: HashSet<i32> = same_director.into_iter().collect();
    let src_year = src.year.map(i64::from);
    let mut scored: Vec<_> = rows
        .into_iter()
        .map(|r| {
            let (g, k) = (strings(r.genres.clone()), strings(r.keywords.clone()));
            let score = score_similarity(
                Signals {
                    genres: &genres,
                    year: src_year,
                    keywords: &keywords,
                },
                Signals {
                    genres: &g,
                    year: r.year.map(i64::from),
                    keywords: &k,
                },
                directors.contains(&r.id),
            );
            (score, r, g)
        })
        .filter(|(s, _, _)| *s >= MIN_SCORE)
        .collect();
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                b.1.rating
                    .unwrap_or(0.0)
                    .partial_cmp(&a.1.rating.unwrap_or(0.0))
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    Ok(scored
        .into_iter()
        .take(limit)
        .map(|(_, r, g)| {
            item(
                r.id,
                &r.title,
                r.year,
                r.poster_url,
                r.fanart_url,
                r.rating,
                g,
                r.has_file,
            )
        })
        .collect())
}

/// `None` is the 200-with-empty-body answer: no collection, or the movie is alone in it.
pub async fn collection(db: &PgPool, id: i32) -> Result<Option<Value>, AppError> {
    let Some(src) = sqlx::query!(
        r#"SELECT coll.cid AS "cid?", coll.tmdb_id AS "collection_id?", coll.name AS "collection_name?",
                  m."libraryId" AS library_id
           FROM media m LEFT JOIN LATERAL (SELECT c.id AS cid, x.value::int AS tmdb_id, NULLIF(c.name, '') AS name
             FROM collection_entries e JOIN collections c ON c.id = e."collectionId"
             JOIN collection_external_ids x ON x."collectionId" = c.id AND x.provider = 'tmdb'
             WHERE e."mediaId" = m.id AND e."itemId" IS NULL ORDER BY c.id LIMIT 1) coll ON true WHERE m.id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    else {
        return Err(media_not_found(id));
    };
    let (Some(tmdb_id), Some(cid), Some(library)) = (src.collection_id, src.cid, src.library_id)
    else {
        return Ok(None);
    };
    let rows = sqlx::query!(
        r#"SELECT m.id AS "id!", m.title AS "title!", m.year, m."posterUrl" AS poster_url, m."fanartUrl" AS fanart_url,
       m.rating, m.genres, EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id) AS "has_file!"
FROM media m
JOIN collection_entries ce ON ce."mediaId" = m.id AND ce."itemId" IS NULL
LEFT JOIN LATERAL (SELECT d.date FROM media_release_dates d WHERE d."mediaId" = m.id AND d."editionId" IS NULL AND d.kind = 'release') dates ON true
WHERE m."libraryId" = $1 AND ce."collectionId" = $2
ORDER BY ce.position ASC NULLS LAST, dates.date ASC NULLS LAST, m.year ASC NULLS LAST, m.id ASC"#,
        library,
        cid
    )
    .fetch_all(db)
    .await?;
    if rows.len() < 2 {
        return Ok(None);
    }
    let items: Vec<Value> = rows
        .into_iter()
        .map(|r| {
            item(
                r.id,
                &r.title,
                r.year,
                r.poster_url,
                r.fanart_url,
                r.rating,
                strings(r.genres),
                r.has_file,
            )
        })
        .collect();
    Ok(Some(
        json!({"id": tmdb_id, "name": src.collection_name.unwrap_or_default(), "items": items}),
    ))
}

pub async fn cast(db: &PgPool, id: i32) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', mc.id, 'createdAt', iso_ms(mc."createdAt"), 'updatedAt', iso_ms(mc."updatedAt"),
  'character', mc.character, 'order', mc.position,
  'person', jsonb_build_object('id', p.id, 'createdAt', iso_ms(p."createdAt"), 'updatedAt', iso_ms(p."updatedAt"),
    'provider', x.provider, 'tmdbId', x.value::int, 'name', p.name, 'avatarUrl', p."avatarUrl", 'biography', p.biography,
    'birthday', p.birthday, 'deathday', p.deathday, 'placeOfBirth', p."placeOfBirth",
    'knownForDepartment', p."knownForDepartment", 'departments', p.departments,
    'metadataRefreshedAt', iso_ms(p."metadataRefreshedAt"))) AS "json!: Value"
FROM media_credits mc JOIN persons p ON p.id = mc."personId" LEFT JOIN person_ids x ON x."personId" = p.id
WHERE mc."mediaId" = $1 AND mc.role = 'cast' ORDER BY mc.position ASC, mc.id ASC"#,
        id
    )
    .fetch_all(db)
    .await
}

pub async fn crew(db: &PgPool, id: i32) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', mc.id, 'createdAt', iso_ms(mc."createdAt"), 'updatedAt', iso_ms(mc."updatedAt"),
  'job', mc.job, 'department', mc.department,
  'person', jsonb_build_object('id', p.id, 'createdAt', iso_ms(p."createdAt"), 'updatedAt', iso_ms(p."updatedAt"),
    'provider', x.provider, 'tmdbId', x.value::int, 'name', p.name, 'avatarUrl', p."avatarUrl", 'biography', p.biography,
    'birthday', p.birthday, 'deathday', p.deathday, 'placeOfBirth', p."placeOfBirth",
    'knownForDepartment', p."knownForDepartment", 'departments', p.departments,
    'metadataRefreshedAt', iso_ms(p."metadataRefreshedAt"))) AS "json!: Value"
FROM media_credits mc JOIN persons p ON p.id = mc."personId" LEFT JOIN person_ids x ON x."personId" = p.id
WHERE mc."mediaId" = $1 AND mc.role = 'crew' ORDER BY mc.position ASC, mc.id ASC"#,
        id
    )
    .fetch_all(db)
    .await
}

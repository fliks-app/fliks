//! Counts, genres, collections and the quality table (`media-query.md` rules 35-38).
use fliks_domain::{
    media::{kind::MediaKind, query::js_parse_int},
    release::parsing::quality::APP_QUALITIES,
};
use serde::{Serialize, ser::SerializeMap};
use serde_json::{Value, json};
use sqlx::PgPool;

/// The media of `libraries` (all when `None`) counted per kind under each kind's count key, zero when absent.
pub async fn kind_counts(
    db: &PgPool,
    libraries: Option<&[i32]>,
) -> Result<serde_json::Map<String, Value>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT type AS "kind!", COUNT(*) AS "n!" FROM media
           WHERE $1::int[] IS NULL OR "libraryId" = ANY($1) GROUP BY type"#,
        libraries
    )
    .fetch_all(db)
    .await?;
    Ok(MediaKind::ALL
        .into_iter()
        .map(|k| {
            let n = rows
                .iter()
                .find(|r| r.kind == k.as_str())
                .map_or(0, |r| r.n);
            (k.count_key().to_owned(), n.into())
        })
        .collect())
}

pub async fn counts(db: &PgPool, ids: &[i32]) -> Result<Value, sqlx::Error> {
    Ok(Value::Object(kind_counts(db, Some(ids)).await?))
}

/// A JSON object whose keys keep the numeric order of the library ids (JS integer-key order).
pub struct ByLibrary(pub Vec<(i32, i32)>);

impl Serialize for ByLibrary {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut m = s.serialize_map(Some(self.0.len()))?;
        for (id, n) in &self.0 {
            m.serialize_entry(&id.to_string(), n)?;
        }
        m.end()
    }
}

pub async fn counts_by_library(db: &PgPool, ids: &[i32]) -> Result<ByLibrary, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT m."libraryId" AS "library_id!", COUNT(*)::int AS "count!" FROM media m
           WHERE m."libraryId" IS NOT NULL AND m."libraryId" = ANY($1) GROUP BY m."libraryId" ORDER BY m."libraryId""#,
        ids
    )
    .fetch_all(db)
    .await?;
    Ok(ByLibrary(
        rows.into_iter().map(|r| (r.library_id, r.count)).collect(),
    ))
}

pub fn qualities() -> Value {
    json!(APP_QUALITIES)
}

/// Rule 38: `libraryId` narrows to itself when accessible; unparsable or `0` keeps the whole scope.
pub fn scope(ids: &[i32], raw: Option<&str>) -> Vec<i32> {
    match raw
        .filter(|r| !r.is_empty())
        .and_then(js_parse_int)
        .filter(|n| *n != 0)
    {
        Some(n) if ids.iter().any(|i| i64::from(*i) == n) => vec![n as i32],
        Some(_) => vec![],
        None => ids.to_vec(),
    }
}

pub async fn genres(db: &PgPool, ids: &[i32]) -> Result<Value, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT g.genre AS "genre!",
       COUNT(*)::int AS "count!",
       COALESCE(
         (ARRAY_AGG(m."posterUrl" ORDER BY m.id)
          FILTER (WHERE m."posterUrl" IS NOT NULL))[1:4],
         ARRAY[]::text[]
       ) AS "posters!"
FROM media m
CROSS JOIN LATERAL jsonb_array_elements_text(m.genres) AS g(genre)
WHERE m."libraryId" = ANY($1)
  AND m.genres IS NOT NULL
  AND m.genres::text != '[]'
GROUP BY g.genre
ORDER BY g.genre ASC"#,
        ids
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| json!({"genre": r.genre, "count": r.count, "posters": r.posters}))
        .collect())
}

pub async fn collections(db: &PgPool, ids: &[i32]) -> Result<Value, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT x.value::int AS "id!",
       c.name AS "name!",
       COUNT(*)::int          AS "count!",
       COALESCE(
         (ARRAY_AGG(m."posterUrl" ORDER BY m.id)
          FILTER (WHERE m."posterUrl" IS NOT NULL))[1:4],
         ARRAY[]::text[]
       ) AS "posters!"
FROM media m
JOIN collection_entries e ON e."mediaId" = m.id
JOIN collections c ON c.id = e."collectionId"
JOIN collection_external_ids x ON x."collectionId" = c.id AND x.provider = 'tmdb'
WHERE m."libraryId" = ANY($1)
  AND c.name <> ''
GROUP BY c.id, x.value, c.name
HAVING COUNT(*) >= 2
ORDER BY c.name ASC, x.value::int ASC"#,
        ids
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| json!({"id": r.id, "name": r.name, "count": r.count, "posters": r.posters}))
        .collect())
}

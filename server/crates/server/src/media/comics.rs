//! The `comic` objects of media payloads (`comics.md` rules 9-11).
use fliks_domain::media::kind::MediaKind;
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;

fn comic_ids(data: &[Value]) -> Vec<i32> {
    data.iter()
        .filter(|v| v["type"] == MediaKind::Comic.as_str())
        .filter_map(|v| v["id"].as_i64().and_then(|n| i32::try_from(n).ok()))
        .collect()
}

/// Adds `comic: ComicListInfo` to the comic items of `data`.
pub(crate) async fn attach_list_info(
    db: &PgPool,
    data: &mut [Value],
    uid: i32,
    acl: &[i32],
) -> Result<(), sqlx::Error> {
    let ids = comic_ids(data);
    if ids.is_empty() {
        return Ok(());
    }
    let rows = sqlx::query!(
        r#"SELECT m.id AS "id!", jsonb_build_object('publisher', cd.publisher, 'startYear', cd."startYear",
  'issueCount', (SELECT count(*) FROM items i JOIN comic_issues ci ON ci."itemId" = i.id
      JOIN editions e ON e.id = i."editionId"
      WHERE i."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($3)),
  'readCount', (SELECT count(*) FROM items i JOIN comic_issues ci ON ci."itemId" = i.id
      JOIN editions e ON e.id = i."editionId"
      JOIN playback_states ps ON ps."itemId" = i.id AND ps."userId" = $2 AND ps.completed
      WHERE i."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($3))) AS "json!: Value"
FROM media m LEFT JOIN comic_details cd ON cd."mediaId" = m.id WHERE m.id = ANY($1)"#,
        &ids,
        uid,
        acl
    )
    .fetch_all(db)
    .await?;
    let mut info: HashMap<i32, Value> = rows.into_iter().map(|r| (r.id, r.json)).collect();
    for item in data.iter_mut() {
        let id = item["id"].as_i64().and_then(|n| i32::try_from(n).ok());
        if let (Some(o), Some(comic)) = (item.as_object_mut(), id.and_then(|i| info.remove(&i))) {
            o.insert("comic".into(), comic);
        }
    }
    Ok(())
}

/// `ComicDetail` of a comic; `acl` is the caller's readable libraries, which decide the issues listed.
pub(crate) async fn detail(
    db: &PgPool,
    id: i32,
    uid: i32,
    acl: &[i32],
) -> Result<Value, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('publisher', cd.publisher, 'startYear', cd."startYear", 'volume', cd.volume,
  'issues', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'itemId', i.id,
      'mediaFileId', pf.id,
      'format', CASE WHEN lower(pf.ext) IN ('cbz', 'cb7', 'cbr', 'pdf') THEN lower(pf.ext) END,
      'number', ci.label, 'sort', ci."sortNumber"::float8, 'annual', ci.kind <> 'issue', 'kind', ci.kind,
      'title', i.title, 'overview', i.overview, 'releaseDate', i."airDate"::text, 'pageCount', ci."pageCount",
      'progression', CASE WHEN ps.id IS NULL THEN NULL
          WHEN ps.completed THEN 1.0::float8
          WHEN ps.progression IS NOT NULL THEN ps.progression
          WHEN ps."durationSeconds" > 0 THEN LEAST(1.0, ps."positionSeconds" / ps."durationSeconds")
          ELSE 0.0::float8 END,
      'finished', COALESCE(ps.completed, false))
      ORDER BY ci.kind <> 'issue', ci."sortNumber", ci.kind, i.id)
    FROM items i JOIN comic_issues ci ON ci."itemId" = i.id JOIN editions e ON e.id = i."editionId"
    LEFT JOIN playback_states ps ON ps."itemId" = i.id AND ps."userId" = $2
    LEFT JOIN LATERAL (SELECT f.id, substring(f."relativePath" FROM '\.([A-Za-z0-9]+)$') AS ext
        FROM media_files f WHERE f.id = comic_part(i.id, $2)) pf ON true
    WHERE i."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($3)), '[]'::jsonb)) AS "json!: Value"
FROM media m LEFT JOIN comic_details cd ON cd."mediaId" = m.id WHERE m.id = $1"#,
        id,
        uid,
        acl
    )
    .fetch_one(db)
    .await
}

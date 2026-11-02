//! The `book` objects of media payloads and the chapters of an edition (`books-api.md` A3-A6).
use crate::http::AppError;
use fliks_domain::media::kind::MediaKind;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashMap;

fn families() -> Vec<&'static str> {
    MediaKind::Book
        .families()
        .iter()
        .map(|f| f.as_str())
        .collect()
}

fn book_ids(data: &[Value]) -> Vec<i32> {
    data.iter()
        .filter(|v| v["type"] == MediaKind::Book.as_str())
        .filter_map(|v| v["id"].as_i64().and_then(|n| i32::try_from(n).ok()))
        .collect()
}

/// Adds `book: BookListInfo` to the book items of `data` (A3); `acl` is the caller's readable libraries.
pub(crate) async fn attach_list_info(
    db: &PgPool,
    data: &mut [Value],
    uid: i32,
    acl: &[i32],
) -> Result<(), sqlx::Error> {
    let ids = book_ids(data);
    if ids.is_empty() {
        return Ok(());
    }
    let rows = sqlx::query!(
        r#"SELECT m.id AS "id!", jsonb_build_object(
  'authors', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'sortName', p."sortName") ORDER BY a.position, a.id)
      FROM (SELECT c.id, c.position, c."personId" FROM media_credits c
            WHERE c."mediaId" = m.id AND c.role = 'author' AND c."editionId" IS NULL
            ORDER BY c.position, c.id LIMIT 3) a
      JOIN persons p ON p.id = a."personId"), '[]'::jsonb),
  'series', (SELECT jsonb_build_object('id', c.id, 'name', c.name, 'position', e.position::float8, 'positionLabel', e."positionLabel")
      FROM collection_entries e JOIN collections c ON c.id = e."collectionId"
      WHERE e."mediaId" = m.id AND e."itemId" IS NULL ORDER BY c.id LIMIT 1),
  'formats', COALESCE((SELECT jsonb_agg(f.family ORDER BY f.ord) FROM unnest($4::text[]) WITH ORDINALITY f(family, ord)
      WHERE EXISTS (SELECT 1 FROM editions e JOIN items i ON i."editionId" = e.id JOIN item_parts ip ON ip."itemId" = i.id
                    WHERE e."mediaId" = m.id AND e.family = f.family
                      AND COALESCE(e."libraryId", m."libraryId") = ANY($3))), '[]'::jsonb),
  'lastFamily', (SELECT e.family FROM playback_states ps JOIN items i ON i.id = ps."itemId" JOIN editions e ON e.id = i."editionId"
      WHERE ps."userId" = $2 AND i."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($3)
      ORDER BY ps."lastPlayedAt" DESC, ps.id DESC LIMIT 1)
) AS "json!: Value"
FROM media m WHERE m.id = ANY($1)"#,
        &ids,
        uid,
        acl,
        &families() as &[&str]
    )
    .fetch_all(db)
    .await?;
    let mut info: HashMap<i32, Value> = rows.into_iter().map(|r| (r.id, r.json)).collect();
    for item in data.iter_mut() {
        let id = item["id"].as_i64().and_then(|n| i32::try_from(n).ok());
        if let (Some(o), Some(book)) = (item.as_object_mut(), id.and_then(|i| info.remove(&i))) {
            o.insert("book".into(), book);
        }
    }
    Ok(())
}

/// The `{id, type, title, year, posterUrl, watched, progressPercent, book?}` summary of `ids` (A8, A9).
pub(crate) async fn summaries(
    db: &PgPool,
    ids: &[i32],
    uid: i32,
    acl: &[i32],
) -> Result<HashMap<i32, Value>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT m.id AS "id!", jsonb_build_object('id', m.id, 'type', m.type, 'title', m.title, 'year', m.year,
  'posterUrl', m."posterUrl") AS "json!: Value"
FROM media m WHERE m.id = ANY($1)"#,
        ids
    )
    .fetch_all(db)
    .await?;
    let watched = super::list::watched_map(db, ids, uid).await?;
    let (keys, mut data): (Vec<i32>, Vec<Value>) = rows.into_iter().map(|r| (r.id, r.json)).unzip();
    for (id, item) in keys.iter().zip(data.iter_mut()) {
        let (w, p) = watched.get(id).copied().unwrap_or((false, 0));
        if let Some(o) = item.as_object_mut() {
            o.insert("watched".into(), w.into());
            o.insert("progressPercent".into(), p.into());
        }
    }
    attach_list_info(db, &mut data, uid, acl).await?;
    Ok(keys.into_iter().zip(data).collect())
}

/// `BookDetail` of a book (A4).
pub(crate) async fn detail(
    db: &PgPool,
    id: i32,
    uid: i32,
    acl: &[i32],
) -> Result<Value, sqlx::Error> {
    let mut book = sqlx::query_scalar!(
        r#"SELECT jsonb_build_object(
  'subtitle', bd.subtitle, 'originalLanguage', bd."originalLanguage", 'subjects', COALESCE(bd.subjects, '[]'::jsonb),
  'authors', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'sortName', p."sortName") ORDER BY c.position, c.id)
      FROM media_credits c JOIN persons p ON p.id = c."personId"
      WHERE c."mediaId" = m.id AND c.role = 'author' AND c."editionId" IS NULL), '[]'::jsonb),
  'translators', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'sortName', p."sortName") ORDER BY c.position, c.id)
      FROM media_credits c JOIN persons p ON p.id = c."personId"
      WHERE c."mediaId" = m.id AND c.role = 'translator' AND c."editionId" IS NULL), '[]'::jsonb),
  'series', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'position', ce.position::float8,
      'positionLabel', ce."positionLabel",
      'previous', (SELECT jsonb_build_object('id', s.id, 'title', s.title, 'position', se.position::float8)
          FROM collection_entries se JOIN media s ON s.id = se."mediaId"
          WHERE se."collectionId" = c.id AND se."itemId" IS NULL AND se."mediaId" <> m.id AND s.type = 'book'
            AND s."libraryId" = ANY($2) AND ce.position IS NOT NULL AND se.position < ce.position
          ORDER BY se.position DESC, se."mediaId" DESC LIMIT 1),
      'next', (SELECT jsonb_build_object('id', s.id, 'title', s.title, 'position', se.position::float8)
          FROM collection_entries se JOIN media s ON s.id = se."mediaId"
          WHERE se."collectionId" = c.id AND se."itemId" IS NULL AND se."mediaId" <> m.id AND s.type = 'book'
            AND s."libraryId" = ANY($2) AND ce.position IS NOT NULL AND se.position > ce.position
          ORDER BY se.position ASC, se."mediaId" ASC LIMIT 1)) ORDER BY c.id)
      FROM collection_entries ce JOIN collections c ON c.id = ce."collectionId"
      WHERE ce."mediaId" = m.id AND ce."itemId" IS NULL), '[]'::jsonb),
  'editions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', e.id,
      'itemId', (SELECT min(i.id) FROM items i WHERE i."editionId" = e.id AND i."groupId" IS NULL),
      'family', e.family, 'format', e.format, 'language', e.language, 'title', e.title, 'publisher', e.publisher,
      'published', (SELECT d.date FROM media_release_dates d WHERE d."editionId" = e.id AND d.kind = 'release'),
      'coverUrl', e."coverUrl", 'durationSeconds', e."durationSeconds", 'pageCount', e."pageCount",
      'libraryId', e."libraryId", 'label', e.label,
      'narrators', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'sortName', p."sortName") ORDER BY c.position, c.id)
          FROM media_credits c JOIN persons p ON p.id = c."personId"
          WHERE c."editionId" = e.id AND c.role = 'narrator'), '[]'::jsonb),
      'hasFile', EXISTS (SELECT 1 FROM items i JOIN item_parts ip ON ip."itemId" = i.id WHERE i."editionId" = e.id),
      'fileIds', COALESCE((SELECT jsonb_agg(g.id ORDER BY g.version, g.position, g.id)
          FROM (SELECT ip."mediaFileId" AS id, min(ip.version) AS version, min(ip.position) AS position
                FROM items i JOIN item_parts ip ON ip."itemId" = i.id WHERE i."editionId" = e.id
                GROUP BY ip."mediaFileId") g), '[]'::jsonb),
      'externalIds', COALESCE((SELECT jsonb_agg(jsonb_build_object('provider', x.provider, 'value', x.value) ORDER BY x.provider, x.value)
          FROM edition_external_ids x WHERE x."editionId" = e.id), '[]'::jsonb),
      'fieldSources', COALESCE((SELECT jsonb_agg(jsonb_build_object('field', s.field, 'provider', s.provider, 'locked', s.locked) ORDER BY s.field)
          FROM edition_field_sources s WHERE s."editionId" = e.id), '[]'::jsonb))
      ORDER BY array_position($3::text[], e.family), e.id)
      FROM editions e WHERE e."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($2)), '[]'::jsonb)
) AS "json!: Value"
FROM media m LEFT JOIN book_details bd ON bd."mediaId" = m.id WHERE m.id = $1"#,
        id,
        acl,
        &families() as &[&str]
    )
    .fetch_one(db)
    .await?;
    let progress = sqlx::query!(
        r#"SELECT e.id AS "edition!", i.id AS "item!", ps.completed AS "completed!",
  CASE WHEN ps.completed THEN 1.0::float8
       WHEN ps."durationSeconds" > 0 THEN LEAST(1.0, ps."positionSeconds" / ps."durationSeconds")
       ELSE 0.0::float8 END AS "progression!",
  iso_ms(ps."lastPlayedAt") AS "last_played!"
FROM playback_states ps JOIN items i ON i.id = ps."itemId" JOIN editions e ON e.id = i."editionId"
JOIN media m ON m.id = i."mediaId"
WHERE ps."userId" = $1 AND i."mediaId" = $2 AND COALESCE(e."libraryId", m."libraryId") = ANY($3)
ORDER BY ps."lastPlayedAt" DESC, ps.id DESC LIMIT 1"#,
        uid,
        id,
        acl
    )
    .fetch_optional(db)
    .await?
    .map(|r| {
        json!({"editionId": r.edition, "itemId": r.item, "progression": r.progression, "lastPlayedAt": r.last_played})
    });
    if let Some(o) = book.as_object_mut() {
        o.insert("progress".into(), progress.unwrap_or(Value::Null));
    }
    Ok(book)
}

fn edition_not_found(id: i32) -> AppError {
    AppError::not_found(format!("Edition #{id} not found"))
}

/// `BookChapter[]` of an edition on its version timeline (A6).
pub(crate) async fn chapters(
    db: &PgPool,
    media: i32,
    edition: i32,
    acl: &[i32],
) -> Result<Vec<Value>, AppError> {
    let visible = sqlx::query_scalar!(
        r#"SELECT e.id FROM editions e JOIN media m ON m.id = e."mediaId"
           WHERE e.id = $1 AND e."mediaId" = $2 AND COALESCE(e."libraryId", m."libraryId") = ANY($3)"#,
        edition,
        media,
        acl
    )
    .fetch_optional(db)
    .await?;
    if visible.is_none() {
        return Err(edition_not_found(edition));
    }
    let file = sqlx::query!(
        r#"WITH it AS (SELECT min(id) AS id FROM items WHERE "editionId" = $1 AND "groupId" IS NULL),
v AS (SELECT max(ip.version) AS v FROM item_parts ip, it WHERE ip."itemId" = it.id),
parts AS (SELECT ip."itemId", ip."mediaFileId" AS fid, ip.position,
    COALESCE(sum(COALESCE((f."streamInfo"->>'durationSeconds')::float8, 0))
      OVER (ORDER BY ip.position ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS off
  FROM item_parts ip JOIN media_files f ON f.id = ip."mediaFileId", it, v
  WHERE ip."itemId" = it.id AND ip.version = v.v)
SELECT mk.title AS "title?", (parts.off + mk."startSeconds")::float8 AS "start!", (parts.off + mk."endSeconds")::float8 AS "end!"
FROM parts JOIN item_markers mk ON mk."itemId" = parts."itemId" AND mk."mediaFileId" = parts.fid AND mk.kind = 'chapter'
ORDER BY parts.off + mk."startSeconds", mk.id"#,
        edition
    )
    .fetch_all(db)
    .await?;
    if !file.is_empty() {
        return Ok(file
            .into_iter()
            .map(|c| json!({"title": c.title, "startSeconds": c.start, "endSeconds": c.end, "source": "file"}))
            .collect());
    }
    let body = sqlx::query_scalar!(
        r#"SELECT s.body AS "body!" FROM metadata_snapshots s
WHERE s.provider = 'audnexus' AND s.resource = 'chapters' AND s.kind = $2 AND s.language = ''
  AND s."externalId" = (SELECT min(x.value) FROM edition_external_ids x WHERE x."editionId" = $1 AND x.provider = 'asin')"#,
        edition,
        MediaKind::Book.as_str()
    )
    .fetch_optional(db)
    .await?;
    Ok(body.as_ref().map(audnexus).unwrap_or_default())
}

fn whole_ms(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| {
        v.as_f64()
            .filter(|f| f.fract() == 0.0 && *f >= 0.0)
            .map(|f| f as u64)
    })
}

/// The `audnexus::Chapters` snapshot as `BookChapter[]`; an entry without a usable range is skipped.
fn audnexus(body: &Value) -> Vec<Value> {
    body["chapters"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let (start, len) = (whole_ms(&c["startMs"])?, whole_ms(&c["lengthMs"])?);
            Some(json!({
                "title": c["title"].as_str(),
                "startSeconds": start as f64 / 1000.0,
                "endSeconds": (start + len) as f64 / 1000.0,
                "source": "audnexus",
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audnexus_chapters_become_seconds_and_skip_unusable_entries() {
        let body = json!({"chapters": [
            {"title": "One", "startMs": 0, "lengthMs": 1500},
            {"title": "Bad", "startMs": 1500},
            {"title": "Two", "startMs": 1500, "lengthMs": 500}]});
        let c = audnexus(&body);
        assert_eq!(c.len(), 2);
        assert_eq!(
            (c[0]["endSeconds"].as_f64(), c[1]["startSeconds"].as_f64()),
            (Some(1.5), Some(1.5))
        );
        assert_eq!(c[1]["source"], "audnexus");
    }
}

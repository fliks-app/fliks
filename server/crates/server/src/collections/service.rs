use crate::media::books;
use fliks_domain::media::kind::MediaKind;
use serde_json::{Value, json};
use sqlx::PgPool;

/// Largest volume number `missingPositions` reaches, so a stray `position` cannot build a huge list.
const MAX_MISSING: i64 = 10_000;

/// A whole number as an integer, so a position reads `1` whether it came from SQL or from here.
pub(crate) fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        json!(f as i64)
    } else {
        json!(f)
    }
}

/// `%`, `_` and `\` literal in an `ILIKE` pattern.
fn contains_pattern(q: &str) -> String {
    let mut p = String::from("%");
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            p.push('\\');
        }
        p.push(c);
    }
    p.push('%');
    p
}

/// `books-api.md` A7.
pub async fn list(
    db: &PgPool,
    scope: &[i32],
    kind: Option<MediaKind>,
    q: Option<&str>,
    paging: Option<(i64, i64)>,
) -> Result<Vec<Value>, sqlx::Error> {
    sqlx::query_scalar!(
        r#"SELECT jsonb_build_object('id', c.id, 'name', c.name, 'count', COUNT(*)::int,
  'maxPosition', max(COALESCE(e."positionEnd", e.position))::float8,
  'posters', COALESCE((ARRAY_AGG(m."posterUrl" ORDER BY e.position NULLS LAST, m.id)
                       FILTER (WHERE m."posterUrl" IS NOT NULL))[1:4], ARRAY[]::text[])) AS "json!: Value"
FROM collections c
JOIN collection_entries e ON e."collectionId" = c.id AND e."itemId" IS NULL
JOIN media m ON m.id = e."mediaId"
WHERE m."libraryId" = ANY($1) AND ($2::text IS NULL OR m.type = $2) AND ($3::text IS NULL OR c.name ILIKE $3)
GROUP BY c.id ORDER BY c.name ASC, c.id ASC LIMIT $4 OFFSET $5"#,
        scope,
        kind.map(MediaKind::as_str),
        q.map(contains_pattern),
        paging.map(|p| p.0),
        paging.map(|p| p.1)
    )
    .fetch_all(db)
    .await
}

/// The integers `1..max` no entry covers (`books.md` rule 16); each span is `(position, end)`.
fn missing_positions(spans: &[(f64, f64)]) -> Vec<i64> {
    let max = spans.iter().map(|s| s.1).fold(0.0, f64::max);
    let max = max.floor().min(MAX_MISSING as f64) as i64;
    (1..=max)
        .filter(|n| {
            let n = *n as f64;
            !spans.iter().any(|(a, b)| *a <= n && n <= *b)
        })
        .collect()
}

/// `books-api.md` A8; `None` when the collection has no entry the caller can read.
pub async fn detail(
    db: &PgPool,
    id: i32,
    uid: i32,
    acl: &[i32],
) -> Result<Option<Value>, sqlx::Error> {
    let Some(head) = sqlx::query!(
        r#"SELECT c.name AS "name!",
  COALESCE((SELECT jsonb_agg(jsonb_build_object('provider', x.provider, 'value', x.value) ORDER BY x.provider)
            FROM collection_external_ids x WHERE x."collectionId" = c.id), '[]'::jsonb) AS "external_ids!: Value"
FROM collections c WHERE c.id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    let rows = sqlx::query!(
        r#"SELECT m.id AS "media_id!", e.position::float8 AS position, e."positionEnd"::float8 AS position_end,
  e."positionLabel" AS position_label
FROM collection_entries e JOIN media m ON m.id = e."mediaId"
LEFT JOIN media_release_dates d ON d."mediaId" = m.id AND d."editionId" IS NULL AND d.kind = 'release'
WHERE e."collectionId" = $1 AND e."itemId" IS NULL AND m."libraryId" = ANY($2)
ORDER BY e.position ASC NULLS LAST, d.date ASC NULLS LAST, m.year ASC NULLS LAST, m.id ASC"#,
        id,
        acl
    )
    .fetch_all(db)
    .await?;
    if rows.is_empty() {
        return Ok(None);
    }
    let ids: Vec<i32> = rows.iter().map(|r| r.media_id).collect();
    let mut media = books::summaries(db, &ids, uid, acl).await?;
    let spans: Vec<(f64, f64)> = rows
        .iter()
        .filter_map(|r| r.position.map(|p| (p, r.position_end.unwrap_or(p))))
        .collect();
    let mut next_up = None;
    let entries: Vec<Value> = rows
        .into_iter()
        .filter_map(|r| {
            let m = media.remove(&r.media_id)?;
            if next_up.is_none() && m["watched"] == false {
                next_up = Some(r.media_id);
            }
            Some(json!({
                "position": r.position.map(num), "positionEnd": r.position_end.map(num),
                "positionLabel": r.position_label, "media": m,
            }))
        })
        .collect();
    Ok(Some(json!({
        "id": id, "name": head.name, "externalIds": head.external_ids, "entries": entries,
        "missingPositions": missing_positions(&spans), "nextUp": next_up,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_range_covers_its_volumes_and_a_fraction_covers_none() {
        let spans = [(1.0, 3.0), (5.0, 5.0), (6.5, 6.5)];
        assert_eq!(missing_positions(&spans), vec![4, 6]);
        assert!(missing_positions(&[]).is_empty());
        assert_eq!(missing_positions(&[(0.0, 0.0)]), Vec::<i64>::new());
        assert_eq!(missing_positions(&[(1e9, 1e9)]).len(), MAX_MISSING as usize);
    }

    #[test]
    fn like_metacharacters_are_literal() {
        assert_eq!(contains_pattern(r"a%b_c\d"), r"%a\%b\_c\\d%");
    }
}

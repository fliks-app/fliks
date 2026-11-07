//! The acquisition entries of a list of books, read through the work, edition and file ACL.
use crate::{
    libraries::readable_file,
    stream::{book_format, extname},
};
use fliks_domain::{
    media::kind::MediaKind,
    opds::{ACQUISITION, Entry, Link},
};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;

const SUMMARY_MAX: usize = 4000;

/// The entries of `ids`, in that order; a book outside `acl` or with no readable file is absent.
pub async fn read(db: &PgPool, ids: &[i32], acl: &[i32]) -> Result<Vec<Entry>, sqlx::Error> {
    let families: Vec<&str> = MediaKind::Book
        .families()
        .iter()
        .map(|f| f.as_str())
        .collect();
    let readable = readable_file("$2", "f.id");
    let rows: Vec<Value> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT jsonb_build_object('id', m.id, 'title', m.title, 'overview', m.overview, 'year', m.year,
  'posterUrl', m."posterUrl", 'updated', iso_ms(m."updatedAt"),
  'authors', COALESCE((SELECT jsonb_agg(p.name ORDER BY c.position, c.id) FROM media_credits c
      JOIN persons p ON p.id = c."personId"
      WHERE c."mediaId" = m.id AND c.role = 'author' AND c."editionId" IS NULL), '[]'::jsonb),
  'editions', COALESCE((SELECT jsonb_agg(jsonb_build_object('language', e.language, 'publisher', e.publisher,
      'files', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'path', f."relativePath", 'size', f.size)
          ORDER BY ip.version DESC, ip.position, f.id)
        FROM items i JOIN item_parts ip ON ip."itemId" = i.id JOIN media_files f ON f.id = ip."mediaFileId"
        WHERE i."editionId" = e.id AND i."groupId" IS NULL
          AND NOT EXISTS (SELECT 1 FROM items i2 WHERE i2."editionId" = e.id AND i2."groupId" IS NULL AND i2.id < i.id)
          AND (e.family = 'text' OR ip.version = (SELECT max(ip2.version) FROM item_parts ip2 WHERE ip2."itemId" = i.id))
          AND {readable}), '[]'::jsonb))
      ORDER BY array_position($3::text[], e.family), e.id)
    FROM editions e WHERE e."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($2)), '[]'::jsonb))
FROM media m WHERE m.id = ANY($1) AND m.type = 'book' AND m."libraryId" = ANY($2)"#
    )))
    .bind(ids)
    .bind(acl)
    .bind(&families)
    .fetch_all(db)
    .await?;
    let mut by_id: HashMap<i64, Entry> = rows
        .iter()
        .filter_map(|r| Some((r["id"].as_i64()?, entry(r)?)))
        .collect();
    Ok(ids
        .iter()
        .filter_map(|i| by_id.remove(&i64::from(*i)))
        .filter(|e| {
            e.links
                .iter()
                .any(|l| l.rel.as_deref() == Some(ACQUISITION))
        })
        .collect())
}

fn entry(r: &Value) -> Option<Entry> {
    let id = r["id"].as_i64()?;
    let first = |k: &str| {
        r["editions"]
            .as_array()?
            .iter()
            .find_map(|e| e[k].as_str().map(str::to_owned))
    };
    let mut links = vec![];
    if let Some(p) = r["posterUrl"]
        .as_str()
        .filter(|p| p.starts_with("/api/images/"))
    {
        let sep = if p.contains('?') { '&' } else { '?' };
        links.push(Link::new("http://opds-spec.org/image", p, "image/jpeg"));
        links.push(Link::new(
            "http://opds-spec.org/image/thumbnail",
            format!("{p}{sep}size=thumb"),
            "image/jpeg",
        ));
    }
    for e in r["editions"].as_array()? {
        let files = e["files"].as_array()?;
        let ext_of = |f: &Value| extname(f["path"].as_str().unwrap_or_default());
        for (i, f) in files.iter().enumerate() {
            let ext = ext_of(f);
            let label = ext.trim_start_matches('.').to_uppercase();
            let same = |g: &&Value| ext_of(g) == ext;
            let total = files.iter().filter(same).count();
            let n = files[..i].iter().filter(same).count() + 1;
            links.push(Link {
                length: f["size"].as_i64(),
                title: Some(if total > 1 {
                    format!("{label} {n}/{total}")
                } else {
                    label
                }),
                ..Link::new(
                    ACQUISITION,
                    format!("/api/stream/{}?download=1", f["id"].as_i64()?),
                    book_format(&ext).unwrap_or("application/octet-stream"),
                )
            });
        }
    }
    let title = r["title"].as_str()?;
    Some(Entry {
        id: format!("urn:fliks:book:{id}"),
        title: title.to_owned(),
        updated: r["updated"].as_str()?.to_owned(),
        authors: r["authors"]
            .as_array()?
            .iter()
            .filter_map(|a| a.as_str().map(str::to_owned))
            .collect(),
        content: Some(
            r["overview"]
                .as_str()
                .unwrap_or(title)
                .chars()
                .take(SUMMARY_MAX)
                .collect(),
        ),
        summary: r["overview"]
            .as_str()
            .map(|s| s.chars().take(SUMMARY_MAX).collect()),
        language: first("language"),
        publisher: first("publisher"),
        issued: r["year"].as_i64().map(|y| y.to_string()),
        links,
    })
}

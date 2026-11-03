//! The Kobo books of a caller (`kobo.md` rules 7-9): which items count, their JSON, covers.
use super::{BOOK_PREFIX, Kobo, iso, json_response, parse_uuid, uuid};
use crate::{
    http::AppError,
    images::paths::{Size, Target, Variant},
    libraries::HIDDEN_FILES_FROM,
    paths::data_dir,
};
use axum::{
    extract::Path,
    http::{
        HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE},
    },
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;

#[derive(sqlx::FromRow)]
pub struct Book {
    pub item: i32,
    pub media: i32,
    pub file: i32,
    pub size: i64,
    pub title: String,
    pub overview: Option<String>,
    pub year: Option<i32>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub created: DateTime<Utc>,
    pub updated: DateTime<Utc>,
    pub authors: Vec<String>,
}

/// The EPUB items `$1` (library ids) lets the caller read; `$2` narrows to item ids (NULL: all).
pub async fn fetch(
    db: &PgPool,
    acl: &[i32],
    only: Option<&[i32]>,
) -> Result<Vec<Book>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT i.id AS item, m.id AS media, f.id AS file, f.size, m.title, m.overview, m.year,
  e.language, e.publisher, m."createdAt" AS created,
  GREATEST(i."updatedAt", m."updatedAt", f."updatedAt") AS updated,
  ARRAY(SELECT p.name FROM media_credits c JOIN persons p ON p.id = c."personId"
        WHERE c."mediaId" = m.id AND c.role = 'author' AND c."editionId" IS NULL
        ORDER BY c.position, c.id) AS authors
FROM items i
JOIN editions e ON e.id = i."editionId" AND e.family = 'text'
JOIN media m ON m.id = i."mediaId" AND m.type = 'book'
JOIN LATERAL (
  SELECT mf.id, mf.size, mf."updatedAt" FROM item_parts ip JOIN media_files mf ON mf.id = ip."mediaFileId"
  WHERE ip."itemId" = i.id
    AND ip.version = (SELECT max(v.version) FROM item_parts v WHERE v."itemId" = i.id)
    AND lower(mf."relativePath") LIKE '%.epub'
    AND NOT EXISTS (SELECT 1 {HIDDEN_FILES_FROM}$1) AND hp."mediaFileId" = mf.id)
  ORDER BY ip.position, mf.id LIMIT 1) f ON true
WHERE i."groupId" IS NULL
  AND i.id = (SELECT min(i2.id) FROM items i2 WHERE i2."editionId" = e.id AND i2."groupId" IS NULL)
  AND m."libraryId" = ANY($1) AND COALESCE(e."libraryId", m."libraryId") = ANY($1)
  AND ($2::int[] IS NULL OR i.id = ANY($2))
ORDER BY i.id"#
    )))
    .bind(acl)
    .bind(only)
    .fetch_all(db)
    .await
}

/// The one place that chooses the format and URL of a book's file (the KEPUB hook of item 6.2).
fn download(k: &Kobo, b: &Book) -> Value {
    json!({
        "Format": "EPUB3",
        "Size": b.size,
        "Url": format!("{}/cred/{}/api/stream/{}?download=1", k.base, k.token, b.file),
        "Platform": "Generic",
    })
}

pub fn entitlement(
    item: i32,
    created: DateTime<Utc>,
    updated: DateTime<Utc>,
    removed: bool,
) -> Value {
    let id = uuid(BOOK_PREFIX, item);
    json!({
        "Accessibility": "Full",
        "ActivePeriod": {"From": iso(created)},
        "Created": iso(created),
        "CrossRevisionId": id,
        "Id": id,
        "IsRemoved": removed,
        "IsHiddenFromArchive": false,
        "IsLocked": false,
        "LastModified": iso(updated),
        "OriginCategory": "Imported",
        "RevisionId": id,
        "Status": "Active",
    })
}

pub fn book_entitlement(b: &Book) -> Value {
    entitlement(b.item, b.created, b.updated, false)
}

pub fn book_metadata(k: &Kobo, b: &Book) -> Value {
    let id = uuid(BOOK_PREFIX, b.item);
    let mut m = json!({
        "Categories": ["00000000-0000-0000-0000-000000000001"],
        "Contributors": b.authors,
        "CoverImageId": id,
        "CrossRevisionId": id,
        "CurrentDisplayPrice": {"CurrencyCode": "USD", "TotalAmount": 0},
        "CurrentLoveDisplayPrice": {"TotalAmount": 0},
        "DownloadUrls": [download(k, b)],
        "EntitlementId": id,
        "ExternalIds": [],
        "Genre": "00000000-0000-0000-0000-000000000001",
        "IsEligibleForKoboLove": false,
        "IsInternetArchive": false,
        "IsPreOrder": false,
        "IsSocialEnabled": true,
        "Language": b.language.as_deref().unwrap_or("en"),
        "PhoneticPronunciations": {},
        "RevisionId": id,
        "Title": b.title,
        "WorkId": id,
    });
    let o = m.as_object_mut().expect("object");
    if let Some(d) = &b.overview {
        o.insert("Description".into(), d.clone().into());
    }
    if let Some(p) = &b.publisher {
        o.insert("Publisher".into(), json!({"Imprint": "", "Name": p}));
    }
    if let Some(y) = b.year {
        o.insert(
            "PublicationDate".into(),
            format!("{y:04}-01-01T00:00:00Z").into(),
        );
    }
    m
}

pub fn not_found() -> Response {
    StatusCode::NOT_FOUND.into_response()
}

/// The readable book named by a path uuid.
pub async fn find(db: &PgPool, k: &Kobo, id: &str) -> Result<Option<Book>, sqlx::Error> {
    let Some(item) = parse_uuid(BOOK_PREFIX, id) else {
        return Ok(None);
    };
    Ok(fetch(db, &k.acl, Some(&[item])).await?.into_iter().next())
}

pub async fn metadata(
    axum::extract::State(st): axum::extract::State<crate::state::AppState>,
    k: Kobo,
    Path((_, id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    Ok(match find(&st.db, &k, &id).await? {
        Some(b) => json_response(StatusCode::OK, json!([book_metadata(&k, &b)])),
        None => not_found(),
    })
}

pub async fn cover(
    st: axum::extract::State<crate::state::AppState>,
    k: Kobo,
    Path((_, id, w, _h, _grey)): Path<(String, String, String, String, String)>,
) -> Result<Response, AppError> {
    serve_cover(&st.db, &k, &id, &w).await
}

pub async fn cover_quality(
    st: axum::extract::State<crate::state::AppState>,
    k: Kobo,
    Path((_, id, w, _h, _q, _grey)): Path<(String, String, String, String, String, String)>,
) -> Result<Response, AppError> {
    serve_cover(&st.db, &k, &id, &w).await
}

async fn serve_cover(db: &PgPool, k: &Kobo, id: &str, width: &str) -> Result<Response, AppError> {
    let Some(b) = find(db, k, id).await? else {
        return Ok(not_found());
    };
    let t = Target::media(b.media, Variant::Poster);
    let first = if width.parse::<u32>().is_ok_and(|w| w <= 300) {
        Size::Thumb
    } else {
        Size::Medium
    };
    for size in [first, Size::Full] {
        if let Ok(bytes) = tokio::fs::read(t.file(data_dir(), size)).await {
            return Ok((
                [
                    (CONTENT_TYPE, HeaderValue::from_static("image/jpeg")),
                    (
                        CACHE_CONTROL,
                        HeaderValue::from_static("private, max-age=86400"),
                    ),
                ],
                bytes,
            )
                .into_response());
        }
    }
    Ok(not_found())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuids_round_trip_and_reject_other_shapes() {
        let u = uuid(BOOK_PREFIX, 4242);
        assert_eq!(parse_uuid(BOOK_PREFIX, &u), Some(4242));
        assert_eq!(parse_uuid(super::super::SHELF_PREFIX, &u), None);
        for bad in [
            "",
            "f11c5b00-0000-4000-8000-00000000000g",
            "f11c5b00-0000-4000-8000-0000000000000",
        ] {
            assert_eq!(parse_uuid(BOOK_PREFIX, bad), None, "{bad}");
        }
        assert_eq!(parse_uuid(BOOK_PREFIX, &uuid(BOOK_PREFIX, 0)), None);
    }
}

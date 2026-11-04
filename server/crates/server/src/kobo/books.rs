//! The Kobo books of a caller (`kobo.md` rules 7-9): which items count, their JSON, covers.
use super::{BOOK_PREFIX, Kobo, iso, json_response, parse_uuid, proxy, uuid};
use crate::{
    http::AppError,
    images::{
        self,
        paths::{Size, Target, Variant},
    },
    libraries::readable_file,
    state::AppState,
};
use axum::{
    extract::{Path, Request, State},
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

const UPDATED: &str = r#"GREATEST(i."updatedAt", m."updatedAt", f."updatedAt", e."updatedAt",
  (SELECT max(c."updatedAt") FROM media_credits c WHERE c."mediaId" = m.id))"#;

/// The EPUB items `$1` (library ids) lets the caller read; `$2` narrows to item ids (NULL: all).
fn from_where() -> String {
    let readable = readable_file("$1", "mf.id");
    format!(
        r#"FROM items i
JOIN editions e ON e.id = i."editionId" AND e.family = 'text'
JOIN media m ON m.id = i."mediaId" AND m.type = 'book'
JOIN LATERAL (
  SELECT mf.id, mf.size, mf."updatedAt" FROM item_parts ip JOIN media_files mf ON mf.id = ip."mediaFileId"
  WHERE ip."itemId" = i.id
    AND ip.version = (SELECT max(v.version) FROM item_parts v WHERE v."itemId" = i.id)
    AND lower(mf."relativePath") LIKE '%.epub'
    AND {readable}
  ORDER BY ip.position, mf.id LIMIT 1) f ON true
WHERE i."groupId" IS NULL
  AND i.id = (SELECT min(i2.id) FROM items i2 WHERE i2."editionId" = e.id AND i2."groupId" IS NULL)
  AND ($2::int[] IS NULL OR i.id = ANY($2))
ORDER BY i.id"#
    )
}

/// A readable book's id and dates: what a sync compares before it reads any metadata.
#[derive(sqlx::FromRow)]
pub struct Index {
    pub item: i32,
    pub created: DateTime<Utc>,
    pub updated: DateTime<Utc>,
}

pub async fn index<'e>(
    db: impl sqlx::PgExecutor<'e>,
    acl: &[i32],
    only: Option<&[i32]>,
) -> Result<Vec<Index>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT i.id AS item, m."createdAt" AS created, {UPDATED} AS updated {}"#,
        from_where()
    )))
    .bind(acl)
    .bind(only)
    .fetch_all(db)
    .await
}

pub async fn fetch<'e>(
    db: impl sqlx::PgExecutor<'e>,
    acl: &[i32],
    only: Option<&[i32]>,
) -> Result<Vec<Book>, sqlx::Error> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT i.id AS item, m.id AS media, f.id AS file, f.size, m.title, m.overview, m.year,
  e.language, e.publisher, m."createdAt" AS created, {UPDATED} AS updated,
  ARRAY(SELECT p.name FROM media_credits c JOIN persons p ON p.id = c."personId"
        WHERE c."mediaId" = m.id AND c.role = 'author' AND c."editionId" IS NULL
        ORDER BY c.position, c.id) AS authors
{}"#,
        from_where()
    )))
    .bind(acl)
    .bind(only)
    .fetch_all(db)
    .await
}

/// The one place that chooses the formats and URLs of a book's file: KEPUB, converted on download.
fn downloads(k: &Kobo, b: &Book) -> Value {
    let url = format!(
        "{}/kobo/{}/download/{}/kepub",
        k.base,
        k.token,
        uuid(BOOK_PREFIX, b.item)
    );
    json!([{"Format": "KEPUB", "Size": b.size, "Url": url, "Platform": "Generic"}])
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
        "DownloadUrls": downloads(k, b),
        "ContributorRoles": b.authors.iter().map(|a| json!({"Name": a, "Role": "Author"})).collect::<Vec<_>>(),
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
    State(st): State<AppState>,
    k: Kobo,
    Path((_, id)): Path<(String, String)>,
    req: Request,
) -> Result<Response, AppError> {
    if proxy::store_book(&st, &id).await? {
        return Ok(proxy::forward(&st, req).await);
    }
    Ok(match find(&st.db, &k, &id).await? {
        Some(b) => json_response(StatusCode::OK, json!([book_metadata(&k, &b)])),
        None => not_found(),
    })
}

pub async fn cover(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, id, w, h, _grey)): Path<(String, String, String, String, String)>,
) -> Result<Response, AppError> {
    serve_cover(&st, &k, &id, &w, &h).await
}

pub async fn cover_quality(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, id, w, h, _q, _grey)): Path<(String, String, String, String, String, String)>,
) -> Result<Response, AppError> {
    serve_cover(&st, &k, &id, &w, &h).await
}

async fn serve_cover(
    st: &AppState,
    k: &Kobo,
    id: &str,
    width: &str,
    height: &str,
) -> Result<Response, AppError> {
    if proxy::store_book(st, id).await? {
        return Ok(proxy::store_cover(id, width, height));
    }
    let Some(b) = find(&st.db, k, id).await? else {
        return Ok(not_found());
    };
    let t = Target::media(b.media, Variant::Poster);
    let first = if width.parse::<u32>().is_ok_and(|w| w <= 300) {
        Size::Thumb
    } else {
        Size::Medium
    };
    if let Some(bytes) = images::read(&t, first).await {
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

//! Comics in the catalogue (`docs/spec/opds.md` rules 16-21): volume feeds, issue entries, PSE pages.
use super::{OpdsAuthed, PAGE, Params, ROOT, links, missing, nav_entry, page_of, xml};
use crate::{
    comics::{MAX_WIDTH, serve_page},
    http::{AppError, kinds::Kinds, validate::PathParams},
    libraries::{HIDDEN_FILES_FROM, accessible_library_ids},
    media::{list::find_ids, params::Search},
    state::AppState,
    stream::{book_format, extname},
};
use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::Response,
};
use fliks_domain::{
    media::kind::MediaKind,
    opds::{ACQ_TYPE, ACQUISITION, Entry, Feed, Link, NAV_TYPE, PSE_STREAM, Pse, render},
};
use serde::Deserialize;
use sqlx::PgPool;

const STREAM_HREF: &str = "/api/opds/issues";

pub fn comic_search(page: i64) -> Search {
    Search {
        media_type: Some(MediaKind::Comic),
        page: Some(page as f64),
        limit: Some(PAGE as f64),
        ..Search::default()
    }
}

fn issues_count(n: i64) -> String {
    format!("{n} issue{}", if n == 1 { "" } else { "s" })
}

/// Navigation entries of the volumes in `ids` (in that order) with a readable issue.
pub async fn volumes(
    db: &PgPool,
    ids: &[i32],
    acl: &[i32],
    uid: i32,
) -> Result<Vec<Entry>, sqlx::Error> {
    let rows: Vec<(i32, String, String, Option<String>, i64)> =
        sqlx::query_as(sqlx::AssertSqlSafe(format!(
            r#"SELECT m.id, m.title, iso_ms(m."updatedAt"), m."posterUrl",
  (SELECT count(*) FROM comic_issues ci JOIN items i ON i.id = ci."itemId"
     JOIN editions e ON e.id = i."editionId" AND e.family = 'image'
     JOIN media_files f ON f.id = comic_part(i.id, $3)
    WHERE i."mediaId" = m.id AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
      AND NOT EXISTS (SELECT 1 {HIDDEN_FILES_FROM}$2) AND hp."mediaFileId" = f.id))
FROM media m WHERE m.id = ANY($1) AND m.type = 'comic' AND m."libraryId" = ANY($2)"#
        )))
        .bind(ids)
        .bind(acl)
        .bind(uid)
        .fetch_all(db)
        .await?;
    let mut by_id: std::collections::HashMap<i32, Entry> = rows
        .into_iter()
        .filter(|r| r.4 > 0)
        .map(|(id, title, updated, poster, n)| {
            let mut e = nav_entry(
                format!("urn:fliks:comic-volume:{id}"),
                &title,
                Some(issues_count(n)),
                format!("/api/opds/comics/{id}"),
            );
            e.updated = updated;
            if let Some(p) = poster.filter(|p| p.starts_with("/api/images/")) {
                let sep = if p.contains('?') { '&' } else { '?' };
                e.links
                    .push(Link::new("http://opds-spec.org/image", &p, "image/jpeg"));
                e.links.push(Link::new(
                    "http://opds-spec.org/image/thumbnail",
                    format!("{p}{sep}size=thumb"),
                    "image/jpeg",
                ));
            }
            (id, e)
        })
        .collect();
    Ok(ids.iter().filter_map(|i| by_id.remove(i)).collect())
}

/// A navigation feed of the comic volumes of a search (`library_id` inside `s` when set).
pub async fn volume_list(
    st: &AppState,
    uid: i32,
    acl: &[i32],
    s: &Search,
    (id, title, href, up): (&str, String, &str, &str),
    page: i64,
) -> Result<Response, AppError> {
    let (ids, total) = find_ids(&st.db, s, acl, &Kinds::all(), uid).await?;
    let feed = Feed {
        id: id.to_owned(),
        title,
        updated: super::now(),
        links: links(href, Some(up), NAV_TYPE, page, total > page * PAGE),
        entries: volumes(&st.db, &ids, acl, uid).await?,
    };
    Ok(xml(NAV_TYPE, render(&feed)))
}

#[utoipa::path(get, path = "/api/opds/comics", responses((status = 200)))]
pub async fn comics_list(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    Query(q): Params,
) -> Result<Response, AppError> {
    let page = page_of(&q)?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    volume_list(
        &st,
        a.user.id,
        &acl,
        &comic_search(page),
        (
            "urn:fliks:opds:comics",
            "Comics".into(),
            "/api/opds/comics",
            ROOT,
        ),
        page,
    )
    .await
}

#[derive(sqlx::FromRow)]
struct Row {
    item: i32,
    label: String,
    kind: String,
    title: Option<String>,
    page_count: Option<i32>,
    year: Option<i32>,
    file: i32,
    path: String,
    size: i64,
    last_read: Option<i32>,
    completed: bool,
    last_read_date: Option<String>,
}

fn issue_entry(volume: &str, updated: &str, publisher: Option<&String>, r: Row) -> Entry {
    let ext = extname(&r.path);
    let name = ext.trim_start_matches('.').to_uppercase();
    let prefix = match r.kind.as_str() {
        "annual" => "Annual ",
        "special" => "Special ",
        _ => "",
    };
    let mut title = format!("{volume} {prefix}#{}", r.label);
    if let Some(t) = r.title.as_deref().filter(|t| !t.is_empty()) {
        title = format!("{title}: {t}");
    }
    let mut links = vec![Link {
        length: Some(r.size),
        title: Some(name),
        ..Link::new(
            ACQUISITION,
            format!("/api/stream/{}?download=1", r.file),
            book_format(&ext).unwrap_or("application/octet-stream"),
        )
    }];
    if let Some(count) = r.page_count.filter(|_| ext != ".pdf") {
        let count = i64::from(count);
        let last_read = r
            .last_read
            .map(i64::from)
            .or_else(|| r.completed.then_some(count))
            .map(|n| n.clamp(1, count));
        links.push(Link {
            pse: Some(Pse {
                count,
                last_read_date: last_read.and(r.last_read_date),
                last_read,
            }),
            ..Link::new(
                PSE_STREAM,
                format!(
                    "{STREAM_HREF}/{}/pages/{{pageNumber}}?width={{maxWidth}}",
                    r.item
                ),
                "image/jpeg",
            )
        });
    }
    Entry {
        id: format!("urn:fliks:comic:{}", r.item),
        content: Some(title.clone()),
        title,
        updated: updated.to_owned(),
        publisher: publisher.cloned(),
        issued: r.year.map(|y| y.to_string()),
        links,
        ..Entry::default()
    }
}

#[utoipa::path(get, path = "/api/opds/comics/{id}", responses((status = 200)))]
pub async fn volume(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    Path(id): Path<i32>,
    Query(q): Params,
) -> Result<Response, AppError> {
    let page = page_of(&q)?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let head: Option<(String, String, Option<String>)> = sqlx::query_as(
        r#"SELECT m.title, iso_ms(m."updatedAt"), cd.publisher FROM media m
           LEFT JOIN comic_details cd ON cd."mediaId" = m.id
           WHERE m.id = $1 AND m.type = 'comic' AND m."libraryId" = ANY($2)"#,
    )
    .bind(id)
    .bind(&acl)
    .fetch_optional(&st.db)
    .await?;
    let (title, updated, publisher) = head.ok_or_else(|| missing("Comic", id))?;
    let mut rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT i.id AS item, ci.label, ci.kind, i.title, ci."pageCount" AS page_count,
  EXTRACT(year FROM i."airDate")::int AS year, f.id AS file, f."relativePath" AS path, f.size,
  CASE WHEN jsonb_typeof(ps.locator -> 'page') = 'number' THEN LEAST(GREATEST(floor((ps.locator ->> 'page')::numeric), 0), 1000000)::int END AS last_read,
  COALESCE(ps.completed, false) AS completed,
  to_char(ps."lastPlayedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_read_date
FROM items i JOIN comic_issues ci ON ci."itemId" = i.id JOIN media m ON m.id = i."mediaId"
  JOIN editions e ON e.id = i."editionId" AND e.family = 'image'
  JOIN media_files f ON f.id = comic_part(i.id, $3)
  LEFT JOIN playback_states ps ON ps."itemId" = i.id AND ps."userId" = $3
WHERE i."mediaId" = $1 AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
  AND NOT EXISTS (SELECT 1 {HIDDEN_FILES_FROM}$2) AND hp."mediaFileId" = f.id)
ORDER BY ci.kind <> 'issue', ci."sortNumber", ci.kind, i.id LIMIT $4 OFFSET $5"#
    )))
    .bind(id)
    .bind(&acl)
    .bind(a.user.id)
    .bind(PAGE + 1)
    .bind((page - 1) * PAGE)
    .fetch_all(&st.db)
    .await?;
    if rows.is_empty() && page == 1 {
        return Err(missing("Comic", id));
    }
    let has_next = rows.len() as i64 > PAGE;
    rows.truncate(PAGE as usize);
    let href = format!("/api/opds/comics/{id}");
    let feed = Feed {
        id: format!("urn:fliks:opds:comics:{id}"),
        title: title.clone(),
        updated: super::now(),
        links: links(&href, Some("/api/opds/comics"), ACQ_TYPE, page, has_next),
        entries: rows
            .into_iter()
            .map(|r| issue_entry(&title, &updated, publisher.as_ref(), r))
            .collect(),
    };
    Ok(xml(ACQ_TYPE, render(&feed)))
}

#[derive(Deserialize)]
pub struct PageQuery {
    width: Option<String>,
}

/// The PSE stream URL: the page route of `comics/pages.rs` under the OPDS credential.
#[utoipa::path(get, path = "/api/opds/issues/{itemId}/pages/{index}", responses((status = 200)))]
pub async fn issue_page(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    headers: HeaderMap,
    p: Result<PathParams<(i32, i64)>, AppError>,
    Query(q): Query<PageQuery>,
) -> Result<Response, AppError> {
    let PathParams((item, index)) = p?;
    // A width above the cap is clamped, an absent or unreplaced `{maxWidth}` gets the cap (always JPEG).
    let width = q
        .width
        .and_then(|w| w.parse::<u32>().ok())
        .unwrap_or(MAX_WIDTH)
        .clamp(1, MAX_WIDTH);
    serve_page(&st, &a, None, &headers, item, index, Some(width)).await
}

//! The OPDS 1.2 catalogue (`docs/spec/opds.md`): Atom feeds of the books the token's owner can read.
mod auth;
mod entries;

use crate::{
    collections::service as series,
    http::AppError,
    libraries::accessible_library_ids,
    media::{list::find_ids, params::Search},
    persons::service as persons,
    state::AppState,
};
use auth::OpdsAuthed;
use axum::{
    Router,
    extract::{Path, Query, State},
    http::{
        HeaderValue, StatusCode,
        header::{CACHE_CONTROL, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS},
    },
    response::{IntoResponse, Response},
    routing::get,
};
use fliks_domain::{
    media::kind::MediaKind,
    opds::{ACQ_TYPE, Entry, Feed, Link, NAV_TYPE, opensearch, render},
};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use std::collections::HashMap;

const PAGE: i64 = 50;
const ROOT: &str = "/api/opds";
const SEARCH_TEMPLATE: &str = "/api/opds/search?q={searchTerms}";
const OPENSEARCH: &str = "application/opensearchdescription+xml";

pub fn router() -> Router<AppState> {
    Router::new()
        .route(ROOT, get(root))
        .route("/api/opds/libraries/{id}", get(library))
        .route("/api/opds/recent", get(recent))
        .route("/api/opds/authors", get(authors))
        .route("/api/opds/authors/{id}", get(author))
        .route("/api/opds/series", get(series_list))
        .route("/api/opds/series/{id}", get(series_one))
        .route("/api/opds/search", get(search))
        .route("/api/opds/opensearch.xml", get(opensearch_description))
}

type Params = Query<HashMap<String, String>>;

fn page_of(q: &HashMap<String, String>) -> Result<i64, AppError> {
    let bad = || AppError::bad_request("page must not be less than 1");
    match q.get("page") {
        None => Ok(1),
        Some(p) => p
            .parse::<i64>()
            .ok()
            .filter(|n| (1..=1_000_000).contains(n))
            .ok_or_else(bad),
    }
}

fn missing(what: &str, id: i32) -> AppError {
    AppError::not_found(format!("{what} #{id} not found"))
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

fn xml(kind: &str, body: String) -> Response {
    (
        StatusCode::OK,
        [
            (
                CONTENT_TYPE,
                HeaderValue::from_str(&format!("{kind}; charset=utf-8")).expect("ascii"),
            ),
            (CACHE_CONTROL, HeaderValue::from_static("private, no-cache")),
            (X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        ],
        body,
    )
        .into_response()
}

/// `self`, `start`, `up`, `search` and the paging links of a feed at `href`.
fn links(href: &str, up: Option<&str>, kind: &str, page: i64, has_next: bool) -> Vec<Link> {
    let at = |n: i64| {
        let sep = if href.contains('?') { '&' } else { '?' };
        if n == 1 && page == 1 {
            href.to_owned()
        } else {
            format!("{href}{sep}page={n}")
        }
    };
    let mut l = vec![
        Link::new("self", at(page), kind),
        Link::new("start", ROOT, NAV_TYPE),
    ];
    if let Some(u) = up {
        l.push(Link::new("up", u, NAV_TYPE));
    }
    l.push(Link::new("search", "/api/opds/opensearch.xml", OPENSEARCH));
    l.push(Link::new("search", SEARCH_TEMPLATE, ACQ_TYPE));
    if page > 1 {
        l.push(Link::new("previous", at(page - 1), kind));
    }
    if has_next {
        l.push(Link::new("next", at(page + 1), kind));
    }
    l
}

fn nav_entry(id: String, title: &str, content: Option<String>, href: String) -> Entry {
    Entry {
        id,
        title: title.to_owned(),
        updated: now(),
        content: content.or_else(|| Some(title.to_owned())),
        links: vec![Link::new("subsection", href, ACQ_TYPE)],
        ..Entry::default()
    }
}

/// The readable libraries that hold books, by name.
async fn book_libraries(db: &sqlx::PgPool, acl: &[i32]) -> Result<Vec<(i32, String)>, sqlx::Error> {
    sqlx::query_as(
        r#"SELECT id, name FROM libraries WHERE id = ANY($1) AND "mediaTypes" ? 'book'
           ORDER BY name COLLATE "C", id"#,
    )
    .bind(acl)
    .fetch_all(db)
    .await
}

fn count(n: i64) -> String {
    format!("{n} book{}", if n == 1 { "" } else { "s" })
}

/// An acquisition feed of `ids` (in order), re-read through the ACL by `entries::read`.
#[allow(clippy::too_many_arguments)]
async fn acquisition(
    st: &AppState,
    acl: &[i32],
    ids: &[i32],
    id: String,
    title: String,
    href: &str,
    up: &str,
    page: i64,
    has_next: bool,
) -> Result<Response, AppError> {
    let feed = Feed {
        id,
        title,
        updated: now(),
        links: links(href, Some(up), ACQ_TYPE, page, has_next),
        entries: entries::read(&st.db, ids, acl).await?,
    };
    Ok(xml(ACQ_TYPE, render(&feed)))
}

fn book_search(page: i64) -> Search {
    Search {
        media_type: Some(MediaKind::Book),
        page: Some(page as f64),
        limit: Some(PAGE as f64),
        ..Search::default()
    }
}

async fn listed(
    st: &AppState,
    uid: i32,
    s: &Search,
    acl: &[i32],
) -> Result<(Vec<i32>, i64), AppError> {
    Ok(find_ids(&st.db, s, acl, uid).await?)
}

#[utoipa::path(get, path = "/api/opds", responses((status = 200)))]
pub async fn root(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
) -> Result<Response, AppError> {
    let acl = accessible_library_ids(&st.db, &a).await?;
    let mut entries: Vec<Entry> = book_libraries(&st.db, &acl)
        .await?
        .into_iter()
        .map(|(id, name)| {
            nav_entry(
                format!("urn:fliks:opds:libraries:{id}"),
                &name,
                None,
                format!("/api/opds/libraries/{id}"),
            )
        })
        .collect();
    let fixed = [
        ("recent", "Recently added", "recent", ACQ_TYPE),
        ("authors", "Authors", "authors", NAV_TYPE),
        ("series", "Series", "series", NAV_TYPE),
    ];
    for (id, title, path, kind) in fixed {
        let mut e = nav_entry(
            format!("urn:fliks:opds:{id}"),
            title,
            None,
            format!("/api/opds/{path}"),
        );
        e.links[0].kind = Some(kind.to_owned());
        entries.push(e);
    }
    let feed = Feed {
        id: "urn:fliks:opds:root".into(),
        title: "Fliks".into(),
        updated: now(),
        links: links(ROOT, None, NAV_TYPE, 1, false),
        entries,
    };
    Ok(xml(NAV_TYPE, render(&feed)))
}

#[utoipa::path(get, path = "/api/opds/libraries/{id}", responses((status = 200)))]
pub async fn library(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    Path(id): Path<i32>,
    Query(q): Params,
) -> Result<Response, AppError> {
    let page = page_of(&q)?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let lib = book_libraries(&st.db, &acl)
        .await?
        .into_iter()
        .find(|l| l.0 == id)
        .ok_or_else(|| missing("Library", id))?;
    let s = Search {
        library_id: Some(id),
        ..book_search(page)
    };
    let (ids, total) = listed(&st, a.user.id, &s, &acl).await?;
    let href = format!("/api/opds/libraries/{id}");
    acquisition(
        &st,
        &acl,
        &ids,
        format!("urn:fliks:opds:libraries:{id}"),
        lib.1,
        &href,
        ROOT,
        page,
        total > page * PAGE,
    )
    .await
}

#[utoipa::path(get, path = "/api/opds/recent", responses((status = 200)))]
pub async fn recent(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    Query(q): Params,
) -> Result<Response, AppError> {
    let page = page_of(&q)?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let s = Search {
        sort_by: Some("createdAt".into()),
        sort_order: Some("DESC".into()),
        ..book_search(page)
    };
    let (ids, total) = listed(&st, a.user.id, &s, &acl).await?;
    acquisition(
        &st,
        &acl,
        &ids,
        "urn:fliks:opds:recent".into(),
        "Recently added".into(),
        "/api/opds/recent",
        ROOT,
        page,
        total > page * PAGE,
    )
    .await
}

#[utoipa::path(get, path = "/api/opds/authors", responses((status = 200)))]
pub async fn authors(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    Query(q): Params,
) -> Result<Response, AppError> {
    let page = page_of(&q)?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let rows = persons::people(
        &st.db,
        "author",
        &acl,
        &acl,
        None,
        false,
        Some((PAGE + 1, (page - 1) * PAGE)),
    )
    .await?;
    let has_next = rows.len() as i64 > PAGE;
    let entries = rows
        .iter()
        .take(PAGE as usize)
        .filter_map(|r| {
            let id = r["id"].as_i64()?;
            Some(nav_entry(
                format!("urn:fliks:opds:authors:{id}"),
                r["name"].as_str()?,
                r["workCount"].as_i64().map(count),
                format!("/api/opds/authors/{id}"),
            ))
        })
        .collect();
    let feed = Feed {
        id: "urn:fliks:opds:authors".into(),
        title: "Authors".into(),
        updated: now(),
        links: links("/api/opds/authors", Some(ROOT), NAV_TYPE, page, has_next),
        entries,
    };
    Ok(xml(NAV_TYPE, render(&feed)))
}

#[utoipa::path(get, path = "/api/opds/authors/{id}", responses((status = 200)))]
pub async fn author(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    Path(id): Path<i32>,
    Query(q): Params,
) -> Result<Response, AppError> {
    let page = page_of(&q)?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let s = Search {
        author_id: Some(id),
        ..book_search(page)
    };
    let (ids, total) = listed(&st, a.user.id, &s, &acl).await?;
    if total == 0 {
        return Err(missing("Author", id));
    }
    let name = persons::find(&st.db, id).await?.name;
    let href = format!("/api/opds/authors/{id}");
    acquisition(
        &st,
        &acl,
        &ids,
        format!("urn:fliks:opds:authors:{id}"),
        name,
        &href,
        "/api/opds/authors",
        page,
        total > page * PAGE,
    )
    .await
}

#[utoipa::path(get, path = "/api/opds/series", responses((status = 200)))]
pub async fn series_list(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    Query(q): Params,
) -> Result<Response, AppError> {
    let page = page_of(&q)?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let rows = series::list(
        &st.db,
        &acl,
        Some(MediaKind::Book),
        None,
        Some((PAGE + 1, (page - 1) * PAGE)),
    )
    .await?;
    let has_next = rows.len() as i64 > PAGE;
    let entries = rows
        .iter()
        .take(PAGE as usize)
        .filter_map(|r| {
            let id = r["id"].as_i64()?;
            Some(nav_entry(
                format!("urn:fliks:opds:series:{id}"),
                r["name"].as_str()?,
                r["count"].as_i64().map(count),
                format!("/api/opds/series/{id}"),
            ))
        })
        .collect();
    let feed = Feed {
        id: "urn:fliks:opds:series".into(),
        title: "Series".into(),
        updated: now(),
        links: links("/api/opds/series", Some(ROOT), NAV_TYPE, page, has_next),
        entries,
    };
    Ok(xml(NAV_TYPE, render(&feed)))
}

#[utoipa::path(get, path = "/api/opds/series/{id}", responses((status = 200)))]
pub async fn series_one(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    Path(id): Path<i32>,
    Query(q): Params,
) -> Result<Response, AppError> {
    let page = page_of(&q)?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let d = series::detail(&st.db, id, a.user.id, &acl)
        .await?
        .ok_or_else(|| missing("Series", id))?;
    let all: Vec<i32> = d["entries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|e| e["media"]["type"] == MediaKind::Book.as_str())
        .filter_map(|e| e["media"]["id"].as_i64())
        .map(|n| n as i32)
        .collect();
    if all.is_empty() {
        return Err(missing("Series", id));
    }
    let from = ((page - 1) * PAGE) as usize;
    let ids: Vec<i32> = all.iter().copied().skip(from).take(PAGE as usize).collect();
    let name = d["name"].as_str().unwrap_or_default().to_owned();
    let href = format!("/api/opds/series/{id}");
    acquisition(
        &st,
        &acl,
        &ids,
        format!("urn:fliks:opds:series:{id}"),
        name,
        &href,
        "/api/opds/series",
        page,
        all.len() as i64 > page * PAGE,
    )
    .await
}

#[utoipa::path(get, path = "/api/opds/search", responses((status = 200)))]
pub async fn search(
    State(st): State<AppState>,
    OpdsAuthed(a): OpdsAuthed,
    Query(q): Params,
) -> Result<Response, AppError> {
    let page = page_of(&q)?;
    let acl = accessible_library_ids(&st.db, &a).await?;
    let term: String = q
        .get("q")
        .map(|t| t.trim().chars().take(200).collect())
        .unwrap_or_default();
    let (ids, total) = if term.is_empty() {
        (vec![], 0)
    } else {
        let s = Search {
            q: Some(term.clone()),
            ..book_search(page)
        };
        listed(&st, a.user.id, &s, &acl).await?
    };
    let href = format!(
        "/api/opds/search?q={}",
        utf8_percent_encode(&term, NON_ALPHANUMERIC)
    );
    acquisition(
        &st,
        &acl,
        &ids,
        "urn:fliks:opds:search".into(),
        format!("Search: {term}"),
        &href,
        ROOT,
        page,
        total > page * PAGE,
    )
    .await
}

#[utoipa::path(get, path = "/api/opds/opensearch.xml", responses((status = 200)))]
pub async fn opensearch_description(OpdsAuthed(_): OpdsAuthed) -> Response {
    xml(OPENSEARCH, opensearch(SEARCH_TEMPLATE))
}

//! Book search, preview and sources routes (`docs/spec/book-metadata.md` rules 18-25).
use super::{
    ANCHOR,
    identify::BookMatch,
    link::{attach, stored},
    merge, people, text, work_id,
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::{accessible_library_ids, assert_media_accessible},
    media::{
        external_ids::{self, EDITION_NAMESPACES, edition_id},
        write::body::Body,
    },
    metadata::{
        MetaError, Metadata,
        routes::{Ids, Pairs, Res, bare, fail, lang, unavailable},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use fliks_domain::{
    acl::{Action, Subject},
    external_id::Namespace,
    media::{AUDIO_EXTS, kind::MediaKind},
    metadata::limiter::Priority,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;

const GO: Priority = Priority::Interactive;

pub fn routes(r: Router<AppState>) -> Router<AppState> {
    r.route("/api/metadata/search/book", get(search_book))
        .route(
            "/api/metadata/{provider}/book/{externalId}",
            get(preview_book),
        )
        .route(
            "/api/media/{id}/sources",
            get(sources_get).put(sources_put).delete(sources_delete),
        )
}

fn meta_fail(p: Namespace, e: MetaError) -> AppError {
    match e {
        MetaError::Upstream(e) => fail(p, &e, true),
        MetaError::Db(e) => e.into(),
    }
}

pub(crate) fn unknown_provider(name: &str) -> AppError {
    AppError::bad_request(format!("Unknown provider: {name}"))
}

/// A registered provider that supports books.
fn book_provider(md: &Metadata, name: &str) -> Result<Namespace, AppError> {
    Namespace::parse(name)
        .filter(|p| md.get(*p).is_some_and(|x| x.supports(MediaKind::Book)))
        .ok_or_else(|| unknown_provider(name))
}

pub(crate) fn page(q: &[(String, String)]) -> Result<u32, AppError> {
    let Some(raw) = bare(q, "page").filter(|p| !p.is_empty()) else {
        return Ok(1);
    };
    let n = fliks_domain::media::query::js_number(&raw)
        .filter(|n| n.fract() == 0.0 && n.is_finite())
        .ok_or_else(|| AppError::bad_request("page must be an integer number"))?;
    if n < 1.0 {
        return Err(AppError::bad_request("page must not be less than 1"));
    }
    Ok(n.min(f64::from(u32::MAX)) as u32)
}

/// The namespace a provider names its ids in when they name an edition (`asin` for Audible).
fn namespace(p: Namespace) -> &'static str {
    match p {
        Namespace::AUDIBLE => Namespace::ASIN.as_str(),
        p => p.as_str(),
    }
}

/// The first series entry of a record as `{name, position}`.
fn first_series(r: &Map<String, Value>) -> Value {
    let Some(Value::Object(s)) = r.get("series").and_then(|a| a.as_array()?.first()) else {
        return Value::Null;
    };
    let Some(name) = text(s, "name") else {
        return Value::Null;
    };
    let position = match s.get("position") {
        Some(Value::String(p)) if !p.trim().is_empty() => json!(p.trim()),
        Some(Value::Number(n)) => json!(n.to_string()),
        _ => Value::Null,
    };
    json!({"name": name, "position": position})
}

fn names(r: &Map<String, Value>, key: &str) -> Vec<String> {
    people(r, key).into_iter().map(|(n, _)| n).collect()
}

fn count(r: &Map<String, Value>, key: &str) -> Value {
    r.get(key)
        .and_then(Value::as_i64)
        .filter(|n| *n > 0)
        .map_or(Value::Null, Value::from)
}

fn opt(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::from)
}

/// A `BookSearchResult` without its `mediaId`; `None` for a hit with no id or title.
fn hit(p: Namespace, v: &Value) -> Option<Value> {
    let r = v.as_object()?;
    Some(json!({
        "provider": p.as_str(),
        "externalId": text(r, "externalId")?,
        "kind": "book",
        "title": text(r, "title")?,
        "subtitle": opt(text(r, "subtitle")),
        "authors": names(r, "authors"),
        "year": r.get("year").and_then(Value::as_i64).map_or(Value::Null, Value::from),
        "coverUrl": opt(text(r, "posterUrl")),
        "series": first_series(r),
        "editionCount": count(r, "editionCount"),
        "mediaId": Value::Null,
    }))
}

/// Sets `mediaId` of each result: the lowest readable book holding its id (rule 19).
async fn with_media_ids(db: &PgPool, acl: &[i32], hits: &mut [Value]) -> Result<(), sqlx::Error> {
    let key = |h: &Value| {
        let p = h["provider"].as_str().and_then(Namespace::parse);
        (
            p.map_or("", namespace).to_owned(),
            h["externalId"].as_str().unwrap_or_default().to_owned(),
        )
    };
    let (ns, ids): (Vec<_>, Vec<_>) = hits.iter().map(key).unzip();
    let rows = sqlx::query!(
        r#"SELECT q.i::int AS "i!", min(m.id) AS media
           FROM UNNEST($1::text[], $2::text[]) WITH ORDINALITY AS q(p, v, i)
           JOIN media m ON m.type = 'book' AND m."libraryId" = ANY($3)
           WHERE EXISTS (SELECT 1 FROM media_external_ids w WHERE w."mediaId" = m.id AND w.kind = 'book'
                           AND w.provider = q.p AND w.value = q.v)
              OR EXISTS (SELECT 1 FROM edition_external_ids x JOIN editions e ON e.id = x."editionId"
                         WHERE x."mediaId" = m.id AND x.provider = q.p AND x.value = q.v
                           AND COALESCE(e."libraryId", m."libraryId") = ANY($3))
           GROUP BY q.i"#,
        &ns,
        &ids,
        acl
    )
    .fetch_all(db)
    .await?;
    for r in rows {
        if let (Some(h), Some(m)) = (hits.get_mut(r.i as usize - 1), r.media) {
            h["mediaId"] = m.into();
        }
    }
    Ok(())
}

/// `GET /api/metadata/search/book` (rules 18-19).
#[utoipa::path(get, path = "/api/metadata/search/book", responses((status = 200)))]
pub async fn search_book(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    let field = |k: &str| {
        bare(&q, k)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let (title, author, isbn) = (field("title"), field("author"), field("isbn"));
    let query = field("q")
        .or_else(|| {
            let t = [title.as_deref(), author.as_deref()].iter().flatten().fold(
                String::new(),
                |acc, s| {
                    if acc.is_empty() {
                        (*s).into()
                    } else {
                        format!("{acc} {s}")
                    }
                },
            );
            (!t.is_empty()).then_some(t)
        })
        .or_else(|| isbn.clone());
    let page = page(&q)?;
    let named = field("provider")
        .map(|p| book_provider(&st.metadata, &p))
        .transpose()?;
    let Some(query) = query else {
        return Ok(Json(json!([])));
    };
    let mut order = merge::providers(&st.metadata);
    if let Some(p) = named.filter(|p| st.metadata.available(*p)) {
        order.retain(|o| *o != p);
        order.insert(0, p);
    }
    let language = field("language");
    let search = crate::metadata::Search {
        kind: MediaKind::Book,
        query: &query,
        year: None,
        title: title.as_deref(),
        author: author.as_deref(),
        author_id: None,
        isbn: isbn.as_deref(),
        language: language.as_deref(),
        page,
    };
    let lang = lang(&st).await?;
    let (mut found, mut answered, mut failed) = (None, false, None);
    for p in order {
        let provider = st.metadata.of(p);
        if !provider.has_search(MediaKind::Book) {
            continue;
        }
        match provider.search(&search, &lang, GO).await {
            Ok(r) if r.is_empty() => answered = true,
            Ok(r) => {
                found = Some((p, r));
                break;
            }
            Err(e) => {
                tracing::warn!("{p} book search skipped: {e}");
                failed = Some((p, e));
            }
        }
    }
    let mut hits: Vec<Value> = match found {
        Some((p, r)) => r.iter().filter_map(|v| hit(p, v)).collect(),
        None if answered => vec![],
        None => {
            return Err(match failed {
                Some((p, e)) => unavailable("search", p, &e),
                None => AppError::with_message(
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "No book metadata provider is available",
                ),
            });
        }
    };
    let acl = accessible_library_ids(&st.db, &a).await?;
    with_media_ids(&st.db, &acl, &mut hits).await?;
    Ok(Json(Value::Array(hits)))
}

fn edition_entry(p: Namespace, r: &Value) -> Option<Value> {
    let r = r.as_object()?;
    let duration = r
        .get("durationSeconds")
        .and_then(Value::as_i64)
        .filter(|n| *n > 0);
    let format = text(r, "format").map(|f| f.to_lowercase());
    let audio = duration.is_some()
        || format
            .as_deref()
            .is_some_and(|f| AUDIO_EXTS.iter().any(|e| e[1..] == *f));
    let isbns = match r.get("isbn13") {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => vec![],
    };
    Some(json!({
        "provider": p.as_str(),
        "externalId": text(r, "externalId")?,
        "family": if audio { "audio" } else { "text" },
        "format": opt(format),
        "language": opt(text(r, "language")),
        "title": opt(text(r, "title")),
        "publisher": opt(text(r, "publisher")),
        "published": opt(text(r, "releaseDate")),
        "isbn13": isbns,
        "asin": opt(text(r, "asin")),
        "coverUrl": opt(text(r, "posterUrl")),
        "narrators": names(r, "narrators"),
        "durationSeconds": duration.map_or(Value::Null, Value::from),
        "pageCount": count(r, "pageCount"),
    }))
}

/// `GET /api/metadata/{provider}/book/{externalId}` (rule 20).
#[utoipa::path(get, path = "/api/metadata/{provider}/book/{externalId}", responses((status = 200)))]
pub async fn preview_book(State(st): State<AppState>, a: Authed, ids: Ids) -> Res {
    let PathParams((name, id)) = ids?;
    if Namespace::parse(&name) != Some(ANCHOR) || st.metadata.get(ANCHOR).is_none() {
        return Err(unknown_provider(&name));
    }
    let work = work_id(&id)
        .ok_or_else(|| AppError::bad_request("externalId must be an Open Library work id"))?;
    let lang = lang(&st).await?;
    let md = &st.metadata;
    let Value::Object(record) = md
        .work(ANCHOR, MediaKind::Book, &work, &lang, GO)
        .await
        .map_err(|e| meta_fail(ANCHOR, e))?
    else {
        return Err(unavailable(
            "request",
            ANCHOR,
            &crate::metadata::Upstream::new(None, "unexpected work record"),
        ));
    };
    let children = md
        .children(ANCHOR, MediaKind::Book, &work, &lang, GO)
        .await
        .map_err(|e| meta_fail(ANCHOR, e))?;
    let editions: Vec<Value> = children
        .iter()
        .filter_map(|c| edition_entry(ANCHOR, c))
        .collect();
    let mut head = record.clone();
    head.insert("externalId".into(), work.clone().into());
    let mut out = hit(ANCHOR, &Value::Object(head)).ok_or_else(|| {
        unavailable(
            "request",
            ANCHOR,
            &crate::metadata::Upstream::new(None, "the work has no title"),
        )
    })?;
    out["editionCount"] = i64::try_from(editions.len())
        .ok()
        .filter(|n| *n > 0)
        .map_or(out["editionCount"].take(), Value::from);
    out["description"] = opt(text(&record, "overview"));
    out["subjects"] = match record.get("subjects") {
        Some(Value::Array(s)) => s.iter().filter(|v| v.is_string()).cloned().collect(),
        _ => vec![],
    }
    .into();
    out["published"] = opt(text(&record, "releaseDate"));
    out["language"] = opt(text(&record, "language"));
    out["editions"] = editions.into();
    out["unofficial"] = false.into();
    let acl = accessible_library_ids(&st.db, &a).await?;
    let mut one = [out];
    with_media_ids(&st.db, &acl, &mut one).await?;
    let [out] = one;
    Ok(Json(out))
}

struct Gate {
    media: i32,
    acl: Vec<i32>,
}

async fn gate(
    st: &AppState,
    a: &Authed,
    action: Action,
    id: Result<PathParams<i32>, AppError>,
) -> Result<Gate, AppError> {
    a.require(action, Subject::Media)?;
    let PathParams(media) = id?;
    let acl = accessible_library_ids(&st.db, a).await?;
    assert_media_accessible(&st.db, media, &acl).await?;
    let kind = sqlx::query_scalar!("SELECT type FROM media WHERE id = $1", media)
        .fetch_one(&st.db)
        .await?;
    if MediaKind::parse(&kind) != Some(MediaKind::Book) {
        return Err(AppError::bad_request(format!(
            "Media #{media} is not a book"
        )));
    }
    Ok(Gate { media, acl })
}

/// `BookSources` of a media (rule 22).
async fn sources(db: &PgPool, g: &Gate) -> Result<Value, sqlx::Error> {
    let work = sqlx::query_scalar!(
        r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = $2"#,
        g.media,
        ANCHOR.as_str()
    )
    .fetch_optional(db)
    .await?;
    let editions = sqlx::query!(
        r#"SELECT e.id,
             COALESCE(jsonb_agg(jsonb_build_object('provider', x.provider, 'value', x.value)
               ORDER BY x.provider, x.value) FILTER (WHERE x.provider IS NOT NULL), '[]'::jsonb) AS "ids!: Value"
           FROM editions e JOIN media m ON m.id = e."mediaId"
           LEFT JOIN edition_external_ids x ON x."editionId" = e.id
           WHERE e."mediaId" = $1 AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
           GROUP BY e.id
           ORDER BY CASE e.family WHEN 'text' THEN 0 ELSE 1 END, e.id"#,
        g.media,
        &g.acl
    )
    .fetch_all(db)
    .await?;
    Ok(json!({
        "work": work.map(|v| json!({"provider": ANCHOR.as_str(), "value": v})),
        "editions": editions.into_iter().map(|r| json!({"editionId": r.id, "ids": r.ids})).collect::<Vec<_>>(),
    }))
}

/// `GET /api/media/{id}/sources` (rule 22).
#[utoipa::path(get, path = "/api/media/{id}/sources", responses((status = 200)))]
pub async fn sources_get(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    let g = gate(&st, &a, Action::Read, id).await?;
    Ok(Json(sources(&st.db, &g).await?))
}

enum Level {
    Work,
    Edition(i32),
}

/// The level, provider and normalised value of a PUT body or DELETE query (rules 23-25).
fn parse(b: &Body) -> Result<(Level, Namespace, String), AppError> {
    let bad = |m: String| AppError::bad_request(vec![m]);
    let level = b.required(
        b.one_of("level", &["work", "edition"])?,
        "level",
        "must be one of the following values: work, edition",
    )?;
    let edition = b.id("editionId")?.flatten();
    let provider = b.required(b.str("provider")?, "provider", "must be a string")?;
    let value = b.required(b.str("value")?, "value", "must be a string")?;
    if level == "work" {
        if edition.is_some() {
            return Err(bad("editionId is only valid with level=edition".into()));
        }
        if provider != ANCHOR.as_str() {
            return Err(bad(format!(
                "provider must be one of the following values: {}",
                ANCHOR.as_str()
            )));
        }
        let work =
            work_id(&value).ok_or_else(|| bad("value must be an Open Library work id".into()))?;
        return Ok((Level::Work, ANCHOR, work));
    }
    let edition = edition.ok_or_else(|| bad("editionId must be an integer number".into()))?;
    let allowed = EDITION_NAMESPACES.map(Namespace::as_str).join(", ");
    let provider = Namespace::parse(&provider)
        .filter(|p| EDITION_NAMESPACES.contains(p))
        .ok_or_else(|| {
            bad(format!(
                "provider must be one of the following values: {allowed}"
            ))
        })?;
    let value = edition_id(provider, &value)
        .ok_or_else(|| bad(format!("value is not a {provider} edition id")))?;
    Ok((Level::Edition(edition), provider, value))
}

/// 404 `Edition #<id> not found` unless the caller can read an edition of the media.
async fn visible_edition(db: &PgPool, g: &Gate, edition: i32) -> Result<(), AppError> {
    let found = sqlx::query_scalar!(
        r#"SELECT e.id FROM editions e JOIN media m ON m.id = e."mediaId"
           WHERE e.id = $1 AND e."mediaId" = $2 AND COALESCE(e."libraryId", m."libraryId") = ANY($3)"#,
        edition,
        g.media,
        &g.acl
    )
    .fetch_optional(db)
    .await?;
    found
        .map(|_| ())
        .ok_or_else(|| AppError::not_found(format!("Edition #{edition} not found")))
}

fn taken() -> AppError {
    AppError::conflict("taken")
}

/// `PUT /api/media/{id}/sources` (rules 23-24).
#[utoipa::path(put, path = "/api/media/{id}/sources", responses((status = 200)))]
pub async fn sources_put(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Res {
    let g = gate(&st, &a, Action::Update, id).await?;
    let b = Body::new(v, &["level", "editionId", "provider", "value"])?;
    let (level, provider, value) = parse(&b)?;
    match level {
        Level::Work => {
            if external_ids::find(&st.db, MediaKind::Book, ANCHOR, &value)
                .await?
                .is_some_and(|m| m != g.media)
            {
                return Err(taken());
            }
            let m = BookMatch {
                work: value.clone(),
                edition: vec![],
                confidence: 100,
            };
            attach(&st, g.media, None, &m, GO)
                .await
                .map_err(|e| meta_fail(ANCHOR, e))?;
            let linked = stored(&st.db, g.media, None).await?.map(|m| m.work);
            if linked.as_deref() != Some(&value) {
                return Err(taken());
            }
        }
        Level::Edition(edition) => {
            visible_edition(&st.db, &g, edition).await?;
            put_edition(&st, &g, edition, provider, value).await?;
        }
    }
    Ok(Json(sources(&st.db, &g).await?))
}

async fn put_edition(
    st: &AppState,
    g: &Gate,
    edition: i32,
    provider: Namespace,
    value: String,
) -> Result<(), AppError> {
    let replace = provider != Namespace::ISBN;
    let Some(mut m) = stored(&st.db, g.media, Some(edition)).await? else {
        let mut tx = st.db.begin().await?;
        if replace {
            external_ids::unlink_edition(&mut tx, edition, provider, None).await?;
        }
        external_ids::link_edition(&mut tx, edition, g.media, provider, &value).await?;
        tx.commit().await?;
        return Ok(());
    };
    let replaced: Vec<String> = m
        .edition
        .iter()
        .filter(|(p, v)| replace && *p == provider && *v != value)
        .map(|(_, v)| v.clone())
        .collect();
    m.edition.retain(|(p, _)| !(replace && *p == provider));
    m.edition.push((provider, value));
    attach(st, g.media, Some(edition), &m, GO)
        .await
        .map_err(|e| meta_fail(ANCHOR, e))?;
    let mut tx = st.db.begin().await?;
    for old in replaced {
        external_ids::unlink_edition(&mut tx, edition, provider, Some(&old)).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// `DELETE /api/media/{id}/sources` (rule 25).
#[utoipa::path(delete, path = "/api/media/{id}/sources", responses((status = 200)))]
pub async fn sources_delete(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    Query(q): Pairs,
) -> Res {
    let g = gate(&st, &a, Action::Update, id).await?;
    let map = q
        .into_iter()
        .map(|(k, v)| (k, Value::String(v)))
        .collect::<Map<_, _>>();
    let b = Body::new(
        Value::Object(map),
        &["level", "editionId", "provider", "value"],
    )?;
    let (level, provider, value) = parse(&b)?;
    let mut c = st.db.acquire().await?;
    match level {
        Level::Work => {
            let linked = stored(&st.db, g.media, None).await?.map(|m| m.work);
            if linked.as_deref() == Some(&value) {
                external_ids::unlink(&mut c, g.media, ANCHOR).await?;
            }
        }
        Level::Edition(edition) => {
            visible_edition(&st.db, &g, edition).await?;
            external_ids::unlink_edition(&mut c, edition, provider, Some(&value)).await?;
        }
    }
    Ok(Json(sources(&st.db, &g).await?))
}

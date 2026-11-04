//! `GET /api/metadata/search/{movie|tv|book|comic}`: one provider walk and one hit shape
//! (`docs/spec/metadata.md` rules 6-12).
use super::{
    Search,
    books::routes::{self as book_hits, unknown_provider},
    comics::routes as comic_hits,
    routes::{Pairs, Res, bare, lang, stamp, unavailable, year},
};
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
};
use fliks_domain::{
    external_id::Namespace,
    media::{
        kind::MediaKind,
        query::{js_number, js_parse_int},
    },
    metadata::limiter::Priority,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;

/// The kind a search segment names.
pub(crate) fn segment_kind(seg: &str) -> Option<MediaKind> {
    match seg {
        "movie" => Some(MediaKind::Movie),
        "tv" => Some(MediaKind::Series),
        "book" => Some(MediaKind::Book),
        "comic" => Some(MediaKind::Comic),
        _ => None,
    }
}

/// `page`: an integer of at least 1, default 1.
fn page(q: &[(String, String)]) -> Result<u32, AppError> {
    let Some(raw) = bare(q, "page").filter(|p| !p.is_empty()) else {
        return Ok(1);
    };
    let n = js_number(&raw)
        .filter(|n| n.fract() == 0.0 && n.is_finite())
        .ok_or_else(|| AppError::bad_request("page must be an integer number"))?;
    if n < 1.0 {
        return Err(AppError::bad_request("page must not be less than 1"));
    }
    Ok(n.min(f64::from(u32::MAX)) as u32)
}

/// Media override, then library, else no preference; a bad id is no preference.
async fn preferred(db: &PgPool, media_id: Option<&str>) -> Result<Option<String>, sqlx::Error> {
    let Some(id) = media_id
        .and_then(js_parse_int)
        .and_then(|n| i32::try_from(n).ok())
        .filter(|n| *n >= 1)
    else {
        return Ok(None);
    };
    let row = sqlx::query!(
        r#"SELECT m."preferredProvider" AS media_pref, l."preferredProvider" AS library_pref
           FROM media m LEFT JOIN libraries l ON l.id = m."libraryId" WHERE m.id = $1"#,
        id
    )
    .fetch_optional(db)
    .await?;
    Ok(row.and_then(|r| r.media_pref.or(r.library_pref)))
}

/// The hit core every kind answers; `existingMediaId` is filled by `mark_existing`.
pub(crate) fn hit_core(
    provider: Namespace,
    external_id: &str,
    kind: MediaKind,
    title: &str,
    year: Option<i64>,
    poster: Option<&str>,
) -> Map<String, Value> {
    let Value::Object(o) = json!({
        "provider": provider.as_str(), "externalId": external_id, "mediaType": kind.as_str(),
        "title": title, "year": year, "posterUrl": poster, "existingMediaId": null,
    }) else {
        unreachable!()
    };
    o
}

/// A video record as a hit: the provider's own fields, the core filled in and `externalId` normalised;
/// `None` for a record that names no id of a namespace.
fn video_hit(mut r: Value) -> Option<Value> {
    let ns = Namespace::parse(r["provider"].as_str()?)?;
    let id = ns.normalize(r["externalId"].as_str()?.trim())?;
    let o = r.as_object_mut()?;
    o.insert("externalId".into(), id.into());
    for k in ["title", "year", "posterUrl"] {
        o.entry(k).or_insert(Value::Null);
    }
    o.entry("existingMediaId").or_insert(Value::Null);
    Some(r)
}

pub(crate) fn hit(kind: MediaKind, ns: Namespace, v: &Value) -> Option<Value> {
    match kind {
        MediaKind::Book => book_hits::hit(ns, v),
        MediaKind::Comic => comic_hits::hit(ns, v),
        MediaKind::Movie | MediaKind::Series => {
            let mut one = [v.clone()];
            stamp(&mut one, ns, kind);
            let [r] = one;
            video_hit(r)
        }
    }
}

/// The ids a hit is held under, most specific first: a video hit also names its TMDB and TVDB ids.
fn candidates(kind: MediaKind, h: &Value) -> Vec<(String, String)> {
    let numeric = |k: &str, ns: Namespace| {
        let n = h
            .get(k)?
            .as_i64()
            .filter(|n| *n > 0 && i32::try_from(*n).is_ok())?;
        Some((ns.as_str().to_owned(), n.to_string()))
    };
    let named = h["provider"]
        .as_str()
        .zip(h["externalId"].as_str())
        .map(|(p, e)| (p.to_owned(), e.to_owned()));
    match kind {
        MediaKind::Movie | MediaKind::Series => [
            numeric("tmdbId", Namespace::TMDB),
            numeric("tvdbId", Namespace::TVDB),
            named,
        ]
        .into_iter()
        .flatten()
        .collect(),
        _ => named.into_iter().collect(),
    }
}

/// Sets `existingMediaId` and `existingMediaType` of each hit: the lowest media of `kind` in a library
/// the caller can read that holds one of its ids (a book's edition ids count, through a readable edition).
pub(crate) async fn mark_existing(
    db: &PgPool,
    a: &Authed,
    kind: MediaKind,
    hits: &mut [Value],
) -> Result<(), AppError> {
    let refs: Vec<Vec<(String, String)>> = hits.iter().map(|h| candidates(kind, h)).collect();
    let (ps, vs): (Vec<&str>, Vec<&str>) = refs
        .iter()
        .flatten()
        .map(|(p, v)| (p.as_str(), v.as_str()))
        .unzip();
    let mut held: Vec<(i32, String, String)> = vec![];
    if !ps.is_empty() {
        let libs = accessible_library_ids(db, a).await?;
        held = sqlx::query_as(
            r#"SELECT min(m.id), e.provider, e.value FROM media m
               JOIN media_external_ids e ON e."mediaId" = m.id AND e.kind = m.type
               WHERE m.type = $1 AND m."libraryId" = ANY($2)
                 AND (e.provider, e.value) IN (SELECT * FROM unnest($3::text[], $4::text[]))
               GROUP BY e.provider, e.value"#,
        )
        .bind(kind.as_str())
        .bind(&libs)
        .bind(&ps)
        .bind(&vs)
        .fetch_all(db)
        .await?;
        if kind == MediaKind::Book {
            held.extend(
                sqlx::query_as::<_, (i32, String, String)>(
                    r#"SELECT min(m.id), x.provider, x.value FROM edition_external_ids x
                       JOIN editions e ON e.id = x."editionId"
                       JOIN media m ON m.id = x."mediaId" AND m.type = 'book'
                       WHERE m."libraryId" = ANY($1) AND COALESCE(e."libraryId", m."libraryId") = ANY($1)
                         AND (x.provider, x.value) IN (SELECT * FROM unnest($2::text[], $3::text[]))
                       GROUP BY x.provider, x.value"#,
                )
                .bind(&libs)
                .bind(&ps)
                .bind(&vs)
                .fetch_all(db)
                .await?,
            );
        }
    }
    for (h, refs) in hits.iter_mut().zip(&refs) {
        let found = refs.iter().find_map(|(p, v)| {
            held.iter()
                .filter(|(_, hp, hv)| hp == p && hv == v)
                .map(|(id, _, _)| *id)
                .min()
        });
        h["existingMediaId"] = found.map_or(Value::Null, Value::from);
        if matches!(kind, MediaKind::Movie | MediaKind::Series) {
            h["existingMediaType"] = found.map_or(Value::Null, |_| kind.as_str().into());
        }
    }
    Ok(())
}

/// `GET /api/metadata/search/{kind}` with `kind` one of `movie`, `tv`, `book`, `comic`.
#[utoipa::path(get, path = "/api/metadata/search/{kind}", responses((status = 200)))]
pub async fn search_hits(
    State(st): State<AppState>,
    a: Authed,
    seg: Result<PathParams<String>, AppError>,
    Query(q): Pairs,
) -> Res {
    let PathParams(seg) = seg?;
    let kind = segment_kind(&seg)
        .ok_or_else(|| AppError::bad_request(format!("Unknown media type: {seg}")))?;
    let mut qs = q.iter().filter(|(k, _)| k == "q");
    let given = match (qs.next(), qs.next()) {
        (_, Some(_)) => return Err(AppError::bad_request(vec!["q must be a string"])),
        (Some((_, v)), None) => v.trim().to_owned(),
        _ => String::new(),
    };
    let field = |k: &str| {
        bare(&q, k)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    let book = kind == MediaKind::Book;
    let (title, author, isbn, language) = if book {
        (
            field("title"),
            field("author"),
            field("isbn"),
            field("language"),
        )
    } else {
        (None, None, None, None)
    };
    let query = Some(given)
        .filter(|g| !g.is_empty())
        .or_else(|| {
            let t = [title.as_deref(), author.as_deref()]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            (!t.is_empty()).then_some(t)
        })
        .or_else(|| isbn.clone());
    let Some(query) = query else {
        return Ok(Json(json!([])));
    };
    let page = page(&q)?;
    let md = &st.metadata;
    let named = field("provider")
        .map(|n| {
            Namespace::parse(&n)
                .filter(|p| md.get(*p).is_some_and(|x| x.supports(kind)))
                .ok_or_else(|| unknown_provider(&n))
        })
        .transpose()?;
    let pinned = preferred(&st.db, bare(&q, "mediaId").as_deref())
        .await?
        .and_then(|n| Namespace::parse(&n));
    let mut order: Vec<Namespace> = vec![];
    for p in named.into_iter().chain(pinned).chain(md.serving(kind)) {
        let usable = md.available(p) && md.of(p).supports(kind) && md.of(p).has_search(kind);
        if usable && !order.contains(&p) {
            order.push(p);
        }
    }
    let search = Search {
        kind,
        query: &query,
        year: year(bare(&q, "year").as_deref()),
        title: title.as_deref(),
        author: author.as_deref(),
        author_id: None,
        isbn: isbn.as_deref(),
        language: language.as_deref(),
        page,
    };
    let lang = lang(&st).await?;
    let (mut hits, mut answered, mut failed) = (vec![], false, None);
    for p in order {
        match md.of(p).search(&search, &lang, Priority::Interactive).await {
            Ok(r) => {
                hits = r.iter().filter_map(|v| hit(kind, p, v)).collect();
                if !hits.is_empty() {
                    break;
                }
                answered = true;
            }
            Err(e) => {
                tracing::warn!("{p} {kind} search skipped: {e}");
                failed.get_or_insert((p, e));
            }
        }
    }
    if let (true, false, Some((p, e))) = (hits.is_empty(), answered, failed) {
        return Err(unavailable("search", p, &e));
    }
    mark_existing(&st.db, &a, kind, &mut hits).await?;
    Ok(Json(Value::Array(hits)))
}

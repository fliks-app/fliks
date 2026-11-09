//! `GET /api/metadata/search/{movie|tv|book|comic}`: one provider walk and one hit shape
//! (`docs/spec/metadata.md` rules 6-12).
use super::{
    Search, Target, Upstream,
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
    external_id::{Namespace, Namespaces},
    media::{
        kind::MediaKind,
        query::{js_number, js_parse_int},
    },
    metadata::{
        book_match::{Candidate, Hints, score},
        limiter::Priority,
    },
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// How long the route waits for one provider before it walks on (`docs/spec/metadata.md` rule 10).
const PROVIDER_CUT: Duration = Duration::from_secs(3);

/// The kind a search segment names.
pub(crate) fn segment_kind(seg: &str) -> Option<MediaKind> {
    match seg {
        "movie" => Some(MediaKind::Movie),
        "tv" => Some(MediaKind::Series),
        "book" => Some(MediaKind::Book),
        "comic" => Some(MediaKind::Comic),
        "album" => Some(MediaKind::Album),
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
fn video_hit(known: &Namespaces, mut r: Value) -> Option<Value> {
    let ns = known.parse(r["provider"].as_str()?)?;
    let id = known.normalize(ns, r["externalId"].as_str()?.trim())?;
    let o = r.as_object_mut()?;
    o.insert("externalId".into(), id.into());
    for k in ["title", "year", "posterUrl"] {
        o.entry(k).or_insert(Value::Null);
    }
    o.entry("existingMediaId").or_insert(Value::Null);
    Some(r)
}

pub(crate) fn hit(known: &Namespaces, kind: MediaKind, ns: Namespace, v: &Value) -> Option<Value> {
    match kind {
        MediaKind::Book => book_hits::hit(known, ns, v),
        MediaKind::Comic => comic_hits::hit(known, ns, v),
        MediaKind::Album => super::music::routes::hit(known, ns, v),
        MediaKind::Movie | MediaKind::Series => {
            let mut one = [v.clone()];
            stamp(&mut one, ns, kind);
            let [r] = one;
            video_hit(known, r)
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
        if kind == MediaKind::Album {
            // A merged id still names the album that absorbed it.
            held.extend(
                sqlx::query_as::<_, (i32, String, String)>(
                    r#"SELECT min(m.id), a.provider, a.value FROM media_external_id_aliases a
                       JOIN media m ON m.id = a."mediaId" AND m.type = 'album'
                       WHERE m."libraryId" = ANY($1)
                         AND (a.provider, a.value) IN (SELECT * FROM unnest($2::text[], $3::text[]))
                       GROUP BY a.provider, a.value"#,
                )
                .bind(&libs)
                .bind(&ps)
                .bind(&vs)
                .fetch_all(db)
                .await?,
            );
        }
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
    mark_state(db, a, kind, hits, &refs).await
}

/// Sets `state` and `requestStatus` of each hit (`docs/spec/metadata.md` rule 53).
async fn mark_state(
    db: &PgPool,
    a: &Authed,
    kind: MediaKind,
    hits: &mut [Value],
    refs: &[Vec<(String, String)>],
) -> Result<(), AppError> {
    let ids: Vec<i32> = hits
        .iter()
        .filter_map(|h| {
            h["existingMediaId"]
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
        })
        .collect();
    let mut media: HashMap<i32, &'static str> = HashMap::new();
    if !ids.is_empty() {
        let rows: Vec<(i32, bool, bool)> = sqlx::query_as(
            r#"SELECT m.id, m.monitored,
                      EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id)
                      OR EXISTS (SELECT 1 FROM item_parts ip WHERE ip."mediaId" = m.id)
               FROM media m WHERE m.id = ANY($1)"#,
        )
        .bind(&ids)
        .fetch_all(db)
        .await?;
        for (id, monitored, owned) in rows {
            let state = match (owned, monitored) {
                (true, _) => "owned",
                (false, true) => "wanted",
                (false, false) => "missing",
            };
            media.insert(id, state);
        }
    }
    let (ps, vs): (Vec<&str>, Vec<&str>) = refs
        .iter()
        .flatten()
        .map(|(p, v)| (p.as_str(), v.as_str()))
        .unzip();
    let mut asked: Vec<(String, String, String)> = vec![];
    if !ps.is_empty() && a.user.id != 0 {
        asked = sqlx::query_as(
            r#"SELECT DISTINCT ON (r.provider, r."externalId") r.provider, r."externalId", r.status::text
               FROM requests r
               LEFT JOIN provider_namespaces pn ON pn.name = r.provider
               WHERE r."userId" = $1 AND r."mediaType" = $2 AND r.kind = 'add'
                 AND r."namespaceGeneration" IS NOT DISTINCT FROM pn.generation
                 AND (r.provider, r."externalId") IN (SELECT * FROM unnest($3::text[], $4::text[]))
               ORDER BY r.provider, r."externalId", r."createdAt" DESC, r.id DESC"#,
        )
        .bind(a.user.id)
        .bind(kind.as_str())
        .bind(&ps)
        .bind(&vs)
        .fetch_all(db)
        .await?;
    }
    for (h, refs) in hits.iter_mut().zip(refs) {
        h["state"] = h["existingMediaId"]
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .and_then(|id| media.get(&id))
            .map_or(Value::Null, |s| (*s).into());
        h["requestStatus"] = refs
            .iter()
            .find_map(|(p, v)| asked.iter().find(|(rp, rv, _)| rp == p && rv == v))
            .filter(|(_, _, status)| status != "removed")
            .map_or(Value::Null, |(_, _, status)| status.as_str().into());
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
    let target = target(kind, bare(&q, "target").as_deref())?;
    let md = &st.metadata;
    let named = field("provider")
        .map(|n| {
            st.namespaces()
                .parse(&n)
                .filter(|p| md.get(*p).is_some_and(|x| x.supports(kind)))
                .ok_or_else(|| unknown_provider(&n))
        })
        .transpose()?;
    let pinned = preferred(&st.db, bare(&q, "mediaId").as_deref())
        .await?
        .and_then(|n| Namespace::parse(&n));
    let wanted_year = year(bare(&q, "year").as_deref());
    let search = Search {
        kind,
        query: &query,
        year: wanted_year,
        title: title.as_deref(),
        author: author.as_deref(),
        author_id: None,
        isbn: isbn.as_deref(),
        language: language.as_deref(),
        page,
    };
    let lang = lang(&st).await?;
    let key = cache_key(&search, target, (named, pinned), &lang.tmdb_locale);
    let cached = super::search_cache::enabled().then(|| md.search_cache.get(&key, Instant::now()));
    let mut hits = match cached.flatten() {
        Some(hits) => hits,
        None => {
            let order = named.into_iter().chain(pinned);
            let walk = Walk {
                target,
                cut: Some(PROVIDER_CUT),
            };
            let mut hits = walk_with(&st, order, &search, Priority::Interactive, &walk).await?;
            if book {
                let wanted = title.as_deref().unwrap_or(&query);
                rank_books(&mut hits, wanted, author.as_deref(), wanted_year);
            }
            if super::search_cache::enabled() {
                md.search_cache.put(key, hits.clone(), Instant::now());
            }
            hits
        }
    };
    match target {
        None => mark_existing(&st.db, &a, kind, &mut hits).await?,
        Some(Target::Artist) => mark_artists(&st.db, &mut hits).await?,
        Some(Target::Recording) => mark_recordings(&st.db, &a, &mut hits).await?,
    }
    Ok(Json(Value::Array(hits)))
}

/// `target` of an album search: `album` or none is the albums themselves.
fn target(kind: MediaKind, raw: Option<&str>) -> Result<Option<Target>, AppError> {
    match (kind, raw.map(str::trim)) {
        (_, None) => Ok(None),
        (MediaKind::Album, Some("album")) => Ok(None),
        (MediaKind::Album, Some("artist")) => Ok(Some(Target::Artist)),
        (MediaKind::Album, Some("recording")) => Ok(Some(Target::Recording)),
        _ => Err(AppError::bad_request(
            "target must be one of the following values: album, artist, recording",
        )),
    }
}

/// The cache key of `docs/spec/metadata.md` rule 11.
fn cache_key(
    s: &Search<'_>,
    target: Option<Target>,
    (named, pinned): (Option<Namespace>, Option<Namespace>),
    locale: &str,
) -> String {
    let norm = |t: &str| {
        t.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    let opt = |v: Option<&str>| v.map(norm).unwrap_or_default();
    let ns = |n: Option<Namespace>| n.map_or_else(String::new, |n| n.as_str().to_owned());
    [
        s.kind.as_str().to_owned(),
        target.map_or("album", Target::as_str).to_owned(),
        ns(named),
        ns(pinned),
        norm(s.query),
        opt(s.title),
        opt(s.author),
        opt(s.isbn),
        opt(s.language),
        s.year.map(|y| y.to_string()).unwrap_or_default(),
        s.page.to_string(),
        locale.to_owned(),
    ]
    .join("\u{1f}")
}

/// Sets `personId` of each artist hit: the person holding its id, or an alias of it.
async fn mark_artists(db: &PgPool, hits: &mut [Value]) -> Result<(), AppError> {
    let ids: Vec<(String, String)> = hits
        .iter()
        .filter_map(|h| {
            Some((
                h["provider"].as_str()?.to_owned(),
                h["externalId"].as_str()?.to_owned(),
            ))
        })
        .collect();
    let (ps, vs): (Vec<String>, Vec<String>) = ids.into_iter().unzip();
    let held: Vec<(i32, String, String)> = sqlx::query_as(
        r#"SELECT min("personId"), provider, value FROM (
             SELECT "personId", provider, value FROM person_external_ids
             UNION ALL SELECT "personId", provider, value FROM person_external_id_aliases) x
           WHERE (provider, value) IN (SELECT * FROM unnest($1::text[], $2::text[]))
           GROUP BY provider, value"#,
    )
    .bind(&ps)
    .bind(&vs)
    .fetch_all(db)
    .await?;
    for h in hits {
        let (p, v) = (h["provider"].as_str(), h["externalId"].as_str());
        h["personId"] = held
            .iter()
            .find(|(_, hp, hv)| Some(hp.as_str()) == p && Some(hv.as_str()) == v)
            .map_or(Value::Null, |(id, _, _)| (*id).into());
    }
    Ok(())
}

/// Marks the release group of each recording hit like an album hit, and sets `trackId`: the lowest track
/// with a part of that recording in a readable library.
async fn mark_recordings(db: &PgPool, a: &Authed, hits: &mut [Value]) -> Result<(), AppError> {
    let mut albums: Vec<Value> = hits.iter_mut().map(|h| h["album"].take()).collect();
    mark_existing(db, a, MediaKind::Album, &mut albums).await?;
    for (h, album) in hits.iter_mut().zip(albums) {
        h["album"] = album;
    }
    let ids: Vec<&str> = hits
        .iter()
        .filter_map(|h| h["externalId"].as_str())
        .collect();
    let held: Vec<(i32, String)> = if ids.is_empty() {
        vec![]
    } else {
        let libs = accessible_library_ids(db, a).await?;
        sqlx::query_as(
            r#"SELECT min(i.id), td."recordingMbid"::text FROM track_details td
               JOIN items i ON i.id = td."itemId" JOIN editions e ON e.id = i."editionId"
               JOIN media m ON m.id = i."mediaId"
               WHERE td."recordingMbid" = ANY($1::text[]::uuid[]) AND m."libraryId" = ANY($2)
                 AND COALESCE(e."libraryId", m."libraryId") = ANY($2)
                 AND EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = i.id)
               GROUP BY td."recordingMbid""#,
        )
        .bind(&ids)
        .bind(&libs)
        .fetch_all(db)
        .await?
    };
    for h in hits {
        let id = h["externalId"].as_str();
        h["trackId"] = held
            .iter()
            .find(|(_, r)| Some(r.as_str()) == id)
            .map_or(Value::Null, |(t, _)| (*t).into());
    }
    Ok(())
}

/// How a walk asks: the album target (`None` is the albums themselves) and the time each provider gets.
pub(crate) struct Walk {
    pub target: Option<Target>,
    pub cut: Option<Duration>,
}

/// The hits of the first provider with any, trying `first` then the providers serving the kind; an
/// error only when no provider answered.
pub(crate) async fn walk(
    st: &AppState,
    first: impl Iterator<Item = Namespace>,
    search: &Search<'_>,
    prio: Priority,
) -> Result<Vec<Value>, AppError> {
    walk_with(
        st,
        first,
        search,
        prio,
        &Walk {
            target: None,
            cut: None,
        },
    )
    .await
}

pub(crate) async fn walk_with(
    st: &AppState,
    first: impl Iterator<Item = Namespace>,
    search: &Search<'_>,
    prio: Priority,
    how: &Walk,
) -> Result<Vec<Value>, AppError> {
    let (md, kind, known) = (&st.metadata, search.kind, st.namespaces());
    let mut order: Vec<Namespace> = vec![];
    for p in first.chain(md.serving(kind)) {
        let usable = md.available(p)
            && md.of(p).supports(kind)
            && how.target.map_or_else(
                || md.of(p).has_search(kind),
                |t| md.of(p).has_target_search(t),
            );
        if usable && !order.contains(&p) {
            order.push(p);
        }
    }
    let lang = lang(st).await?;
    let (mut answered, mut failed) = (false, None);
    for p in order {
        let provider = md.of(p);
        let call = async {
            match how.target {
                None => provider.search(search, &lang, prio).await,
                Some(t) => provider.search_target(t, search, &lang, prio).await,
            }
        };
        let r = match how.cut {
            Some(cut) => tokio::time::timeout(cut, call)
                .await
                .unwrap_or_else(|_| Err(Upstream::new(Some(504), "timed out"))),
            None => call.await,
        };
        match r {
            Ok(r) => {
                let hits: Vec<Value> = r
                    .iter()
                    .filter_map(|v| match how.target {
                        None => hit(&known, kind, p, v),
                        Some(Target::Artist) => super::music::routes::artist_hit(&known, p, v),
                        Some(Target::Recording) => {
                            super::music::routes::recording_hit(&known, p, v)
                        }
                    })
                    .collect();
                if !hits.is_empty() {
                    return Ok(hits);
                }
                answered = true;
            }
            Err(e) => {
                tracing::warn!("{p} {kind} search skipped: {e}");
                failed.get_or_insert((p, e));
            }
        }
    }
    match (answered, failed) {
        (false, Some((p, e))) => Err(unavailable("search", p, &e)),
        _ => Ok(vec![]),
    }
}

/// Book hits best first by `book_match::score` (`book-metadata.md` rule 18); ties keep the provider's order.
fn rank_books(hits: &mut [Value], title: &str, author: Option<&str>, year: Option<i64>) {
    let authors: Vec<String> = author.map(str::to_owned).into_iter().collect();
    let h = Hints {
        title,
        authors: &authors,
        year: year.and_then(|y| i32::try_from(y).ok()),
    };
    hits.sort_by_cached_key(|v| {
        let listed: Vec<String> = v["authors"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|n| n.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let c = Candidate {
            title: v["title"].as_str().unwrap_or_default(),
            subtitle: v["subtitle"].as_str(),
            authors: &listed,
            year: v["year"].as_i64().and_then(|y| i32::try_from(y).ok()),
        };
        std::cmp::Reverse(score(&h, &c))
    });
}

#[cfg(test)]
mod tests {
    use super::rank_books;
    use serde_json::json;

    #[test]
    fn book_hits_rank_by_title_author_and_year_ties_in_provider_order() {
        let hit = |t: &str, y: i64| json!({"title": t, "authors": ["Ana Placeholder"], "year": y});
        let mut hits = vec![
            hit("Other Story", 2024),
            hit("Second Story", 2021),
            hit("Wanted Place", 2023),
            hit("Third Story", 2021),
        ];
        rank_books(
            &mut hits,
            "det_11Wanted Place",
            Some("Ana Placeholder"),
            Some(2024),
        );
        let order: Vec<_> = hits.iter().map(|h| h["title"].as_str().unwrap()).collect();
        assert_eq!(
            order,
            ["Wanted Place", "Other Story", "Second Story", "Third Story"]
        );
    }
}

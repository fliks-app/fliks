//! `/api/metadata/*` (`docs/spec/metadata.md` rules 1-16, 38-39).
use super::{Metadata, Search, Upstream};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, int_param},
    },
    libraries::accessible_library_ids,
    media::external_ids,
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::get,
};
use fliks_domain::external_id::Namespace;
use fliks_domain::media::kind::MediaKind;
use fliks_domain::{
    media::query::js_parse_int,
    metadata::{language::Resolved, limiter::Priority},
};
use serde_json::{Value, json};
use sqlx::PgPool;

pub(crate) type Pairs = Query<Vec<(String, String)>>;
pub(crate) type Res = Result<Json<Value>, AppError>;

pub fn router() -> Router<AppState> {
    let m = "/api/metadata";
    super::books::routes::routes(Router::new())
        .route(&format!("{m}/providers"), get(providers))
        .route(&format!("{m}/search/movie"), get(search_movie))
        .route(&format!("{m}/search/tv"), get(search_tv))
        .route(&format!("{m}/trending/movie"), get(trending_movie))
        .route(&format!("{m}/popular/movie"), get(popular_movie))
        .route(&format!("{m}/upcoming/movie"), get(upcoming_movie))
        .route(&format!("{m}/trending/tv"), get(trending_tv))
        .route(&format!("{m}/popular/tv"), get(popular_tv))
        .route(&format!("{m}/upcoming/tv"), get(upcoming_tv))
        .route(&format!("{m}/genres/movie"), get(genres_movie))
        .route(&format!("{m}/genres/tv"), get(genres_tv))
        .route(&format!("{m}/discover/movie"), get(discover_movie))
        .route(&format!("{m}/discover/tv"), get(discover_tv))
        .route(
            &format!("{m}/{{provider}}/movie/{{externalId}}"),
            get(details_movie),
        )
        .route(
            &format!("{m}/{{provider}}/tv/{{externalId}}"),
            get(details_tv),
        )
        .route(
            &format!("{m}/{{provider}}/tv/{{externalId}}/seasons"),
            get(seasons),
        )
        .route(
            &format!("{m}/{{provider}}/tv/{{externalId}}/season-stubs"),
            get(season_stubs),
        )
        .route(&format!("{m}/movie/{{tmdbId}}"), get(legacy_movie))
        .route(&format!("{m}/tv/{{tmdbId}}"), get(legacy_tv))
        .route(&format!("{m}/tv/{{tmdbId}}/seasons"), get(legacy_seasons))
}

/// A bare `@Query` string; a repeated key is an array to the pipe, joined here (only `q` rejects it).
pub(crate) fn bare(pairs: &[(String, String)], key: &str) -> Option<String> {
    let v: Vec<&str> = pairs
        .iter()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .collect();
    (!v.is_empty()).then(|| v.join(","))
}

pub(crate) fn unavailable(what: &str, provider: Namespace, e: &Upstream) -> AppError {
    AppError::with_message(
        StatusCode::SERVICE_UNAVAILABLE,
        format!(
            "Metadata {what} failed on {}: {}",
            provider.as_str(),
            e.reason()
        ),
    )
}

/// An upstream 404 on a detail route is a 404, everything else a 503.
pub(crate) fn fail(provider: Namespace, e: &Upstream, detail: bool) -> AppError {
    if detail && e.is_not_found() {
        return AppError::not_found("not_found");
    }
    unavailable("request", provider, e)
}

/// `year ? +year : undefined`, dropped unless truthy (NaN and 0).
fn year(raw: Option<&str>) -> Option<i64> {
    let f = raw?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|f| f.is_finite() && *f != 0.0)?;
    Some(f as i64)
}

/// Rule 7: media override, then library, else no preference; a bad id is no preference.
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

/// Fills what a plugin record leaves out from the namespace that answered, so the client can link it.
fn stamp(records: &mut [Value], ns: Namespace, kind: MediaKind) {
    for r in records {
        let ext = r["ids"][ns.as_str()].as_str().map(str::to_owned);
        let Some(o) = r.as_object_mut() else { continue };
        o.entry("provider").or_insert_with(|| ns.as_str().into());
        o.entry("mediaType").or_insert_with(|| kind.as_str().into());
        if let Some(e) = ext {
            o.entry("externalId").or_insert(e.into());
        }
    }
}

/// The `(provider, externalId)` a record names.
fn title_ref(r: &Value) -> Option<(&str, &str)> {
    Some((r["provider"].as_str()?, r["externalId"].as_str()?))
}

/// Rule 12: `existingMediaId` / `existingMediaType`, only for libraries the caller can read.
async fn enrich(db: &PgPool, a: &Authed, results: Vec<Value>, tv: bool) -> Result<Value, AppError> {
    if results.is_empty() {
        return Ok(Value::Array(results));
    }
    let ids = |k: &str| -> Vec<String> {
        results
            .iter()
            .filter_map(|r| r.get(k).and_then(Value::as_i64))
            .filter_map(|n| i32::try_from(n).ok())
            .filter(|n| *n > 0)
            .map(|n| n.to_string())
            .collect()
    };
    let (tmdb, tvdb) = (ids("tmdbId"), ids("tvdbId"));
    let kind = MediaKind::from_tv(tv);
    let mut rows: Vec<MediaIds> = vec![];
    if !tmdb.is_empty() || !tvdb.is_empty() {
        let libs = accessible_library_ids(db, a).await?;
        rows = sqlx::query!(
            r#"SELECT m.id AS "id!", ids.tmdb AS tmdb_id, ids.tvdb AS tvdb_id
               FROM media m
               LEFT JOIN LATERAL (SELECT max(value) FILTER (WHERE provider = $5)::int AS tmdb,
                 max(value) FILTER (WHERE provider = $6)::int AS tvdb,
                 max(value) FILTER (WHERE provider = $7) AS imdb
                 FROM media_external_ids WHERE "mediaId" = m.id) ids ON true
               WHERE m.type = $3 AND m."libraryId" = ANY($4)
                 AND m.id IN (SELECT "mediaId" FROM media_external_ids WHERE kind = $3
                              AND ((provider = $5 AND value = ANY($1)) OR (provider = $6 AND value = ANY($2))))
               ORDER BY m.id ASC"#,
            &tmdb,
            &tvdb,
            kind.as_str(),
            &libs,
            external_ids::TMDB,
            external_ids::TVDB,
            external_ids::IMDB
        )
        .fetch_all(db)
        .await?
        .into_iter()
        .map(|r| (r.id, r.tmdb_id, r.tvdb_id))
        .collect();
    }
    let refs: Vec<(&str, &str)> = results.iter().filter_map(title_ref).collect();
    let held: Vec<(i32, String, String)> = if refs.is_empty() {
        vec![]
    } else {
        let libs = accessible_library_ids(db, a).await?;
        let (ps, vs): (Vec<&str>, Vec<&str>) = refs.into_iter().unzip();
        sqlx::query_as(
            r#"SELECT m.id, e.provider::text, e.value FROM media m
               JOIN media_external_ids e ON e."mediaId" = m.id AND e.kind = m.type
               WHERE m.type = $1 AND m."libraryId" = ANY($2)
                 AND (e.provider::text, e.value) IN (SELECT * FROM unnest($3::text[], $4::text[]))
               ORDER BY m.id ASC"#,
        )
        .bind(kind.as_str())
        .bind(&libs)
        .bind(&ps)
        .bind(&vs)
        .fetch_all(db)
        .await?
    };
    let out = results
        .into_iter()
        .map(|mut r| {
            let find = |k: &str, col: fn(&MediaIds) -> Option<i32>| {
                let want = r.get(k).and_then(Value::as_i64).filter(|n| *n > 0)?;
                rows.iter()
                    .rfind(|m| col(m).map(i64::from) == Some(want))
                    .map(|m| m.0)
            };
            let named = || {
                let (p, e) = title_ref(&r)?;
                held.iter().rfind(|h| h.1 == p && h.2 == e).map(|h| h.0)
            };
            let hit = find("tmdbId", |m| m.1)
                .or_else(|| find("tvdbId", |m| m.2))
                .or_else(named);
            r["existingMediaId"] = hit.map_or(Value::Null, Value::from);
            r["existingMediaType"] = hit.map_or(Value::Null, |_| kind.as_str().into());
            r
        })
        .collect();
    Ok(Value::Array(out))
}

type MediaIds = (i32, Option<i32>, Option<i32>);

pub(crate) async fn lang(st: &AppState) -> Result<Resolved, AppError> {
    Ok(st.metadata.lang.resolve(None).await?)
}

async fn search(st: AppState, a: Authed, q: Vec<(String, String)>, tv: bool) -> Res {
    let mut qs = q.iter().filter(|(k, _)| k == "q");
    let query = match (qs.next(), qs.next()) {
        (_, Some(_)) => return Err(AppError::bad_request(vec!["q must be a string"])),
        (Some((_, v)), None) => v.trim(),
        _ => "",
    };
    if query.is_empty() {
        return Ok(Json(json!([])));
    }
    let md = &st.metadata;
    let name = match bare(&q, "provider") {
        Some(p) => Some(p),
        None => preferred(&st.db, bare(&q, "mediaId").as_deref()).await?,
    };
    let kind = MediaKind::from_tv(tv);
    let Some(primary) = md.resolve(name.as_deref(), kind) else {
        return Ok(Json(json!([])));
    };
    let search = Search::text(kind, query, year(bare(&q, "year").as_deref()));
    let lang = lang(&st).await?;
    let go = Priority::Interactive;
    let mut answered = primary;
    let mut found = md.of(primary).search(&search, &lang, go).await;
    if let (Ok(r), Some(other)) = (&found, md.fallback(primary, search.kind))
        && r.is_empty()
    {
        tracing::info!("no {} result, trying {}", primary.as_str(), other.as_str());
        answered = other;
        found = md.of(other).search(&search, &lang, go).await;
    }
    let mut results = found.map_err(|e| unavailable("search", answered, &e))?;
    stamp(&mut results, answered, kind);
    Ok(Json(enrich(&st.db, &a, results, tv).await?))
}

/// Whether the TMDB provider answers (a client keys a request by `tmdbId` only then), and the available providers serving each video kind.
#[utoipa::path(get, path = "/api/metadata/providers", responses((status = 200)))]
pub async fn providers(State(st): State<AppState>, _a: Authed) -> Res {
    let serving = |kind| -> Vec<Value> {
        st.metadata
            .order(kind)
            .into_iter()
            .filter(|p| st.metadata.available(*p) && st.metadata.of(*p).supports(kind))
            .map(|p| json!({"provider": p.as_str(), "label": p.label()}))
            .collect()
    };
    Ok(Json(json!({
        "tmdb": st.metadata.available(Namespace::TMDB),
        "serving": {"movie": serving(MediaKind::Movie), "series": serving(MediaKind::Series)},
    })))
}

#[utoipa::path(get, path = "/api/metadata/search/movie", responses((status = 200)))]
pub async fn search_movie(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    search(st, a, q, false).await
}

#[utoipa::path(get, path = "/api/metadata/search/tv", responses((status = 200)))]
pub async fn search_tv(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    search(st, a, q, true).await
}

async fn listed(
    st: &AppState,
    a: &Authed,
    tv: bool,
    name: &str,
    params: &[(String, String)],
) -> Res {
    let kind = MediaKind::from_tv(tv);
    let Some(id) = st.metadata.lister(kind) else {
        return Ok(Json(json!([])));
    };
    let l = lang(st).await?;
    let v = st
        .metadata
        .list(id, kind, name, params, &l, Priority::Interactive)
        .await
        .map_err(|(p, e)| fail(p, &e, false))?;
    let mut items = v.as_array().cloned().unwrap_or_default();
    stamp(&mut items, id, kind);
    Ok(Json(enrich(&st.db, a, items, tv).await?))
}

/// Exactly `day`, else `week`; a repeated key is an array and so `week`.
fn window(q: &[(String, String)]) -> &'static str {
    match bare(q, "window").as_deref() {
        Some("day") => "day",
        _ => "week",
    }
}

fn trending(q: &[(String, String)]) -> [(String, String); 1] {
    [("window".into(), window(q).into())]
}

#[utoipa::path(get, path = "/api/metadata/trending/movie", responses((status = 200)))]
pub async fn trending_movie(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    listed(&st, &a, false, "trending", &trending(&q)).await
}

#[utoipa::path(get, path = "/api/metadata/popular/movie", responses((status = 200)))]
pub async fn popular_movie(State(st): State<AppState>, a: Authed) -> Res {
    listed(&st, &a, false, "popular", &[]).await
}

#[utoipa::path(get, path = "/api/metadata/upcoming/movie", responses((status = 200)))]
pub async fn upcoming_movie(State(st): State<AppState>, a: Authed) -> Res {
    listed(&st, &a, false, "upcoming", &[]).await
}

#[utoipa::path(get, path = "/api/metadata/trending/tv", responses((status = 200)))]
pub async fn trending_tv(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    listed(&st, &a, true, "trending", &trending(&q)).await
}

#[utoipa::path(get, path = "/api/metadata/popular/tv", responses((status = 200)))]
pub async fn popular_tv(State(st): State<AppState>, a: Authed) -> Res {
    listed(&st, &a, true, "popular", &[]).await
}

#[utoipa::path(get, path = "/api/metadata/upcoming/tv", responses((status = 200)))]
pub async fn upcoming_tv(State(st): State<AppState>, a: Authed) -> Res {
    listed(&st, &a, true, "upcoming", &[]).await
}

async fn genres(st: &AppState, tv: bool) -> Res {
    let kind = MediaKind::from_tv(tv);
    let Some(id) = st.metadata.lister(kind) else {
        return Ok(Json(json!([])));
    };
    let l = lang(st).await?;
    let v = st
        .metadata
        .list(id, kind, "genres", &[], &l, Priority::Interactive)
        .await
        .map_err(|(p, e)| fail(p, &e, false))?;
    Ok(Json(v))
}

#[utoipa::path(get, path = "/api/metadata/genres/movie", responses((status = 200)))]
pub async fn genres_movie(State(st): State<AppState>, _a: Authed) -> Res {
    genres(&st, false).await
}

#[utoipa::path(get, path = "/api/metadata/genres/tv", responses((status = 200)))]
pub async fn genres_tv(State(st): State<AppState>, _a: Authed) -> Res {
    genres(&st, true).await
}

async fn discovered(st: AppState, a: Authed, q: Vec<(String, String)>, tv: bool) -> Res {
    let params: Vec<_> = ["genres", "sort", "voteGte", "yearGte", "yearLte"]
        .into_iter()
        .filter_map(|k| Some((k.to_owned(), bare(&q, k)?)))
        .collect();
    listed(&st, &a, tv, "discover", &params).await
}

#[utoipa::path(get, path = "/api/metadata/discover/movie", responses((status = 200)))]
pub async fn discover_movie(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    discovered(st, a, q, false).await
}

#[utoipa::path(get, path = "/api/metadata/discover/tv", responses((status = 200)))]
pub async fn discover_tv(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    discovered(st, a, q, true).await
}

/// `registry.get(name)` (availability unchecked) and the id: a canonical integer for a core
/// provider, the plugin's own normal form for a plugin namespace.
fn target(md: &Metadata, provider: &str, id: &str) -> Result<(Namespace, String), AppError> {
    let p = Namespace::parse(provider)
        .filter(|p| md.get(*p).is_some())
        .ok_or_else(|| AppError::bad_request(format!("Unknown provider: {provider}")))?;
    let id = match p.core() {
        Some(_) => int_param(id)?.to_string(),
        None => p
            .normalize(id)
            .ok_or_else(|| AppError::bad_request(format!("Invalid id for provider: {provider}")))?,
    };
    Ok((p, id))
}

type Legacy = Result<PathParams<String>, AppError>;
pub(crate) type Ids = Result<PathParams<(String, String)>, AppError>;

async fn details(st: &AppState, p: Namespace, kind: MediaKind, id: &str) -> Res {
    let l = lang(st).await?;
    let v = st
        .metadata
        .of(p)
        .fetch_work(kind, id, &l, Priority::Interactive)
        .await
        .map_err(|e| fail(p, &e, true))?;
    Ok(Json(v))
}

async fn seasons_of(st: &AppState, p: Namespace, id: &str, stubs: bool) -> Res {
    let l = lang(st).await?;
    let (go, series) = (Priority::Interactive, MediaKind::Series);
    let provider = st.metadata.of(p);
    let found = if stubs {
        provider.child_stubs(series, id, &l, go).await
    } else {
        provider.fetch_children(series, id, &l, go).await
    };
    Ok(Json(Value::Array(found.map_err(|e| fail(p, &e, true))?)))
}

#[utoipa::path(get, path = "/api/metadata/{provider}/movie/{externalId}", responses((status = 200)))]
pub async fn details_movie(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st.metadata, &p, &id)?;
    details(&st, p, MediaKind::Movie, &id).await
}

#[utoipa::path(get, path = "/api/metadata/{provider}/tv/{externalId}", responses((status = 200)))]
pub async fn details_tv(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st.metadata, &p, &id)?;
    details(&st, p, MediaKind::Series, &id).await
}

#[utoipa::path(get, path = "/api/metadata/{provider}/tv/{externalId}/seasons", responses((status = 200)))]
pub async fn seasons(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st.metadata, &p, &id)?;
    seasons_of(&st, p, &id, false).await
}

#[utoipa::path(get, path = "/api/metadata/{provider}/tv/{externalId}/season-stubs", responses((status = 200)))]
pub async fn season_stubs(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st.metadata, &p, &id)?;
    seasons_of(&st, p, &id, true).await
}

#[utoipa::path(get, path = "/api/metadata/movie/{tmdbId}", responses((status = 200)))]
pub async fn legacy_movie(State(st): State<AppState>, _a: Authed, id: Legacy) -> Res {
    let (p, id) = target(&st.metadata, "tmdb", &id?.0)?;
    details(&st, p, MediaKind::Movie, &id).await
}

#[utoipa::path(get, path = "/api/metadata/tv/{tmdbId}", responses((status = 200)))]
pub async fn legacy_tv(State(st): State<AppState>, _a: Authed, id: Legacy) -> Res {
    let (p, id) = target(&st.metadata, "tmdb", &id?.0)?;
    details(&st, p, MediaKind::Series, &id).await
}

#[utoipa::path(get, path = "/api/metadata/tv/{tmdbId}/seasons", responses((status = 200)))]
pub async fn legacy_seasons(State(st): State<AppState>, _a: Authed, id: Legacy) -> Res {
    let (p, id) = target(&st.metadata, "tmdb", &id?.0)?;
    seasons_of(&st, p, &id, false).await
}

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
use fliks_domain::external_id::ExternalProvider;
use fliks_domain::media::kind::MediaKind;
use fliks_domain::{
    media::query::js_parse_int,
    metadata::{discover, language::Resolved, limiter::Priority},
};
use serde_json::{Value, json};
use sqlx::PgPool;

type Pairs = Query<Vec<(String, String)>>;
type Res = Result<Json<Value>, AppError>;

pub fn router() -> Router<AppState> {
    let m = "/api/metadata";
    Router::new()
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
fn bare(pairs: &[(String, String)], key: &str) -> Option<String> {
    let v: Vec<&str> = pairs
        .iter()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
        .collect();
    (!v.is_empty()).then(|| v.join(","))
}

fn unavailable(what: &str, provider: ExternalProvider, e: &Upstream) -> AppError {
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
fn fail(provider: ExternalProvider, e: &Upstream, detail: bool) -> AppError {
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
    let out = results
        .into_iter()
        .map(|mut r| {
            let find = |k: &str, col: fn(&MediaIds) -> Option<i32>| {
                let want = r.get(k).and_then(Value::as_i64).filter(|n| *n > 0)?;
                rows.iter()
                    .rfind(|m| col(m).map(i64::from) == Some(want))
                    .map(|m| m.0)
            };
            let hit = find("tmdbId", |m| m.1).or_else(|| find("tvdbId", |m| m.2));
            r["existingMediaId"] = hit.map_or(Value::Null, Value::from);
            r["existingMediaType"] = hit.map_or(Value::Null, |_| kind.as_str().into());
            r
        })
        .collect();
    Ok(Value::Array(out))
}

type MediaIds = (i32, Option<i32>, Option<i32>);

async fn lang(st: &AppState) -> Result<Resolved, AppError> {
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
    let primary = md.resolve(name.as_deref());
    let search = Search::text(
        MediaKind::from_tv(tv),
        query,
        year(bare(&q, "year").as_deref()),
    );
    let lang = lang(&st).await?;
    let go = Priority::Interactive;
    let mut found = md.of(primary).search(&search, &lang, go).await;
    if let (Ok(r), Some(other)) = (&found, md.fallback(primary, search.kind))
        && r.is_empty()
    {
        tracing::info!("no {} result, trying {}", primary.as_str(), other.as_str());
        found = md.of(other).search(&search, &lang, go).await;
    }
    let results = found.map_err(|e| unavailable("search", primary, &e))?;
    Ok(Json(enrich(&st.db, &a, results, tv).await?))
}

#[utoipa::path(get, path = "/api/metadata/search/movie", responses((status = 200)))]
pub async fn search_movie(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    search(st, a, q, false).await
}

#[utoipa::path(get, path = "/api/metadata/search/tv", responses((status = 200)))]
pub async fn search_tv(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    search(st, a, q, true).await
}

async fn listed(st: &AppState, a: &Authed, tv: bool, live: Result<Value, Upstream>) -> Res {
    let v = live.map_err(|e| fail(ExternalProvider::Tmdb, &e, false))?;
    let items = v.as_array().cloned().unwrap_or_default();
    Ok(Json(enrich(&st.db, a, items, tv).await?))
}

/// Exactly `day`, else `week`; a repeated key is an array and so `week`.
fn window(q: &[(String, String)]) -> &'static str {
    match bare(q, "window").as_deref() {
        Some("day") => "day",
        _ => "week",
    }
}

#[utoipa::path(get, path = "/api/metadata/trending/movie", responses((status = 200)))]
pub async fn trending_movie(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    let l = lang(&st).await?;
    listed(
        &st,
        &a,
        false,
        st.metadata
            .tmdb
            .trending(false, window(&q), &l, Priority::Interactive)
            .await,
    )
    .await
}

#[utoipa::path(get, path = "/api/metadata/popular/movie", responses((status = 200)))]
pub async fn popular_movie(State(st): State<AppState>, a: Authed) -> Res {
    let l = lang(&st).await?;
    listed(
        &st,
        &a,
        false,
        st.metadata
            .tmdb
            .popular(false, &l, Priority::Interactive)
            .await,
    )
    .await
}

#[utoipa::path(get, path = "/api/metadata/upcoming/movie", responses((status = 200)))]
pub async fn upcoming_movie(State(st): State<AppState>, a: Authed) -> Res {
    let l = lang(&st).await?;
    listed(
        &st,
        &a,
        false,
        st.metadata
            .tmdb
            .upcoming(false, &l, Priority::Interactive)
            .await,
    )
    .await
}

#[utoipa::path(get, path = "/api/metadata/trending/tv", responses((status = 200)))]
pub async fn trending_tv(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    let l = lang(&st).await?;
    listed(
        &st,
        &a,
        true,
        st.metadata
            .tmdb
            .trending(true, window(&q), &l, Priority::Interactive)
            .await,
    )
    .await
}

#[utoipa::path(get, path = "/api/metadata/popular/tv", responses((status = 200)))]
pub async fn popular_tv(State(st): State<AppState>, a: Authed) -> Res {
    let l = lang(&st).await?;
    listed(
        &st,
        &a,
        true,
        st.metadata
            .tmdb
            .popular(true, &l, Priority::Interactive)
            .await,
    )
    .await
}

#[utoipa::path(get, path = "/api/metadata/upcoming/tv", responses((status = 200)))]
pub async fn upcoming_tv(State(st): State<AppState>, a: Authed) -> Res {
    let l = lang(&st).await?;
    listed(
        &st,
        &a,
        true,
        st.metadata
            .tmdb
            .upcoming(true, &l, Priority::Interactive)
            .await,
    )
    .await
}

async fn genres(st: &AppState, tv: bool) -> Res {
    let l = lang(st).await?;
    let v = st
        .metadata
        .tmdb
        .genres(tv, &l, Priority::Interactive)
        .await
        .map_err(|e| fail(ExternalProvider::Tmdb, &e, false))?;
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
    let opts = discover::parse(
        bare(&q, "genres").as_deref(),
        bare(&q, "sort").as_deref(),
        bare(&q, "voteGte").as_deref(),
        bare(&q, "yearGte").as_deref(),
        bare(&q, "yearLte").as_deref(),
    );
    let l = lang(&st).await?;
    let found = st
        .metadata
        .tmdb
        .discover(tv, &opts, &l, Priority::Interactive)
        .await;
    let results = found.map_err(|e| fail(ExternalProvider::Tmdb, &e, false))?;
    Ok(Json(enrich(&st.db, &a, results, tv).await?))
}

#[utoipa::path(get, path = "/api/metadata/discover/movie", responses((status = 200)))]
pub async fn discover_movie(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    discovered(st, a, q, false).await
}

#[utoipa::path(get, path = "/api/metadata/discover/tv", responses((status = 200)))]
pub async fn discover_tv(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    discovered(st, a, q, true).await
}

/// `registry.get(name)` (availability unchecked) and the canonical integer id.
fn target(md: &Metadata, provider: &str, id: &str) -> Result<(ExternalProvider, i64), AppError> {
    let p = ExternalProvider::parse(provider)
        .filter(|p| md.get(*p).is_some())
        .ok_or_else(|| AppError::bad_request(format!("Unknown provider: {provider}")))?;
    Ok((p, i64::from(int_param(id)?)))
}

type Ids = Result<PathParams<(String, String)>, AppError>;

async fn details(st: &AppState, p: ExternalProvider, kind: MediaKind, id: i64) -> Res {
    let l = lang(st).await?;
    let v = st
        .metadata
        .of(p)
        .fetch_work(kind, &id.to_string(), &l, Priority::Interactive)
        .await
        .map_err(|e| fail(p, &e, true))?;
    Ok(Json(v))
}

async fn seasons_of(st: &AppState, p: ExternalProvider, id: i64, stubs: bool) -> Res {
    let l = lang(st).await?;
    let (id, go, series) = (id.to_string(), Priority::Interactive, MediaKind::Series);
    let provider = st.metadata.of(p);
    let found = if stubs {
        provider.child_stubs(series, &id, &l, go).await
    } else {
        provider.fetch_children(series, &id, &l, go).await
    };
    Ok(Json(Value::Array(found.map_err(|e| fail(p, &e, true))?)))
}

#[utoipa::path(get, path = "/api/metadata/{provider}/movie/{externalId}", responses((status = 200)))]
pub async fn details_movie(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st.metadata, &p, &id)?;
    details(&st, p, MediaKind::Movie, id).await
}

#[utoipa::path(get, path = "/api/metadata/{provider}/tv/{externalId}", responses((status = 200)))]
pub async fn details_tv(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st.metadata, &p, &id)?;
    details(&st, p, MediaKind::Series, id).await
}

#[utoipa::path(get, path = "/api/metadata/{provider}/tv/{externalId}/seasons", responses((status = 200)))]
pub async fn seasons(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st.metadata, &p, &id)?;
    seasons_of(&st, p, id, false).await
}

#[utoipa::path(get, path = "/api/metadata/{provider}/tv/{externalId}/season-stubs", responses((status = 200)))]
pub async fn season_stubs(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st.metadata, &p, &id)?;
    seasons_of(&st, p, id, true).await
}

#[utoipa::path(get, path = "/api/metadata/movie/{tmdbId}", responses((status = 200)))]
pub async fn legacy_movie(
    State(st): State<AppState>,
    _a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    details(
        &st,
        ExternalProvider::Tmdb,
        MediaKind::Movie,
        i64::from(id?.0),
    )
    .await
}

#[utoipa::path(get, path = "/api/metadata/tv/{tmdbId}", responses((status = 200)))]
pub async fn legacy_tv(
    State(st): State<AppState>,
    _a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    details(
        &st,
        ExternalProvider::Tmdb,
        MediaKind::Series,
        i64::from(id?.0),
    )
    .await
}

#[utoipa::path(get, path = "/api/metadata/tv/{tmdbId}/seasons", responses((status = 200)))]
pub async fn legacy_seasons(
    State(st): State<AppState>,
    _a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res {
    seasons_of(&st, ExternalProvider::Tmdb, i64::from(id?.0), false).await
}

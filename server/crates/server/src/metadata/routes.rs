//! `/api/metadata/*` except the search (`docs/spec/metadata.md` rules 1-16, 38-39).
use super::{Upstream, mark_existing, search_hits};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, int_param},
    },
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
use fliks_domain::metadata::{language::Resolved, limiter::Priority};
use serde_json::{Value, json};

pub(crate) type Pairs = Query<Vec<(String, String)>>;
pub(crate) type Res = Result<Json<Value>, AppError>;

pub fn router() -> Router<AppState> {
    let m = "/api/metadata";
    super::comics::routes::routes(super::books::routes::routes(Router::new()))
        .route(&format!("{m}/providers"), get(providers))
        .route(&format!("{m}/search/{{kind}}"), get(search_hits))
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
pub(crate) fn year(raw: Option<&str>) -> Option<i64> {
    let f = raw?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|f| f.is_finite() && *f != 0.0)?;
    Some(f as i64)
}

/// Fills what a plugin record leaves out from the namespace that answered, so the client can link it.
pub(crate) fn stamp(records: &mut [Value], ns: Namespace, kind: MediaKind) {
    for r in records {
        let native = match ns {
            Namespace::TMDB => r["tmdbId"].as_i64(),
            Namespace::TVDB => r["tvdbId"].as_i64(),
            _ => None,
        };
        let ext = r["ids"][ns.as_str()]
            .as_str()
            .map(str::to_owned)
            .or(native.map(|n| n.to_string()));
        let Some(o) = r.as_object_mut() else { continue };
        o.entry("provider").or_insert_with(|| ns.as_str().into());
        o.entry("mediaType").or_insert_with(|| kind.as_str().into());
        if let Some(e) = ext {
            o.entry("externalId").or_insert(e.into());
        }
    }
}

pub(crate) async fn lang(st: &AppState) -> Result<Resolved, AppError> {
    Ok(st.metadata.lang.resolve(None).await?)
}

/// Whether the TMDB provider answers (a client keys a request by `tmdbId` only then), and the available
/// providers serving each kind, in the admin's order.
#[utoipa::path(get, path = "/api/metadata/providers", responses((status = 200)))]
pub async fn providers(State(st): State<AppState>, _a: Authed) -> Res {
    let mut serving = serde_json::Map::new();
    let known = st.namespaces();
    for kind in MediaKind::ALL {
        let list = match kind {
            MediaKind::Comic => super::comics::routes::serving(&st).await?,
            _ => st
                .metadata
                .serving(kind)
                .into_iter()
                .map(|p| json!({"provider": p.as_str(), "label": known.label(p)}))
                .collect(),
        };
        serving.insert(kind.as_str().to_owned(), Value::Array(list));
    }
    Ok(Json(json!({
        "tmdb": st.metadata.available(Namespace::TMDB),
        "serving": serving,
    })))
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
    mark_existing(&st.db, a, kind, &mut items).await?;
    Ok(Json(Value::Array(items)))
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
fn target(st: &AppState, provider: &str, id: &str) -> Result<(Namespace, String), AppError> {
    let known = st.namespaces();
    let p = known
        .parse(provider)
        .filter(|p| st.metadata.get(*p).is_some())
        .ok_or_else(|| AppError::bad_request(format!("Unknown provider: {provider}")))?;
    let id = match p.core() {
        Some(_) => int_param(id)?.to_string(),
        None => known
            .normalize(p, id)
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
        provider.fetch_children(series, id, None, &l, go).await
    };
    Ok(Json(Value::Array(found.map_err(|e| fail(p, &e, true))?)))
}

#[utoipa::path(get, path = "/api/metadata/{provider}/movie/{externalId}", responses((status = 200)))]
pub async fn details_movie(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st, &p, &id)?;
    details(&st, p, MediaKind::Movie, &id).await
}

#[utoipa::path(get, path = "/api/metadata/{provider}/tv/{externalId}", responses((status = 200)))]
pub async fn details_tv(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st, &p, &id)?;
    details(&st, p, MediaKind::Series, &id).await
}

#[utoipa::path(get, path = "/api/metadata/{provider}/tv/{externalId}/seasons", responses((status = 200)))]
pub async fn seasons(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st, &p, &id)?;
    seasons_of(&st, p, &id, false).await
}

#[utoipa::path(get, path = "/api/metadata/{provider}/tv/{externalId}/season-stubs", responses((status = 200)))]
pub async fn season_stubs(State(st): State<AppState>, _a: Authed, ids: Ids) -> Res {
    let PathParams((p, id)) = ids?;
    let (p, id) = target(&st, &p, &id)?;
    seasons_of(&st, p, &id, true).await
}

#[utoipa::path(get, path = "/api/metadata/movie/{tmdbId}", responses((status = 200)))]
pub async fn legacy_movie(State(st): State<AppState>, _a: Authed, id: Legacy) -> Res {
    let (p, id) = target(&st, "tmdb", &id?.0)?;
    details(&st, p, MediaKind::Movie, &id).await
}

#[utoipa::path(get, path = "/api/metadata/tv/{tmdbId}", responses((status = 200)))]
pub async fn legacy_tv(State(st): State<AppState>, _a: Authed, id: Legacy) -> Res {
    let (p, id) = target(&st, "tmdb", &id?.0)?;
    details(&st, p, MediaKind::Series, &id).await
}

#[utoipa::path(get, path = "/api/metadata/tv/{tmdbId}/seasons", responses((status = 200)))]
pub async fn legacy_seasons(State(st): State<AppState>, _a: Authed, id: Legacy) -> Res {
    let (p, id) = target(&st, "tmdb", &id?.0)?;
    seasons_of(&st, p, &id, false).await
}

//! What the media services read from the providers and write back (`media-write.md` rules 16, 17, 53-58):
//! provider choice per library, media and season, cross-references, season overrides and credits.
use super::{Override, Provider, Upstream};
use crate::{http::AppError, state::AppState};
use fliks_domain::media::kind::MediaKind;
use fliks_domain::metadata::language::Resolved;
use serde_json::Value;
use std::collections::HashMap;

pub use super::credits::persist_credits;

/// `MetadataDetails` as the media services read it; `raw` keeps the provider JSON for the credits.
#[derive(Debug, Clone, Default)]
pub struct Details {
    pub tmdb_id: Option<i32>,
    pub tvdb_id: Option<i32>,
    pub imdb_id: Option<String>,
    pub title: String,
    pub original_title: Option<String>,
    pub overview: Option<String>,
    pub year: Option<f64>,
    pub poster_url: Option<String>,
    pub fanart_url: Option<String>,
    pub logo_url: Option<String>,
    pub additional_fanart_urls: Vec<String>,
    pub rating: Option<f64>,
    pub genres: Vec<String>,
    pub runtime: Option<i32>,
    pub release_date: Option<String>,
    pub in_cinemas: Option<String>,
    pub digital_release: Option<String>,
    pub physical_release: Option<String>,
    pub status: String,
    pub alternative_titles: Vec<String>,
    pub tmdb_collection_id: Option<i32>,
    pub tmdb_collection_name: Option<String>,
    pub(super) raw: Value,
}

pub(super) fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

pub(super) fn n(v: &Value, k: &str) -> Option<i32> {
    v.get(k)
        .and_then(Value::as_i64)
        .and_then(|n| i32::try_from(n).ok())
}

fn strings(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

impl Details {
    pub fn from_value(v: &Value) -> Self {
        Self {
            tmdb_id: n(v, "tmdbId"),
            tvdb_id: n(v, "tvdbId"),
            imdb_id: s(v, "imdbId"),
            title: s(v, "title").unwrap_or_default(),
            original_title: s(v, "originalTitle"),
            overview: s(v, "overview"),
            year: v.get("year").and_then(Value::as_f64),
            poster_url: s(v, "posterUrl"),
            fanart_url: s(v, "fanartUrl"),
            logo_url: s(v, "logoUrl"),
            additional_fanart_urls: strings(v, "additionalFanartUrls"),
            rating: v.get("rating").and_then(Value::as_f64),
            genres: strings(v, "genres"),
            runtime: n(v, "runtime"),
            release_date: s(v, "releaseDate"),
            in_cinemas: s(v, "inCinemas"),
            digital_release: s(v, "digitalRelease"),
            physical_release: s(v, "physicalRelease"),
            status: s(v, "status").unwrap_or_default(),
            alternative_titles: strings(v, "alternativeTitles"),
            tmdb_collection_id: n(v, "tmdbCollectionId"),
            tmdb_collection_name: s(v, "tmdbCollectionName"),
            raw: v.clone(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SeasonDetails {
    pub season_number: i32,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub poster_url: Option<String>,
    pub episodes: Vec<EpisodeDetails>,
}

#[derive(Debug, Clone, Default)]
pub struct EpisodeDetails {
    pub episode_number: i32,
    pub title: String,
    pub overview: Option<String>,
    pub air_date: Option<String>,
    pub runtime: Option<i32>,
    pub still_url: Option<String>,
}

impl SeasonDetails {
    fn from_value(v: &Value) -> Self {
        Self {
            season_number: n(v, "seasonNumber").unwrap_or_default(),
            overview: s(v, "overview"),
            air_date: s(v, "airDate"),
            poster_url: s(v, "posterUrl"),
            episodes: v
                .get("episodes")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(EpisodeDetails::from_value).collect())
                .unwrap_or_default(),
        }
    }
}

impl EpisodeDetails {
    fn from_value(v: &Value) -> Self {
        Self {
            episode_number: n(v, "episodeNumber").unwrap_or_default(),
            title: s(v, "title").unwrap_or_default(),
            overview: s(v, "overview"),
            air_date: s(v, "airDate"),
            runtime: n(v, "runtime"),
            still_url: s(v, "stillUrl"),
        }
    }
}

/// A title as read from its provider; `seasons` is every season with full episode lists (series).
#[derive(Debug, Clone)]
pub struct Found {
    pub details: Details,
    pub seasons: Vec<SeasonDetails>,
}

/// What `importMedia` / `importFromTmdb` look up (`media-write.md` rules 16-17).
#[derive(Debug, Clone)]
pub struct Lookup {
    pub media_type: MediaKind,
    /// `None` = default provider.
    pub provider: Option<String>,
    pub external_id: String,
    pub library_id: i32,
}

/// Any provider failure is a generic 500; the reason is only logged.
fn fail(p: Provider, e: Upstream) -> AppError {
    tracing::warn!("metadata request failed on {}: {e}", p.name());
    AppError::plain(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    )
}

fn ext_i64(external_id: &str) -> Result<i64, AppError> {
    external_id
        .parse()
        .map_err(|_| AppError::bad_request("externalId must be a numeric string"))
}

struct Lib {
    preferred: Option<String>,
    over: Override,
}

async fn library(st: &AppState, id: Option<i32>) -> Result<Option<Lib>, sqlx::Error> {
    let Some(id) = id else { return Ok(None) };
    Ok(sqlx::query!(
        r#"SELECT "preferredProvider" AS pref, "metadataLanguage" AS lang, "metadataRegion" AS region
           FROM libraries WHERE id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .map(|r| Lib {
        preferred: r.pref,
        over: Override {
            language: r.lang,
            region: r.region,
        },
    }))
}

async fn language(st: &AppState, lib: Option<&Lib>) -> Result<Resolved, sqlx::Error> {
    st.metadata.lang.resolve(lib.map(|l| &l.over)).await
}

async fn read_details(
    st: &AppState,
    p: Provider,
    kind: MediaKind,
    external_id: &str,
    lang: &Resolved,
) -> Result<Details, AppError> {
    let id = ext_i64(external_id)?;
    let v = st
        .metadata
        .details(p, kind, id, lang)
        .await
        .map_err(|e| fail(p, e))?;
    Ok(Details::from_value(&v))
}

async fn read_seasons(
    st: &AppState,
    p: Provider,
    external_id: &str,
    lang: &Resolved,
) -> Result<Vec<SeasonDetails>, AppError> {
    let id = ext_i64(external_id)?;
    let v = st
        .metadata
        .seasons(p, id, lang)
        .await
        .map_err(|e| fail(p, e))?;
    Ok(v.iter().map(SeasonDetails::from_value).collect())
}

/// The id `target` knows this work by: its own id off the details, else an IMDB lookup.
async fn cross_reference_id(
    st: &AppState,
    target: Provider,
    d: &Details,
    lang: &Resolved,
) -> Result<Option<String>, AppError> {
    match (target, d.tmdb_id, d.tvdb_id) {
        (Provider::Tmdb, Some(id), _) if id != 0 => return Ok(Some(id.to_string())),
        (Provider::Tvdb, _, Some(id)) if id != 0 => return Ok(Some(id.to_string())),
        _ => {}
    }
    let Some(imdb) = d.imdb_id.as_deref().filter(|i| !i.is_empty()) else {
        return Ok(None);
    };
    let found = st
        .metadata
        .find_by_external_id(target, "imdb", imdb, lang)
        .await
        .map_err(|e| fail(target, e))?;
    Ok(found.map(|(id, _)| id))
}

/// `readForLibrary` (rule 16): the details from the provider the library prefers, ids kept from the finder.
async fn read_for_library(
    st: &AppState,
    kind: MediaKind,
    found: Provider,
    external_id: &str,
    lib: Option<&Lib>,
    lang: &Resolved,
) -> Result<(Provider, String, Details), AppError> {
    let details = read_details(st, found, kind, external_id, lang).await?;
    let keep = (found, external_id.to_owned(), details.clone());
    let Some(pref) = lib
        .and_then(|l| l.preferred.as_deref())
        .filter(|p| !p.is_empty())
    else {
        return Ok(keep);
    };
    let target = match Provider::parse(pref) {
        Some(p) if p == found => return Ok(keep),
        Some(p) if st.metadata.available(p) => p,
        _ => {
            tracing::warn!(
                "import: library prefers {pref} but it is not available (no API key?) - importing \"{}\" from {}",
                details.title,
                found.name()
            );
            return Ok(keep);
        }
    };
    let Some(target_id) = cross_reference_id(st, target, &details, lang).await? else {
        tracing::warn!(
            "import: no {pref} id for \"{}\" (cross-reference failed) - importing from {}",
            details.title,
            found.name()
        );
        return Ok(keep);
    };
    let mut preferred = read_details(st, target, kind, &target_id, lang).await?;
    tracing::info!(
        "import: \"{}\" read from {pref} (id={target_id}) - library preference",
        details.title
    );
    if preferred.tmdb_id.is_none_or(|t| t == 0) {
        preferred.tmdb_id = details.tmdb_id;
    }
    preferred.tvdb_id = preferred.tvdb_id.or(details.tvdb_id);
    preferred.imdb_id = preferred.imdb_id.or(details.imdb_id);
    Ok((target, target_id, preferred))
}

/// `importMedia` / `importFromTmdb` reads (rules 16, 17): the title, every season for a series, a missing
/// `tmdbId` filled from the `tvdbId`.
pub async fn import(st: &AppState, l: Lookup) -> Result<Found, AppError> {
    let kind = l.media_type;
    let finder = st.metadata.resolve(l.provider.as_deref());
    let lib = library(st, Some(l.library_id)).await?;
    let lang = language(st, lib.as_ref()).await?;
    let (p, id, mut details) =
        read_for_library(st, kind, finder, &l.external_id, lib.as_ref(), &lang).await?;
    let seasons = if kind.is_series() {
        read_seasons(st, p, &id, &lang).await?
    } else {
        vec![]
    };
    if details.tmdb_id.is_none_or(|t| t == 0)
        && st.metadata.available(Provider::Tmdb)
        && let Some(tvdb) = details.tvdb_id.filter(|t| *t != 0)
    {
        let cross = st
            .metadata
            .find_by_external_id(Provider::Tmdb, "tvdb", &tvdb.to_string(), &lang)
            .await
            .map_err(|e| fail(Provider::Tmdb, e))?;
        if let Some((tmdb, _)) = cross {
            details.tmdb_id = tmdb.parse().ok();
        }
    }
    Ok(Found { details, seasons })
}

/// The columns of a media row the resolution reads.
struct Row {
    id: i32,
    title: String,
    kind: MediaKind,
    tmdb_id: Option<i32>,
    tvdb_id: Option<i32>,
    imdb_id: Option<String>,
    preferred: Option<String>,
    library_id: Option<i32>,
}

impl Row {
    fn label(&self) -> String {
        format!("\"{}\" (#{})", self.title, self.id)
    }
}

async fn load(st: &AppState, id: i32) -> Result<Row, AppError> {
    let r = sqlx::query!(
        r#"SELECT title, type AS "kind!", "tmdbId" AS tmdb, "tvdbId" AS tvdb, "imdbId" AS imdb,
                  "preferredProvider" AS pref, "libraryId" AS lib FROM media WHERE id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("Media #{id} not found")))?;
    Ok(Row {
        id,
        title: r.title,
        kind: crate::db::kind(&r.kind)?,
        tmdb_id: r.tmdb,
        tvdb_id: r.tvdb,
        imdb_id: r.imdb,
        preferred: r.pref,
        library_id: r.lib,
    })
}

type Source = (Provider, String);

async fn set_external(st: &AppState, id: i32, p: Provider, ext: i32) -> Result<(), sqlx::Error> {
    match p {
        Provider::Tmdb => {
            sqlx::query!(r#"UPDATE media SET "tmdbId" = $2 WHERE id = $1"#, id, ext)
                .execute(&st.db)
                .await
        }
        Provider::Tvdb => {
            sqlx::query!(r#"UPDATE media SET "tvdbId" = $2 WHERE id = $1"#, id, ext)
                .execute(&st.db)
                .await
        }
    }
    .map(drop)
}

/// The id `p` knows `m` by, cross-referencing through the other provider (and writing it back).
async fn external_id_for(
    st: &AppState,
    m: &Row,
    p: Provider,
    lang: &Resolved,
) -> Result<Option<String>, AppError> {
    let direct = match p {
        Provider::Tmdb => m.tmdb_id,
        Provider::Tvdb => m.tvdb_id,
    };
    if let Some(id) = direct.filter(|i| *i != 0) {
        return Ok(Some(id.to_string()));
    }
    let label = m.label();
    let found = async |via: Provider, source: &str, id: &str| {
        st.metadata
            .find_by_external_id(via, source, id, lang)
            .await
            .map_err(|e| fail(via, e))
    };
    let imdb = m.imdb_id.as_deref().filter(|i| !i.is_empty());
    match p {
        Provider::Tvdb => {
            if let Some(imdb) = imdb
                && let Some((id, _)) = found(Provider::Tvdb, "imdb", imdb).await?
                && let Ok(n) = id.parse()
            {
                tracing::info!("crossRef: {label} - found tvdbId={id} via IMDB");
                set_external(st, m.id, p, n).await?;
                return Ok(Some(id));
            }
            if let Some(tmdb) = m.tmdb_id.filter(|t| *t != 0) {
                let d = read_details(st, Provider::Tmdb, m.kind, &tmdb.to_string(), lang).await?;
                if let Some(tvdb) = d.tvdb_id.filter(|t| *t != 0) {
                    tracing::info!("crossRef: {label} - found tvdbId={tvdb} via TMDB");
                    set_external(st, m.id, p, tvdb).await?;
                    return Ok(Some(tvdb.to_string()));
                }
            }
        }
        Provider::Tmdb => {
            if let Some(imdb) = imdb
                && let Some((id, _)) = found(Provider::Tmdb, "imdb", imdb).await?
                && let Ok(n) = id.parse()
            {
                tracing::info!("crossRef: {label} - found tmdbId={id} via IMDB");
                set_external(st, m.id, p, n).await?;
                return Ok(Some(id));
            }
            if let Some(tvdb) = m.tvdb_id.filter(|t| *t != 0)
                && let Some((id, _)) = found(Provider::Tmdb, "tvdb", &tvdb.to_string()).await?
                && let Ok(n) = id.parse()
            {
                tracing::info!("crossRef: {label} - found tmdbId={id} via TVDB");
                set_external(st, m.id, p, n).await?;
                return Ok(Some(id));
            }
        }
    }
    tracing::warn!(
        "crossRef: {label} - cross-reference failed for {}",
        p.name()
    );
    Ok(None)
}

async fn try_preferred(
    st: &AppState,
    m: &Row,
    pref: &str,
    origin: &str,
    lang: &Resolved,
) -> Result<Option<Source>, AppError> {
    let label = m.label();
    tracing::info!("resolveProvider: {label} - {origin} prefers {pref}");
    let Some(p) = Provider::parse(pref).filter(|p| st.metadata.available(*p)) else {
        tracing::warn!(
            "resolveProvider: {label} - {origin} preferred {pref} but not available (no API key?)"
        );
        return Ok(None);
    };
    Ok(external_id_for(st, m, p, lang).await?.map(|id| (p, id)))
}

/// `resolveProviderForMedia`: season override (strict), media override (strict), library preference
/// (soft), then whichever id exists.
async fn resolve_provider(
    st: &AppState,
    m: &Row,
    lib: Option<&Lib>,
    lang: &Resolved,
    season_pref: Option<&str>,
) -> Result<Source, AppError> {
    let label = m.label();
    if let Some(pref) = season_pref.filter(|p| !p.is_empty()) {
        return try_preferred(st, m, pref, "season", lang).await?.ok_or_else(|| {
            AppError::bad_request(format!(
                "Season override \"{pref}\" cannot be resolved for {label}: no matching external ID available (check API key + cross-reference)."
            ))
        });
    }
    if let Some(pref) = m.preferred.as_deref().filter(|p| !p.is_empty()) {
        return try_preferred(st, m, pref, "media", lang).await?.ok_or_else(|| {
            AppError::bad_request(format!(
                "Media override \"{pref}\" cannot be resolved for {label}: no matching external ID available."
            ))
        });
    }
    if let Some(pref) = lib
        .and_then(|l| l.preferred.as_deref())
        .filter(|p| !p.is_empty())
    {
        if let Some(r) = try_preferred(st, m, pref, "library", lang).await? {
            return Ok(r);
        }
        tracing::warn!(
            "resolveProvider: {label} - library preferred {pref} but no matching ID found, falling back"
        );
    }
    let id = |v: Option<i32>| v.filter(|i| *i != 0);
    if let Some(t) = id(m.tmdb_id).filter(|_| st.metadata.available(Provider::Tmdb)) {
        return Ok((Provider::Tmdb, t.to_string()));
    }
    if let Some(t) = id(m.tvdb_id).filter(|_| st.metadata.available(Provider::Tvdb)) {
        return Ok((Provider::Tvdb, t.to_string()));
    }
    if let Some(t) = id(m.tmdb_id) {
        return Ok((Provider::Tmdb, t.to_string()));
    }
    if m.imdb_id.as_deref().is_some_and(|i| !i.is_empty())
        && st.metadata.available(Provider::Tmdb)
        && let Some(ext) = external_id_for(st, m, Provider::Tmdb, lang).await?
    {
        return Ok((Provider::Tmdb, ext));
    }
    Err(AppError::bad_request(
        "No provider ID available for this media",
    ))
}

/// `fetchSingleSeason`: TMDB's single-season endpoint, else the provider's full list (cached per run).
async fn single_season(
    st: &AppState,
    (p, ext): &Source,
    number: i32,
    lang: &Resolved,
    cache: &mut HashMap<String, Vec<SeasonDetails>>,
) -> Result<Option<SeasonDetails>, AppError> {
    if *p == Provider::Tmdb {
        let v = st
            .metadata
            .tmdb
            .season(ext_i64(ext)?, i64::from(number), lang)
            .await
            .map_err(|e| fail(*p, e))?;
        return Ok(Some(SeasonDetails::from_value(&v)));
    }
    let key = format!("{}:{ext}", p.name());
    if !cache.contains_key(&key) {
        let all = read_seasons(st, *p, ext, lang).await?;
        cache.insert(key.clone(), all);
    }
    Ok(cache[&key]
        .iter()
        .find(|s| s.season_number == number)
        .cloned())
}

/// Rule 56: the media provider's seasons, a season with its own override replaced by that provider's data
/// (the media-level data when the override cannot be resolved or has no such season).
async fn seasons_of(
    st: &AppState,
    m: &Row,
    lib: Option<&Lib>,
    lang: &Resolved,
    media: &Source,
) -> Result<Vec<SeasonDetails>, AppError> {
    let mut seasons = read_seasons(st, media.0, &media.1, lang).await?;
    let overridden: Vec<(i32, String)> = sqlx::query!(
        r#"SELECT "seasonNumber" AS n, "preferredProvider" AS "pref!" FROM seasons
           WHERE "mediaId" = $1 AND "preferredProvider" IS NOT NULL AND "preferredProvider" <> ''
           ORDER BY id"#,
        m.id
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .filter(|r| r.pref != media.0.name())
    .map(|r| (r.n, r.pref))
    .collect();
    let mut cache = HashMap::new();
    for (number, pref) in overridden {
        let resolved = match resolve_provider(st, m, lib, lang, Some(&pref)).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    "refreshSeriesEpisodes: season S{number} override \"{pref}\" failed - {e}. Falling back to media-level data."
                );
                continue;
            }
        };
        let Some(data) = single_season(st, &resolved, number, lang, &mut cache).await? else {
            tracing::warn!(
                "refreshSeriesEpisodes: season S{number} override \"{pref}\" returned no matching season (numbering mismatch?). Falling back to media-level data."
            );
            continue;
        };
        match seasons.iter_mut().find(|s| s.season_number == number) {
            Some(slot) => *slot = data,
            None => seasons.push(data),
        }
    }
    Ok(seasons)
}

/// Rescan and relink entry point: the seasons only, no details.
pub async fn seasons_for_media(
    st: &AppState,
    media_id: i32,
) -> Result<Vec<SeasonDetails>, AppError> {
    let m = load(st, media_id).await?;
    let lib = library(st, m.library_id).await?;
    let lang = language(st, lib.as_ref()).await?;
    let media = resolve_provider(st, &m, lib.as_ref(), &lang, None).await?;
    seasons_of(st, &m, lib.as_ref(), &lang, &media).await
}

/// `refreshMetadata` reads (rule 53): details from the resolved provider, seasons for a series.
pub async fn for_media(st: &AppState, media_id: i32) -> Result<Found, AppError> {
    let m = load(st, media_id).await?;
    let lib = library(st, m.library_id).await?;
    let lang = language(st, lib.as_ref()).await?;
    let media = resolve_provider(st, &m, lib.as_ref(), &lang, None).await?;
    tracing::info!(
        "refreshMetadata: \"{}\" using provider={} externalId={}",
        m.title,
        media.0.name(),
        media.1
    );
    let details = read_details(st, media.0, m.kind, &media.1, &lang).await?;
    let seasons = if m.kind.is_series() {
        seasons_of(st, &m, lib.as_ref(), &lang, &media).await?
    } else {
        vec![]
    };
    Ok(Found { details, seasons })
}

/// Rule 55: the episode as its season's provider lists it; `None` when the provider has no such episode.
pub async fn episode(st: &AppState, episode_id: i32) -> Result<Option<EpisodeDetails>, AppError> {
    let row = sqlx::query!(
        r#"SELECT e."episodeNumber" AS number, s."seasonNumber" AS season, s."preferredProvider" AS pref,
                  s."mediaId" AS "media_id!"
           FROM episodes e JOIN seasons s ON s.id = e."seasonId" WHERE e.id = $1"#,
        episode_id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("Episode #{episode_id} not found")))?;
    let m = load(st, row.media_id).await?;
    let lib = library(st, m.library_id).await?;
    let lang = language(st, lib.as_ref()).await?;
    let resolved = resolve_provider(st, &m, lib.as_ref(), &lang, row.pref.as_deref()).await?;
    let season = single_season(st, &resolved, row.season, &lang, &mut HashMap::new()).await?;
    Ok(season.and_then(|s| {
        s.episodes
            .into_iter()
            .find(|e| e.episode_number == row.number)
    }))
}

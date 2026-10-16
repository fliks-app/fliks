//! What the media services read from the providers and write back (`media-write.md` rules 16, 17, 53-58):
//! provider choice per library, media and season, cross-references, season overrides and credits.
use super::{MediaKind, Override, Provider, Upstream};
use crate::{
    http::AppError,
    images::paths::Target,
    persons::service::{Person, ensure_details_loaded},
    state::AppState,
};
use fliks_domain::metadata::language::Resolved;
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};

const AVATAR_CONCURRENCY: usize = 8;

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
    raw: Value,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn n(v: &Value, k: &str) -> Option<i32> {
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
    pub media_type: String,
    /// `None` = default provider.
    pub provider: Option<String>,
    pub external_id: String,
    pub library_id: i32,
}

/// Nest answers any provider failure with its generic 500; the reason is only logged.
fn fail(p: Provider, e: Upstream) -> AppError {
    tracing::warn!("metadata request failed on {}: {e}", p.name());
    AppError::plain(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    )
}

fn kind_of(media_type: &str) -> MediaKind {
    if media_type == "movie" {
        MediaKind::Movie
    } else {
        MediaKind::Series
    }
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
    let kind = kind_of(&l.media_type);
    let finder = st.metadata.resolve(l.provider.as_deref());
    let lib = library(st, Some(l.library_id)).await?;
    let lang = language(st, lib.as_ref()).await?;
    let (p, id, mut details) =
        read_for_library(st, kind, finder, &l.external_id, lib.as_ref(), &lang).await?;
    let seasons = if kind.is_tv() {
        read_seasons(st, p, &id, &lang).await?
    } else {
        vec![]
    };
    if details.tmdb_id.is_none_or(|t| t == 0)
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
    sqlx::query!(
        r#"SELECT title, type::text AS "kind!", "tmdbId" AS tmdb, "tvdbId" AS tvdb, "imdbId" AS imdb,
                  "preferredProvider" AS pref, "libraryId" AS lib FROM media WHERE id = $1"#,
        id
    )
    .fetch_optional(&st.db)
    .await?
    .map(|r| Row {
        id,
        title: r.title,
        kind: kind_of(&r.kind),
        tmdb_id: r.tmdb,
        tvdb_id: r.tvdb,
        imdb_id: r.imdb,
        preferred: r.pref,
        library_id: r.lib,
    })
    .ok_or_else(|| AppError::not_found(format!("Media #{id} not found")))
}

type Resolved2 = (Provider, String);

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
            {
                tracing::info!("crossRef: {label} - found tvdbId={id} via IMDB");
                set_external(st, m.id, p, id.parse().unwrap_or_default()).await?;
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
            {
                tracing::info!("crossRef: {label} - found tmdbId={id} via IMDB");
                set_external(st, m.id, p, id.parse().unwrap_or_default()).await?;
                return Ok(Some(id));
            }
            if let Some(tvdb) = m.tvdb_id.filter(|t| *t != 0)
                && let Some((id, _)) = found(Provider::Tmdb, "tvdb", &tvdb.to_string()).await?
            {
                tracing::info!("crossRef: {label} - found tmdbId={id} via TVDB");
                set_external(st, m.id, p, id.parse().unwrap_or_default()).await?;
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
) -> Result<Option<Resolved2>, AppError> {
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
) -> Result<Resolved2, AppError> {
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
    (p, ext): &Resolved2,
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
    media: &Resolved2,
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
    let seasons = if m.kind.is_tv() {
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

fn credits(d: &Details, key: &str) -> Vec<Value> {
    d.raw
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn ext(c: &Value) -> Option<i32> {
    n(c, "externalId")
}

/// `persistMediaMetadata` (rule 58): the `media_metadata` row, persons, cast and crew.
pub async fn persist_credits(st: &AppState, media_id: i32, d: &Details) -> Result<(), AppError> {
    persist_metadata_row(st, media_id, d).await?;
    let provider = d
        .raw
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("tmdb");
    let (cast, crew) = (credits(d, "cast"), credits(d, "crew"));
    let all: Vec<&Value> = cast.iter().chain(&crew).collect();
    let mut unique: Vec<i32> = vec![];
    for id in all.iter().filter_map(|c| ext(c)) {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    let mut people: HashMap<i32, Person> = HashMap::new();
    if !unique.is_empty() {
        people = upsert_persons(st, provider, &unique, &all).await?;
    }
    replace_credits(st, media_id, &cast, &crew, &people).await?;
    if unique.is_empty() {
        return Ok(());
    }
    merge_departments(st, &cast, &crew, &people).await?;
    let lang = st.metadata.lang.resolve(None).await?;
    let mut order: Vec<i32> = people.keys().copied().collect();
    order.sort_unstable();
    for key in order {
        if let Some(p) = people.get_mut(&key) {
            ensure_details_loaded(&st.db, &st.metadata, &st.images, &lang, p).await;
        }
    }
    Ok(())
}

async fn persist_metadata_row(st: &AppState, media_id: i32, d: &Details) -> Result<(), AppError> {
    let r = &d.raw;
    let big = |k: &str| r.get(k).and_then(Value::as_i64);
    let set = |k: &str| r.get(k).is_some();
    let val = |k: &str| r.get(k).filter(|v| !v.is_null()).cloned();
    let (budget, revenue) = (big("budget"), big("revenue"));
    let tagline = s(r, "tagline");
    let popularity = r.get("popularity").and_then(Value::as_f64);
    let votes = n(r, "voteCount");
    let language = s(r, "originalLanguage");
    let (countries, companies, videos, keywords) = (
        val("productionCountries"),
        val("productionCompanies"),
        val("videos"),
        val("keywords"),
    );
    let flags = [
        set("productionCountries"),
        set("productionCompanies"),
        set("videos"),
        set("keywords"),
    ];
    let updated = sqlx::query!(
        r#"UPDATE media_metadata SET budget = COALESCE($2, budget), revenue = COALESCE($3, revenue),
             tagline = COALESCE($4, tagline), popularity = COALESCE($5, popularity),
             "voteCount" = COALESCE($6, "voteCount"), "originalLanguage" = COALESCE($7, "originalLanguage"),
             "productionCountries" = CASE WHEN $8 THEN $12 ELSE "productionCountries" END,
             "productionCompanies" = CASE WHEN $9 THEN $13 ELSE "productionCompanies" END,
             videos = CASE WHEN $10 THEN $14 ELSE videos END,
             keywords = CASE WHEN $11 THEN $15 ELSE keywords END
           WHERE "mediaId" = $1"#,
        media_id,
        budget,
        revenue,
        tagline,
        popularity,
        votes,
        language,
        flags[0],
        flags[1],
        flags[2],
        flags[3],
        countries,
        companies,
        videos,
        keywords
    )
    .execute(&st.db)
    .await?
    .rows_affected();
    if updated == 0 {
        sqlx::query!(
            r#"INSERT INTO media_metadata ("mediaId", budget, revenue, tagline, popularity, "voteCount",
                 "originalLanguage", "productionCountries", "productionCompanies", videos, keywords)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT ("mediaId") DO NOTHING"#,
            media_id,
            budget,
            revenue,
            tagline,
            popularity,
            votes,
            language,
            countries,
            companies,
            videos,
            keywords
        )
        .execute(&st.db)
        .await?;
    }
    Ok(())
}

/// Existing persons by `(provider, tmdbId)`, the missing ones inserted in one statement, avatars and
/// changed names written with a concurrency of 8.
async fn upsert_persons(
    st: &AppState,
    provider: &str,
    ids: &[i32],
    credits: &[&Value],
) -> Result<HashMap<i32, Person>, AppError> {
    let credit_of = |id: i32| credits.iter().find(|c| ext(c) == Some(id)).copied();
    let name_of = |id: i32| credit_of(id).and_then(|c| s(c, "name")).unwrap_or_default();
    let mut rows = person_rows(st, provider, ids).await?;
    let missing: Vec<i32> = ids
        .iter()
        .copied()
        .filter(|i| !rows.contains_key(i))
        .collect();
    let mut fresh: Vec<i32> = vec![];
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|i| name_of(*i)).collect();
        sqlx::query!(
            r#"INSERT INTO persons (provider, "tmdbId", name)
               SELECT $1, t.id, t.name FROM UNNEST($2::int[], $3::text[]) AS t(id, name)
               ON CONFLICT (provider, "tmdbId") DO NOTHING"#,
            provider,
            &missing,
            &names
        )
        .execute(&st.db)
        .await?;
        let inserted = person_rows(st, provider, &missing).await?;
        fresh = inserted.keys().copied().collect();
        rows.extend(inserted);
    }
    let jobs: Vec<(i32, Option<String>, Option<String>)> = ids
        .iter()
        .filter_map(|ext_id| {
            let p = rows.get(ext_id)?;
            let c = credit_of(*ext_id)?;
            let name = s(c, "name").filter(|n| !fresh.contains(ext_id) && *n != p.name);
            let avatar = s(c, "avatarUrl").filter(|a| !a.is_empty());
            (name.is_some() || avatar.is_some()).then_some((p.id, name, avatar))
        })
        .collect();
    stream::iter(jobs)
        .for_each_concurrent(AVATAR_CONCURRENCY, |(id, name, avatar)| async move {
            let local = match avatar {
                Some(url) => st.images.download_and_store(&url, &Target::person(id)).await,
                None => None,
            };
            if name.is_none() && local.is_none() {
                return;
            }
            if let Err(e) = sqlx::query!(
                r#"UPDATE persons SET name = COALESCE($2, name), "avatarUrl" = COALESCE($3, "avatarUrl") WHERE id = $1"#,
                id,
                name,
                local
            )
            .execute(&st.db)
            .await
            {
                tracing::warn!("person #{id} not updated: {e}");
            }
        })
        .await;
    Ok(rows)
}

async fn person_rows(
    st: &AppState,
    provider: &str,
    ids: &[i32],
) -> Result<HashMap<i32, Person>, sqlx::Error> {
    Ok(sqlx::query!(
        r#"SELECT id, "tmdbId" AS tmdb_id, name, "metadataRefreshedAt" AS refreshed FROM persons
           WHERE provider = $1 AND "tmdbId" = ANY($2)"#,
        provider,
        ids
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .map(|r| {
        (
            r.tmdb_id,
            Person {
                id: r.id,
                provider: provider.to_owned(),
                tmdb_id: r.tmdb_id,
                name: r.name,
                refreshed_ms: r.refreshed.map(|t| t.timestamp_millis()),
            },
        )
    })
    .collect())
}

/// `media_cast` and `media_crew` replaced in one transaction.
async fn replace_credits(
    st: &AppState,
    media_id: i32,
    cast: &[Value],
    crew: &[Value],
    people: &HashMap<i32, Person>,
) -> Result<(), sqlx::Error> {
    let person = |c: &Value| ext(c).and_then(|e| people.get(&e)).map(|p| p.id);
    let text = |c: &Value, k: &str| s(c, k).unwrap_or_default();
    let mut tx = st.db.begin().await?;
    sqlx::query!(r#"DELETE FROM media_cast WHERE "mediaId" = $1"#, media_id)
        .execute(&mut *tx)
        .await?;
    if !cast.is_empty() {
        let (ids, chars, order): (Vec<Option<i32>>, Vec<String>, Vec<i32>) = cast
            .iter()
            .map(|c| (person(c), text(c, "character"), n(c, "order").unwrap_or(0)))
            .collect();
        sqlx::query!(
            r#"INSERT INTO media_cast ("mediaId", "personId", character, "order")
               SELECT $1, t.p, t.c, t.o FROM UNNEST($2::int[], $3::text[], $4::int[]) AS t(p, c, o)"#,
            media_id,
            &ids as &[Option<i32>],
            &chars,
            &order
        )
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query!(r#"DELETE FROM media_crew WHERE "mediaId" = $1"#, media_id)
        .execute(&mut *tx)
        .await?;
    if !crew.is_empty() {
        let (ids, jobs, depts): (Vec<Option<i32>>, Vec<String>, Vec<String>) = crew
            .iter()
            .map(|c| (person(c), text(c, "job"), text(c, "department")))
            .collect();
        sqlx::query!(
            r#"INSERT INTO media_crew ("mediaId", "personId", job, department)
               SELECT $1, t.p, t.j, t.d FROM UNNEST($2::int[], $3::text[], $4::text[]) AS t(p, j, d)"#,
            media_id,
            &ids as &[Option<i32>],
            &jobs,
            &depts
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Each person's departments merged with the ones this title gives them, sorted.
async fn merge_departments(
    st: &AppState,
    cast: &[Value],
    crew: &[Value],
    people: &HashMap<i32, Person>,
) -> Result<(), sqlx::Error> {
    let mut wanted: HashMap<i32, BTreeSet<String>> = HashMap::new();
    for c in cast {
        if let Some(e) = ext(c) {
            wanted.entry(e).or_default().insert("Acting".into());
        }
    }
    for c in crew {
        if let Some(e) = ext(c) {
            wanted
                .entry(e)
                .or_default()
                .insert(s(c, "department").unwrap_or_default());
        }
    }
    for (e, new) in wanted {
        let Some(p) = people.get(&e) else { continue };
        let mut merged: BTreeSet<String> = sqlx::query_scalar!(
            r#"SELECT departments AS "d!: Value" FROM persons WHERE id = $1"#,
            p.id
        )
        .fetch_optional(&st.db)
        .await?
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
        .into_iter()
        .collect();
        merged.extend(new);
        sqlx::query!(
            "UPDATE persons SET departments = $2 WHERE id = $1",
            p.id,
            json!(merged.into_iter().collect::<Vec<_>>())
        )
        .execute(&st.db)
        .await?;
    }
    Ok(())
}

//! What the media services read from the providers and write back (`media-write.md` rules 16, 17, 53-58):
//! provider choice per library, media and season, cross-references, season overrides and credits.
use super::{MetaError, Override, Upstream};
use crate::{
    http::AppError,
    media::{external_ids, field_sources::locked_fields},
    state::AppState,
};
use fliks_domain::external_id::ExternalProvider;
use fliks_domain::media::kind::MediaKind;
use fliks_domain::metadata::{
    field::Field,
    language::Resolved,
    limiter::Priority,
    merge::{FieldOrder, Provenance, merge},
};
use serde_json::{Map, Value};
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
    pub(crate) raw: Value,
}

pub(crate) fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

pub(crate) fn n(v: &Value, k: &str) -> Option<i32> {
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
    /// The TMDB collection the provider names, its name `''` when it gives none.
    pub fn tmdb_collection(&self) -> Option<(i32, &str)> {
        let id = self.tmdb_collection_id?;
        Some((id, self.tmdb_collection_name.as_deref().unwrap_or_default()))
    }

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
    /// The media's locked fields, left out of `details`.
    pub locked: Vec<Field>,
    pub provenance: Provenance,
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
fn fail(p: ExternalProvider, e: Upstream) -> AppError {
    tracing::warn!("metadata request failed on {}: {e}", p.as_str());
    AppError::plain(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        "Internal server error",
    )
}

fn fail_meta(p: ExternalProvider, e: MetaError) -> AppError {
    match e {
        MetaError::Upstream(e) => fail(p, e),
        MetaError::Db(e) => e.into(),
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

async fn read_record(
    st: &AppState,
    p: ExternalProvider,
    kind: MediaKind,
    external_id: &str,
    lang: &Resolved,
    prio: Priority,
) -> Result<Map<String, Value>, AppError> {
    ext_i64(external_id)?;
    let v = st
        .metadata
        .work(p, kind, external_id, lang, prio)
        .await
        .map_err(|e| fail_meta(p, e))?;
    Ok(match v {
        Value::Object(o) => o,
        _ => Map::new(),
    })
}

async fn read_details(
    st: &AppState,
    p: ExternalProvider,
    kind: MediaKind,
    external_id: &str,
    lang: &Resolved,
    prio: Priority,
) -> Result<Details, AppError> {
    let record = read_record(st, p, kind, external_id, lang, prio).await?;
    Ok(Details::from_value(&Value::Object(record)))
}

async fn read_seasons(
    st: &AppState,
    p: ExternalProvider,
    external_id: &str,
    lang: &Resolved,
    prio: Priority,
) -> Result<Vec<SeasonDetails>, AppError> {
    ext_i64(external_id)?;
    let v = st
        .metadata
        .children(p, external_id, lang, prio)
        .await
        .map_err(|e| fail_meta(p, e))?;
    Ok(v.iter().map(SeasonDetails::from_value).collect())
}

/// The id `target` knows this work by: its own id off the details, else an IMDB lookup.
async fn cross_reference_id(
    st: &AppState,
    target: ExternalProvider,
    d: &Details,
    lang: &Resolved,
    prio: Priority,
) -> Result<Option<String>, AppError> {
    match (target, d.tmdb_id, d.tvdb_id) {
        (ExternalProvider::Tmdb, Some(id), _) if id != 0 => return Ok(Some(id.to_string())),
        (ExternalProvider::Tvdb, _, Some(id)) if id != 0 => return Ok(Some(id.to_string())),
        _ => {}
    }
    let Some(imdb) = d.imdb_id.as_deref().filter(|i| !i.is_empty()) else {
        return Ok(None);
    };
    let found = st
        .metadata
        .of(target)
        .find_by(ExternalProvider::Imdb, imdb, lang, prio)
        .await
        .map_err(|e| fail(target, e))?;
    Ok(found.map(|(id, _)| id))
}

/// The details and provenance of `records` merged in the order of `first`.
fn merged(
    kind: MediaKind,
    records: &[(ExternalProvider, Map<String, Value>)],
    first: ExternalProvider,
    locked: &[Field],
) -> (Details, Provenance) {
    let (m, provenance) = merge(records, &FieldOrder::new(kind, &[first]), locked);
    (Details::from_value(&Value::Object(m)), provenance)
}

/// `readForLibrary` (rule 16): the details from the provider the library prefers, ids kept from the finder.
async fn read_for_library(
    st: &AppState,
    kind: MediaKind,
    found: ExternalProvider,
    external_id: &str,
    lib: Option<&Lib>,
    lang: &Resolved,
    prio: Priority,
) -> Result<(ExternalProvider, String, Details, Provenance), AppError> {
    let record = read_record(st, found, kind, external_id, lang, prio).await?;
    let details = Details::from_value(&Value::Object(record.clone()));
    let keep = |record| {
        let (d, p) = merged(kind, &[(found, record)], found, &[]);
        (found, external_id.to_owned(), d, p)
    };
    let Some(pref) = lib
        .and_then(|l| l.preferred.as_deref())
        .filter(|p| !p.is_empty())
    else {
        return Ok(keep(record));
    };
    let target = match ExternalProvider::parse(pref) {
        Some(p) if p == found => return Ok(keep(record)),
        Some(p) if st.metadata.available(p) => p,
        _ => {
            tracing::warn!(
                "import: library prefers {pref} but it is not available (no API key?) - importing \"{}\" from {}",
                details.title,
                found.as_str()
            );
            return Ok(keep(record));
        }
    };
    let Some(target_id) = cross_reference_id(st, target, &details, lang, prio).await? else {
        tracing::warn!(
            "import: no {pref} id for \"{}\" (cross-reference failed) - importing from {}",
            details.title,
            found.as_str()
        );
        return Ok(keep(record));
    };
    let preferred = read_record(st, target, kind, &target_id, lang, prio).await?;
    tracing::info!(
        "import: \"{}\" read from {pref} (id={target_id}) - library preference",
        details.title
    );
    let ids = |r: &Map<String, Value>| -> Map<String, Value> {
        let own = |k: &String| Field::Ids.keys().contains(&k.as_str());
        r.iter()
            .filter(|(k, _)| own(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    };
    let (d, p) = merged(
        kind,
        &[(target, preferred), (found, ids(&record))],
        target,
        &[],
    );
    Ok((target, target_id, d, p))
}

/// `importMedia` / `importFromTmdb` reads (rules 16, 17): the title, every season for a series, a missing
/// `tmdbId` filled from the `tvdbId`.
pub async fn import(st: &AppState, l: Lookup, prio: Priority) -> Result<Found, AppError> {
    let kind = l.media_type;
    let finder = st
        .metadata
        .resolve(l.provider.as_deref(), kind)
        .unwrap_or(ExternalProvider::Tmdb);
    let lib = library(st, Some(l.library_id)).await?;
    let lang = language(st, lib.as_ref()).await?;
    let (p, id, mut details, provenance) =
        read_for_library(st, kind, finder, &l.external_id, lib.as_ref(), &lang, prio).await?;
    let seasons = if kind.has_seasons() {
        read_seasons(st, p, &id, &lang, prio).await?
    } else {
        vec![]
    };
    if details.tmdb_id.is_none_or(|t| t == 0)
        && st.metadata.available(ExternalProvider::Tmdb)
        && let Some(tvdb) = details.tvdb_id.filter(|t| *t != 0)
    {
        let cross = st
            .metadata
            .of(ExternalProvider::Tmdb)
            .find_by(ExternalProvider::Tvdb, &tvdb.to_string(), &lang, prio)
            .await
            .map_err(|e| fail(ExternalProvider::Tmdb, e))?;
        if let Some((tmdb, _)) = cross {
            details.tmdb_id = tmdb.parse().ok();
        }
    }
    Ok(Found {
        details,
        seasons,
        locked: vec![],
        provenance,
    })
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
        r#"SELECT m.title, m.type AS "kind!", ids.tmdb, ids.tvdb, ids.imdb,
                  m."preferredProvider" AS pref, m."libraryId" AS lib
           FROM media m
           LEFT JOIN LATERAL (SELECT max(value) FILTER (WHERE provider = $2)::int AS tmdb,
             max(value) FILTER (WHERE provider = $3)::int AS tvdb,
             max(value) FILTER (WHERE provider = $4) AS imdb
           FROM media_external_ids WHERE "mediaId" = m.id) ids ON true
           WHERE m.id = $1"#,
        id,
        external_ids::TMDB,
        external_ids::TVDB,
        external_ids::IMDB
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

type Source = (ExternalProvider, String);

/// Links a cross-referenced id; one another media of the kind holds stays with that media.
async fn set_external(
    st: &AppState,
    m: &Row,
    p: ExternalProvider,
    ext: i32,
) -> Result<(), sqlx::Error> {
    let mut c = st.db.acquire().await?;
    match external_ids::link(&mut c, m.id, m.kind, p, &ext.to_string()).await? {
        external_ids::Link::Taken => tracing::warn!(
            "crossRef: {} - {} id {ext} belongs to another title",
            m.label(),
            p.as_str()
        ),
        external_ids::Link::Gone => tracing::info!("crossRef: {} was removed", m.label()),
        external_ids::Link::Linked => {}
    }
    Ok(())
}

/// The id `p` knows `m` by, cross-referencing through the other provider (and writing it back).
async fn external_id_for(
    st: &AppState,
    m: &Row,
    p: ExternalProvider,
    lang: &Resolved,
    prio: Priority,
) -> Result<Option<String>, AppError> {
    let direct = match p {
        ExternalProvider::Tmdb => m.tmdb_id,
        ExternalProvider::Tvdb => m.tvdb_id,
        _ => None,
    };
    if let Some(id) = direct.filter(|i| *i != 0) {
        return Ok(Some(id.to_string()));
    }
    let label = m.label();
    let found = async |via: ExternalProvider, source: ExternalProvider, id: &str| {
        st.metadata
            .of(via)
            .find_by(source, id, lang, prio)
            .await
            .map_err(|e| fail(via, e))
    };
    let imdb = m.imdb_id.as_deref().filter(|i| !i.is_empty());
    match p {
        ExternalProvider::Tvdb => {
            if let Some(imdb) = imdb
                && let Some((id, _)) =
                    found(ExternalProvider::Tvdb, ExternalProvider::Imdb, imdb).await?
                && let Ok(n) = id.parse()
            {
                tracing::info!("crossRef: {label} - found tvdbId={id} via IMDB");
                set_external(st, m, p, n).await?;
                return Ok(Some(id));
            }
            if let Some(tmdb) = m.tmdb_id.filter(|t| *t != 0) {
                let d = read_details(
                    st,
                    ExternalProvider::Tmdb,
                    m.kind,
                    &tmdb.to_string(),
                    lang,
                    prio,
                )
                .await?;
                if let Some(tvdb) = d.tvdb_id.filter(|t| *t != 0) {
                    tracing::info!("crossRef: {label} - found tvdbId={tvdb} via TMDB");
                    set_external(st, m, p, tvdb).await?;
                    return Ok(Some(tvdb.to_string()));
                }
            }
        }
        ExternalProvider::Tmdb => {
            if let Some(imdb) = imdb
                && let Some((id, _)) =
                    found(ExternalProvider::Tmdb, ExternalProvider::Imdb, imdb).await?
                && let Ok(n) = id.parse()
            {
                tracing::info!("crossRef: {label} - found tmdbId={id} via IMDB");
                set_external(st, m, p, n).await?;
                return Ok(Some(id));
            }
            if let Some(tvdb) = m.tvdb_id.filter(|t| *t != 0)
                && let Some((id, _)) = found(
                    ExternalProvider::Tmdb,
                    ExternalProvider::Tvdb,
                    &tvdb.to_string(),
                )
                .await?
                && let Ok(n) = id.parse()
            {
                tracing::info!("crossRef: {label} - found tmdbId={id} via TVDB");
                set_external(st, m, p, n).await?;
                return Ok(Some(id));
            }
        }
        _ => {}
    }
    tracing::warn!(
        "crossRef: {label} - cross-reference failed for {}",
        p.as_str()
    );
    Ok(None)
}

async fn try_preferred(
    st: &AppState,
    m: &Row,
    pref: &str,
    origin: &str,
    lang: &Resolved,
    prio: Priority,
) -> Result<Option<Source>, AppError> {
    let label = m.label();
    tracing::info!("resolveProvider: {label} - {origin} prefers {pref}");
    let Some(p) = ExternalProvider::parse(pref).filter(|p| st.metadata.available(*p)) else {
        tracing::warn!(
            "resolveProvider: {label} - {origin} preferred {pref} but not available (no API key?)"
        );
        return Ok(None);
    };
    Ok(external_id_for(st, m, p, lang, prio)
        .await?
        .map(|id| (p, id)))
}

/// `resolveProviderForMedia`: season override (strict), media override (strict), library preference
/// (soft), then whichever id exists.
async fn resolve_provider(
    st: &AppState,
    m: &Row,
    lib: Option<&Lib>,
    lang: &Resolved,
    season_pref: Option<&str>,
    prio: Priority,
) -> Result<Source, AppError> {
    let label = m.label();
    if let Some(pref) = season_pref.filter(|p| !p.is_empty()) {
        return try_preferred(st, m, pref, "season", lang, prio).await?.ok_or_else(|| {
            AppError::bad_request(format!(
                "Season override \"{pref}\" cannot be resolved for {label}: no matching external ID available (check API key + cross-reference)."
            ))
        });
    }
    if let Some(pref) = m.preferred.as_deref().filter(|p| !p.is_empty()) {
        return try_preferred(st, m, pref, "media", lang, prio).await?.ok_or_else(|| {
            AppError::bad_request(format!(
                "Media override \"{pref}\" cannot be resolved for {label}: no matching external ID available."
            ))
        });
    }
    if let Some(pref) = lib
        .and_then(|l| l.preferred.as_deref())
        .filter(|p| !p.is_empty())
    {
        if let Some(r) = try_preferred(st, m, pref, "library", lang, prio).await? {
            return Ok(r);
        }
        tracing::warn!(
            "resolveProvider: {label} - library preferred {pref} but no matching ID found, falling back"
        );
    }
    let id = |v: Option<i32>| v.filter(|i| *i != 0);
    if let Some(t) = id(m.tmdb_id).filter(|_| st.metadata.available(ExternalProvider::Tmdb)) {
        return Ok((ExternalProvider::Tmdb, t.to_string()));
    }
    if let Some(t) = id(m.tvdb_id).filter(|_| st.metadata.available(ExternalProvider::Tvdb)) {
        return Ok((ExternalProvider::Tvdb, t.to_string()));
    }
    if let Some(t) = id(m.tmdb_id) {
        return Ok((ExternalProvider::Tmdb, t.to_string()));
    }
    if m.imdb_id.as_deref().is_some_and(|i| !i.is_empty())
        && st.metadata.available(ExternalProvider::Tmdb)
        && let Some(ext) = external_id_for(st, m, ExternalProvider::Tmdb, lang, prio).await?
    {
        return Ok((ExternalProvider::Tmdb, ext));
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
    prio: Priority,
) -> Result<Option<SeasonDetails>, AppError> {
    if *p == ExternalProvider::Tmdb {
        let v = st
            .metadata
            .tmdb
            .season(ext_i64(ext)?, i64::from(number), lang, prio)
            .await
            .map_err(|e| fail(*p, e))?;
        return Ok(Some(SeasonDetails::from_value(&v)));
    }
    let key = format!("{}:{ext}", p.as_str());
    if !cache.contains_key(&key) {
        let all = read_seasons(st, *p, ext, lang, prio).await?;
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
    prio: Priority,
) -> Result<Vec<SeasonDetails>, AppError> {
    let mut seasons = read_seasons(st, media.0, &media.1, lang, prio).await?;
    let overridden: Vec<(i32, String)> = sqlx::query!(
        r#"SELECT "number" AS n, "preferredProvider" AS "pref!" FROM item_groups
           WHERE "mediaId" = $1 AND "preferredProvider" IS NOT NULL AND "preferredProvider" <> ''
           ORDER BY id"#,
        m.id
    )
    .fetch_all(&st.db)
    .await?
    .into_iter()
    .filter(|r| r.pref != media.0.as_str())
    .map(|r| (r.n, r.pref))
    .collect();
    let mut cache = HashMap::new();
    for (number, pref) in overridden {
        let resolved = match resolve_provider(st, m, lib, lang, Some(&pref), prio).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(
                    "refreshSeriesEpisodes: season S{number} override \"{pref}\" failed - {e}. Falling back to media-level data."
                );
                continue;
            }
        };
        let Some(data) = single_season(st, &resolved, number, lang, &mut cache, prio).await? else {
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
    prio: Priority,
) -> Result<Vec<SeasonDetails>, AppError> {
    let m = load(st, media_id).await?;
    let lib = library(st, m.library_id).await?;
    let lang = language(st, lib.as_ref()).await?;
    let media = resolve_provider(st, &m, lib.as_ref(), &lang, None, prio).await?;
    seasons_of(st, &m, lib.as_ref(), &lang, &media, prio).await
}

/// `refreshMetadata` reads (rule 53): details from the resolved provider, seasons for a series.
pub async fn for_media(st: &AppState, media_id: i32, prio: Priority) -> Result<Found, AppError> {
    let m = load(st, media_id).await?;
    let lib = library(st, m.library_id).await?;
    let lang = language(st, lib.as_ref()).await?;
    let media = resolve_provider(st, &m, lib.as_ref(), &lang, None, prio).await?;
    tracing::info!(
        "refreshMetadata: \"{}\" using provider={} externalId={}",
        m.title,
        media.0.as_str(),
        media.1
    );
    let record = read_record(st, media.0, m.kind, &media.1, &lang, prio).await?;
    let locked = locked_fields(&st.db, m.id).await?;
    let (details, provenance) = merged(m.kind, &[(media.0, record)], media.0, &locked);
    let seasons = if m.kind.has_seasons() {
        seasons_of(st, &m, lib.as_ref(), &lang, &media, prio).await?
    } else {
        vec![]
    };
    Ok(Found {
        details,
        seasons,
        locked,
        provenance,
    })
}

/// Rule 55: the episode as its season's provider lists it; `None` when the provider has no such episode.
pub async fn episode(
    st: &AppState,
    episode_id: i32,
    prio: Priority,
) -> Result<Option<EpisodeDetails>, AppError> {
    let row = sqlx::query!(
        r#"SELECT e."number" AS "number!", s."number" AS season, s."preferredProvider" AS pref,
                  s."mediaId" AS "media_id!"
           FROM items e JOIN item_groups s ON s.id = e."groupId" WHERE e.id = $1"#,
        episode_id
    )
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("Episode #{episode_id} not found")))?;
    let m = load(st, row.media_id).await?;
    let lib = library(st, m.library_id).await?;
    let lang = language(st, lib.as_ref()).await?;
    let resolved = resolve_provider(st, &m, lib.as_ref(), &lang, row.pref.as_deref(), prio).await?;
    let season = single_season(st, &resolved, row.season, &lang, &mut HashMap::new(), prio).await?;
    Ok(season.and_then(|s| {
        s.episodes
            .into_iter()
            .find(|e| e.episode_number == row.number)
    }))
}

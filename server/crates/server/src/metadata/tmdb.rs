//! TMDB v3 client and response mapping (`metadata.md` rules 17, 24-29, 31, 33-34).
use super::{
    http::{Guarded, Upstream},
    map::{
        arr, get, image, nn, num_or_null, or, pluck, put, score, str_lower_or, text, text_or_null,
        year_of,
    },
    provider::{Call, MetadataProvider, Search, numeric},
    types::{Credits, PersonDetails},
};
use crate::sync::MutexExt;
use fliks_domain::{
    external_id::ExternalProvider,
    media::kind::MediaKind,
    metadata::{
        discover::Options,
        language::Resolved,
        limiter::{Limits, Priority},
    },
};
use futures_util::{StreamExt, stream};
use serde_json::{Map, Value, json};
use std::{collections::HashMap, sync::Mutex, time::Duration};

pub const API_URL: &str = "https://api.themoviedb.org/3";
pub const IMAGE_URL: &str = "https://image.tmdb.org/t/p";
const MAX_ADDITIONAL_FANARTS: usize = 5;
const SEASON_FETCH_CONCURRENCY: usize = 8;
/// TMDB documents about 50 requests a second.
const LIMITS: Limits = Limits {
    rate_per_sec: 40.0,
    burst: 40,
    daily_quota: None,
    background_share: 0.75,
};

pub struct Tmdb {
    http: Guarded,
    img: String,
    /// Last good copy of each global list (rule 17); never expires.
    stale: Mutex<HashMap<String, Value>>,
}

type Query = Vec<(String, String)>;

fn q(pairs: &[(&str, &str)]) -> Query {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn results(v: &Value) -> Result<&[Value], Upstream> {
    v.get("results")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| Upstream::new(None, "Cannot read properties of undefined (reading 'map')"))
}

impl Tmdb {
    pub fn new(base: &str, img: &str, key: &str, timeout: Duration) -> Self {
        Self {
            http: Guarded::new(
                "tmdb",
                base,
                timeout,
                vec![("api_key".into(), key.to_owned())],
                LIMITS,
            ),
            img: img.trim_end_matches('/').to_owned(),
            stale: Mutex::default(),
        }
    }

    async fn get(&self, path: &str, query: Query, p: Priority) -> Result<Value, Upstream> {
        self.http.get_json(path, &query, p).await
    }

    /// Serves the last good copy of `key` when a live fetch fails; a cold failure propagates.
    async fn with_stale(
        &self,
        key: String,
        fetch: impl Future<Output = Result<Value, Upstream>>,
    ) -> Result<Value, Upstream> {
        match fetch.await {
            Ok(v) => {
                self.stale.lock_clean().insert(key, v.clone());
                Ok(v)
            }
            Err(e) => match self.stale.lock_clean().get(&key) {
                Some(v) => {
                    tracing::warn!("TMDB {key} unavailable, serving last cached copy");
                    Ok(v.clone())
                }
                None => Err(e),
            },
        }
    }

    fn list(&self, data: &Value, tv: bool) -> Result<Value, Upstream> {
        Ok(Value::Array(
            results(data)?.iter().map(|r| self.result(r, tv)).collect(),
        ))
    }

    pub fn result(&self, r: &Value, tv: bool) -> Value {
        let (title, original, date) = if tv {
            ("name", "original_name", "first_air_date")
        } else {
            ("title", "original_title", "release_date")
        };
        let mut o = Map::new();
        put(&mut o, "tmdbId", r, "id");
        o.insert("provider".into(), "tmdb".into());
        put(&mut o, "title", r, title);
        put(&mut o, "originalTitle", r, original);
        put(&mut o, "overview", r, "overview");
        o.insert("year".into(), year_of(r, date));
        o.insert(
            "posterUrl".into(),
            image(&self.img, "w500", r, "poster_path"),
        );
        o.insert(
            "fanartUrl".into(),
            image(&self.img, "original", r, "backdrop_path"),
        );
        o.insert("rating".into(), or(r, "vote_average", json!(0)));
        o.insert("genres".into(), json!([]));
        o.insert("genreIds".into(), or(r, "genre_ids", json!([])));
        o.insert("mediaType".into(), MediaKind::from_tv(tv).as_str().into());
        Value::Object(o)
    }

    pub async fn search_titles(
        &self,
        tv: bool,
        query: &str,
        year: Option<i64>,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Vec<Value>, Upstream> {
        let mut params = q(&[("query", query), ("language", &lang.tmdb_locale)]);
        if let Some(y) = year {
            params.push((
                if tv { "first_air_date_year" } else { "year" }.into(),
                y.to_string(),
            ));
        }
        let data = self
            .get(if tv { "/search/tv" } else { "/search/movie" }, params, p)
            .await?;
        results(&data)?
            .iter()
            .map(|r| Ok(self.result(r, tv)))
            .collect()
    }

    pub async fn trending(
        &self,
        tv: bool,
        window: &str,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Value, Upstream> {
        let kind = if tv { "tv" } else { "movie" };
        let key = format!("trending:{kind}:{window}:{}", lang.tmdb_locale);
        let path = format!("/trending/{kind}/{window}");
        self.with_stale(key, async {
            let d = self
                .get(&path, q(&[("language", &lang.tmdb_locale)]), p)
                .await?;
            self.list(&d, tv)
        })
        .await
    }

    pub async fn popular(&self, tv: bool, lang: &Resolved, p: Priority) -> Result<Value, Upstream> {
        let kind = if tv { "tv" } else { "movie" };
        let key = format!("popular:{kind}:{}", lang.tmdb_locale);
        self.with_stale(key, async {
            let d = self
                .get(
                    &format!("/{kind}/popular"),
                    q(&[("language", &lang.tmdb_locale)]),
                    p,
                )
                .await?;
            self.list(&d, tv)
        })
        .await
    }

    pub async fn upcoming(
        &self,
        tv: bool,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Value, Upstream> {
        let (key, path, params) = if tv {
            (
                format!("upcoming:tv:{}", lang.tmdb_locale),
                "/tv/on_the_air",
                q(&[("language", &lang.tmdb_locale)]),
            )
        } else {
            (
                format!("upcoming:movie:{}:{}", lang.tmdb_locale, lang.region),
                "/movie/upcoming",
                q(&[("language", &lang.tmdb_locale), ("region", &lang.region)]),
            )
        };
        self.with_stale(key, async {
            let d = self.get(path, params, p).await?;
            self.list(&d, tv)
        })
        .await
    }

    pub async fn genres(&self, tv: bool, lang: &Resolved, p: Priority) -> Result<Value, Upstream> {
        let kind = if tv { "tv" } else { "movie" };
        let key = format!("genres:{kind}:{}", lang.tmdb_locale);
        self.with_stale(key, async {
            let d = self
                .get(
                    &format!("/genre/{kind}/list"),
                    q(&[("language", &lang.tmdb_locale)]),
                    p,
                )
                .await?;
            Ok(d.get("genres").cloned().unwrap_or(Value::Null))
        })
        .await
    }

    pub async fn discover(
        &self,
        tv: bool,
        opts: &Options,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Vec<Value>, Upstream> {
        let params = fliks_domain::metadata::discover::params(opts, &lang.tmdb_locale, tv);
        let d = self
            .get(
                if tv {
                    "/discover/tv"
                } else {
                    "/discover/movie"
                },
                params,
                p,
            )
            .await?;
        results(&d)?
            .iter()
            .map(|r| Ok(self.result(r, tv)))
            .collect()
    }

    pub async fn details(
        &self,
        tv: bool,
        id: i64,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Value, Upstream> {
        let (path, append) = if tv {
            (
                format!("/tv/{id}"),
                "external_ids,images,credits,videos,keywords,alternative_titles",
            )
        } else {
            (
                format!("/movie/{id}"),
                "external_ids,images,release_dates,credits,videos,keywords,alternative_titles",
            )
        };
        let d = self
            .get(
                &path,
                q(&[
                    ("language", &lang.tmdb_locale),
                    ("include_image_language", &lang.include_image_language),
                    ("append_to_response", append),
                ]),
                p,
            )
            .await?;
        Ok(if tv {
            self.map_tv_details(&d, lang)
        } else {
            self.map_movie_details(&d, lang)
        })
    }

    fn credits(&self, d: &Value) -> (Value, Value) {
        let url = |c: &Value| image(&self.img, "w185", c, "profile_path");
        let cast = arr(get(d, "credits"), "cast")
            .iter()
            .map(|c| {
                let mut o = Map::new();
                put(&mut o, "externalId", c, "id");
                put(&mut o, "name", c, "name");
                put(&mut o, "character", c, "character");
                o.insert("avatarUrl".into(), url(c));
                put(&mut o, "order", c, "order");
                Value::Object(o)
            })
            .collect();
        let crew = arr(get(d, "credits"), "crew")
            .iter()
            .map(|c| {
                let mut o = Map::new();
                put(&mut o, "externalId", c, "id");
                put(&mut o, "name", c, "name");
                put(&mut o, "job", c, "job");
                put(&mut o, "department", c, "department");
                o.insert("avatarUrl".into(), url(c));
                Value::Object(o)
            })
            .collect();
        (Value::Array(cast), Value::Array(crew))
    }

    /// Fields both details shapes share.
    fn common_details(&self, d: &Value, lang: &Resolved, tv: bool) -> Map<String, Value> {
        let mut o = Map::new();
        o.insert("tmdbId".into(), nn(d, "id"));
        o.insert("provider".into(), "tmdb".into());
        o.insert("overview".into(), nn(d, "overview"));
        o.insert(
            "posterUrl".into(),
            image(&self.img, "w500", d, "poster_path"),
        );
        o.insert(
            "fanartUrl".into(),
            image(&self.img, "original", d, "backdrop_path"),
        );
        o.insert(
            "logoUrl".into(),
            pick_logo(&self.img, get(d, "images"), lang.logo_iso1),
        );
        o.insert(
            "additionalFanartUrls".into(),
            pick_additional_fanarts(&self.img, get(d, "images"), get(d, "backdrop_path")).into(),
        );
        o.insert("rating".into(), or(d, "vote_average", json!(0)));
        o.insert("genres".into(), pluck(arr(d, "genres"), "name").into());
        o.insert("genreIds".into(), pluck(arr(d, "genres"), "id").into());
        o.insert("mediaType".into(), MediaKind::from_tv(tv).as_str().into());
        o.insert("originalLanguage".into(), nn(d, "original_language"));
        o.insert("voteCount".into(), nn(d, "vote_count"));
        o.insert("popularity".into(), nn(d, "popularity"));
        o.insert("tagline".into(), text_or_null(d, "tagline"));
        let (cast, crew) = self.credits(d);
        o.insert("cast".into(), cast);
        o.insert("crew".into(), crew);
        let videos = arr(get(d, "videos"), "results")
            .iter()
            .map(|v| {
                let mut m = Map::new();
                for k in ["key", "site", "type", "name"] {
                    put(&mut m, k, v, k);
                }
                Value::Object(m)
            })
            .collect::<Vec<_>>();
        o.insert("videos".into(), videos.into());
        o
    }

    pub fn map_movie_details(&self, d: &Value, lang: &Resolved) -> Value {
        let mut o = self.common_details(d, lang, false);
        let dates = release_dates(
            arr(get(d, "release_dates"), "results"),
            &lang.release_date_priority,
        );
        let imdb = match get(get(d, "external_ids"), "imdb_id") {
            Value::Null => nn(d, "imdb_id"),
            x => x.clone(),
        };
        o.insert("tvdbId".into(), Value::Null);
        o.insert("seasonCount".into(), Value::Null);
        o.insert("episodeCount".into(), Value::Null);
        o.insert("imdbId".into(), imdb);
        o.insert("title".into(), nn(d, "title"));
        o.insert("originalTitle".into(), nn(d, "original_title"));
        o.insert("year".into(), year_of(d, "release_date"));
        o.insert("runtime".into(), nn(d, "runtime"));
        o.insert("releaseDate".into(), nn(d, "release_date"));
        o.insert("inCinemas".into(), dates.0.map_or(Value::Null, Value::from));
        o.insert(
            "digitalRelease".into(),
            dates.1.map_or(Value::Null, Value::from),
        );
        o.insert(
            "physicalRelease".into(),
            dates.2.map_or(Value::Null, Value::from),
        );
        o.insert("status".into(), str_lower_or(d, "status", "unknown").into());
        o.insert("budget".into(), num_or_null(d, "budget"));
        o.insert("revenue".into(), num_or_null(d, "revenue"));
        o.insert(
            "productionCountries".into(),
            pluck(arr(d, "production_countries"), "name").into(),
        );
        o.insert(
            "productionCompanies".into(),
            pluck(arr(d, "production_companies"), "name").into(),
        );
        o.insert(
            "keywords".into(),
            pluck(arr(get(d, "keywords"), "keywords"), "name").into(),
        );
        o.insert(
            "alternativeTitles".into(),
            alternative_titles(
                arr(get(d, "alternative_titles"), "titles"),
                d,
                "title",
                "original_title",
            )
            .into(),
        );
        let coll = get(d, "belongs_to_collection");
        o.insert("tmdbCollectionId".into(), nn(coll, "id"));
        o.insert("tmdbCollectionName".into(), nn(coll, "name"));
        Value::Object(o)
    }

    pub fn map_tv_details(&self, d: &Value, lang: &Resolved) -> Value {
        let mut o = self.common_details(d, lang, true);
        let ext = get(d, "external_ids");
        o.insert("tvdbId".into(), nn(ext, "tvdb_id"));
        o.insert("imdbId".into(), nn(ext, "imdb_id"));
        o.insert("title".into(), nn(d, "name"));
        o.insert("originalTitle".into(), nn(d, "original_name"));
        o.insert("year".into(), year_of(d, "first_air_date"));
        o.insert(
            "runtime".into(),
            arr(d, "episode_run_time")
                .first()
                .cloned()
                .unwrap_or(Value::Null),
        );
        o.insert("seasonCount".into(), nn(d, "number_of_seasons"));
        o.insert("episodeCount".into(), nn(d, "number_of_episodes"));
        o.insert("releaseDate".into(), nn(d, "first_air_date"));
        for k in [
            "inCinemas",
            "digitalRelease",
            "physicalRelease",
            "budget",
            "revenue",
        ] {
            o.insert(k.into(), Value::Null);
        }
        o.insert(
            "status".into(),
            tv_status(get(d, "status").as_str().unwrap_or_default()).into(),
        );
        o.insert(
            "productionCountries".into(),
            or(d, "origin_country", json!([])),
        );
        let companies: Vec<Value> = pluck(arr(d, "networks"), "name")
            .into_iter()
            .chain(pluck(arr(d, "production_companies"), "name"))
            .collect();
        o.insert("productionCompanies".into(), companies.into());
        o.insert(
            "keywords".into(),
            pluck(arr(get(d, "keywords"), "results"), "name").into(),
        );
        o.insert(
            "alternativeTitles".into(),
            alternative_titles(
                arr(get(d, "alternative_titles"), "results"),
                d,
                "name",
                "original_name",
            )
            .into(),
        );
        o.insert("tmdbCollectionId".into(), Value::Null);
        o.insert("tmdbCollectionName".into(), Value::Null);
        Value::Object(o)
    }

    /// Season numbers and episode counts in one call; season 0 is kept.
    pub async fn season_stubs(
        &self,
        id: i64,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Vec<Value>, Upstream> {
        let d = self
            .get(
                &format!("/tv/{id}"),
                q(&[("language", &lang.tmdb_locale)]),
                p,
            )
            .await?;
        Ok(arr(&d, "seasons")
            .iter()
            .map(|s| json!({"seasonNumber": nn(s, "season_number"), "episodeCount": or(s, "episode_count", json!(0))}))
            .collect())
    }

    pub async fn season(
        &self,
        id: i64,
        n: i64,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Value, Upstream> {
        let s = self
            .get(
                &format!("/tv/{id}/season/{n}"),
                q(&[("language", &lang.tmdb_locale)]),
                p,
            )
            .await?;
        let episodes: Vec<Value> = arr(&s, "episodes")
            .iter()
            .map(|e| {
                json!({
                    "episodeNumber": nn(e, "episode_number"),
                    "title": nn(e, "name"),
                    "overview": text_or_null(e, "overview"),
                    "airDate": text_or_null(e, "air_date"),
                    "runtime": nn(e, "runtime"),
                    "stillUrl": image(&self.img, "w780", e, "still_path"),
                })
            })
            .collect();
        Ok(json!({
            "seasonNumber": nn(&s, "season_number"),
            "episodeCount": episodes.len(),
            "overview": text_or_null(&s, "overview"),
            "airDate": text_or_null(&s, "air_date"),
            "posterUrl": image(&self.img, "w500", &s, "poster_path"),
            "episodes": episodes,
        }))
    }

    /// Every season; at most 8 in flight, stub order kept, a failing season is dropped unless the
    /// provider is throttling: a partial list would make identify delete the missing seasons.
    pub async fn seasons(
        &self,
        id: i64,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Vec<Value>, Upstream> {
        let stubs = self.season_stubs(id, lang, p).await?;
        let fetched = stream::iter(stubs)
            .map(|stub| async move {
                let n = stub["seasonNumber"].as_i64().unwrap_or_default();
                match self.season(id, n, lang, p).await {
                    Ok(s) => Ok(Some(s)),
                    Err(e) if e.is_throttled() => Err(e),
                    Err(e) => {
                        tracing::warn!("failed to fetch season {n} for TV {id}: {e}");
                        Ok(None)
                    }
                }
            })
            .buffered(SEASON_FETCH_CONCURRENCY)
            .collect::<Vec<_>>()
            .await;
        let fetched = fetched.into_iter().collect::<Result<Vec<_>, _>>()?;
        Ok(fetched.into_iter().flatten().collect())
    }

    pub async fn find_by_external_id(
        &self,
        source: ExternalProvider,
        id: &str,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Option<(String, bool)>, Upstream> {
        let external = match source {
            ExternalProvider::Imdb => "imdb_id",
            ExternalProvider::Tvdb => "tvdb_id",
            ExternalProvider::Tmdb => return Ok(None),
        };
        let d = self
            .get(
                &format!("/find/{id}"),
                q(&[
                    ("external_source", external),
                    ("language", &lang.tmdb_locale),
                ]),
                p,
            )
            .await?;
        let first = |k: &str| arr(&d, k).first().and_then(|m| id_string(get(m, "id")));
        Ok(first("movie_results")
            .map(|i| (i, false))
            .or_else(|| first("tv_results").map(|i| (i, true))))
    }

    pub async fn person_details(
        &self,
        id: i64,
        lang: &Resolved,
        p: Priority,
    ) -> Result<PersonDetails, Upstream> {
        let d = self
            .get(
                &format!("/person/{id}"),
                q(&[("language", &lang.tmdb_locale)]),
                p,
            )
            .await?;
        let s = |k: &str| get(&d, k).as_str().map(str::to_owned);
        Ok(PersonDetails {
            name: s("name"),
            biography: s("biography"),
            birthday: s("birthday"),
            deathday: s("deathday"),
            place_of_birth: s("place_of_birth"),
            avatar_url: text(&d, "profile_path").map(|path| format!("{}/w500{path}", self.img)),
            known_for_department: s("known_for_department"),
        })
    }

    pub async fn credits_of(
        &self,
        id: i64,
        lang: &Resolved,
        p: Priority,
    ) -> Result<Credits, Upstream> {
        let d = self
            .get(
                &format!("/person/{id}/combined_credits"),
                q(&[("language", &lang.tmdb_locale)]),
                p,
            )
            .await?;
        let item = |c: &Value, extra: &[&str]| {
            let mut o = Map::new();
            put(&mut o, "externalId", c, "id");
            let title = text(c, "title")
                .or_else(|| get(c, "name").as_str())
                .unwrap_or_default();
            o.insert("title".into(), title.into());
            let kind = MediaKind::from_tv(get(c, "media_type") == "tv");
            o.insert("mediaType".into(), kind.as_str().into());
            for k in extra {
                put(&mut o, k, c, k);
            }
            o.insert(
                "posterUrl".into(),
                image(&self.img, "w500", c, "poster_path"),
            );
            o.insert(
                "fanartUrl".into(),
                image(&self.img, "original", c, "backdrop_path"),
            );
            let date = match get(c, "release_date") {
                Value::Null => nn(c, "first_air_date"),
                x => x.clone(),
            };
            o.insert("releaseDate".into(), date);
            o.insert("rating".into(), or(c, "vote_average", json!(0)));
            Value::Object(o)
        };
        let list = |k: &str, extra: &[&str]| -> Result<Vec<Value>, Upstream> {
            let items = d.get(k).and_then(Value::as_array).ok_or_else(|| {
                Upstream::new(None, "Cannot read properties of undefined (reading 'map')")
            })?;
            Ok(items.iter().map(|c| item(c, extra)).collect())
        };
        Ok(Credits {
            cast: list("cast", &["character"])?,
            crew: list("crew", &["job", "department"])?,
        })
    }
}

impl MetadataProvider for Tmdb {
    fn id(&self) -> ExternalProvider {
        ExternalProvider::Tmdb
    }

    fn supports(&self, _kind: MediaKind) -> bool {
        true
    }

    fn has_persons(&self) -> bool {
        true
    }

    fn limits(&self) -> Limits {
        self.http.limits()
    }

    fn search<'a>(
        &'a self,
        q: &'a Search<'a>,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>> {
        let tv = q.kind.has_seasons();
        Box::pin(self.search_titles(tv, q.query, q.year, lang, p))
    }

    fn fetch_work<'a>(
        &'a self,
        kind: MediaKind,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Value> {
        Box::pin(async move {
            self.details(kind.has_seasons(), numeric(id)?, lang, p)
                .await
        })
    }

    fn fetch_children<'a>(
        &'a self,
        _kind: MediaKind,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>> {
        Box::pin(async move { self.seasons(numeric(id)?, lang, p).await })
    }

    fn child_stubs<'a>(
        &'a self,
        _kind: MediaKind,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Vec<Value>> {
        Box::pin(async move { self.season_stubs(numeric(id)?, lang, p).await })
    }

    fn find_by<'a>(
        &'a self,
        source: ExternalProvider,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Option<(String, MediaKind)>> {
        Box::pin(async move {
            let found = self.find_by_external_id(source, id, lang, p).await?;
            Ok(found.map(|(id, tv)| (id, MediaKind::from_tv(tv))))
        })
    }

    fn fetch_person<'a>(
        &'a self,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, PersonDetails> {
        Box::pin(async move { self.person_details(numeric(id)?, lang, p).await })
    }

    fn person_credits<'a>(
        &'a self,
        id: &'a str,
        lang: &'a Resolved,
        p: Priority,
    ) -> Call<'a, Credits> {
        Box::pin(async move { self.credits_of(numeric(id)?, lang, p).await })
    }
}

/// JS `String(n)` of an id; a missing one is no id.
fn id_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// Best clearlogo: community vote plus a language bonus, the provider's order breaking ties.
pub fn pick_logo(base: &str, images: &Value, prefer: &str) -> Value {
    let bonus = |l: &Value| match get(l, "iso_639_1").as_str() {
        Some(x) if x == prefer => 0.5,
        Some("en") => 0.25,
        _ => 0.0,
    };
    let mut best: Option<(&Value, f64)> = None;
    for l in arr(images, "logos")
        .iter()
        .filter(|l| text(l, "file_path").is_some())
    {
        let s = score(l, "vote_average") + bonus(l);
        if best.is_none_or(|(_, b)| s > b) {
            best = Some((l, s));
        }
    }
    best.map_or(Value::Null, |(l, _)| {
        image(base, "original", l, "file_path")
    })
}

/// The top backdrops other than the primary one, by vote.
pub fn pick_additional_fanarts(base: &str, images: &Value, primary: &Value) -> Vec<Value> {
    let mut c: Vec<&Value> = arr(images, "backdrops")
        .iter()
        .filter(|b| text(b, "file_path").is_some() && get(b, "file_path") != primary)
        .collect();
    c.sort_by(|a, b| score(b, "vote_average").total_cmp(&score(a, "vote_average")));
    c.into_iter()
        .take(MAX_ADDITIONAL_FANARTS)
        .map(|b| image(base, "original", b, "file_path"))
        .collect()
}

/// Trimmed alternative titles, de-duplicated case-insensitively against the titles and each other.
pub fn alternative_titles(raw: &[Value], d: &Value, primary: &str, original: &str) -> Vec<Value> {
    let mut seen: Vec<String> = [primary, original]
        .iter()
        .filter_map(|k| text(d, k))
        .map(str::to_lowercase)
        .collect();
    let mut out = vec![];
    for e in raw {
        let t = text(e, "title")
            .or_else(|| get(e, "name").as_str())
            .unwrap_or_default()
            .trim();
        if t.is_empty() || seen.contains(&t.to_lowercase()) {
            continue;
        }
        seen.push(t.to_lowercase());
        out.push(Value::from(t));
    }
    out
}

/// `(inCinemas, digitalRelease, physicalRelease)`: countries by priority, the first carrying a type wins.
pub fn release_dates(
    results: &[Value],
    priority: &[String],
) -> (Option<String>, Option<String>, Option<String>) {
    let rank = |c: &Value| {
        let code = get(c, "iso_3166_1").as_str().unwrap_or_default();
        priority.iter().position(|p| p == code).unwrap_or(99)
    };
    let mut sorted: Vec<&Value> = results.iter().collect();
    sorted.sort_by_key(|c| rank(c));
    let mut dates: HashMap<i64, String> = HashMap::new();
    for country in sorted {
        for rd in arr(country, "release_dates") {
            let (Some(date), Some(kind)) = (text(rd, "release_date"), get(rd, "type").as_i64())
            else {
                continue;
            };
            dates
                .entry(kind)
                .or_insert_with(|| date.chars().take(10).collect());
        }
    }
    let d = |k: i64| dates.get(&k).cloned();
    (d(3).or_else(|| d(2)).or_else(|| d(1)), d(4), d(5))
}

pub fn tv_status(s: &str) -> &'static str {
    match s {
        "Returning Series" => "continuing",
        "Ended" | "Canceled" => "ended",
        "In Production" => "announced",
        "Planned" => "tba",
        _ => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::stub::serve;
    use fliks_domain::metadata::language::resolve;

    /// A two-season series whose second season answers `second`.
    async fn seasons_with(second: u16) -> Result<Vec<Value>, Upstream> {
        let (url, _) = serve(move |path, _| match path {
            "/tv/1" => (
                200,
                None,
                r#"{"seasons":[{"season_number":1,"episode_count":1},{"season_number":2,"episode_count":1}]}"#.into(),
            ),
            "/tv/1/season/1" => (200, None, r#"{"season_number":1,"episodes":[]}"#.into()),
            _ => (second, Some("0".into()), "{}".into()),
        })
        .await;
        let tmdb = Tmdb::new(&url, "https://img", "key", Duration::from_secs(5));
        tmdb.seasons(1, &resolve(None, None), Priority::Interactive)
            .await
    }

    #[tokio::test]
    async fn a_missing_season_is_dropped() {
        assert_eq!(seasons_with(404).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_throttled_season_fails_the_list_instead_of_shortening_it() {
        for status in [429, 503] {
            let e = seasons_with(status).await.unwrap_err();
            assert_eq!(e.status, Some(status));
        }
    }
}

//! The acquisition reads of `plugins.md` rule 31, built on the S5 release domain.
use super::runtime::fliks::plugin::types as t;
use crate::state::AppState;
use chrono::{Days, NaiveDate, Utc};
use fliks_domain::release::parsing::quality::{app_quality_by_id, rank_from_quality_string};
use fliks_domain::release::parsing::season_episode::{
    ReleaseCoverage, coverage_of, parse_season_episode,
};
use fliks_domain::release::scoring::{
    AudioLanguageItem, CustomFormat, ExpectedTitle, Param, QualityProfileItem, ReleaseCandidate,
    ScoreOptions, SearchMedia, SizeLimits, WhenUnreadable, allowed_audio_language_ids,
    build_allowed_quality_ids, index_title_expectations, matches_indexed_expectation,
    max_resolution_from_quality_strings, release_flags, release_title_tokens,
    resolve_search_titles, score_and_sort_releases,
};
use serde_json::Value;
use sqlx::{FromRow, PgPool};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_LIMIT: u32 = 500;
const PAGE_CACHE: Duration = Duration::from_secs(60);
const PACK_MIN_SHARE: f64 = 0.5;

#[derive(FromRow, Clone)]
struct MediaRow {
    id: i32,
    kind: String,
    title: String,
    original_title: Option<String>,
    alternative_titles: Value,
    year: Option<i32>,
    runtime: Option<i32>,
    imdb_id: Option<String>,
    tmdb_id: Option<i32>,
    tvdb_id: Option<i32>,
    library_id: Option<i32>,
    minimum_availability: String,
    in_cinemas: Option<NaiveDate>,
    digital_release: Option<NaiveDate>,
    physical_release: Option<NaiveDate>,
    release_date: Option<NaiveDate>,
    status: String,
    qp_id: Option<i32>,
    qp_cutoff: Option<i32>,
    qp_upgrade: Option<bool>,
    qp_items: Option<Value>,
    qp_res_only: Option<bool>,
    qp_min_cf: Option<i32>,
    lp_audio: Option<Value>,
}

const MEDIA_SELECT: &str = r#"SELECT m.id, m.type::text AS kind, m.title, m."originalTitle" AS original_title,
    m."alternativeTitles" AS alternative_titles, m.year, m.runtime, m."imdbId" AS imdb_id,
    m."tmdbId" AS tmdb_id, m."tvdbId" AS tvdb_id, m."libraryId" AS library_id, m.monitored,
    m."minimumAvailability" AS minimum_availability, m."inCinemas" AS in_cinemas,
    m."digitalRelease" AS digital_release, m."physicalRelease" AS physical_release,
    m."releaseDate" AS release_date, m.status::text AS status,
    qp.id AS qp_id, qp.cutoff AS qp_cutoff, qp."upgradeAllowed" AS qp_upgrade, qp.items AS qp_items,
    qp."resolutionUpgradeOnly" AS qp_res_only, qp."minCustomFormatScore" AS qp_min_cf,
    lp."audioLanguages" AS lp_audio
  FROM media m LEFT JOIN quality_profiles qp ON qp.id = m."qualityProfileId"
  LEFT JOIN language_profiles lp ON lp.id = m."languageProfileId""#;

impl MediaRow {
    fn is_movie(&self) -> bool {
        self.kind == "movie"
    }
    fn alt(&self) -> Vec<String> {
        self.alternative_titles
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    }
    fn allowed(&self) -> (BTreeSet<u32>, BTreeSet<u32>) {
        let items: Vec<QualityProfileItem> = self
            .qp_items
            .clone()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        let langs: Vec<AudioLanguageItem> = self
            .lp_audio
            .clone()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        (
            build_allowed_quality_ids(&items),
            allowed_audio_language_ids(&langs),
        )
    }
    fn search(&self) -> SearchMedia {
        SearchMedia {
            original_title: self.original_title.clone(),
            title: self.title.clone(),
            alternative_titles: Some(self.alt()),
        }
    }
}

async fn media(db: &PgPool, id: i32) -> sqlx::Result<Option<MediaRow>> {
    sqlx::query_as(&format!("{MEDIA_SELECT} WHERE m.id = $1"))
        .bind(id)
        .fetch_optional(db)
        .await
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    Missing,
    Upgrade,
    Skip,
}

#[derive(Clone, Copy, Debug)]
enum Decision {
    Unprofiled,
    Window {
        mode: Mode,
        min: u32,
        max: Option<u32>,
    },
}

type Files = Vec<Option<String>>;

/// `classifyForSearch`: only the quality profile is required.
fn classify(m: &MediaRow, files: &Files) -> Decision {
    if m.qp_id.is_none() {
        return Decision::Unprofiled;
    }
    if files.is_empty() {
        return Decision::Window {
            mode: Mode::Missing,
            min: 0,
            max: None,
        };
    }
    let current = files
        .iter()
        .map(|f| rank_from_quality_string(f.as_deref()))
        .max()
        .unwrap_or(0);
    let cutoff = m
        .qp_cutoff
        .and_then(|c| app_quality_by_id(c.into()))
        .map(|q| q.rank);
    if m.qp_upgrade != Some(true) || cutoff.is_none() {
        return Decision::Window {
            mode: Mode::Skip,
            min: current,
            max: cutoff,
        };
    }
    let cutoff = cutoff.expect("checked");
    let mode = if current >= cutoff {
        Mode::Skip
    } else {
        Mode::Upgrade
    };
    Decision::Window {
        mode,
        min: current,
        max: Some(cutoff),
    }
}

fn excluded(d: Decision) -> bool {
    matches!(
        d,
        Decision::Unprofiled
            | Decision::Window {
                mode: Mode::Skip,
                ..
            }
    )
}

#[derive(FromRow, Clone)]
struct EpisodeRow {
    id: i32,
    season_id: i32,
    episode_number: i32,
    end_episode_number: Option<i32>,
    title: Option<String>,
    air_date: Option<NaiveDate>,
    has_file: bool,
    monitored: bool,
}

const EPISODE_SELECT: &str = r#"SELECT id, "seasonId" AS season_id, "episodeNumber" AS episode_number,
    "endEpisodeNumber" AS end_episode_number, title, "airDate" AS air_date, "hasFile" AS has_file, monitored
  FROM episodes"#;

async fn episodes_of(db: &PgPool, season_id: i32) -> sqlx::Result<Vec<EpisodeRow>> {
    sqlx::query_as(&format!(
        r#"{EPISODE_SELECT} WHERE "seasonId" = $1 ORDER BY id"#
    ))
    .bind(season_id)
    .fetch_all(db)
    .await
}

/// Episode numbers on disk: own file, or covered by a multi-episode file.
fn on_disk(eps: &[EpisodeRow]) -> BTreeSet<i32> {
    let mut out = BTreeSet::new();
    for e in eps.iter().filter(|e| e.has_file) {
        out.insert(e.episode_number);
        if let Some(end) = e.end_episode_number.filter(|n| *n > e.episode_number) {
            out.extend(e.episode_number + 1..=end);
        }
    }
    out
}

async fn file_qualities(db: &PgPool, column: &str, id: i32) -> sqlx::Result<Vec<String>> {
    sqlx::query_scalar(&format!(
        r#"SELECT quality FROM media_files WHERE "{column}" = $1 ORDER BY id"#
    ))
    .bind(id)
    .fetch_all(db)
    .await
}

async fn files_for_episode(
    db: &PgPool,
    e: &EpisodeRow,
    disk: &BTreeSet<i32>,
) -> sqlx::Result<Files> {
    if !disk.contains(&e.episode_number) {
        return Ok(vec![]);
    }
    let q = file_qualities(db, "episodeId", e.id).await?;
    if q.is_empty() {
        return Ok(vec![None]);
    }
    let best = q
        .iter()
        .max_by_key(|x| rank_from_quality_string(Some(x)))
        .cloned();
    Ok(vec![best])
}

/// `[]` while any episode is missing, else the weakest quality on disk.
async fn files_for_pack(
    db: &PgPool,
    eps: &[EpisodeRow],
    disk: &BTreeSet<i32>,
) -> sqlx::Result<Files> {
    if eps.is_empty() {
        return Ok(vec![]);
    }
    let mut per = vec![];
    for e in eps {
        per.push(files_for_episode(db, e, disk).await?);
    }
    if per.iter().any(Vec::is_empty) {
        return Ok(vec![]);
    }
    let weakest = per
        .iter()
        .map(|f| f[0].clone())
        .min_by_key(|q| rank_from_quality_string(q.as_deref()))
        .flatten();
    Ok(vec![weakest])
}

async fn files_for(
    db: &PgPool,
    m: &MediaRow,
    season: Option<i32>,
    episode: Option<&EpisodeRow>,
) -> sqlx::Result<Files> {
    if m.is_movie() {
        return Ok(file_qualities(db, "mediaId", m.id)
            .await?
            .into_iter()
            .map(Some)
            .collect());
    }
    if let Some(e) = episode {
        let sib = episodes_of(db, e.season_id).await?;
        return files_for_episode(db, e, &on_disk(&sib)).await;
    }
    if let Some(s) = season {
        let eps = episodes_of(db, s).await?;
        return files_for_pack(db, &eps, &on_disk(&eps)).await;
    }
    Ok(vec![])
}

fn want(m: &MediaRow, d: Option<Decision>, files: &Files) -> Option<t::Want> {
    let Some(Decision::Window { mode, .. }) = d else {
        return None;
    };
    let (allowed, langs) = m.allowed();
    let res_only = mode != Mode::Missing && m.qp_res_only == Some(true);
    let quals: Vec<Option<&str>> = files.iter().map(|f| f.as_deref()).collect();
    Some(t::Want {
        decision: match mode {
            Mode::Missing => t::WantDecision::Missing,
            Mode::Upgrade => t::WantDecision::Upgrade,
            Mode::Skip => t::WantDecision::Skip,
        },
        allowed_quality_ids: allowed.into_iter().collect(),
        allowed_language_ids: langs.into_iter().collect(),
        min_resolution: if res_only {
            max_resolution_from_quality_strings(&quals)
        } else {
            0
        },
        resolution_upgrade_only: res_only,
    })
}

fn target(m: &MediaRow, d: Option<Decision>, files: &Files) -> Option<t::AcquisitionTarget> {
    let Some(library_id) = m.library_id else {
        tracing::warn!(
            "candidate #{} \"{}\" dropped — no library id on the loaded media",
            m.id,
            m.title
        );
        return None;
    };
    let titles = resolve_search_titles(&m.search(), None);
    Some(t::AcquisitionTarget {
        media_id: m.id as u32,
        kind: if m.is_movie() {
            t::MediaKind::Movie
        } else {
            t::MediaKind::Series
        },
        title: m.title.clone(),
        original_title: m.original_title.clone(),
        alternative_titles: m.alt(),
        year: m.year.map(|y| y as u32),
        runtime_minutes: m.runtime.map(|r| r as u32),
        imdb_id: m.imdb_id.clone(),
        tmdb_id: m.tmdb_id.map(|v| v as u32),
        tvdb_id: m.tvdb_id.map(|v| v as u32),
        library_id: library_id as u32,
        want: want(m, d, files),
        expected_titles: titles.expected_titles,
        search_title: titles.search_title,
        season: None,
        episode: None,
    })
}

fn episode_ref(e: &EpisodeRow) -> t::EpisodeRef {
    t::EpisodeRef {
        id: e.id as u32,
        number: e.episode_number as u32,
        end_number: e.end_episode_number.map(|n| n as u32),
        air_date: e.air_date.map(|d| d.to_string()),
        title: e.title.clone(),
    }
}

async fn season_row(
    db: &PgPool,
    where_: &str,
    a: i32,
    b: Option<i32>,
) -> sqlx::Result<Option<(i32, i32, i32, bool)>> {
    let sql =
        format!(r#"SELECT id, "mediaId", "seasonNumber", monitored FROM seasons WHERE {where_}"#);
    let mut q = sqlx::query_as(&sql).bind(a);
    if let Some(b) = b {
        q = q.bind(b);
    }
    q.fetch_optional(db).await
}

/// `media.acquisitionContext`: null for unknown media, no library, or a scope of another media.
pub async fn context(
    st: &AppState,
    media_id: u32,
    season_id: Option<u32>,
    episode_id: Option<u32>,
) -> sqlx::Result<Option<t::AcquisitionTarget>> {
    let db = &st.db;
    let Some(m) = media(db, media_id as i32).await? else {
        return Ok(None);
    };
    if m.library_id.is_none() {
        return Ok(None);
    }
    let (mut season, mut episode) = (None, None);
    if let Some(eid) = episode_id {
        let e: Option<EpisodeRow> = sqlx::query_as(&format!("{EPISODE_SELECT} WHERE id = $1"))
            .bind(eid as i32)
            .fetch_optional(db)
            .await?;
        let Some(e) = e else { return Ok(None) };
        let s = season_row(db, "id = $1", e.season_id, None).await?;
        let Some(s) = s.filter(|s| s.1 == m.id) else {
            return Ok(None);
        };
        season = Some(s);
        episode = Some(e);
    } else if let Some(sid) = season_id {
        let s = season_row(db, "id = $1", sid as i32, None).await?;
        let Some(s) = s.filter(|s| s.1 == m.id) else {
            return Ok(None);
        };
        season = Some(s);
    }
    let files = files_for(db, &m, season.map(|s| s.0), episode.as_ref()).await?;
    let whole_series = !m.is_movie() && season.is_none() && episode.is_none();
    let decision = (!whole_series).then(|| classify(&m, &files));
    let Some(mut tg) = target(&m, decision, &files) else {
        return Ok(None);
    };
    if let Some((sid, _, number, _)) = season {
        let count: i64 =
            sqlx::query_scalar(r#"SELECT count(*) FROM episodes WHERE "seasonId" = $1"#)
                .bind(sid)
                .fetch_one(db)
                .await?;
        tg.season = Some(t::SeasonRef {
            id: sid as u32,
            number: number as u32,
            episode_count: count as u32,
        });
    }
    tg.episode = episode.as_ref().map(episode_ref);
    Ok(Some(tg))
}

fn available(m: &MediaRow, today: NaiveDate) -> bool {
    let le = |d: Option<NaiveDate>| d.is_some_and(|d| d <= today);
    match m.minimum_availability.as_str() {
        "announced" => true,
        "inCinemas" => le(m.in_cinemas),
        "released" => {
            le(m.digital_release)
                || le(m.physical_release)
                || m.in_cinemas
                    .and_then(|d| d.checked_add_days(Days::new(90)))
                    .is_some_and(|d| d <= today)
                || le(m.release_date)
                || m.status == "released"
        }
        _ => true,
    }
}

struct EpTarget {
    media: MediaRow,
    season: (i32, i32),
    episode: EpisodeRow,
    files: Files,
}

async fn movie_targets(db: &PgPool, ids: Option<&[i32]>) -> sqlx::Result<Vec<(MediaRow, Files)>> {
    let rows: Vec<MediaRow> = sqlx::query_as(&format!(
        r#"{MEDIA_SELECT} WHERE m.monitored AND m.type = 'movie'
             AND (NOT EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id) OR qp."upgradeAllowed")
             AND ($1::int[] IS NULL OR m.id = ANY($1)) ORDER BY m.id"#
    ))
    .bind(ids)
    .fetch_all(db)
    .await?;
    let mut out = vec![];
    for m in rows {
        let files: Files = file_qualities(db, "mediaId", m.id)
            .await?
            .into_iter()
            .map(Some)
            .collect();
        if !excluded(classify(&m, &files)) {
            out.push((m, files));
        }
    }
    Ok(out)
}

async fn episode_targets(db: &PgPool, ids: Option<&[i32]>) -> sqlx::Result<Vec<EpTarget>> {
    let today = Utc::now().date_naive();
    let rows: Vec<(i32, i32, i32)> = sqlx::query_as(
        r#"SELECT ep.id, s.id, s."seasonNumber" FROM episodes ep
             JOIN seasons s ON s.id = ep."seasonId" JOIN media m ON m.id = s."mediaId"
             LEFT JOIN quality_profiles qp ON qp.id = m."qualityProfileId"
            WHERE m.monitored AND m.type = 'series' AND s.monitored AND ep.monitored
              AND ep."airDate" IS NOT NULL AND ep."airDate" <= $1
              AND (NOT (ep."hasFile" OR EXISTS (SELECT 1 FROM episodes cov WHERE cov."seasonId" = ep."seasonId"
                     AND cov."hasFile" AND cov."endEpisodeNumber" IS NOT NULL
                     AND ep."episodeNumber" > cov."episodeNumber" AND ep."episodeNumber" <= cov."endEpisodeNumber"))
                   OR (ep."hasFile" AND qp."upgradeAllowed"))
              AND ($2::int[] IS NULL OR m.id = ANY($2))
            ORDER BY ep.id"#,
    )
    .bind(today)
    .bind(ids)
    .fetch_all(db)
    .await?;
    let mut medias: HashMap<i32, MediaRow> = HashMap::new();
    let mut out = vec![];
    for (eid, sid, snum) in rows {
        let e: EpisodeRow = sqlx::query_as(&format!("{EPISODE_SELECT} WHERE id = $1"))
            .bind(eid)
            .fetch_one(db)
            .await?;
        let mid: i32 = sqlx::query_scalar(r#"SELECT "mediaId" FROM seasons WHERE id = $1"#)
            .bind(sid)
            .fetch_one(db)
            .await?;
        if !medias.contains_key(&mid)
            && let Some(m) = media(db, mid).await?
        {
            medias.insert(mid, m);
        }
        let Some(m) = medias.get(&mid).cloned() else {
            continue;
        };
        let files: Files = if e.has_file {
            let q = file_qualities(db, "episodeId", e.id).await?;
            vec![
                q.into_iter()
                    .max_by_key(|x| rank_from_quality_string(Some(x))),
            ]
        } else {
            vec![]
        };
        if !excluded(classify(&m, &files)) {
            out.push(EpTarget {
                media: m,
                season: (sid, snum),
                episode: e,
                files,
            });
        }
    }
    Ok(out)
}

async fn count_by_season(
    db: &PgPool,
    ids: &[i32],
    unaired: bool,
) -> sqlx::Result<HashMap<i32, i64>> {
    let rows: Vec<(i32, i64)> = sqlx::query_as(
        r#"SELECT "seasonId", count(*) FROM episodes WHERE "seasonId" = ANY($1)
             AND (NOT $2 OR "airDate" IS NULL OR "airDate" > CURRENT_DATE) GROUP BY "seasonId""#,
    )
    .bind(ids)
    .bind(unaired)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

type Cached = (String, Instant, Vec<t::AcquisitionTarget>);

fn page_cache() -> &'static Mutex<HashMap<String, Cached>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, Cached>>> = std::sync::OnceLock::new();
    C.get_or_init(Mutex::default)
}

fn page(targets: &[t::AcquisitionTarget], cursor: Option<&str>, limit: usize) -> t::CandidatesPage {
    let offset = cursor
        .and_then(|c| c.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let items: Vec<_> = targets.iter().skip(offset).take(limit).cloned().collect();
    let next = offset + items.len();
    t::CandidatesPage {
        cursor: (next < targets.len()).then(|| next.to_string()),
        items,
    }
}

/// `acquisition.candidates`: movies, season packs and episodes, sorted, paged by offset.
pub async fn candidates(
    st: &AppState,
    plugin: &str,
    q: t::CandidatesQuery,
) -> sqlx::Result<t::CandidatesPage> {
    let db = &st.db;
    let limit = q.limit.clamp(1, MAX_LIMIT) as usize;
    let mut ids: Option<Vec<i32>> = q
        .media_ids
        .as_ref()
        .map(|v| v.iter().map(|i| *i as i32).collect());
    if let Some(v) = ids.as_mut() {
        v.sort();
    }
    let key = format!(
        "{:?}|{:?}|{}",
        q.kind.map(|k| matches!(k, t::MediaKind::Movie)),
        ids,
        q.available_on
    );
    if q.cursor.is_some()
        && let Some((k, at, targets)) = page_cache().lock().unwrap().get(plugin)
        && *k == key
        && at.elapsed() < PAGE_CACHE
    {
        return Ok(page(targets, q.cursor.as_deref(), limit));
    }
    let ids = ids.filter(|v| !v.is_empty());
    let on = NaiveDate::parse_from_str(&q.available_on, "%Y-%m-%d")
        .unwrap_or_else(|_| Utc::now().date_naive());
    let mut targets = vec![];
    if !matches!(q.kind, Some(t::MediaKind::Series)) {
        for (m, files) in movie_targets(db, ids.as_deref()).await? {
            if available(&m, on) {
                let d = classify(&m, &files);
                if !excluded(d) {
                    targets.extend(target(&m, Some(d), &files));
                }
            }
        }
    }
    if !matches!(q.kind, Some(t::MediaKind::Movie)) {
        let eps: Vec<EpTarget> = episode_targets(db, ids.as_deref())
            .await?
            .into_iter()
            .filter(|e| e.episode.air_date.is_none_or(|d| d <= on))
            .collect();
        let mut by_season: Vec<(i32, Vec<&EpTarget>)> = vec![];
        for e in &eps {
            match by_season.iter_mut().find(|(s, _)| *s == e.season.0) {
                Some((_, v)) => v.push(e),
                None => by_season.push((e.season.0, vec![e])),
            }
        }
        let season_ids: Vec<i32> = by_season.iter().map(|(s, _)| *s).collect();
        let totals = count_by_season(db, &season_ids, false).await?;
        let unaired = count_by_season(db, &season_ids, true).await?;
        for (sid, group) in by_season.iter().filter(|(_, g)| g.len() >= 2) {
            if unaired.get(sid).copied().unwrap_or(0) > 0 {
                continue;
            }
            let total = totals.get(sid).copied().unwrap_or(group.len() as i64);
            if (group.len() as f64) < total as f64 * PACK_MIN_SHARE {
                continue;
            }
            let files: Files = if group.iter().all(|e| !e.files.is_empty()) {
                vec![
                    group
                        .iter()
                        .map(|e| e.files[0].clone())
                        .min_by_key(|q| rank_from_quality_string(q.as_deref()))
                        .flatten(),
                ]
            } else {
                vec![]
            };
            let m = &group[0].media;
            let d = classify(m, &files);
            if excluded(d) {
                continue;
            }
            if let Some(mut tg) = target(m, Some(d), &files) {
                tg.season = Some(t::SeasonRef {
                    id: *sid as u32,
                    number: group[0].season.1 as u32,
                    episode_count: total as u32,
                });
                targets.push(tg);
            }
        }
        for e in &eps {
            let d = classify(&e.media, &e.files);
            if excluded(d) {
                continue;
            }
            if let Some(mut tg) = target(&e.media, Some(d), &e.files) {
                let count = totals.get(&e.season.0).copied().unwrap_or(1);
                tg.season = Some(t::SeasonRef {
                    id: e.season.0 as u32,
                    number: e.season.1 as u32,
                    episode_count: count as u32,
                });
                tg.episode = Some(episode_ref(&e.episode));
                targets.push(tg);
            }
        }
    }
    targets.sort_by_key(|tg| {
        (
            tg.media_id,
            tg.season.as_ref().map_or(0, |s| s.id),
            tg.episode.as_ref().map_or(0, |e| e.id),
        )
    });
    let out = page(&targets, q.cursor.as_deref(), limit);
    page_cache()
        .lock()
        .unwrap()
        .insert(plugin.to_owned(), (key, Instant::now(), targets));
    Ok(out)
}

fn wit_coverage(c: &ReleaseCoverage) -> t::ReleaseCoverage {
    let span = |s: &fliks_domain::release::parsing::season_episode::Span| t::Span {
        first: s.from as u32,
        last: s.to as u32,
    };
    t::ReleaseCoverage {
        seasons: c.seasons.as_ref().map(span),
        episodes: c.episodes.as_ref().map(span),
        complete_series: c.complete_series,
    }
}

/// `releases.match`: one index of the monitored library per call, then each title in order.
pub async fn matches(
    st: &AppState,
    titles: Vec<t::ReleaseTitle>,
    min_age: Option<u32>,
) -> sqlx::Result<Vec<t::ReleaseMatch>> {
    let db = &st.db;
    let library: Vec<MediaRow> =
        sqlx::query_as(&format!("{MEDIA_SELECT} WHERE m.monitored ORDER BY m.id"))
            .fetch_all(db)
            .await?;
    let indexed: Vec<_> = tokio::task::block_in_place(|| {
        library
            .iter()
            .map(|m| {
                let mut names = vec![
                    m.title.clone(),
                    m.original_title.clone().unwrap_or_default(),
                ];
                names.extend(m.alt());
                index_title_expectations(&names)
            })
            .collect()
    });
    let mut out = vec![];
    for entry in titles {
        let se = parse_season_episode(&entry.title);
        let coverage = wit_coverage(&coverage_of(&se));
        let skip = |reason: t::SkipReason, media: Option<i32>, s: Option<i32>, e: Option<i32>| {
            t::ReleaseMatch {
                id: entry.id.clone(),
                media_id: media.map(|m| m as u32),
                season_number: s.map(|n| n as u32),
                episode_number: e.map(|n| n as u32),
                is_full_season: se.is_full_season,
                coverage: Some(coverage),
                decision: t::MatchDecision::Skip,
                skip_reason: Some(reason),
            }
        };
        let tokens = release_title_tokens(&entry.title);
        let Some(m) = library
            .iter()
            .zip(&indexed)
            .find(|(_, idx)| matches_indexed_expectation(&tokens, idx, WhenUnreadable::NoMatch))
            .map(|(m, _)| m)
        else {
            out.push(skip(t::SkipReason::Unmatched, None, None, None));
            continue;
        };
        let (mut season_n, mut episode_n) = (None, None);
        let files: Files = if !m.is_movie() {
            let Some(sn) = se.season else {
                out.push(skip(t::SkipReason::NotAvailable, Some(m.id), None, None));
                continue;
            };
            let Some((sid, _, number, monitored)) = season_row(
                db,
                r#""mediaId" = $1 AND "seasonNumber" = $2"#,
                m.id,
                Some(sn as i32),
            )
            .await?
            else {
                out.push(skip(t::SkipReason::NotAvailable, Some(m.id), None, None));
                continue;
            };
            if !monitored {
                out.push(skip(
                    t::SkipReason::NotMonitored,
                    Some(m.id),
                    Some(number),
                    None,
                ));
                continue;
            }
            season_n = Some(number);
            let eps = episodes_of(db, sid).await?;
            if se.is_full_season {
                if eps.is_empty() {
                    out.push(skip(
                        t::SkipReason::NotAvailable,
                        Some(m.id),
                        season_n,
                        None,
                    ));
                    continue;
                }
                files_for_pack(db, &eps, &on_disk(&eps)).await?
            } else if let Some(en) = se.episode {
                let Some(e) = eps.iter().find(|e| i64::from(e.episode_number) == en) else {
                    out.push(skip(
                        t::SkipReason::NotAvailable,
                        Some(m.id),
                        season_n,
                        None,
                    ));
                    continue;
                };
                if !e.monitored {
                    out.push(skip(
                        t::SkipReason::NotMonitored,
                        Some(m.id),
                        season_n,
                        Some(e.episode_number),
                    ));
                    continue;
                }
                episode_n = Some(e.episode_number);
                files_for_episode(db, e, &on_disk(&eps)).await?
            } else {
                out.push(skip(
                    t::SkipReason::NotAvailable,
                    Some(m.id),
                    season_n,
                    None,
                ));
                continue;
            }
        } else {
            file_qualities(db, "mediaId", m.id)
                .await?
                .into_iter()
                .map(Some)
                .collect()
        };
        match classify(m, &files) {
            Decision::Unprofiled => {
                out.push(skip(
                    t::SkipReason::Unprofiled,
                    Some(m.id),
                    season_n,
                    episode_n,
                ));
                continue;
            }
            Decision::Window {
                mode: Mode::Skip, ..
            } => {
                out.push(skip(t::SkipReason::OnDisk, Some(m.id), season_n, episode_n));
                continue;
            }
            _ => {}
        }
        if let Some(min) = min_age.filter(|m| *m > 0)
            && let Ok(at) = chrono::DateTime::parse_from_rfc3339(&entry.publish_date)
        {
            let age = (Utc::now() - at.with_timezone(&Utc)).num_milliseconds() as f64 / 60_000.0;
            if age < f64::from(min) {
                out.push(skip(
                    t::SkipReason::TooFresh,
                    Some(m.id),
                    season_n,
                    episode_n,
                ));
                continue;
            }
        }
        out.push(t::ReleaseMatch {
            id: entry.id.clone(),
            media_id: Some(m.id as u32),
            season_number: season_n.map(|n| n as u32),
            episode_number: episode_n.map(|n| n as u32),
            is_full_season: se.is_full_season,
            coverage: Some(coverage),
            decision: t::MatchDecision::Grab,
            skip_reason: None,
        });
    }
    Ok(out)
}

struct Deps {
    formats: Vec<CustomFormat>,
    blocked: BTreeMap<i64, bool>,
}

async fn runtime_minutes(
    db: &PgPool,
    m: &MediaRow,
    season: Option<u32>,
    episode: Option<u32>,
) -> sqlx::Result<f64> {
    let (Some(season), false) = (season, m.is_movie()) else {
        return Ok(m.runtime.unwrap_or(0).into());
    };
    let total: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(ep.runtime), 0)::bigint FROM episodes ep JOIN seasons s ON s.id = ep."seasonId"
            WHERE s."mediaId" = $1 AND s."seasonNumber" = $2 AND ($3::int IS NULL OR ep."episodeNumber" = $3)"#,
    )
    .bind(m.id)
    .bind(season as i32)
    .bind(episode.map(|e| e as i32))
    .fetch_one(db)
    .await?;
    if total > 0 {
        return Ok(total as f64);
    }
    let per = m.runtime.unwrap_or(0);
    if per <= 0 || episode.is_some() {
        return Ok(per.into());
    }
    let count: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM episodes ep JOIN seasons s ON s.id = ep."seasonId" WHERE s."mediaId" = $1 AND s."seasonNumber" = $2"#,
    )
    .bind(m.id)
    .bind(season as i32)
    .fetch_one(db)
    .await?;
    Ok(f64::from(per) * count.max(1) as f64)
}

/// `releases.score`: the profile window recomputed here, `[]` for an unknown media.
pub async fn score(
    st: &AppState,
    media_id: u32,
    season_n: Option<u32>,
    episode_n: Option<u32>,
    releases: Vec<t::CandidateRelease>,
) -> sqlx::Result<Vec<t::ScoredRelease>> {
    let db = &st.db;
    let Some(m) = media(db, media_id as i32).await? else {
        return Ok(vec![]);
    };
    let (allowed, allowed_langs) = m.allowed();
    let titles = resolve_search_titles(&m.search(), None);
    let defs: Vec<(i32, f64, f64, f64)> = sqlx::query_as(
        r#"SELECT "qualityId", "minSize", "preferredSize", "maxSize" FROM quality_definitions"#,
    )
    .fetch_all(db)
    .await?;
    let size_by_quality = defs
        .into_iter()
        .map(|(q, min, preferred, max)| {
            (
                q as u32,
                SizeLimits {
                    min,
                    preferred,
                    max,
                },
            )
        })
        .collect();
    let formats: Vec<CustomFormat> = sqlx::query_as::<_, (i32, String, i32, Value)>(
        r#"SELECT id, name, score, specs FROM custom_formats ORDER BY name"#,
    )
    .fetch_all(db)
    .await?
    .into_iter()
    .filter_map(|(id, name, score, specs)| {
        Some(CustomFormat {
            id: id.into(),
            name,
            score: score.into(),
            specs: serde_json::from_value(specs).ok()?,
        })
    })
    .collect();
    let (mut season, mut episode) = (None, None);
    if !m.is_movie()
        && let Some(sn) = season_n
    {
        season = season_row(
            db,
            r#""mediaId" = $1 AND "seasonNumber" = $2"#,
            m.id,
            Some(sn as i32),
        )
        .await?;
        if let (Some(s), Some(en)) = (season, episode_n) {
            episode = sqlx::query_as::<_, EpisodeRow>(&format!(
                r#"{EPISODE_SELECT} WHERE "seasonId" = $1 AND "episodeNumber" = $2"#
            ))
            .bind(s.0)
            .bind(en as i32)
            .fetch_optional(db)
            .await?;
        }
    }
    let files = files_for(db, &m, season.map(|s| s.0), episode.as_ref()).await?;
    let quals: Vec<Option<&str>> = files.iter().map(|f| f.as_deref()).collect();
    let min_resolution = if m.qp_res_only == Some(true) && !files.is_empty() {
        max_resolution_from_quality_strings(&quals)
    } else {
        0
    };
    let whole_series = !m.is_movie() && season.is_none();
    let (min_rank, max_rank) = match (!whole_series).then(|| classify(&m, &files)) {
        Some(Decision::Window { min, max, .. }) => (Some(i64::from(min)), max.map(i64::from)),
        _ => (None, None),
    };
    let opts = ScoreOptions {
        allowed,
        allowed_langs,
        size_by_quality,
        source_min_seeders: releases
            .iter()
            .enumerate()
            .map(|(i, r)| (i as i64, r.min_seeders.unwrap_or(0).into()))
            .collect(),
        source_unknown_lang: releases
            .iter()
            .enumerate()
            .map(|(i, r)| (i as i64, r.unknown_language_iso_code.clone()))
            .collect(),
        runtime_minutes: runtime_minutes(db, &m, season_n, episode_n).await?,
        expected_title: Some(ExpectedTitle::Many(titles.expected_titles)),
        expected_season: season_n.map(i64::from),
        expected_episode: episode_n.map(i64::from),
        min_resolution: Some(i64::from(min_resolution)),
        expected_year: if m.is_movie() {
            m.year.map(i64::from)
        } else {
            None
        },
        min_custom_format_score: m.qp_id.map(|_| i64::from(m.qp_min_cf.unwrap_or(0))),
        min_rank_exclusive: min_rank,
        max_rank_inclusive: max_rank,
    };
    let deps = Deps {
        formats,
        blocked: releases
            .iter()
            .enumerate()
            .map(|(i, r)| (i as i64, r.blocked))
            .collect(),
    };
    let ids: Vec<String> = releases.iter().map(|r| r.id.clone()).collect();
    let candidates = releases
        .into_iter()
        .enumerate()
        .map(|(i, r)| ReleaseCandidate {
            flags: release_flags(
                &r.flags.clone().unwrap_or_default(),
                r.freeleech,
                r.download_volume_factor,
            ),
            title: r.title,
            download_url: String::new(),
            source_id: i as i64,
            source_name: r.source_ref,
            size: r.size as f64,
            seeders: r.seeders.into(),
            leechers: r.leechers.into(),
            publish_date: Some(r.publish_date),
        })
        .collect();
    let scored = tokio::task::block_in_place(|| {
        let formats = |title: &str, flags: &[String]| {
            fliks_domain::release::scoring::score_release_with(&deps.formats, title, flags)
        };
        let blocked =
            |_: &str, source_id: i64| deps.blocked.get(&source_id).copied().unwrap_or(false);
        score_and_sort_releases(candidates, &opts, &formats, &blocked)
    });
    Ok(scored
        .into_iter()
        .map(|s| t::ScoredRelease {
            id: ids[s.candidate.source_id as usize].clone(),
            quality_id: s.quality_id,
            quality_name: s.quality_name.into(),
            rank: s.rank as i32,
            allowed: s.allowed,
            custom_format_score: s.custom_format_score as i32,
            blocklisted: s.blocklisted,
            language_id: Some(s.language_id),
            language_name: Some(s.language_name.into()),
            language_allowed: s.language_allowed,
            is_full_season: s.is_full_season,
            coverage: Some(wit_coverage(&s.coverage)),
            size_deviation: s.size_deviation,
            video_codec: s.video_codec.map(str::to_owned),
            rejections: s
                .rejections
                .into_iter()
                .map(|r| t::Rejection {
                    code: r.code,
                    params: r
                        .params
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(k, v)| {
                            (
                                k.to_owned(),
                                match v {
                                    Param::Num(n) => t::ParamValue::Number(n as f64),
                                    Param::Str(s) => t::ParamValue::Text(s),
                                },
                            )
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect())
}

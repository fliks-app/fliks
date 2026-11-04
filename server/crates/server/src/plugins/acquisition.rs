//! The acquisition reads of `plugins.md` rule 31, built on the S5 release domain.
use super::imports::{db_err, host_err};
use super::runtime::HostError;
use super::runtime::fliks::plugin::types as t;
use crate::profiles::db as profiles;
use crate::scene::Mapping;
use crate::state::AppState;
use chrono::{Days, NaiveDate, Utc};
use fliks_domain::media::family::Family;
use fliks_domain::media::kind::MediaKind;
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

const MAX_LIMIT: u32 = 500;
const PACK_MIN_SHARE: f64 = 0.5;

#[derive(FromRow, Clone)]
struct MediaRow {
    id: i32,
    #[sqlx(try_from = "String")]
    kind: MediaKind,
    title: String,
    original_title: Option<String>,
    alternative_titles: Value,
    year: Option<i32>,
    runtime: Option<i32>,
    external_ids: Value,
    library_id: Option<i32>,
    want_family: Option<String>,
    want_language: Option<String>,
    minimum_availability: Option<String>,
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

fn media_select() -> String {
    format!(
        r#"SELECT m.id, m.type AS kind, m.title, m."originalTitle" AS original_title,
    m."alternativeTitles" AS alternative_titles, m.year, m.runtime, ids.list AS external_ids,
    m."libraryId" AS library_id, m.monitored, w.family AS want_family, w.language AS want_language,
    w."minimumAvailability" AS minimum_availability, dates.cinema_date AS in_cinemas,
    dates.digital_date AS digital_release, dates.physical_date AS physical_release,
    dates.release_date, m.status::text AS status,
    qp.id AS qp_id, qp.cutoff AS qp_cutoff, qp."upgradeAllowed" AS qp_upgrade, qp.items AS qp_items,
    qp."resolutionUpgradeOnly" AS qp_res_only, qp."minCustomFormatScore" AS qp_min_cf,
    lp."audioLanguages" AS lp_audio
  FROM media m {}
  LEFT JOIN quality_profiles qp ON qp.id = w."qualityProfileId"
  LEFT JOIN language_profiles lp ON lp.id = m."languageProfileId"
  LEFT JOIN LATERAL (SELECT COALESCE(jsonb_agg(jsonb_build_object('provider', provider, 'value', value)
      ORDER BY provider), '[]'::jsonb) AS list FROM media_external_ids WHERE "mediaId" = m.id) ids ON true {}"#,
        crate::media::wants::video_want_join("m"),
        crate::media::details::dates_join("m")
    )
}

impl MediaRow {
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
    fn external_ids(&self) -> Vec<t::ExternalId> {
        let text = |v: &Value, k: &str| v[k].as_str().map(str::to_owned);
        self.external_ids
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|e| {
                Some(t::ExternalId {
                    provider: text(e, "provider")?,
                    value: text(e, "value")?,
                })
            })
            .collect()
    }
    fn family(&self) -> Family {
        self.want_family
            .as_deref()
            .and_then(Family::parse)
            .unwrap_or(Family::Video)
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
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} WHERE m.id = $1",
        media_select()
    )))
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

const EPISODE_SELECT: &str = r#"SELECT id, "groupId" AS season_id, "number" AS episode_number,
    "endNumber" AS end_episode_number, title, "airDate" AS air_date,
    EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = items.id) AS has_file, monitored
  FROM items"#;

async fn episodes_of(db: &PgPool, season_id: i32) -> sqlx::Result<Vec<EpisodeRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{EPISODE_SELECT} WHERE "groupId" = $1 ORDER BY id"#
    )))
    .bind(season_id)
    .fetch_all(db)
    .await
}

fn on_disk(eps: &[EpisodeRow]) -> BTreeSet<i32> {
    eps.iter()
        .filter(|e| e.has_file)
        .map(|e| e.episode_number)
        .collect()
}

/// The highest-ranked quality; the first of equal ranks wins.
fn best(qualities: Vec<String>) -> Option<String> {
    qualities.into_iter().reduce(|a, b| {
        if rank_from_quality_string(Some(&b)) > rank_from_quality_string(Some(&a)) {
            b
        } else {
            a
        }
    })
}

/// `(owner id, quality)` rows of the parts of items, grouped by item or, for `by_item` false, by the
/// media of their ungrouped item, in file order.
async fn qualities_by(
    db: &PgPool,
    by_item: bool,
    ids: &[i32],
) -> sqlx::Result<HashMap<i32, Vec<String>>> {
    let sql = if by_item {
        r#"SELECT p."itemId", f.quality FROM media_files f JOIN item_parts p ON p."mediaFileId" = f.id
           WHERE p."itemId" = ANY($1) ORDER BY f.id"#
    } else {
        r#"SELECT i."mediaId", f.quality FROM media_files f JOIN item_parts p ON p."mediaFileId" = f.id
           JOIN items i ON i.id = p."itemId" WHERE i."mediaId" = ANY($1) AND i."groupId" IS NULL
           ORDER BY f.id"#
    };
    let rows: Vec<(i32, String)> = sqlx::query_as(sql).bind(ids).fetch_all(db).await?;
    let mut out: HashMap<i32, Vec<String>> = HashMap::new();
    for (id, q) in rows {
        out.entry(id).or_default().push(q);
    }
    Ok(out)
}

async fn file_qualities(db: &PgPool, by_item: bool, id: i32) -> sqlx::Result<Vec<String>> {
    Ok(qualities_by(db, by_item, &[id])
        .await?
        .remove(&id)
        .unwrap_or_default())
}

async fn files_for_episode(
    db: &PgPool,
    e: &EpisodeRow,
    disk: &BTreeSet<i32>,
) -> sqlx::Result<Files> {
    if !disk.contains(&e.episode_number) {
        return Ok(vec![]);
    }
    let q = file_qualities(db, true, e.id).await?;
    if q.is_empty() {
        return Ok(vec![None]);
    }
    Ok(vec![best(q)])
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
    if let Some(e) = episode {
        let sib = episodes_of(db, e.season_id).await?;
        return files_for_episode(db, e, &on_disk(&sib)).await;
    }
    if let Some(s) = season {
        let eps = episodes_of(db, s).await?;
        return files_for_pack(db, &eps, &on_disk(&eps)).await;
    }
    Ok(file_qualities(db, false, m.id)
        .await?
        .into_iter()
        .map(Some)
        .collect())
}

/// An error unless `kind` is wished in `family`.
fn wished(kind: MediaKind, family: Option<Family>) -> Result<(), HostError> {
    match family {
        Some(f) if !kind.families().contains(&f) => Err(host_err(
            "ERR_VALIDATION",
            format!("a {kind} is not wished in family \"{f}\""),
        )),
        _ => Ok(()),
    }
}

/// The canonical `language` of a book call; `ERR_VALIDATION` for a video call or a non-code.
fn book_language(
    kind: MediaKind,
    family: Option<Family>,
    language: Option<&str>,
) -> Result<Option<String>, HostError> {
    let Some(raw) = language else {
        return Ok(None);
    };
    if kind != MediaKind::Book || family == Some(Family::Video) {
        return Err(host_err("ERR_VALIDATION", "a video call has no language"));
    }
    fliks_domain::language::parse_language_code(raw)
        .map(Some)
        .ok_or_else(|| host_err("ERR_VALIDATION", "language is not a language code"))
}

/// `releases.score` of any kind: a book by its want of (family, language), the first want's when none, else the video score.
pub async fn score_any(
    st: &AppState,
    media_id: u32,
    family: Option<Family>,
    language: Option<String>,
    unit: Option<t::UnitRef>,
    releases: Vec<t::CandidateRelease>,
) -> Result<Vec<t::ScoredRelease>, HostError> {
    let Some(m) = media(&st.db, media_id as i32).await.map_err(db_err)? else {
        return Ok(vec![]);
    };
    wished(m.kind, family)?;
    let language = book_language(m.kind, family, language.as_deref())?;
    if m.kind != MediaKind::Book {
        let (season, episode) = super::units::video(unit.as_ref())?;
        return release::score_of(st, &m, season, episode, releases)
            .await
            .map_err(db_err);
    }
    if unit.is_some() {
        return Err(host_err("ERR_VALIDATION", "a book has no units"));
    }
    let family = match family {
        Some(f) => f,
        None => book::first_family(&st.db, m.id, language.as_deref())
            .await
            .map_err(db_err)?,
    };
    book::score(st, media_id, family, language.as_deref(), releases)
        .await
        .map_err(db_err)
}

mod book;
mod candidates;
mod create;
mod release;
pub use book::score as score_book;
pub use candidates::*;
pub use create::*;
pub use release::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = false)]
    async fn a_book_at_the_end_of_a_full_batch_leaves_a_cursor(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'B', '["book"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b');
               INSERT INTO media (id, title, type, "libraryId", monitored)
                 SELECT n, 'b' || n, 'book', 1, true FROM generate_series(3, 102) n"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let mut c = db.acquire().await.unwrap();
        crate::media::items::create_shell(&mut c, 102, MediaKind::Book, Default::default())
            .await
            .unwrap();
        drop(c);
        let on = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
        let q = |cursor| t::CandidatesQuery {
            kind: Some("book".into()),
            family: None,
            media_ids: None,
            available_on: "2030-01-01".into(),
            limit: 1,
            cursor,
        };
        let page = candidates(&db, q(None), on).await.unwrap();
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.cursor.as_deref(), Some("102.0.0"));
        let next = candidates(&db, q(page.cursor), on).await.unwrap();
        assert!(next.items.is_empty() && next.cursor.is_none());
    }

    #[sqlx::test(migrations = false)]
    async fn candidates_page_by_keyset_across_media_batches(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'P', 18, '[]');
               INSERT INTO libraries (id, name) VALUES (1, 'L');
INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO media (title, year, type, status, "libraryId", "folderName", monitored)
                 SELECT 'm' || n, 2000, 'movie', 'released', 1, 'm' || n, n % 5 <> 0 FROM generate_series(1, 250) n;
               INSERT INTO wants ("mediaId", family, "qualityProfileId") SELECT id, 'video', 1 FROM media;"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let mut seen = vec![];
        let mut cursor = None;
        loop {
            let q = t::CandidatesQuery {
                kind: None,
                family: None,
                media_ids: None,
                available_on: "2030-01-01".into(),
                limit: 70,
                cursor,
            };
            let page = candidates(&db, q, NaiveDate::from_ymd_opt(2030, 1, 1).unwrap())
                .await
                .unwrap();
            seen.extend(page.items.iter().map(|i| i.media_id));
            match page.cursor {
                Some(c) => cursor = Some(c),
                None => break,
            }
        }
        let want: Vec<u32> = (1..=250).filter(|n| n % 5 != 0).collect();
        assert_eq!(seen, want);
    }

    #[sqlx::test(migrations = false)]
    async fn the_context_of_a_movie_item_is_null(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name) VALUES (1, 'L');
INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO media (id, title, type, "libraryId") VALUES (1, 'm', 'movie', 1)"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let mut c = db.acquire().await.unwrap();
        crate::media::items::create_shell(
            &mut c,
            1,
            fliks_domain::media::kind::MediaKind::Movie,
            Default::default(),
        )
        .await
        .unwrap();
        drop(c);
        let item = crate::media::items::sole_item(&db, 1)
            .await
            .unwrap()
            .unwrap();
        let st = AppState::new(
            db.clone(),
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        assert!(
            context(&st, 1, None, None, None, Some(item as u32))
                .await
                .unwrap()
                .is_none()
        );
    }

    async fn series_with_episodes(db: &PgPool) -> (i32, Vec<i32>) {
        sqlx::raw_sql(
            r#"INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'P', 18, '[]');
               INSERT INTO libraries (id, name) VALUES (1, 'L');
INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO media (id, title, type, "libraryId", monitored) VALUES (1, 'Show', 'series', 1, true);
               INSERT INTO media_external_ids ("mediaId", kind, provider, value)
                 VALUES (1, 'series', 'tmdb', '5'), (1, 'series', 'tvdb', '7')"#,
        )
        .execute(db)
        .await
        .unwrap();
        let mut c = db.acquire().await.unwrap();
        let want = crate::media::items::NewWant {
            quality_profile_id: Some(1),
            ..Default::default()
        };
        crate::media::items::create_shell(&mut c, 1, MediaKind::Series, want)
            .await
            .unwrap();
        drop(c);
        let edition = crate::media::items::video_edition(db, 1).await.unwrap();
        let group: i32 = sqlx::query_scalar(
            r#"INSERT INTO item_groups ("mediaId", "number", monitored) VALUES (1, 2, true) RETURNING id"#,
        )
        .fetch_one(db)
        .await
        .unwrap();
        let mut items = vec![];
        for n in 1..=3 {
            items.push(sqlx::query_scalar(
                r#"INSERT INTO items ("mediaId", "editionId", "groupId", "number", title, "airDate", monitored)
                   VALUES (1, $1, $2, $3, 'E' || $3, make_date(2020, 1, $3), true) RETURNING id"#,
            )
            .bind(edition)
            .bind(group)
            .bind(n)
            .fetch_one(db)
            .await
            .unwrap());
        }
        (group, items)
    }

    #[sqlx::test(migrations = false)]
    async fn the_scope_of_a_target_names_its_group_or_item(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let (group, items) = series_with_episodes(&db).await;
        let st = AppState::new(
            db.clone(),
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        let whole = context(&st, 1, None, None, None, None)
            .await
            .unwrap()
            .unwrap();
        assert!(whole.scope.is_empty() && whole.want.is_none());
        assert_eq!((whole.family, whole.language), (t::Family::Video, None));
        let ids: Vec<_> = whole
            .external_ids
            .iter()
            .map(|e| (&*e.provider, &*e.value))
            .collect();
        assert_eq!(ids, [("tmdb", "5"), ("tvdb", "7")]);
        let pack = context(&st, 1, None, None, Some(group as u32), None)
            .await
            .unwrap()
            .unwrap();
        let [u] = &pack.scope[..] else {
            panic!("one unit")
        };
        assert_eq!((u.ref_.group, u.ref_.number), (Some(2), None));
        assert_eq!(
            (u.group_id, u.item_id, u.unit_count),
            (Some(group as u32), None, Some(3))
        );
        let ep = context(&st, 1, None, None, None, Some(items[1] as u32))
            .await
            .unwrap()
            .unwrap();
        let [u] = &ep.scope[..] else {
            panic!("one unit")
        };
        assert_eq!((u.ref_.group, u.ref_.number), (Some(2), Some(2.0)));
        assert_eq!(u.item_id, Some(items[1] as u32));
        assert_eq!(
            (u.title.as_deref(), u.air_date.as_deref()),
            (Some("E2"), Some("2020-01-02"))
        );
        assert!(matches!(
            ep.want,
            Some(t::Want {
                decision: t::WantDecision::Missing,
                ..
            })
        ));
    }

    #[sqlx::test(migrations = false)]
    async fn a_mapped_series_target_carries_the_scene_units(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let (group, items) = series_with_episodes(&db).await;
        let st = AppState::new(
            db.clone(),
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        let units = |tg: &t::Target| -> Vec<(Option<u32>, Option<f64>)> {
            tg.search_units
                .iter()
                .map(|u| (u.group, u.number))
                .collect()
        };
        let season = || context(&st, 1, None, None, Some(group as u32), None);
        let episode = || context(&st, 1, None, None, None, Some(items[1] as u32));
        assert_eq!(units(&season().await.unwrap().unwrap()), [(Some(2), None)]);
        assert_eq!(
            units(&episode().await.unwrap().unwrap()),
            [(Some(2), Some(2.0))]
        );
        let entries: Vec<_> = (1..=3)
            .map(|e| serde_json::json!({"sceneSeason": 3, "sceneEpisode": e, "season": 2, "episode": e}))
            .collect();
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId", entries) VALUES (7, $1)"#)
            .bind(sqlx::types::Json(serde_json::json!({ "entries": entries })))
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(units(&season().await.unwrap().unwrap()), [(Some(3), None)]);
        assert_eq!(
            units(&episode().await.unwrap().unwrap()),
            [(Some(3), Some(2.0))]
        );
        assert!(
            context(&st, 1, None, None, None, None)
                .await
                .unwrap()
                .unwrap()
                .search_units
                .is_empty()
        );
    }

    async fn map_scene_three_to_aired_two(db: &PgPool) {
        let entries: Vec<_> = (1..=3)
            .map(|e| serde_json::json!({"sceneSeason": 3, "sceneEpisode": e, "season": 2, "episode": e}))
            .collect();
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId", entries) VALUES (7, $1)"#)
            .bind(sqlx::types::Json(serde_json::json!({ "entries": entries })))
            .execute(db)
            .await
            .unwrap();
    }

    fn app_state(db: &PgPool) -> AppState {
        let cfg = crate::config::Config::from_lookup(|_| None);
        AppState::new(db.clone(), cfg, "0123456789abcdef0123456789abcdef")
    }

    fn title(id: &str, title: &str) -> t::ReleaseTitle {
        t::ReleaseTitle {
            id: id.into(),
            title: title.into(),
            publish_date: "2020-01-01T00:00:00Z".into(),
        }
    }

    #[sqlx::test(migrations = false)]
    async fn releases_match_reads_scene_numbers_as_aired(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        series_with_episodes(&db).await;
        let st = app_state(&db);
        let titles = || {
            vec![
                title("a", "Show.S03E02.1080p.WEB"),
                title("b", "Show.S02E02.1080p.WEB"),
            ]
        };
        let unit = |m: &t::ReleaseMatch| m.unit.as_ref().map(|u| (u.group, u.number));
        let before = matches(&st, titles(), None).await.unwrap();
        assert_eq!(before[0].skip_reason, Some(t::SkipReason::NotAvailable));
        assert_eq!(unit(&before[1]), Some((Some(2), Some(2.0))));
        map_scene_three_to_aired_two(&db).await;
        let after = matches(&st, titles(), None).await.unwrap();
        assert_eq!(unit(&after[0]), Some((Some(2), Some(2.0))));
        assert_ne!(after[0].skip_reason, Some(t::SkipReason::NotAvailable));
        // A scene number the mapping does not list keeps its number.
        assert_eq!(unit(&after[1]), Some((Some(2), Some(2.0))));
    }

    #[sqlx::test(migrations = false)]
    async fn an_unknown_mapping_skips_numbered_releases(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        series_with_episodes(&db).await;
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId") VALUES (7)"#)
            .execute(&db)
            .await
            .unwrap();
        let st = app_state(&db);
        let down = std::sync::Arc::new(crate::metadata::scene_stub::SceneStub::default());
        down.down.store(true, std::sync::atomic::Ordering::SeqCst);
        st.metadata.add_plugin(down);
        let out = matches(&st, vec![title("a", "Show.S03E02.1080p.WEB")], None)
            .await
            .unwrap();
        assert_eq!(out[0].skip_reason, Some(t::SkipReason::SceneUnresolved));
        assert_eq!(out[0].decision, t::MatchDecision::Skip);
    }

    #[sqlx::test(migrations = false)]
    async fn candidates_carry_the_scene_units_of_a_mapped_series(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        series_with_episodes(&db).await;
        map_scene_three_to_aired_two(&db).await;
        let q = t::CandidatesQuery {
            kind: Some("series".into()),
            family: None,
            media_ids: None,
            available_on: "2030-01-01".into(),
            limit: 50,
            cursor: None,
        };
        let on = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
        let page = candidates(&db, q, on).await.unwrap();
        let units: Vec<_> = page
            .items
            .iter()
            .map(|tg| {
                tg.search_units
                    .iter()
                    .map(|u| (u.group, u.number))
                    .collect::<Vec<_>>()
            })
            .collect();
        assert_eq!(units.len(), 4, "the season pack and its three episodes");
        assert!(units.contains(&vec![(Some(3), None)]));
        for n in 1..=3 {
            assert!(units.contains(&vec![(Some(3), Some(f64::from(n)))]));
        }
    }

    #[sqlx::test(migrations = false)]
    async fn candidates_name_their_unit_and_skip_unserved_kinds(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let (group, items) = series_with_episodes(&db).await;
        let on = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
        let query = |kind, family| t::CandidatesQuery {
            kind,
            family,
            media_ids: None,
            available_on: "2030-01-01".into(),
            limit: 50,
            cursor: None,
        };
        let page = candidates(&db, query(Some("series".into()), None), on)
            .await
            .unwrap();
        let units: Vec<_> = page
            .items
            .iter()
            .map(|i| (i.scope[0].group_id, i.scope[0].item_id))
            .collect();
        let g = Some(group as u32);
        let item = |n: usize| Some(items[n] as u32);
        assert_eq!(units, [(g, None), (g, item(0)), (g, item(1)), (g, item(2))]);
        for (kind, family) in [
            (Some("book".into()), None),
            (Some("artist".into()), None),
            (None, Some(t::Family::Audio)),
            (Some("movie".into()), None),
        ] {
            let page = candidates(&db, query(kind.clone(), family), on)
                .await
                .unwrap();
            assert!(
                page.items.is_empty() && page.cursor.is_none(),
                "{kind:?} {family:?}"
            );
        }
    }

    #[test]
    fn published_dates() {
        let at = |s: &str| published(s).map(|d| d.to_rfc3339());
        let want = Some("2026-10-17T10:00:00+00:00".to_owned());
        assert_eq!(at("2026-10-17T12:00:00+02:00"), want);
        assert_eq!(at("Sat, 17 Oct 2026 10:00:00 +0000"), want);
        assert_eq!(at("2026-10-17T10:00:00"), want);
        assert_eq!(at("not a date"), None);
    }

    #[test]
    fn best_keeps_the_first_of_equal_ranks() {
        let a = "Bluray-1080p".to_owned();
        let b = format!("{a} ");
        assert_eq!(
            rank_from_quality_string(Some(&a)),
            rank_from_quality_string(Some(&b))
        );
        assert_eq!(best(vec![a.clone(), b]), Some(a));
    }
}

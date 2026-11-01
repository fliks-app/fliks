//! The acquisition reads of `plugins.md` rule 31, built on the S5 release domain.
use super::runtime::fliks::plugin::types as t;
use crate::profiles::db as profiles;
use crate::state::AppState;
use chrono::{Days, NaiveDate, Utc};
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
    imdb_id: Option<String>,
    tmdb_id: Option<i32>,
    tvdb_id: Option<i32>,
    library_id: Option<i32>,
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
    m."alternativeTitles" AS alternative_titles, m.year, m.runtime, ids.imdb AS imdb_id,
    ids.tmdb AS tmdb_id, ids.tvdb AS tvdb_id, m."libraryId" AS library_id, m.monitored,
    w."minimumAvailability" AS minimum_availability, dates.cinema_date AS in_cinemas,
    dates.digital_date AS digital_release, dates.physical_date AS physical_release,
    dates.release_date, m.status::text AS status,
    qp.id AS qp_id, qp.cutoff AS qp_cutoff, qp."upgradeAllowed" AS qp_upgrade, qp.items AS qp_items,
    qp."resolutionUpgradeOnly" AS qp_res_only, qp."minCustomFormatScore" AS qp_min_cf,
    lp."audioLanguages" AS lp_audio
  FROM media m {}
  LEFT JOIN quality_profiles qp ON qp.id = w."qualityProfileId"
  LEFT JOIN language_profiles lp ON lp.id = m."languageProfileId" {} {}"#,
        crate::media::wants::video_want_join("m"),
        crate::media::external_ids::ids_join("m"),
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

/// `(owner id, quality)` rows of `media_files` grouped by media (or by item parts), in row order.
async fn qualities_by(
    db: &PgPool,
    by_item: bool,
    ids: &[i32],
) -> sqlx::Result<HashMap<i32, Vec<String>>> {
    let sql = if by_item {
        r#"SELECT p."itemId", f.quality FROM media_files f JOIN item_parts p ON p."mediaFileId" = f.id
           WHERE p."itemId" = ANY($1) ORDER BY f.id"#
    } else {
        r#"SELECT "mediaId", quality FROM media_files WHERE "mediaId" = ANY($1) ORDER BY id"#
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
    match m.kind {
        MediaKind::Movie => Ok(file_qualities(db, false, m.id)
            .await?
            .into_iter()
            .map(Some)
            .collect()),
        MediaKind::Series => {
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
    }
}

mod candidates;
mod release;
pub use candidates::*;
pub use release::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = false)]
    async fn candidates_page_by_keyset_across_media_batches(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'P', 18, '[]');
               INSERT INTO libraries (id, name, path) VALUES (1, 'L', '/m');
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
            r#"INSERT INTO libraries (id, name, path) VALUES (1, 'L', '/m');
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
            context(&st, 1, None, Some(item as u32))
                .await
                .unwrap()
                .is_none()
        );
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

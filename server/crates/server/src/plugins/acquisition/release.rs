//! The release reads of rule 31: matching titles to the library and scoring candidates.
use super::*;
use crate::scene::Mapping;
use fliks_domain::release::fitting_kinds;
use fliks_domain::release::parsing::season_episode::ParsedSeasonEpisode;

pub(super) fn wit_coverage(c: &ReleaseCoverage) -> t::ReleaseCoverage {
    let span = |s: &fliks_domain::release::parsing::season_episode::Span| t::Span {
        first: s.from as f64,
        last: s.to as f64,
    };
    t::ReleaseCoverage {
        groups: c.seasons.as_ref().map(span),
        units: c.episodes.as_ref().map(span),
        complete: c.complete_series,
    }
}

/// `releases.match`: one index of the monitored library per call, then each title in order.
pub async fn matches(
    st: &AppState,
    titles: Vec<t::ReleaseTitle>,
    min_age: Option<u32>,
) -> sqlx::Result<Vec<t::ReleaseMatch>> {
    let db = &st.db;
    let library: Vec<MediaRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{} WHERE m.monitored ORDER BY m.id",
        media_select()
    )))
    .fetch_all(db)
    .await?;
    let (library, identified) = identify(library, titles).await;
    let mut out = vec![];
    let mut scenes: HashMap<i32, Mapping> = HashMap::new();
    for (entry, se, coverage, hits) in identified {
        let seasonal = hits
            .first()
            .map(|&i| &library[i])
            .filter(|m| m.kind.has_seasons());
        if let Some(m) = seasonal.filter(|_| se.season.is_some())
            && !scenes.contains_key(&m.id)
        {
            scenes.insert(m.id, crate::scene::for_media(st, m.id).await?);
        }
        let scene = seasonal
            .and_then(|m| scenes.get(&m.id))
            .unwrap_or(&Mapping::Unmapped);
        out.push(match_one(db, &library, min_age, (entry, scene), &se, coverage, hits).await?);
    }
    Ok(out)
}

/// The library media a title names: the first, and every comic volume when the first is a comic.
type Hits = Vec<usize>;

type Identified = (
    t::ReleaseTitle,
    ParsedSeasonEpisode,
    t::ReleaseCoverage,
    Hits,
);

/// Each title with its parsed season and episode, its coverage and the library media it names.
async fn identify(
    library: Vec<MediaRow>,
    titles: Vec<t::ReleaseTitle>,
) -> (Vec<MediaRow>, Vec<Identified>) {
    // Index and identification are CPU-bound over owned data; only the DB reads stay async.
    tokio::task::spawn_blocking(move || {
        let indexed: Vec<_> = library
            .iter()
            .map(|m| {
                let mut names = vec![
                    m.title.clone(),
                    m.original_title.clone().unwrap_or_default(),
                ];
                names.extend(m.alt());
                index_title_expectations(&names)
            })
            .collect();
        let identified: Vec<_> = titles
            .into_iter()
            .map(|entry| {
                let se = parse_season_episode(&entry.title);
                let coverage = wit_coverage(&coverage_of(&se));
                let tokens = release_title_tokens(&entry.title);
                let named =
                    |idx: &_| matches_indexed_expectation(&tokens, idx, WhenUnreadable::NoMatch);
                let fits = fitting_kinds(&entry.title, se.season.is_some() || se.episode.is_some());
                let fit = |i: &usize| fits.is_none_or(|k| k.contains(&library[*i].kind));
                let all: Vec<usize> = (0..indexed.len()).filter(|i| named(&indexed[*i])).collect();
                let first = all.iter().copied().find(fit);
                let mut hits: Hits = first.into_iter().collect();
                if let Some(first) = hits.first().copied()
                    && library[first].kind == MediaKind::Comic
                {
                    hits = (first..indexed.len())
                        .filter(|i| library[*i].kind == MediaKind::Comic && named(&indexed[*i]))
                        .collect();
                }
                (entry, se, coverage, hits)
            })
            .collect();
        (library, identified)
    })
    .await
    .unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()))
}

/// The verdict on one title: a skip with its reason, or a grab.
async fn match_one(
    db: &PgPool,
    library: &[MediaRow],
    min_age: Option<u32>,
    (entry, scene): (t::ReleaseTitle, &Mapping),
    se: &ParsedSeasonEpisode,
    coverage: t::ReleaseCoverage,
    hits: Hits,
) -> sqlx::Result<t::ReleaseMatch> {
    let hit = hits.first().copied();
    // The title's numbers are scene numbers: read them as aired ones before anything uses them.
    let translated;
    let unresolved = |media: i32| t::ReleaseMatch {
        id: entry.id.clone(),
        media_id: Some(media as u32),
        unit: None,
        whole_group: se.is_full_season,
        coverage: Some(coverage),
        decision: t::MatchDecision::Skip,
        skip_reason: Some(t::SkipReason::SceneUnresolved),
    };
    let (se, coverage) = match (hit.map(|i| &library[i]), scene) {
        (Some(m), Mapping::Unknown) if se.season.is_some() => return Ok(unresolved(m.id)),
        (Some(m), Mapping::Mapped(map)) => match map.translate(se) {
            Some(t) => {
                translated = t;
                (&translated, wit_coverage(&coverage_of(&translated)))
            }
            None => return Ok(unresolved(m.id)),
        },
        _ => (se, coverage),
    };
    if let Some(book) = hit
        .map(|i| &library[i])
        .filter(|m| m.kind == MediaKind::Book)
    {
        return super::book::match_one(db, book, min_age, entry).await;
    }
    if hit.is_some_and(|i| library[i].kind == MediaKind::Comic) {
        return super::comic::match_one(db, library, &hits, min_age, entry).await;
    }
    let skip = |reason: t::SkipReason, media: Option<i32>, s: Option<i32>, e: Option<i32>| {
        t::ReleaseMatch {
            id: entry.id.clone(),
            media_id: media.map(|m| m as u32),
            unit: crate::plugins::units::unit_ref(s, e),
            whole_group: se.is_full_season,
            coverage: Some(coverage),
            decision: t::MatchDecision::Skip,
            skip_reason: Some(reason),
        }
    };
    let Some(m) = hit.map(|i| &library[i]) else {
        return Ok(skip(t::SkipReason::Unmatched, None, None, None));
    };
    let (mut season_n, mut episode_n) = (None, None);
    let files: Files = if m.kind.has_seasons() {
        let Some(sn) = se.season else {
            return Ok(skip(t::SkipReason::NotAvailable, Some(m.id), None, None));
        };
        let Some((sid, _, number, monitored)) = season_row(
            db,
            r#""mediaId" = $1 AND "number" = $2"#,
            m.id,
            Some(sn as i32),
        )
        .await?
        else {
            return Ok(skip(t::SkipReason::NotAvailable, Some(m.id), None, None));
        };
        if !monitored {
            return Ok(skip(
                t::SkipReason::NotMonitored,
                Some(m.id),
                Some(number),
                None,
            ));
        }
        season_n = Some(number);
        let eps = episodes_of(db, sid).await?;
        if se.is_full_season {
            if eps.is_empty() {
                return Ok(skip(
                    t::SkipReason::NotAvailable,
                    Some(m.id),
                    season_n,
                    None,
                ));
            }
            files_for_pack(db, &eps, &on_disk(&eps)).await?
        } else if let Some(en) = se.episode {
            let Some(e) = eps.iter().find(|e| i64::from(e.episode_number) == en) else {
                return Ok(skip(
                    t::SkipReason::NotAvailable,
                    Some(m.id),
                    season_n,
                    None,
                ));
            };
            if !e.monitored {
                return Ok(skip(
                    t::SkipReason::NotMonitored,
                    Some(m.id),
                    season_n,
                    Some(e.episode_number),
                ));
            }
            episode_n = Some(e.episode_number);
            files_for_episode(db, e, &on_disk(&eps)).await?
        } else {
            return Ok(skip(
                t::SkipReason::NotAvailable,
                Some(m.id),
                season_n,
                None,
            ));
        }
    } else {
        file_qualities(db, false, m.id)
            .await?
            .into_iter()
            .map(Some)
            .collect()
    };
    match classify(m, &files) {
        Decision::Unprofiled => {
            return Ok(skip(
                t::SkipReason::Unprofiled,
                Some(m.id),
                season_n,
                episode_n,
            ));
        }
        Decision::Window {
            mode: Mode::Skip, ..
        } => {
            return Ok(skip(t::SkipReason::OnDisk, Some(m.id), season_n, episode_n));
        }
        _ => {}
    }
    if let Some(min) = min_age.filter(|m| *m > 0)
        && let Some(at) = published(&entry.publish_date)
    {
        let age = (Utc::now() - at).num_milliseconds() as f64 / 60_000.0;
        if age < f64::from(min) {
            return Ok(skip(
                t::SkipReason::TooFresh,
                Some(m.id),
                season_n,
                episode_n,
            ));
        }
    }
    Ok(t::ReleaseMatch {
        id: entry.id.clone(),
        media_id: Some(m.id as u32),
        unit: crate::plugins::units::unit_ref(season_n, episode_n),
        whole_group: se.is_full_season,
        coverage: Some(coverage),
        decision: t::MatchDecision::Grab,
        skip_reason: None,
    })
}

/// `Date.parse` of an indexer date: RFC 3339, then RFC 2822, then ISO 8601 without offset as UTC.
pub(super) fn published(s: &str) -> Option<chrono::DateTime<Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(s))
        .map(|d| d.to_utc())
        .ok()
        .or_else(|| fliks_domain::livetv::m3u::parse_iso_date(s))
}

pub(super) async fn runtime_minutes(
    db: &PgPool,
    m: &MediaRow,
    season: Option<u32>,
    episode: Option<u32>,
) -> sqlx::Result<f64> {
    let (Some(season), true) = (season, m.kind.has_seasons()) else {
        return Ok(m.runtime.unwrap_or(0).into());
    };
    let total: i64 = sqlx::query_scalar(
        r#"SELECT COALESCE(SUM(ep.runtime), 0)::bigint FROM items ep JOIN item_groups s ON s.id = ep."groupId"
            WHERE s."mediaId" = $1 AND s."number" = $2 AND ($3::int IS NULL OR ep."number" = $3)"#,
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
        r#"SELECT count(*) FROM items ep JOIN item_groups s ON s.id = ep."groupId" WHERE s."mediaId" = $1 AND s."number" = $2"#,
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
    let Some(m) = media(&st.db, media_id as i32).await? else {
        return Ok(vec![]);
    };
    score_of(st, &m, season_n, episode_n, releases).await
}

/// `score` of an already loaded media.
pub(super) async fn score_of(
    st: &AppState,
    m: &MediaRow,
    season_n: Option<u32>,
    episode_n: Option<u32>,
    releases: Vec<t::CandidateRelease>,
) -> sqlx::Result<Vec<t::ScoredRelease>> {
    let db = &st.db;
    let (allowed, allowed_langs) = m.allowed();
    let titles = resolve_search_titles(&m.search(), None);
    let (size_by_quality, formats) = scoring_tables(db).await?;
    let (season, episode) = season_and_episode(db, m, season_n, episode_n).await?;
    let scene = if m.kind.has_seasons() {
        crate::scene::for_media(st, m.id).await?
    } else {
        Mapping::Unmapped
    };
    let scene_unknown = scene == Mapping::Unknown;
    let scene_map = match scene {
        Mapping::Mapped(map) => Some(map),
        _ => None,
    };
    let files = files_for(db, m, season.map(|s| s.0), episode.as_ref()).await?;
    let quals: Vec<Option<&str>> = files.iter().map(|f| f.as_deref()).collect();
    let min_resolution = if m.qp_res_only == Some(true) && !files.is_empty() {
        max_resolution_from_quality_strings(&quals)
    } else {
        0
    };
    let whole_series = m.kind.has_seasons() && season.is_none();
    let (min_rank, max_rank) = match (!whole_series).then(|| classify(m, &files)) {
        Some(Decision::Window { min, max, .. }) => (Some(i64::from(min)), max.map(i64::from)),
        _ => (None, None),
    };
    let inp = Inputs::of(releases);
    let opts = ScoreOptions {
        allowed,
        allowed_langs,
        size_by_quality,
        source_min_seeders: inp.min_seeders,
        source_unknown_lang: inp.unknown_lang,
        runtime_minutes: runtime_minutes(db, m, season_n, episode_n).await?,
        expected_title: Some(ExpectedTitle::Many(titles.expected_titles)),
        expected_season: season_n.map(i64::from),
        expected_episode: episode_n.map(i64::from),
        min_resolution: Some(i64::from(min_resolution)),
        expected_year: m.year.map(i64::from).filter(|_| !m.kind.has_seasons()),
        min_custom_format_score: m.qp_id.map(|_| i64::from(m.qp_min_cf.unwrap_or(0))),
        min_rank_exclusive: min_rank,
        max_rank_inclusive: max_rank,
        scene_map,
        scene_unknown,
    };
    let (blocked, ids, candidates) = (inp.blocked, inp.ids, inp.candidates);
    let scored = tokio::task::spawn_blocking(move || {
        let compiled = fliks_domain::release::scoring::CompiledFormats::new(&formats);
        let formats = |title: &str, flags: &[String]| compiled.score(title, flags);
        let blocked = |_: &str, source_id: i64| blocked.get(&source_id).copied().unwrap_or(false);
        score_and_sort_releases(candidates, &opts, &formats, &blocked)
    })
    .await
    .unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()));
    Ok(into_scored(scored, &ids))
}

type SizeTable = BTreeMap<u32, SizeLimits>;

/// The size limits per video quality and the custom formats of the profiles.
async fn scoring_tables(db: &PgPool) -> sqlx::Result<(SizeTable, Vec<CustomFormat>)> {
    let size_by_quality: SizeTable = profiles::definition_list(db, Family::Video)
        .await?
        .into_iter()
        .map(|d| {
            (
                d.quality_id as u32,
                SizeLimits {
                    min: d.min_size,
                    preferred: d.preferred_size,
                    max: d.max_size,
                },
            )
        })
        .collect();
    Ok((size_by_quality, custom_formats(db).await?))
}

pub(super) async fn custom_formats(db: &PgPool) -> sqlx::Result<Vec<CustomFormat>> {
    Ok(profiles::format_list(db)
        .await?
        .into_iter()
        .filter_map(|f| {
            Some(CustomFormat {
                id: f.id.into(),
                name: f.name,
                score: f.score.into(),
                specs: serde_json::from_value(f.specs.0).ok()?,
            })
        })
        .collect())
}

/// What the scorers read of the candidate releases, keyed by their position.
pub(super) struct Inputs {
    pub ids: Vec<String>,
    pub candidates: Vec<ReleaseCandidate>,
    pub min_seeders: BTreeMap<i64, i64>,
    pub unknown_lang: BTreeMap<i64, Option<String>>,
    pub blocked: BTreeMap<i64, bool>,
}

impl Inputs {
    pub(super) fn of(releases: Vec<t::CandidateRelease>) -> Self {
        let (mut min_seeders, mut unknown_lang, mut blocked) =
            <(BTreeMap<_, _>, BTreeMap<_, _>, BTreeMap<_, _>)>::default();
        for (i, r) in releases.iter().enumerate() {
            let i = i as i64;
            min_seeders.insert(i, i64::from(r.min_seeders.unwrap_or(0)));
            unknown_lang.insert(i, r.unknown_language_iso_code.clone());
            blocked.insert(i, r.blocked);
        }
        let ids = releases.iter().map(|r| r.id.clone()).collect();
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
        Inputs {
            ids,
            candidates,
            min_seeders,
            unknown_lang,
            blocked,
        }
    }
}

type SeasonRow = (i32, i32, i32, bool);

/// The season and the episode a scoring call is about, for a series.
async fn season_and_episode(
    db: &PgPool,
    m: &MediaRow,
    season_n: Option<u32>,
    episode_n: Option<u32>,
) -> sqlx::Result<(Option<SeasonRow>, Option<EpisodeRow>)> {
    let (mut season, mut episode) = (None, None);
    if m.kind.has_seasons()
        && let Some(sn) = season_n
    {
        season = season_row(
            db,
            r#""mediaId" = $1 AND "number" = $2"#,
            m.id,
            Some(sn as i32),
        )
        .await?;
        if let (Some(s), Some(en)) = (season, episode_n) {
            episode = sqlx::query_as::<_, EpisodeRow>(sqlx::AssertSqlSafe(format!(
                r#"{EPISODE_SELECT} WHERE "groupId" = $1 AND "number" = $2"#
            )))
            .bind(s.0)
            .bind(en as i32)
            .fetch_optional(db)
            .await?;
        }
    }
    Ok((season, episode))
}

fn into_scored(
    scored: Vec<fliks_domain::release::scoring::ScoredRelease>,
    ids: &[String],
) -> Vec<t::ScoredRelease> {
    scored
        .into_iter()
        .map(|s| t::ScoredRelease {
            id: ids[s.candidate.source_id as usize].clone(),
            quality_id: s.quality_id,
            quality_name: s.quality_name.into(),
            rank: s.rank as i32,
            allowed: s.allowed,
            custom_format_score: s.custom_format_score as i32,
            blocklisted: s.blocklisted,
            languages: wit_languages(&s.languages),
            language_allowed: s.language_allowed,
            whole_group: s.is_full_season,
            coverage: Some(wit_coverage(&s.coverage)),
            size_deviation: s.size_deviation,
            video_codec: s.video_codec.map(str::to_owned),
            rejections: wit_rejections(s.rejections),
        })
        .collect()
}

pub(super) fn wit_languages(
    langs: &[&'static fliks_domain::language::AppLanguage],
) -> Vec<t::ReleaseLanguage> {
    langs
        .iter()
        .map(|l| t::ReleaseLanguage {
            id: l.id,
            name: l.name.into(),
        })
        .collect()
}

pub(super) fn wit_rejections(
    rejections: Vec<fliks_domain::release::scoring::ReleaseRejection>,
) -> Vec<t::Rejection> {
    rejections
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
        .collect()
}

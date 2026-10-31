//! The candidates read of rule 31: the wanted targets of the monitored library, paged by keyset.
use super::*;

pub(super) fn want(m: &MediaRow, d: Option<Decision>, files: &Files) -> Option<t::Want> {
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

pub(super) fn target(
    m: &MediaRow,
    d: Option<Decision>,
    files: &Files,
) -> Option<t::AcquisitionTarget> {
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
        kind: m.kind.into(),
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

pub(super) fn episode_ref(e: &EpisodeRow) -> t::EpisodeRef {
    t::EpisodeRef {
        id: e.id as u32,
        number: e.episode_number as u32,
        end_number: e.end_episode_number.map(|n| n as u32),
        air_date: e.air_date.map(|d| d.to_string()),
        title: e.title.clone(),
    }
}

pub(super) async fn season_row(
    db: &PgPool,
    where_: &str,
    a: i32,
    b: Option<i32>,
) -> sqlx::Result<Option<(i32, i32, i32, bool)>> {
    let sql =
        format!(r#"SELECT id, "mediaId", "seasonNumber", monitored FROM seasons WHERE {where_}"#);
    let mut q = sqlx::query_as(sqlx::AssertSqlSafe(sql)).bind(a);
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
        let e: Option<EpisodeRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
            "{EPISODE_SELECT} WHERE id = $1"
        )))
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
    let whole_series = m.kind.is_series() && season.is_none() && episode.is_none();
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

pub(super) fn available(m: &MediaRow, today: NaiveDate) -> bool {
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

pub(super) struct EpTarget {
    media: MediaRow,
    season: (i32, i32),
    episode: EpisodeRow,
    files: Files,
    decision: Decision,
}

pub(super) async fn movie_targets(
    db: &PgPool,
    ids: Option<&[i32]>,
) -> sqlx::Result<Vec<(MediaRow, Files, Decision)>> {
    let rows: Vec<MediaRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{MEDIA_SELECT} WHERE m.monitored AND m.type = 'movie'
             AND (NOT EXISTS (SELECT 1 FROM media_files f WHERE f."mediaId" = m.id) OR qp."upgradeAllowed")
             AND ($1::int[] IS NULL OR m.id = ANY($1)) ORDER BY m.id"#
    )))
    .bind(ids)
    .fetch_all(db)
    .await?;
    let mids: Vec<i32> = rows.iter().map(|m| m.id).collect();
    let mut files = qualities_by(db, "mediaId", &mids).await?;
    Ok(rows
        .into_iter()
        .filter_map(|m| {
            let f: Files = files
                .remove(&m.id)
                .unwrap_or_default()
                .into_iter()
                .map(Some)
                .collect();
            let d = classify(&m, &f);
            (!excluded(d)).then_some((m, f, d))
        })
        .collect())
}

pub(super) async fn episode_targets(
    db: &PgPool,
    ids: Option<&[i32]>,
    today: NaiveDate,
) -> sqlx::Result<Vec<EpTarget>> {
    let rows: Vec<(i32, i32, i32, i32)> = sqlx::query_as(
        r#"SELECT ep.id, s.id, s."seasonNumber", m.id FROM episodes ep
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
    let eids: Vec<i32> = rows.iter().map(|r| r.0).collect();
    let mut mids: Vec<i32> = rows.iter().map(|r| r.3).collect();
    mids.sort_unstable();
    mids.dedup();
    let mut episodes: HashMap<i32, EpisodeRow> = sqlx::query_as::<_, EpisodeRow>(
        sqlx::AssertSqlSafe(format!("{EPISODE_SELECT} WHERE id = ANY($1)")),
    )
    .bind(&eids)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|e| (e.id, e))
    .collect();
    let medias: HashMap<i32, MediaRow> = sqlx::query_as::<_, MediaRow>(sqlx::AssertSqlSafe(
        format!("{MEDIA_SELECT} WHERE m.id = ANY($1)"),
    ))
    .bind(&mids)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|m| (m.id, m))
    .collect();
    let with_file: Vec<i32> = episodes
        .values()
        .filter(|e| e.has_file)
        .map(|e| e.id)
        .collect();
    let mut files = qualities_by(db, "episodeId", &with_file).await?;
    let mut out = vec![];
    for (eid, sid, snum, mid) in rows {
        let (Some(e), Some(m)) = (episodes.remove(&eid), medias.get(&mid)) else {
            continue;
        };
        let files: Files = if e.has_file {
            vec![best(files.remove(&e.id).unwrap_or_default())]
        } else {
            vec![]
        };
        let decision = classify(m, &files);
        if !excluded(decision) {
            out.push(EpTarget {
                media: m.clone(),
                season: (sid, snum),
                episode: e,
                files,
                decision,
            });
        }
    }
    Ok(out)
}

pub(super) async fn count_by_season(
    db: &PgPool,
    ids: &[i32],
    unaired_after: Option<NaiveDate>,
) -> sqlx::Result<HashMap<i32, i64>> {
    let rows: Vec<(i32, i64)> = sqlx::query_as(
        r#"SELECT "seasonId", count(*) FROM episodes WHERE "seasonId" = ANY($1)
             AND ($2::date IS NULL OR "airDate" IS NULL OR "airDate" > $2) GROUP BY "seasonId""#,
    )
    .bind(ids)
    .bind(unaired_after)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Media scanned per step of a page: bounds what one `candidates` call loads.
pub(super) const BATCH: usize = 100;

pub(super) type Key = (u32, u32, u32);

pub(super) fn key(tg: &t::AcquisitionTarget) -> Key {
    (
        tg.media_id,
        tg.season.as_ref().map_or(0, |s| s.id),
        tg.episode.as_ref().map_or(0, |e| e.id),
    )
}

pub(super) fn parse_cursor(c: &str) -> Option<Key> {
    let mut p = c.trim().split('.').map(|n| n.parse::<u32>().ok());
    Some((p.next()??, p.next()??, p.next()??))
}

/// The ids of the next monitored media from `from`, in order.
pub(super) async fn media_batch(
    db: &PgPool,
    from: i32,
    ids: Option<&[i32]>,
    kind: Option<t::MediaKind>,
) -> sqlx::Result<Vec<i32>> {
    let kind = kind.map(|k| MediaKind::from(k).as_str());
    sqlx::query_scalar(
        r#"SELECT id FROM media WHERE monitored AND id >= $1 AND ($2::int[] IS NULL OR id = ANY($2))
             AND ($3::text IS NULL OR type = $3) ORDER BY id LIMIT $4"#,
    )
    .bind(from)
    .bind(ids)
    .bind(kind)
    .bind(BATCH as i64)
    .fetch_all(db)
    .await
}

/// The movies, season packs and episodes wanted among `ids`.
pub(super) async fn targets_for(
    db: &PgPool,
    ids: &[i32],
    kind: Option<t::MediaKind>,
    on: NaiveDate,
) -> sqlx::Result<Vec<t::AcquisitionTarget>> {
    let ids = Some(ids);
    let today = Utc::now().date_naive();
    let mut targets = vec![];
    if !matches!(kind, Some(t::MediaKind::Series)) {
        for (m, files, d) in movie_targets(db, ids).await? {
            if available(&m, on) {
                targets.extend(target(&m, Some(d), &files));
            }
        }
    }
    if !matches!(kind, Some(t::MediaKind::Movie)) {
        let eps: Vec<EpTarget> = episode_targets(db, ids, today)
            .await?
            .into_iter()
            .filter(|e| e.episode.air_date.is_none_or(|d| d <= on))
            .collect();
        let mut by_season: BTreeMap<i32, Vec<&EpTarget>> = BTreeMap::new();
        for e in &eps {
            by_season.entry(e.season.0).or_default().push(e);
        }
        let season_ids: Vec<i32> = by_season.keys().copied().collect();
        let totals = count_by_season(db, &season_ids, None).await?;
        let unaired = count_by_season(db, &season_ids, Some(today)).await?;
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
            if let Some(mut tg) = target(&e.media, Some(e.decision), &e.files) {
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
    targets.sort_by_key(key);
    Ok(targets)
}

/// `acquisition.candidates`: movies, season packs and episodes, sorted, paged by keyset: the cursor
/// names the last item returned. `on` is the validated `availableOn`.
pub async fn candidates(
    db: &PgPool,
    q: t::CandidatesQuery,
    on: NaiveDate,
) -> sqlx::Result<t::CandidatesPage> {
    let limit = q.limit.clamp(1, MAX_LIMIT) as usize;
    let ids: Option<Vec<i32>> = q
        .media_ids
        .as_ref()
        .map(|v| v.iter().map(|i| *i as i32).collect::<Vec<_>>())
        .filter(|v| !v.is_empty());
    let after = q.cursor.as_deref().and_then(parse_cursor);
    let mut from = after.map_or(0, |k| k.0 as i32);
    let mut items: Vec<t::AcquisitionTarget> = vec![];
    while items.len() <= limit {
        let batch = media_batch(db, from, ids.as_deref(), q.kind).await?;
        let Some(last) = batch.last() else { break };
        from = last + 1;
        let full = batch.len() == BATCH;
        let found = targets_for(db, &batch, q.kind, on).await?;
        items.extend(
            found
                .into_iter()
                .filter(|tg| after.is_none_or(|a| key(tg) > a)),
        );
        if !full {
            break;
        }
    }
    let more = items.len() > limit;
    items.truncate(limit);
    let cursor = items
        .last()
        .filter(|_| more)
        .map(key)
        .map(|(m, s, e)| format!("{m}.{s}.{e}"));
    Ok(t::CandidatesPage { cursor, items })
}

//! The audio and text families of rule 31: the wants of a book as targets, matches and scores.
use super::release::{Inputs, custom_formats, wit_languages, wit_rejections};
use super::*;
use fliks_domain::profiles::{default_allowed, default_sizes};
use fliks_domain::release::audio::quality::parse_audio_release;
use fliks_domain::release::scoring::{
    BookScoreOptions, ExpectedIssue, score_and_sort_book_releases,
};
use fliks_domain::release::text::quality::parse_text_release;

/// A want of a book with its profile and whether it is satisfied.
#[derive(FromRow)]
struct WantRow {
    media_id: i32,
    family: String,
    language: Option<String>,
    qp_id: Option<i32>,
    qp_items: Option<Value>,
    qp_min_cf: Option<i32>,
    satisfied: bool,
    released: Option<NaiveDate>,
}

impl WantRow {
    fn family(&self) -> Family {
        Family::parse(&self.family).unwrap_or(Family::Text)
    }
    /// The profile's qualities, else every known one of the family.
    fn allowed(&self) -> BTreeSet<u32> {
        match &self.qp_items {
            Some(v) => serde_json::from_value::<Vec<QualityProfileItem>>(v.clone())
                .map(|i| build_allowed_quality_ids(&i))
                .unwrap_or_default(),
            None => default_allowed(self.family()).into_iter().collect(),
        }
    }
    fn languages(&self) -> BTreeSet<u32> {
        let items: Vec<_> = self
            .language
            .iter()
            .map(|l| AudioLanguageItem {
                iso_code: l.clone(),
            })
            .collect();
        allowed_audio_language_ids(&items)
    }
}

/// The wants of the books in the order of rule 31: text before audio, no language first.
fn want_sql(filter: &str) -> String {
    format!(
        r#"SELECT w."mediaId" AS media_id, w.family, w.language, qp.id AS qp_id, qp.items AS qp_items,
    qp."minCustomFormatScore" AS qp_min_cf, {sat} AS satisfied, rel.date AS released
  FROM wants w JOIN media m ON m.id = w."mediaId"
  LEFT JOIN quality_profiles qp ON qp.id = w."qualityProfileId"
  LEFT JOIN LATERAL (SELECT d.date FROM media_release_dates d WHERE d."mediaId" = m.id AND d."editionId" IS NULL
      ORDER BY (d.kind = 'release') DESC, d.date LIMIT 1) rel ON true
  WHERE m.type IN ('book', 'comic') AND w."mediaId" = ANY($1) AND w.family = ANY($2) {filter}
  ORDER BY w."mediaId", CASE w.family WHEN 'text' THEN 0 ELSE 1 END, w.language NULLS FIRST, w.id"#,
        sat = crate::media::wants::satisfied_sql()
    )
}

fn names(families: &[Family]) -> Vec<&'static str> {
    families.iter().map(|f| f.as_str()).collect()
}

async fn wants(db: &PgPool, media: i32, families: &[Family]) -> sqlx::Result<Vec<WantRow>> {
    sqlx::query_as(sqlx::AssertSqlSafe(want_sql("")))
        .bind([media])
        .bind(names(families))
        .fetch_all(db)
        .await
}

/// The want of `language` among `wanted` (the first one without a language).
fn pick(wanted: Vec<WantRow>, language: Option<&str>) -> Option<WantRow> {
    wanted
        .into_iter()
        .find(|w| language.is_none_or(|l| w.language.as_deref() == Some(l)))
}

/// The family of the first want of a book (of `language` when given), text when it has none.
pub async fn first_family(db: &PgPool, media: i32, language: Option<&str>) -> sqlx::Result<Family> {
    let wanted = wants(db, media, MediaKind::Book.families()).await?;
    Ok(pick(wanted, language).map_or(Family::Text, |w| w.family()))
}

/// What a target adds to its media row, read once for a batch of media.
#[derive(Default)]
struct Extras {
    creators: HashMap<i32, Vec<t::Creator>>,
    /// Per media: the edition (family, language) and its external ids.
    editions: HashMap<i32, Vec<(String, Option<String>, t::ExternalId)>>,
    /// The longest audio edition of a media, in minutes.
    minutes: HashMap<i32, u32>,
}

async fn extras(db: &PgPool, media: &[i32]) -> sqlx::Result<Extras> {
    let mut out = Extras::default();
    let rows: Vec<(i32, String, String)> = sqlx::query_as(
        r#"SELECT "mediaId", name, role FROM (
             SELECT DISTINCT ON (c."mediaId", c.role, p.id) c."mediaId", p.name, c.role, c.position
               FROM media_credits c JOIN persons p ON p.id = c."personId"
              WHERE c."mediaId" = ANY($1) AND c.role IN ('author', 'narrator')
              ORDER BY c."mediaId", c.role, p.id, c.position) x
           ORDER BY "mediaId", role, position, name"#,
    )
    .bind(media)
    .fetch_all(db)
    .await?;
    for (id, name, role) in rows {
        out.creators
            .entry(id)
            .or_default()
            .push(t::Creator { name, role });
    }
    let rows: Vec<(i32, String, Option<String>, String, String)> = sqlx::query_as(
        r#"SELECT e."mediaId", e.family, e.language, x.provider, x.value
             FROM edition_external_ids x JOIN editions e ON e.id = x."editionId"
            WHERE e."mediaId" = ANY($1) ORDER BY x."editionId", x.provider, x.value"#,
    )
    .bind(media)
    .fetch_all(db)
    .await?;
    for (id, family, language, provider, value) in rows {
        out.editions.entry(id).or_default().push((
            family,
            language,
            t::ExternalId { provider, value },
        ));
    }
    let rows: Vec<(i32, Option<i32>)> = sqlx::query_as(
        r#"SELECT "mediaId", max("durationSeconds") FROM editions
            WHERE "mediaId" = ANY($1) AND family = 'audio' GROUP BY "mediaId""#,
    )
    .bind(media)
    .fetch_all(db)
    .await?;
    for (id, secs) in rows {
        if let Some(s) = secs.filter(|s| *s > 0) {
            out.minutes.insert(id, (s / 60) as u32);
        }
    }
    Ok(out)
}

fn target(m: &MediaRow, w: &WantRow, x: &Extras) -> Option<t::Target> {
    let library_id = m.library_id?;
    let family = w.family();
    let titles = resolve_search_titles(&m.search(), None);
    Some(t::Target {
        media_id: m.id as u32,
        kind: m.kind.as_str().to_owned(),
        family: family.into(),
        language: w.language.clone(),
        title: m.title.clone(),
        original_title: m.original_title.clone(),
        alternative_titles: m.alt(),
        creators: x.creators.get(&m.id).cloned().unwrap_or_default(),
        year: m.year.map(|y| y as u32),
        runtime_minutes: (family == Family::Audio)
            .then(|| x.minutes.get(&m.id).copied())
            .flatten(),
        external_ids: m.external_ids(),
        edition_ids: x
            .editions
            .get(&m.id)
            .into_iter()
            .flatten()
            .filter(|(f, l, _)| {
                *f == family.as_str() && (w.language.is_none() || l.is_none() || *l == w.language)
            })
            .map(|(_, _, id)| id.clone())
            .collect(),
        library_id: library_id as u32,
        want: Some(t::Want {
            decision: if w.satisfied {
                t::WantDecision::Skip
            } else {
                t::WantDecision::Missing
            },
            family: family.into(),
            language: w.language.clone(),
            allowed_quality_ids: w.allowed().into_iter().collect(),
            allowed_language_ids: w.languages().into_iter().collect(),
            min_resolution: 0,
            resolution_upgrade_only: false,
        }),
        expected_titles: titles.expected_titles,
        search_title: titles.search_title,
        scope: vec![],
        search_units: vec![],
    })
}

/// `media.acquisitionContext` of a book: its want of `family` and `language` (any), null for a group or a foreign item.
pub(super) async fn context(
    db: &PgPool,
    m: &MediaRow,
    family: Option<Family>,
    language: Option<&str>,
    group_id: Option<u32>,
    item_id: Option<u32>,
) -> sqlx::Result<Option<t::Target>> {
    if group_id.is_some() {
        return Ok(None);
    }
    let mut family = family;
    if let Some(item) = item_id {
        let of_item: Option<String> = sqlx::query_scalar(
            r#"SELECT e.family FROM items i JOIN editions e ON e.id = i."editionId"
                WHERE i.id = $1 AND i."mediaId" = $2 AND i."groupId" IS NULL"#,
        )
        .bind(item as i32)
        .bind(m.id)
        .fetch_optional(db)
        .await?;
        let Some(of_item) = of_item.as_deref().and_then(Family::parse) else {
            return Ok(None);
        };
        if family.is_some_and(|f| f != of_item) {
            return Ok(None);
        }
        family = Some(of_item);
    }
    let families = family.map_or_else(|| MediaKind::Book.families().to_vec(), |f| vec![f]);
    match pick(wants(db, m.id, &families).await?, language) {
        Some(w) => Ok(target(m, &w, &extras(db, &[m.id]).await?)),
        None => Ok(None),
    }
}

/// The monitored books among `ids` whose release date has come, one target per unsatisfied want,
/// which `context`, `score` and the ingest serve by (family, language).
pub(super) async fn targets(
    db: &PgPool,
    ids: &[i32],
    family: Option<Family>,
    on: NaiveDate,
) -> sqlx::Result<Vec<t::Target>> {
    let families = family.map_or_else(|| MediaKind::Book.families().to_vec(), |f| vec![f]);
    let rows: Vec<WantRow> = sqlx::query_as(sqlx::AssertSqlSafe(want_sql(
        "AND m.type = 'book' AND m.monitored AND (rel.date IS NULL OR rel.date <= $3)",
    )))
    .bind(ids)
    .bind(names(&families))
    .bind(on)
    .fetch_all(db)
    .await?;
    // A language-less want is the fallback of a family with no language want.
    let first: Vec<&WantRow> = rows
        .iter()
        .filter(|w| {
            !w.satisfied
                && !(w.language.is_none()
                    && rows.iter().any(|o| {
                        o.media_id == w.media_id && o.family == w.family && o.language.is_some()
                    }))
        })
        .collect();
    let wanted: Vec<i32> = first.iter().map(|w| w.media_id).collect();
    let books: HashMap<i32, MediaRow> = sqlx::query_as::<_, MediaRow>(sqlx::AssertSqlSafe(
        format!("{} WHERE m.id = ANY($1)", media_select()),
    ))
    .bind(&wanted)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|m| (m.id, m))
    .collect();
    let x = extras(db, &wanted).await?;
    Ok(first
        .into_iter()
        .filter_map(|w| target(books.get(&w.media_id)?, w, &x))
        .collect())
}

/// The families a release name carries: its audio or text format, both when it names none.
fn release_families(title: &str) -> Vec<Family> {
    let audio = parse_audio_release(title).format.is_some();
    let text = parse_text_release(title).format.is_some();
    match (audio, text) {
        (true, false) => vec![Family::Audio],
        (false, true) => vec![Family::Text],
        _ => vec![Family::Text, Family::Audio],
    }
}

/// `releases.match` of a title that names the book `m`.
pub(super) async fn match_one(
    db: &PgPool,
    m: &MediaRow,
    min_age: Option<u32>,
    entry: t::ReleaseTitle,
) -> sqlx::Result<t::ReleaseMatch> {
    let verdict = |decision, skip_reason| t::ReleaseMatch {
        id: entry.id.clone(),
        media_id: Some(m.id as u32),
        unit: None,
        whole_group: false,
        coverage: None,
        decision,
        skip_reason,
    };
    let skip = |reason| verdict(t::MatchDecision::Skip, Some(reason));
    let wants = wants(db, m.id, &release_families(&entry.title)).await?;
    if wants.is_empty() {
        return Ok(skip(t::SkipReason::NotAvailable));
    }
    if wants.iter().all(|w| w.satisfied) {
        return Ok(skip(t::SkipReason::OnDisk));
    }
    if wants
        .iter()
        .all(|w| w.released.is_some_and(|d| d > Utc::now().date_naive()))
    {
        return Ok(skip(t::SkipReason::TooFresh));
    }
    if let Some(min) = min_age.filter(|m| *m > 0)
        && let Some(at) = published(&entry.publish_date)
        && (Utc::now() - at).num_milliseconds() as f64 / 60_000.0 < f64::from(min)
    {
        return Ok(skip(t::SkipReason::TooFresh));
    }
    Ok(verdict(t::MatchDecision::Grab, None))
}

/// The size limits per quality of the family: the stored definitions over the defaults.
async fn sizes(db: &PgPool, family: Family) -> sqlx::Result<BTreeMap<u32, SizeLimits>> {
    let mut out: BTreeMap<u32, SizeLimits> = fliks_domain::profiles::table(family)
        .iter()
        .map(|q| {
            let s = default_sizes(family, q.id.into());
            (
                q.id,
                SizeLimits {
                    min: s.min,
                    preferred: s.preferred,
                    max: s.max,
                },
            )
        })
        .collect();
    let rows: Vec<(i32, f64, f64, f64)> = sqlx::query_as(
        r#"SELECT "qualityId", "minSize", "preferredSize", "maxSize" FROM quality_definitions WHERE family = $1"#,
    )
    .bind(family.as_str())
    .fetch_all(db)
    .await?;
    for (id, min, preferred, max) in rows {
        out.insert(
            id as u32,
            SizeLimits {
                min,
                preferred,
                max,
            },
        );
    }
    Ok(out)
}

/// `releases.score` of `audio`, `text` or `image` by the want of `language` (the first when none), `[]` for an
/// unknown media; `issue` is the comic issue a search wants.
pub async fn score(
    st: &AppState,
    media_id: u32,
    family: Family,
    language: Option<&str>,
    issue: Option<ExpectedIssue>,
    releases: Vec<t::CandidateRelease>,
) -> sqlx::Result<Vec<t::ScoredRelease>> {
    let db = &st.db;
    let Some(m) = media(db, media_id as i32).await? else {
        return Ok(vec![]);
    };
    let want = pick(wants(db, m.id, &[family]).await?, language);
    if language.is_some() && want.is_none() {
        return Ok(vec![]);
    }
    let formats = custom_formats(db).await?;
    let inp = Inputs::of(releases);
    let opts = BookScoreOptions {
        allowed: want.as_ref().map_or_else(
            || default_allowed(family).into_iter().collect(),
            WantRow::allowed,
        ),
        allowed_langs: want.as_ref().map(WantRow::languages).unwrap_or_default(),
        size_by_quality: sizes(db, family).await?,
        source_min_seeders: inp.min_seeders,
        source_unknown_lang: inp.unknown_lang,
        duration_minutes: f64::from(
            extras(db, &[m.id])
                .await?
                .minutes
                .get(&m.id)
                .copied()
                .unwrap_or(0),
        ),
        expected_title: Some(ExpectedTitle::Many(
            resolve_search_titles(&m.search(), None).expected_titles,
        )),
        expected_year: None,
        min_custom_format_score: want
            .as_ref()
            .and_then(|w| w.qp_id.map(|_| i64::from(w.qp_min_cf.unwrap_or(0)))),
        min_rank_exclusive: None,
        max_rank_inclusive: None,
        expected_issue: issue,
    };
    let (blocked, ids, candidates) = (inp.blocked, inp.ids, inp.candidates);
    let scored = tokio::task::spawn_blocking(move || {
        let compiled = fliks_domain::release::scoring::CompiledFormats::new(&formats);
        let formats = |title: &str, flags: &[String]| compiled.score(title, flags);
        let blocked = |_: &str, source_id: i64| blocked.get(&source_id).copied().unwrap_or(false);
        score_and_sort_book_releases(family, candidates, &opts, &formats, &blocked)
    })
    .await
    .unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()));
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
            languages: wit_languages(&s.languages),
            language_allowed: s.language_allowed,
            whole_group: false,
            coverage: None,
            size_deviation: s.size_deviation,
            video_codec: None,
            rejections: wit_rejections(s.rejections),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::acquisition::context;

    fn state(db: &PgPool) -> AppState {
        AppState::new(
            db.clone(),
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        )
    }

    /// Two monitored books (1 and 2) of a book library, each with its default text and audio wants.
    async fn books(db: &PgPool) {
        crate::db::migrate(db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'B', '["book"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b');
               INSERT INTO media (id, title, year, type, "libraryId", monitored)
                 VALUES (1, 'Mirelune', 2019, 'book', 1, true), (2, 'Orfaline', 2020, 'book', 1, true)"#,
        )
        .execute(db)
        .await
        .unwrap();
        for id in [1, 2] {
            let mut c = db.acquire().await.unwrap();
            crate::media::items::create_shell(&mut c, id, MediaKind::Book, Default::default())
                .await
                .unwrap();
        }
    }

    fn release(id: &str, title: &str, size: u64) -> t::CandidateRelease {
        t::CandidateRelease {
            id: id.into(),
            title: title.into(),
            size,
            seeders: 5,
            leechers: 0,
            publish_date: "2026-01-01T00:00:00Z".into(),
            flags: None,
            freeleech: None,
            download_volume_factor: None,
            source_ref: "ix".into(),
            min_seeders: None,
            unknown_language_iso_code: None,
            blocked: false,
        }
    }

    #[sqlx::test(migrations = false)]
    async fn a_book_target_names_its_want_family_and_editions(db: PgPool) {
        books(&db).await;
        sqlx::raw_sql(
            r#"INSERT INTO editions ("mediaId", family, "durationSeconds") VALUES (1, 'audio', 7200);
               INSERT INTO edition_external_ids ("editionId", "mediaId", provider, value)
                 SELECT id, 1, 'asin', 'B000000001' FROM editions WHERE family = 'audio'"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let st = state(&db);
        let ctx = |family| context(&st, 1, family, None, None, None);
        let first = ctx(None).await.unwrap().unwrap();
        assert_eq!(
            (first.kind.as_str(), first.family),
            ("book", t::Family::Text)
        );
        assert!(first.scope.is_empty() && first.edition_ids.is_empty());
        let want = first.want.unwrap();
        assert_eq!(
            (want.decision, want.allowed_quality_ids),
            (t::WantDecision::Missing, vec![202, 203, 204, 205, 206, 207])
        );
        let audio = ctx(Some(Family::Audio)).await.unwrap().unwrap();
        assert_eq!(audio.family, t::Family::Audio);
        assert_eq!(audio.runtime_minutes, Some(120));
        let ids: Vec<_> = audio
            .edition_ids
            .iter()
            .map(|e| (&*e.provider, &*e.value))
            .collect();
        assert_eq!(ids, [("asin", "B000000001")]);
        let item: i32 = sqlx::query_scalar(r#"INSERT INTO items ("mediaId", "editionId", monitored) SELECT 1, id, true FROM editions RETURNING id"#)
            .fetch_one(&db)
            .await
            .unwrap();
        let by_item = context(&st, 1, None, None, None, Some(item as u32))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(by_item.family, t::Family::Audio);
        let mismatch = context(&st, 1, Some(Family::Text), None, None, Some(item as u32)).await;
        assert!(mismatch.unwrap().is_none());
        assert!(
            context(&st, 1, None, None, Some(1), None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            context(&st, 1, None, None, None, Some(9999))
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            context(&st, 99, None, None, None, None)
                .await
                .unwrap()
                .is_none()
        );
        let err = context(&st, 1, Some(Family::Video), None, None, None).await;
        assert_eq!(err.unwrap_err().code, "ERR_VALIDATION");
        assert_eq!(first_family(&db, 1, None).await.unwrap(), Family::Text);
    }

    #[sqlx::test(migrations = false)]
    async fn candidates_hold_a_target_per_unsatisfied_want_and_keep_them_in_one_page(db: PgPool) {
        books(&db).await;
        let on = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
        let query = |kind: Option<&str>, family, limit, cursor| t::CandidatesQuery {
            kind: kind.map(str::to_owned),
            family,
            media_ids: None,
            available_on: "2030-01-01".into(),
            limit,
            cursor,
        };
        let all = candidates(&db, query(None, None, 50, None), on)
            .await
            .unwrap();
        let got: Vec<_> = all.items.iter().map(|i| (i.media_id, i.family)).collect();
        let (text, audio) = (t::Family::Text, t::Family::Audio);
        assert_eq!(got, [(1, text), (1, audio), (2, text), (2, audio)]);
        let page = candidates(&db, query(Some("book"), None, 1, None), on)
            .await
            .unwrap();
        assert_eq!(page.items.len(), 2, "the wants of one media stay together");
        assert_eq!(page.cursor.as_deref(), Some("1.0.0"));
        let next = candidates(&db, query(Some("book"), None, 1, page.cursor), on)
            .await
            .unwrap();
        assert_eq!(
            next.items.iter().map(|i| i.media_id).collect::<Vec<_>>(),
            [2, 2]
        );
        assert!(next.cursor.is_none());
        let only = candidates(&db, query(None, Some(audio), 50, None), on)
            .await
            .unwrap();
        assert_eq!(only.items.len(), 2);
        for (kind, family) in [(Some("movie"), None), (None, Some(t::Family::Video))] {
            let none = candidates(&db, query(kind, family, 50, None), on)
                .await
                .unwrap();
            assert!(none.items.is_empty(), "{kind:?} {family:?}");
        }
        sqlx::query("UPDATE media SET monitored = false WHERE id = 1")
            .execute(&db)
            .await
            .unwrap();
        sqlx::query(r#"INSERT INTO media_release_dates ("mediaId", kind, date) VALUES (2, 'release', '2031-01-01')"#)
            .execute(&db)
            .await
            .unwrap();
        let gated = candidates(&db, query(None, None, 50, None), on)
            .await
            .unwrap();
        assert!(
            gated.items.is_empty(),
            "unmonitored and unreleased books are no candidate"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn releases_score_by_family_with_the_wanted_language(db: PgPool) {
        books(&db).await;
        sqlx::query("UPDATE wants SET language = 'fr' WHERE \"mediaId\" = 1 AND family = 'text'")
            .execute(&db)
            .await
            .unwrap();
        let st = state(&db);
        let names = [
            ("epub", "Mirelune.FR.EPUB-GRP"),
            ("pdf", "Mirelune.FR.PDF"),
            ("en", "Mirelune.EPUB"),
            ("mp3", "Mirelune.FR.MP3.128kbps"),
        ];
        let releases = names.map(|(id, t)| release(id, t, 2_000_000)).to_vec();
        let scored = score(&st, 1, Family::Text, None, None, releases.clone())
            .await
            .unwrap();
        let by = |id: &str| scored.iter().find(|s| s.id == id).unwrap();
        assert_eq!((by("epub").quality_id, by("epub").allowed), (205, true));
        assert!(by("epub").language_allowed && !by("epub").whole_group);
        assert!(by("pdf").allowed && !by("en").language_allowed);
        assert!(!by("mp3").allowed, "an audio release has no text quality");
        let audio = score(&st, 1, Family::Audio, None, None, releases)
            .await
            .unwrap();
        let mp3 = audio.iter().find(|s| s.id == "mp3").unwrap();
        assert_eq!((mp3.quality_id, mp3.allowed), (103, true));
        assert!(
            score(
                &st,
                99,
                Family::Text,
                None,
                None,
                vec![release("x", "x", 1)]
            )
            .await
            .unwrap()
            .is_empty()
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_title_naming_a_book_matches_by_the_family_of_its_format(db: PgPool) {
        books(&db).await;
        let st = state(&db);
        let ask = |id: &str, title: &str| t::ReleaseTitle {
            id: id.into(),
            title: title.into(),
            publish_date: "2020-01-01T00:00:00Z".into(),
        };
        let titles = vec![
            ask("a", "Mirelune.EPUB-GRP"),
            ask("b", "Nothing.Known.EPUB"),
        ];
        let m = matches(&st, titles, None).await.unwrap();
        assert_eq!(
            (m[0].media_id, m[0].decision),
            (Some(1), t::MatchDecision::Grab)
        );
        assert!(m[0].unit.is_none() && !m[0].whole_group);
        assert_eq!(m[1].skip_reason, Some(t::SkipReason::Unmatched));
        sqlx::query(r#"DELETE FROM wants WHERE "mediaId" = 1 AND family = 'text'"#)
            .execute(&db)
            .await
            .unwrap();
        let m = matches(
            &st,
            vec![ask("a", "Mirelune.EPUB-GRP"), ask("b", "Mirelune.m4b")],
            None,
        )
        .await
        .unwrap();
        assert_eq!(m[0].skip_reason, Some(t::SkipReason::NotAvailable));
        assert_eq!(m[1].decision, t::MatchDecision::Grab);
        let fresh = ask("c", "Mirelune.m4b");
        let fresh = t::ReleaseTitle {
            publish_date: chrono::Utc::now().to_rfc3339(),
            ..fresh
        };
        let m = matches(&st, vec![fresh], Some(60)).await.unwrap();
        assert_eq!(m[0].skip_reason, Some(t::SkipReason::TooFresh));
    }

    #[sqlx::test(migrations = false)]
    async fn an_unsatisfied_second_language_is_a_target_that_context_and_score_select(db: PgPool) {
        books(&db).await;
        sqlx::raw_sql(
            r#"INSERT INTO wants ("mediaId", family, language) VALUES (1, 'text', 'fr');
               WITH e AS (INSERT INTO editions ("mediaId", family, language) VALUES (1, 'text', 'en') RETURNING id),
                    i AS (INSERT INTO items ("mediaId", "editionId", monitored) SELECT 1, id, true FROM e RETURNING id),
                    f AS (INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId")
                          VALUES ('a.epub', 1, 'epub', 1, (SELECT min(id) FROM library_folders)) RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
                 SELECT i.id, f.id, 1, 0, 0 FROM i, f"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let on = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
        let got = targets(&db, &[1], Some(Family::Text), on).await.unwrap();
        let wanted = |g: &[t::Target]| -> Vec<(t::Family, Option<String>)> {
            g.iter().map(|g| (g.family, g.language.clone())).collect()
        };
        assert_eq!(
            wanted(&got),
            [(t::Family::Text, Some("fr".to_owned()))],
            "text/NULL is satisfied by the English edition, text/fr is not"
        );
        let got = targets(&db, &[1], None, on).await.unwrap();
        assert_eq!(
            wanted(&got),
            [
                (t::Family::Text, Some("fr".to_owned())),
                (t::Family::Audio, None)
            ]
        );
        let st = state(&db);
        let ctx = |language: Option<&str>| {
            context(
                &st,
                1,
                Some(Family::Text),
                language.map(str::to_owned),
                None,
                None,
            )
        };
        let fr = ctx(Some("fr")).await.unwrap().unwrap();
        assert_eq!(fr.language.as_deref(), Some("fr"));
        assert_eq!(fr.want.unwrap().decision, t::WantDecision::Missing);
        let first = ctx(None).await.unwrap().unwrap();
        assert_eq!(first.language, None);
        assert_eq!(first.want.unwrap().decision, t::WantDecision::Skip);
        assert!(ctx(Some("de")).await.unwrap().is_none());
        assert_eq!(ctx(Some("zz zz")).await.unwrap_err().code, "ERR_VALIDATION");
        let plain = vec![release("x", "Mirelune.EPUB", 2_000_000)];
        let fr = score(&st, 1, Family::Text, Some("fr"), None, plain.clone())
            .await
            .unwrap();
        assert!(!fr[0].language_allowed, "scored against the want of fr");
        let any = score(&st, 1, Family::Text, None, None, plain)
            .await
            .unwrap();
        assert!(any[0].language_allowed, "scored against the first want");
    }

    #[sqlx::test(migrations = false)]
    async fn an_unreleased_book_is_too_fresh(db: PgPool) {
        books(&db).await;
        sqlx::query(r#"INSERT INTO media_release_dates ("mediaId", kind, date) VALUES (1, 'release', '2999-01-01')"#)
            .execute(&db)
            .await
            .unwrap();
        let ask = t::ReleaseTitle {
            id: "a".into(),
            title: "Mirelune.EPUB-GRP".into(),
            publish_date: "2020-01-01T00:00:00Z".into(),
        };
        let m = matches(&state(&db), vec![ask], None).await.unwrap();
        assert_eq!(m[0].skip_reason, Some(t::SkipReason::TooFresh));
    }
}

//! The comics of rule 31: the wanted issues of a volume as targets and matches, one issue per target.
use super::release::published;
use super::*;
use fliks_domain::comics::name::number as canonical;
use fliks_domain::release::comic::parse_comic_release;
use fliks_domain::release::scoring::ExpectedIssue;

/// An issue item of a volume with what a target and a match read of it.
#[derive(FromRow)]
struct IssueRow {
    media_id: i32,
    item_id: i32,
    kind: String,
    sort: String,
    label: String,
    title: Option<String>,
    air_date: Option<NaiveDate>,
    has_file: bool,
    monitored: bool,
    wanted: bool,
    qp_items: Option<Value>,
}

const SELECT: &str = r#"SELECT i."mediaId" AS media_id, i.id AS item_id, ci.kind, ci."sortNumber"::text AS sort,
    ci.label, i.title, i."airDate" AS air_date, i.monitored,
    EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = i.id) AS has_file,
    w.id IS NOT NULL AS wanted, qp.items AS qp_items
  FROM items i JOIN comic_issues ci ON ci."itemId" = i.id
  JOIN media m ON m.id = i."mediaId"
  LEFT JOIN wants w ON w."mediaId" = m.id AND w.family = 'image'
  LEFT JOIN quality_profiles qp ON qp.id = w."qualityProfileId""#;

impl IssueRow {
    /// The profile's qualities, else every known one of the family.
    fn allowed(&self) -> Vec<u32> {
        match &self.qp_items {
            Some(v) => serde_json::from_value::<Vec<QualityProfileItem>>(v.clone())
                .map(|i| build_allowed_quality_ids(&i).into_iter().collect())
                .unwrap_or_default(),
            None => default_allowed(Family::Image),
        }
    }

    /// The printed number, led by the kind word for an annual or a special.
    fn unit_label(&self) -> String {
        match self.kind.as_str() {
            "issue" => self.label.clone(),
            k => format!("{k} {}", self.label),
        }
    }

    fn unit(&self) -> t::Unit {
        t::Unit {
            ref_: t::UnitRef {
                group: None,
                number: self.sort.parse().ok(),
                end_number: None,
                label: Some(self.unit_label()),
                absolute: None,
            },
            group_id: None,
            item_id: Some(self.item_id as u32),
            title: self.title.clone(),
            air_date: self.air_date.map(|d| d.to_string()),
            unit_count: None,
        }
    }
}

/// The issue a comic unit names: a `number`, led in its `label` by `annual` or `special`; no group.
pub(super) fn expected(u: &t::UnitRef) -> Result<ExpectedIssue, HostError> {
    let bad = |m: &str| host_err("ERR_VALIDATION", format!("a comic unit {m}"));
    if u.group.is_some() || u.end_number.is_some() || u.absolute.is_some() {
        return Err(bad("is one issue: no group, end-number or absolute"));
    }
    let number = u
        .number
        .and_then(|n| canonical(&n.to_string()))
        .ok_or_else(|| bad("needs a number of the issue grammar"))?;
    let kind = u
        .label
        .as_deref()
        .and_then(|l| l.split_once(' '))
        .map(|(k, _)| k)
        .filter(|k| matches!(*k, "annual" | "special"))
        .unwrap_or("issue");
    Ok(ExpectedIssue {
        kind: kind.to_owned(),
        number,
    })
}

fn target(m: &MediaRow, issue: Option<&IssueRow>) -> Option<t::Target> {
    let library_id = m.library_id?;
    let titles = resolve_search_titles(&m.search(), None);
    Some(t::Target {
        media_id: m.id as u32,
        kind: m.kind.as_str().to_owned(),
        family: t::Family::Image,
        language: None,
        title: m.title.clone(),
        original_title: m.original_title.clone(),
        alternative_titles: m.alt(),
        creators: vec![],
        year: m.year.map(|y| y as u32),
        runtime_minutes: None,
        external_ids: m.external_ids(),
        edition_ids: vec![],
        library_id: library_id as u32,
        want: issue.map(|i| t::Want {
            decision: if i.has_file {
                t::WantDecision::Skip
            } else {
                t::WantDecision::Missing
            },
            family: t::Family::Image,
            language: None,
            allowed_quality_ids: i.allowed(),
            allowed_language_ids: vec![],
            min_resolution: 0,
            resolution_upgrade_only: false,
        }),
        expected_titles: titles.expected_titles,
        search_title: titles.search_title,
        scope: issue.map(|i| vec![i.unit()]).unwrap_or_default(),
    })
}

/// `media.acquisitionContext` of a comic: the volume, or with `item_id` one of its issues; a group is none.
pub(super) async fn context(
    db: &PgPool,
    m: &MediaRow,
    group_id: Option<u32>,
    item_id: Option<u32>,
) -> sqlx::Result<Option<t::Target>> {
    if group_id.is_some() {
        return Ok(None);
    }
    let Some(item) = item_id else {
        return Ok(target(m, None));
    };
    let issue: Option<IssueRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{SELECT} WHERE i.id = $1 AND i."mediaId" = $2"#
    )))
    .bind(item as i32)
    .bind(m.id)
    .fetch_optional(db)
    .await?;
    Ok(issue.and_then(|i| target(m, Some(&i))))
}

/// The monitored issues without a file, released by `on`, of the monitored volumes among `ids`: one target each.
pub(super) async fn targets(
    db: &PgPool,
    ids: &[i32],
    on: NaiveDate,
) -> sqlx::Result<Vec<t::Target>> {
    let issues: Vec<IssueRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{SELECT} WHERE m.type = 'comic' AND m.monitored AND i.monitored AND w.id IS NOT NULL
             AND i."mediaId" = ANY($1) AND (i."airDate" IS NULL OR i."airDate" <= $2)
             AND NOT EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = i.id)
           ORDER BY i."mediaId", i.id"#
    )))
    .bind(ids)
    .bind(on)
    .fetch_all(db)
    .await?;
    let mut wanted: Vec<i32> = issues.iter().map(|i| i.media_id).collect();
    wanted.dedup();
    let volumes: HashMap<i32, MediaRow> = sqlx::query_as::<_, MediaRow>(sqlx::AssertSqlSafe(
        format!("{} WHERE m.id = ANY($1)", media_select()),
    ))
    .bind(&wanted)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|m| (m.id, m))
    .collect();
    Ok(issues
        .iter()
        .filter_map(|i| target(volumes.get(&i.media_id)?, Some(i)))
        .collect())
}

/// `releases.match` of a title that names the volume `m`: a trade or a run is never one issue.
pub(super) async fn match_one(
    db: &PgPool,
    m: &MediaRow,
    min_age: Option<u32>,
    entry: t::ReleaseTitle,
) -> sqlx::Result<t::ReleaseMatch> {
    let verdict = |decision, skip_reason, unit| t::ReleaseMatch {
        id: entry.id.clone(),
        media_id: Some(m.id as u32),
        unit,
        whole_group: false,
        coverage: None,
        decision,
        skip_reason,
    };
    let skip = |reason| verdict(t::MatchDecision::Skip, Some(reason), None);
    let release = parse_comic_release(&entry.title);
    let Some(number) = release.number.filter(|_| !release.collected) else {
        return Ok(skip(t::SkipReason::NotAvailable));
    };
    let issue: Option<IssueRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{SELECT} WHERE i."mediaId" = $1 AND ci.kind = $2 AND ci."sortNumber" = $3::text::numeric
           ORDER BY i.id LIMIT 1"#
    )))
    .bind(m.id)
    .bind(release.kind)
    .bind(&number)
    .fetch_optional(db)
    .await?;
    let Some(issue) = issue.filter(|i| i.wanted) else {
        return Ok(skip(t::SkipReason::NotAvailable));
    };
    let unit = Some(issue.unit().ref_);
    let skip = |reason| verdict(t::MatchDecision::Skip, Some(reason), unit.clone());
    if issue.has_file {
        return Ok(skip(t::SkipReason::OnDisk));
    }
    if !issue.monitored {
        return Ok(skip(t::SkipReason::NotMonitored));
    }
    if issue.air_date.is_some_and(|d| d > Utc::now().date_naive()) {
        return Ok(skip(t::SkipReason::TooFresh));
    }
    if let Some(min) = min_age.filter(|m| *m > 0)
        && let Some(at) = published(&entry.publish_date)
        && (Utc::now() - at).num_milliseconds() as f64 / 60_000.0 < f64::from(min)
    {
        return Ok(skip(t::SkipReason::TooFresh));
    }
    Ok(verdict(t::MatchDecision::Grab, None, unit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::acquisition::{candidates, context, matches, score_any};

    fn state(db: &PgPool) -> AppState {
        AppState::new(
            db.clone(),
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        )
    }

    /// Volume 1 with issue 1 on disk, issue 2 aired, issue 3 unreleased and an undated annual 1.
    async fn volume(db: &PgPool) {
        crate::db::migrate(db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'C', '["comic"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/c');
               INSERT INTO media (id, title, year, type, "libraryId", monitored)
                 VALUES (1, 'Star Gardens', 2024, 'comic', 1, true)"#,
        )
        .execute(db)
        .await
        .unwrap();
        let mut c = db.acquire().await.unwrap();
        crate::media::items::create_shell(&mut c, 1, MediaKind::Comic, Default::default())
            .await
            .unwrap();
        drop(c);
        sqlx::raw_sql(
            r#"INSERT INTO editions ("mediaId", family) VALUES (1, 'image');
               INSERT INTO items ("mediaId", "editionId", monitored, "airDate")
                 SELECT 1, e.id, true, v.d::date FROM editions e,
                   (VALUES ('2020-01-01'), ('2020-02-01'), ('2999-01-01'), (NULL)) AS v(d) WHERE e.family = 'image';
               INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label)
                 SELECT i.id, 1, CASE WHEN i.id = (SELECT max(id) FROM items) THEN 'annual' ELSE 'issue' END,
                        CASE WHEN i.id = (SELECT max(id) FROM items) THEN 1 ELSE i.id - (SELECT min(id) FROM items) + 1 END,
                        CASE WHEN i.id = (SELECT max(id) FROM items) THEN '1' ELSE (i.id - (SELECT min(id) FROM items) + 1)::text END
                   FROM items i;
               WITH f AS (INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId")
                          VALUES ('a 1.cbz', 1, 'cbz', 1, (SELECT min(id) FROM library_folders)) RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
                 SELECT (SELECT min(id) FROM items), f.id, 1, 0, 0 FROM f"#,
        )
        .execute(db)
        .await
        .unwrap();
    }

    async fn item_of(db: &PgPool, kind: &str, sort: i32) -> u32 {
        sqlx::query_scalar::<_, i32>(
            r#"SELECT "itemId" FROM comic_issues WHERE kind = $1 AND "sortNumber" = $2"#,
        )
        .bind(kind)
        .bind(sort)
        .fetch_one(db)
        .await
        .unwrap() as u32
    }

    fn release(id: &str, title: &str) -> t::CandidateRelease {
        t::CandidateRelease {
            id: id.into(),
            title: title.into(),
            size: 40 * 1_048_576,
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
    async fn an_issue_without_a_file_is_a_target_and_unsatisfies_the_volume(db: PgPool) {
        volume(&db).await;
        let on = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
        let q = |kind: Option<&str>, family| t::CandidatesQuery {
            kind: kind.map(str::to_owned),
            family,
            media_ids: None,
            available_on: "2030-01-01".into(),
            limit: 50,
            cursor: None,
        };
        let page = candidates(&db, q(Some("comic"), None), on).await.unwrap();
        let got: Vec<_> = page
            .items
            .iter()
            .map(|g| {
                let u = &g.scope[0];
                (u.ref_.number, u.ref_.label.clone(), g.family, g.year)
            })
            .collect();
        let image = t::Family::Image;
        assert_eq!(
            got,
            [
                (Some(2.0), Some("2".into()), image, Some(2024)),
                (Some(1.0), Some("annual 1".into()), image, Some(2024))
            ],
            "issue 1 has a file, issue 3 is unreleased"
        );
        let want = page.items[0].want.as_ref().unwrap();
        assert_eq!(want.decision, t::WantDecision::Missing);
        assert_eq!(want.allowed_quality_ids, [302, 303, 304, 305]);
        for (kind, family) in [(Some("book"), None), (None, Some(t::Family::Video))] {
            let none = candidates(&db, q(kind, family), on).await.unwrap();
            assert!(none.items.is_empty(), "{kind:?} {family:?}");
        }
        let wants = crate::media::wants::list(&db, 1).await.unwrap();
        assert!(!wants[0].satisfied);
        sqlx::query(
            r#"INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId")
               SELECT 'f' || n, 1, 'cbz', 1, (SELECT min(id) FROM library_folders) FROM generate_series(1, 2) n"#,
        )
        .execute(&db)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
               SELECT i."itemId", f.id, 1, 0, 0 FROM comic_issues i JOIN media_files f ON f."relativePath" =
                 CASE WHEN i.kind = 'annual' THEN 'f1' ELSE 'f2' END
               WHERE (i.kind = 'annual' OR i."sortNumber" = 2)"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let wants = crate::media::wants::list(&db, 1).await.unwrap();
        assert!(wants[0].satisfied, "the unreleased issue is not wanted yet");
        let done = candidates(&db, q(None, None), on).await.unwrap();
        assert!(done.items.is_empty());
    }

    #[sqlx::test(migrations = false)]
    async fn the_context_names_the_issue_and_its_want(db: PgPool) {
        volume(&db).await;
        let st = state(&db);
        let ctx = |item: Option<u32>, group| context(&st, 1, None, None, group, item);
        let whole = ctx(None, None).await.unwrap().unwrap();
        assert!(whole.scope.is_empty() && whole.want.is_none());
        assert_eq!((whole.kind.as_str(), whole.year), ("comic", Some(2024)));
        let two = item_of(&db, "issue", 2).await;
        let t2 = ctx(Some(two), None).await.unwrap().unwrap();
        assert_eq!(t2.scope[0].item_id, Some(two));
        assert_eq!(t2.want.unwrap().decision, t::WantDecision::Missing);
        let one = item_of(&db, "issue", 1).await;
        let t1 = ctx(Some(one), None).await.unwrap().unwrap();
        assert_eq!(t1.want.unwrap().decision, t::WantDecision::Skip);
        assert!(ctx(None, Some(1)).await.unwrap().is_none());
        assert!(ctx(Some(9999), None).await.unwrap().is_none());
        let err = context(&st, 1, Some(Family::Video), None, None, None).await;
        assert_eq!(err.unwrap_err().code, "ERR_VALIDATION");
    }

    #[sqlx::test(migrations = false)]
    async fn releases_are_scored_against_the_issue_wanted(db: PgPool) {
        volume(&db).await;
        let st = state(&db);
        let unit = |number: f64, label: &str| t::UnitRef {
            group: None,
            number: Some(number),
            end_number: None,
            label: Some(label.into()),
            absolute: None,
        };
        let names = [
            ("ok", "Star Gardens 002 (2024) (Digital) (Nitro)"),
            ("other", "Star Gardens 003 (2024) (Digital) (Nitro)"),
            ("trade", "Star Gardens TPB Vol 1 (2024) (Digital) (Nitro)"),
            ("run", "Star Gardens 001-012 (2024) (Digital)"),
            ("annual", "Star Gardens Annual 002 (2024)"),
            ("pdf", "Star Gardens 002 (2024) PDF"),
        ];
        let releases: Vec<_> = names.map(|(i, n)| release(i, n)).to_vec();
        let scored = score_any(
            &st,
            1,
            Some(Family::Image),
            None,
            Some(unit(2.0, "2")),
            releases.clone(),
        )
        .await
        .unwrap();
        let by = |id: &str| scored.iter().find(|s| s.id == id).unwrap();
        let codes = |id: &str| -> Vec<String> {
            by(id).rejections.iter().map(|r| r.code.clone()).collect()
        };
        assert_eq!((by("ok").quality_id, by("ok").allowed), (302, true));
        assert!(codes("ok").is_empty());
        assert_eq!(codes("other"), ["EPISODE_MISMATCH"]);
        assert_eq!(codes("trade"), ["COLLECTED_EDITION"]);
        assert_eq!(codes("run"), ["COLLECTED_EDITION"]);
        assert_eq!(codes("annual"), ["EPISODE_MISMATCH"]);
        assert_eq!(by("pdf").quality_id, 305);
        assert_eq!(scored[0].id, "ok", "the digital clean issue sorts first");
        let any = score_any(&st, 1, None, None, None, releases.clone())
            .await
            .unwrap();
        assert!(
            any.iter()
                .find(|s| s.id == "other")
                .unwrap()
                .rejections
                .is_empty(),
            "no unit, no issue expected"
        );
        let annual = score_any(
            &st,
            1,
            None,
            None,
            Some(unit(2.0, "annual 2")),
            releases.clone(),
        )
        .await
        .unwrap();
        assert!(
            annual
                .iter()
                .find(|s| s.id == "annual")
                .unwrap()
                .rejections
                .is_empty()
        );
        for bad in [
            t::UnitRef {
                group: Some(1),
                ..unit(2.0, "2")
            },
            t::UnitRef {
                number: Some(123456.0),
                ..unit(2.0, "2")
            },
        ] {
            let e = score_any(&st, 1, None, None, Some(bad), releases.clone()).await;
            assert_eq!(e.unwrap_err().code, "ERR_VALIDATION");
        }
        let lang = score_any(&st, 1, None, Some("fr".into()), None, releases).await;
        assert_eq!(lang.unwrap_err().code, "ERR_VALIDATION");
    }

    #[sqlx::test(migrations = false)]
    async fn a_title_naming_an_issue_matches_by_its_state(db: PgPool) {
        volume(&db).await;
        let st = state(&db);
        let ask = |id: &str, title: &str| t::ReleaseTitle {
            id: id.into(),
            title: title.into(),
            publish_date: "2020-01-01T00:00:00Z".into(),
        };
        let titles = vec![
            ask("grab", "Star Gardens 002 (2024) (Digital) (Nitro)"),
            ask("disk", "Star Gardens 001 (2024) (Digital)"),
            ask("fresh", "Star Gardens 003 (2024) (Digital)"),
            ask("gap", "Star Gardens 009 (2024) (Digital)"),
            ask("trade", "Star Gardens TPB Vol 1 (2024) (Digital)"),
            ask("annual", "Star Gardens Annual 001 (2024) (Digital)"),
            ask("none", "Nothing Known 002 (2024) (Digital)"),
        ];
        let m = matches(&st, titles, None).await.unwrap();
        let got: Vec<_> = m
            .iter()
            .map(|m| (m.decision, m.skip_reason, m.media_id))
            .collect();
        use t::{MatchDecision::*, SkipReason::*};
        assert_eq!(
            got,
            [
                (Grab, None, Some(1)),
                (Skip, Some(OnDisk), Some(1)),
                (Skip, Some(TooFresh), Some(1)),
                (Skip, Some(NotAvailable), Some(1)),
                (Skip, Some(NotAvailable), Some(1)),
                (Grab, None, Some(1)),
                (Skip, Some(Unmatched), None),
            ]
        );
        assert_eq!(m[0].unit.as_ref().and_then(|u| u.number), Some(2.0));
        assert_eq!(
            m[5].unit.as_ref().and_then(|u| u.label.clone()),
            Some("annual 1".into())
        );
        let fresh = t::ReleaseTitle {
            publish_date: chrono::Utc::now().to_rfc3339(),
            ..ask("g", "Star Gardens 002 (2024) (Digital)")
        };
        let m = matches(&st, vec![fresh], Some(60)).await.unwrap();
        assert_eq!(m[0].skip_reason, Some(TooFresh));
        sqlx::query("UPDATE items SET monitored = false WHERE id = $1")
            .bind(item_of(&db, "issue", 2).await as i32)
            .execute(&db)
            .await
            .unwrap();
        let m = matches(&st, vec![ask("g", "Star Gardens 002 (2024)")], None)
            .await
            .unwrap();
        assert_eq!(m[0].skip_reason, Some(NotMonitored));
    }
}

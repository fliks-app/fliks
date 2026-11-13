//! The albums of rule 31: the wanted tracks of the target edition as targets, matches and scores.
use super::book::{
    Extras, WantRow, extras, pick, sizes, target as book_target, want_sql, wants, wit_scored,
};
use super::release::{Inputs, custom_formats, published};
use super::*;
use fliks_domain::release::audio::music::parse_music_release;
use fliks_domain::release::scoring::{
    BookScoreOptions, MusicExpectation, score_and_sort_music_releases,
};

/// A track of the target edition with what a target reads of it.
#[derive(FromRow, Clone)]
struct TrackRow {
    item_id: i32,
    disc: i32,
    number: Option<i32>,
    title: Option<String>,
    monitored: bool,
    has_file: bool,
}

impl TrackRow {
    /// The disc as the unit's group and the printed number as its number.
    fn unit(&self) -> t::Unit {
        t::Unit {
            ref_: t::UnitRef {
                group: Some(self.disc as u32),
                number: self.number.map(f64::from),
                end_number: None,
                label: self.title.clone(),
                absolute: None,
            },
            group_id: None,
            item_id: Some(self.item_id as u32),
            title: self.title.clone(),
            air_date: None,
            unit_count: None,
        }
    }
}

const TRACKS: &str = r#"SELECT i.id AS item_id, td."discNumber" AS disc, td."trackNumber" AS number, i.title, i.monitored,
    EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = i.id) AS has_file
  FROM items i JOIN track_details td ON td."itemId" = i.id"#;

/// The target edition of an album: its tracks, in order, and the ids a search names it by.
struct Wished {
    tracks: Vec<TrackRow>,
    edition_ids: Vec<t::ExternalId>,
    released: Option<NaiveDate>,
}

async fn wished(db: &PgPool, media: i32) -> sqlx::Result<Wished> {
    let row: Option<(Option<i32>, Option<NaiveDate>)> = sqlx::query_as(
        r#"SELECT "targetEditionId", "firstReleaseDate" FROM album_details WHERE "mediaId" = $1"#,
    )
    .bind(media)
    .fetch_optional(db)
    .await?;
    let (edition, released) = row.unwrap_or_default();
    let Some(edition) = edition else {
        return Ok(Wished {
            tracks: vec![],
            edition_ids: vec![],
            released,
        });
    };
    let tracks = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{TRACKS} WHERE i."editionId" = $1 ORDER BY td.position"#
    )))
    .bind(edition)
    .fetch_all(db)
    .await?;
    let ids: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT provider, value FROM edition_external_ids WHERE "editionId" = $1 ORDER BY provider, value"#,
    )
    .bind(edition)
    .fetch_all(db)
    .await?;
    Ok(Wished {
        tracks,
        edition_ids: ids
            .into_iter()
            .map(|(provider, value)| t::ExternalId { provider, value })
            .collect(),
        released,
    })
}

/// A target of the album, or of one of its tracks when `track` is given.
fn target(
    m: &MediaRow,
    w: &WantRow,
    x: &Extras,
    wish: &Wished,
    track: Option<&TrackRow>,
) -> Option<t::Target> {
    let mut tg = book_target(m, w, x)?;
    tg.edition_ids = wish.edition_ids.clone();
    if let Some(tr) = track {
        tg.scope = vec![tr.unit()];
        tg.search_units = vec![tr.unit().ref_];
        if let Some(want) = tg.want.as_mut() {
            want.decision = if tr.has_file {
                t::WantDecision::Skip
            } else {
                t::WantDecision::Missing
            };
        }
    }
    Some(tg)
}

/// `media.acquisitionContext` of an album: the album, or with `item_id` one of its tracks; a group is none.
pub(super) async fn context(
    db: &PgPool,
    m: &MediaRow,
    group_id: Option<u32>,
    item_id: Option<u32>,
) -> sqlx::Result<Option<t::Target>> {
    if group_id.is_some() {
        return Ok(None);
    }
    let Some(w) = pick(wants(db, m.id, &[Family::Audio]).await?, None) else {
        return Ok(None);
    };
    let wish = wished(db, m.id).await?;
    let track = match item_id {
        None => None,
        Some(item) => {
            let row: Option<TrackRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
                r#"{TRACKS} WHERE i.id = $1 AND i."mediaId" = $2"#
            )))
            .bind(item as i32)
            .bind(m.id)
            .fetch_optional(db)
            .await?;
            match row {
                Some(r) => Some(r),
                None => return Ok(None),
            }
        }
    };
    let x = extras(db, &[m.id]).await?;
    Ok(target(m, &w, &x, &wish, track.as_ref()))
}

/// The monitored albums among `ids` that are released by `on` and lack a wanted track: the album itself
/// when every track of the target edition is monitored, else one target per wanted track.
pub(super) async fn targets(
    db: &PgPool,
    ids: &[i32],
    on: NaiveDate,
) -> sqlx::Result<Vec<t::Target>> {
    let rows: Vec<WantRow> = sqlx::query_as(sqlx::AssertSqlSafe(want_sql(
        "AND m.type = 'album' AND m.monitored AND w.language IS NULL",
    )))
    .bind(ids)
    .bind(vec![Family::Audio.as_str()])
    .fetch_all(db)
    .await?;
    let open: Vec<&WantRow> = rows.iter().filter(|w| !w.satisfied).collect();
    let wanted: Vec<i32> = open.iter().map(|w| w.media_id).collect();
    let albums: HashMap<i32, MediaRow> = sqlx::query_as::<_, MediaRow>(sqlx::AssertSqlSafe(
        format!("{} WHERE m.id = ANY($1)", media_select()),
    ))
    .bind(&wanted)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|m| (m.id, m))
    .collect();
    let x = extras(db, &wanted).await?;
    let mut out = vec![];
    for w in open {
        let Some(m) = albums.get(&w.media_id) else {
            continue;
        };
        let wish = wished(db, m.id).await?;
        if wish.released.is_some_and(|d| d > on) {
            continue;
        }
        let all_monitored = wish.tracks.iter().all(|t| t.monitored);
        if all_monitored {
            out.extend(target(m, w, &x, &wish, None));
        } else {
            out.extend(
                wish.tracks
                    .iter()
                    .filter(|t| t.monitored && !t.has_file)
                    .filter_map(|t| target(m, w, &x, &wish, Some(t))),
            );
        }
    }
    Ok(out)
}

/// `releases.match` of a title that names the album `m`: a discography is never the album; an album with
/// no wanted track is on disk; one not out yet, or a release too fresh, waits.
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
    if parse_music_release(&entry.title).discography {
        return Ok(skip(t::SkipReason::NotAvailable));
    }
    let Some(w) = pick(wants(db, m.id, &[Family::Audio]).await?, None) else {
        return Ok(skip(t::SkipReason::NotAvailable));
    };
    if w.satisfied {
        return Ok(skip(t::SkipReason::OnDisk));
    }
    if wished(db, m.id)
        .await?
        .released
        .is_some_and(|d| d > Utc::now().date_naive())
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

/// `releases.score` of an album: the audio want's profile over the music pipeline, `[]` for an unknown media.
pub(super) async fn score(
    st: &AppState,
    m: &MediaRow,
    unit: Option<&t::UnitRef>,
    releases: Vec<t::CandidateRelease>,
) -> sqlx::Result<Vec<t::ScoredRelease>> {
    let db = &st.db;
    let want = pick(wants(db, m.id, &[Family::Audio]).await?, None);
    let formats = custom_formats(db).await?;
    let inp = Inputs::of(releases);
    let x = extras(db, &[m.id]).await?;
    let track = unit
        .and_then(|u| u.label.clone())
        .filter(|l| !l.trim().is_empty());
    let artists: Vec<String> = x
        .creators
        .get(&m.id)
        .into_iter()
        .flatten()
        .filter(|c| c.role == "artist")
        .map(|c| c.name.clone())
        .collect();
    let opts = BookScoreOptions {
        allowed: want.as_ref().map_or_else(
            || default_allowed(Family::Audio).into_iter().collect(),
            WantRow::allowed,
        ),
        allowed_langs: BTreeSet::new(),
        size_by_quality: sizes(db, Family::Audio).await?,
        source_min_seeders: inp.min_seeders,
        source_unknown_lang: inp.unknown_lang,
        // A track is scored on its own title; the album's length says nothing of its size.
        duration_minutes: if track.is_some() {
            0.0
        } else {
            f64::from(x.minutes.get(&m.id).copied().unwrap_or(0))
        },
        expected_title: Some(ExpectedTitle::Many(match track {
            Some(title) => vec![title],
            None => resolve_search_titles(&m.search(), None).expected_titles,
        })),
        expected_year: None,
        min_custom_format_score: want
            .as_ref()
            .and_then(|w| w.qp_id.map(|_| i64::from(w.qp_min_cf.unwrap_or(0)))),
        min_rank_exclusive: None,
        max_rank_inclusive: None,
        expected_issue: None,
    };
    let expect = MusicExpectation {
        artists,
        allow_discography: false,
    };
    let (blocked, ids, candidates) = (inp.blocked, inp.ids, inp.candidates);
    let scored = tokio::task::spawn_blocking(move || {
        let compiled = fliks_domain::release::scoring::CompiledFormats::new(&formats);
        let formats = |title: &str, flags: &[String]| compiled.score(title, flags);
        let blocked = |_: &str, source_id: i64| blocked.get(&source_id).copied().unwrap_or(false);
        score_and_sort_music_releases(candidates, &opts, &expect, &formats, &blocked)
    })
    .await
    .unwrap_or_else(|e| std::panic::resume_unwind(e.into_panic()));
    Ok(wit_scored(&ids, scored))
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

    /// Album 1 "Salt Meadows" by Cora Vell: a target edition of three tracks, track 1 on disk.
    async fn album(db: &PgPool) {
        crate::db::migrate(db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'M', '["album"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO media (id, title, year, type, "libraryId", "folderName", monitored)
                 VALUES (1, 'Salt Meadows', 2019, 'album', 1, 'Cora Vell/Salt Meadows', true);
               INSERT INTO persons (id, name) VALUES (1, 'Cora Vell');
               INSERT INTO media_credits ("mediaId", "personId", role, position) VALUES (1, 1, 'artist', 0)"#,
        )
        .execute(db)
        .await
        .unwrap();
        let mut c = db.acquire().await.unwrap();
        crate::media::items::create_shell(&mut c, 1, MediaKind::Album, Default::default())
            .await
            .unwrap();
        drop(c);
        sqlx::raw_sql(
            r#"INSERT INTO editions ("mediaId", family) VALUES (1, 'audio');
               INSERT INTO edition_external_ids ("editionId", "mediaId", provider, value)
                 SELECT id, 1, 'musicbrainz', '11111111-1111-1111-1111-111111111111' FROM editions;
               INSERT INTO items ("mediaId", "editionId", monitored, title)
                 SELECT 1, e.id, true, 'T' || n FROM editions e, generate_series(1, 3) n;
               INSERT INTO track_details ("itemId", "mediaId", "discNumber", position, "trackNumber")
                 SELECT i.id, 1, 1, i.id - (SELECT min(id) FROM items) + 1, i.id - (SELECT min(id) FROM items) + 1 FROM items i;
               INSERT INTO album_details ("mediaId", "targetEditionId", "firstReleaseDate")
                 SELECT 1, id, '2019-05-01' FROM editions;
               WITH f AS (INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId")
                          VALUES ('01.flac', 1, 'flac', 1, (SELECT min(id) FROM library_folders)) RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
                 SELECT (SELECT min(id) FROM items), f.id, 1, 0, 0 FROM f"#,
        )
        .execute(db)
        .await
        .unwrap();
    }

    fn release(id: &str, title: &str) -> t::CandidateRelease {
        t::CandidateRelease {
            id: id.into(),
            title: title.into(),
            size: 300 * 1024 * 1024,
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

    fn query() -> t::CandidatesQuery {
        t::CandidatesQuery {
            kind: Some("album".into()),
            family: None,
            media_ids: None,
            available_on: "2030-01-01".into(),
            limit: 50,
            cursor: None,
        }
    }

    #[sqlx::test(migrations = false)]
    async fn an_album_with_a_missing_track_is_one_target(db: PgPool) {
        album(&db).await;
        let on = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
        let page = candidates(&db, query(), on).await.unwrap();
        let [tg] = &page.items[..] else {
            panic!("one target")
        };
        assert_eq!((tg.kind.as_str(), tg.family), ("album", t::Family::Audio));
        assert!(tg.scope.is_empty());
        assert_eq!(
            tg.creators
                .iter()
                .map(|c| c.name.as_str())
                .collect::<Vec<_>>(),
            ["Cora Vell"]
        );
        assert_eq!(tg.edition_ids[0].provider, "musicbrainz");
        assert_eq!(tg.want.as_ref().unwrap().decision, t::WantDecision::Missing);
    }

    #[sqlx::test(migrations = false)]
    async fn a_partly_monitored_album_is_wanted_track_by_track(db: PgPool) {
        album(&db).await;
        sqlx::query(r#"UPDATE items SET monitored = false WHERE title = 'T3'"#)
            .execute(&db)
            .await
            .unwrap();
        let on = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
        let page = candidates(&db, query(), on).await.unwrap();
        let [tg] = &page.items[..] else {
            panic!("one target")
        };
        let unit = &tg.scope[0];
        assert_eq!((unit.ref_.group, unit.ref_.number), (Some(1), Some(2.0)));
        assert_eq!(unit.title.as_deref(), Some("T2"));
    }

    #[sqlx::test(migrations = false)]
    async fn a_satisfied_or_unreleased_album_is_not_wanted(db: PgPool) {
        album(&db).await;
        let on = NaiveDate::from_ymd_opt(2030, 1, 1).unwrap();
        sqlx::query(r#"UPDATE items SET monitored = false WHERE title IN ('T2', 'T3')"#)
            .execute(&db)
            .await
            .unwrap();
        assert!(candidates(&db, query(), on).await.unwrap().items.is_empty());
        sqlx::query(r#"UPDATE items SET monitored = true"#)
            .execute(&db)
            .await
            .unwrap();
        let early = NaiveDate::from_ymd_opt(2019, 1, 1).unwrap();
        assert!(
            candidates(&db, query(), early)
                .await
                .unwrap()
                .items
                .is_empty()
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_recording_owned_by_another_edition_satisfies_the_track(db: PgPool) {
        album(&db).await;
        sqlx::raw_sql(
            r#"UPDATE track_details SET "recordingMbid" = '22222222-2222-2222-2222-222222222222'
                WHERE "trackNumber" = 2;
               INSERT INTO editions ("mediaId", family) VALUES (1, 'audio');
               INSERT INTO items ("mediaId", "editionId", monitored, title)
                 SELECT 1, id, true, 'Other' FROM editions ORDER BY id DESC LIMIT 1;
               INSERT INTO track_details ("itemId", "mediaId", position, "recordingMbid")
                 SELECT max(id), 1, 1, '22222222-2222-2222-2222-222222222222' FROM items;
               WITH f AS (INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId")
                          VALUES ('x.flac', 1, 'flac', 1, (SELECT min(id) FROM library_folders)) RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
                 SELECT (SELECT max(id) FROM items), f.id, 1, 0, 0 FROM f"#,
        )
        .execute(&db)
        .await
        .unwrap();
        let wants = crate::media::wants::list(&db, 1).await.unwrap();
        assert!(!wants[0].satisfied, "track 3 has no other copy");
        sqlx::query(r#"UPDATE track_details SET "recordingMbid" = '22222222-2222-2222-2222-222222222222' WHERE "trackNumber" = 3"#)
            .execute(&db)
            .await
            .unwrap();
        assert!(crate::media::wants::list(&db, 1).await.unwrap()[0].satisfied);
    }

    #[sqlx::test(migrations = false)]
    async fn the_context_of_a_track_names_its_unit(db: PgPool) {
        album(&db).await;
        let st = state(&db);
        let item: i32 = sqlx::query_scalar(r#"SELECT id FROM items WHERE title = 'T2'"#)
            .fetch_one(&db)
            .await
            .unwrap();
        let tg = context(&st, 1, None, None, None, Some(item as u32))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(tg.scope[0].item_id, Some(item as u32));
        assert!(
            context(&st, 1, None, None, Some(1), None)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_release_is_matched_by_album_and_artist(db: PgPool) {
        use t::SkipReason::*;
        album(&db).await;
        let st = state(&db);
        let ask = |id: &str, title: &str| t::ReleaseTitle {
            id: id.into(),
            title: title.into(),
            publish_date: "2020-01-01T00:00:00Z".into(),
        };
        let titles = vec![
            ask("grab", "Cora Vell - Salt Meadows (2019) [FLAC]"),
            ask("other-artist", "Someone Else - Salt Meadows (2019) [FLAC]"),
            ask("pack", "Cora Vell - Discography (1998-2020) FLAC"),
        ];
        let m = matches(&st, titles, None).await.unwrap();
        assert_eq!(m[0].decision, t::MatchDecision::Grab);
        assert_eq!(m[1].skip_reason, Some(Unmatched));
        assert_ne!(m[2].decision, t::MatchDecision::Grab);
        sqlx::query(r#"UPDATE items SET monitored = false WHERE title IN ('T2', 'T3')"#)
            .execute(&db)
            .await
            .unwrap();
        let again = matches(
            &st,
            vec![ask("g", "Cora Vell - Salt Meadows (2019) [FLAC]")],
            None,
        )
        .await
        .unwrap();
        assert_eq!(again[0].skip_reason, Some(OnDisk));
    }

    #[sqlx::test(migrations = false)]
    async fn releases_are_scored_for_the_artist_and_the_pack_shape(db: PgPool) {
        album(&db).await;
        let st = state(&db);
        let scored = score_any(
            &st,
            1,
            None,
            None,
            None,
            vec![
                release("ok", "Cora Vell - Salt Meadows (2019) [FLAC]"),
                release("wrong", "Someone Else - Salt Meadows (2019) [FLAC]"),
                release(
                    "pack",
                    "Cora Vell - Salt Meadows Discography (1998-2020) [FLAC]",
                ),
            ],
        )
        .await
        .unwrap();
        let by = |id: &str| scored.iter().find(|s| s.id == id).unwrap();
        assert!(by("ok").rejections.is_empty(), "{:?}", by("ok").rejections);
        assert_eq!(by("ok").quality_id, 114);
        assert!(
            by("wrong")
                .rejections
                .iter()
                .any(|r| r.code == "ARTIST_MISMATCH")
        );
        assert!(
            by("pack")
                .rejections
                .iter()
                .any(|r| r.code == "DISCOGRAPHY")
        );
        assert_eq!(scored[0].id, "ok", "the clean release sorts first");
    }

    #[sqlx::test(migrations = false)]
    async fn a_track_is_scored_on_its_own_title(db: PgPool) {
        album(&db).await;
        let st = state(&db);
        let score = |unit: Option<t::UnitRef>| {
            score_any(
                &st,
                1,
                None,
                None,
                unit,
                vec![release("r", "Cora Vell - T2 [FLAC]")],
            )
        };
        let track = t::UnitRef {
            group: Some(1),
            number: Some(2.0),
            end_number: None,
            label: Some("T2".into()),
            absolute: None,
        };
        let codes = |s: Vec<t::ScoredRelease>| {
            s[0].rejections
                .iter()
                .map(|r| r.code.clone())
                .collect::<Vec<_>>()
        };
        assert!(codes(score(None).await.unwrap()).contains(&"TITLE_MISMATCH".to_owned()));
        assert!(!codes(score(Some(track)).await.unwrap()).contains(&"TITLE_MISMATCH".to_owned()));
    }
}

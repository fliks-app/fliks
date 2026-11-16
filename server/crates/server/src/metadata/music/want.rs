//! Wanting one track of an album by its recording (`docs/spec/music.md` rule 73), shared by
//! `POST /api/music/want-recording` and the import lists' `music-want-recording`.
use super::{Create, Fetched, fetch, fetch_edition, target, write_edition};
use crate::{http::AppError, metadata::MetaError, state::AppState};
use axum::http::StatusCode;
use fliks_domain::{
    external_id::{ExternalProvider, Namespace},
    metadata::{language::Resolved, limiter::Priority},
    music::{
        profile::MetadataProfile,
        provider::{Release, Track},
        target::cover,
    },
};
use sqlx::PgPool;

const NS: Namespace = Namespace::MUSICBRAINZ;

#[derive(Clone, Copy)]
pub enum Recording<'a> {
    Isrc(&'a str),
    Mbid(&'a str),
}

/// Why no track was wanted.
#[derive(Debug)]
pub enum Refused {
    /// No release of the album holds these recordings.
    NotOnAlbum(Vec<String>),
    /// The album's releases could not be read yet: retryable.
    Unavailable,
    Db(sqlx::Error),
}

impl From<sqlx::Error> for Refused {
    fn from(e: sqlx::Error) -> Self {
        Self::Db(e)
    }
}

impl Refused {
    pub fn app_error(self) -> AppError {
        match self {
            Self::NotOnAlbum(ids) => AppError::not_found(format!(
                "No release of the album holds recording(s) {}",
                ids.join(", ")
            )),
            Self::Unavailable => AppError::with_message(
                StatusCode::SERVICE_UNAVAILABLE,
                "The album's releases are not available yet",
            ),
            Self::Db(e) => e.into(),
        }
    }
}

impl<'a> Recording<'a> {
    fn parts(self) -> (Namespace, &'a str) {
        match self {
            Self::Isrc(v) => (Namespace::Core(ExternalProvider::Isrc), v),
            Self::Mbid(v) => (Namespace::MUSICBRAINZ, v),
        }
    }
}

/// The item of `media` a recording names; `owned` keeps only the tracks that have a file.
pub async fn item_of(
    db: &PgPool,
    media: Option<i32>,
    recording: Recording<'_>,
    owned: bool,
) -> sqlx::Result<Option<(i32, i32)>> {
    let (column, value) = match recording {
        Recording::Isrc(v) => ("isrc", v),
        Recording::Mbid(v) => ("\"recordingMbid\"::text", v),
    };
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT td."mediaId", td."itemId" FROM track_details td
             JOIN album_details ad ON ad."mediaId" = td."mediaId"
             JOIN items i ON i.id = td."itemId"
            WHERE td.{column} = $1 AND ($2::int IS NULL OR td."mediaId" = $2)
              AND (NOT $3 OR EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = td."itemId"))
            ORDER BY (i."editionId" = ad."targetEditionId") DESC, td."itemId" LIMIT 1"#
    )))
    .bind(value)
    .bind(media)
    .bind(owned)
    .fetch_optional(db)
    .await
}

pub(crate) async fn has_target(db: &PgPool, media: i32) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        r#"SELECT COALESCE((SELECT "targetEditionId" IS NOT NULL FROM album_details WHERE "mediaId" = $1), false)"#,
    )
    .bind(media)
    .fetch_one(db)
    .await
}

/// Makes `items` wanted and their album monitored. An album this call created (`fresh`) keeps only those
/// tracks of its target edition monitored; one the library already had keeps its other tracks as they are.
pub async fn monitor(db: &PgPool, media: i32, items: &[i32], fresh: bool) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    if fresh {
        sqlx::query(
            r#"UPDATE items SET monitored = false
                WHERE "mediaId" = $1 AND id <> ALL($2)
                  AND "editionId" = (SELECT "targetEditionId" FROM album_details WHERE "mediaId" = $1)"#,
        )
        .bind(media)
        .bind(items)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("UPDATE items SET monitored = true WHERE id = ANY($1)")
        .bind(items)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE media SET monitored = true WHERE id = $1 AND NOT monitored")
        .bind(media)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}

/// The releases of `fetched` that the recordings `rest` (held by no edition of the album) go to, the fewest
/// (`music.md` rule 73): each round the release holding most of what is left, ties by pressing preference.
/// Each release comes with the indices of `rest` it takes; a recording on no release of the group is refused.
pub(super) async fn place<'a>(
    st: &AppState,
    fetched: &'a Fetched,
    lang: &Resolved,
    profile: &MetadataProfile,
    rest: &[Recording<'_>],
    prio: Priority,
) -> Result<Vec<(&'a Release, Vec<usize>)>, Refused> {
    let mut holders = Vec::with_capacity(rest.len());
    let mut missing = vec![];
    for r in rest {
        let (source, id) = r.parts();
        let all = match st
            .metadata
            .recording_releases(NS, source, id, lang, prio)
            .await
        {
            Ok(all) => all,
            Err(MetaError::Upstream(u)) if u.status == Some(404) => vec![],
            Err(MetaError::Upstream(u)) => {
                tracing::warn!("recording {id}: releases not read: {u}");
                return Err(Refused::Unavailable);
            }
            Err(MetaError::Db(e)) => return Err(e.into()),
        };
        let here: Vec<String> = all
            .into_iter()
            .filter(|x| fetched.releases.iter().any(|r| &r.external_id == x))
            .collect();
        if here.is_empty() {
            missing.push(id.to_owned());
        }
        holders.push(here);
    }
    if !missing.is_empty() {
        return Err(Refused::NotOnAlbum(missing));
    }
    let cfg = crate::ingest::music::identify::config(st).await;
    Ok(cover(&fetched.releases, profile, &cfg, &holders))
}

/// The recordings of `recordings` that no edition of `media` holds yet, as their index and item.
async fn held(
    db: &PgPool,
    media: i32,
    recordings: &[Recording<'_>],
) -> sqlx::Result<Vec<Option<i32>>> {
    let mut out = vec![];
    for r in recordings {
        out.push(item_of(db, Some(media), *r, false).await?.map(|(_, i)| i));
    }
    Ok(out)
}

/// Places the recordings on the editions of `media` (writing the releases that hold the ones no edition
/// has, unmonitored) and returns their items; the caller holds the album's lock.
async fn placed(
    st: &AppState,
    media: i32,
    recordings: &[Recording<'_>],
    existed: bool,
) -> Result<Vec<i32>, Refused> {
    let mut items = held(&st.db, media, recordings).await?;
    if items.iter().all(Option::is_some) {
        return Ok(items.into_iter().flatten().collect());
    }
    let was: bool = sqlx::query_scalar("SELECT monitored FROM media WHERE id = $1")
        .bind(media)
        .fetch_one(&st.db)
        .await?;
    let leave = async |refused| {
        if !existed || !was {
            sqlx::query("UPDATE media SET monitored = false WHERE id = $1")
                .bind(media)
                .execute(&st.db)
                .await?;
        }
        Err(refused)
    };
    if !has_target(&st.db, media).await? {
        sqlx::query("UPDATE media SET monitored = true WHERE id = $1")
            .bind(media)
            .execute(&st.db)
            .await?;
        if let Err(e) = target::ensure(st, media, Priority::Background).await {
            tracing::warn!("album #{media}: no target edition yet: {}", e.text());
        }
        if !has_target(&st.db, media).await? {
            return leave(Refused::Unavailable).await;
        }
        items = held(&st.db, media, recordings).await?;
    }
    let rest: Vec<usize> = (0..items.len()).filter(|i| items[*i].is_none()).collect();
    if !rest.is_empty() {
        match write_holders(st, media, recordings, &rest).await {
            Ok(()) => {}
            Err(refused) => return leave(refused).await,
        }
        items = held(&st.db, media, recordings).await?;
        let lost: Vec<String> = (0..items.len())
            .filter(|i| items[*i].is_none())
            .map(|i| recordings[i].parts().1.to_owned())
            .collect();
        if !lost.is_empty() {
            return leave(Refused::NotOnAlbum(lost)).await;
        }
    }
    Ok(items.into_iter().flatten().collect())
}

/// Writes, unmonitored, the releases that hold the recordings `rest` of `recordings`.
async fn write_holders(
    st: &AppState,
    media: i32,
    recordings: &[Recording<'_>],
    rest: &[usize],
) -> Result<(), Refused> {
    let ask: Vec<Recording> = rest.iter().map(|i| recordings[*i]).collect();
    let album = target::album(&st.db, media).await?;
    let (Some(group), Some(library)) = (
        album.as_ref().and_then(|a| a.id.clone()),
        album.and_then(|a| a.library),
    ) else {
        return Err(Refused::NotOnAlbum(
            ask.iter().map(|r| r.parts().1.to_owned()).collect(),
        ));
    };
    let unavailable = |e: AppError| {
        tracing::warn!("album #{media}: releases not read: {}", e.text());
        Refused::Unavailable
    };
    let lang = crate::metadata::library_language(st, library)
        .await
        .map_err(unavailable)?;
    let profile = crate::libraries::metadata_profile(&st.db, library)
        .await
        .map_err(Refused::Db)?;
    let prio = Priority::Background;
    let fetched = fetch(st, NS, &group, &lang, prio)
        .await
        .map_err(unavailable)?;
    for (release, _) in place(st, &fetched, &lang, &profile, &ask, prio).await? {
        let edition = fetch_edition(st, NS, &release.external_id, &lang, prio)
            .await
            .map_err(unavailable)?;
        let id = target::edition_of(&st.db, media, &release.external_id).await?;
        write_edition(st, media, id, &edition, Create::Unmonitored)
            .await
            .map_err(unavailable)?;
    }
    Ok(())
}

/// `want_many` of one recording.
pub async fn want(
    st: &AppState,
    media: i32,
    recording: Recording<'_>,
    existed: bool,
) -> Result<i32, Refused> {
    Ok(want_many(st, media, &[recording], existed).await?[0])
}

/// Wants the tracks of `recordings` on an album just resolved, all or none (`music.md` rule 73): a recording
/// an edition of the album holds is that edition's track, the others go to the fewest releases of the group
/// that hold them, written as editions with their tracks unmonitored. Never moves the target. Under the
/// album's advisory lock, so two wants of one album never make the same edition twice.
pub async fn want_many(
    st: &AppState,
    media: i32,
    recordings: &[Recording<'_>],
    existed: bool,
) -> Result<Vec<i32>, Refused> {
    let mut lock = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(format!("music-want:{media}"))
        .execute(&mut *lock)
        .await?;
    let items = placed(st, media, recordings, existed).await?;
    monitor(&st.db, media, &items, !existed).await?;
    lock.commit().await?;
    Ok(items)
}

/// The tracklist of the release `recordings` would be wanted on in `group` for `library` (rule 74): the
/// edition of the album that holds the first one, else the release placement picks, written nowhere.
pub async fn tracklist(
    st: &AppState,
    group: &str,
    library: i32,
    recordings: &[Recording<'_>],
    prio: Priority,
) -> Result<Vec<Track>, AppError> {
    let lang = crate::metadata::library_language(st, library).await?;
    let profile = crate::libraries::metadata_profile(&st.db, library).await?;
    let fetched = fetch(st, NS, group, &lang, prio).await?;
    if recordings.is_empty() {
        return target::main_tracks(st, group, library, prio).await;
    }
    let cfg = crate::ingest::music::identify::config(st).await;
    let album = crate::media::external_ids::find(
        &st.db,
        fliks_domain::media::kind::MediaKind::Album,
        NS,
        group,
    )
    .await?;
    let album = match album {
        Some(media) if has_target(&st.db, media).await? => Some(media),
        _ => None,
    };
    // The release each recording already sits on: the album's own edition, else the one it would target.
    let mut sits: Vec<Option<Option<String>>> = vec![];
    match album {
        Some(media) => {
            for r in recordings {
                sits.push(release_of(&st.db, media, *r).await?);
            }
        }
        None => {
            let main =
                fliks_domain::music::target::pick_target(&fetched.releases, &profile, &cfg, None);
            let tracks = match main {
                Some(m) => {
                    fetch_edition(st, NS, &m.external_id, &lang, prio)
                        .await?
                        .tracks
                }
                None => vec![],
            };
            for r in recordings {
                let (_, id) = r.parts();
                let on = tracks.iter().any(|t| t.recording_id.as_deref() == Some(id));
                sits.push(main.filter(|_| on).map(|m| Some(m.external_id.clone())));
            }
        }
    }
    let rest: Vec<usize> = (0..sits.len()).filter(|i| sits[*i].is_none()).collect();
    let ask: Vec<Recording> = rest.iter().map(|i| recordings[*i]).collect();
    let placed = place(st, &fetched, &lang, &profile, &ask, prio)
        .await
        .map_err(Refused::app_error)?;
    let first = match &sits[0] {
        Some(Some(r)) => r.clone(),
        Some(None) => return target::main_tracks(st, group, library, prio).await,
        None => placed
            .iter()
            .find(|(_, took)| took.contains(&0))
            .map(|(r, _)| r.external_id.clone())
            .ok_or_else(|| AppError::not_found("No release of the album holds the recording"))?,
    };
    Ok(fetch_edition(st, NS, &first, &lang, prio).await?.tracks)
}

/// The musicbrainz release of the edition holding `recording` on `media`: none when no edition holds it,
/// `Some(None)` when the edition that does names no release.
async fn release_of(
    db: &PgPool,
    media: i32,
    recording: Recording<'_>,
) -> sqlx::Result<Option<Option<String>>> {
    let Some((_, item)) = item_of(db, Some(media), recording, false).await? else {
        return Ok(None);
    };
    sqlx::query_scalar(
        r#"SELECT x.value FROM items i JOIN edition_external_ids x ON x."editionId" = i."editionId"
            WHERE i.id = $1 AND x.provider = 'musicbrainz' ORDER BY x.value LIMIT 1"#,
    )
    .bind(item)
    .fetch_optional(db)
    .await
    .map(Some)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::metadata::music::tests::{GROUP, MusicFake};
    use serde_json::json;
    use std::sync::Arc;

    pub(crate) const STD: &str = "a0000000-0000-4000-8000-000000000001";
    const STD_B: &str = "a0000000-0000-4000-8000-000000000002";
    pub(crate) const PLUS: &str = "a0000000-0000-4000-8000-000000000003";
    const DELUXE: &str = "a0000000-0000-4000-8000-000000000004";
    const ALT: &str = "a0000000-0000-4000-8000-000000000005";
    const S1: &str = "b0000000-0000-4000-8000-000000000001";
    const S2: &str = "b0000000-0000-4000-8000-000000000002";
    const STUDIO: &str = "b0000000-0000-4000-8000-000000000003";
    pub(crate) const LIVE: &str = "b0000000-0000-4000-8000-000000000004";
    const BONUS: &str = "b0000000-0000-4000-8000-000000000005";
    const EXTRA: &str = "b0000000-0000-4000-8000-000000000006";
    const ONLY_ALT: &str = "b0000000-0000-4000-8000-000000000007";
    const NOWHERE: &str = "b0000000-0000-4000-8000-000000000008";

    fn tracks(list: &[(&str, &str, i32)]) -> Vec<serde_json::Value> {
        list.iter()
            .enumerate()
            .map(|(i, (title, id, ms))| {
                json!({"title": title, "discNumber": 1, "position": i + 1, "number": i + 1,
                       "durationMs": ms, "recordingId": id})
            })
            .collect()
    }

    /// A group of five releases: two standard ones of 3 tracks, a 4-track and a 6-track one holding the live
    /// take of "Song", and a 2-track one.
    pub(crate) fn fake() -> Arc<MusicFake> {
        let f = Arc::new(MusicFake::default());
        f.works.lock().unwrap().insert(
            GROUP.into(),
            json!({"externalId": GROUP, "title": "Alpha", "primaryType": "album", "year": 2019,
                   "mediaType": "album", "artists": [{"name": "Ana"}]}),
        );
        let releases = [
            (
                STD,
                3,
                "2019-01-01",
                tracks(&[
                    ("One", S1, 100_000),
                    ("Two", S2, 100_000),
                    ("Song", STUDIO, 237_000),
                ]),
            ),
            (
                STD_B,
                3,
                "2020-01-01",
                tracks(&[
                    ("One", S1, 100_000),
                    ("Two", S2, 100_000),
                    ("Song", STUDIO, 237_000),
                ]),
            ),
            (
                PLUS,
                4,
                "2021-01-01",
                tracks(&[
                    ("One", S1, 100_000),
                    ("Two", S2, 100_000),
                    ("Song", LIVE, 306_000),
                    ("Extra", BONUS, 90_000),
                ]),
            ),
            (
                DELUXE,
                6,
                "2021-06-01",
                tracks(&[
                    ("One", S1, 100_000),
                    ("Two", S2, 100_000),
                    ("Song", STUDIO, 237_000),
                    ("Song", LIVE, 306_000),
                    ("Extra", BONUS, 90_000),
                    ("More", EXTRA, 80_000),
                ]),
            ),
            (
                ALT,
                2,
                "2022-01-01",
                tracks(&[("One", S1, 100_000), ("Only", ONLY_ALT, 70_000)]),
            ),
        ];
        let mut children = vec![];
        for (id, n, date, list) in releases {
            children.push(
                json!({"externalId": id, "title": "Alpha", "country": "GB", "status": "official",
                                 "trackCount": n, "releaseDate": date}),
            );
            f.editions.lock().unwrap().insert(
                id.into(),
                json!({"externalId": id, "title": "Alpha", "country": "GB", "status": "official", "media": "cd",
                       "trackCount": n, "releaseDate": date, "tracks": list}),
            );
        }
        f.children.lock().unwrap().insert(GROUP.into(), children);
        let mut h = f.holders.lock().unwrap();
        h.insert(LIVE.into(), vec![PLUS.into(), DELUXE.into()]);
        h.insert(BONUS.into(), vec![PLUS.into(), DELUXE.into()]);
        h.insert(EXTRA.into(), vec![DELUXE.into()]);
        h.insert(ONLY_ALT.into(), vec![ALT.into()]);
        drop(h);
        f
    }

    pub(crate) async fn state(db: &PgPool, f: Arc<MusicFake>) -> AppState {
        crate::db::migrate(db).await.unwrap();
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'M', '["album"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO media (id, title, type, "libraryId", "folderName", monitored)
                 VALUES (1, 'Alpha', 'album', 1, 'Ana/Alpha', false);
               INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES (1, 'album', 'musicbrainz', '{GROUP}')"#
        )))
        .execute(db)
        .await
        .unwrap();
        let st = AppState::new(
            db.clone(),
            crate::config::Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        st.metadata.add_plugin(f);
        st
    }

    fn mbid(id: &str) -> Recording<'_> {
        Recording::Mbid(id)
    }

    /// The release of each edition of album 1 with its monitored track count, by edition id.
    async fn editions(db: &PgPool) -> Vec<(String, i64, i64)> {
        sqlx::query_as(
            r#"SELECT x.value, count(i.id), count(i.id) FILTER (WHERE i.monitored)
                 FROM editions e JOIN edition_external_ids x ON x."editionId" = e.id
                 LEFT JOIN items i ON i."editionId" = e.id
                WHERE e."mediaId" = 1 GROUP BY e.id, x.value ORDER BY e.id"#,
        )
        .fetch_all(db)
        .await
        .unwrap()
    }

    fn asked(f: &MusicFake) -> usize {
        f.calls()
            .iter()
            .filter(|c| c.starts_with("recording_releases"))
            .count()
    }

    #[sqlx::test(migrations = false)]
    async fn a_recording_only_a_bonus_release_holds_is_wanted_on_that_edition(db: PgPool) {
        let f = fake();
        let st = state(&db, f.clone()).await;
        let items = want_many(&st, 1, &[mbid(LIVE)], false).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(
            editions(&db).await,
            [(STD.to_owned(), 3, 0), (PLUS.to_owned(), 4, 1)],
            "the target stays the standard release, only the live take is wanted"
        );
        let target: i32 = sqlx::query_scalar(
            r#"SELECT "targetEditionId" FROM album_details WHERE "mediaId" = 1"#,
        )
        .fetch_one(&db)
        .await
        .unwrap();
        let first: i32 = sqlx::query_scalar(r#"SELECT min(id) FROM editions WHERE "mediaId" = 1"#)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(target, first);
        let on: bool = sqlx::query_scalar("SELECT monitored FROM media WHERE id = 1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(on);
    }

    #[sqlx::test(migrations = false)]
    async fn a_recording_an_edition_holds_asks_the_provider_nothing(db: PgPool) {
        let f = fake();
        let st = state(&db, f.clone()).await;
        want_many(&st, 1, &[mbid(STUDIO)], false).await.unwrap();
        assert_eq!(asked(&f), 0, "on the target");
        want_many(&st, 1, &[mbid(LIVE)], true).await.unwrap();
        assert_eq!(asked(&f), 1);
        want_many(&st, 1, &[mbid(LIVE), mbid(BONUS)], true)
            .await
            .unwrap();
        assert_eq!(
            asked(&f),
            1,
            "the bonus track is on the live take's edition too"
        );
        assert_eq!(editions(&db).await.len(), 2);
    }

    #[sqlx::test(migrations = false)]
    async fn recordings_on_one_release_make_one_edition_and_on_two_make_two(db: PgPool) {
        let st = state(&db, fake()).await;
        want_many(&st, 1, &[mbid(LIVE), mbid(EXTRA)], false)
            .await
            .unwrap();
        assert_eq!(
            editions(&db)
                .await
                .iter()
                .map(|e| e.0.as_str())
                .collect::<Vec<_>>(),
            [STD, DELUXE],
            "the deluxe release holds both"
        );
        want_many(&st, 1, &[mbid(ONLY_ALT)], true).await.unwrap();
        assert_eq!(editions(&db).await.len(), 3);
    }

    #[sqlx::test(migrations = false)]
    async fn the_cover_prefers_the_release_nearest_the_usual_size(db: PgPool) {
        let st = state(&db, fake()).await;
        want_many(&st, 1, &[mbid(LIVE), mbid(BONUS)], false)
            .await
            .unwrap();
        assert_eq!(
            editions(&db)
                .await
                .iter()
                .map(|e| e.0.as_str())
                .collect::<Vec<_>>(),
            [STD, PLUS],
            "the 4-track release beats the 6-track one for the same recordings"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_recording_on_no_release_refuses_the_whole_want(db: PgPool) {
        let st = state(&db, fake()).await;
        let Err(Refused::NotOnAlbum(ids)) =
            want_many(&st, 1, &[mbid(LIVE), mbid(NOWHERE)], false).await
        else {
            panic!("refused")
        };
        assert_eq!(ids, [NOWHERE]);
        assert_eq!(
            editions(&db).await.len(),
            1,
            "no edition written for the live take"
        );
        let on: bool = sqlx::query_scalar("SELECT monitored FROM media WHERE id = 1")
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(!on, "an album this call made stays unmonitored");
        assert_eq!(Refused::NotOnAlbum(ids).app_error().status().as_u16(), 404);
    }

    #[sqlx::test(migrations = false)]
    async fn a_wanted_secondary_track_keeps_the_album_unsatisfied_until_it_has_a_file(db: PgPool) {
        let st = state(&db, fake()).await;
        sqlx::query(r#"INSERT INTO wants ("mediaId", family) VALUES (1, 'audio')"#)
            .execute(&db)
            .await
            .unwrap();
        let items = want_many(&st, 1, &[mbid(LIVE)], false).await.unwrap();
        assert!(!crate::media::wants::list(&db, 1).await.unwrap()[0].satisfied);
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
                 VALUES (1, 1, 1, 'x.flac', 1, 'flac');
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
                 VALUES ({}, 1, 1, 0, 0)"#,
            items[0]
        )))
        .execute(&db)
        .await
        .unwrap();
        assert!(crate::media::wants::list(&db, 1).await.unwrap()[0].satisfied);
    }

    #[sqlx::test(migrations = false)]
    async fn the_picker_shows_the_release_the_want_would_use(db: PgPool) {
        let f = fake();
        let st = state(&db, f.clone()).await;
        let ids = |t: Vec<Track>| t.iter().map(|t| t.title.clone()).collect::<Vec<_>>();
        let plain = tracklist(&st, GROUP, 1, &[], Priority::Interactive)
            .await
            .unwrap();
        assert_eq!(plain.len(), 3);
        let read = tracklist(
            &st,
            GROUP,
            1,
            &[mbid(LIVE), mbid(BONUS)],
            Priority::Interactive,
        )
        .await
        .unwrap();
        assert_eq!(ids(read).len(), 4);
        assert_eq!(
            tracklist(&st, GROUP, 1, &[mbid(STUDIO)], Priority::Interactive)
                .await
                .unwrap()
                .len(),
            3,
            "the target holds it"
        );
        assert!(
            tracklist(&st, GROUP, 1, &[mbid(NOWHERE)], Priority::Interactive)
                .await
                .is_err()
        );
        // The real want of the same recordings writes the release the picker showed.
        want_many(&st, 1, &[mbid(LIVE), mbid(BONUS)], false)
            .await
            .unwrap();
        assert_eq!(editions(&db).await[1].0, PLUS);
        let held = tracklist(&st, GROUP, 1, &[mbid(LIVE)], Priority::Interactive)
            .await
            .unwrap();
        assert_eq!(held.len(), 4, "the album's own edition once it holds it");
    }

    #[sqlx::test(migrations = false)]
    async fn two_wants_of_one_album_at_once_make_one_edition(db: PgPool) {
        let st = state(&db, fake()).await;
        let (one, two) = ([mbid(LIVE)], [mbid(BONUS)]);
        let (a, b) = tokio::join!(want_many(&st, 1, &one, true), want_many(&st, 1, &two, true),);
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(
            editions(&db)
                .await
                .iter()
                .map(|e| e.0.as_str())
                .collect::<Vec<_>>(),
            [STD, PLUS]
        );
        assert_eq!(editions(&db).await[1].2, 2);
    }

    /// POSTs `body` to `uri` as an admin and returns the `media.acquisition.requested` reasons it emitted.
    async fn add(db: &PgPool, drop_album: bool, uri: &str, body: serde_json::Value) -> Vec<String> {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let st = state(db, fake()).await;
        sqlx::query(r#"INSERT INTO wants ("mediaId", family) VALUES (1, 'audio')"#)
            .execute(db)
            .await
            .unwrap();
        if drop_album {
            sqlx::query("DELETE FROM media WHERE id = 1")
                .execute(db)
                .await
                .unwrap();
        }
        sqlx::query(r#"INSERT INTO users (id, username, "isAdmin") VALUES (1, 'admin', true)"#)
            .execute(db)
            .await
            .unwrap();
        let tok = crate::auth::testing::token(&st, 1, "admin").await;
        let mut rx = st.hub.subscribe();
        let app = crate::media::write::routes(axum::Router::new())
            .merge(crate::music::router())
            .with_state(st);
        let req = Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .header("x-fliks-kinds", "album")
            .header("authorization", format!("Bearer {tok}"))
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status().as_u16(), 201);
        let mut reasons = vec![];
        while let Ok(b) = rx.try_recv() {
            if let crate::events::Bus::Domain(
                crate::events::DomainEvent::MediaAcquisitionRequested { reason, .. },
            ) = &*b
            {
                reasons.push(reason.clone());
            }
        }
        reasons
    }

    #[sqlx::test(migrations = false)]
    async fn wanting_a_track_of_a_held_album_asks_one_search(db: PgPool) {
        let body = json!({"provider": "musicbrainz", "externalId": LIVE, "albumExternalId": GROUP});
        assert_eq!(
            add(&db, false, "/api/music/want-recording", body).await,
            ["media-added"]
        );
    }

    #[sqlx::test(migrations = false)]
    async fn wanting_a_track_of_a_new_album_asks_one_search(db: PgPool) {
        let body = json!({"provider": "musicbrainz", "externalId": LIVE, "albumExternalId": GROUP,
                          "libraryId": 1});
        assert_eq!(
            add(&db, true, "/api/music/want-recording", body).await,
            ["media-added"]
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_album_import_asks_one_search(db: PgPool) {
        let body = json!({"type": "album", "provider": "musicbrainz", "externalId": GROUP,
                          "libraryId": 1});
        assert_eq!(
            add(&db, true, "/api/media/import", body).await,
            ["media-added"]
        );
    }
}

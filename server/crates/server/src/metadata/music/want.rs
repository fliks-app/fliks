//! Wanting tracks of an album by their recording (`docs/spec/music.md` rule 73), shared by
//! `POST /api/music/want-recording`, the import lists' `music-want-recording`, the requests and
//! `monitoredRecordings`.
use super::Fetched;
use crate::{http::AppError, metadata::MetaError, state::AppState};
use axum::http::StatusCode;
use fliks_domain::{
    external_id::{ExternalProvider, Namespace},
    metadata::{language::Resolved, limiter::Priority},
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
    /// The release does not hold these recordings.
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
    pub fn parts(self) -> (Namespace, &'a str) {
        match self {
            Self::Isrc(v) => (Namespace::Core(ExternalProvider::Isrc), v),
            Self::Mbid(v) => (Namespace::MUSICBRAINZ, v),
        }
    }
}

/// Where `item_of` looks: one album, or the albums of some libraries; both none is every album.
#[derive(Clone, Copy, Default)]
pub struct Scope<'a> {
    pub media: Option<i32>,
    pub libraries: Option<&'a [i32]>,
}

/// The track a recording names, as `(media, item)`: one with a part of its own first, then a monitored album's;
/// `owned` keeps only the tracks that have a file (their own or a shared one).
pub async fn item_of(
    db: &PgPool,
    scope: Scope<'_>,
    recording: Recording<'_>,
    owned: bool,
) -> sqlx::Result<Option<(i32, i32)>> {
    let (column, value) = match recording {
        Recording::Isrc(v) => ("isrc", v),
        Recording::Mbid(v) => ("\"recordingMbid\"::text", v),
    };
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT td."mediaId", td."itemId" FROM track_details td JOIN media m ON m.id = td."mediaId"
            WHERE td.{column} = $1 AND ($2::int IS NULL OR td."mediaId" = $2)
              AND ($3::int[] IS NULL OR m."libraryId" = ANY($3))
              AND (NOT $4 OR track_file(td."itemId") IS NOT NULL)
            ORDER BY EXISTS (SELECT 1 FROM item_parts ip WHERE ip."itemId" = td."itemId") DESC,
                     m.monitored DESC, td."itemId" LIMIT 1"#
    )))
    .bind(value)
    .bind(scope.media)
    .bind(scope.libraries)
    .bind(owned)
    .fetch_optional(db)
    .await
}

/// Makes `items` wanted and their album monitored. An album this call created (`fresh`) keeps only those
/// tracks monitored; one the library already had keeps its other tracks as they are.
pub async fn monitor(db: &PgPool, media: i32, items: &[i32], fresh: bool) -> sqlx::Result<()> {
    let mut tx = db.begin().await?;
    if fresh {
        sqlx::query(r#"UPDATE items SET monitored = false WHERE "mediaId" = $1 AND id <> ALL($2)"#)
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

/// Monitors every track of the albums `media` in one statement (a whole album is wanted).
pub async fn monitor_all(db: impl sqlx::PgExecutor<'_>, media: &[i32]) -> sqlx::Result<()> {
    sqlx::query(
        r#"UPDATE items i SET monitored = true FROM track_details td
            WHERE td."itemId" = i.id AND i."mediaId" = ANY($1) AND NOT i.monitored"#,
    )
    .bind(media)
    .execute(db)
    .await
    .map(drop)
}

/// The releases of `group` that hold `recording`: what the provider says, kept to the group's releases.
pub async fn holders(
    st: &AppState,
    group: &Fetched,
    recording: Recording<'_>,
    lang: &Resolved,
    prio: Priority,
) -> Result<Vec<String>, Refused> {
    let (source, id) = recording.parts();
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
        .filter(|x| group.releases.iter().any(|r| &r.external_id == x))
        .collect();
    if here.is_empty() {
        return Err(Refused::NotOnAlbum(vec![id.to_owned()]));
    }
    Ok(here)
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

/// Wants the tracks of `recordings` on the album `media`, all or none (`music.md` rule 73): a recording the
/// album does not hold is refused. An album this call created (`!existed`) keeps only those tracks monitored.
pub async fn want_many(
    st: &AppState,
    media: i32,
    recordings: &[Recording<'_>],
    existed: bool,
) -> Result<Vec<i32>, Refused> {
    let scope = Scope {
        media: Some(media),
        libraries: None,
    };
    let (mut items, mut lost) = (vec![], vec![]);
    for r in recordings {
        match item_of(&st.db, scope, *r, false).await? {
            Some((_, item)) => items.push(item),
            None => lost.push(r.parts().1.to_owned()),
        }
    }
    if !lost.is_empty() {
        return Err(Refused::NotOnAlbum(lost));
    }
    monitor(&st.db, media, &items, !existed).await?;
    Ok(items)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::metadata::music::tests::{GROUP, MusicFake};
    use crate::sync::MutexExt;
    use fliks_domain::metadata::limiter::Priority;
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
        f.works.lock_clean().insert(
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
            f.editions.lock_clean().insert(
                id.into(),
                json!({"externalId": id, "releaseGroupId": GROUP, "title": "Alpha", "country": "GB",
                       "status": "official", "media": "cd", "trackCount": n, "releaseDate": date,
                       "tracks": list}),
            );
        }
        f.children.lock_clean().insert(GROUP.into(), children);
        let mut h = f.holders.lock_clean();
        h.insert(LIVE.into(), vec![PLUS.into(), DELUXE.into()]);
        h.insert(BONUS.into(), vec![PLUS.into(), DELUXE.into()]);
        h.insert(EXTRA.into(), vec![DELUXE.into()]);
        h.insert(ONLY_ALT.into(), vec![ALT.into()]);
        drop(h);
        f
    }

    /// A library, an admin and the fake provider; no album.
    pub(crate) async fn state(db: &PgPool, f: Arc<MusicFake>) -> AppState {
        crate::db::migrate(db).await.unwrap();
        sqlx::raw_sql(
            r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'M', '["album"]');
               INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
               INSERT INTO users (id, username, "isAdmin") VALUES (1, 'admin', true)"#,
        )
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

    /// POSTs `body` to `uri` as the admin; the status, the body and the `media.acquisition.requested` reasons.
    pub(crate) async fn post(
        st: &AppState,
        uri: &str,
        body: serde_json::Value,
    ) -> (u16, serde_json::Value, Vec<String>) {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let tok = crate::auth::testing::token(st, 1, "admin").await;
        let mut rx = st.hub.subscribe();
        let app = crate::media::routes(axum::Router::new())
            .merge(crate::music::router())
            .with_state(st.clone());
        let req = Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .header("x-fliks-kinds", "album")
            .header("authorization", format!("Bearer {tok}"))
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let mut reasons = vec![];
        while let Ok(b) = rx.try_recv() {
            if let crate::events::Bus::Domain(
                crate::events::DomainEvent::MediaAcquisitionRequested { reason, .. },
            ) = &*b
            {
                reasons.push(reason.clone());
            }
        }
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
            reasons,
        )
    }

    /// Imports `id` (a release or a group) into library 1 and answers the album's id.
    pub(crate) async fn import(st: &AppState, id: &str) -> i32 {
        let (status, body, _) = post(
            st,
            "/api/media/import",
            json!({"type": "album", "provider": "musicbrainz", "externalId": id, "libraryId": 1}),
        )
        .await;
        assert_eq!(status, 201, "{body}");
        body["id"].as_i64().unwrap() as i32
    }

    fn mbid(id: &str) -> Recording<'_> {
        Recording::Mbid(id)
    }

    /// The release of an album, its group and its tracks `(title, monitored)` in order.
    async fn album(db: &PgPool, media: i32) -> (String, Option<String>, Vec<(String, bool)>) {
        let release: String = sqlx::query_scalar(
            r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = 'musicbrainz'"#,
        )
        .bind(media)
        .fetch_one(db)
        .await
        .unwrap();
        let group: Option<String> = sqlx::query_scalar(
            r#"SELECT "releaseGroupMbid"::text FROM album_details WHERE "mediaId" = $1"#,
        )
        .bind(media)
        .fetch_one(db)
        .await
        .unwrap();
        let tracks = sqlx::query_as(
            r#"SELECT i.title, i.monitored FROM items i JOIN track_details td ON td."itemId" = i.id
                WHERE i."mediaId" = $1 ORDER BY td.position"#,
        )
        .bind(media)
        .fetch_all(db)
        .await
        .unwrap();
        (release, group, tracks)
    }

    fn asked(f: &MusicFake) -> usize {
        f.calls()
            .iter()
            .filter(|c| c.starts_with("recording_releases"))
            .count()
    }

    #[sqlx::test(migrations = false)]
    async fn a_group_creates_the_release_it_picks_with_its_tracks(db: PgPool) {
        let st = state(&db, fake()).await;
        let media = import(&st, GROUP).await;
        let (release, group, tracks) = album(&db, media).await;
        assert_eq!((release.as_str(), group.as_deref()), (STD, Some(GROUP)));
        assert_eq!(tracks.len(), 3);
        assert!(tracks.iter().all(|t| t.1), "wanted as a whole");
        let editions: i64 =
            sqlx::query_scalar(r#"SELECT count(*) FROM editions WHERE "mediaId" = $1"#)
                .bind(media)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(editions, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn a_release_id_creates_that_release_and_its_group_comes_from_the_release(db: PgPool) {
        let st = state(&db, fake()).await;
        let media = import(&st, PLUS).await;
        let (release, group, tracks) = album(&db, media).await;
        assert_eq!((release.as_str(), group.as_deref()), (PLUS, Some(GROUP)));
        assert_eq!(tracks.len(), 4);
    }

    #[sqlx::test(migrations = false)]
    async fn a_group_whose_picked_release_cannot_be_read_creates_nothing(db: PgPool) {
        let f = fake();
        f.editions.lock_clean().remove(STD);
        let st = state(&db, f).await;
        let (status, _, _) = post(
            &st,
            "/api/media/import",
            json!({"type": "album", "provider": "musicbrainz", "externalId": GROUP, "libraryId": 1}),
        )
        .await;
        assert_ne!(status, 201);
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[sqlx::test(migrations = false)]
    async fn the_same_release_or_the_same_recordings_of_its_group_are_one_album(db: PgPool) {
        let st = state(&db, fake()).await;
        import(&st, STD).await;
        for id in [STD, STD_B, GROUP] {
            let (status, _, _) = post(
                &st,
                "/api/media/import",
                json!({"type": "album", "provider": "musicbrainz", "externalId": id, "libraryId": 1}),
            )
            .await;
            assert_eq!(status, 409, "{id}");
        }
        import(&st, PLUS).await;
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 2, "a release with other recordings is another album");
    }

    #[sqlx::test(migrations = false)]
    async fn a_recording_only_a_bonus_release_holds_is_wanted_on_a_new_album_of_that_release(
        db: PgPool,
    ) {
        let f = fake();
        let st = state(&db, f.clone()).await;
        let (status, body, reasons) = post(
            &st,
            "/api/music/want-recording",
            json!({"provider": "musicbrainz", "externalId": LIVE, "albumExternalId": GROUP}),
        )
        .await;
        assert_eq!(status, 201, "{body}");
        assert_eq!(reasons, ["media-added"], "one search");
        let media = body["mediaId"].as_i64().unwrap() as i32;
        let (release, _, tracks) = album(&db, media).await;
        assert_eq!(release, PLUS, "the 4-track holder beats the 6-track one");
        assert_eq!(
            tracks,
            [
                ("One".into(), false),
                ("Two".into(), false),
                ("Song".into(), true),
                ("Extra".into(), false)
            ]
        );
        let on: bool = sqlx::query_scalar("SELECT monitored FROM media WHERE id = $1")
            .bind(media)
            .fetch_one(&db)
            .await
            .unwrap();
        assert!(on);
        assert_eq!(asked(&f), 1);
    }

    #[sqlx::test(migrations = false)]
    async fn a_recording_an_album_of_the_library_holds_is_wanted_there_without_a_provider_call(
        db: PgPool,
    ) {
        let f = fake();
        let st = state(&db, f.clone()).await;
        let media = import(&st, STD).await;
        sqlx::query("UPDATE items SET monitored = false")
            .execute(&db)
            .await
            .unwrap();
        let (status, body, reasons) = post(
            &st,
            "/api/music/want-recording",
            json!({"provider": "musicbrainz", "externalId": STUDIO, "albumExternalId": GROUP}),
        )
        .await;
        assert_eq!(status, 201, "{body}");
        assert_eq!(reasons, ["media-added"]);
        assert_eq!(body["mediaId"].as_i64().unwrap() as i32, media);
        assert_eq!(asked(&f), 0);
        let wanted: Vec<String> =
            sqlx::query_scalar("SELECT title FROM items WHERE monitored ORDER BY id")
                .fetch_all(&db)
                .await
                .unwrap();
        assert_eq!(wanted, ["Song"]);
    }

    #[sqlx::test(migrations = false)]
    async fn a_recording_on_no_release_wants_nothing_and_creates_nothing(db: PgPool) {
        let st = state(&db, fake()).await;
        let (status, _, _) = post(
            &st,
            "/api/music/want-recording",
            json!({"provider": "musicbrainz", "externalId": NOWHERE, "albumExternalId": GROUP}),
        )
        .await;
        assert_eq!(status, 404);
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[sqlx::test(migrations = false)]
    async fn a_named_release_that_lacks_the_recording_is_undone(db: PgPool) {
        let st = state(&db, fake()).await;
        let (status, _, _) = post(
            &st,
            "/api/music/want-recording",
            json!({"provider": "musicbrainz", "externalId": LIVE, "albumExternalId": STD}),
        )
        .await;
        assert_eq!(status, 404);
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }

    #[sqlx::test(migrations = false)]
    async fn monitoredrecordings_keep_only_those_tracks_of_the_release(db: PgPool) {
        let st = state(&db, fake()).await;
        let (status, body, _) = post(
            &st,
            "/api/media/import",
            json!({"type": "album", "provider": "musicbrainz", "externalId": PLUS, "libraryId": 1,
                   "monitoredRecordings": [BONUS]}),
        )
        .await;
        assert_eq!(status, 201, "{body}");
        let media = body["id"].as_i64().unwrap() as i32;
        let (_, _, tracks) = album(&db, media).await;
        assert_eq!(
            tracks
                .iter()
                .filter(|t| t.1)
                .map(|t| t.0.as_str())
                .collect::<Vec<_>>(),
            ["Extra"]
        );
        let (status, _, _) = post(
            &st,
            "/api/media/import",
            json!({"type": "album", "provider": "musicbrainz", "externalId": ALT, "libraryId": 1,
                   "monitoredRecordings": [BONUS]}),
        )
        .await;
        assert_eq!(status, 404, "the release does not hold it");
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn want_many_is_all_or_nothing(db: PgPool) {
        let st = state(&db, fake()).await;
        let media = import(&st, STD).await;
        sqlx::query("UPDATE items SET monitored = false")
            .execute(&db)
            .await
            .unwrap();
        let Err(Refused::NotOnAlbum(ids)) =
            want_many(&st, media, &[mbid(S1), mbid(NOWHERE)], true).await
        else {
            panic!("refused")
        };
        assert_eq!(ids, [NOWHERE]);
        let wanted: i64 = sqlx::query_scalar("SELECT count(*) FROM items WHERE monitored")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(wanted, 0);
        let items = want_many(&st, media, &[mbid(S1), mbid(STUDIO)], true)
            .await
            .unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(Refused::NotOnAlbum(ids).app_error().status().as_u16(), 404);
    }

    #[sqlx::test(migrations = false)]
    async fn the_picker_shows_the_release_a_group_or_a_release_would_be(db: PgPool) {
        let st = state(&db, fake()).await;
        let len = async |id: &str| {
            crate::metadata::music::tracklist(&st, id, 1, Priority::Interactive)
                .await
                .unwrap()
                .len()
        };
        assert_eq!(len(GROUP).await, 3);
        assert_eq!(len(DELUXE).await, 6);
    }

    #[sqlx::test(migrations = false)]
    async fn a_file_of_one_album_satisfies_the_same_recordings_of_another_and_deleting_it_reopens_them(
        db: PgPool,
    ) {
        let st = state(&db, fake()).await;
        let std = import(&st, STD).await;
        let plus = import(&st, PLUS).await;
        let open = |media: i32| {
            let db = db.clone();
            async move { !crate::media::wants::list(&db, media).await.unwrap()[0].satisfied }
        };
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
                 SELECT i.id, i."mediaId", 1, i.id || '.flac', 1, 'flac' FROM items i WHERE i."mediaId" = {std};
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
                 SELECT i.id, i.id, i."mediaId", 0, 0 FROM items i WHERE i."mediaId" = {std}"#
        )))
        .execute(&db)
        .await
        .unwrap();
        assert!(!open(std).await);
        assert!(
            open(plus).await,
            "the live take and the bonus track have no file"
        );
        let shared: Vec<(String, bool)> = sqlx::query_as(
            r#"SELECT i.title, track_file(i.id) IS NOT NULL FROM items i
                WHERE i."mediaId" = $1 ORDER BY i.id"#,
        )
        .bind(plus)
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(
            shared,
            [
                ("One".into(), true),
                ("Two".into(), true),
                ("Song".into(), false),
                ("Extra".into(), false)
            ]
        );
        sqlx::query("UPDATE items SET monitored = false WHERE \"mediaId\" = $1 AND title IN ('Song', 'Extra')")
            .bind(plus)
            .execute(&db)
            .await
            .unwrap();
        assert!(
            !open(plus).await,
            "wanted tracks are all satisfied through the other album"
        );
        sqlx::query("DELETE FROM media WHERE id = $1")
            .bind(std)
            .execute(&db)
            .await
            .unwrap();
        assert!(open(plus).await, "deleting the owner reopens the want");
    }

    #[sqlx::test(migrations = false)]
    async fn the_isrc_matches_only_when_a_side_has_no_recording(db: PgPool) {
        let st = state(&db, fake()).await;
        let (a, b) = (import(&st, STD).await, import(&st, ALT).await);
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
                 VALUES (1, {a}, 1, 'a.flac', 1, 'flac');
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
                 SELECT i.id, 1, i."mediaId", 0, 0 FROM items i WHERE i.title = 'One' AND i."mediaId" = {a};
               UPDATE track_details SET isrc = 'FRABC2400001' WHERE "itemId" IN (SELECT id FROM items WHERE title = 'One');
               UPDATE track_details SET "recordingMbid" = NULL
                 WHERE "mediaId" = {b} AND "itemId" IN (SELECT id FROM items WHERE title = 'One')"#
        )))
        .execute(&db)
        .await
        .unwrap();
        let plays: Option<i32> = sqlx::query_scalar(
            r#"SELECT track_file(i.id) FROM items i WHERE i."mediaId" = $1 AND i.title = 'One'"#,
        )
        .bind(b)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(
            plays,
            Some(1),
            "no recording on this side: the ISRC decides"
        );
        sqlx::query(r#"UPDATE track_details SET "recordingMbid" = $1::uuid WHERE "mediaId" = $2"#)
            .bind("b0000000-0000-4000-8000-0000000000ff")
            .bind(b)
            .execute(&db)
            .await
            .unwrap();
        let plays: Option<i32> = sqlx::query_scalar(
            r#"SELECT track_file(i.id) FROM items i WHERE i."mediaId" = $1 AND i.title = 'One'"#,
        )
        .bind(b)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(plays, None, "two different recordings never share a file");
    }
}

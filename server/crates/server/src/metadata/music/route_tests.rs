//! The album preview and the artist's popular list against a fake music provider (`docs/spec/music.md`).
use super::tests::{ARTIST, GROUP, MusicFake, RELEASE};
use crate::{auth::testing as session, config::Config, state::AppState};
use axum::{Router, body::Body, http::Request};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

const OWNED: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";

async fn ctx(pool: &PgPool, fake: MusicFake) -> (Router, String) {
    crate::db::migrate(pool).await.unwrap();
    let st = AppState::new(
        pool.clone(),
        Config::from_lookup(|_| None),
        "0123456789abcdef0123456789abcdef",
    );
    st.metadata.add_plugin(Arc::new(fake));
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO users (id, username, "isAdmin") VALUES (1, 'admin', true);
           INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'M', '["album"]');
           INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
           INSERT INTO persons (id, name) VALUES (1, 'Ana');
           INSERT INTO person_external_ids ("personId", provider, value) VALUES (1, 'musicbrainz', '{ARTIST}');
           INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (10, 'Own', 'album', 1, 'a');
           INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES (10, 'album', 'musicbrainz', '{GROUP}');
           INSERT INTO editions (id, "mediaId", family) VALUES (1, 10, 'audio');
           INSERT INTO items (id, "mediaId", "editionId", title) VALUES (1, 10, 1, 'One');
           INSERT INTO track_details ("itemId", "mediaId", position, "recordingMbid") VALUES (1, 10, 1, '{OWNED}');
           INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo")
             VALUES (1, 10, 1, '1.flac', 1, 'FLAC', '{{}}');
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES (1, 1, 10, 0, 0)"#
    )))
    .execute(pool)
    .await
    .unwrap();
    let t = session::token(&st, 1, "admin").await;
    let app = crate::metadata::router()
        .merge(crate::persons::router())
        .with_state(st);
    (app, t)
}

async fn get(app: &Router, t: &str, uri: &str) -> (u16, Value) {
    let req = Request::builder()
        .uri(uri)
        .header("x-fliks-kinds", "album")
        .header("authorization", format!("Bearer {t}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn fake() -> MusicFake {
    let f = MusicFake::default();
    f.works.lock().unwrap().insert(
        GROUP.into(),
        json!({"externalId": GROUP, "title": "Alpha", "primaryType": "album", "year": 1999, "mediaType": "album",
               "artists": [{"name": "Ana", "id": ARTIST, "joinPhrase": " & "}]}),
    );
    f.children.lock().unwrap().insert(
        GROUP.into(),
        vec![json!({"externalId": RELEASE, "title": "Alpha", "country": "FR", "status": "official", "trackCount": 2})],
    );
    f.editions.lock().unwrap().insert(
        RELEASE.into(),
        json!({"externalId": RELEASE, "title": "Alpha", "country": "FR", "status": "official", "media": "cd",
               "trackCount": 2, "tracks": [
            {"title": "One", "discNumber": 1, "position": 1, "number": 1, "durationMs": 100000, "recordingId": OWNED},
            {"title": "Two", "discNumber": 1, "position": 2, "number": 2, "durationMs": 50000, "recordingId": OTHER}]}),
    );
    f
}

#[sqlx::test(migrations = false)]
async fn the_preview_lists_the_main_release_and_marks_an_owned_album(pool: PgPool) {
    let (app, t) = ctx(&pool, fake()).await;
    let (s, v) = get(
        &app,
        &t,
        &format!("/api/metadata/musicbrainz/album/{GROUP}"),
    )
    .await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        (
            v["title"].as_str(),
            v["trackCount"].as_i64(),
            v["durationMs"].as_i64()
        ),
        (Some("Alpha"), Some(2), Some(150_000))
    );
    assert_eq!(v["release"]["externalId"], RELEASE);
    assert_eq!(v["artists"][0]["externalId"], ARTIST);
    assert_eq!(v["tracks"][1]["recordingId"], OTHER);
    assert_eq!(v["existingMediaId"], 10);
    let (s, _) = get(&app, &t, "/api/metadata/tmdb/album/x").await;
    assert_eq!(s, 400);
    let missing = "33333333-3333-4333-8333-333333333333";
    let (s, _) = get(
        &app,
        &t,
        &format!("/api/metadata/musicbrainz/album/{missing}"),
    )
    .await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn popular_recordings_carry_the_owned_track(pool: PgPool) {
    let f = fake();
    *f.top.lock().unwrap() = vec![
        json!({"recordingId": OWNED, "title": "One", "listenCount": 9, "albumExternalId": GROUP}),
        json!({"recordingId": OTHER, "title": "Two", "listenCount": 5, "albumExternalId": GROUP}),
        json!({"recordingId": "nope", "title": "Bad"}),
    ];
    let (app, t) = ctx(&pool, f).await;
    let (s, v) = get(&app, &t, "/api/persons/1/discography").await;
    assert_eq!(s, 200, "{v}");
    let p = v["popular"].as_array().unwrap();
    assert_eq!(p.len(), 2);
    assert_eq!(p[0]["track"]["itemId"], 1);
    assert!(p[1]["track"].is_null());
    assert_eq!(p[1]["albumExternalId"], GROUP);
}

#[sqlx::test(migrations = false)]
async fn without_top_recordings_the_owned_tracks_by_popularity_stand_in(pool: PgPool) {
    let (app, t) = ctx(&pool, fake()).await;
    sqlx::raw_sql(
        r#"INSERT INTO media_credits ("mediaId", "personId", role, position) VALUES (10, 1, 'artist', 0);
           UPDATE track_details SET popularity = 3 WHERE "itemId" = 1"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let (_, v) = get(&app, &t, "/api/persons/1/discography").await;
    let p = v["popular"].as_array().unwrap();
    assert_eq!((p.len(), p[0]["title"].as_str()), (1, Some("One")));
    assert_eq!(p[0]["track"]["itemId"], 1);
}

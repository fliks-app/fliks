//! Track-scoped album requests (`docs/spec/requests.md` rule 52) through the real routers over a fake MusicBrainz.
use crate::auth::testing as session;
use crate::metadata::music::tests::{GROUP, MusicFake, RELEASE};
use crate::{config::Config, media, state::AppState};
use axum::{Router, body::Body, http::Request};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

const ONE: &str = "11111111-1111-4111-8111-111111111111";
const TWO: &str = "22222222-2222-4222-8222-222222222222";
const THREE: &str = "33333333-3333-4333-8333-333333333333";
const LOST: &str = "44444444-4444-4444-8444-444444444444";
const BONUS_RELEASE: &str = "55555555-5555-4555-8555-555555555555";

struct Ctx {
    app: Router,
    pool: PgPool,
    admin: String,
    user: String,
}

async fn ctx(pool: PgPool) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let st = AppState::new(
        pool.clone(),
        Config::from_lookup(|_| None),
        "0123456789abcdef0123456789abcdef",
    );
    let fake = MusicFake::default();
    fake.works.lock().unwrap().insert(
        GROUP.into(),
        json!({"externalId": GROUP, "title": "Alpha", "primaryType": "album", "year": 1999, "mediaType": "album",
               "artists": [{"name": "Ana", "id": crate::metadata::music::tests::ARTIST}]}),
    );
    fake.children.lock().unwrap().insert(
        GROUP.into(),
        vec![
            json!({"externalId": RELEASE, "title": "Alpha", "country": "FR", "status": "official", "trackCount": 2}),
            json!({"externalId": BONUS_RELEASE, "title": "Alpha", "country": "XW", "status": "official", "trackCount": 3}),
        ],
    );
    fake.editions.lock().unwrap().insert(
        BONUS_RELEASE.into(),
        json!({"externalId": BONUS_RELEASE, "releaseGroupId": GROUP, "title": "Alpha", "country": "XW",
               "status": "official", "media": "cd", "trackCount": 3, "tracks": [
            {"title": "One", "discNumber": 1, "position": 1, "number": 1, "durationMs": 100000, "recordingId": ONE},
            {"title": "Two", "discNumber": 1, "position": 2, "number": 2, "durationMs": 50000, "recordingId": TWO},
            {"title": "Three", "discNumber": 1, "position": 3, "number": 3, "durationMs": 70000, "recordingId": THREE}]}),
    );
    fake.holders
        .lock()
        .unwrap()
        .insert(THREE.into(), vec![BONUS_RELEASE.into()]);
    fake.editions.lock().unwrap().insert(
        RELEASE.into(),
        json!({"externalId": RELEASE, "releaseGroupId": GROUP, "title": "Alpha", "country": "FR",
               "status": "official", "media": "cd", "trackCount": 2, "tracks": [
            {"title": "One", "discNumber": 1, "position": 1, "number": 1, "durationMs": 100000, "recordingId": ONE},
            {"title": "Two", "discNumber": 1, "position": 2, "number": 2, "durationMs": 50000, "recordingId": TWO}]}),
    );
    st.metadata.add_plugin(Arc::new(fake));
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES
          (1, 'U', '["media.read","requests.create"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'user', false, 1);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Music', '["album"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m/one');
        INSERT INTO quality_profiles (id, name, family, cutoff, items) VALUES (1, 'Audio', 'audio', 1, '[]');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        admin: session::token(&st, 1, "admin").await,
        user: session::token(&st, 2, "user").await,
        app: media::router().merge(super::router()).with_state(st),
        pool,
    }
}

impl Ctx {
    async fn call(&self, tok: &str, method: &str, uri: &str, body: Value) -> (u16, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("x-fliks-kinds", "movie,series,book,comic,album")
            .header("authorization", format!("Bearer {tok}"))
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let b = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }

    async fn ask(&self, tok: &str, recordings: Option<Value>) -> (u16, Value) {
        self.ask_for(tok, GROUP, recordings).await
    }

    async fn ask_for(&self, tok: &str, id: &str, recordings: Option<Value>) -> (u16, Value) {
        let mut body = json!({"mediaType": "album", "externalId": id, "title": "Alpha",
                              "wants": [{"family": "audio", "qualityProfileId": 1}]});
        if let Some(r) = recordings {
            body["recordings"] = r;
        }
        self.call(tok, "POST", "/api/requests", body).await
    }

    /// The recordings of the tracks the album monitors.
    async fn monitored(&self) -> Vec<String> {
        sqlx::query_scalar(
            r#"SELECT td."recordingMbid"::text FROM items i JOIN track_details td ON td."itemId" = i.id
               WHERE i.monitored ORDER BY td.position"#,
        )
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }
}

#[sqlx::test(migrations = false)]
async fn recordings_are_validated(pool: PgPool) {
    let c = ctx(pool).await;
    for r in [json!([]), json!([ONE, ONE]), json!(["nope"]), json!("x")] {
        assert_eq!(c.ask(&c.user, Some(r.clone())).await.0, 400, "{r}");
    }
    let (s, _) = c
        .call(
            &c.user,
            "POST",
            "/api/requests",
            json!({"mediaType": "book", "externalId": "OL2W", "title": "t", "recordings": [ONE],
                   "wants": [{"family": "text"}]}),
        )
        .await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn a_track_request_is_scoped_guarded_and_wants_only_its_tracks(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, r) = c.ask(&c.user, Some(json!([ONE]))).await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(
        (&r["recordings"], &r["trackCount"]),
        (&json!([ONE]), &json!(2))
    );
    let (s, _) = c.ask(&c.user, Some(json!([ONE]))).await;
    assert_eq!(s, 409, "the same track twice");
    let state_uri = format!("/api/requests/title-state?mediaType=album&externalId={GROUP}");
    let (_, state) = c.call(&c.user, "GET", &state_uri, json!(null)).await;
    assert_eq!(
        (
            &state["requested"],
            &state["wholeAlbumRequested"],
            &state["requestedRecordings"]
        ),
        (&json!(false), &json!(false), &json!([ONE]))
    );
    let id = r["id"].as_i64().unwrap();
    let (s, _) = c
        .call(
            &c.admin,
            "POST",
            &format!("/api/requests/{id}/approve"),
            json!({}),
        )
        .await;
    assert_eq!(s, 201);
    assert_eq!(c.monitored().await, [ONE], "only the requested track");

    let (s, r) = c.ask(&c.user, Some(json!([TWO]))).await;
    assert_eq!(s, 201, "{r}");
    let two = r["id"].as_i64().unwrap();
    let (s, r) = c
        .call(
            &c.admin,
            "POST",
            &format!("/api/requests/{two}/approve"),
            json!({"wholeAlbum": true}),
        )
        .await;
    assert_eq!((s, &r["recordings"]), (201, &Value::Null), "{r}");
    assert_eq!(c.monitored().await, [ONE, TWO], "the whole album");
    let (s, _) = c.ask(&c.user, Some(json!([ONE]))).await;
    assert_eq!(s, 409, "a track already wanted");
}

#[sqlx::test(migrations = false)]
async fn a_whole_album_blocks_its_tracks_and_a_track_does_not_block_the_album(pool: PgPool) {
    let c = ctx(pool).await;
    assert_eq!(c.ask(&c.user, Some(json!([ONE]))).await.0, 201);
    let (s, r) = c.ask(&c.admin, None).await;
    assert_eq!(s, 201, "{r}");
    let (s, r) = c.ask(&c.user, Some(json!([TWO]))).await;
    assert_eq!(
        (s, r["message"].as_str()),
        (409, Some("The whole album has already been requested"))
    );
    let (_, state) = c
        .call(
            &c.user,
            "GET",
            &format!("/api/requests/title-state?mediaType=album&externalId={GROUP}"),
            json!(null),
        )
        .await;
    assert_eq!(state["wholeAlbumRequested"], json!(true));
}

#[sqlx::test(migrations = false)]
async fn a_pending_album_request_of_the_caller_grows_instead_of_a_second_row(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, first) = c.ask(&c.user, Some(json!([ONE]))).await;
    assert_eq!(s, 201, "{first}");
    let (s, r) = c.ask(&c.user, Some(json!([TWO]))).await;
    assert_eq!(
        (s, &r["id"], &r["recordings"]),
        (201, &first["id"], &json!([ONE, TWO])),
        "{r}"
    );
    let (s, r) = c.ask(&c.user, None).await;
    assert_eq!(
        (s, &r["id"], &r["recordings"]),
        (201, &first["id"], &Value::Null),
        "{r}"
    );
    let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM requests")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(rows, 1);
}

#[sqlx::test(migrations = false)]
async fn growing_a_pending_request_does_not_count_against_the_quota(pool: PgPool) {
    let c = ctx(pool).await;
    sqlx::query(r#"INSERT INTO user_quotas ("userId", kind, "limit") VALUES (2, 'album', 1)"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, first) = c.ask(&c.user, Some(json!([ONE]))).await;
    assert_eq!(s, 201, "{first}");
    let (s, r) = c.ask(&c.user, Some(json!([TWO]))).await;
    assert_eq!((s, &r["id"]), (201, &first["id"]), "{r}");
    let (s, _) = c
        .ask_for(&c.user, BONUS_RELEASE, Some(json!([THREE])))
        .await;
    assert_eq!(s, 403, "a second title is a new request");
}

async fn approve(c: &Ctx, id: i64) -> (u16, Value) {
    let uri = format!("/api/requests/{id}/approve");
    c.call(&c.admin, "POST", &uri, json!({})).await
}

#[sqlx::test(migrations = false)]
async fn a_recording_the_release_lacks_refuses_the_whole_approval(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, r) = c.ask(&c.user, Some(json!([ONE, THREE]))).await;
    let (s, r) = approve(&c, r["id"].as_i64().unwrap()).await;
    assert_eq!(s, 404, "{r}");
    assert!(c.monitored().await.is_empty(), "all or nothing");
}

#[sqlx::test(migrations = false)]
async fn a_track_request_names_the_release_that_holds_the_track(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, r) = c
        .ask_for(&c.user, BONUS_RELEASE, Some(json!([THREE])))
        .await;
    assert_eq!((s, &r["trackCount"]), (201, &json!(3)), "{r}");
    let (s, r) = approve(&c, r["id"].as_i64().unwrap()).await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(c.monitored().await, [THREE]);
    let release: String = sqlx::query_scalar(
        r#"SELECT value FROM media_external_ids WHERE kind = 'album' AND provider = 'musicbrainz'"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(release, BONUS_RELEASE);
}

#[sqlx::test(migrations = false)]
async fn an_import_monitors_its_recordings_or_is_undone(pool: PgPool) {
    let c = ctx(pool).await;
    let body = |r: &str| {
        json!({"type": "album", "provider": "musicbrainz", "externalId": GROUP, "libraryId": 1,
               "monitoredRecordings": [r]})
    };
    let (s, r) = c
        .call(&c.admin, "POST", "/api/media/import", body(LOST))
        .await;
    assert_eq!(s, 404, "{r}");
    let albums: i64 = sqlx::query_scalar("SELECT count(*) FROM media WHERE type = 'album'")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(albums, 0, "the album is not created");
    let (s, r) = c
        .call(&c.admin, "POST", "/api/media/import", body(TWO))
        .await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(c.monitored().await, [TWO]);
}

async fn hold_album(c: &Ctx) {
    let body = json!({"type": "album", "provider": "musicbrainz", "externalId": GROUP, "libraryId": 1,
                      "monitoredRecordings": [ONE]});
    let (s, r) = c.call(&c.admin, "POST", "/api/media/import", body).await;
    assert_eq!(s, 201, "{r}");
}

async fn albums(c: &Ctx) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM media WHERE type = 'album'")
        .fetch_one(&c.pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = false)]
async fn a_refused_approval_deletes_only_the_album_it_created(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, r) = c.ask(&c.user, Some(json!([ONE, THREE]))).await;
    let (s, _) = approve(&c, r["id"].as_i64().unwrap()).await;
    assert_eq!(s, 404);
    assert_eq!(albums(&c).await, 0);
    hold_album(&c).await;
    let (_, r) = c.ask(&c.user, Some(json!([TWO]))).await;
    sqlx::query(
        r#"DELETE FROM items WHERE id IN (SELECT "itemId" FROM track_details WHERE "recordingMbid" = $1::uuid)"#,
    )
    .bind(TWO)
    .execute(&c.pool)
    .await
    .unwrap();
    let (s, _) = approve(&c, r["id"].as_i64().unwrap()).await;
    assert_eq!(s, 404);
    assert_eq!(albums(&c).await, 1, "the album the library held stays");
}

#[sqlx::test(migrations = false)]
async fn a_group_request_and_a_release_request_clash_in_both_orders(pool: PgPool) {
    let c = ctx(pool).await;
    hold_album(&c).await;
    let (s, r) = c.ask_for(&c.user, RELEASE, Some(json!([TWO]))).await;
    assert_eq!(s, 201, "{r}");
    let (s, r) = c.ask_for(&c.user, GROUP, Some(json!([TWO]))).await;
    assert_eq!(s, 409, "{r}");
    sqlx::query("DELETE FROM requests")
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, r) = c.ask_for(&c.user, GROUP, Some(json!([TWO]))).await;
    assert_eq!(s, 201, "{r}");
    let (s, r) = c.ask_for(&c.user, RELEASE, Some(json!([TWO]))).await;
    assert_eq!(s, 409, "{r}");
}

#[sqlx::test(migrations = false)]
async fn a_fileless_album_identified_by_its_group_links_the_target_release(pool: PgPool) {
    let c = ctx(pool).await;
    sqlx::query(
        r#"INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (7, 'Alpha', 'album', 1, 'a')"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let body = json!({"provider": "musicbrainz", "externalId": GROUP});
    let (s, r) = c
        .call(&c.admin, "POST", "/api/media/7/identify", body)
        .await;
    assert_eq!(s, 201, "{r}");
    let mut held: Vec<String> = vec![];
    for _ in 0..50 {
        held = sqlx::query_scalar(
            r#"SELECT value FROM media_external_ids WHERE "mediaId" = 7 AND provider = 'musicbrainz'"#,
        )
        .fetch_all(&c.pool)
        .await
        .unwrap();
        if !held.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(held, [RELEASE]);
}

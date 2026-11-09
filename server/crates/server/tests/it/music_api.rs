//! The music reads (`music.md` rules 44-49): list info, detail, tracks, favourites, playlists.
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

async fn ctx(pool: &PgPool) -> (Router, String) {
    fliks_server::db::migrate(pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'L1', '["album"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
        INSERT INTO media (id, title, year, type, "libraryId", "folderName") VALUES (10, 'Alpha', 1973, 'album', 1, 'a');
        INSERT INTO album_details ("mediaId", "primaryType", "secondaryTypes") VALUES (10, 'album', '{live}');
        INSERT INTO persons (id, name, "sortName") VALUES (1, 'Ana', 'Ana'), (2, 'Wolf', 'Wolf');
        INSERT INTO media_credits ("mediaId", "personId", role, position) VALUES (10, 1, 'artist', 0);
        INSERT INTO editions (id, "mediaId", family, "trackCount", "discCount") VALUES (1, 10, 'audio', 2, 1);
        INSERT INTO items (id, "mediaId", "editionId", title) VALUES (1, 10, 1, 'One'), (2, 10, 1, 'Two');
        INSERT INTO track_details ("itemId", "mediaId", "discNumber", position, "durationMs") VALUES
          (1, 10, 1, 1, 200000), (2, 10, 1, 2, 100000);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, '1.flac', 1, 'FLAC', '{}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES (1, 1, 10, 0, 0);
        INSERT INTO works (id, title, "composerPersonId") VALUES (1, 'Sonata', 2), (2, 'Allegro', 2);
        UPDATE works SET "parentWorkId" = 1 WHERE id = 2;
        INSERT INTO item_works ("itemId", "workId") VALUES (1, 2);
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
    let t = session::token(&st, 1, "admin").await;
    let app = fliks_server::media::router()
        .merge(fliks_server::social::router())
        .merge(fliks_server::playlists::router())
        .merge(fliks_server::persons::router())
        .merge(fliks_server::music::router())
        .with_state(st);
    (app, t)
}

async fn call(app: &Router, t: &str, method: &str, uri: &str, body: Option<Value>) -> (u16, Value) {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-fliks-kinds", "movie,series,book,comic,album")
        .header("authorization", format!("Bearer {t}"));
    let body = match body {
        Some(v) => {
            b = b.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(b.body(body).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrations = false)]
async fn album_reads_tracks_favourites_and_works(pool: PgPool) {
    let (app, t) = ctx(&pool).await;
    let (_, list) = call(&app, &t, "GET", "/api/media?type=album", None).await;
    let info = &list["data"][0]["album"];
    assert_eq!(
        (&info["trackCount"], &info["durationSeconds"]),
        (&json!(1), &json!(200))
    );
    assert_eq!(info["artists"][0]["name"], "Ana");

    let (_, d) = call(&app, &t, "GET", "/api/media/10", None).await;
    let tracks = d["album"]["tracks"].as_array().unwrap();
    assert_eq!(
        (
            tracks.len(),
            &tracks[0]["mediaFileId"],
            &tracks[1]["hasFile"]
        ),
        (2, &json!(1), &json!(false))
    );
    assert_eq!(tracks[0]["artists"][0]["name"], "Ana");
    assert_eq!(tracks[0]["works"][0]["composerName"], "Wolf");

    assert_eq!(
        call(
            &app,
            &t,
            "PUT",
            "/api/items/1/rating",
            Some(json!({"rating": 4}))
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(&app, &t, "GET", "/api/tracks?sortBy=rating", None)
            .await
            .0,
        400
    );
    assert_eq!(
        call(
            &app,
            &t,
            "POST",
            "/api/likes",
            Some(json!({"mediaId": 10, "episodeId": 1}))
        )
        .await
        .0,
        201
    );
    let (_, rows) = call(&app, &t, "GET", "/api/tracks?favourite=true", None).await;
    assert_eq!(
        (
            rows.as_array().unwrap().len(),
            rows[0].get("rating"),
            &rows[0]["albumTitle"]
        ),
        (1, None, &json!("Alpha"))
    );

    let (_, cw) = call(&app, &t, "GET", "/api/composers/2/works", None).await;
    assert_eq!(
        (
            &cw[0]["title"],
            &cw[0]["recordingCount"],
            &cw[0]["children"][0]["title"]
        ),
        (&json!("Sonata"), &json!(1), &json!("Allegro"))
    );
    let (_, rec) = call(&app, &t, "GET", "/api/works/1/recordings", None).await;
    assert_eq!(
        (&rec[0]["itemId"], &rec[0]["mediaFileId"]),
        (&json!(1), &json!(1))
    );

    let (_, people) = call(&app, &t, "GET", "/api/persons?role=artist", None).await;
    assert_eq!(
        (
            &people[0]["name"],
            &people[0]["albumCount"],
            &people[0]["trackCount"]
        ),
        (&json!("Ana"), &json!(1), &json!(1))
    );

    let (_, pl) = call(
        &app,
        &t,
        "POST",
        "/api/playlists",
        Some(json!({"name": "P"})),
    )
    .await;
    let id = pl["id"].as_i64().unwrap();
    assert_eq!(
        call(
            &app,
            &t,
            "POST",
            &format!("/api/playlists/{id}/items"),
            Some(json!({"itemId": 1}))
        )
        .await
        .0,
        201
    );
    let (_, items) = call(&app, &t, "GET", &format!("/api/playlists/{id}/items"), None).await;
    assert_eq!(
        (
            &items[0]["track"]["title"],
            &items[0]["track"]["albumTitle"]
        ),
        (&json!("One"), &json!("Alpha"))
    );

    let (_, disco) = call(&app, &t, "GET", "/api/persons/1/discography", None).await;
    assert_eq!(
        (
            &disco["albums"][0]["owned"],
            &disco["albums"][0]["ownedTrackCount"]
        ),
        (&json!(true), &json!(1))
    );
}

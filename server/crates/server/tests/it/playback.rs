//! `/api/playback/*` validation, watched toggles and the in-process top genres.
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, playback, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    pool: PgPool,
    token: String,
    user: i32,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO libraries (name) VALUES ('fixture');
           INSERT INTO library_folders ("libraryId", path) SELECT id, '/fixture' FROM libraries"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let cfg = Config::from_lookup(|_| None);
    let st = AppState::new(pool.clone(), cfg, SECRET);
    let user: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin") VALUES ('u', true) RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    Ctx {
        token: session::token(&st, user, "u").await,
        app: playback::router().with_state(st),
        pool,
        user,
    }
}

impl Ctx {
    async fn call(&self, method: &str, uri: &str, auth: &str, body: Option<Value>) -> (u16, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {auth}"))
            .header("content-type", "application/json")
            .body(Body::from(body.unwrap_or(json!({})).to_string()))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn api(&self, method: &str, uri: &str, body: Option<Value>) -> (u16, Value) {
        self.call(method, uri, &self.token, body).await
    }

    async fn id(&self, sql: &str) -> i32 {
        sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    /// The media's `video` edition and its ungrouped item.
    async fn shell(&self, media: i32) -> i32 {
        self.id(&format!(
            r#"WITH e AS (INSERT INTO editions ("mediaId", family) VALUES ({media}, 'video') RETURNING id)
               INSERT INTO items ("mediaId", "editionId") SELECT {media}, id FROM e RETURNING items.id"#
        ))
        .await
    }
}

#[sqlx::test(migrations = false)]
async fn history_rejects_fractional_paging(pool: PgPool) {
    let c = ctx(pool).await;
    for q in ["page=1.5", "limit=2.5"] {
        let (s, b) = c
            .api("GET", &format!("/api/playback/history?{q}"), None)
            .await;
        assert_eq!((s, b["error"].as_str()), (400, Some("Bad Request")), "{q}");
    }
    let (s, b) = c
        .api("GET", "/api/playback/history?page=abc&limit=0", None)
        .await;
    assert_eq!((s, b), (200, json!({"data": [], "total": 0})));
}

#[sqlx::test(migrations = false)]
async fn toggles_check_the_media_and_the_season(pool: PgPool) {
    let c = ctx(pool).await;
    let a = c
        .id(r#"INSERT INTO media (title, type, "libraryId") VALUES ('a', 'series', (SELECT min(id) FROM libraries)) RETURNING id"#)
        .await;
    let b = c
        .id(r#"INSERT INTO media (title, type, "libraryId") VALUES ('b', 'series', (SELECT min(id) FROM libraries)) RETURNING id"#)
        .await;
    let season = c
        .id(&format!(
            r#"INSERT INTO item_groups ("number", "mediaId") VALUES (1, {b}) RETURNING id"#
        ))
        .await;
    let toggle = |m: i32| format!("/api/playback/media/{m}/toggle-watched");
    assert_eq!(c.api("POST", &toggle(9999), None).await.0, 404);
    assert_eq!(
        c.api("POST", &toggle(a), None).await.0,
        404,
        "a series names no item"
    );
    let season_uri = |m: i32| format!("/api/playback/media/{m}/seasons/{season}/toggle-watched");
    let w = Some(json!({"watched": true}));
    assert_eq!(c.api("POST", &season_uri(a), w.clone()).await.0, 404);
    assert_eq!(c.api("POST", &season_uri(9999), w.clone()).await.0, 404);
    let (s, b) = c.api("POST", &season_uri(b), w).await;
    assert_eq!((s, b), (201, json!({"watched": true})));
}

#[sqlx::test(migrations = false)]
async fn toggle_watched_round_trip_and_state(pool: PgPool) {
    let c = ctx(pool).await;
    let m = c
        .id(r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', (SELECT min(id) FROM libraries)) RETURNING id"#)
        .await;
    let item = c.shell(m).await;
    let f = c
        .id(&format!(
            r#"WITH f AS (INSERT INTO media_files ("relativePath", size, quality, "mediaId", "streamInfo", "folderId")
                 VALUES ('x', 1, 'q', {m}, '{{"durationSeconds": 90.5}}', (SELECT min(id) FROM library_folders)) RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT {item}, id, {m}, 0 FROM f
               RETURNING "mediaFileId""#
        ))
        .await;
    let uri = format!("/api/playback/media/{m}/toggle-watched");
    let (s, row) = c.api("POST", &uri, None).await;
    assert_eq!(
        (s, row["completed"].clone(), row["durationSeconds"].clone()),
        (201, json!(true), json!(90.5))
    );
    assert_eq!(
        (
            row["mediaFileId"].clone(),
            row["user"].clone(),
            row["episode"].clone()
        ),
        (json!(f), json!({"id": c.user}), Value::Null)
    );
    let (_, row) = c.api("POST", &uri, None).await;
    assert_eq!(
        (row["completed"].clone(), row.get("user")),
        (json!(false), None)
    );
    let (s, got) = c
        .api("GET", &format!("/api/playback/media/{m}/state"), None)
        .await;
    assert_eq!(
        (s, got["completed"].clone(), got["userId"].clone()),
        (200, json!(false), json!(c.user))
    );
    assert_eq!(
        c.api("DELETE", &format!("/api/playback/media/{m}/state"), None)
            .await
            .0,
        200
    );
    let (s, got) = c
        .api("GET", &format!("/api/playback/media/{m}/state"), None)
        .await;
    assert_eq!((s, got), (200, Value::Null));
}

#[sqlx::test(migrations = false)]
async fn toggle_watched_without_a_file_keeps_duration_null(pool: PgPool) {
    let c = ctx(pool).await;
    let m = c
        .id(r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', (SELECT min(id) FROM libraries)) RETURNING id"#)
        .await;
    c.shell(m).await;
    let uri = format!("/api/playback/media/{m}/toggle-watched");
    for completed in [true, false] {
        let (s, row) = c.api("POST", &uri, None).await;
        assert_eq!(
            (s, row["completed"].clone(), row["durationSeconds"].clone()),
            (201, json!(completed), Value::Null)
        );
    }
}

#[sqlx::test(migrations = false)]
async fn recommendation_ties_break_by_media_id(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c
        .id(r#"INSERT INTO libraries (name) VALUES ('l') RETURNING id"#)
        .await;
    let watched = c
        .id(&format!(
            r#"INSERT INTO media (title, type, genres, "libraryId") VALUES ('w', 'movie', '["Drama"]', {lib}) RETURNING id"#
        ))
        .await;
    let item = c.shell(watched).await;
    sqlx::query(
        r#"INSERT INTO playback_states ("userId", "itemId", completed) VALUES ($1, $2, true)"#,
    )
    .bind(c.user)
    .bind(item)
    .execute(&c.pool)
    .await
    .unwrap();
    let mut ids = vec![];
    for t in ["x", "y", "z"] {
        ids.push(
            c.id(&format!(
                r#"INSERT INTO media (title, type, genres, "libraryId") VALUES ('{t}', 'movie', '["Drama"]', {lib}) RETURNING id"#
            ))
            .await,
        );
    }
    let (s, got) = c.api("GET", "/api/playback/recommendations", None).await;
    let got: Vec<i64> = got
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["media"]["id"].as_i64().unwrap())
        .collect();
    assert_eq!((s, got), (200, ids.iter().map(|i| i64::from(*i)).collect()));

    let drama = playback::top_genres(&c.pool, c.user, 8, &[lib])
        .await
        .unwrap();
    assert_eq!(drama.len(), 1);
    assert_eq!(drama[0].genre, "Drama");
    assert!(
        playback::top_genres(&c.pool, c.user, 8, &[lib + 1])
            .await
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrations = false)]
async fn completing_appends_history_and_unmarking_keeps_it(pool: PgPool) {
    let c = ctx(pool).await;
    let m = c
        .id(r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', (SELECT min(id) FROM libraries)) RETURNING id"#)
        .await;
    c.shell(m).await;
    let uri = format!("/api/playback/media/{m}/toggle-watched");
    let plays = || c.id("SELECT count(*)::int FROM playback_history");
    c.api("POST", &uri, None).await;
    assert_eq!(plays().await, 1, "a manual mark counts as a play");
    c.api("POST", &uri, None).await;
    assert_eq!(plays().await, 1, "unmarking keeps the history");
    c.api("POST", &uri, None).await;
    assert_eq!(plays().await, 2);
}

#[sqlx::test(migrations = false)]
async fn series_and_season_toggles_append_one_row_per_new_episode(pool: PgPool) {
    let c = ctx(pool).await;
    let m = c
        .id(r#"INSERT INTO media (title, type, "libraryId") VALUES ('s', 'series', (SELECT min(id) FROM libraries)) RETURNING id"#)
        .await;
    c.id(&format!(
        r#"INSERT INTO editions ("mediaId", family) VALUES ({m}, 'video') RETURNING id"#
    ))
    .await;
    let season = c
        .id(&format!(
            r#"INSERT INTO item_groups ("number", "mediaId") VALUES (1, {m}) RETURNING id"#
        ))
        .await;
    for n in 1..=2 {
        let item = c
            .id(&format!(
                r#"INSERT INTO items ("number", "groupId", "mediaId", "editionId")
               SELECT {n}, g.id, g."mediaId", ed.id FROM item_groups g
               JOIN editions ed ON ed."mediaId" = g."mediaId" WHERE g.id = {season} RETURNING items.id"#
            ))
            .await;
        c.id(&format!(
            r#"WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId")
                 VALUES ({m}, 'e{n}.mkv', 1, 'q', (SELECT min(id) FROM library_folders)) RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT {item}, id, {m}, 0 FROM f
               RETURNING "itemId""#
        ))
        .await;
    }
    let plays = || c.id("SELECT count(*)::int FROM playback_history");
    let w = Some(json!({"watched": true}));
    let series = format!("/api/playback/media/{m}/toggle-series-watched");
    c.api("POST", &series, w.clone()).await;
    assert_eq!(plays().await, 2);
    c.api("POST", &series, w.clone()).await;
    assert_eq!(
        plays().await,
        2,
        "already completed episodes do not count again"
    );
    let season_uri = format!("/api/playback/media/{m}/seasons/{season}/toggle-watched");
    c.api("POST", &season_uri, Some(json!({"watched": false})))
        .await;
    c.api("POST", &season_uri, w).await;
    assert_eq!(plays().await, 4);
}

/// A series with one episode that has a part, and its media id.
async fn series_with_episode(c: &Ctx, library: i32) -> (i32, i32, i32) {
    let m = c
        .id(&format!(
            r#"INSERT INTO media (title, type, "libraryId") VALUES ('s', 'series', {library}) RETURNING id"#
        ))
        .await;
    c.id(&format!(
        r#"INSERT INTO editions ("mediaId", family) VALUES ({m}, 'video') RETURNING id"#
    ))
    .await;
    let season = c
        .id(&format!(
            r#"INSERT INTO item_groups ("number", "mediaId") VALUES (1, {m}) RETURNING id"#
        ))
        .await;
    let item = c
        .id(&format!(
            r#"INSERT INTO items ("number", "groupId", "mediaId", "editionId")
               SELECT 1, {season}, {m}, id FROM editions WHERE "mediaId" = {m} RETURNING items.id"#
        ))
        .await;
    c.id(&format!(
        r#"WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId")
             VALUES ({m}, 'e.mkv', 1, 'q', (SELECT min(id) FROM library_folders)) RETURNING id)
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT {item}, id, {m}, 0 FROM f
           RETURNING "mediaFileId""#
    ))
    .await;
    (m, season, item)
}

#[sqlx::test(migrations = false)]
async fn the_season_toggle_keeps_played_at(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c
        .id(r#"INSERT INTO libraries (name) VALUES ('l') RETURNING id"#)
        .await;
    let (m, season, item) = series_with_episode(&c, lib).await;
    c.id(&format!(
        r#"INSERT INTO playback_states ("userId", "itemId", "positionSeconds", completed, "playedAt")
           VALUES ({}, {item}, 40, false, '2025-01-01') RETURNING id"#,
        c.user
    ))
    .await;
    let uri = format!("/api/playback/media/{m}/seasons/{season}/toggle-watched");
    let (s, _) = c.api("POST", &uri, Some(json!({"watched": true}))).await;
    assert_eq!(s, 201);
    let (completed, played): (bool, Option<chrono::DateTime<chrono::Utc>>) =
        sqlx::query_as(r#"SELECT completed, "playedAt" FROM playback_states WHERE "itemId" = $1"#)
            .bind(item)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert!(completed);
    assert_eq!(played.unwrap().format("%Y").to_string(), "2025");
}

#[sqlx::test(migrations = false)]
async fn a_movie_sorts_before_a_series_on_equal_continue_times(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c
        .id(r#"INSERT INTO libraries (name) VALUES ('l') RETURNING id"#)
        .await;
    let (series, _, ep) = series_with_episode(&c, lib).await;
    let movie = c
        .id(&format!(
            r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', {lib}) RETURNING id"#
        ))
        .await;
    let item = c.shell(movie).await;
    let file = c
        .id(&format!(
            r#"WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId")
                 VALUES ({movie}, 'm.mkv', 1, 'q', (SELECT min(id) FROM library_folders)) RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT {item}, id, {movie}, 0 FROM f
               RETURNING "mediaFileId""#
        ))
        .await;
    for it in [ep, item] {
        c.id(&format!(
            r#"INSERT INTO playback_states ("userId", "itemId", "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
               VALUES ({}, {it}, 100, 3600, false, '2026-01-01T00:00:00Z') RETURNING id"#,
            c.user
        ))
        .await;
    }
    let (s, got) = c.api("GET", "/api/playback/continue-watching", None).await;
    let ids: Vec<i64> = got
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["mediaId"].as_i64().unwrap())
        .collect();
    assert_eq!((s, ids), (200, vec![i64::from(movie), i64::from(series)]));

    // A movie whose only file is gone cannot be played, so it leaves the row.
    c.id(&format!(
        "DELETE FROM media_files WHERE id = {file} RETURNING id"
    ))
    .await;
    let (_, got) = c.api("GET", "/api/playback/continue-watching", None).await;
    let ids: Vec<i64> = got
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["mediaId"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![i64::from(series)]);
}

#[sqlx::test(migrations = false)]
async fn an_audio_item_stays_out_of_continue_watching(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c
        .id(r#"INSERT INTO libraries (name) VALUES ('l') RETURNING id"#)
        .await;
    let media = c
        .id(&format!(
            r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', {lib}) RETURNING id"#
        ))
        .await;
    let item = c.shell(media).await;
    c.id(&format!(
        r#"WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId")
             VALUES ({media}, 'm.mkv', 1, 'q', (SELECT min(id) FROM library_folders)) RETURNING id)
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT {item}, id, {media}, 0 FROM f
           RETURNING "mediaFileId""#
    ))
    .await;
    c.id(&format!(
        r#"INSERT INTO playback_states ("userId", "itemId", "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
           VALUES ({}, {item}, 100, 3600, false, now()) RETURNING id"#,
        c.user
    ))
    .await;
    let (_, got) = c.api("GET", "/api/playback/continue-watching", None).await;
    assert_eq!(got.as_array().unwrap().len(), 1);
    c.id(&format!(
        r#"UPDATE editions SET family = 'audio' WHERE "mediaId" = {media} RETURNING id"#
    ))
    .await;
    let (_, got) = c.api("GET", "/api/playback/continue-watching", None).await;
    assert!(got.as_array().unwrap().is_empty());
}

#[sqlx::test(migrations = false)]
async fn watched_ids_follow_the_rule_of_each_kind(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let u = c.user;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"ALTER TABLE media DROP CONSTRAINT "CK_media_type";
        INSERT INTO media (id, title, type, "libraryId") VALUES
          (1, 'done', 'movie', 1), (2, 'begun', 'movie', 1), (3, 'all', 'series', 1),
          (4, 'half', 'series', 1), (5, 'third', 'third', 1), (6, 'empty', 'series', 1);
        INSERT INTO editions (id, "mediaId", family) SELECT id, id, 'video' FROM media;
        INSERT INTO item_groups (id, "number", "mediaId") VALUES (13, 1, 3), (14, 1, 4), (16, 1, 6);
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 1, 1), (2, 2, 2), (5, 5, 5);
        INSERT INTO items (id, "number", "groupId", "mediaId", "editionId")
          VALUES (31, 1, 13, 3, 3), (32, 2, 13, 3, 3), (41, 1, 14, 4, 4), (42, 2, 14, 4, 4), (61, 1, 16, 6, 6);
        INSERT INTO media_files (id, "mediaId", "relativePath", size, quality, "folderId")
          SELECT i.id, i."mediaId", 'f' || i.id, 1, 'q', (SELECT min(id) FROM library_folders) FROM items i WHERE i.id IN (31, 32, 41, 42);
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT id, id, "mediaId", 0 FROM items WHERE id IN (31, 32, 41, 42);
        INSERT INTO playback_states ("userId", "itemId", completed) VALUES
          ({u}, 1, true), ({u}, 2, false), ({u}, 31, true), ({u}, 32, true), ({u}, 41, true),
          ({u}, 42, false), ({u}, 5, true), ({u}, 61, true);"#
    )))
    .execute(&pool)
    .await
    .unwrap();
    let (s, ids) = c.api("GET", "/api/playback/watched-ids", None).await;
    let mut ids: Vec<i64> = ids
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    ids.sort();
    assert_eq!((s, ids), (200, vec![1, 3, 5]));
}

#[sqlx::test(migrations = false)]
async fn a_pair_naming_several_ungrouped_items_is_a_409(pool: PgPool) {
    let c = ctx(pool).await;
    let m = c
        .id(r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', (SELECT min(id) FROM libraries)) RETURNING id"#)
        .await;
    let item = c.shell(m).await;
    let state = format!("/api/playback/media/{m}/state");
    let file = c
        .id(&format!(
            r#"WITH f AS (INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId")
                 VALUES ('x', 1, 'q', {m}, (SELECT min(id) FROM library_folders)) RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
               SELECT {item}, id, {m}, 0 FROM f RETURNING "mediaFileId""#
        ))
        .await;
    let beat = json!({"mediaFileId": file, "positionSeconds": 1, "durationSeconds": 10});

    c.id(&format!(
        r#"WITH e AS (INSERT INTO editions ("mediaId", family) VALUES ({m}, 'video') RETURNING id)
           INSERT INTO items ("mediaId", "editionId") SELECT {m}, id FROM e RETURNING items.id"#
    ))
    .await;
    for (method, uri, body) in [
        ("PUT", state.clone(), Some(beat)),
        ("DELETE", state.clone(), None),
        ("GET", state.clone(), None),
        (
            "POST",
            format!("/api/playback/media/{m}/toggle-watched"),
            None,
        ),
    ] {
        let (s, b) = c.api(method, &uri, body).await;
        assert_eq!(s, 409, "{method} {uri}: {b}");
        assert_eq!(b["message"], "errors.ambiguous_item");
    }
    let other = c
        .id(&format!(
            r#"SELECT max(id) FROM items WHERE "mediaId" = {m}"#
        ))
        .await;
    for (method, uri, body) in [
        ("GET", format!("{state}?itemId={other}"), None),
        ("DELETE", format!("{state}?itemId={other}"), None),
        (
            "PUT",
            state.clone(),
            Some(
                json!({"itemId": other, "mediaFileId": file, "positionSeconds": 1, "durationSeconds": 10}),
            ),
        ),
        (
            "POST",
            format!("/api/playback/media/{m}/toggle-watched"),
            Some(json!({"itemId": other, "mediaFileId": file})),
        ),
    ] {
        let (s, b) = c.api(method, &uri, body).await;
        assert!(s < 300, "{method} {uri} with an itemId: {s} {b}");
    }
    let (_, st) = c
        .api(
            "POST",
            &format!("/api/playback/media/{m}/toggle-watched"),
            Some(json!({"itemId": other})),
        )
        .await;
    assert_eq!(st["itemId"], other, "a state names its item");
    let named = format!("{state}?episodeId={item}");
    assert_eq!(
        c.api("GET", &named, None).await.0,
        200,
        "an item id still names it"
    );
    assert_eq!(
        c.api("GET", "/api/playback/media/9999/state", None).await.0,
        200
    );
}

#[sqlx::test(migrations = false)]
async fn history_names_the_played_item_of_a_multi_item_media(pool: PgPool) {
    let c = ctx(pool).await;
    let m = c
        .id(r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', (SELECT min(id) FROM libraries)) RETURNING id"#)
        .await;
    let first = c.shell(m).await;
    let second = c
        .id(&format!(
            r#"WITH e AS (INSERT INTO editions ("mediaId", family) VALUES ({m}, 'video') RETURNING id)
               INSERT INTO items ("mediaId", "editionId") SELECT {m}, id FROM e RETURNING items.id"#
        ))
        .await;
    let file = c
        .id(&format!(
            r#"INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId")
               VALUES ('x', 1, 'q', {m}, (SELECT min(id) FROM library_folders)) RETURNING id"#
        ))
        .await;
    for item in [first, second] {
        c.id(&format!(
            r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
               VALUES ({item}, {file}, {m}, 0) RETURNING "mediaFileId""#
        ))
        .await;
        let beat = json!({"mediaFileId": file, "itemId": item, "positionSeconds": 1, "durationSeconds": 10});
        let (s, b) = c
            .api("PUT", &format!("/api/playback/media/{m}/state"), Some(beat))
            .await;
        assert_eq!(s, 200, "{b}");
    }
    c.id(r#"UPDATE playback_states SET "playedAt" = now() RETURNING id"#)
        .await;
    let (_, h) = c.api("GET", "/api/playback/history", None).await;
    let mut got: Vec<i64> = h["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["itemId"].as_i64().unwrap())
        .collect();
    got.sort();
    assert_eq!(got, [first, second].map(i64::from));
}

async fn featured_media(
    c: &Ctx,
    lib: i32,
    title: &str,
    genre: &str,
    fanart: bool,
    file: bool,
) -> i32 {
    let fanart = if fanart { "'/f.jpg'" } else { "NULL" };
    let m = c
        .id(&format!(
            r#"INSERT INTO media (title, type, genres, "fanartUrl", "libraryId")
               VALUES ('{title}', 'movie', '["{genre}"]', {fanart}, {lib}) RETURNING id"#
        ))
        .await;
    c.shell(m).await;
    if file {
        c.id(&format!(
            r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId")
               VALUES ({m}, '{title}.mkv', 1, 'x', (SELECT min(id) FROM library_folders)) RETURNING id"#
        ))
        .await;
        c.id(&format!(
            r#"UPDATE media SET "lastFileAddedAt" = '2026-01-01'::timestamptz + make_interval(days => {m}) WHERE id = {m} RETURNING id"#
        ))
        .await;
    }
    m
}

async fn complete(c: &Ctx, media: i32) {
    let item = c
        .id(&format!(
            r#"SELECT id FROM items WHERE "mediaId" = {media}"#
        ))
        .await;
    sqlx::query(
        r#"INSERT INTO playback_states ("userId", "itemId", completed) VALUES ($1, $2, true)"#,
    )
    .bind(c.user)
    .bind(item)
    .execute(&c.pool)
    .await
    .unwrap();
}

fn picks(body: &Value) -> Vec<(i64, &str)> {
    body.as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["media"]["id"].as_i64().unwrap(),
                i["reason"].as_str().unwrap(),
            )
        })
        .collect()
}

#[sqlx::test(migrations = false)]
async fn featured_without_history_falls_back_to_recent(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.id("SELECT min(id) FROM libraries").await;
    let old = featured_media(&c, lib, "old", "Drama", true, true).await;
    let new = featured_media(&c, lib, "new", "Drama", true, true).await;
    featured_media(&c, lib, "nofanart", "Drama", false, true).await;
    featured_media(&c, lib, "nofile", "Drama", true, false).await;
    let dismissed = featured_media(&c, lib, "dismissed", "Drama", true, true).await;
    sqlx::query(r#"INSERT INTO recommendation_dismissals ("userId", "mediaId") VALUES ($1, $2)"#)
        .bind(c.user)
        .bind(dismissed)
        .execute(&c.pool)
        .await
        .unwrap();
    let watched = featured_media(&c, lib, "watched", "Drama", true, true).await;
    c.id(&format!(
        r#"UPDATE media SET genres = NULL WHERE id = {watched} RETURNING id"#
    ))
    .await;
    complete(&c, watched).await;
    let (s, body) = c.api("GET", "/api/home/featured", None).await;
    assert_eq!(s, 200);
    assert_eq!(
        picks(&body),
        [(i64::from(new), "recent"), (i64::from(old), "recent")]
    );
    assert_eq!(body[0]["becauseTitle"], Value::Null);
    assert_eq!(body[0]["media"]["fanartUrl"], "/f.jpg");
}

#[sqlx::test(migrations = false)]
async fn featured_puts_recommendations_first_without_duplicates(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.id("SELECT min(id) FROM libraries").await;
    let seen = featured_media(&c, lib, "seen", "Drama", true, true).await;
    complete(&c, seen).await;
    let rec = featured_media(&c, lib, "rec", "Drama", true, true).await;
    featured_media(&c, lib, "rec-nofanart", "Drama", false, true).await;
    featured_media(&c, lib, "rec-nofile", "Drama", true, false).await;
    let other = featured_media(&c, lib, "other", "Comedy", true, true).await;
    let (s, body) = c.api("GET", "/api/home/featured", None).await;
    assert_eq!(s, 200);
    assert_eq!(
        picks(&body),
        [
            (i64::from(rec), "recommended"),
            (i64::from(other), "recent")
        ]
    );
    assert_eq!(body[0]["becauseTitle"], "seen");

    let (_, body) = c.api("GET", "/api/home/featured?limit=1", None).await;
    assert_eq!(picks(&body), [(i64::from(rec), "recommended")]);
}

#[sqlx::test(migrations = false)]
async fn featured_library_filter_and_access_scope(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.id("SELECT min(id) FROM libraries").await;
    let lib2 = c
        .id(r#"INSERT INTO libraries (name) VALUES ('two') RETURNING id"#)
        .await;
    let a = featured_media(&c, lib, "a", "Drama", true, true).await;
    let b = featured_media(&c, lib2, "b", "Drama", true, true).await;
    let (_, body) = c.api("GET", "/api/home/featured", None).await;
    assert_eq!(
        picks(&body),
        [(i64::from(b), "recent"), (i64::from(a), "recent")]
    );
    let (_, body) = c
        .api("GET", &format!("/api/home/featured?libraryId={lib}"), None)
        .await;
    assert_eq!(picks(&body), [(i64::from(a), "recent")]);
    let (s, body) = c
        .api(
            "GET",
            &format!("/api/home/featured?libraryId={}", lib2 + 9),
            None,
        )
        .await;
    assert_eq!((s, body), (200, json!([])));

    let user = c
        .id(r#"INSERT INTO users (username, "isAdmin") VALUES ('v', false) RETURNING id"#)
        .await;
    let st = AppState::new(c.pool.clone(), Config::from_lookup(|_| None), SECRET);
    let token = session::token(&st, user, "v").await;
    let (s, _) = c.call("GET", "/api/home/featured", &token, None).await;
    assert_eq!(s, 403);
    c.id(&format!(
        r#"WITH r AS (INSERT INTO roles (name, permissions) VALUES ('R', '["media.read"]') RETURNING id)
           UPDATE users SET "roleId" = (SELECT id FROM r) WHERE id = {user} RETURNING id"#
    ))
    .await;
    c.id(&format!(
        r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ({user}, {lib}) RETURNING id"#
    ))
    .await;
    let (s, body) = c.call("GET", "/api/home/featured", &token, None).await;
    assert_eq!(s, 200);
    assert_eq!(picks(&body), [(i64::from(a), "recent")]);
}

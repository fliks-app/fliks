//! `/api/playback/*` validation, watched toggles and the in-process top genres.
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
    let cfg = Config::from_lookup(|_| None);
    let st = AppState::new(pool.clone(), cfg, SECRET);
    let user: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin") VALUES ('u', true) RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    Ctx {
        token: st.jwt.sign_access(user, "u").unwrap().token,
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
        .id(r#"INSERT INTO media (title, type) VALUES ('a', 'series') RETURNING id"#)
        .await;
    let b = c
        .id(r#"INSERT INTO media (title, type) VALUES ('b', 'series') RETURNING id"#)
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
        .id(r#"INSERT INTO media (title, type) VALUES ('m', 'movie') RETURNING id"#)
        .await;
    let item = c.shell(m).await;
    let f = c
        .id(&format!(
            r#"WITH f AS (INSERT INTO media_files ("relativePath", size, quality, "mediaId", "streamInfo")
                 VALUES ('x', 1, 'q', {m}, '{{"durationSeconds": 90.5}}') RETURNING id)
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
        .id(r#"INSERT INTO media (title, type) VALUES ('m', 'movie') RETURNING id"#)
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
        .id(r#"INSERT INTO media (title, type) VALUES ('m', 'movie') RETURNING id"#)
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
        .id(r#"INSERT INTO media (title, type) VALUES ('s', 'series') RETURNING id"#)
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
            r#"WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality)
                 VALUES ({m}, 'e{n}.mkv', 1, 'q') RETURNING id)
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
        r#"WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality)
             VALUES ({m}, 'e.mkv', 1, 'q') RETURNING id)
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
            r#"WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality)
                 VALUES ({movie}, 'm.mkv', 1, 'q') RETURNING id)
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
async fn watched_ids_follow_the_rule_of_each_kind(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let u = c.user;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"ALTER TABLE media DROP CONSTRAINT "CK_media_type";
        INSERT INTO libraries (id, name) VALUES (1, 'l');
        INSERT INTO media (id, title, type, "libraryId") VALUES
          (1, 'done', 'movie', 1), (2, 'begun', 'movie', 1), (3, 'all', 'series', 1),
          (4, 'half', 'series', 1), (5, 'third', 'third', 1), (6, 'empty', 'series', 1);
        INSERT INTO editions (id, "mediaId", family) SELECT id, id, 'video' FROM media;
        INSERT INTO item_groups (id, "number", "mediaId") VALUES (13, 1, 3), (14, 1, 4), (16, 1, 6);
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 1, 1), (2, 2, 2), (5, 5, 5);
        INSERT INTO items (id, "number", "groupId", "mediaId", "editionId")
          VALUES (31, 1, 13, 3, 3), (32, 2, 13, 3, 3), (41, 1, 14, 4, 4), (42, 2, 14, 4, 4), (61, 1, 16, 6, 6);
        INSERT INTO media_files (id, "mediaId", "relativePath", size, quality)
          SELECT i.id, i."mediaId", 'f' || i.id, 1, 'q' FROM items i WHERE i.id IN (31, 32, 41, 42);
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
        .id(r#"INSERT INTO media (title, type) VALUES ('m', 'movie') RETURNING id"#)
        .await;
    let item = c.shell(m).await;
    let state = format!("/api/playback/media/{m}/state");
    let file = c
        .id(&format!(
            r#"WITH f AS (INSERT INTO media_files ("relativePath", size, quality, "mediaId")
                 VALUES ('x', 1, 'q', {m}) RETURNING id)
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
        assert_eq!(b["message"], "ambiguous_item");
    }
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

//! `/api/playback/*` deviations (C1, C4, C6), watched toggles and the in-process top genres.
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
    let cfg = Config::from_lookup(|k| (k == "FLIKS_BRIDGE_TOKEN").then(|| "bridge".into()));
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
        sqlx::query_scalar(sql).fetch_one(&self.pool).await.unwrap()
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
            r#"INSERT INTO seasons ("seasonNumber", "mediaId") VALUES (1, {b}) RETURNING id"#
        ))
        .await;
    let toggle = |m: i32| format!("/api/playback/media/{m}/toggle-watched");
    assert_eq!(c.api("POST", &toggle(9999), None).await.0, 404);
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
    let f = c
        .id(&format!(
            r#"INSERT INTO media_files ("relativePath", size, quality, "mediaId", "streamInfo")
               VALUES ('x', 1, 'q', {m}, '{{"durationSeconds": 90.5}}') RETURNING id"#
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
    sqlx::query(
        r#"INSERT INTO playback_states ("userId", "mediaId", completed) VALUES ($1, $2, true)"#,
    )
    .bind(c.user)
    .bind(watched)
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

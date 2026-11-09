//! `X-Fliks-Kinds`: media of an undeclared kind never reaches a list (`docs/spec/client-kinds.md`).
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    token: String,
}

/// One media of each kind (ids 1-5, in library 1) and an album library (2) with one album (6).
async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO users (id, username, "isAdmin") VALUES (1, 'admin', true);
        INSERT INTO libraries (id, name) VALUES (1, 'mixed');
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (2, 'music', '["album"]');
        INSERT INTO media (id, title, type, "libraryId", genres) VALUES
          (1, 'm', 'movie', 1, '["g"]'), (2, 's', 'series', 1, '["g"]'), (3, 'b', 'book', 1, '["g"]'),
          (4, 'c', 'comic', 1, '["g"]'), (5, 'a', 'album', 1, '["g"]'), (6, 'a2', 'album', 2, '["g"]');
        INSERT INTO editions ("mediaId", family) SELECT id, 'video' FROM media;
        INSERT INTO items ("mediaId", "editionId") SELECT "mediaId", id FROM editions;
        INSERT INTO playback_states ("userId", "itemId", completed, "playedAt") SELECT 1, id, true, now() FROM items;
        INSERT INTO likes ("userId", "mediaId") SELECT 1, id FROM media;
        INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, wants)
          SELECT 1, 'add', type, 'tmdb', id::text, title, 'pending', CASE WHEN type = 'book' THEN '[]'::jsonb END
          FROM media;
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        app: app::router(st.clone(), None, "/nonexistent".into(), None),
        token: session::token(&st, 1, "admin").await,
    }
}

impl Ctx {
    async fn get(&self, uri: &str, kinds: Option<&str>) -> (u16, Value) {
        let mut req = Request::builder()
            .uri(uri)
            .header("authorization", format!("Bearer {}", self.token));
        if let Some(k) = kinds {
            req = req.header("x-fliks-kinds", k);
        }
        let res = self
            .app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// The distinct kinds of the rows `key` of `uri` holds (`""` for a bare array).
    async fn kinds(&self, uri: &str, key: &str, field: &str, header: Option<&str>) -> Vec<String> {
        let (s, v) = self.get(uri, header).await;
        assert_eq!(s, 200, "{uri}");
        let rows = if key.is_empty() { &v } else { &v[key] };
        let mut kinds: Vec<String> = rows
            .as_array()
            .unwrap_or_else(|| panic!("{uri}: {v}"))
            .iter()
            .map(|r| {
                r[field]
                    .as_str()
                    .unwrap_or_else(|| panic!("{uri}: {r}"))
                    .to_owned()
            })
            .collect();
        kinds.sort();
        kinds.dedup();
        kinds
    }
}

/// (uri, rows key, kind field): the mixed lists the filter reaches.
const LISTS: [(&str, &str, &str); 5] = [
    ("/api/media?limit=0", "data", "type"),
    ("/api/media/recently-added?mode=media", "", "type"),
    ("/api/playback/history", "data", "mediaType"),
    ("/api/likes", "", "mediaType"),
    ("/api/requests", "data", "mediaType"),
];

#[sqlx::test(migrations = false)]
async fn no_header_is_movie_series_book_and_comic(pool: PgPool) {
    let c = ctx(pool).await;
    for (uri, key, field) in LISTS {
        assert_eq!(
            c.kinds(uri, key, field, None).await,
            ["book", "comic", "movie", "series"],
            "{uri}"
        );
    }
}

#[sqlx::test(migrations = false)]
async fn declared_kinds_are_served_and_unknown_ones_ignored(pool: PgPool) {
    let c = ctx(pool).await;
    for (uri, key, field) in LISTS {
        let got = c.kinds(uri, key, field, Some("Movie, album,tape")).await;
        assert_eq!(got, ["album", "movie"], "{uri}");
    }
    let all = "movie,series,book,comic,album";
    for (uri, key, field) in LISTS {
        assert_eq!(c.kinds(uri, key, field, Some(all)).await.len(), 5, "{uri}");
    }
}

#[sqlx::test(migrations = false)]
async fn counts_item_pages_and_libraries_follow_the_declaration(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, counts) = c.get("/api/media/counts", None).await;
    assert_eq!(
        (counts["movies"].as_i64(), counts["albums"].as_i64()),
        (Some(1), Some(0))
    );
    let (_, by_library) = c.get("/api/media/counts-by-library", None).await;
    assert_eq!(by_library, serde_json::json!({"1": 4}));
    let (_, genres) = c.get("/api/media/genres", None).await;
    assert_eq!(genres[0]["count"], 4);
    assert_eq!(c.get("/api/media/5", None).await.0, 404);
    assert_eq!(c.get("/api/media/5", Some("album")).await.0, 200);
    assert_eq!(c.get("/api/media/1", None).await.0, 200);

    let libraries = |v: Value| -> Vec<i64> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|l| l["id"].as_i64().unwrap())
            .collect()
    };
    assert_eq!(libraries(c.get("/api/libraries/mine", None).await.1), [1]);
    assert_eq!(libraries(c.get("/api/libraries", None).await.1), [1]);
    assert_eq!(
        libraries(c.get("/api/libraries/mine", Some("movie,album")).await.1),
        [1, 2]
    );
    let (s, page) = c.get("/api/media?libraryId=2&limit=0", None).await;
    assert_eq!((s, page["total"].as_i64()), (200, Some(0)));
}

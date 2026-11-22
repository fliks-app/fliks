//! Lists released Apple TV builds decode into non-optional keys: dropping one empties that rail
//! (`media-query.md` rule 14a).
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;

const MEDIA: [&str; 4] = ["id", "title", "type", "additionalFanartUrls"];
const FILE: [&str; 4] = ["id", "quality", "relativePath", "size"];
const CONTINUE: [&str; 6] = [
    "mediaId",
    "positionSeconds",
    "progressPercent",
    "lastPlayedAt",
    "mediaTitle",
    "mediaType",
];
const REQUEST: [&str; 3] = ["id", "title", "status"];
const GRID_FILE: [&str; 5] = ["episodeId", "id", "quality", "relativePath", "size"];

struct Ctx {
    app: Router,
    token: String,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(
        pool.clone(),
        Config::from_lookup(|_| None),
        "0123456789abcdef0123456789abcdef",
    );
    sqlx::raw_sql(
        r#"INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL);
        INSERT INTO libraries (id, name) VALUES (1, 'L');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m/one');
        INSERT INTO media (id, title, year, type, "libraryId", "folderName") VALUES (1, 'Alpha', 2000, 'movie', 1, 'a');
        INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId")
          SELECT 1, 'a/f', 1, 'WEBDL-720p', "folderId" FROM library_default_folders WHERE "libraryId" = 1;
        WITH e AS (INSERT INTO editions ("mediaId", family) VALUES (1, 'video') RETURNING id),
          i AS (INSERT INTO items ("mediaId", "editionId") SELECT 1, id FROM e RETURNING id),
          p AS (INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
            SELECT i.id, f.id, 1, 0 FROM i, media_files f WHERE f."mediaId" = 1 RETURNING "itemId")
        INSERT INTO playback_states ("userId", "itemId", "positionSeconds", "durationSeconds", completed, "lastPlayedAt")
          SELECT 1, "itemId", 100, 3600, false, now() FROM p;
        INSERT INTO requests ("userId", "mediaType", provider, "externalId", title, status)
          VALUES (1, 'movie', 'tmdb', '9', 'R', 'pending');"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        token: session::token(&st, 1, "admin").await,
        app: app::router(st, None, "/nonexistent".into(), None),
    }
}

impl Ctx {
    async fn get(&self, uri: &str) -> Value {
        let req = Request::builder()
            .uri(uri)
            .header("x-fliks-kinds", "movie,series")
            .header("authorization", format!("Bearer {}", self.token))
            .body(Body::empty())
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status().as_u16(), 200, "{uri}");
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
}

fn require(row: &Value, keys: &[&str], what: &str) {
    for k in keys {
        assert!(!row[k].is_null(), "{what} lacks `{k}`: {row}");
    }
}

fn media_rows(rows: &Value, uri: &str) {
    let rows = rows.as_array().unwrap();
    assert!(!rows.is_empty(), "{uri} answered no row");
    for m in rows {
        require(m, &MEDIA, uri);
        let files = m["files"].as_array().unwrap();
        assert!(!files.is_empty(), "{uri} answered a row without files");
        for f in files {
            require(f, &FILE, uri);
        }
    }
}

#[sqlx::test(migrations = false)]
async fn recently_added_keeps_the_keys_tvos_decodes(pool: PgPool) {
    let c = ctx(pool).await;
    for uri in [
        "/api/media/recently-added",
        "/api/media/recently-added?libraryId=1",
    ] {
        media_rows(&c.get(uri).await, uri);
    }
}

#[sqlx::test(migrations = false)]
async fn the_media_list_keeps_the_keys_tvos_decodes(pool: PgPool) {
    let c = ctx(pool).await;
    let page = c.get("/api/media?limit=25").await;
    assert!(page["total"].is_number());
    media_rows(&page["data"], "/api/media");
}

#[sqlx::test(migrations = false)]
async fn the_grid_view_ships_five_keys_per_file_and_no_stream_info(pool: PgPool) {
    let c = ctx(pool).await;
    for (uri, rows) in [
        (
            "/api/media?view=grid&limit=0",
            c.get("/api/media?view=grid&limit=0").await["data"].clone(),
        ),
        (
            "/api/media/recently-added",
            c.get("/api/media/recently-added").await,
        ),
    ] {
        let file = &rows[0]["files"][0];
        let mut keys: Vec<&str> = file
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, GRID_FILE, "{uri}");
        assert_eq!(rows[0]["fileCount"], 1, "{uri}");
    }
    let full = c.get("/api/media?limit=0").await;
    assert!(full["data"][0]["files"][0].get("streamInfo").is_some());
}

#[sqlx::test(migrations = false)]
async fn continue_watching_keeps_the_keys_tvos_decodes(pool: PgPool) {
    let c = ctx(pool).await;
    let rows = c.get("/api/playback/continue-watching").await;
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    require(&rows[0], &CONTINUE, "continue-watching");
}

#[sqlx::test(migrations = false)]
async fn requests_keep_the_keys_tvos_decodes(pool: PgPool) {
    let c = ctx(pool).await;
    let page = c.get("/api/requests?limit=12").await;
    let rows = page["data"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    require(&rows[0], &REQUEST, "requests");
}

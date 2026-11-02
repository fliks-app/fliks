//! `/kosync/*` (`docs/spec/kosync.md`): the requests KOReader's plugin sends, on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_server::{
    config::Config,
    device_tokens::{self, Kind},
    kosync,
    state::AppState,
};
use md5::{Digest, Md5};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const H_TEXT: &str = "0123456789abcdef0123456789abcdef";
const H_HIDDEN: &str = "11111111111111111111111111111111";
const H_AUDIO: &str = "22222222222222222222222222222222";

struct Ctx {
    app: Router,
    pool: PgPool,
}

fn md5_hex(s: &str) -> String {
    Md5::digest(s).iter().map(|b| format!("{b:02x}")).collect()
}

/// User 1 reads library 1 only; user 2 is disabled. Returns the context and the kosync key of each.
async fn ctx(pool: PgPool) -> (Ctx, String, String) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId", enabled) VALUES (1, 'a', false, 1, true), (2, 'b', false, 1, false);
        INSERT INTO libraries (id, name) VALUES (1, 'L1'), (2, 'L2');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b/one'), (2, '/b/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 1), (1, 2);
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES
          (10, 'Alpha', 'book', 1, 'a'), (11, 'Beta', 'book', 2, 'b'), (12, 'Gamma', 'book', 1, 'c');
        INSERT INTO editions (id, "mediaId", family, format) VALUES
          (1, 10, 'text', 'epub'), (2, 11, 'text', 'epub'), (3, 12, 'audio', 'm4b');
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 10, 1), (2, 11, 2), (3, 12, 3);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, 'a.epub', 1, 'EPUB', '{}'), (2, 11, 2, 'b.epub', 1, 'EPUB', '{}'),
          (3, 12, 1, 'c.m4b', 1, 'M4B', '{"durationSeconds": 100}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (2, 2, 11, 0, 0), (3, 3, 12, 0, 0);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    for (f, h) in [(1, H_TEXT), (2, H_HIDDEN), (3, H_AUDIO)] {
        sqlx::query(
            r#"INSERT INTO media_file_hashes ("mediaFileId", kind, hash) VALUES ($1, 'koreader', $2)"#,
        )
        .bind(f)
        .bind(h)
        .execute(&pool)
        .await
        .unwrap();
    }
    let mut keys = vec![];
    for user in [1, 2] {
        let (token, hash) = device_tokens::issue(Kind::Kosync);
        sqlx::query(
            r#"INSERT INTO device_tokens ("userId", name, kind, hash) VALUES ($1, 'KOReader', 'kosync', $2)"#,
        )
        .bind(user)
        .bind(hash)
        .execute(&pool)
        .await
        .unwrap();
        keys.push(md5_hex(&token));
    }
    let app = kosync::router().with_state(st);
    (Ctx { app, pool }, keys.remove(0), keys.remove(0))
}

impl Ctx {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        key: Option<&str>,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-auth-user", "any");
        if let Some(k) = key {
            req = req.header("x-auth-key", k);
        }
        let body = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let res = self
            .app
            .clone()
            .oneshot(req.body(body).unwrap())
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

    async fn put(&self, key: &str, document: &str, progress: Value, pct: f64) -> (u16, Value) {
        let body = json!({"document": document, "progress": progress, "percentage": pct,
            "device": "Kobo Clara", "device_id": "ABCD"});
        self.call("PUT", "/kosync/syncs/progress", Some(key), Some(body))
            .await
    }

    async fn state(&self) -> Option<(f64, Option<Value>, bool)> {
        sqlx::query_as(
            r#"SELECT progression, locator, completed FROM playback_states WHERE "userId" = 1 AND "itemId" = 1"#,
        )
        .fetch_optional(&self.pool)
        .await
        .unwrap()
    }
}

#[sqlx::test(migrations = false)]
async fn auth_accepts_only_a_kosync_key_of_an_enabled_user(pool: PgPool) {
    let (c, key, disabled) = ctx(pool).await;
    let (s, b) = c.call("GET", "/kosync/users/auth", Some(&key), None).await;
    assert_eq!((s, b), (200, json!({"authorized": "OK"})));
    let used: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar(r#"SELECT "lastUsedAt" FROM device_tokens WHERE "userId" = 1"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert!(used.is_some());
    let (opds, hash) = device_tokens::issue(Kind::Opds);
    sqlx::query(
        r#"INSERT INTO device_tokens ("userId", name, kind, hash) VALUES (1, 'o', 'opds', $1)"#,
    )
    .bind(hash)
    .execute(&c.pool)
    .await
    .unwrap();
    let opds_md5 = md5_hex(&opds);
    for bad in [
        None,
        Some(disabled.as_str()),
        Some(opds.as_str()),
        Some(opds_md5.as_str()),
        Some("zz"),
    ] {
        let (s, b) = c.call("GET", "/kosync/syncs/progress/x", bad, None).await;
        assert_eq!((s, b), (401, json!({"message": "Unauthorized"})), "{bad:?}");
    }
    let body = json!({"username": "x", "password": "y"});
    let (s, _) = c
        .call("POST", "/kosync/users/create", None, Some(body))
        .await;
    assert_eq!(s, 402);
}

#[sqlx::test(migrations = false)]
async fn progress_round_trips_byte_for_byte_and_feeds_the_text_progression(pool: PgPool) {
    let (c, key, _) = ctx(pool).await;
    let uri = format!("/kosync/syncs/progress/{H_TEXT}");
    assert_eq!(
        c.call("GET", &uri, Some(&key), None).await,
        (200, json!({}))
    );
    let xp = "/body/DocFragment[12]/body/div/p[3]/text().57";
    sqlx::query(
        r#"INSERT INTO playback_states ("userId", "itemId", progression, locator) VALUES (1, 1, 0.1, '{"href":"c1"}')"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let (s, b) = c.put(&key, H_TEXT, json!(xp), 0.42).await;
    assert_eq!(s, 200);
    assert_eq!(b["document"], H_TEXT);
    assert!(b["timestamp"].is_i64());
    let (s, b) = c.call("GET", &uri, Some(&key), None).await;
    assert_eq!(s, 200);
    assert_eq!(
        (
            b["progress"].as_str(),
            b["percentage"].as_f64(),
            b["device"].as_str(),
            b["device_id"].as_str()
        ),
        (Some(xp), Some(0.42), Some("Kobo Clara"), Some("ABCD"))
    );
    assert_eq!(
        c.state().await,
        Some((0.42, None, false)),
        "locator cleared, progression shared"
    );
    // A page number is stored as text; no device_id leaves the key out.
    let body = json!({"document": H_TEXT, "progress": 17, "percentage": 1.0, "device": "Pb"});
    let put = c
        .call("PUT", "/kosync/syncs/progress", Some(&key), Some(body))
        .await;
    assert_eq!(put.0, 200);
    let (_, b) = c.call("GET", &uri, Some(&key), None).await;
    assert_eq!(
        (b["progress"].as_str(), b.get("device_id")),
        (Some("17"), None)
    );
    assert_eq!(c.state().await.map(|s| s.2), Some(true), "finished at 1.0");
    let plays: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM playback_history WHERE "itemId" = 1"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(plays, 1);
}

#[sqlx::test(migrations = false)]
async fn unknown_hidden_and_non_text_documents_are_accepted_but_not_kept(pool: PgPool) {
    let (c, key, _) = ctx(pool).await;
    let upper = H_TEXT.to_uppercase();
    let unknown = "f".repeat(32);
    for doc in [H_HIDDEN, H_AUDIO, "Book Title.epub", &unknown, &upper] {
        let (s, b) = c.put(&key, doc, json!("x"), 0.5).await;
        assert_eq!((s, b["document"].as_str()), (200, Some(doc)), "{doc}");
        let uri = format!("/kosync/syncs/progress/{}", doc.replace(' ', "%20"));
        let (s, b) = c.call("GET", &uri, Some(&key), None).await;
        assert_eq!((s, b), (200, json!({})), "{doc}");
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM kosync_progress")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    // A library the owner loses access to hides a stored position.
    assert_eq!(c.put(&key, H_TEXT, json!("p"), 0.3).await.0, 200);
    sqlx::query(r#"DELETE FROM library_user_access WHERE "userId" = 1"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let uri = format!("/kosync/syncs/progress/{H_TEXT}");
    let (s, b) = c.call("GET", &uri, Some(&key), None).await;
    assert_eq!((s, b), (200, json!({})));
}

#[sqlx::test(migrations = false)]
async fn a_malformed_body_is_400(pool: PgPool) {
    let (c, key, _) = ctx(pool).await;
    for body in [
        json!({}),
        json!({"document": H_TEXT, "progress": "p", "percentage": "0.5", "device": "d"}),
        json!({"document": H_TEXT, "progress": "x".repeat(5000), "percentage": 0.5, "device": "d"}),
    ] {
        let (s, b) = c
            .call("PUT", "/kosync/syncs/progress", Some(&key), Some(body))
            .await;
        assert_eq!((s, b), (400, json!({"message": "Invalid request"})));
    }
}

#[sqlx::test(migrations = false)]
async fn labels_are_never_refused_and_a_hidden_first_copy_is_skipped(pool: PgPool) {
    let (c, key, _) = ctx(pool).await;
    let body = json!({"document": H_TEXT, "progress": "p", "percentage": 0.5, "device": "  "});
    let put = c
        .call("PUT", "/kosync/syncs/progress", Some(&key), Some(body))
        .await;
    assert_eq!(put.0, 200);
    let device: String = sqlx::query_scalar("SELECT device FROM kosync_progress")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(device, "unknown");
    // The lowest-id copy sits in an unreadable library, the next one is readable.
    let dup = "33333333333333333333333333333333";
    sqlx::raw_sql(
        r#"
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (20, 'D1', 'book', 2, 'd1'), (21, 'D2', 'book', 1, 'd2');
        INSERT INTO editions (id, "mediaId", family, format) VALUES (20, 20, 'text', 'epub'), (21, 21, 'text', 'epub');
        INSERT INTO items (id, "mediaId", "editionId") VALUES (20, 20, 20), (21, 21, 21);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (20, 20, 2, 'd1.epub', 1, 'EPUB', '{}'), (21, 21, 1, 'd2.epub', 1, 'EPUB', '{}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES (20, 20, 20, 0, 0), (21, 21, 21, 0, 0);
        INSERT INTO media_file_hashes ("mediaFileId", kind, hash) VALUES (20, 'koreader', '33333333333333333333333333333333'), (21, 'koreader', '33333333333333333333333333333333');
        "#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    assert_eq!(c.put(&key, dup, json!("q"), 0.2).await.0, 200);
    let file: i32 =
        sqlx::query_scalar(r#"SELECT "mediaFileId" FROM kosync_progress WHERE document = $1"#)
            .bind(dup)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(file, 21);
}

#[sqlx::test(migrations = false)]
async fn auth_is_throttled_whatever_the_label(pool: PgPool) {
    let (c, key, _) = ctx(pool).await;
    for i in 0..5 {
        let req = Request::builder()
            .uri("/kosync/users/auth")
            .header("x-auth-user", format!("u{i}"))
            .header("x-auth-key", "0".repeat(32));
        let res = c
            .app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), 401);
    }
    let throttled = c.call("GET", "/kosync/users/auth", Some(&key), None).await;
    assert_eq!(throttled.0, 429);
    // The sync routes are not throttled.
    let uri = format!("/kosync/syncs/progress/{H_TEXT}");
    assert_eq!(c.call("GET", &uri, Some(&key), None).await.0, 200);
}

#[sqlx::test(migrations = false)]
async fn concurrent_puts_leave_one_state(pool: PgPool) {
    let (c, key, _) = ctx(pool).await;
    let c = std::sync::Arc::new(c);
    let tasks: Vec<_> = (0..8)
        .map(|i| {
            let (c, key) = (c.clone(), key.clone());
            tokio::spawn(async move {
                c.put(
                    &key,
                    H_TEXT,
                    json!(format!("p{i}")),
                    0.1 + f64::from(i) / 100.0,
                )
                .await
                .0
            })
        })
        .collect();
    for t in tasks {
        assert_eq!(t.await.unwrap(), 200);
    }
    let n: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM playback_states WHERE "itemId" = 1"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

//! `/kobo/<token>/v1/*` (`docs/spec/kobo.md`): the requests a Kobo e-reader sends, on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_server::{
    config::Config,
    device_tokens::{self, Kind},
    kobo,
    state::AppState,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    pool: PgPool,
    token: String,
    cache: std::path::PathBuf,
}

/// A fresh empty directory under the system temp dir.
fn scratch(tag: &str) -> std::path::PathBuf {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let d = std::env::temp_dir().join(format!("fliks-kobo-{}-{n}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn book(n: i32) -> String {
    format!("f11c5b00-0000-4000-8000-{n:012x}")
}

async fn token(pool: &PgPool, user: i32, kind: Kind) -> String {
    let (token, hash) = device_tokens::issue(kind);
    sqlx::query(r#"INSERT INTO device_tokens ("userId", name, kind, hash) VALUES ($1, 'k', $2::text::device_token_kind, $3)"#)
        .bind(user)
        .bind(kind.as_str())
        .bind(hash)
        .execute(pool)
        .await
        .unwrap();
    token
}

/// User 1 reads library 1; user 2 is disabled. Items: 1 and 4 EPUB in library 1, 2 EPUB in library 2, 3 PDF.
async fn ctx(pool: PgPool) -> (Ctx, String) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let mut st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let cache = scratch("cache");
    st.kepub_cache = Some(cache.clone().into());
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId", enabled) VALUES (1, 'a', false, 1, true), (2, 'b', false, 1, false);
        INSERT INTO libraries (id, name) VALUES (1, 'L1'), (2, 'L2');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b/one'), (2, '/b/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 1), (1, 2);
        INSERT INTO media (id, title, type, "libraryId", "folderName", overview, year) VALUES
          (10, 'Alpha', 'book', 1, 'a', 'About alpha', 2001), (11, 'Beta', 'book', 2, 'b', NULL, NULL),
          (12, 'Gamma', 'book', 1, 'c', NULL, NULL), (13, 'Delta', 'book', 1, 'd', NULL, NULL);
        INSERT INTO editions (id, "mediaId", family, format) VALUES
          (1, 10, 'text', 'epub'), (2, 11, 'text', 'epub'), (3, 12, 'text', 'pdf'), (4, 13, 'text', 'epub');
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 10, 1), (2, 11, 2), (3, 12, 3), (4, 13, 4);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, 'a.epub', 111, 'EPUB', '{}'), (2, 11, 2, 'b.epub', 1, 'EPUB', '{}'),
          (3, 12, 1, 'c.pdf', 1, 'PDF', '{}'), (4, 13, 1, 'd.EPUB', 1, 'EPUB', '{}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (2, 2, 11, 0, 0), (3, 3, 12, 0, 0), (4, 4, 13, 0, 0);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let t = token(&pool, 1, Kind::Kobo).await;
    let disabled = token(&pool, 2, Kind::Kobo).await;
    let app = kobo::router().with_state(st);
    (
        Ctx {
            app,
            pool,
            token: t,
            cache,
        },
        disabled,
    )
}

struct Res {
    status: u16,
    sync_token: Option<String>,
    more: bool,
    body: Value,
}

impl Ctx {
    async fn raw(
        &self,
        method: &str,
        token: &str,
        path: &str,
        sync: Option<&str>,
        body: Option<Value>,
    ) -> Res {
        let mut req = Request::builder()
            .method(method)
            .uri(format!("/kobo/{token}{path}"))
            .header("host", "kobo.example")
            .header("x-forwarded-proto", "https")
            .header("user-agent", "Mozilla/5.0 (Linux; U; Android 2.0; en-us;) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1 (Kobo Touch 0391/4.38.23171)");
        if let Some(s) = sync {
            req = req.header("x-kobo-synctoken", s);
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
        let h = res.headers().clone();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        Res {
            status,
            sync_token: h
                .get("x-kobo-synctoken")
                .map(|v| v.to_str().unwrap().to_owned()),
            more: h.get("x-kobo-sync").is_some_and(|v| v == "continue"),
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }

    async fn call(&self, method: &str, path: &str, body: Option<Value>) -> Res {
        self.raw(method, &self.token, path, None, body).await
    }

    async fn sync(&self, token: Option<&str>) -> Res {
        self.raw("GET", &self.token, "/v1/library/sync", token, None)
            .await
    }
}

fn ids(r: &Res) -> Vec<String> {
    r.body
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let (k, v) = e.as_object().unwrap().iter().next().unwrap();
            let id = v["BookEntitlement"]["Id"]
                .as_str()
                .or_else(|| v["ReadingState"]["EntitlementId"].as_str())
                .or_else(|| v["Tag"]["Id"].as_str())
                .unwrap();
            format!(
                "{k} {}",
                id.rsplit('-').next().unwrap().trim_start_matches('0')
            )
        })
        .collect()
}

#[sqlx::test(migrations = false)]
async fn only_a_kobo_token_of_an_enabled_user_opens_the_routes(pool: PgPool) {
    let (c, disabled) = ctx(pool).await;
    let opds = token(&c.pool, 1, Kind::Opds).await;
    let kosync = token(&c.pool, 1, Kind::Kosync).await;
    for bad in [
        disabled.as_str(),
        opds.as_str(),
        kosync.as_str(),
        "fkd_nope",
        "x",
    ] {
        let r = c.raw("GET", bad, "/v1/initialization", None, None).await;
        assert_eq!(r.status, 401, "{bad}");
    }
    assert_eq!(c.call("GET", "/v1/initialization", None).await.status, 200);
    let used: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        r#"SELECT "lastUsedAt" FROM device_tokens WHERE "userId" = 1 AND kind = 'kobo'"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert!(used.is_some());
    sqlx::query("DELETE FROM device_tokens WHERE kind = 'kobo' AND \"userId\" = 1")
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(
        c.call("GET", "/v1/initialization", None).await.status,
        401,
        "revoked"
    );
}

#[sqlx::test(migrations = false)]
async fn failing_tokens_are_throttled_and_a_valid_one_is_not(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let mut seen = vec![];
    for _ in 0..7 {
        seen.push(
            c.raw("GET", "fkd_bad", "/v1/initialization", None, None)
                .await
                .status,
        );
    }
    assert_eq!(seen, [401, 401, 401, 401, 401, 429, 429]);
    assert_eq!(c.call("GET", "/v1/initialization", None).await.status, 200);
}

#[sqlx::test(migrations = false)]
async fn initialization_points_back_at_the_request_base(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let r = c.call("GET", "/v1/initialization", None).await;
    let res = &r.body["Resources"];
    let root = format!("https://kobo.example/kobo/{}", c.token);
    assert_eq!(res["library_sync"], format!("{root}/v1/library/sync"));
    assert_eq!(res["image_host"], "https://kobo.example");
    assert!(
        res["image_url_template"]
            .as_str()
            .unwrap()
            .starts_with(&root)
    );
}

#[sqlx::test(migrations = false)]
async fn sync_round_trip_sends_changes_removals_and_survives_a_lost_answer(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let first = c.sync(None).await;
    assert_eq!(ids(&first), ["NewEntitlement 1", "NewEntitlement 4"]);
    assert!(!first.more);
    let e = &first.body[0]["NewEntitlement"];
    let dl = &e["BookMetadata"]["DownloadUrls"][0];
    assert_eq!(dl["Format"], "KEPUB");
    assert_eq!(
        e["BookMetadata"]["DownloadUrls"].as_array().unwrap().len(),
        1
    );
    assert_eq!(dl["Size"], 111);
    assert_eq!(
        dl["Url"],
        format!(
            "https://kobo.example/kobo/{}/download/{}/kepub",
            c.token,
            book(1)
        )
    );
    assert_eq!(e["BookMetadata"]["Title"], "Alpha");
    assert_eq!(e["BookMetadata"]["Description"], "About alpha");
    assert_eq!(e["ReadingState"]["StatusInfo"]["Status"], "ReadyToRead");

    // the answer was lost: the same token (or none) rebuilds the same answer
    assert_eq!(ids(&c.sync(None).await), ids(&first));
    let t1 = first.sync_token.unwrap();
    // acknowledged by the next call
    let second = c.sync(Some(&t1)).await;
    assert_eq!(ids(&second), Vec::<String>::new());
    let t2 = second.sync_token.unwrap();

    sqlx::query("UPDATE media SET title = 'Alpha 2' WHERE id = 10")
        .execute(&c.pool)
        .await
        .unwrap();
    let third = c.sync(Some(&t2)).await;
    assert_eq!(ids(&third), ["ChangedEntitlement 1"]);
    let lost = c.sync(Some(&t2)).await;
    assert_eq!(ids(&lost), ids(&third));
    let t3 = third.sync_token.unwrap();
    assert!(ids(&c.sync(Some(&t3)).await).is_empty());

    // a book that becomes unreadable is removed, then forgotten
    sqlx::query(r#"UPDATE media SET "libraryId" = 2 WHERE id = 13"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let gone = c.sync(Some(&t3)).await;
    assert_eq!(ids(&gone), ["ChangedEntitlement 4"]);
    assert_eq!(
        gone.body[0]["ChangedEntitlement"]["BookEntitlement"]["IsRemoved"],
        true
    );
    let t4 = gone.sync_token.unwrap();
    assert!(ids(&c.sync(Some(&t4)).await).is_empty());
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM kobo_sync_items WHERE kind = 'item'")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);

    // an unreadable token is no token: everything is new again
    assert_eq!(
        ids(&c.sync(Some("not base64!")).await),
        ["NewEntitlement 1"]
    );
}

#[sqlx::test(migrations = false)]
async fn an_epub_with_a_text_sibling_in_a_later_version_stays_a_book(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let t1 = c.sync(None).await.sync_token.unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (14, 'Eps', 'book', 1, 'e');
        INSERT INTO editions (id, "mediaId", family, format) VALUES (5, 14, 'text', 'epub');
        INSERT INTO items (id, "mediaId", "editionId") VALUES (5, 14, 5);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (5, 14, 1, 'e.epub', 1, 'EPUB', '{}'), (6, 14, 1, 'e.pdf', 1, 'PDF', '{}'), (7, 10, 1, 'a.pdf', 1, 'PDF', '{}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (5, 5, 14, 0, 0), (5, 6, 14, 1, 0), (1, 7, 10, 1, 0);
        "#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let r = c.sync(Some(&t1)).await;
    assert_eq!(ids(&r), ["NewEntitlement 5"]);
    assert_eq!(
        c.call("GET", &format!("/v1/library/{}/metadata", book(5)), None)
            .await
            .status,
        200
    );
}

#[sqlx::test(migrations = false)]
async fn sync_pages_by_100(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    sqlx::raw_sql(
        r#"
        INSERT INTO media (id, title, type, "libraryId", "folderName")
          SELECT 100 + n, 'B' || n, 'book', 1, 'f' || n FROM generate_series(1, 120) n;
        INSERT INTO editions (id, "mediaId", family, format) SELECT 100 + n, 100 + n, 'text', 'epub' FROM generate_series(1, 120) n;
        INSERT INTO items (id, "mediaId", "editionId") SELECT 100 + n, 100 + n, 100 + n FROM generate_series(1, 120) n;
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo")
          SELECT 100 + n, 100 + n, 1, n || '.epub', 1, 'EPUB', '{}' FROM generate_series(1, 120) n;
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
          SELECT 100 + n, 100 + n, 100 + n, 0, 0 FROM generate_series(1, 120) n;
        "#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let a = c.sync(None).await;
    assert_eq!((a.body.as_array().unwrap().len(), a.more), (100, true));
    let b = c.sync(a.sync_token.as_deref()).await;
    assert_eq!((b.body.as_array().unwrap().len(), b.more), (22, false));
    let done = c.sync(b.sync_token.as_deref()).await;
    assert!(done.body.as_array().unwrap().is_empty());
}

#[sqlx::test(migrations = false)]
async fn sync_resumes_after_the_cursor_across_scan_windows(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    sqlx::raw_sql(
        r#"
        INSERT INTO media (id, title, type, "libraryId", "folderName")
          SELECT 100 + n, 'B' || n, 'book', 1, 'f' || n FROM generate_series(1, 600) n;
        INSERT INTO editions (id, "mediaId", family, format) SELECT 100 + n, 100 + n, 'text', 'epub' FROM generate_series(1, 600) n;
        INSERT INTO items (id, "mediaId", "editionId") SELECT 100 + n, 100 + n, 100 + n FROM generate_series(1, 600) n;
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo")
          SELECT 100 + n, 100 + n, 1, n || '.epub', 1, 'EPUB', '{}' FROM generate_series(1, 600) n;
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
          SELECT 100 + n, 100 + n, 100 + n, 0, 0 FROM generate_series(1, 600) n;
        "#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let a = c.sync(None).await;
    assert_eq!((a.body.as_array().unwrap().len(), a.more), (100, true));
    let mut sent = ids(&a);

    // an unsent book becomes unreadable and a sent one changes between two pages
    sqlx::raw_sql(
        r#"UPDATE media SET "libraryId" = 2 WHERE id = 400; UPDATE media SET title = 'Alpha 2' WHERE id = 10"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let mut tok = a.sync_token.unwrap();
    loop {
        let r = c.sync(Some(&tok)).await;
        sent.extend(ids(&r));
        tok = r.sync_token.clone().unwrap();
        if !r.more {
            break;
        }
    }
    assert_eq!(sent.len(), 601, "every readable book once, no removal");
    assert!(sent.iter().all(|e| e.starts_with("NewEntitlement")));
    assert!(!sent.contains(&format!("NewEntitlement {:x}", 400)));
    let mut uniq = sent.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), sent.len());

    // the next sync starts from the top again and finds both changes
    let last = c.sync(Some(&tok)).await;
    assert_eq!(ids(&last), ["ChangedEntitlement 1"]);
    sqlx::query(r#"UPDATE media SET "libraryId" = 2 WHERE id = 550"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let gone = c.sync(last.sync_token.as_deref()).await;
    assert_eq!(ids(&gone), [format!("ChangedEntitlement {:x}", 550)]);
    assert_eq!(
        gone.body[0]["ChangedEntitlement"]["BookEntitlement"]["IsRemoved"],
        true
    );
}

#[sqlx::test(migrations = false)]
async fn an_archived_book_is_not_sent_again_until_a_reset(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let t = c.sync(None).await.sync_token.unwrap();
    assert_eq!(
        c.call("DELETE", &format!("/v1/library/{}", book(1)), None)
            .await
            .status,
        204
    );
    assert_eq!(
        c.call("DELETE", &format!("/v1/library/{}", book(2)), None)
            .await
            .status,
        404
    );
    assert_eq!(c.call("DELETE", "/v1/library/nope", None).await.status, 404);
    sqlx::query("UPDATE media SET title = 'Alpha 2' WHERE id = 10")
        .execute(&c.pool)
        .await
        .unwrap();
    assert!(ids(&c.sync(Some(&t)).await).is_empty());
    assert_eq!(
        ids(&c.sync(None).await),
        ["NewEntitlement 1", "NewEntitlement 4"]
    );
}

#[sqlx::test(migrations = false)]
async fn metadata_and_state_follow_the_acl(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let m = c
        .call("GET", &format!("/v1/library/{}/metadata", book(1)), None)
        .await;
    assert_eq!(
        (m.status, m.body[0]["Title"].clone()),
        (200, json!("Alpha"))
    );
    for n in [2, 3, 99] {
        assert_eq!(
            c.call("GET", &format!("/v1/library/{}/metadata", book(n)), None)
                .await
                .status,
            404,
            "{n}"
        );
        assert_eq!(
            c.call("GET", &format!("/v1/library/{}/state", book(n)), None)
                .await
                .status,
            404,
            "{n}"
        );
        let put = json!({"ReadingStates": [{"EntitlementId": book(n), "CurrentBookmark": {"ProgressPercent": 50}}]});
        assert_eq!(
            c.call("PUT", &format!("/v1/library/{}/state", book(n)), Some(put))
                .await
                .status,
            404,
            "{n}"
        );
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM playback_states")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    assert_eq!(
        c.call(
            "GET",
            &format!("/kobo-no/{}/320/480/false/image.jpg", book(1)),
            None
        )
        .await
        .status,
        404
    );
    for n in [1, 2] {
        let r = c
            .call(
                "GET",
                &format!("/{}/320/480/false/image.jpg", book(n)),
                None,
            )
            .await;
        assert_eq!(r.status, 404, "no poster, or no access: {n}");
    }
}

fn state_put(n: i32, pct: f64, status: &str, loc: &str) -> Value {
    json!({"ReadingStates": [{
        "EntitlementId": book(n), "Created": "2026-11-03T10:00:00Z", "LastModified": "2026-11-03T10:00:00Z",
        "PriorityTimestamp": "2026-11-03T10:00:00Z",
        "StatusInfo": {"Status": status, "TimesStartedReading": 1},
        "Statistics": {"SpentReadingMinutes": 3, "RemainingTimeMinutes": 9},
        "CurrentBookmark": {"ProgressPercent": pct, "ContentSourceProgressPercent": 10.0,
            "Location": {"Value": loc, "Type": "KoboSpan", "Source": "OEBPS/ch2.xhtml"}},
    }]})
}

#[sqlx::test(migrations = false)]
async fn progress_round_trips_and_feeds_the_shared_progression(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let path = format!("/v1/library/{}/state", book(1));
    let put = c
        .call(
            "PUT",
            &path,
            Some(state_put(1, 42.5, "Reading", "kobo.3.1")),
        )
        .await;
    assert_eq!(put.status, 200);
    assert_eq!(put.body["RequestResult"], "Success");
    assert_eq!(put.body["UpdateResults"][0]["EntitlementId"], book(1));
    let row: (f64, Option<Value>, bool) =
        sqlx::query_as(r#"SELECT progression, locator, completed FROM playback_states WHERE "userId" = 1 AND "itemId" = 1"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(row, (0.425, None, false));
    let got = c.call("GET", &path, None).await;
    let s = &got.body[0];
    assert_eq!(s["CurrentBookmark"]["Location"]["Value"], "kobo.3.1");
    assert_eq!(s["StatusInfo"]["Status"], "Reading");

    // not echoed back by the next sync
    let t = c.sync(None).await.sync_token.unwrap();
    assert!(ids(&c.sync(Some(&t)).await).is_empty());

    // another reader moves on: the device is told the percentage only
    sqlx::query(
        r#"UPDATE playback_states SET progression = 0.9 WHERE "userId" = 1 AND "itemId" = 1"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let got = c.call("GET", &path, None).await;
    let b = &got.body[0]["CurrentBookmark"];
    assert!(b["Location"].is_null());
    assert!((b["ProgressPercent"].as_f64().unwrap() - 90.0).abs() < 1e-9);
    let t2 = c.sync(Some(&t)).await.sync_token.unwrap();
    assert_eq!(ids(&c.sync(Some(&t2)).await), Vec::<String>::new());

    // finished, from the status alone
    c.call(
        "PUT",
        &path,
        Some(state_put(1, 12.0, "Finished", "kobo.9.9")),
    )
    .await;
    let done: (f64, bool) =
        sqlx::query_as(r#"SELECT progression, completed FROM playback_states WHERE "itemId" = 1"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(done, (1.0, true));
    assert_eq!(
        c.call("GET", &path, None).await.body[0]["StatusInfo"]["Status"],
        "Finished"
    );

    // a body that names no state of this book
    let bad = c
        .call("PUT", &path, Some(state_put(4, 5.0, "Reading", "x")))
        .await;
    assert_eq!(bad.status, 400);
}

#[sqlx::test(migrations = false)]
async fn a_state_changed_elsewhere_is_sent_as_a_changed_reading_state(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let t = c.sync(None).await.sync_token.unwrap();
    let t = c.sync(Some(&t)).await.sync_token.unwrap();
    sqlx::query(
        r#"INSERT INTO playback_states ("userId", "itemId", progression) VALUES (1, 1, 0.3)"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let r = c.sync(Some(&t)).await;
    assert_eq!(ids(&r), ["ChangedReadingState 1"]);
    let b = &r.body[0]["ChangedReadingState"]["ReadingState"]["CurrentBookmark"];
    assert!((b["ProgressPercent"].as_f64().unwrap() - 30.0).abs() < 1e-9);
}

#[sqlx::test(migrations = false)]
async fn shelves_sync_both_ways_without_echo(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let t = c.sync(None).await.sync_token.unwrap();
    let t = c.sync(Some(&t)).await.sync_token.unwrap();

    let body = json!({"Name": " Holiday ", "Items": [
        {"RevisionId": book(1), "Type": "ProductRevisionTagItem"},
        {"RevisionId": book(2), "Type": "ProductRevisionTagItem"},
        {"RevisionId": "junk", "Type": "ProductRevisionTagItem"}]});
    let made = c.call("POST", "/v1/library/tags", Some(body.clone())).await;
    assert_eq!(made.status, 201);
    let tag = made.body.as_str().unwrap().to_owned();
    let again = c.call("POST", "/v1/library/tags", Some(body)).await;
    assert_eq!(again.body.as_str().unwrap(), tag, "same name, same shelf");
    let items: Vec<i32> =
        sqlx::query_scalar(r#"SELECT "itemId" FROM playlist_items ORDER BY position"#)
            .fetch_all(&c.pool)
            .await
            .unwrap();
    assert_eq!(items, [1], "the unreadable and the unknown are skipped");
    assert_eq!(
        c.call("POST", "/v1/library/tags", Some(json!({"Name": "  "})))
            .await
            .status,
        400
    );

    let t = c.sync(Some(&t)).await;
    assert!(
        ids(&t).is_empty(),
        "the device made it, so it is not echoed"
    );
    let t = t.sync_token.unwrap();
    let list = c.call("GET", "/v1/library/tags", None).await;
    assert_eq!(list.body[0]["Name"], "Holiday");
    assert_eq!(list.body[0]["Items"][0]["RevisionId"], book(1));

    let add = json!({"Items": [{"RevisionId": book(4)}]});
    assert_eq!(
        c.call("POST", &format!("/v1/library/tags/{tag}/items"), Some(add))
            .await
            .status,
        201
    );
    assert_eq!(
        c.call(
            "PUT",
            &format!("/v1/library/tags/{tag}"),
            Some(json!({"Name": "Trip"}))
        )
        .await
        .status,
        200
    );
    let list = c.call("GET", "/v1/library/tags", None).await;
    assert_eq!(
        (
            list.body[0]["Name"].clone(),
            list.body[0]["Items"].as_array().unwrap().len()
        ),
        (json!("Trip"), 2)
    );
    let del = json!({"Items": [{"RevisionId": book(1)}]});
    assert_eq!(
        c.call(
            "POST",
            &format!("/v1/library/tags/{tag}/items/delete"),
            Some(del)
        )
        .await
        .status,
        200
    );

    // made in Fliks: new on the device, then changed, then deleted
    sqlx::query(
        r#"INSERT INTO playlists (id, name, "ownerId") VALUES (50, 'Web', 1), (51, 'Other', 2)"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO playlist_items ("playlistId", "itemId", position) VALUES (50, 4, 0)"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let r = c.sync(Some(&t)).await;
    assert_eq!(ids(&r), ["NewTag 32"]);
    let t = r.sync_token.unwrap();
    sqlx::query(r#"UPDATE playlists SET name = 'Web 2' WHERE id = 50"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let r = c.sync(Some(&t)).await;
    assert_eq!(ids(&r), ["ChangedTag 32"]);
    let t = r.sync_token.unwrap();
    sqlx::query("DELETE FROM playlists WHERE id = 50")
        .execute(&c.pool)
        .await
        .unwrap();
    let r = c.sync(Some(&t)).await;
    assert_eq!(ids(&r), ["DeletedTag 32"]);

    assert_eq!(
        c.call("DELETE", &format!("/v1/library/tags/{tag}"), None)
            .await
            .status,
        200
    );
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM playlists WHERE \"ownerId\" = 1")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
    let other = format!("f11c5a60-0000-4000-8000-{:012x}", 51);
    assert_eq!(
        c.call("DELETE", &format!("/v1/library/tags/{other}"), None)
            .await
            .status,
        404,
        "not theirs"
    );
}

#[sqlx::test(migrations = false)]
async fn the_store_proxy_is_off_by_default_and_unknown_paths_get_stubs(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let r = c.call("GET", "/v1/user/loyalty/benefits", None).await;
    assert_eq!((r.status, r.body), (200, json!({"Benefits": {}})));
    let r = c.call("GET", "/v1/some/new/thing", None).await;
    assert_eq!((r.status, r.body), (200, json!({})));
    let r = c
        .call(
            "POST",
            "/v1/auth/device",
            Some(json!({"AffiliateName": "Kobo"})),
        )
        .await;
    assert_eq!(r.body["TokenType"], "Bearer");
    assert_eq!(
        c.raw("GET", "fkd_x", "/v1/some/new/thing", None, None)
            .await
            .status,
        401
    );
}

#[sqlx::test(migrations = false)]
async fn only_shelves_made_of_readable_books_are_exposed_and_never_wiped(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    sqlx::raw_sql(
        r#"
        INSERT INTO playlists (id, name, "ownerId") VALUES (60, 'Movies', 1), (61, 'Mixed', 1), (62, 'Hidden', 1);
        INSERT INTO playlist_items ("playlistId", "itemId", position) VALUES (60, 2, 0), (61, 1, 0), (61, 2, 1), (62, 3, 0);
        "#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let list = c.call("GET", "/v1/library/tags", None).await;
    let names: Vec<_> = list
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["Name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        names,
        ["Mixed"],
        "a playlist of other items, or of none the device can read, is no shelf"
    );
    assert_eq!(list.body[0]["Items"].as_array().unwrap().len(), 1);
    let mixed = format!("f11c5a60-0000-4000-8000-{:012x}", 61);
    let r = c
        .call(
            "PUT",
            &format!("/v1/library/tags/{mixed}"),
            Some(json!({"Name": "Renamed"})),
        )
        .await;
    assert_eq!(r.status, 409);
    assert_eq!(
        c.call("DELETE", &format!("/v1/library/tags/{mixed}"), None)
            .await
            .status,
        200
    );
    let left: Vec<i32> =
        sqlx::query_scalar(r#"SELECT "itemId" FROM playlist_items WHERE "playlistId" = 61"#)
            .fetch_all(&c.pool)
            .await
            .unwrap();
    assert_eq!(left, [2], "only the books left the playlist");
    let name: String = sqlx::query_scalar("SELECT name FROM playlists WHERE id = 61")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(name, "Mixed");
    let r = c
        .call(
            "POST",
            "/v1/library/tags",
            Some(json!({"Name": "Movies", "Items": []})),
        )
        .await;
    assert_ne!(
        r.body.as_str().unwrap(),
        format!("f11c5a60-0000-4000-8000-{:012x}", 60),
        "a mixed playlist is not reused"
    );
}

#[sqlx::test(migrations = false)]
async fn a_web_edit_before_a_device_rename_is_not_lost(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let made = c
        .call(
            "POST",
            "/v1/library/tags",
            Some(json!({"Name": "S", "Items": [{"RevisionId": book(1)}]})),
        )
        .await;
    let tag = made.body.as_str().unwrap().to_owned();
    let t = c.sync(None).await;
    let t = c.sync(t.sync_token.as_deref()).await.sync_token.unwrap();
    sqlx::query(r#"UPDATE playlists SET name = 'Web' WHERE "ownerId" = 1"#)
        .execute(&c.pool)
        .await
        .unwrap();
    c.call(
        "PUT",
        &format!("/v1/library/tags/{tag}"),
        Some(json!({"Name": "Dev"})),
    )
    .await;
    let r = c.sync(Some(&t)).await;
    assert_eq!(
        ids(&r).len(),
        1,
        "the shelf is still sent: the device had missed the web edit"
    );
}

#[sqlx::test(migrations = false)]
async fn initialization_carries_the_native_resources_under_ours(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let res = c.call("GET", "/v1/initialization", None).await.body["Resources"].clone();
    assert!(
        res["account_page"]
            .as_str()
            .unwrap()
            .starts_with("https://www.kobo.com")
    );
    assert!(res.as_object().unwrap().len() > 100);
    assert!(
        res["library_sync"]
            .as_str()
            .unwrap()
            .contains("kobo.example/kobo/")
    );
    assert!(
        res["reading_state"]
            .as_str()
            .unwrap()
            .ends_with("/v1/library/{Ids}/state")
    );
}

#[sqlx::test(migrations = false)]
async fn a_change_of_the_edition_or_the_credits_changes_the_entitlement(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let t = c.sync(None).await.sync_token.unwrap();
    let t = c.sync(Some(&t)).await.sync_token.unwrap();
    sqlx::query("UPDATE editions SET publisher = 'P' WHERE id = 1")
        .execute(&c.pool)
        .await
        .unwrap();
    let r = c.sync(Some(&t)).await;
    assert_eq!(ids(&r), ["ChangedEntitlement 1"]);
    let t = c.sync(r.sync_token.as_deref()).await.sync_token.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO persons (id, name) VALUES (900, 'Ann');
           INSERT INTO media_credits ("mediaId", "personId", role) VALUES (10, 900, 'author');"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let r = c.sync(Some(&t)).await;
    assert_eq!(ids(&r), ["ChangedEntitlement 1"]);
    let m = &r.body[0]["ChangedEntitlement"]["BookMetadata"];
    assert_eq!(
        m["ContributorRoles"][0],
        json!({"Name": "Ann", "Role": "Author"})
    );
    assert_eq!(m["DownloadUrls"][0]["Format"], "KEPUB");
}

#[sqlx::test(migrations = false)]
async fn a_sync_token_naming_too_many_ids_is_no_token(pool: PgPool) {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let (c, _) = ctx(pool).await;
    let t = c.sync(None).await.sync_token.unwrap();
    c.sync(Some(&t)).await;
    let big =
        STANDARD.encode(json!({"v": 1, "t": 0, "b": (1..=101).collect::<Vec<i32>>()}).to_string());
    assert_eq!(
        ids(&c.sync(Some(&big)).await),
        ["NewEntitlement 1", "NewEntitlement 4"]
    );
}

#[sqlx::test(migrations = false)]
async fn reading_state_edge_cases(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let path = format!("/v1/library/{}/state", book(1));
    c.call("PUT", &path, Some(state_put(1, 40.0, "Reading", "a")))
        .await;
    let mut unread = state_put(1, 0.0, "ReadyToRead", "a");
    unread["ReadingStates"][0]
        .as_object_mut()
        .unwrap()
        .remove("CurrentBookmark");
    c.call("PUT", &path, Some(unread)).await;
    let p: Option<f64> =
        sqlx::query_scalar(r#"SELECT progression FROM playback_states WHERE "itemId" = 1"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(p, Some(0.0), "ready to read with no bookmark is unread");

    let t = c.sync(None).await.sync_token.unwrap();
    let t = c.sync(Some(&t)).await.sync_token.unwrap();
    let mut big = state_put(1, 60.0, "Reading", "b");
    big["ReadingStates"][0]["Statistics"] = json!({"Pad": "x".repeat(20_000)});
    assert_eq!(c.call("PUT", &path, Some(big)).await.status, 200);
    assert!(
        ids(&c.sync(Some(&t)).await).is_empty(),
        "an oversized state is not echoed back"
    );
}

#[sqlx::test(migrations = false)]
async fn last_used_is_stamped_at_most_once_a_minute(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    sqlx::query(r#"UPDATE device_tokens SET "lastUsedAt" = now() - interval '10 seconds' WHERE kind = 'kobo' AND "userId" = 1"#).execute(&c.pool).await.unwrap();
    let before: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar(r#"SELECT "lastUsedAt" FROM device_tokens WHERE "userId" = 1"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    c.call("GET", "/v1/initialization", None).await;
    let after: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar(r#"SELECT "lastUsedAt" FROM device_tokens WHERE "userId" = 1"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(before, after);
}

#[sqlx::test(migrations = false)]
async fn unknown_paths_and_methods_are_a_json_404(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    for (m, p) in [
        ("GET", format!("/v1/library/{}", book(1))),
        ("POST", "/v1/library/sync".to_owned()),
        ("GET", "/other".to_owned()),
        ("GET", String::new()),
    ] {
        let r = c.call(m, &p, None).await;
        assert_eq!(
            (r.status, r.body["message"].as_str()),
            (404, Some("Not found")),
            "{m} {p}"
        );
    }
}

#[sqlx::test(migrations = false)]
async fn store_books_are_proxied_or_refused_by_the_setting(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let store = "0b6ee1c2-aaaa-4bbb-8ccc-123456789abc";
    let r = c
        .call("GET", &format!("/{store}/100/200/false/image.jpg"), None)
        .await;
    assert_eq!(r.status, 404, "off: no redirect");
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('kobo_store_proxy', 'true')")
        .execute(&c.pool)
        .await
        .unwrap();
    let res = c
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/kobo/{}/{store}/100/200/false/image.jpg", c.token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 307);
    assert_eq!(
        res.headers()["location"],
        format!("https://cdn.kobo.com/book-images/{store}/100/200/false/image.jpg")
    );
    let ours = c
        .call(
            "GET",
            &format!("/{}/100/200/false/image.jpg", book(2)),
            None,
        )
        .await;
    assert_eq!(
        ours.status, 404,
        "an unreadable book of ours is never sent to the store"
    );
}

#[sqlx::test(migrations = false)]
async fn the_auth_stub_echoes_the_user_key(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let r = c
        .call("POST", "/v1/auth/device", Some(json!({"UserKey": "abc"})))
        .await;
    assert_eq!(r.body["UserKey"], "abc");
}

#[sqlx::test(migrations = false)]
async fn with_the_proxy_on_store_books_state_and_deletes_reach_the_store(pool: PgPool) {
    use std::sync::{Arc, Mutex};
    let (mut c, _) = ctx(pool).await;
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let log = seen.clone();
    let store = Router::new().fallback(move |req: Request<Body>| {
        let log = log.clone();
        async move {
            let line = format!("{} {}", req.method(), req.uri().path());
            log.lock().unwrap().push(line.clone());
            if line.contains("redirect") {
                return axum::response::Response::builder()
                    .status(302)
                    .header("location", "https://elsewhere.example/")
                    .body(Body::empty())
                    .unwrap();
            }
            let body = if line.ends_with("/v1/initialization") {
                json!({"Resources": {"zzz": "x", "kobo_subscriptions_enabled": "True"}})
            } else {
                json!({"from": "store"})
            };
            axum::response::Response::builder()
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, store).await.unwrap() });
    let mut st = AppState::new(c.pool.clone(), Config::from_lookup(|_| None), SECRET);
    st.kobo_store = format!("http://{addr}").into();
    c.app = kobo::router().with_state(st);
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('kobo_store_proxy', 'true')")
        .execute(&c.pool)
        .await
        .unwrap();
    let foreign = "0b6ee1c2-aaaa-4bbb-8ccc-123456789abc";
    let put = state_put(1, 5.0, "Reading", "x");
    let r = c
        .call("PUT", &format!("/v1/library/{foreign}/state"), Some(put))
        .await;
    assert_eq!((r.status, r.body["from"].as_str()), (200, Some("store")));
    let r = c
        .call("GET", &format!("/v1/library/{foreign}/state"), None)
        .await;
    assert_eq!(r.body["from"], "store");
    let r = c
        .call("DELETE", &format!("/v1/library/{foreign}"), None)
        .await;
    assert_eq!(r.status, 200);
    let r = c.call("GET", "/v1/redirect/me", None).await;
    assert_eq!(r.status, 502, "a store redirect is no answer");
    let seen_now = seen.lock().unwrap().clone();
    assert!(
        seen_now.contains(&format!("PUT /v1/library/{foreign}/state")),
        "{seen_now:?}"
    );
    assert!(seen_now.contains(&format!("DELETE /v1/library/{foreign}")));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM playback_states")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0, "nothing of a store book is written here");

    let res = c.call("GET", "/v1/initialization", None).await.body["Resources"].clone();
    assert_eq!(res["zzz"], "x", "the store's own keys are merged");
    assert_eq!(
        res["kobo_subscriptions_enabled"], "False",
        "ours win over the store"
    );
    assert_eq!(res["kobo_superpoints_enabled"], "False");
}

#[sqlx::test(migrations = false)]
async fn a_reused_playlist_the_device_never_saw_is_still_sent(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let t = c.sync(None).await.sync_token.unwrap();
    let t = c.sync(Some(&t)).await.sync_token.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO playlists (id, name, "ownerId") VALUES (70, 'Old', 1);
           INSERT INTO playlist_items ("playlistId", "itemId", position) VALUES (70, 1, 0);"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let made = c
        .call(
            "POST",
            "/v1/library/tags",
            Some(json!({"Name": "Old", "Items": [{"RevisionId": book(4)}]})),
        )
        .await;
    assert_eq!(
        made.body.as_str().unwrap(),
        format!("f11c5a60-0000-4000-8000-{:012x}", 70)
    );
    let r = c.sync(Some(&t)).await;
    assert_eq!(
        ids(&r),
        ["NewTag 46"],
        "the device had never seen the playlist, so it gets all of it"
    );
    assert_eq!(
        r.body[0]["NewTag"]["Tag"]["Items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[sqlx::test(migrations = false)]
async fn a_crafted_delete_never_removes_a_playlist_the_device_cannot_see(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    sqlx::query(r#"INSERT INTO playlists (id, name, "ownerId") VALUES (71, 'Empty', 1)"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let tag = format!("f11c5a60-0000-4000-8000-{:012x}", 71);
    assert_eq!(
        c.call("DELETE", &format!("/v1/library/tags/{tag}"), None)
            .await
            .status,
        404
    );
    assert_eq!(
        c.call(
            "PUT",
            &format!("/v1/library/tags/{tag}"),
            Some(json!({"Name": "X"}))
        )
        .await
        .status,
        404
    );
    let name: String = sqlx::query_scalar("SELECT name FROM playlists WHERE id = 71")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(name, "Empty");
}

#[sqlx::test(migrations = false)]
async fn native_resources_keep_json_values_and_the_store_host(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let res = c.call("GET", "/v1/initialization", None).await.body["Resources"].clone();
    assert_eq!(
        res["blackstone_header"],
        json!({"key": "x-amz-request-payer", "value": "requester"})
    );
    assert!(
        res["free_books_page"]["FR"]
            .as_str()
            .unwrap()
            .contains("livres-gratuits")
    );
    assert_eq!(res["ppx_purchasing_url"], "https://purchasing.kobo.com");
    assert_eq!(
        res["category_featured_lists"],
        "https://storeapi.kobo.com/v1/categories/{CategoryId}/featured"
    );
    assert!(!res.to_string().contains("storeapi.mobile.kobo.com"));
    for k in [
        "kobo_audiobooks_enabled",
        "kobo_subscriptions_enabled",
        "kobo_superpoints_enabled",
    ] {
        assert_eq!(res[k], "False", "{k}");
    }
}

fn epub(chapter: &str) -> Vec<u8> {
    use std::io::Write;
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let o = zip::write::SimpleFileOptions::default();
    let container = r#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;
    let opf = r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>"#;
    for (n, b) in [
        ("mimetype", "application/epub+zip"),
        ("META-INF/container.xml", container),
        ("content.opf", opf),
        ("c1.xhtml", chapter),
    ] {
        w.start_file(n, o).unwrap();
        w.write_all(b.as_bytes()).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// Puts `bytes` where item 1's file is, under a fresh folder root.
async fn place(c: &Ctx, bytes: &[u8]) -> std::path::PathBuf {
    let dir = scratch("lib");
    std::fs::write(dir.join("a.epub"), bytes).unwrap();
    sqlx::query("UPDATE library_folders SET path = $1 WHERE id = 1")
        .bind(dir.to_str().unwrap())
        .execute(&c.pool)
        .await
        .unwrap();
    dir
}

async fn download(
    c: &Ctx,
    token: &str,
    uuid: &str,
    range: Option<&str>,
) -> (u16, axum::http::HeaderMap, Vec<u8>) {
    let mut req = Request::builder()
        .uri(format!("/kobo/{token}/download/{uuid}/kepub"))
        .header("host", "kobo.example")
        .header("x-forwarded-proto", "https");
    if let Some(r) = range {
        req = req.header("range", r);
    }
    let res = c
        .app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let (status, h) = (res.status().as_u16(), res.headers().clone());
    let b = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, h, b.to_vec())
}

fn kepubs(c: &Ctx) -> Vec<String> {
    let mut v: Vec<_> = std::fs::read_dir(&c.cache)
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn text_of(zipped: &[u8], name: &str) -> String {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(zipped)).unwrap();
    let mut s = String::new();
    z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
    s
}

#[sqlx::test(migrations = false)]
async fn a_kepub_download_converts_once_per_file_version(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let dir = place(&c, &epub("<html><body><p>One. Two.</p></body></html>")).await;
    let (status, h, body) = download(&c, &c.token, &book(1), None).await;
    assert_eq!(status, 200);
    assert_eq!(h["content-type"], "application/epub+zip");
    assert!(
        h["content-disposition"]
            .to_str()
            .unwrap()
            .contains(".kepub.epub")
    );
    assert!(text_of(&body, "c1.xhtml").contains("koboSpan"));
    assert_eq!(kepubs(&c).len(), 1);

    // concurrent downloads of one version share the file
    let all = futures_join(&c).await;
    assert!(all.iter().all(|b| *b == body));
    assert_eq!(kepubs(&c).len(), 1);

    let (status, _, part) = download(&c, &c.token, &book(1), Some("bytes=0-3")).await;
    assert_eq!((status, part.as_slice()), (206, &body[..4]));

    // a hit refreshes the file's mtime, which is what eviction orders by
    let cached = c.cache.join(&kepubs(&c)[0]);
    let day_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(86400);
    std::fs::File::options()
        .append(true)
        .open(&cached)
        .unwrap()
        .set_modified(day_ago)
        .unwrap();
    download(&c, &c.token, &book(1), None).await;
    let age = std::fs::metadata(&cached)
        .unwrap()
        .modified()
        .unwrap()
        .elapsed()
        .unwrap();
    assert!(age < std::time::Duration::from_secs(3600));

    // a replaced file is a new version; the old one is dropped
    std::fs::write(
        dir.join("a.epub"),
        epub("<html><body><p>Changed text here.</p></body></html>"),
    )
    .unwrap();
    let (_, _, again) = download(&c, &c.token, &book(1), None).await;
    assert!(text_of(&again, "c1.xhtml").contains("Changed text here."));
    assert_eq!(kepubs(&c).len(), 1);
}

fn dup(c: &Ctx) -> Ctx {
    Ctx {
        app: c.app.clone(),
        pool: c.pool.clone(),
        token: c.token.clone(),
        cache: c.cache.clone(),
    }
}

async fn futures_join(c: &Ctx) -> Vec<Vec<u8>> {
    let mut set = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let c2 = dup(c);
        set.spawn(async move { download(&c2, &c2.token, &book(1), None).await.2 });
    }
    let mut out = vec![];
    while let Some(r) = set.join_next().await {
        out.push(r.unwrap());
    }
    out
}

#[sqlx::test(migrations = false)]
async fn a_book_that_cannot_be_converted_falls_back_to_the_epub(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    place(&c, b"this is not a zip").await;
    for _ in 0..2 {
        let (status, h, _) = download(&c, &c.token, &book(1), None).await;
        assert_eq!(status, 307);
        assert_eq!(
            h["location"],
            format!(
                "https://kobo.example/cred/{}/api/stream/1?download=1",
                c.token
            )
        );
    }
    assert!(kepubs(&c).is_empty());
}

#[sqlx::test(migrations = false)]
async fn the_kepub_download_follows_the_book_rules(pool: PgPool) {
    let (c, disabled) = ctx(pool).await;
    place(&c, &epub("<html><body><p>x</p></body></html>")).await;
    // another library, a PDF, an unknown uuid, a shape that names nothing, a missing file
    for uuid in [book(2), book(3), book(99), "nope".to_string(), book(4)] {
        assert_eq!(download(&c, &c.token, &uuid, None).await.0, 404, "{uuid}");
    }
    assert_eq!(download(&c, &disabled, &book(1), None).await.0, 401);
    let other = token(&c.pool, 1, Kind::Opds).await;
    assert_eq!(download(&c, &other, &book(1), None).await.0, 401);
    assert!(kepubs(&c).is_empty());
}

#[sqlx::test(migrations = false)]
async fn a_download_dropped_mid_conversion_does_not_corrupt_the_retry(pool: PgPool) {
    let (c, _) = ctx(pool).await;
    let last = "Last sentence here.";
    let chapter = format!(
        "<html><body><p>{}{last}</p></body></html>",
        "A sentence. ".repeat(60_000)
    );
    place(&c, &epub(&chapter)).await;
    let first = {
        let c2 = dup(&c);
        tokio::spawn(async move { download(&c2, &c2.token, &book(1), None).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    first.abort();
    let (status, _, body) = download(&c, &c.token, &book(1), None).await;
    assert_eq!(status, 200);
    assert!(text_of(&body, "c1.xhtml").contains(last));
    let files = kepubs(&c);
    assert_eq!(files.len(), 1, "{files:?}");
    assert!(files[0].ends_with(".kepub.epub"));
}

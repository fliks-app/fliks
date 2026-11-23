//! Problem reports (`docs/spec/problems.md`) through the real router on a fresh database.
use crate::session;
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    routing::post,
};
use fliks_server::sync::MutexExt;
use fliks_server::{app, config::Config, problems, push, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

/// Users: 1 admin, 2 reporter, 3 manager of library 1, 4 reader of library 2 only, 5 manager of library 2.
/// Media: 10 movie (files 1 and 4, item 1), 11 series (item 2 = S02E03 file 2, item 3 = S02E04 file 3), 12 movie of library 2.
struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
    admin: String,
    rep: String,
    mgr: String,
    blind: String,
    mgr2: String,
    hook: Arc<Mutex<Vec<Value>>>,
}

async fn capture(State(h): State<Arc<Mutex<Vec<Value>>>>, Json(b): Json<Value>) -> StatusCode {
    h.lock_clean().push(b);
    StatusCode::OK
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let hook: Arc<Mutex<Vec<Value>>> = Arc::default();
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/hook", l.local_addr().unwrap());
    let router = Router::new()
        .route("/hook", post(capture))
        .with_state(hook.clone());
    tokio::spawn(async { axum::serve(l, router).await.unwrap() });
    sqlx::query(
        r#"INSERT INTO notification_connections (name, type, settings, events, enabled)
           VALUES ('hook', 'webhook', $1, $2, true)"#,
    )
    .bind(json!({"url": url}))
    .bind(json!(["problem.created", "problem.resolved"]))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES
          (1, 'Viewer', '["media.read"]', false), (2, 'Mgr', '["media.read","requests.manage"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES
          (1, 'admin', true, NULL), (2, 'rep', false, 1), (3, 'mgr', false, 2), (4, 'blind', false, 1), (5, 'mgr2', false, 2);
        INSERT INTO libraries (id, name) VALUES (1, 'L1'), (2, 'L2');
        INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '/tmp/problems-1'), (2, 2, '/tmp/problems-2');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2), (1, 3), (2, 4), (2, 5);
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES
          (10, 'Alpha', 'movie', 1, 'a'), (11, 'Show', 'series', 1, 's'), (12, 'Hidden', 'movie', 2, 'h');
        INSERT INTO editions (id, "mediaId", family) VALUES (1, 10, 'video'), (2, 11, 'video'), (3, 12, 'video');
        INSERT INTO item_groups (id, "mediaId", number) VALUES (1, 11, 2);
        INSERT INTO items (id, "mediaId", "editionId", "groupId", number) VALUES
          (1, 10, 1, NULL, NULL), (2, 11, 2, 1, 3), (3, 11, 2, 1, 4), (4, 12, 3, NULL, NULL);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality) VALUES
          (1, 10, 1, 'a/a.mkv', 100, 'q'), (4, 10, 1, 'a/b.mkv', 100, 'q'), (2, 11, 1, 's/e3.mkv', 100, 'q'),
          (3, 11, 1, 's/e4.mkv', 100, 'q'), (5, 12, 2, 'h/h.mkv', 100, 'q');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (1, 4, 10, 1, 0), (2, 2, 11, 0, 0), (3, 3, 11, 0, 0), (4, 5, 12, 0, 0);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    Ctx {
        admin: session::token(&st, 1, "admin").await,
        rep: session::token(&st, 2, "rep").await,
        mgr: session::token(&st, 3, "mgr").await,
        blind: session::token(&st, 4, "blind").await,
        mgr2: session::token(&st, 5, "mgr2").await,
        app: app::router(st.clone(), None, std::env::temp_dir(), None),
        st,
        pool,
        hook,
    }
}

async fn call(c: &Ctx, method: &str, uri: &str, token: &str, body: Option<Value>) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"));
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let res = c
        .app
        .clone()
        .oneshot(req.body(body).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

async fn report(c: &Ctx, token: &str, media: i32, body: Value) -> (u16, Value) {
    call(
        c,
        "POST",
        &format!("/api/media/{media}/problems"),
        token,
        Some(body),
    )
    .await
}

async fn status_of(c: &Ctx, id: i64) -> String {
    sqlx::query_scalar("SELECT status FROM media_issues WHERE id = $1")
        .bind(id as i32)
        .fetch_one(&c.pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = false)]
async fn create_gates_duplicates_and_cap(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, row) = report(
        &c,
        &c.rep,
        10,
        json!({"kind": "video", "file": null, "note": "grainy"}),
    )
    .await;
    assert_eq!(s, 400, "{row}");
    let (s, row) = report(
        &c,
        &c.rep,
        10,
        json!({"kind": "video", "mediaFileId": 1, "note": "grainy"}),
    )
    .await;
    assert_eq!(
        (s, row["status"].clone(), row["fileSize"].clone()),
        (201, json!("open"), json!(100))
    );
    assert_eq!(row["file"]["name"], "a.mkv");
    assert_eq!(row["user"]["username"], "rep");
    assert_eq!(row["commentCount"], 1);
    let (s, b) = report(&c, &c.rep, 10, json!({"kind": "video", "mediaFileId": 1})).await;
    assert_eq!(
        (s, b["message"].clone()),
        (409, json!("problem_already_open"))
    );
    assert_eq!(report(&c, &c.rep, 10, json!({"kind": "nope"})).await.0, 400);
    assert_eq!(
        report(
            &c,
            &c.rep,
            10,
            json!({"kind": "audio", "itemId": 1, "seasonNumber": 1})
        )
        .await
        .0,
        400
    );
    assert_eq!(
        report(&c, &c.rep, 10, json!({"kind": "audio", "itemId": 2}))
            .await
            .0,
        400
    );
    assert_eq!(
        report(&c, &c.rep, 10, json!({"kind": "audio", "mediaFileId": 2}))
            .await
            .0,
        400
    );
    assert_eq!(
        report(&c, &c.rep, 12, json!({"kind": "audio"})).await.0,
        404
    );
    assert_eq!(
        report(&c, &c.rep, 10, json!({"kind": "audio", "mediaFileId": 99}))
            .await
            .0,
        404
    );
    assert_eq!(
        report(&c, &c.rep, 12, json!({"kind": "audio", "mediaFileId": 5}))
            .await
            .0,
        404
    );
    // an episode report keeps its numbers and pins the only file of the item
    let (s, ep) = report(&c, &c.rep, 11, json!({"kind": "subtitles", "itemId": 2})).await;
    assert_eq!(
        (
            s,
            ep["seasonNumber"].clone(),
            ep["episodeNumber"].clone(),
            ep["file"]["id"].clone()
        ),
        (201, json!(2), json!(3), json!(2))
    );
    // a season pins nothing; a whole title with two files pins nothing
    let (_, season) = report(&c, &c.rep, 11, json!({"kind": "other", "seasonNumber": 2})).await;
    assert!(season["file"].is_null() && season["fileSize"].is_null());
    let (_, title) = report(&c, &c.rep, 10, json!({"kind": "other"})).await;
    assert!(title["file"].is_null());
    // the cap counts active reports of the user
    sqlx::query(
        r#"INSERT INTO media_issues ("userId", "mediaId", "seasonNumber", "issueKind")
           SELECT 2, 11, n + 10, 'other' FROM generate_series(1, 16) n"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let (s, b) = report(&c, &c.rep, 11, json!({"kind": "playback"})).await;
    assert_eq!((s, b["message"].clone()), (409, json!("problem_cap")));
}

#[sqlx::test(migrations = false)]
async fn transitions_and_permissions(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, row) = report(
        &c,
        &c.rep,
        10,
        json!({"kind": "video", "mediaFileId": 1, "note": "n"}),
    )
    .await;
    let id = row["id"].as_i64().unwrap();
    let uri = format!("/api/problems/{id}");
    sqlx::query(
        r#"INSERT INTO playback_qoe_sessions ("sessionId", "userId", "mediaFileId", "startedAt", "lastSeenAt", "stallCount")
           VALUES ('s1', 2, 1, now() - interval '1 hour', now() - interval '1 hour', 7)"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    // only the reporter and the managers of the library read it
    assert_eq!(call(&c, "GET", &uri, &c.blind, None).await.0, 403);
    assert_eq!(call(&c, "GET", &uri, &c.mgr2, None).await.0, 403);
    let (s, d) = call(&c, "GET", &uri, &c.mgr, None).await;
    assert_eq!(
        (
            s,
            d["playback"]["stallCount"].clone(),
            d["comments"].as_array().unwrap().len()
        ),
        (200, json!(7), 1)
    );
    let (_, d) = call(&c, "GET", &uri, &c.rep, None).await;
    assert!(d.get("playback").is_none());
    // a manager's comment acknowledges; the reporter's does not change the state
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/comments"),
            &c.rep,
            Some(json!({"message": "still"}))
        )
        .await
        .0,
        201
    );
    assert_eq!(status_of(&c, id).await, "open");
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/comments"),
            &c.mgr,
            Some(json!({"message": "looking"}))
        )
        .await
        .0,
        201
    );
    assert_eq!(status_of(&c, id).await, "acknowledged");
    let (_, list) = call(&c, "GET", "/api/problems?status=active", &c.rep, None).await;
    assert_eq!(list["data"][0]["lastReply"]["message"], "looking");
    // resolve and close are for managers, once
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/resolve"),
            &c.rep,
            Some(json!({}))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/resolve"),
            &c.mgr2,
            Some(json!({}))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(&c, "POST", &format!("{uri}/close"), &c.mgr, Some(json!({})))
            .await
            .0,
        400
    );
    let (s, r) = call(
        &c,
        "POST",
        &format!("{uri}/resolve"),
        &c.mgr,
        Some(json!({"reply": "replaced"})),
    )
    .await;
    assert_eq!(
        (
            s,
            r["status"].clone(),
            r["resolvedBy"]["username"].clone(),
            r["autoResolved"].clone()
        ),
        (201, json!("resolved"), json!("mgr"), json!(false))
    );
    let (s, b) = call(
        &c,
        "POST",
        &format!("{uri}/close"),
        &c.mgr,
        Some(json!({"reason": "x"})),
    )
    .await;
    assert_eq!(
        (s, b["message"].clone()),
        (409, json!("problem_not_active"))
    );
    // the reporter reopens a fixed one with a note, inside 14 days only
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/reopen"),
            &c.rep,
            Some(json!({}))
        )
        .await
        .0,
        400
    );
    sqlx::query(
        r#"UPDATE media_issues SET "resolvedAt" = now() - interval '15 days' WHERE id = $1"#,
    )
    .bind(id as i32)
    .execute(&c.pool)
    .await
    .unwrap();
    let (s, b) = call(
        &c,
        "POST",
        &format!("{uri}/reopen"),
        &c.rep,
        Some(json!({"note": "again"})),
    )
    .await;
    assert_eq!(
        (s, b["message"].clone()),
        (409, json!("problem_reopen_window"))
    );
    sqlx::query(r#"UPDATE media_issues SET "resolvedAt" = now() WHERE id = $1"#)
        .bind(id as i32)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, r) = call(
        &c,
        "POST",
        &format!("{uri}/reopen"),
        &c.rep,
        Some(json!({"note": "again"})),
    )
    .await;
    assert_eq!(
        (s, r["status"].clone(), r["resolvedBy"].clone()),
        (201, json!("open"), Value::Null)
    );
    // closed: the reporter cannot reopen, a manager can without a note
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/close"),
            &c.mgr,
            Some(json!({"reason": "won't fix"}))
        )
        .await
        .0,
        201
    );
    let (s, b) = call(
        &c,
        "POST",
        &format!("{uri}/reopen"),
        &c.rep,
        Some(json!({"note": "n"})),
    )
    .await;
    assert_eq!(
        (s, b["message"].clone()),
        (409, json!("problem_reopen_denied"))
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/reopen"),
            &c.mgr,
            Some(json!({}))
        )
        .await
        .0,
        201
    );
    // withdraw: the reporter while active, never once fixed; a manager always
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{uri}/resolve"),
            &c.mgr,
            Some(json!({}))
        )
        .await
        .0,
        201
    );
    assert_eq!(call(&c, "DELETE", &uri, &c.rep, None).await.0, 403);
    assert_eq!(call(&c, "DELETE", &uri, &c.mgr, None).await.0, 200);
    assert_eq!(call(&c, "GET", &uri, &c.mgr, None).await.0, 404);
    // the admin webhook saw the lifecycle
    tokio::time::sleep(Duration::from_millis(300)).await;
    let events: Vec<String> = c
        .hook
        .lock_clean()
        .iter()
        .map(|b| b["event"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        events.iter().filter(|e| *e == "problem.created").count() >= 2,
        "{events:?}"
    );
    assert!(
        events.contains(&"problem.resolved".to_owned()),
        "{events:?}"
    );
}

#[sqlx::test(migrations = false)]
async fn reopen_repeats_the_duplicate_check(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = report(&c, &c.rep, 10, json!({"kind": "audio"})).await;
    let id = a["id"].as_i64().unwrap();
    call(
        &c,
        "POST",
        &format!("/api/problems/{id}/resolve"),
        &c.mgr,
        Some(json!({})),
    )
    .await;
    assert_eq!(
        report(&c, &c.rep, 10, json!({"kind": "audio"})).await.0,
        201
    );
    let (s, b) = call(
        &c,
        "POST",
        &format!("/api/problems/{id}/reopen"),
        &c.mgr,
        Some(json!({})),
    )
    .await;
    assert_eq!(
        (s, b["message"].clone()),
        (409, json!("problem_already_open"))
    );
}

#[sqlx::test(migrations = false)]
async fn list_scoping_counts_and_requests_stay_apart(pool: PgPool) {
    let c = ctx(pool).await;
    report(&c, &c.rep, 10, json!({"kind": "audio"})).await;
    let (_, other) = report(&c, &c.admin, 12, json!({"kind": "video"})).await;
    let (_, mine) = call(&c, "GET", "/api/problems", &c.rep, None).await;
    assert_eq!(mine["total"], 1);
    let (_, all) = call(&c, "GET", "/api/problems", &c.mgr, None).await;
    assert_eq!(
        all["total"], 1,
        "a manager reads the libraries they reach only"
    );
    let (_, theirs) = call(&c, "GET", "/api/problems", &c.mgr2, None).await;
    assert_eq!(theirs["data"][0]["id"], other["id"]);
    assert_eq!(
        call(&c, "GET", "/api/problems", &c.admin, None).await.1["total"],
        2
    );
    assert_eq!(
        call(&c, "GET", "/api/problems?status=wat", &c.mgr, None)
            .await
            .0,
        400
    );
    assert_eq!(
        call(&c, "GET", "/api/problems?status=resolved", &c.mgr, None)
            .await
            .1["total"],
        0
    );
    let counts = |t: String| {
        let c = &c;
        async move { call(c, "GET", "/api/counts", &t, None).await.1 }
    };
    let m = counts(c.mgr.clone()).await;
    assert_eq!(
        (
            m["openProblems"].clone(),
            m["pendingRequests"].clone(),
            m["attention"].clone()
        ),
        (json!(1), json!(0), json!(0))
    );
    assert_eq!(counts(c.rep.clone()).await["openProblems"], 0);
    let (_, reqs) = call(&c, "GET", "/api/requests", &c.admin, None).await;
    assert_eq!(reqs["total"], 0);
    // a media removed by any path takes its reports
    sqlx::query("DELETE FROM media WHERE id = 10")
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(
        call(&c, "GET", "/api/problems", &c.rep, None).await.1["total"],
        0
    );
}

#[sqlx::test(migrations = false)]
async fn only_managers_of_the_library_are_notified(pool: PgPool) {
    let c = ctx(pool).await;
    let mut one = push::approvers(&c.st, Some(1)).await;
    let mut two = push::approvers(&c.st, Some(2)).await;
    let mut any = push::approvers(&c.st, None).await;
    one.sort();
    two.sort();
    any.sort();
    assert_eq!((one, two, any), (vec![1, 3], vec![1, 5], vec![1, 3, 5]));
}

async fn resolved(c: &Ctx, id: i64) -> bool {
    status_of(c, id).await == "resolved"
}

#[sqlx::test(migrations = false)]
async fn auto_resolve_follows_the_replacement_of_the_reported_file(pool: PgPool) {
    let c = ctx(pool).await;
    // a replacement under a new id, added after the report
    let (_, a) = report(&c, &c.rep, 11, json!({"kind": "video", "itemId": 2})).await;
    let a = a["id"].as_i64().unwrap();
    // a same-path rewrite with another size
    let (_, b) = report(&c, &c.rep, 11, json!({"kind": "video", "itemId": 3})).await;
    let b = b["id"].as_i64().unwrap();
    // one of two versions deleted while the other is re-probed
    let (_, v) = report(&c, &c.rep, 10, json!({"kind": "video", "mediaFileId": 1})).await;
    let v = v["id"].as_i64().unwrap();
    problems::auto_resolve(&c.st, None).await.unwrap();
    assert!(!resolved(&c, a).await && !resolved(&c, b).await && !resolved(&c, v).await);
    sqlx::raw_sql(
        r#"DELETE FROM media_files WHERE id = 2;
           UPDATE media_files SET size = 999 WHERE id = 3;
           DELETE FROM media_files WHERE id = 1;
           UPDATE media_files SET size = 100 WHERE id = 4;
           WITH f AS (INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
                      VALUES (21, 11, 1, 's/e3b.mkv', 100, 'q') RETURNING id)
             INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) SELECT 2, id, 11, 0, 0 FROM f;"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    problems::auto_resolve(&c.st, Some(11)).await.unwrap();
    assert!(resolved(&c, a).await, "a new file of the item resolves");
    assert!(resolved(&c, b).await, "a rewritten file resolves");
    problems::auto_resolve(&c.st, None).await.unwrap();
    assert!(!resolved(&c, v).await, "a re-probe is not a replacement");
    let (_, row) = call(&c, "GET", &format!("/api/problems/{a}"), &c.rep, None).await;
    assert_eq!(
        (row["autoResolved"].clone(), row["resolvedBy"].clone()),
        (json!(true), Value::Null)
    );
    // a reopened report watches the file as it is now
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("/api/problems/{a}/reopen"),
            &c.rep,
            Some(json!({"note": "n"}))
        )
        .await
        .0,
        201
    );
    problems::auto_resolve(&c.st, None).await.unwrap();
    assert_eq!(status_of(&c, a).await, "open");
}

#[sqlx::test(migrations = false)]
async fn a_dropped_item_keeps_the_report_for_a_manager(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = report(&c, &c.rep, 11, json!({"kind": "video", "itemId": 3})).await;
    let a = a["id"].as_i64().unwrap();
    sqlx::raw_sql(
        r#"DELETE FROM items WHERE id = 3;
           DELETE FROM media_files WHERE id = 3;
           INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality) VALUES (20, 11, 1, 's/e5.mkv', 100, 'q');"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    problems::auto_resolve(&c.st, Some(11)).await.unwrap();
    assert_eq!(status_of(&c, a).await, "open");
    let (_, row) = call(&c, "GET", &format!("/api/problems/{a}"), &c.mgr, None).await;
    assert_eq!(
        (
            row["itemId"].clone(),
            row["seasonNumber"].clone(),
            row["episodeNumber"].clone()
        ),
        (Value::Null, json!(2), json!(4))
    );
}

#[sqlx::test(migrations = false)]
async fn another_episode_does_not_resolve_a_file_pinned_without_item(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = report(&c, &c.rep, 11, json!({"kind": "video", "mediaFileId": 2})).await;
    let a = a["id"].as_i64().unwrap();
    let h = problems::open_system(&c.pool, 3).await.unwrap().unwrap() as i64;
    sqlx::raw_sql(
        r#"DELETE FROM media_files WHERE id IN (2, 3);
           INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality) VALUES (30, 11, 1, 's/e9.mkv', 100, 'q');"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    problems::auto_resolve(&c.st, Some(11)).await.unwrap();
    assert!(!resolved(&c, a).await && !resolved(&c, h).await);
}

#[sqlx::test(migrations = false)]
async fn create_and_withdraw_loop_is_throttled(pool: PgPool) {
    let c = ctx(pool).await;
    let mut last = 0;
    for _ in 0..12 {
        let (s, row) = report(&c, &c.rep, 10, json!({"kind": "video"})).await;
        last = s;
        if s != 201 {
            break;
        }
        let id = row["id"].as_i64().unwrap();
        let (s, _) = call(&c, "DELETE", &format!("/api/problems/{id}"), &c.rep, None).await;
        assert!(s < 300);
    }
    assert_eq!(last, 429);
}

#[sqlx::test(migrations = false)]
async fn resolve_and_reopen_loop_is_throttled(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, row) = report(&c, &c.rep, 10, json!({"kind": "video"})).await;
    let id = row["id"].as_i64().unwrap();
    let mut last = 0;
    for _ in 0..12 {
        let (s, _) = call(
            &c,
            "POST",
            &format!("/api/problems/{id}/resolve"),
            &c.mgr,
            Some(json!({})),
        )
        .await;
        assert!(s < 300);
        let (s, _) = call(
            &c,
            "POST",
            &format!("/api/problems/{id}/reopen"),
            &c.rep,
            Some(json!({"note": "still broken"})),
        )
        .await;
        last = s;
        if s != 201 {
            break;
        }
    }
    assert_eq!(last, 429);
    assert_eq!(status_of(&c, id).await, "resolved");
}

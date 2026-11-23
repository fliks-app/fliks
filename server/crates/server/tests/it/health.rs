//! Health checks (`docs/spec/system.md` section H) and system problem reports through the real router.
use crate::session;
use axum::{
    Json, Router,
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    routing::post,
};
use fliks_server::sync::MutexExt;
use fliks_server::{app, config::Config, health, problems, queue::settings, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    admin: String,
    hook: Arc<Mutex<Vec<Value>>>,
}

async fn capture(State(h): State<Arc<Mutex<Vec<Value>>>>, Json(b): Json<Value>) -> StatusCode {
    h.lock_clean().push(b);
    StatusCode::OK
}

/// Library 1 holds `folder`; the free-space floor is off so a small CI disk raises nothing.
async fn ctx(pool: PgPool, folder: &str) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    settings::save(
        &pool,
        &settings::Settings {
            trash_min_free_gb: 0,
            ..settings::Settings::default()
        },
    )
    .await
    .unwrap();
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
    .bind(json!(["health.issue"]))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO users (id, username, "isAdmin") VALUES (1, 'admin', true), (2, 'rep', false);
        INSERT INTO libraries (id, name) VALUES (1, 'L1');
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (10, 'Alpha', 'movie', 1, 'a');
        INSERT INTO editions (id, "mediaId", family) VALUES (1, 10, 'video');
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 10, 1);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, $1)"#)
        .bind(folder)
        .execute(&pool)
        .await
        .unwrap();
    let st = AppState::new(pool, Config::from_lookup(|_| None), SECRET);
    Ctx {
        admin: session::token(&st, 1, "admin").await,
        app: app::router(st.clone(), None, std::env::temp_dir(), None),
        st,
        hook,
    }
}

async fn call(c: &Ctx, method: &str, uri: &str) -> (u16, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {}", c.admin))
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let res = c.app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

/// The webhook is fed by a spawned task: waits for `n` bodies, then a beat to catch a surplus one.
async fn sent(c: &Ctx, n: usize) -> Vec<Value> {
    for _ in 0..100 {
        if c.hook.lock_clean().len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    c.hook.lock_clean().clone()
}

async fn folder_checks(c: &Ctx) -> Vec<Value> {
    let (_, b) = call(c, "GET", "/api/system/checks").await;
    b["checks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|k| k["key"].as_str().unwrap().starts_with("folder:"))
        .cloned()
        .collect()
}

#[sqlx::test(migrations = false)]
async fn an_unreachable_folder_is_announced_once_and_survives_runs(pool: PgPool) {
    let dir = std::env::temp_dir().join(format!("fliks-health-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let c = ctx(pool, dir.to_str().unwrap()).await;

    health::run(&c.st).await.unwrap();
    let open = folder_checks(&c).await;
    assert_eq!(open.len(), 1);
    assert_eq!(open[0]["state"], "error");
    assert_eq!(open[0]["code"], "library_unmounted");
    assert_eq!(open[0]["link"], "/admin/settings/libraries/1");
    let (_, counts) = call(&c, "GET", "/api/counts").await;
    assert_eq!(counts["systemAttention"], 1);
    let since = open[0]["since"].clone();
    assert_eq!(sent(&c, 1).await.len(), 1);

    let (s, b) = call(&c, "POST", "/api/system/checks/run").await;
    assert_eq!(s, 201);
    assert!(b["checkedAt"].is_string());
    let again = folder_checks(&c).await;
    assert_eq!(again[0]["since"], since);
    assert_eq!(c.hook.lock_clean().len(), 1);

    std::fs::create_dir_all(&dir).unwrap();
    health::run(&c.st).await.unwrap();
    assert!(folder_checks(&c).await.is_empty());
    let (_, counts) = call(&c, "GET", "/api/counts").await;
    assert_eq!(counts["systemAttention"], 0);
    let seen = sent(&c, 2).await;
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0]["event"], "health.issue");
    assert!(
        seen[1]["message"]
            .as_str()
            .unwrap()
            .starts_with("Resolved: ")
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[sqlx::test(migrations = false)]
async fn an_empty_folder_that_holds_files_is_an_unmounted_share(pool: PgPool) {
    let dir = std::env::temp_dir().join(format!("fliks-health-empty-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let c = ctx(pool.clone(), dir.to_str().unwrap()).await;
    health::run(&c.st).await.unwrap();
    assert!(folder_checks(&c).await.is_empty());

    sqlx::query(
        r#"INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
           VALUES (1, 10, 1, 'a/a.mkv', 100, 'q')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    health::run(&c.st).await.unwrap();
    let open = folder_checks(&c).await;
    assert_eq!(open[0]["code"], "library_unmounted");
    std::fs::remove_dir_all(&dir).unwrap();
}

#[sqlx::test(migrations = false)]
async fn a_system_problem_has_no_reporter_and_outlives_users(pool: PgPool) {
    let c = ctx(pool.clone(), "/tmp").await;
    sqlx::query(
        r#"INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
           VALUES (1, 10, 1, 'a/a.mkv', 100, 'q')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO media_issues ("userId", "mediaId", "issueKind") VALUES (2, 10, 'video')"#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let id = problems::open_system(&pool, 1).await.unwrap().unwrap();
    assert!(problems::open_system(&pool, 1).await.unwrap().is_none());

    sqlx::query("DELETE FROM users WHERE id = 2")
        .execute(&pool)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM media_issues")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 1);

    let (s, b) = call(&c, "GET", "/api/problems?status=active").await;
    assert_eq!(s, 200);
    assert_eq!(b["total"], 1);
    assert_eq!(b["data"][0]["source"], "health");
    assert!(b["data"][0]["user"].is_null());
    assert_eq!(b["data"][0]["file"]["id"], 1);

    let (s, b) = call(&c, "GET", &format!("/api/problems/{id}")).await;
    assert_eq!(s, 200);
    assert_eq!(b["id"], id);
    let (s, b) = call(&c, "POST", &format!("/api/problems/{id}/resolve")).await;
    assert_eq!((s, b["status"].as_str()), (201, Some("resolved")));
}

#[sqlx::test(migrations = false)]
async fn only_a_health_row_may_lack_a_reporter(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name) VALUES (1, 'L1');
           INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (10, 'Alpha', 'movie', 1, 'a');"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let user_row =
        sqlx::query(r#"INSERT INTO media_issues ("mediaId", "issueKind") VALUES (10, 'video')"#)
            .execute(&pool)
            .await;
    assert!(user_row.is_err());
    sqlx::query(
        r#"INSERT INTO media_issues ("source", "mediaId", "issueKind") VALUES ('health', 10, 'other')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = false)]
async fn accounts_differing_by_case_are_one_warning_that_links_to_the_users(pool: PgPool) {
    let tmp = std::env::temp_dir();
    let c = ctx(pool.clone(), tmp.to_str().unwrap()).await;
    health::run(&c.st).await.unwrap();
    let case = |b: &Value| {
        b["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|k| k["code"] == "accounts_differ_by_case")
            .cloned()
    };
    assert!(case(&call(&c, "GET", "/api/system/checks").await.1).is_none());

    sqlx::query(r#"INSERT INTO users (id, username) VALUES (91, 'Rob'), (92, 'rob')"#)
        .execute(&pool)
        .await
        .unwrap();
    health::run(&c.st).await.unwrap();
    let k = case(&call(&c, "GET", "/api/system/checks").await.1).unwrap();
    assert_eq!(k["state"], "warn");
    assert_eq!(k["params"]["names"], "Rob, rob");
    assert_eq!(k["link"], "/admin/settings/users");
    assert!(c.hook.lock_clean().is_empty(), "a warning notifies nobody");
}

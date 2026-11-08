//! `/api/optimize/*`: profile CRUD and validation, library assignment, preview and counter.
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    admin: String,
}

async fn ctx(pool: &PgPool) -> Ctx {
    fliks_server::db::migrate(pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin") VALUES ('admin', true) RETURNING id"#,
    )
    .fetch_one(pool)
    .await
    .unwrap();
    let admin = session::token(&st, id, "admin").await;
    // Without a registered encoder nothing can be re-encoded.
    st.queue.register(
        "w".into(),
        fliks_server::queue::Worker {
            principal: fliks_server::queue::Principal::Local,
            engine_version: "test".into(),
            devices: vec![fliks_engine_core::api::WorkerDevice {
                id: "cpu".into(),
                name: None,
                encoders: vec!["libx265".into()],
                decoders: vec![],
                max_jobs: 1,
                pause: fliks_engine_core::api::PauseMode::Suspend,
            }],
        },
    );
    Ctx {
        app: app::router(st, None, "/nonexistent".into(), None),
        admin,
    }
}

async fn call(c: &Ctx, method: &str, uri: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {}", c.admin))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = c.app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let b = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

async fn balanced(c: &Ctx) -> Value {
    let (_, presets) = call(c, "GET", "/api/optimize/presets", Value::Null).await;
    presets[0]["document"].clone()
}

#[sqlx::test(migrations = false)]
async fn presets_are_templates_and_profiles_validate(pool: PgPool) {
    let c = ctx(&pool).await;
    let (s, presets) = call(&c, "GET", "/api/optimize/presets", Value::Null).await;
    assert_eq!(s, 200);
    assert_eq!(presets.as_array().unwrap().len(), 3);
    let (_, list) = call(&c, "GET", "/api/optimize/profiles", Value::Null).await;
    assert_eq!(list, json!([]));

    let doc = balanced(&c).await;
    let (s, p) = call(
        &c,
        "POST",
        "/api/optimize/profiles",
        json!({"name": "Mine", "document": doc}),
    )
    .await;
    assert_eq!(s, 201);
    let id = p["id"].as_i64().unwrap();
    let mut bad = doc.clone();
    bad["guards"]["min_savings_pct"] = json!(120);
    let (s, _) = call(
        &c,
        "PUT",
        &format!("/api/optimize/profiles/{id}"),
        json!({"name": "Mine", "document": bad}),
    )
    .await;
    assert_eq!(s, 400);
    let mut unknown = doc.clone();
    unknown["video"]["nope"] = json!(1);
    let (s, _) = call(
        &c,
        "POST",
        "/api/optimize/profiles",
        json!({"name": "x", "document": unknown}),
    )
    .await;
    assert_eq!(s, 400);
    let (s, _) = call(
        &c,
        "DELETE",
        &format!("/api/optimize/profiles/{id}"),
        Value::Null,
    )
    .await;
    assert_eq!(s, 204);
    let (s, _) = call(
        &c,
        "GET",
        &format!("/api/optimize/profiles/{id}"),
        Value::Null,
    )
    .await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn library_assignment_and_preview(pool: PgPool) {
    let c = ctx(&pool).await;
    let (_, lib) = call(&c, "POST", "/api/libraries", json!({"name": "Films"})).await;
    let lib_id = lib["id"].as_i64().unwrap();
    assert_eq!(lib["optimizeProfileId"], Value::Null);
    let (s, _) = call(
        &c,
        "PATCH",
        &format!("/api/libraries/{lib_id}"),
        json!({"optimizeNewFiles": true}),
    )
    .await;
    assert_eq!(s, 400);
    let (s, _) = call(
        &c,
        "PATCH",
        &format!("/api/libraries/{lib_id}"),
        json!({"optimizeProfileId": 999}),
    )
    .await;
    assert_eq!(s, 400);

    let (_, p) = call(
        &c,
        "POST",
        "/api/optimize/profiles",
        json!({"name": "P", "document": balanced(&c).await}),
    )
    .await;
    let pid = p["id"].as_i64().unwrap();
    let (s, lib) = call(
        &c,
        "PATCH",
        &format!("/api/libraries/{lib_id}"),
        json!({"optimizeProfileId": pid, "optimizeNewFiles": true, "allowRename": true}),
    )
    .await;
    assert_eq!(
        (
            s,
            lib["optimizeProfileId"].as_i64(),
            lib["allowRename"].as_bool()
        ),
        (200, Some(pid), Some(true))
    );

    let media: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, type, "libraryId", "folderName") VALUES ('m', 'movie', $1, 'm') RETURNING id"#,
    )
    .bind(lib_id as i32)
    .fetch_one(&pool)
    .await
    .unwrap();
    let folder: i32 = sqlx::query_scalar(
        r#"INSERT INTO library_folders ("libraryId", path, position) VALUES ($1, '/nonexistent/optimize', 0) RETURNING id"#,
    )
    .bind(lib_id as i32)
    .fetch_one(&pool)
    .await
    .unwrap();
    let info = json!({
        "video": [{"streamIndex": 0, "codec": "h264", "width": 1920, "height": 1080}],
        "audio": [{"streamIndex": 1, "codec": "eac3", "language": "eng", "channels": 6}],
        "subtitles": [], "schemaVersion": 5
    });
    sqlx::query(
        r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "streamInfo", "probeVersion", "folderId", "createdAt")
           VALUES ($1, 'm/a.mkv', 1000, 'x', $2, $3, $4, now() - interval '30 days')"#,
    )
    .bind(media)
    .bind(info)
    .bind(fliks_server::ingest::rescan::PROBE_VERSION)
    .bind(folder)
    .execute(&pool)
    .await
    .unwrap();

    let (s, pv) = call(
        &c,
        "GET",
        &format!("/api/libraries/{lib_id}/optimize/preview"),
        Value::Null,
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(pv["withDifference"], 1);
    assert_eq!(pv["perLevel"]["reencode"], 1);
    let file_id: i32 = sqlx::query_scalar(r#"SELECT id FROM media_files WHERE "mediaId" = $1"#)
        .bind(media)
        .fetch_one(&pool)
        .await
        .unwrap();
    let uri = format!("/api/libraries/{lib_id}/optimize/preview/file");
    let (s, o) = call(&c, "POST", &uri, json!({"fileId": file_id})).await;
    assert_eq!(
        (s, o["status"].as_str(), o["level"].as_str()),
        (200, Some("diff"), Some("reencode"))
    );
    let mut cleanup = balanced(&c).await;
    cleanup["video"]["enabled"] = json!(false);
    let (_, o) = call(
        &c,
        "POST",
        &uri,
        json!({"fileId": file_id, "profile": cleanup}),
    )
    .await;
    assert_ne!(o["level"].as_str(), Some("reencode"));
    let (s, _) = call(&c, "POST", &uri, json!({"fileId": file_id + 999})).await;
    assert_eq!(s, 404);
    let (_, sm) = call(
        &c,
        "GET",
        &format!("/api/libraries/{lib_id}/optimize/summary"),
        Value::Null,
    )
    .await;
    assert_eq!(sm["filesWithDifference"], 1);
}

#[sqlx::test(migrations = false)]
async fn job_routes_follow_library_access(pool: PgPool) {
    let mut c = ctx(&pool).await;
    for q in [
        r#"INSERT INTO libraries (name) VALUES ('a'), ('b')"#,
        r#"INSERT INTO media (title, type, "libraryId") VALUES ('in-a', 'movie', 1), ('in-b', 'movie', 2)"#,
        r#"INSERT INTO library_folders ("libraryId", path) VALUES (1, '/tmp/a'), (2, '/tmp/b')"#,
        r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality)
           SELECT m.id, f.id, 'x.mkv', 1, '{}'::jsonb FROM media m JOIN library_folders f ON f."libraryId" = m."libraryId""#,
        r#"INSERT INTO jobs (kind, "mediaFileId", payload, "profileHash", state, "inPath")
           SELECT 'optimize', id, '{}'::jsonb, 'h', 'queued', '/tmp/p' FROM media_files"#,
        r#"INSERT INTO roles (name, permissions) VALUES ('s', '["settings.access"]')"#,
        r#"INSERT INTO users (username, "roleId") VALUES ('u', (SELECT id FROM roles))"#,
    ] {
        sqlx::query(q).execute(&pool).await.unwrap();
    }
    let uid: i32 = sqlx::query_scalar(r#"SELECT id FROM users WHERE username = 'u'"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ($1, 1)"#)
        .bind(uid)
        .execute(&pool)
        .await
        .unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    c.admin = session::token(&st, uid, "u").await;
    let (s, jobs) = call(&c, "GET", "/api/optimize/jobs", Value::Null).await;
    assert_eq!((s, jobs.as_array().unwrap().len()), (200, 1));
    let other: i32 = sqlx::query_scalar(
        r#"SELECT f.id FROM media_files f JOIN media m ON m.id = f."mediaId" WHERE m."libraryId" = 2"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let (s, _) = call(
        &c,
        "POST",
        "/api/optimize/jobs",
        json!({"mediaFileIds": [other]}),
    )
    .await;
    assert_eq!(s, 404);
    let (s, _) = call(
        &c,
        "POST",
        "/api/optimize/verify",
        json!({"mediaFileIds": [other]}),
    )
    .await;
    assert_eq!(s, 404);
    let job: i64 = sqlx::query_scalar(r#"SELECT j.id FROM jobs j WHERE j."mediaFileId" = $1"#)
        .bind(other)
        .fetch_one(&pool)
        .await
        .unwrap();
    for op in ["cancel", "retry", "restore"] {
        let (s, _) = call(
            &c,
            "POST",
            &format!("/api/optimize/jobs/{job}/{op}"),
            Value::Null,
        )
        .await;
        assert_eq!(s, 404, "{op}");
    }
    let (_, r) = call(
        &c,
        "POST",
        "/api/optimize/jobs/cancel",
        json!({"ids": [job]}),
    )
    .await;
    assert_eq!(r["cancelled"].as_array().unwrap().len(), 0);
}

#[sqlx::test(migrations = false)]
async fn saving_settings_never_flips_the_pause_and_shared_markers_stay_out_of_the_list(
    pool: PgPool,
) {
    let c = ctx(&pool).await;
    let (_, mut conf) = call(&c, "GET", "/api/optimize/settings", Value::Null).await;
    call(&c, "POST", "/api/optimize/queue/pause", json!({})).await;
    conf["paused"] = false.into();
    let (s, saved) = call(&c, "PUT", "/api/optimize/settings", conf).await;
    assert_eq!(s, 200);
    assert_eq!(saved["paused"], true);
    sqlx::query(
        r#"INSERT INTO jobs (kind, payload, "profileHash", state, error, "finishedAt")
           VALUES ('optimize', '{}'::jsonb, 'shared', 'skipped', '{"class": "shared"}'::jsonb, now())"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let (_, jobs) = call(&c, "GET", "/api/optimize/jobs", Value::Null).await;
    assert!(jobs.as_array().unwrap().is_empty());
}

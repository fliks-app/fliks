//! Importer routes (`docs/spec/importers.md`) through the real router, against an in-process stub of
//! Radarr, Sonarr and Seerr serving `fixtures/importers`.
use axum::{
    Router,
    body::Body,
    extract::Request as AxReq,
    http::{Request, StatusCode, header},
    response::{IntoResponse, Response},
};
use fliks_server::{app, config::Config, roles, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{path::PathBuf, time::Duration};
use tower::ServiceExt;

const KEY: &str = "stub-key";

fn fixture(service: &str, name: &str) -> Value {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/importers");
    let text = std::fs::read_to_string(dir.join(service).join(format!("{name}.json"))).unwrap();
    serde_json::from_str(&text).unwrap()
}

/// `/<service>/<variant>/api/...`; variants `ok`, `500`, `redirect` (to `localhost`), `slow` (Seerr lists), `v3`, `tmdb-zero`, `traversal`.
async fn stub(req: AxReq) -> Response {
    let path = req.uri().path().to_owned();
    let mut seg = path.trim_start_matches('/').splitn(3, '/');
    let (service, variant, rest) = (
        seg.next().unwrap_or_default().to_owned(),
        seg.next().unwrap_or_default().to_owned(),
        format!("/{}", seg.next().unwrap_or_default()),
    );
    if req.headers().get("x-api-key").and_then(|v| v.to_str().ok()) != Some(KEY) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match variant.as_str() {
        "500" => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
        "redirect" => {
            let host = req
                .headers()
                .get(header::HOST)
                .and_then(|h| h.to_str().ok())
                .unwrap_or_default();
            let port = host.rsplit(':').next().unwrap_or_default();
            return (
                StatusCode::FOUND,
                [(
                    header::LOCATION,
                    format!("http://localhost:{port}/{service}/ok{rest}"),
                )],
            )
                .into_response();
        }
        "slow" => tokio::time::sleep(Duration::from_millis(1500)).await,
        _ => {}
    }
    let body = match (service.as_str(), rest.as_str(), variant.as_str()) {
        (_, "/api/v3/system/status", _) => fixture(&service, "system-status"),
        (_, "/api/v3/qualityprofile", _) => fixture(&service, "qualityprofile"),
        (_, "/api/v3/rootfolder", _) => fixture(&service, "rootfolder"),
        ("radarr", "/api/v3/movie", "tmdb-zero") => fixture("radarr", "movie-tmdb-zero"),
        ("radarr", "/api/v3/movie", "traversal") => fixture("radarr", "movie-traversal"),
        ("radarr", "/api/v3/movie", _) => fixture("radarr", "movie"),
        ("radarr", "/api/v3/extrafile", "subs-traversal") => {
            fixture("radarr", "extrafile-traversal")
        }
        ("radarr", "/api/v3/extrafile", _) => fixture("radarr", "extrafile"),
        ("sonarr", "/api/v3/series", "v3") => fixture("sonarr", "series-v3"),
        ("sonarr", "/api/v3/series", _) => fixture("sonarr", "series"),
        ("seerr", "/api/v1/settings/main", _) => fixture("seerr", "settings-main"),
        ("seerr", "/api/v1/request", _) => {
            if req.uri().query().is_some_and(|q| q.contains("skip=0")) {
                fixture("seerr", "request-page-1")
            } else {
                json!({"pageInfo": {"results": 0}, "results": []})
            }
        }
        ("seerr", "/api/v1/movie/5555", _) => fixture("seerr", "movie-5555"),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    axum::Json(body).into_response()
}

async fn stub_url() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async {
        axum::serve(listener, Router::new().fallback(stub))
            .await
            .unwrap()
    });
    url
}

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
    admin: String,
    readonly: String,
    stub: String,
}

async fn token(pool: &PgPool, st: &AppState, name: &str, perms: &str, admin: bool) -> String {
    let role: i32 =
        sqlx::query_scalar(r#"INSERT INTO roles (name, permissions) VALUES ($1, $2) RETURNING id"#)
            .bind(format!("r-{name}"))
            .bind(perms)
            .fetch_one(pool)
            .await
            .unwrap();
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "roleId", "isAdmin") VALUES ($1, $2, $3) RETURNING id"#,
    )
    .bind(name)
    .bind(role)
    .bind(admin)
    .fetch_one(pool)
    .await
    .unwrap();
    st.jwt.sign_access(id, name).unwrap().token
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    roles::seed(&pool).await.unwrap();
    let st = AppState::new(
        pool.clone(),
        Config::from_lookup(|_| None),
        "0123456789abcdef0123456789abcdef",
    );
    let admin = token(&pool, &st, "admin", "[]", true).await;
    let readonly = token(&pool, &st, "ro", r#"["media.read"]"#, false).await;
    for (id, name, types, path) in [
        (1, "Movies", r#"["movie"]"#, "/lib/movies"),
        (2, "Series", r#"["series"]"#, "/lib/tv"),
    ] {
        sqlx::query(r#"INSERT INTO libraries (id, name, "mediaTypes", path) VALUES ($1, $2, $3::jsonb, $4)"#)
            .bind(id)
            .bind(name)
            .bind(types)
            .bind(path)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query(
        "INSERT INTO quality_profiles (name, cutoff, items) VALUES ('Existing HD', 18, '[]')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let app = app::router(st.clone(), None, std::env::temp_dir(), None);
    Ctx {
        app,
        st,
        pool,
        admin,
        readonly,
        stub: stub_url().await,
    }
}

async fn post(c: &Ctx, uri: &str, token: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = c.app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn import_body(c: &Ctx, svc: &str, variant: &str, lib: i64) -> Value {
    let root = if svc == "radarr" {
        "/data/movies"
    } else {
        "/data/tv"
    };
    json!({"url": format!("{}/{svc}/{variant}", c.stub), "apiKey": KEY, "targetLibraryId": lib,
           "pathMappings": [{"remotePath": root, "localLibraryId": lib}, {"remotePath": "/data/ignored", "ignore": true}]})
}

async fn setting(c: &Ctx, key: &str, value: &str) {
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2")
        .bind(key)
        .bind(value)
        .execute(&c.pool)
        .await
        .unwrap();
}

#[sqlx::test(migrations = false)]
async fn connection_tests_report_ok_false_without_the_url(pool: PgPool) {
    let c = ctx(pool).await;
    let url = |v: &str| format!("{}/radarr/{v}", c.stub);
    let (s, b) = post(
        &c,
        "/api/imports/radarr/test",
        &c.admin,
        json!({"url": url("ok"), "apiKey": KEY}),
    )
    .await;
    assert_eq!(
        (s, &b["ok"], b["message"].as_str()),
        (201, &json!(true), Some("Connecté à Radarr Parity"))
    );
    let (_, b) = post(
        &c,
        "/api/imports/radarr/test",
        &c.admin,
        json!({"url": url("ok"), "apiKey": "x"}),
    )
    .await;
    assert_eq!(
        b,
        json!({"ok": false, "message": "Radarr returned 401 Unauthorized"})
    );
    let (s, b) = post(
        &c,
        "/api/imports/radarr/test",
        &c.admin,
        json!({"url": "http://127.0.0.1:1/secret-path", "apiKey": "k"}),
    )
    .await;
    assert_eq!((s, &b["ok"]), (201, &json!(false)));
    let msg = b["message"].as_str().unwrap();
    assert!(
        !msg.contains("127.0.0.1") && !msg.contains("secret-path"),
        "{msg}"
    );
    let (_, b) = post(
        &c,
        "/api/imports/seerr/test",
        &c.admin,
        json!({"url": format!("{}/seerr/ok/", c.stub), "apiKey": KEY}),
    )
    .await;
    assert_eq!(b, json!({"ok": true, "message": "Connecté à Parity Seerr"}));
}

#[sqlx::test(migrations = false)]
async fn a_redirect_to_another_host_is_a_failure(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, b) = post(
        &c,
        "/api/imports/radarr/test",
        &c.admin,
        json!({"url": format!("{}/radarr/redirect", c.stub), "apiKey": KEY}),
    )
    .await;
    assert_eq!(
        b,
        json!({"ok": false, "message": "Radarr returned 302 Found"})
    );
}

#[sqlx::test(migrations = false)]
async fn the_stored_key_follows_only_its_own_url(pool: PgPool) {
    let c = ctx(pool).await;
    let stored = format!("{}/radarr/ok", c.stub);
    setting(&c, "radarr_api_key", KEY).await;
    setting(&c, "radarr_url", &stored).await;
    let (_, b) = post(
        &c,
        "/api/imports/radarr/test",
        &c.admin,
        json!({"url": format!("{stored}/")}),
    )
    .await;
    assert_eq!(b["ok"], true);
    let (s, b) = post(
        &c,
        "/api/imports/radarr/test",
        &c.admin,
        json!({"url": format!("{}/radarr/other", c.stub)}),
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (400, Some("apiKey is required"))
    );
    let (s, _) = post(
        &c,
        "/api/imports/radarr/test",
        &c.admin,
        json!({"url": stored, "apiKey": "  "}),
    )
    .await;
    assert_eq!(s, 201);
}

#[sqlx::test(migrations = false)]
async fn authz_and_validation(pool: PgPool) {
    let c = ctx(pool).await;
    let body = json!({"url": "http://x"});
    assert_eq!(
        post(&c, "/api/imports/sonarr/test", &c.readonly, body.clone())
            .await
            .0,
        403
    );
    assert_eq!(
        post(&c, "/api/imports/sonarr/preview", &c.readonly, body)
            .await
            .0,
        403
    );
    assert_eq!(
        post(&c, "/api/imports/radarr", &c.readonly, json!({}))
            .await
            .0,
        403
    );
    assert_eq!(
        post(
            &c,
            "/api/imports/seerr/import-requests",
            &c.readonly,
            json!({})
        )
        .await
        .0,
        403
    );
    let (s, b) = post(
        &c,
        "/api/imports/radarr",
        &c.admin,
        json!({"url": "nope", "targetLibraryId": 0, "pathMappings": "x"}),
    )
    .await;
    assert_eq!(s, 400);
    assert!(b["message"].as_array().unwrap().len() >= 3);
}

#[sqlx::test(migrations = false)]
async fn preview_lists_roots_with_suggestions(pool: PgPool) {
    let c = ctx(pool).await;
    sqlx::query("UPDATE libraries SET path = '/media/movies' WHERE id = 1")
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, b) = post(
        &c,
        "/api/imports/radarr/preview",
        &c.admin,
        json!({"url": format!("{}/radarr/ok", c.stub), "apiKey": KEY}),
    )
    .await;
    assert_eq!(s, 201);
    assert_eq!(
        b["remoteRootFolders"],
        json!([{"remotePath": "/data/movies", "suggestedLocalLibraryId": 1}, {"remotePath": "/data/ignored", "suggestedLocalLibraryId": null}])
    );
    assert_eq!(
        b["localLibraries"][1],
        json!({"id": 2, "name": "Series", "path": "/lib/tv"})
    );
    let (s, b) = post(
        &c,
        "/api/imports/radarr/preview",
        &c.admin,
        json!({"url": format!("{}/radarr/500", c.stub), "apiKey": KEY}),
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (400, Some("Radarr API returned 500: Internal Server Error"))
    );
}

#[sqlx::test(migrations = false)]
async fn radarr_import_writes_media_profiles_and_subtitles(pool: PgPool) {
    let c = ctx(pool).await;
    sqlx::query(r#"WITH m AS (INSERT INTO media (id, title, year, type, status, "folderName", "libraryId") VALUES (50, 'Parity Movie 01', 2020, 'movie', 'released', 'Old', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (1001)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#)
        .execute(&c.pool).await.unwrap();
    sqlx::query(r#"INSERT INTO wants ("mediaId", family) VALUES (50, 'video')"#)
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO media_files (id, "mediaId", "relativePath", size, quality) VALUES (60, 50, 'Old.mkv', 1, 'x')"#)
        .execute(&c.pool).await.unwrap();
    let mut body = import_body(&c, "radarr", "ok", 1);
    let (s, b) = post(&c, "/api/imports/radarr", &c.admin, body.clone()).await;
    assert_eq!(s, 201, "{b}");
    assert_eq!(b["imported"], 1);
    assert_eq!(b["qualityProfilesCreated"], json!(["Remote HD"]));
    assert_eq!(b["errors"].as_array().unwrap().len(), 2);
    assert_eq!(b["subtitlesImported"], json!(0));
    body["mode"] = json!("update");
    body["importSubtitles"] = json!(true);
    body["pathMappings"][0]["remotePath"] = json!("/data/movies");
    let (_, b) = post(&c, "/api/imports/radarr", &c.admin, body).await;
    assert_eq!(
        (b["imported"].clone(), b["subtitlesImported"].clone()),
        (json!(2), json!(2))
    );
    let m: (i32, bool, String, Option<i32>) = sqlx::query_as(
        r#"SELECT m.year, m.monitored, m."folderName", w."qualityProfileId" FROM media m JOIN wants w ON w."mediaId" = m.id WHERE m.id = 50"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        (m.0, m.1, m.2.as_str()),
        (2019, false, "Parity Movie 01 (2020)")
    );
    assert!(m.3.is_some());
    let langs: Vec<(String, bool, String)> = sqlx::query_as(
        r#"SELECT language, forced, "providerType"::text FROM subtitle_files ORDER BY id"#,
    )
    .fetch_all(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        langs,
        [
            ("en".into(), false, "radarr".into()),
            ("fr".into(), true, "radarr".into())
        ]
    );
    let (_, b) = post(
        &c,
        "/api/imports/radarr",
        &c.admin,
        import_body(&c, "radarr", "ok", 1),
    )
    .await;
    assert_eq!(b["imported"], 0, "skip mode keeps every title");
    let made: Vec<i32> = sqlx::query_scalar("SELECT id FROM media WHERE id <> 50")
        .fetch_all(&c.pool)
        .await
        .unwrap();
    assert!(!made.is_empty());
    crate::items::assert_media_have_shells(&c.pool, &made).await;
}

#[sqlx::test(migrations = false)]
async fn radarr_import_refuses_what_the_spec_refuses(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, b) = post(
        &c,
        "/api/imports/radarr",
        &c.admin,
        import_body(&c, "radarr", "ok", 2),
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (400, Some("Library \"Series\" does not accept movie"))
    );
    let mut body = import_body(&c, "radarr", "ok", 1);
    body["pathMappings"][0]["localLibraryId"] = json!(2);
    let (_, b) = post(&c, "/api/imports/radarr", &c.admin, body).await;
    assert_eq!(
        b["message"],
        "Path mappings target a different library than the import (target #1, mappings: 2)"
    );
    let (_, b) = post(
        &c,
        "/api/imports/radarr",
        &c.admin,
        import_body(&c, "radarr", "tmdb-zero", 1),
    )
    .await;
    assert_eq!(
        (&b["imported"], b["errors"][0].as_str()),
        (&json!(0), Some("Zero Id: invalid tmdbId"))
    );
    let (_, b) = post(
        &c,
        "/api/imports/radarr",
        &c.admin,
        import_body(&c, "radarr", "traversal", 1),
    )
    .await;
    assert_eq!(
        b["errors"][0],
        "Escape: invalid folder name for \"/data/movies/..\\escape\""
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test(migrations = false)]
async fn sonarr_import_needs_v4_and_refreshes_new_series(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, b) = post(
        &c,
        "/api/imports/sonarr",
        &c.admin,
        import_body(&c, "sonarr", "v3", 2),
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (
            400,
            Some("Sonarr v4 or later is required (the series list carries no tmdbId)")
        )
    );
    let (s, b) = post(
        &c,
        "/api/imports/sonarr",
        &c.admin,
        import_body(&c, "sonarr", "ok", 2),
    )
    .await;
    assert_eq!((s, &b["imported"]), (201, &json!(2)));
    let rows: Vec<(i32, String, String)> = sqlx::query_as(
        r#"SELECT e.value::int, m.status::text, m."folderName" FROM media m
           JOIN media_external_ids e ON e."mediaId" = m.id AND e.provider = 'tmdb' ORDER BY 1"#,
    )
    .fetch_all(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        rows[0],
        (2000, "continuing".into(), "Parity Series A".into())
    );
    crate::items::assert_media_have_shells(&c.pool, &[]).await;
}

#[sqlx::test(migrations = false)]
async fn sonarr_import_writes_sidecar_subtitles(pool: PgPool) {
    let c = ctx(pool).await;
    let root = std::env::temp_dir().join(format!("s5-sonarr-subs-{}", std::process::id()));
    let season = root.join("Parity Series A/Season 01");
    std::fs::create_dir_all(&season).unwrap();
    for name in [
        "Parity Series A - S01E01.mkv",
        "Parity Series A - S01E01.en.srt",
        "Parity Series A - S01E01.fr.forced.srt",
        "Other - S01E02.en.srt",
    ] {
        std::fs::write(season.join(name), b"x").unwrap();
    }
    sqlx::query("UPDATE libraries SET path = $1 WHERE id = 2")
        .bind(root.to_str().unwrap())
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query(r#"WITH m AS (INSERT INTO media (id, title, year, type, status, "folderName", "libraryId") VALUES (70, 'Parity Series A', 2021, 'series', 'continuing', 'Parity Series A', 2) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (2000)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#)
        .execute(&c.pool).await.unwrap();
    sqlx::query(r#"INSERT INTO wants ("mediaId", family) VALUES (70, 'video')"#)
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO media_files (id, "mediaId", "relativePath", size, quality) VALUES (80, 70, 'Season 01/Parity Series A - S01E01.mkv', 1, 'x')"#)
        .execute(&c.pool).await.unwrap();
    let mut body = import_body(&c, "sonarr", "ok", 2);
    body["importSubtitles"] = json!(true);
    body["mode"] = json!("update");
    let (s, b) = post(&c, "/api/imports/sonarr", &c.admin, body).await;
    assert_eq!((s, &b["subtitlesImported"]), (201, &json!(2)), "{b}");
    let rows: Vec<(String, bool, String, Option<String>)> = sqlx::query_as(
        r#"SELECT language, forced, "providerType"::text, "filePath" FROM subtitle_files ORDER BY id"#,
    )
    .fetch_all(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [
            (
                "en".into(),
                false,
                "sonarr".into(),
                Some("Season 01/Parity Series A - S01E01.en.srt".into())
            ),
            (
                "fr".into(),
                true,
                "sonarr".into(),
                Some("Season 01/Parity Series A - S01E01.fr.forced.srt".into())
            )
        ]
    );
    std::fs::remove_dir_all(&root).unwrap();
}

async fn wait_command(c: &Ctx, name: &str) -> String {
    for _ in 0..80 {
        let st: Option<String> = sqlx::query_scalar(
            "SELECT status FROM commands WHERE name = $1 ORDER BY id DESC LIMIT 1",
        )
        .bind(name)
        .fetch_optional(&c.pool)
        .await
        .unwrap();
        if let Some(s) = st.filter(|s| s != "running") {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("{name} did not finish");
}

#[sqlx::test(migrations = false)]
async fn seerr_import_creates_users_requests_and_refuses_a_second_run(pool: PgPool) {
    let c = ctx(pool).await;
    let default_role: i32 = sqlx::query_scalar(r#"SELECT id FROM roles WHERE "isDefault""#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO role_default_libraries ("roleId", "libraryId") VALUES ($1, 1), ($1, 2)"#,
    )
    .bind(default_role)
    .execute(&c.pool)
    .await
    .unwrap();
    sqlx::query(r#"WITH m AS (INSERT INTO media (id, title, year, type, status, "folderName", "libraryId") VALUES (50, 'M', 2020, 'movie', 'released', 'M', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (1001)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#)
        .execute(&c.pool).await.unwrap();
    sqlx::query(r#"INSERT INTO wants ("mediaId", family) VALUES (50, 'video')"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let mut events = c.st.hub.subscribe();
    setting(&c, "seerr_api_key", KEY).await;
    setting(&c, "seerr_url", &format!("{}/seerr/slow", c.stub)).await;
    let (s, b) = post(
        &c,
        "/api/imports/seerr/import-requests",
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!((s, b), (201, json!({"ok": true})));
    let (s, b) = post(
        &c,
        "/api/imports/seerr/import-requests",
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (409, Some("Import already running"))
    );
    assert_eq!(wait_command(&c, "ImportSeerrRequests").await, "completed");
    let mut seen = vec![];
    while let Ok(ev) = events.try_recv() {
        seen.push(
            serde_json::to_value(match &*ev {
                fliks_server::events::Bus::Sse(e) => e.clone(),
                _ => continue,
            })
            .unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    assert_eq!(
        seen,
        [
            "seerr.import.started",
            "command.started",
            "seerr.import.completed",
            "command.completed"
        ]
    );
    let users: Vec<(String, i64)> = sqlx::query_as(
        r#"SELECT u.username, (SELECT count(*) FROM library_user_access a WHERE a."userId" = u.id) FROM users u WHERE u.username LIKE 'seerr_%' ORDER BY 1"#,
    ).fetch_all(&c.pool).await.unwrap();
    assert_eq!(users, [("seerr_alice".into(), 2), ("seerr_bob".into(), 2)]);
    let reqs: Vec<(i32, String, String)> =
        sqlx::query_as(
            r#"SELECT "externalId"::int, status::text, title FROM requests WHERE provider = 'tmdb' ORDER BY 1"#,
        )
            .fetch_all(&c.pool)
            .await
            .unwrap();
    assert_eq!(
        reqs,
        [
            (1001, "pending".into(), "M".into()),
            (1002, "available".into(), "".into()),
            (2000, "processing".into(), "".into()),
            (5555, "failed".into(), "Fetched Title".into()),
            (9001, "declined".into(), "".into())
        ]
    );
    let owner: Option<i32> = sqlx::query_scalar("SELECT \"addedById\" FROM media WHERE id = 50")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert!(owner.is_some());
    let (_, _) = post(
        &c,
        "/api/imports/seerr/import-requests",
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!(wait_command(&c, "ImportSeerrRequests").await, "completed");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM requests")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 5, "a re-run updates in place");
}

#[sqlx::test(migrations = false)]
async fn seerr_import_without_configuration_fails_through_the_event(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, _) = post(
        &c,
        "/api/imports/seerr/import-requests",
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!(s, 201);
    assert_eq!(wait_command(&c, "ImportSeerrRequests").await, "failed");
}

#[sqlx::test(migrations = false)]
async fn radarr_extrafile_path_cannot_leave_the_media_folder(pool: PgPool) {
    let c = ctx(pool).await;
    sqlx::query(r#"WITH m AS (INSERT INTO media (id, title, year, type, status, "folderName", "libraryId") VALUES (50, 'Parity Movie 01', 2020, 'movie', 'released', 'Old', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (1001)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#)
        .execute(&c.pool).await.unwrap();
    sqlx::query(r#"INSERT INTO wants ("mediaId", family) VALUES (50, 'video')"#)
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO media_files (id, "mediaId", "relativePath", size, quality) VALUES (60, 50, 'Old.mkv', 1, 'x')"#)
        .execute(&c.pool).await.unwrap();
    let mut body = import_body(&c, "radarr", "subs-traversal", 1);
    body["importSubtitles"] = json!(true);
    let (s, b) = post(&c, "/api/imports/radarr", &c.admin, body).await;
    assert_eq!(s, 201, "{b}");
    assert_eq!(b["subtitlesImported"], json!(0));
    assert!(
        b["errors"].to_string().contains("invalid subtitle path"),
        "{b}"
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM subtitle_files")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

//! Media-servers routes, Emby provider, dispatch and watch-history import (`docs/spec/media-servers.md`)
//! against an in-process Emby stub serving `fixtures/media-servers/emby`.
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, Uri},
    response::Response,
};
use fliks_server::{
    app,
    config::Config,
    events::{Bus, SseEvent},
    media_servers, roles,
    state::AppState,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const USERS: &str = include_str!("../../../../fixtures/media-servers/emby/users.json");
const SERIES: &str = include_str!("../../../../fixtures/media-servers/emby/series.json");
const ITEMS: &str = include_str!("../../../../fixtures/media-servers/emby/items.json");
const INFO: &str = include_str!("../../../../fixtures/media-servers/emby/system-info.json");

#[derive(Clone, Default)]
struct Hits(Arc<Mutex<Vec<(String, String)>>>);

fn json_res(status: u16, body: Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn page(set: &[Value], q: &HashMap<String, String>) -> Value {
    let get = |k: &str, d: usize| q.get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let (offset, limit) = (get("StartIndex", 0), get("Limit", 500));
    let items: Vec<_> = set.iter().skip(offset).take(limit).collect();
    json!({"Items": items, "TotalRecordCount": set.len()})
}

/// The first path segment is the mode: ok, 401, 500, redirect, nousers, big, hit (redirect target).
async fn stub(hits: Hits, req: Request<Body>) -> Response {
    let uri: &Uri = req.uri();
    let q: HashMap<String, String> = uri.query().map(url_pairs).unwrap_or_default();
    let segs: Vec<&str> = uri.path().trim_matches('/').split('/').collect();
    let mode = segs[0];
    let token = req
        .headers()
        .get("x-emby-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    match mode {
        "401" => return json_res(401, json!({})),
        "500" => return json_res(500, json!({})),
        "hit" => {
            hits.0.lock().unwrap().push(("redirected".into(), token));
            return json_res(200, json!({}));
        }
        _ => {}
    }
    let rest = &segs[1..];
    let items: Value = serde_json::from_str(ITEMS).unwrap();
    match (req.method().as_str(), rest) {
        ("GET", ["System", "Info"]) if mode == "redirect" => Response::builder()
            .status(302)
            .header(
                "location",
                format!("http://127.0.0.2:{}/hit", port_of(&req)),
            )
            .body(Body::empty())
            .unwrap(),
        ("GET", ["System", "Info"]) => json_res(200, serde_json::from_str(INFO).unwrap()),
        ("POST", ["Library", "Refresh"]) => {
            hits.0.lock().unwrap().push((mode.into(), token));
            json_res(204, Value::Null)
        }
        ("GET", ["Users"]) if mode == "nousers" => json_res(500, json!({})),
        ("GET", ["Users"]) if mode == "blank" => {
            json_res(200, json!([{"Id": "b1", "Name": "  "}, {"Id": "b2"}]))
        }
        ("GET", ["Users"]) => json_res(200, serde_json::from_str(USERS).unwrap()),
        ("GET", ["Users", _, "Items", id]) if *id != "Resume" => {
            let series: Value = serde_json::from_str(SERIES).unwrap();
            match series.get(*id) {
                Some(s) => json_res(200, s.clone()),
                None => json_res(404, json!({})),
            }
        }
        ("GET", ["Users", uid, "Items", kind @ ..]) => {
            let empty = vec![];
            if mode == "big" {
                let resume = !kind.is_empty() || q.contains_key("IsResumable");
                if resume || *uid != "u1" {
                    return json_res(200, page(&[], &q));
                }
                let all: Vec<Value> = (0..1100)
                    .map(|i| json!({"Id": format!("big-{i}"), "Type": "Movie",
                        "ProviderIds": {"Tmdb": (8_000_000 + i).to_string()}, "UserData": {"Played": true}}))
                    .collect();
                return json_res(200, page(&all, &q));
            }
            let which = if !kind.is_empty() {
                "resume"
            } else if q.contains_key("IsPlayed") {
                "played"
            } else {
                "resumable"
            };
            let set = items[*uid][which].as_array().unwrap_or(&empty);
            json_res(200, page(set, &q))
        }
        _ => json_res(404, json!({})),
    }
}

fn url_pairs(q: &str) -> HashMap<String, String> {
    q.split('&')
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
}

fn port_of(req: &Request<Body>) -> String {
    req.headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.rsplit(':').next())
        .unwrap_or("0")
        .to_owned()
}

async fn spawn_stub() -> (String, Hits) {
    let hits = Hits::default();
    let h = hits.clone();
    let app = Router::new().fallback(move |req: Request<Body>| {
        let h = h.clone();
        async move { stub(h, req).await }
    });
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    (base, hits)
}

struct Ctx {
    st: AppState,
    app: Router,
    admin: String,
    plain: String,
    base: String,
    hits: Hits,
}

async fn user(pool: &PgPool, st: &AppState, name: &str, perms: &str, admin: bool) -> String {
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
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let admin = user(&pool, &st, "admin", r#"["settings.access"]"#, true).await;
    let plain = user(&pool, &st, "plain", r#"["media.read"]"#, false).await;
    let app = app::router(st.clone(), None, std::env::temp_dir(), None);
    let (base, hits) = spawn_stub().await;
    Ctx {
        st,
        app,
        admin,
        plain,
        base,
        hits,
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
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn add_server(c: &Ctx, mode: &str, events: &[&str], enabled: bool) -> i64 {
    let (s, b) = call(
        c,
        "POST",
        "/api/media-servers",
        &c.admin,
        Some(json!({"name": format!("emby-{mode}"), "type": "emby", "url": format!("{}/{mode}/", c.base),
            "apiKey": "tok", "events": events, "enabled": enabled})),
    )
    .await;
    assert_eq!(s, 201, "{b}");
    b["id"].as_i64().unwrap()
}

#[sqlx::test(migrations = false)]
async fn crud_validation_and_acl(pool: PgPool) {
    let c = ctx(pool).await;
    for (m, u, body) in [
        ("GET", "/api/media-servers/types", None),
        ("GET", "/api/media-servers", None),
        ("GET", "/api/media-servers/1", None),
        ("POST", "/api/media-servers", Some(json!({}))),
        ("PUT", "/api/media-servers/1", Some(json!({}))),
        ("DELETE", "/api/media-servers/1", None),
        ("POST", "/api/media-servers/1/test", None),
        ("POST", "/api/media-servers/1/import-watch-history", None),
    ] {
        let (s, b) = call(&c, m, u, &c.plain, body).await;
        assert_eq!(
            (s, b["message"].as_str()),
            (403, Some("Forbidden resource")),
            "{m} {u}"
        );
    }
    let (s, b) = call(&c, "GET", "/api/media-servers/types", &c.admin, None).await;
    assert_eq!(s, 200);
    assert_eq!(b[0]["type"], "emby");
    assert_eq!(b[0]["supportedEvents"].as_array().unwrap().len(), 7);

    let (s, b) = call(
        &c,
        "POST",
        "/api/media-servers",
        &c.admin,
        Some(
            json!({"name":"b","type":"emby","url":"http://x","events":null,"enabled":null,"apiKey":null}),
        ),
    )
    .await;
    assert_eq!(s, 201);
    assert_eq!(
        (
            b["events"].clone(),
            b["enabled"].clone(),
            b["apiKey"].clone()
        ),
        (json!([]), json!(true), json!(""))
    );
    let id = b["id"].as_i64().unwrap();
    let (_, b2) = call(
        &c,
        "POST",
        "/api/media-servers",
        &c.admin,
        Some(json!({"name":"a","type":"plex","url":"http://y"})),
    )
    .await;
    let (_, l) = call(&c, "GET", "/api/media-servers", &c.admin, None).await;
    assert_eq!(l[0]["id"], b2["id"]);

    let (s, b) = call(
        &c,
        "POST",
        "/api/media-servers",
        &c.admin,
        Some(json!({"type":"nope","url":1,"events":["a",2],"enabled":"true"})),
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(
        b["message"],
        json!([
            "name must be a string",
            "type must be one of the following values: local, jellyfin, emby, plex",
            "url must be a string",
            "each value in events must be a string",
            "enabled must be a boolean value"
        ])
    );
    let body = json!({"name":"b2","type":"emby","url":"http://u"});
    for bad in [json!({"events": null}), json!({"enabled": null})] {
        let mut m = body.clone();
        m.as_object_mut()
            .unwrap()
            .extend(bad.as_object().unwrap().clone());
        let (s, _) = call(
            &c,
            "PUT",
            &format!("/api/media-servers/{id}"),
            &c.admin,
            Some(m),
        )
        .await;
        assert_eq!(s, 400);
    }
    let mut m = body.clone();
    m["apiKey"] = Value::Null;
    let (s, b) = call(
        &c,
        "PUT",
        &format!("/api/media-servers/{id}"),
        &c.admin,
        Some(m),
    )
    .await;
    assert_eq!(
        (s, b["apiKey"].clone(), b["name"].clone()),
        (200, json!(""), json!("b2"))
    );
    let (s, b) = call(
        &c,
        "PUT",
        &format!("/api/media-servers/{id}"),
        &c.admin,
        Some(body),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!((&b["apiKey"], &b["apiKeySet"]), (&json!(""), &json!(false)));
    let (s, b) = call(&c, "GET", "/api/media-servers/999", &c.admin, None).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (404, Some("MediaServer #999 not found"))
    );
    assert_eq!(
        call(&c, "GET", "/api/media-servers/007", &c.admin, None)
            .await
            .0,
        400
    );
    assert_eq!(
        call(
            &c,
            "DELETE",
            &format!("/api/media-servers/{id}"),
            &c.admin,
            None
        )
        .await
        .0,
        200
    );
    assert_eq!(
        call(
            &c,
            "DELETE",
            &format!("/api/media-servers/{id}"),
            &c.admin,
            None
        )
        .await
        .0,
        404
    );
}

/// No response carries the key; absent or "" keeps it, a new string replaces it, null clears it.
#[sqlx::test(migrations = false)]
async fn api_key_is_redacted_and_kept(pool: PgPool) {
    let c = ctx(pool).await;
    let id = add_server(&c, "ok", &[], true).await;
    let uri = format!("/api/media-servers/{id}");
    let stored = || async {
        sqlx::query_scalar::<_, Option<String>>(
            r#"SELECT "apiKey" FROM media_servers WHERE id = $1"#,
        )
        .bind(id as i32)
        .fetch_one(&c.st.db)
        .await
        .unwrap()
    };
    let redacted = |b: &Value, set: bool| {
        assert_eq!(
            (&b["apiKey"], &b["apiKeySet"]),
            (&json!(""), &json!(set)),
            "{b}"
        );
    };
    redacted(&call(&c, "GET", &uri, &c.admin, None).await.1, true);
    redacted(
        &call(&c, "GET", "/api/media-servers", &c.admin, None)
            .await
            .1[0],
        true,
    );
    let put = |extra: Value| {
        let mut body = json!({"name": "n", "type": "emby", "url": "http://u", "enabled": false});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        call(&c, "PUT", &uri, &c.admin, Some(body))
    };
    for keep in [json!({}), json!({"apiKey": ""})] {
        let (s, b) = put(keep).await;
        assert_eq!(s, 200);
        redacted(&b, true);
        assert_eq!(stored().await.as_deref(), Some("tok"));
    }
    let (_, b) = put(json!({"apiKey": "fresh"})).await;
    redacted(&b, true);
    assert_eq!(stored().await.as_deref(), Some("fresh"));
    let (_, b) = put(json!({"apiKey": null})).await;
    redacted(&b, false);
    assert_eq!(stored().await, None);
    let (_, b) = call(
        &c,
        "POST",
        "/api/media-servers",
        &c.admin,
        Some(json!({"name":"m","type":"emby","url":"http://u"})),
    )
    .await;
    redacted(&b, false);
}

/// A write is checked on what it changes; a stored row a 4.x toggle re-sends still passes.
#[sqlx::test(migrations = false)]
async fn url_and_events_are_validated_on_change(pool: PgPool) {
    let c = ctx(pool).await;
    let msg = |b: &Value| b["message"][0].as_str().unwrap_or_default().to_owned();
    for (url, events, want) in [
        ("emby:8096", json!([]), "url must be a URL address"),
        ("ftp://emby", json!([]), "url must be a URL address"),
        ("http://", json!([]), "url must be a URL address"),
        (
            "https://emby",
            json!(["nope"]),
            "each value in events must be one of",
        ),
    ] {
        let body = json!({"name": "n", "type": "emby", "url": url, "events": events});
        let (s, b) = call(&c, "POST", "/api/media-servers", &c.admin, Some(body)).await;
        assert_eq!(s, 400, "{url}");
        assert!(msg(&b).starts_with(want), "{b}");
    }
    let plex =
        json!({"name": "n", "type": "plex", "url": "HTTPS://plex", "events": ["library.rescan"]});
    let (s, b) = call(&c, "POST", "/api/media-servers", &c.admin, Some(plex)).await;
    assert_eq!((s, msg(&b).as_str()), (400, "type plex supports no events"));

    let legacy: i32 = sqlx::query_scalar(
        r#"INSERT INTO media_servers (name, type, url, events) VALUES ('old', 'emby', 'ftp://old', '["bogus"]') RETURNING id"#,
    )
    .fetch_one(&c.st.db)
    .await
    .unwrap();
    let uri = format!("/api/media-servers/{legacy}");
    let put = |extra: Value| {
        let mut body = json!({"name": "old", "type": "emby", "url": "ftp://old", "events": ["bogus"], "enabled": false});
        body.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        call(&c, "PUT", &uri, &c.admin, Some(body))
    };
    assert_eq!(
        put(json!({})).await.0,
        200,
        "the stored values are re-sent unchanged"
    );
    assert_eq!(put(json!({"name": "renamed"})).await.0, 200);
    assert_eq!(put(json!({"url": "ftp://other"})).await.0, 400);
    assert_eq!(put(json!({"events": ["bogus", "x"]})).await.0, 400);
    assert_eq!(
        put(json!({"type": "plex"})).await.0,
        400,
        "a new type re-checks the events"
    );
    let fixed = json!({"url": "http://new", "events": ["media.deleted"]});
    let (s, b) = put(fixed).await;
    assert_eq!(
        (s, &b["url"], &b["events"]),
        (200, &json!("http://new"), &json!(["media.deleted"]))
    );
}

#[sqlx::test(migrations = false)]
async fn test_connection_modes(pool: PgPool) {
    let c = ctx(pool).await;
    let check = |mode: &'static str| {
        let c = &c;
        async move {
            let id = add_server(c, mode, &[], true).await;
            call(
                c,
                "POST",
                &format!("/api/media-servers/{id}/test"),
                &c.admin,
                None,
            )
            .await
        }
    };
    let (s, b) = check("ok").await;
    assert_eq!(
        (s, b["ok"].clone(), b["message"].as_str()),
        (201, json!(true), Some("Connecte a Parity Emby"))
    );
    let (_, b) = check("401").await;
    assert_eq!(
        (b["ok"].clone(), b["message"].as_str()),
        (json!(false), Some("Request failed with status code 401"))
    );
    assert_eq!(check("500").await.1["ok"], false);
    let (_, b) = check("redirect").await;
    assert_eq!(b["ok"], false, "a cross-host redirect is a failure");
    assert!(
        c.hits.0.lock().unwrap().is_empty(),
        "the token never reached the other host"
    );
    let (_, p) = call(
        &c,
        "POST",
        "/api/media-servers",
        &c.admin,
        Some(json!({"name":"p","type":"plex","url":"http://u"})),
    )
    .await;
    let (s, b) = call(
        &c,
        "POST",
        &format!("/api/media-servers/{}/test", p["id"]),
        &c.admin,
        None,
    )
    .await;
    assert_eq!(
        (s, b),
        (
            201,
            json!({"ok": false, "message": "Type \"plex\" non supporte"})
        )
    );
    assert_eq!(
        call(&c, "POST", "/api/media-servers/999/test", &c.admin, None)
            .await
            .0,
        404
    );
    let (_, b) = call(
        &c,
        "POST",
        "/api/media-servers",
        &c.admin,
        Some(json!({"name":"e","type":"emby","url":"http://u:p@127.0.0.1:1/x"})),
    )
    .await;
    let (_, b) = call(
        &c,
        "POST",
        &format!("/api/media-servers/{}/test", b["id"]),
        &c.admin,
        None,
    )
    .await;
    let msg = b["message"].as_str().unwrap();
    assert!(
        !msg.contains("127.0.0.1") && !msg.contains("u:p"),
        "no credential in {msg}"
    );
}

#[sqlx::test(migrations = false)]
async fn dispatch_hits_enabled_subscribers_only(pool: PgPool) {
    let c = ctx(pool).await;
    add_server(&c, "ok", &["library.rescan"], true).await;
    add_server(&c, "ok", &["media.deleted"], true).await;
    add_server(&c, "ok", &["library.rescan"], false).await;
    add_server(&c, "500", &["library.rescan"], true).await;
    add_server(&c, "401", &["library.rescan"], true).await;
    media_servers::dispatch(&c.st, "library.rescan").await;
    assert_eq!(
        *c.hits.0.lock().unwrap(),
        vec![("ok".to_owned(), "tok".to_owned())]
    );
    media_servers::dispatch(&c.st, "unknown.event").await;
    assert_eq!(c.hits.0.lock().unwrap().len(), 1);
}

async fn seed_library(pool: &PgPool) {
    let q = |s: &'static str| sqlx::query(s);
    q(r#"INSERT INTO libraries (id, name, "mediaTypes", path) VALUES (1,'Movies','["movie"]','/tmp/fliks-parity/s5-importers/m'),(2,'Series','["series"]','/tmp/fliks-parity/s5-importers/s')"#).execute(pool).await.unwrap();
    q(r#"UPDATE roles SET "isDefault" = (name = 'User')"#)
        .execute(pool)
        .await
        .unwrap();
    q(r#"INSERT INTO role_default_libraries ("roleId", "libraryId") SELECT id, l FROM roles, (VALUES (1),(2)) v(l) WHERE name = 'User'"#).execute(pool).await.unwrap();
    for n in 1..=5 {
        q(r#"WITH m AS (INSERT INTO media (title, type, "libraryId", "folderName") VALUES ($1, 'movie', 1, $1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', $2::int4::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#)
            .bind(format!("Movie {n}")).bind(1000 + n).execute(pool).await.unwrap();
    }
    q(r#"WITH m AS (INSERT INTO media (title, type, "libraryId", "folderName") VALUES ('Show', 'series', 2, 'Show') RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (2000)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).execute(pool).await.unwrap();
    q(r#"INSERT INTO seasons ("seasonNumber", "mediaId") SELECT 1, id FROM media WHERE type = 'series'"#).execute(pool).await.unwrap();
    q(r#"INSERT INTO episodes ("episodeNumber", title, "seasonId") SELECT n, 'E' || n, s.id FROM seasons s, generate_series(1,2) n"#).execute(pool).await.unwrap();
}

async fn wait_for(
    rx: &mut tokio::sync::broadcast::Receiver<Arc<Bus>>,
    until: fn(&SseEvent) -> bool,
) -> Vec<SseEvent> {
    let mut seen = vec![];
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            if let Ok(b) = rx.recv().await
                && let Bus::Sse(ev) = &*b
                && !matches!(ev, SseEvent::ActivityChanged {})
            {
                seen.push(ev.clone());
                if until(ev) {
                    return;
                }
            }
        }
    })
    .await
    .expect("import events");
    seen
}

fn finished(e: &SseEvent) -> bool {
    matches!(e, SseEvent::CommandCompleted { .. })
}

async fn run_import(c: &Ctx, id: i64) -> Vec<SseEvent> {
    let mut rx = c.st.hub.subscribe();
    let (s, b) = call(
        c,
        "POST",
        &format!("/api/media-servers/{id}/import-watch-history"),
        &c.admin,
        None,
    )
    .await;
    assert_eq!((s, b), (201, json!({"ok": true})));
    wait_for(&mut rx, finished).await
}

#[sqlx::test(migrations = false)]
async fn import_history_follows_the_resume_rules(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    seed_library(&pool).await;
    let existing: i32 =
        sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ('user') RETURNING id"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    // Fliks played movie 2 after Emby did, so Emby must not overwrite it.
    sqlx::query(r#"INSERT INTO playback_states ("userId","mediaId","positionSeconds","lastPlayedAt") SELECT $1, id, 5, '2026-01-03' FROM media WHERE id = (SELECT "mediaId" FROM media_external_ids WHERE provider = 'tmdb' AND value = '1002')"#)
        .bind(existing).execute(&pool).await.unwrap();
    let id = add_server(&c, "ok", &[], true).await;
    let ev = run_import(&c, id).await;
    let kinds: Vec<&str> = ev
        .iter()
        .map(|e| match e {
            SseEvent::WatchHistoryImportStarted { .. } => "started",
            SseEvent::CommandStarted { .. } => "command.started",
            SseEvent::WatchHistoryImportCompleted { .. } => "completed",
            SseEvent::CommandCompleted { .. } => "command.completed",
            _ => "other",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "started",
            "command.started",
            "completed",
            "command.completed"
        ]
    );
    assert_eq!(
        ev[2],
        SseEvent::WatchHistoryImportCompleted {
            server_id: id,
            server_name: "emby-ok".into(),
            users: 2,
            users_created: 1,
            imported: 6,
            skipped: 6
        }
    );
    let row = |title: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (f64, f64, bool, bool)>(
                r#"SELECT ps."positionSeconds", ps."durationSeconds", ps.completed, ps."hiddenFromContinueWatching"
                   FROM playback_states ps JOIN media m ON m.id = ps."mediaId" JOIN users u ON u.id = ps."userId"
                   WHERE m.title = $1 AND u.username = 'user' AND ps."episodeId" IS NULL"#,
            )
            .bind(title).fetch_optional(&pool).await.unwrap()
        }
    };
    assert_eq!(
        row("Movie 1").await,
        Some((600.0, 3600.0, false, false)),
        "resume beats played"
    );
    assert_eq!(
        row("Movie 2").await,
        Some((5.0, 0.0, false, false)),
        "Fliks wins"
    );
    assert_eq!(row("Movie 3").await, Some((0.0, 1800.0, true, false)));
    assert_eq!(
        row("Movie 4").await,
        Some((300.0, 3600.0, false, true)),
        "hidden from continue watching"
    );
    assert_eq!(row("Movie 5").await, None);
    let eps: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM playback_states WHERE "episodeId" IS NOT NULL"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(eps, 2);
    let d: String = sqlx::query_scalar(r#"SELECT to_char("lastPlayedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM playback_states ps JOIN media m ON m.id = ps."mediaId" WHERE m.title = 'Movie 3'"#).fetch_one(&pool).await.unwrap();
    assert_eq!(d, "2024-03-04", "DateCreated fallback");
    // The created account sees the default role's libraries
    let libs: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM library_user_access a JOIN users u ON u.id = a."userId" WHERE u.username = 'newbie'"#).fetch_one(&pool).await.unwrap();
    assert_eq!(libs, 2);
    let status: String =
        sqlx::query_scalar("SELECT status FROM commands WHERE name = 'ImportWatchHistory'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "completed");
    // a re-run changes nothing the second time but still counts the same writes
    let again = run_import(&c, id).await;
    assert!(matches!(
        &again[2],
        SseEvent::WatchHistoryImportCompleted {
            users_created: 0,
            ..
        }
    ));
}

#[sqlx::test(migrations = false)]
async fn import_pages_through_the_total(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = add_server(&c, "big", &[], true).await;
    let ev = run_import(&c, id).await;
    assert!(
        matches!(&ev[2], SseEvent::WatchHistoryImportCompleted { users: 2, skipped, .. } if *skipped == 1100),
        "{ev:?}"
    );
}

#[sqlx::test(migrations = false)]
async fn import_skips_missing_and_blank_names(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = add_server(&c, "blank", &[], true).await;
    let ev = run_import(&c, id).await;
    assert!(
        matches!(
            &ev[2],
            SseEvent::WatchHistoryImportCompleted {
                users: 2,
                users_created: 0,
                imported: 0,
                ..
            }
        ),
        "{ev:?}"
    );
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE username !~ '^(admin|plain)$'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test(migrations = false)]
async fn import_guards_and_failures(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (_, p) = call(
        &c,
        "POST",
        "/api/media-servers",
        &c.admin,
        Some(json!({"name":"p","type":"plex","url":"http://u"})),
    )
    .await;
    let (s, b) = call(
        &c,
        "POST",
        &format!("/api/media-servers/{}/import-watch-history", p["id"]),
        &c.admin,
        None,
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (
            404,
            Some("Watch-history import is only supported for Emby servers")
        )
    );
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/media-servers/999/import-watch-history",
            &c.admin,
            None
        )
        .await
        .0,
        404
    );
    // A failing Users call is a failed event and a failed command row
    let id = add_server(&c, "nousers", &[], true).await;
    let ev = run_import(&c, id).await;
    assert!(
        matches!(&ev[2], SseEvent::WatchHistoryImportFailed { error, .. } if error.starts_with("listUsers failed:")),
        "{ev:?}"
    );
    assert!(matches!(&ev[3], SseEvent::CommandCompleted { status, .. } if status == "failed"));
    // A running import refuses a second one until it ends
    let claim = c.st.busy.watch_history.claim(id as i32).unwrap();
    let (s, b) = call(
        &c,
        "POST",
        &format!("/api/media-servers/{id}/import-watch-history"),
        &c.admin,
        None,
    )
    .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (409, Some("Import already running"))
    );
    drop(claim);
    assert_eq!(
        StatusCode::CREATED.as_u16(),
        call(
            &c,
            "POST",
            &format!("/api/media-servers/{id}/import-watch-history"),
            &c.admin,
            None
        )
        .await
        .0
    );
}

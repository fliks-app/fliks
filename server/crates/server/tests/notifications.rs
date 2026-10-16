//! Notification routes, senders and the dispatch bridge (`docs/spec/notifications.md`) against a
//! local mock receiver: no external network.
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Redirect},
    routing::{any, get},
};
use fliks_server::{app, config::Config, roles, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

#[derive(Clone, Default)]
struct Mock(Arc<Mutex<Vec<Seen>>>);

#[derive(Clone, Debug)]
struct Seen {
    uri: String,
    headers: HeaderMap,
    body: String,
}

/// Records every request; `/status/<n>` answers n, `/hang` never answers, `/redirect` 302s to `/ok`.
async fn spawn_mock() -> (String, Mock) {
    async fn record(
        State(m): State<Mock>,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> axum::response::Response {
        m.0.lock().unwrap().push(Seen {
            uri: uri.to_string(),
            headers,
            body: String::from_utf8_lossy(&body).into(),
        });
        match uri.path() {
            "/hang" => std::future::pending().await,
            "/redirect" => Redirect::temporary("/ok").into_response(),
            p => match p
                .strip_prefix("/status/")
                .and_then(|n| n.parse::<u16>().ok())
            {
                Some(n) => StatusCode::from_u16(n).unwrap().into_response(),
                None => StatusCode::OK.into_response(),
            },
        }
    }
    let mock = Mock::default();
    let app = Router::new()
        .route("/", get(record))
        .fallback(any(record))
        .with_state(mock.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (base, mock)
}

struct Ctx {
    app: Router,
    pool: PgPool,
    admin: String,
    plain: String,
    bridge: String,
}

async fn user(pool: &PgPool, st: &AppState, name: &str, admin: bool) -> String {
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin") VALUES ($1, $2) RETURNING id"#,
    )
    .bind(name)
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
    let admin = user(&pool, &st, "admin", true).await;
    let plain = user(&pool, &st, "plain", false).await;
    let bridge = st.cfg.bridge_token.clone();
    let app = app::router(
        st,
        fliks_engine::gateway::Upstream::parse("http://127.0.0.1:1").unwrap(),
        None,
        std::env::temp_dir(),
        None,
    );
    Ctx {
        app,
        pool,
        admin,
        plain,
        bridge,
    }
}

async fn call(
    c: &Ctx,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (u16, Value) {
    let mut req = axum::http::Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            axum::body::Body::from(b.to_string())
        }
        None => axum::body::Body::empty(),
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

async fn admin(c: &Ctx, method: &str, uri: &str, body: Option<Value>) -> (u16, Value) {
    call(c, method, uri, Some(&c.admin), body).await
}

async fn dispatch(c: &Ctx, body: Value) -> (u16, Value) {
    call(
        c,
        "POST",
        "/internal/notifications/dispatch",
        Some(&c.bridge),
        Some(body),
    )
    .await
}

fn bad(msgs: &[&str]) -> Value {
    json!({"statusCode": 400, "message": msgs, "error": "Bad Request"})
}

#[sqlx::test]
async fn authz_and_bad_ids(pool: PgPool) {
    let c = ctx(pool).await;
    let forbidden =
        json!({"statusCode": 403, "message": "Forbidden resource", "error": "Forbidden"});
    let ntfy = json!({"name": "n", "type": "ntfy", "settings": {"url": "https://n.test"}});
    for (m, u, b) in [
        ("GET", "/api/notifications", None),
        ("GET", "/api/notifications/events", None),
        ("GET", "/api/notifications/1", None),
        ("POST", "/api/notifications", Some(ntfy.clone())),
        ("PUT", "/api/notifications/1", Some(ntfy.clone())),
        ("DELETE", "/api/notifications/1", None),
        ("POST", "/api/notifications/1/test", None),
    ] {
        assert_eq!(call(&c, m, u, None, b.clone()).await.0, 401, "{m} {u}");
        assert_eq!(
            call(&c, m, u, Some(&c.plain), b).await,
            (403, forbidden.clone()),
            "{m} {u}"
        );
    }
    // C1: ids outside int4 or non-integers are 400, never 500.
    for id in ["99999999999", "abc", "007", "1.5"] {
        let (s, body) = admin(&c, "GET", &format!("/api/notifications/{id}"), None).await;
        assert_eq!(s, 400, "{id}");
        assert_eq!(
            body["message"],
            "Validation failed (numeric string is expected)"
        );
    }
    let (s, body) = admin(&c, "GET", "/api/notifications/9", None).await;
    assert_eq!(
        (s, body["message"].clone()),
        (404, json!("Notification connection #9 not found"))
    );
    assert_eq!(
        admin(&c, "DELETE", "/api/notifications/9", None).await.0,
        404
    );
    assert_eq!(
        admin(&c, "POST", "/api/notifications/9/test", None).await.0,
        404
    );
    assert_eq!(
        admin(&c, "PUT", "/api/notifications/9", Some(ntfy)).await.0,
        404
    );
}

#[sqlx::test]
async fn secrets_follow_the_f5_convention(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, created) = admin(
        &c,
        "POST",
        "/api/notifications",
        Some(json!({"name": "n", "type": "ntfy", "settings": {"url": " https://n.test ", "token": "tk"}, "events": ["request.created"]})),
    )
    .await;
    assert_eq!(s, 201);
    assert_eq!(
        created["settings"],
        json!({"url": "https://n.test", "secretsSet": ["token"]})
    );
    assert_eq!(
        (created["enabled"].clone(), created["events"].clone()),
        (json!(true), json!(["request.created"]))
    );
    let id = created["id"].as_i64().unwrap();
    let uri = format!("/api/notifications/{id}");
    let put = |settings: Value| json!({"name": "n2", "type": "ntfy", "settings": settings});

    // a blank or echoed token keeps the stored one
    let (s, b) = admin(
        &c,
        "PUT",
        &uri,
        Some(put(
            json!({"url": "https://n.test", "token": "", "secretsSet": ["token"]}),
        )),
    )
    .await;
    assert_eq!(
        (s, b["settings"].clone(), b["name"].clone()),
        (
            200,
            json!({"url": "https://n.test", "secretsSet": ["token"]}),
            json!("n2")
        )
    );
    let stored: Value =
        sqlx::query_scalar("SELECT settings FROM notification_connections WHERE id = $1")
            .bind(id as i32)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(stored, json!({"url": "https://n.test", "token": "tk"}));
    // a type switch drops it, null erases it
    let switch = json!({"name": "n2", "type": "webhook", "settings": {"url": "https://n.test"}});
    let (_, b) = admin(&c, "PUT", &uri, Some(switch)).await;
    assert_eq!(
        b["settings"],
        json!({"url": "https://n.test", "secretsSet": []})
    );
    admin(&c, "PUT", &uri, Some(json!({"name": "n", "type": "webhook", "settings": {"url": "https://n.test", "token": "t2"}}))).await;
    let (_, b) = admin(&c, "PUT", &uri, Some(json!({"name": "n", "type": "webhook", "settings": {"url": "https://n.test", "token": null}}))).await;
    assert_eq!(
        b["settings"],
        json!({"url": "https://n.test", "secretsSet": []})
    );

    // gotify needs a token
    let gotify = json!({"name": "g", "type": "gotify", "settings": {"url": "https://g.test"}});
    assert_eq!(
        admin(&c, "POST", "/api/notifications", Some(gotify))
            .await
            .1["message"],
        "gotify requires a non-empty settings.token"
    );
}

#[sqlx::test]
async fn f28_webhook_url_is_a_secret(pool: PgPool) {
    let c = ctx(pool).await;
    let hook = "https://discord.test/api/webhooks/1/abc";
    let (_, d) = admin(&c, "POST", "/api/notifications", Some(json!({"name": "d", "type": "discord", "settings": {"webhookUrl": hook, "username": "Bot"}}))).await;
    assert_eq!(
        d["settings"],
        json!({"username": "Bot", "secretsSet": ["webhookUrl"]})
    );
    let id = d["id"].as_i64().unwrap();
    let uri = format!("/api/notifications/{id}");
    let (_, list) = admin(&c, "GET", "/api/notifications", None).await;
    assert!(!list.to_string().contains("abc"));
    // omitting it on update keeps the stored endpoint and still validates
    let (s, b) = admin(
        &c,
        "PUT",
        &uri,
        Some(json!({"name": "d", "type": "discord", "settings": {"username": "Bot2"}})),
    )
    .await;
    assert_eq!(
        (s, b["settings"].clone()),
        (
            200,
            json!({"username": "Bot2", "secretsSet": ["webhookUrl"]})
        )
    );
    let stored: Value =
        sqlx::query_scalar("SELECT settings FROM notification_connections WHERE id = $1")
            .bind(id as i32)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(stored["webhookUrl"], hook);
    // null erases it, which the endpoint constraint rejects
    let erase = json!({"name": "d", "type": "discord", "settings": {"webhookUrl": null}});
    assert_eq!(
        admin(&c, "PUT", &uri, Some(erase)).await.1,
        bad(&["discord requires settings.webhookUrl to be an http(s) URL"])
    );
    // a type switch to slack carries no endpoint
    let slack = json!({"name": "d", "type": "slack", "settings": {}});
    assert_eq!(
        admin(&c, "PUT", &uri, Some(slack)).await.1,
        bad(&["slack requires settings.webhookUrl to be an http(s) URL"])
    );
    // create still requires one
    let none = json!({"name": "d", "type": "slack", "settings": {}});
    assert_eq!(
        admin(&c, "POST", "/api/notifications", Some(none)).await.0,
        400
    );
}

#[sqlx::test]
async fn validation_and_events_list(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, ev) = admin(&c, "GET", "/api/notifications/events", None).await;
    assert_eq!(ev.as_array().unwrap().len(), 17);
    assert!(!ev.to_string().contains("health.issue"));
    let (s, b) = admin(
        &c,
        "POST",
        "/api/notifications",
        Some(
            json!({"name": "n", "type": "ntfy", "settings": {"url": "nope"}, "events": ["bogus"]}),
        ),
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(
        b["message"][0],
        "ntfy requires settings.url to be an http(s) URL"
    );
    assert!(
        b["message"][1]
            .as_str()
            .unwrap()
            .starts_with("each value in events must be one of")
    );
    // C1: a null on a column that cannot hold it is a 400, not Nest's 500
    let ok = json!({"name": "n", "type": "ntfy", "settings": {"url": "https://n.test"}});
    let (_, created) = admin(&c, "POST", "/api/notifications", Some(ok.clone())).await;
    let uri = format!("/api/notifications/{}", created["id"]);
    let mut nulls = ok;
    nulls["events"] = Value::Null;
    nulls["enabled"] = Value::Null;
    assert_eq!(
        admin(&c, "PUT", &uri, Some(nulls)).await.1,
        bad(&["events must be an array", "enabled must be a boolean value"])
    );
    assert_eq!(admin(&c, "DELETE", &uri, None).await.0, 200);
    assert_eq!(admin(&c, "GET", &uri, None).await.0, 404);
}

async fn add(c: &Ctx, name: &str, typ: &str, settings: Value, events: Value, enabled: bool) {
    // settings are written raw: the mock URL is http, which the DTO accepts, but this skips secrets handling
    sqlx::query("INSERT INTO notification_connections (name, type, settings, events, enabled) VALUES ($1, $2, $3, $4, $5)")
        .bind(name)
        .bind(typ)
        .bind(settings)
        .bind(events)
        .bind(enabled)
        .execute(&c.pool)
        .await
        .unwrap();
}

#[sqlx::test]
async fn dispatch_reaches_enabled_subscribed_connections(pool: PgPool) {
    let c = ctx(pool).await;
    let (base, mock) = spawn_mock().await;
    let ev = json!(["request.available"]);
    add(
        &c,
        "a-discord",
        "discord",
        json!({"webhookUrl": format!("{base}/discord")}),
        ev.clone(),
        true,
    )
    .await;
    add(
        &c,
        "b-slack",
        "slack",
        json!({"webhookUrl": format!("{base}/slack")}),
        ev.clone(),
        true,
    )
    .await;
    add(
        &c,
        "c-webhook",
        "webhook",
        json!({"url": format!("{base}/hook"), "token": "tk"}),
        ev.clone(),
        true,
    )
    .await;
    add(
        &c,
        "d-gotify",
        "gotify",
        json!({"url": format!("{base}/"), "token": "a b&c"}),
        ev.clone(),
        true,
    )
    .await;
    add(
        &c,
        "e-ntfy",
        "ntfy",
        json!({"url": format!("{base}/"), "token": "nt"}),
        ev.clone(),
        true,
    )
    .await;
    add(
        &c,
        "f-off",
        "slack",
        json!({"webhookUrl": format!("{base}/off")}),
        ev,
        false,
    )
    .await;
    add(
        &c,
        "g-other",
        "slack",
        json!({"webhookUrl": format!("{base}/other")}),
        json!(["request.created"]),
        true,
    )
    .await;
    // a failing sender (500) neither changes the status nor stops the others
    add(
        &c,
        "h-broken",
        "slack",
        json!({"webhookUrl": format!("{base}/status/500")}),
        json!(["request.available"]),
        true,
    )
    .await;

    let payload = json!({"title": "Dune @everyone", "mediaType": "movie"});
    assert_eq!(
        dispatch(
            &c,
            json!({"event": "request.available", "payload": payload})
        )
        .await
        .0,
        204
    );

    let seen = mock.0.lock().unwrap().clone();
    let at = |p: &str| {
        seen.iter()
            .find(|s| s.uri == p)
            .unwrap_or_else(|| panic!("{p} not called: {seen:?}"))
    };
    let json_body = |s: &Seen| serde_json::from_str::<Value>(&s.body).unwrap();
    assert_eq!(seen.len(), 6, "{seen:?}");
    assert_eq!(
        json_body(at("/discord")),
        json!({"username": "Fliks", "content": "Request available: Dune @everyone", "allowed_mentions": {"parse": []}})
    );
    assert_eq!(
        json_body(at("/slack")),
        json!({"text": "Request available: Dune @everyone"})
    );
    let hook = at("/hook");
    assert_eq!(hook.headers["authorization"], "Bearer tk");
    assert_eq!(
        json_body(hook),
        json!({"event": "request.available", "title": "Dune @everyone", "mediaType": "movie"})
    );
    let gotify = at("/message?token=a%20b%26c");
    assert_eq!(
        json_body(gotify),
        json!({"title": "Fliks \u{2014} request.available", "message": "Request available: Dune @everyone", "priority": 5})
    );
    let ntfy = at("/fliks");
    assert_eq!(ntfy.body, "Request available: Dune @everyone");
    assert_eq!(ntfy.headers["title"], "Fliks - request.available");
    assert_eq!(ntfy.headers["authorization"], "Bearer nt");
    assert_eq!(
        ntfy.headers["content-type"],
        "application/x-www-form-urlencoded"
    );
}

#[sqlx::test]
async fn bridge_validates_before_sending(pool: PgPool) {
    let c = ctx(pool).await;
    async fn post(c: &Ctx, token: Option<&str>, body: Value) -> (u16, Value) {
        call(
            c,
            "POST",
            "/internal/notifications/dispatch",
            token,
            Some(body),
        )
        .await
    }
    let ok = json!({"event": "request.created", "payload": {}});
    assert_eq!(post(&c, None, ok.clone()).await.0, 401);
    assert_eq!(post(&c, Some("wrong"), ok.clone()).await.0, 401);
    assert_eq!(post(&c, Some(&c.bridge), ok).await.0, 204);
    let vocab = "event must be one of the following values: request.created, request.approved";
    for body in [
        json!({"event": "nope", "payload": {}}),
        json!({"event": 5, "payload": {}}),
        json!({"payload": {}}),
    ] {
        let (s, b) = post(&c, Some(&c.bridge), body).await;
        assert_eq!(s, 400);
        assert!(b["message"][0].as_str().unwrap().starts_with(vocab), "{b}");
        assert_eq!(b["error"], "Bad Request");
    }
    assert_eq!(
        post(
            &c,
            Some(&c.bridge),
            json!({"event": "request.created", "payload": []})
        )
        .await
        .1,
        bad(&["payload must be an object"])
    );
    assert_eq!(
        post(&c, Some(&c.bridge), json!({"event": "request.created"}))
            .await
            .1,
        bad(&["payload must be an object"])
    );
    assert_eq!(
        post(
            &c,
            Some(&c.bridge),
            json!({"event": "request.created", "payload": {}, "x": 1})
        )
        .await
        .1,
        bad(&["property x should not exist"])
    );
}

async fn test_send(c: &Ctx, typ: &str, settings: Value) -> (u16, Value) {
    add(c, "t", typ, settings, json!([]), false).await;
    let id: i32 = sqlx::query_scalar("SELECT max(id) FROM notification_connections")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    admin(c, "POST", &format!("/api/notifications/{id}/test"), None).await
}

#[sqlx::test]
async fn test_route_reports_results_never_errors(pool: PgPool) {
    let c = ctx(pool).await;
    let (base, mock) = spawn_mock().await;
    // regardless of `enabled` and `events`
    let (s, b) = test_send(&c, "webhook", json!({"url": format!("{base}/hook")})).await;
    assert_eq!(
        (s, b),
        (
            201,
            json!({"ok": true, "message": "Test notification sent"})
        )
    );
    let sent: Value = serde_json::from_str(&mock.0.lock().unwrap()[0].body).unwrap();
    assert_eq!(
        sent,
        json!({"event": "health.issue", "test": true, "message": "Test notification from Fliks"})
    );

    let (s, b) = test_send(
        &c,
        "slack",
        json!({"webhookUrl": format!("{base}/status/401")}),
    )
    .await;
    assert_eq!(
        (s, b),
        (
            201,
            json!({"ok": false, "message": "Request failed with status code 401"})
        )
    );
    // redirects are followed as in Nest (Q1)
    let (_, b) = test_send(
        &c,
        "slack",
        json!({"webhookUrl": format!("{base}/redirect")}),
    )
    .await;
    assert_eq!(b["ok"], true);
    let (_, b) = test_send(&c, "gotify", json!({"url": base})).await;
    assert_eq!(b, json!({"ok": false, "message": "url and token required"}));
    let (_, b) = test_send(&c, "discord", json!({})).await;
    assert_eq!(
        b,
        json!({"ok": false, "message": "webhookUrl not configured"})
    );
}

#[sqlx::test]
async fn f29_errors_never_carry_the_url(pool: PgPool) {
    let c = ctx(pool).await;
    // a port nothing listens on: bind then drop
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = closed.local_addr().unwrap();
    drop(closed);
    for (typ, settings) in [
        (
            "gotify",
            json!({"url": format!("http://{addr}"), "token": "SECRET-TOKEN-1"}),
        ),
        (
            "discord",
            json!({"webhookUrl": format!("http://{addr}/api/webhooks/1/SECRET-HOOK-2")}),
        ),
    ] {
        let (s, b) = test_send(&c, typ, settings).await;
        assert_eq!((s, b["ok"].clone()), (201, json!(false)));
        let msg = b["message"].as_str().unwrap();
        for leak in ["SECRET", "127.0.0.1", &addr.port().to_string(), "token="] {
            assert!(!msg.contains(leak), "{typ}: {msg}");
        }
    }
}

#[sqlx::test]
async fn c16_a_silent_receiver_times_out_after_10s(pool: PgPool) {
    let c = ctx(pool).await;
    let (base, _) = spawn_mock().await;
    add(
        &c,
        "t",
        "slack",
        json!({"webhookUrl": format!("{base}/hang")}),
        json!(["request.created"]),
        true,
    )
    .await;
    let id: i32 = sqlx::query_scalar("SELECT max(id) FROM notification_connections")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    // Real clock: a paused one auto-advances during sqlx I/O and can fire the pool timeouts.
    let t = std::time::Instant::now();
    let (s, b) = admin(&c, "POST", &format!("/api/notifications/{id}/test"), None).await;
    assert_eq!(
        (s, b),
        (
            201,
            json!({"ok": false, "message": "timeout of 10000ms exceeded"})
        )
    );
    assert!(t.elapsed() >= std::time::Duration::from_secs(10));
    // dispatch is bounded by the same timeout and still answers 204
    assert_eq!(
        dispatch(&c, json!({"event": "request.created", "payload": {}}))
            .await
            .0,
        204
    );
}

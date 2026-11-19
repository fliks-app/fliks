//! Push notifications (`docs/spec/push.md`) against a fake relay: no external network.
use crate::session;
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
    routing::any,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fliks_server::{
    app,
    config::Config,
    events::{Bus, Identity, SseEvent},
    push::{self, Notification},
    roles,
    state::AppState,
};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

#[derive(Clone, Default)]
struct Relay(Arc<Mutex<Vec<Seen>>>);

#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    body: Vec<u8>,
    signed: bool,
}

impl Relay {
    fn seen(&self, method: &str, path_prefix: &str) -> Vec<Seen> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.method == method && s.path.starts_with(path_prefix))
            .cloned()
            .collect()
    }

    async fn wait(&self, method: &str, path_prefix: &str, n: usize) {
        for _ in 0..100 {
            if self.seen(method, path_prefix).len() >= n {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        panic!(
            "relay never saw {n} x {method} {path_prefix}: {:?}",
            self.0.lock().unwrap()
        );
    }
}

/// Records every request and checks its signature as the relay would; answers like a healthy relay.
async fn spawn_relay() -> (String, Relay) {
    async fn handle(
        State((relay, host)): State<(Relay, String)>,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> axum::response::Response {
        let h = |k: &str| {
            headers
                .get(k)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let signed = match (h("fliks-key"), h("fliks-time"), h("fliks-signature")) {
            (Some(key), Some(time), Some(sig)) => {
                let vk = VerifyingKey::from_bytes(&B64.decode(key).unwrap().try_into().unwrap())
                    .unwrap();
                let text = format!(
                    "fliks-relay-v1\n{method}\n{host}\n{}\n{time}\n{}",
                    uri.path(),
                    sha256_hex(&body)
                );
                let sig = Signature::from_bytes(&B64.decode(sig).unwrap().try_into().unwrap());
                vk.verify(text.as_bytes(), &sig)
                    .expect("signature verifies");
                true
            }
            _ => false,
        };
        relay.0.lock().unwrap().push(Seen {
            method: method.to_string(),
            path: uri.path().to_owned(),
            body: body.to_vec(),
            signed,
        });
        match (method.as_str(), uri.path()) {
            ("GET", "/v1/info") => axum::Json(json!({"api": 1})).into_response(),
            ("POST", "/v1/servers") => (StatusCode::CREATED, axum::Json(json!({}))).into_response(),
            ("GET", "/v1/servers/self/stats") => axum::Json(json!({"days": []})).into_response(),
            ("POST", "/v1/push") => axum::Json(json!({})).into_response(),
            ("DELETE", _) => StatusCode::NO_CONTENT.into_response(),
            _ => StatusCode::NOT_FOUND.into_response(),
        }
    }
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let relay = Relay::default();
    let app = Router::new()
        .fallback(any(handle))
        .with_state((relay.clone(), addr.to_string()));
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (format!("http://{addr}"), relay)
}

fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

struct Ctx {
    app: Router,
    st: AppState,
    relay: Relay,
    admin: String,
    user: String,
    user_id: i32,
    conf: std::path::PathBuf,
}

async fn make_user(pool: &PgPool, st: &AppState, name: &str, admin: bool) -> (i32, String) {
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin") VALUES ($1, $2) RETURNING id"#,
    )
    .bind(name)
    .bind(admin)
    .fetch_one(pool)
    .await
    .unwrap();
    (id, session::token(st, id, name).await)
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    roles::seed(&pool).await.unwrap();
    let (url, relay) = spawn_relay().await;
    let base = std::env::temp_dir().join(format!(
        "fliks-push-it-{}",
        fliks_server::config::random_hex(4)
    ));
    let conf = base.join("conf");
    std::fs::create_dir_all(base.join("static/i18n")).unwrap();
    std::fs::write(
        base.join("static/i18n/fr.json"),
        json!({"push": {"test": {"title": "Notification de test", "body": "ok"}}}).to_string(),
    )
    .unwrap();
    let cfg = Config::from_lookup(|k| match k {
        "FLIKS_CONF_DIR" => Some(conf.to_string_lossy().into()),
        "FLIKS_PUSH_RELAY_URL" => Some(url.clone()),
        "SERVE_STATIC_PATH" => Some(base.join("static").to_string_lossy().into()),
        _ => None,
    });
    let st = AppState::new(pool.clone(), cfg, SECRET);
    let (_, admin) = make_user(&pool, &st, "admin", true).await;
    let (user_id, user) = make_user(&pool, &st, "plain", false).await;
    let app = app::router(st.clone(), None, std::env::temp_dir(), None);
    Ctx {
        app,
        st,
        relay,
        admin,
        user,
        user_id,
        conf,
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

fn keys(seed: u8) -> (String, String) {
    let sk = p256::SecretKey::from_slice(&[seed; 32]).unwrap();
    (
        B64.encode(sk.public_key().to_encoded_point(false).as_bytes()),
        B64.encode([seed; 16]),
    )
}

async fn subscribe(c: &Ctx, token: &str, platform: &str, seed: u8) -> (u16, Value) {
    let (p256dh, auth) = keys(seed);
    call(
        c,
        "POST",
        "/api/push/subscriptions",
        Some(token),
        Some(json!({"platform": platform, "p256dh": p256dh, "auth": auth, "locale": "fr-CA"})),
    )
    .await
}

async fn set_relay(c: &Ctx, enabled: bool) {
    let (s, body) = call(
        c,
        "PUT",
        "/api/notifications/1",
        Some(&c.admin),
        Some(json!({"enabled": enabled})),
    )
    .await;
    assert_eq!((s, body["enabled"].clone()), (200, json!(enabled)));
}

#[sqlx::test]
async fn the_builtin_connection_is_seeded_and_protected(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, list) = call(&c, "GET", "/api/notifications", Some(&c.admin), None).await;
    assert_eq!(s, 200);
    let row = &list.as_array().unwrap()[0];
    assert_eq!(
        (
            row["name"].clone(),
            row["type"].clone(),
            row["enabled"].clone(),
            row["settings"].clone()
        ),
        (
            json!("Fliks Relay"),
            json!("fliks-relay"),
            json!(false),
            json!({})
        )
    );
    let new = json!({"name": "x", "type": "fliks-relay", "settings": {}});
    assert_eq!(
        call(&c, "POST", "/api/notifications", Some(&c.admin), Some(new))
            .await
            .0,
        400
    );
    let (s, body) = call(&c, "DELETE", "/api/notifications/1", Some(&c.admin), None).await;
    assert_eq!(
        (s, body["message"].clone()),
        (400, json!("notifications.error_builtin"))
    );
    let (s, body) = call(&c, "PUT", "/api/notifications/1", Some(&c.admin), Some(json!({"name": "x", "type": "webhook", "settings": {"url": "https://x.test"}, "enabled": false}))).await;
    assert_eq!(
        (s, body["name"].clone(), body["type"].clone()),
        (200, json!("Fliks Relay"), json!("fliks-relay"))
    );
    let (_, test) = call(
        &c,
        "POST",
        "/api/notifications/1/test",
        Some(&c.admin),
        None,
    )
    .await;
    assert_eq!(test["ok"], false);
    // the seeded row does not tick the setup checklist
    let (_, list) = call(&c, "GET", "/api/setup-checklist", Some(&c.admin), None).await;
    let item = list
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["key"] == "notification")
        .unwrap()
        .clone();
    assert_eq!(item["done"], false, "{item}");
}

#[sqlx::test]
async fn enabling_registers_and_disabling_deletes_everything_at_the_relay(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, body) = subscribe(&c, &c.user, "apns", 1).await;
    assert_eq!(
        (s, body["message"].clone()),
        (409, json!("push.error_disabled"))
    );
    set_relay(&c, true).await;
    c.relay.wait("POST", "/v1/servers", 1).await;
    assert!(c.relay.seen("POST", "/v1/servers")[0].signed);
    let (s, sub) = subscribe(&c, &c.user, "apns", 1).await;
    assert_eq!(s, 201, "{sub}");
    let ticket = sub["ticket"].as_str().unwrap();
    let claims: Value =
        serde_json::from_slice(&B64.decode(ticket.split('.').next().unwrap()).unwrap()).unwrap();
    assert_eq!(claims["sub"], sub["sub"]);
    assert_eq!(claims["aud"].as_str().unwrap(), c.relay_host());
    // the same session subscribing again keeps its sub
    let (_, again) = subscribe(&c, &c.user, "apns", 2).await;
    assert_eq!(again["sub"], sub["sub"]);
    let (s, status) = call(&c, "GET", "/api/push/status", Some(&c.admin), None).await;
    assert_eq!(
        (
            s,
            status["relay"]["state"].clone(),
            status["mobile"]["subscriptions"].clone()
        ),
        (200, json!("ready"), json!(1))
    );
    // a test push reaches the relay with the subscription and an encrypted payload
    let (s, test) = call(&c, "POST", "/api/push/test", Some(&c.user), None).await;
    assert_eq!(
        (s, test["results"][0]["ok"].clone()),
        (200, json!(true)),
        "{test}"
    );
    let pushed = c.relay.seen("POST", "/v1/push");
    let sent: Value = serde_json::from_slice(&pushed[0].body).unwrap();
    assert_eq!(sent["sub"], sub["sub"]);
    assert!(B64.decode(sent["payload"].as_str().unwrap()).unwrap().len() > 103);
    set_relay(&c, false).await;
    c.relay.wait("DELETE", "/v1/servers/self", 1).await;
    let (_, status) = call(&c, "GET", "/api/push/status", Some(&c.admin), None).await;
    assert_eq!(
        (
            status["relay"]["state"].clone(),
            status["mobile"]["subscriptions"].clone()
        ),
        (json!("disabled"), json!(0))
    );
    assert_eq!(status["relay"]["pendingDeletions"], json!([]));
    std::fs::remove_dir_all(c.conf.parent().unwrap()).unwrap();
}

impl Ctx {
    fn relay_host(&self) -> String {
        reqwest_host(&self.st)
    }
}

fn reqwest_host(st: &AppState) -> String {
    let u = st.cfg.push_relay_url.clone().unwrap();
    u.trim_start_matches("http://").to_owned()
}

#[sqlx::test]
async fn subscription_validation_and_web_endpoints(pool: PgPool) {
    let c = ctx(pool).await;
    let (p256dh, auth) = keys(3);
    let web = |endpoint: &str| json!({"platform": "web", "p256dh": p256dh, "auth": auth, "locale": "en", "endpoint": endpoint});
    for bad in [
        "http://fcm.googleapis.com/x",
        "https://evil.example/x",
        "https://127.0.0.1/x",
    ] {
        assert_eq!(
            call(
                &c,
                "POST",
                "/api/push/subscriptions",
                Some(&c.user),
                Some(web(bad))
            )
            .await
            .0,
            400,
            "{bad}"
        );
    }
    let (s, ok) = call(
        &c,
        "POST",
        "/api/push/subscriptions",
        Some(&c.user),
        Some(web("https://fcm.googleapis.com/fcm/send/abc")),
    )
    .await;
    assert_eq!(s, 201, "{ok}");
    assert!(ok["id"].is_number());
    let broken = json!({"platform": "web", "p256dh": "AAAA", "auth": auth, "locale": "en", "endpoint": "https://fcm.googleapis.com/x"});
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/push/subscriptions",
            Some(&c.user),
            Some(broken)
        )
        .await
        .0,
        400
    );
    let (s, cfg) = call(&c, "GET", "/api/push/config", Some(&c.user), None).await;
    assert_eq!((s, cfg["mobile"].clone()), (200, json!(false)));
    assert!(cfg["vapidPublicKey"].as_str().unwrap().len() > 80);
    let (s, _) = call(
        &c,
        "DELETE",
        "/api/push/subscriptions/current",
        Some(&c.user),
        Some(json!({"platform": "web"})),
    )
    .await;
    assert_eq!(s, 204);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM push_subscriptions")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(n, 0);
    // an admin route for a plain user
    assert_eq!(
        call(&c, "GET", "/api/push/status", Some(&c.user), None)
            .await
            .0,
        403
    );
}

#[sqlx::test]
async fn a_user_keeps_ten_subscriptions_at_most(pool: PgPool) {
    let c = ctx(pool).await;
    for i in 0..11 {
        let token = session::token(&c.st, c.user_id, "plain").await;
        let (p256dh, auth) = keys(5);
        let (s, body) = call(&c, "POST", "/api/push/subscriptions", Some(&token), Some(json!({"platform": "web", "p256dh": p256dh, "auth": auth, "locale": "en", "endpoint": format!("https://fcm.googleapis.com/fcm/send/{i}")}))).await;
        assert_eq!(s, 201, "{body}");
    }
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM push_subscriptions")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(n, 10);
    let first: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM push_subscriptions WHERE endpoint LIKE '%/send/0'",
    )
    .fetch_one(&c.st.db)
    .await
    .unwrap();
    assert_eq!(first, 0, "the oldest is replaced");
}

#[sqlx::test]
async fn notify_renders_per_language_and_honours_mutes(pool: PgPool) {
    let c = ctx(pool).await;
    let sid: i32 = sqlx::query_scalar(r#"SELECT id FROM sessions WHERE "userId" = $1"#)
        .bind(c.user_id)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    let _fr = c.st.hub.connect_session(
        c.user_id,
        Some(sid),
        Identity {
            lang: Some("fr".into()),
            ..Identity::default()
        },
    );
    let _en =
        c.st.hub
            .connect_session(c.user_id, Some(sid), Identity::default());
    let mut bus = c.st.hub.subscribe();
    let send = || {
        push::notify(
            &c.st,
            vec![c.user_id],
            Notification::core("account", "test", &Default::default(), "/".into(), 300),
        )
    };
    send();
    let mut titles = vec![];
    while titles.len() < 2 {
        let ev = tokio::time::timeout(Duration::from_secs(5), bus.recv())
            .await
            .unwrap()
            .unwrap();
        if let Bus::Sse(SseEvent::Notification { title, cat, .. }) = &*ev {
            assert_eq!(cat, "account");
            titles.push(title.clone());
        }
    }
    titles.sort();
    assert_eq!(titles, ["Notification de test", "Test notification"]);
    // a muted category reaches nobody
    let (s, _) = call(
        &c,
        "PUT",
        &format!("/api/users/{}", c.user_id),
        Some(&c.admin),
        Some(json!({"pushMuted": ["account"]})),
    )
    .await;
    assert_eq!(s, 200);
    send();
    let got = tokio::time::timeout(Duration::from_millis(500), async {
        loop {
            if let Ok(ev) = bus.recv().await
                && matches!(&*ev, Bus::Sse(SseEvent::Notification { .. }))
            {
                return true;
            }
        }
    })
    .await;
    assert!(got.is_err(), "muted");
    let (s, bad) = call(
        &c,
        "PUT",
        &format!("/api/users/{}", c.user_id),
        Some(&c.admin),
        Some(json!({"pushMuted": ["nope"]})),
    )
    .await;
    assert_eq!(s, 400, "{bad}");
}

#[sqlx::test]
async fn revoking_a_session_deletes_its_relay_subscription(pool: PgPool) {
    let c = ctx(pool).await;
    set_relay(&c, true).await;
    c.relay.wait("POST", "/v1/servers", 1).await;
    let (s, sub) = subscribe(&c, &c.user, "fcm", 4).await;
    assert_eq!(s, 201, "{sub}");
    let sid: i32 = sqlx::query_scalar("SELECT \"sessionId\" FROM push_subscriptions")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    let (s, _) = call(
        &c,
        "DELETE",
        &format!("/api/auth/sessions/{sid}"),
        Some(&c.user),
        None,
    )
    .await;
    assert_eq!(s, 204);
    let path = format!("/v1/subscriptions/{}", sub["sub"].as_str().unwrap());
    c.relay.wait("DELETE", &path, 1).await;
    for _ in 0..50 {
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM push_subscriptions")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        if n == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the row stayed");
}

#[sqlx::test]
async fn attention_counts_pending_requests_and_follow_requests(pool: PgPool) {
    let c = ctx(pool).await;
    sqlx::query(r#"INSERT INTO requests ("mediaType", provider, "externalId", title, status, "userId") VALUES ('movie', 'tmdb', '1', 'T', 'pending', $1)"#)
        .bind(c.user_id)
        .execute(&c.st.db)
        .await
        .unwrap();
    let (_, admin) = call(&c, "GET", "/api/counts", Some(&c.admin), None).await;
    let (_, user) = call(&c, "GET", "/api/counts", Some(&c.user), None).await;
    assert_eq!(
        (admin["attention"].clone(), user["attention"].clone()),
        (json!(1), json!(0))
    );
}

async fn act_token(c: &Ctx, user: i32, action: &str, target: i32, exp_in: i64) -> String {
    push::mint_action(
        &c.st.grant_key,
        &push::Grant {
            user,
            action: action.into(),
            target,
            exp: chrono::Utc::now().timestamp() + exp_in,
        },
    )
}

async fn act(c: &Ctx, bearer: &str, token: &str) -> (u16, Value) {
    call(
        c,
        "POST",
        "/api/push/act",
        Some(bearer),
        Some(json!({"token": token})),
    )
    .await
}

#[sqlx::test]
async fn act_runs_the_existing_routes_for_the_token_user_only(pool: PgPool) {
    let c = ctx(pool).await;
    let admin_id: i32 = sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    let request: i32 = sqlx::query_scalar(r#"INSERT INTO requests ("mediaType", provider, "externalId", title, status, "userId") VALUES ('movie', 'tmdb', '1', 'T', 'pending', $1) RETURNING id"#)
        .bind(c.user_id)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    // decline: a manager acts through the token, the requests route state follows
    let decline = act_token(&c, admin_id, "request.decline", request, 60).await;
    assert_eq!(
        act(&c, &c.user, &decline).await.0,
        403,
        "another user's token"
    );
    assert_eq!(act(&c, &c.admin, &decline).await.0, 204);
    let status: String = sqlx::query_scalar("SELECT status::text FROM requests WHERE id = $1")
        .bind(request)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    assert_eq!(status, "declined");
    // a second decline is the route's own state error
    assert_eq!(act(&c, &c.admin, &decline).await.0, 409);
    // approve reaches the approve route: an unknown request is its 404
    let approve = act_token(&c, admin_id, "request.approve", 9999, 60).await;
    assert_eq!(act(&c, &c.admin, &approve).await.0, 404);
    // a plain user keeps the route's permission check
    let own = act_token(&c, c.user_id, "request.approve", request, 60).await;
    assert_eq!(act(&c, &c.user, &own).await.0, 403);
    // expired, tampered, malformed
    let old = act_token(&c, admin_id, "request.decline", request, -5).await;
    assert_eq!(act(&c, &c.admin, &old).await.0, 403);
    assert_eq!(
        act(
            &c,
            &c.admin,
            &decline.replace(":request.decline:", ":request.approve:")
        )
        .await
        .0,
        403
    );
    assert_eq!(act(&c, &c.admin, "nope").await.0, 400);
    let unknown = act_token(&c, admin_id, "request.explode", 1, 60).await;
    assert_eq!(act(&c, &c.admin, &unknown).await.0, 400);
}

#[sqlx::test]
async fn act_accepts_and_rejects_follow_requests(pool: PgPool) {
    let c = ctx(pool).await;
    let admin_id: i32 = sqlx::query_scalar("SELECT id FROM users WHERE username = 'admin'")
        .fetch_one(&c.st.db)
        .await
        .unwrap();
    let follow = |status: &'static str| {
        let (pool, from, to) = (c.st.db.clone(), c.user_id, admin_id);
        async move {
            sqlx::query(r#"DELETE FROM user_follows"#)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query(r#"INSERT INTO user_follows ("followerId", "followingId", status) VALUES ($1, $2, $3::text::user_follows_status_enum)"#)
                .bind(from)
                .bind(to)
                .bind(status)
                .execute(&pool)
                .await
                .unwrap();
        }
    };
    let state = |c: &Ctx| {
        let pool = c.st.db.clone();
        async move {
            sqlx::query_scalar::<_, String>("SELECT status::text FROM user_follows")
                .fetch_optional(&pool)
                .await
                .unwrap()
        }
    };
    follow("pending").await;
    let (_, counts) = call(&c, "GET", "/api/counts", Some(&c.admin), None).await;
    assert_eq!(counts["attention"], 1);
    let accept = act_token(&c, admin_id, "follow.accept", c.user_id, 60).await;
    assert_eq!(act(&c, &c.admin, &accept).await.0, 204);
    assert_eq!(state(&c).await.as_deref(), Some("accepted"));
    follow("pending").await;
    let reject = act_token(&c, admin_id, "follow.decline", c.user_id, 60).await;
    assert_eq!(act(&c, &c.admin, &reject).await.0, 204);
    assert_eq!(state(&c).await, None);
}

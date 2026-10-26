//! `/api/auth/*` through the real router on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_server::{auth, config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    st: AppState,
    app: Router,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool, Config::from_lookup(|_| None), SECRET);
    let app = auth::router().with_state(st.clone());
    Ctx { st, app }
}

async fn user(pool: &PgPool, name: &str, perms: Option<&str>, admin: bool, enabled: bool) -> i32 {
    let role: Option<i32> = match perms {
        None => None,
        Some(p) => Some(
            sqlx::query_scalar(
                r#"INSERT INTO roles (name, permissions) VALUES ($1, $2) RETURNING id"#,
            )
            .bind(format!("r-{name}"))
            .bind(p)
            .fetch_one(pool)
            .await
            .unwrap(),
        ),
    };
    let hash = bcrypt::hash(format!("{name}-pass"), 4).unwrap();
    sqlx::query_scalar(
        r#"INSERT INTO users (username, "passwordHash", "roleId", "isAdmin", enabled) VALUES ($1, $2, $3, $4, $5) RETURNING id"#,
    )
    .bind(name)
    .bind(hash)
    .bind(role)
    .bind(admin)
    .bind(enabled)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn call(
    c: &Ctx,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> (u16, axum::http::HeaderMap, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
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
    let (status, h) = (res.status().as_u16(), res.headers().clone());
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        h,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn bearer(c: &Ctx, id: i32, name: &str) -> String {
    format!("Bearer {}", c.st.jwt.sign_access(id, name).unwrap().token)
}

async fn login(c: &Ctx, name: &str) -> Value {
    let (s, _, b) = call(
        c,
        "POST",
        "/api/auth/login",
        &[],
        Some(json!({"username": name, "password": format!("{name}-pass")})),
    )
    .await;
    assert_eq!(s, 201, "{b}");
    b
}

#[sqlx::test(migrations = false)]
async fn login_and_refresh_rotate(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    user(&pool, "bob", Some("[]"), false, true).await;
    user(&pool, "off", None, false, false).await;
    let b = login(&c, "bob").await;
    assert_eq!(b["user"]["role"], "r-bob");
    assert!(b["user"].get("passwordHash").is_none());
    assert!(b["accessTokenExpiresAt"].is_i64() && b["refreshTokenExpiresAt"].is_i64());
    let bad = |body| call(&c, "POST", "/api/auth/login", &[], Some(body));
    let (s, _, e) = bad(json!({"username": "bob", "password": "x"})).await;
    assert_eq!(
        (s, e["message"].clone()),
        (401, json!("Invalid credentials"))
    );
    let (_, _, e) = bad(json!({"username": "nobody", "password": "x"})).await;
    assert_eq!(e["message"], "Invalid credentials");
    let (_, _, e) = bad(json!({"username": "off", "password": "off-pass"})).await;
    assert_eq!(e["message"], "Account disabled");
    let (_, _, e) =
        bad(json!({"username": "bob", "password": "bob-pass", "serverType": "plex"})).await;
    assert_eq!(
        e["message"],
        "Media server login for plex not yet implemented"
    );
    let (s, _, _) = bad(json!({"username": "", "password": "x", "extra": 1})).await;
    assert_eq!(s, 400);

    let rt = b["refreshToken"].as_str().unwrap();
    let (s, h, r) = call(
        &c,
        "POST",
        "/api/auth/refresh",
        &[],
        Some(json!({"refreshToken": rt})),
    )
    .await;
    assert_eq!(s, 201);
    assert!(h["set-cookie"].to_str().unwrap().contains("Max-Age=3600"));
    assert!(r.get("user").is_none() && r["refreshToken"] != json!(rt));
    let (s, _, e) = call(
        &c,
        "POST",
        "/api/auth/refresh",
        &[],
        Some(json!({"refreshToken": rt})),
    )
    .await;
    assert_eq!(
        (s, e["message"].clone()),
        (401, json!("Refresh token already rotated"))
    );
    let (_, _, e) = call(&c, "POST", "/api/auth/refresh", &[], Some(json!({}))).await;
    assert_eq!(e["message"], "Missing refresh token");
    let (_, _, e) = call(
        &c,
        "POST",
        "/api/auth/refresh",
        &[],
        Some(json!({"refreshToken": "zzz"})),
    )
    .await;
    assert_eq!(e["message"], "Invalid refresh token");
}

#[sqlx::test(migrations = false)]
async fn register_requires_users_manage(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let plain = user(&pool, "plain", Some("[]"), false, true).await;
    let mgr = user(&pool, "mgr", Some(r#"["users.manage"]"#), false, true).await;
    let body = json!({"username": "new", "password": "pw"});
    let (s, _, _) = call(&c, "POST", "/api/auth/register", &[], Some(body.clone())).await;
    assert_eq!(s, 401);
    let h = bearer(&c, plain, "plain");
    let (s, _, _) = call(
        &c,
        "POST",
        "/api/auth/register",
        &[("authorization", &h)],
        Some(json!({})),
    )
    .await;
    assert_eq!(s, 403, "guard before validation");
    let h = bearer(&c, mgr, "mgr");
    let (s, _, u) = call(
        &c,
        "POST",
        "/api/auth/register",
        &[("authorization", &h)],
        Some(body.clone()),
    )
    .await;
    assert_eq!(
        (s, u["role"].clone(), u["isAdmin"].clone()),
        (201, Value::Null, json!(false))
    );
    let (s, _, _) = call(
        &c,
        "POST",
        "/api/auth/register",
        &[("authorization", &h)],
        Some(body),
    )
    .await;
    assert_eq!(s, 409);
}

#[sqlx::test(migrations = false)]
async fn me_stream_scope_is_rejected_and_tokens(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = user(&pool, "bob", Some("[]"), false, true).await;
    let h = bearer(&c, id, "bob");
    let (s, _, u) = call(&c, "GET", "/api/auth/me", &[("authorization", &h)], None).await;
    assert_eq!(
        (s, u["libraryIds"].clone(), u["features"].clone()),
        (200, json!([]), json!([]))
    );
    assert!(
        u["lastLogin"].is_null(),
        "response carries the pre-update value"
    );
    let (_, _, u) = call(&c, "GET", "/api/auth/me", &[("authorization", &h)], None).await;
    assert!(u["lastLogin"].is_string());
    let stream = format!("Bearer {}", c.st.jwt.sign_stream(id, "bob").unwrap().token);
    for (m, p) in [
        ("GET", "/api/auth/me"),
        ("POST", "/api/auth/stream-token"),
        ("POST", "/api/auth/cast-info"),
    ] {
        let (s, _, _) = call(&c, m, p, &[("authorization", &stream)], None).await;
        assert_eq!(s, 401, "{p}");
    }
    let (s, _, t) = call(
        &c,
        "POST",
        "/api/auth/stream-token",
        &[("authorization", &h)],
        None,
    )
    .await;
    assert_eq!(s, 201);
    assert!(
        c.st.jwt
            .verify(t["streamToken"].as_str().unwrap())
            .unwrap()
            .scope
            .is_some()
    );
    let (s, _, t) = call(
        &c,
        "POST",
        "/api/auth/stream-token",
        &[("authorization", &h)],
        Some(json!({"mediaFileId": 42})),
    )
    .await;
    assert_eq!(s, 201);
    let claims = c.st.jwt.verify(t["streamToken"].as_str().unwrap()).unwrap();
    assert_eq!((claims.mf, claims.sub), (Some(42), id));
    // A JSON content type with an empty body is still a request for an unbound token.
    let (s, _, _) = call(
        &c,
        "POST",
        "/api/auth/stream-token",
        &[("authorization", &h), ("content-type", "application/json")],
        None,
    )
    .await;
    assert_eq!(s, 201);
    let (s, _, t) = call(
        &c,
        "POST",
        "/api/auth/stream-token",
        &[("authorization", &h)],
        Some(json!({})),
    )
    .await;
    assert_eq!(s, 201);
    assert_eq!(
        c.st.jwt
            .verify(t["streamToken"].as_str().unwrap())
            .unwrap()
            .mf,
        None
    );
    let (_, _, i) = call(
        &c,
        "POST",
        "/api/auth/cast-info",
        &[
            ("authorization", &h),
            ("host", "h:1"),
            ("x-forwarded-proto", "https"),
        ],
        None,
    )
    .await;
    assert_eq!(i["streamBaseUrl"], "https://h:1");
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('public_url', 'https://x.test//')")
        .execute(&pool)
        .await
        .unwrap();
    let (_, _, i) = call(
        &c,
        "POST",
        "/api/auth/cast-info",
        &[("authorization", &h)],
        None,
    )
    .await;
    assert_eq!(i["streamBaseUrl"], "https://x.test");
    let (_, _, l) = call(&c, "GET", "/api/auth/users-public", &[], None).await;
    assert_eq!(l, json!([{"id": id, "username": "bob", "avatar": null}]));
}

#[sqlx::test(migrations = false)]
async fn pairing_flow(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = user(&pool, "bob", Some("[]"), false, true).await;
    let other = user(&pool, "eve", Some("[]"), false, true).await;
    let dev = [("x-device-id", "tv")];
    let req = json!({"userId": id, "deviceName": "TV"});
    let (s, _, _) = call(
        &c,
        "POST",
        "/api/auth/pairing/request",
        &[],
        Some(req.clone()),
    )
    .await;
    assert_eq!(s, 400, "missing device header");
    let (s, _, r) = call(&c, "POST", "/api/auth/pairing/request", &dev, Some(req)).await;
    assert_eq!((s, r["expiresIn"].clone()), (201, json!(600)));
    let pid = r["pairingId"].as_str().unwrap().to_owned();
    let (_, _, st) = call(
        &c,
        "GET",
        &format!("/api/auth/pairing/status?pairingId={pid}"),
        &dev,
        None,
    )
    .await;
    assert_eq!(st, json!({"status": "pending"}));
    let (bob, eve) = (bearer(&c, id, "bob"), bearer(&c, other, "eve"));
    let (_, _, l) = call(
        &c,
        "GET",
        "/api/auth/pairing/pending",
        &[("authorization", &bob)],
        None,
    )
    .await;
    assert_eq!(l[0]["pairingId"], json!(pid));
    let approve = format!("/api/auth/pairing/{pid}/approve");
    let (s, _, _) = call(&c, "POST", &approve, &[("authorization", &eve)], None).await;
    assert_eq!(s, 404);
    let (s, _, _) = call(&c, "POST", &approve, &[("authorization", &bob)], None).await;
    assert_eq!(s, 204);
    let status = format!("/api/auth/pairing/status?pairingId={pid}");
    let (_, _, st) = call(&c, "GET", &status, &[("x-device-id", "other")], None).await;
    assert_eq!(st, json!({"status": "approved"}));
    let (_, h, st) = call(&c, "GET", &status, &dev, None).await;
    assert!(st["accessToken"].is_string() && h.contains_key("set-cookie"));
    let (_, _, st) = call(&c, "GET", &status, &dev, None).await;
    assert_eq!(st, json!({"status": "approved"}));
}

#[sqlx::test(migrations = false)]
async fn pairing_cancel_by_requesting_device(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = user(&pool, "bob", Some("[]"), false, true).await;
    let dev = [("x-device-id", "tv")];
    let req = json!({"userId": id, "deviceName": "TV"});
    let (_, _, r) = call(&c, "POST", "/api/auth/pairing/request", &dev, Some(req)).await;
    let cancel = format!(
        "/api/auth/pairing/{}/cancel",
        r["pairingId"].as_str().unwrap()
    );
    let (s, _, _) = call(&c, "POST", &cancel, &[("x-device-id", "other")], None).await;
    assert_eq!(s, 404, "another device's request");
    let (s, _, _) = call(&c, "POST", &cancel, &dev, None).await;
    assert_eq!(s, 204);
    let bob = bearer(&c, id, "bob");
    let (_, _, l) = call(
        &c,
        "GET",
        "/api/auth/pairing/pending",
        &[("authorization", &bob)],
        None,
    )
    .await;
    assert_eq!(l, json!([]));
    let (s, _, _) = call(&c, "POST", &cancel, &dev, None).await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn logout_is_always_204_and_revokes(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    user(&pool, "bob", None, false, true).await;
    let b = login(&c, "bob").await;
    let rt = b["refreshToken"].as_str().unwrap();
    let (s, h, _) = call(
        &c,
        "POST",
        "/api/auth/logout",
        &[],
        Some(json!({"refreshToken": rt})),
    )
    .await;
    assert_eq!(s, 204);
    assert!(
        h["set-cookie"]
            .to_str()
            .unwrap()
            .starts_with("fliks_access=;")
    );
    let (s, _, _) = call(&c, "POST", "/api/auth/logout", &[], None).await;
    assert_eq!(s, 204);
    let live: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM refresh_tokens WHERE "revokedAt" IS NULL"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(live, 0);
}

#[sqlx::test(migrations = false)]
async fn failed_logins_are_limited_per_address_and_username(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    user(&pool, "bob", Some("[]"), false, true).await;
    user(&pool, "amy", Some("[]"), false, true).await;
    let try_login = async |name: &str, pass: &str, ip: &str| {
        call(
            &c,
            "POST",
            "/api/auth/login",
            &[("x-forwarded-for", ip)],
            Some(json!({"username": name, "password": pass})),
        )
        .await
        .0
    };
    for _ in 0..5 {
        assert_eq!(try_login("bob", "wrong", "9.9.9.9").await, 401);
    }
    assert_eq!(
        try_login("bob", "bob-pass", "9.9.9.9").await,
        429,
        "even the right password"
    );
    assert_eq!(
        try_login("amy", "amy-pass", "9.9.9.9").await,
        201,
        "another username"
    );
    assert_eq!(
        try_login("bob", "bob-pass", "8.8.8.8").await,
        201,
        "another address"
    );
    assert_eq!(try_login("bob", "wrong", "7.7.7.7").await, 401);
    assert_eq!(try_login("bob", "bob-pass", "7.7.7.7").await, 201);
    assert_eq!(
        try_login("bob", "wrong", "7.7.7.7").await,
        401,
        "a success reset the count"
    );
}

#[sqlx::test(migrations = false)]
async fn first_admin_setup(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (_, _, s) = call(&c, "GET", "/api/auth/setup", &[], None).await;
    assert_eq!(s, json!({"required": true}));
    let short = json!({"username": "root", "password": "short"});
    let (s, _, _) = call(&c, "POST", "/api/auth/setup", &[], Some(short)).await;
    assert_eq!(s, 400);
    let body = json!({"username": "root", "password": "long-enough-pass"});
    let (s, _, _) = call(&c, "POST", "/api/auth/setup", &[], Some(body.clone())).await;
    assert_eq!(s, 201);
    let (s, _, _) = call(&c, "POST", "/api/auth/setup", &[], Some(body)).await;
    assert_eq!(s, 409);
    let (_, _, s) = call(&c, "GET", "/api/auth/setup", &[], None).await;
    assert_eq!(s, json!({"required": false}));
    let login = json!({"username": "root", "password": "long-enough-pass"});
    let (s, _, r) = call(&c, "POST", "/api/auth/login", &[], Some(login)).await;
    assert_eq!((s, r["user"]["isAdmin"].clone()), (201, json!(true)));
}

#[sqlx::test(migrations = false)]
async fn first_admin_setup_refused_with_users(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    user(&pool, "bob", Some("[]"), false, true).await;
    let body = json!({"username": "root", "password": "long-enough-pass"});
    let (s, _, _) = call(&c, "POST", "/api/auth/setup", &[], Some(body)).await;
    assert_eq!(s, 409);
}

#[sqlx::test(migrations = false)]
async fn first_admin_setup_race(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let calls = (0..6).map(|i| {
        let body = json!({"username": format!("root{i}"), "password": "long-enough-pass"});
        call(&c, "POST", "/api/auth/setup", &[], Some(body))
    });
    let created = futures_util::future::join_all(calls)
        .await
        .into_iter()
        .filter(|(s, _, _)| *s == 201)
        .count();
    assert_eq!(created, 1);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM users")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

async fn picker(c: &Ctx, peer: &str, xff: Option<&str>) -> Value {
    let mut req = Request::builder().uri("/api/auth/users-public");
    if let Some(x) = xff {
        req = req.header("x-forwarded-for", x);
    }
    let mut req = req.body(Body::empty()).unwrap();
    let addr: std::net::SocketAddr = format!("{peer}:1234").parse().unwrap();
    req.extensions_mut()
        .insert(axum::extract::ConnectInfo(addr));
    let res = c.app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[sqlx::test(migrations = false)]
async fn users_public_modes(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = user(&pool, "bob", Some("[]"), false, true).await;
    let roster = json!([{"id": id, "username": "bob", "avatar": null}]);
    let mode = |m: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO app_settings (key, value) VALUES ('users_public_mode', $1)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            )
            .bind(m)
            .execute(&pool)
            .await
            .unwrap();
        }
    };
    // Unset and "everyone": public callers see the roster.
    assert_eq!(picker(&c, "203.0.113.9", None).await, roster);
    mode("everyone").await;
    assert_eq!(picker(&c, "203.0.113.9", None).await, roster);
    mode("lan").await;
    assert_eq!(picker(&c, "192.168.1.20", None).await, roster);
    assert_eq!(picker(&c, "127.0.0.1", Some("10.0.0.5")).await, roster);
    assert_eq!(picker(&c, "203.0.113.9", None).await, json!([]));
    // A forged private entry or a public hop in the chain keeps the caller out.
    assert_eq!(picker(&c, "10.0.0.2", Some("203.0.113.9")).await, json!([]));
    assert_eq!(
        picker(&c, "203.0.113.9", Some("192.168.1.20")).await,
        json!([])
    );
    mode("hidden").await;
    assert_eq!(picker(&c, "192.168.1.20", None).await, json!([]));
}

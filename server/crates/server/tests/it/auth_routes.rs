//! `/api/auth/*` through the real router on a fresh database.
use crate::session;
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

async fn bearer(c: &Ctx, id: i32, name: &str) -> String {
    format!("Bearer {}", session::token(&c.st, id, name).await)
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
    let long = "u".repeat(256);
    let (s, _, e) = bad(json!({"username": long, "password": "x"})).await;
    assert_eq!(s, 400);
    assert_eq!(
        e["message"],
        json!(["username must be shorter than or equal to 255 characters"])
    );

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
    let h = bearer(&c, plain, "plain").await;
    let (s, _, _) = call(
        &c,
        "POST",
        "/api/auth/register",
        &[("authorization", &h)],
        Some(json!({})),
    )
    .await;
    assert_eq!(s, 403, "guard before validation");
    let h = bearer(&c, mgr, "mgr").await;
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
    let h = bearer(&c, id, "bob").await;
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
    let stream = format!("Bearer {}", session::stream(&c.st, id, "bob").await);
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
    let code = r["code"].as_str().unwrap().to_owned();
    assert_eq!(code.len(), 6);
    let (_, _, st) = call(
        &c,
        "GET",
        &format!("/api/auth/pairing/status?pairingId={pid}"),
        &dev,
        None,
    )
    .await;
    assert_eq!(st, json!({"status": "pending"}));
    let (bob, eve) = (bearer(&c, id, "bob").await, bearer(&c, other, "eve").await);
    let (_, _, l) = call(
        &c,
        "GET",
        "/api/auth/pairing/pending",
        &[("authorization", &bob)],
        None,
    )
    .await;
    assert_eq!(l[0]["pairingId"], json!(pid));
    assert!(
        l[0].get("code").is_none(),
        "the approver must read it off the device"
    );
    let approve = "/api/auth/pairing/approve";
    let wrong = format!("{:06}", (code.parse::<u32>().unwrap() + 1) % 1_000_000);
    let body = |k: &str| Some(json!({ "code": k }));
    let (s, _, _) = call(
        &c,
        "POST",
        approve,
        &[("authorization", &bob)],
        body(&wrong),
    )
    .await;
    assert_eq!(s, 404, "wrong code");
    let (s, _, _) = call(&c, "POST", approve, &[("authorization", &eve)], body(&code)).await;
    assert_eq!(s, 404, "another user's request");
    let spaced = format!("{} {}", &code[..3], &code[3..]);
    let (s, _, _) = call(
        &c,
        "POST",
        approve,
        &[("authorization", &bob)],
        body(&spaced),
    )
    .await;
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
async fn pairing_without_a_user_is_approved_by_whoever_types_the_code(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = user(&pool, "bob", Some("[]"), false, true).await;
    let dev = [("x-device-id", "tv")];
    let req = json!({"deviceName": "TV", "systemName": "tvOS"});
    let (s, _, r) = call(&c, "POST", "/api/auth/pairing/request", &dev, Some(req)).await;
    assert_eq!(s, 201);
    let (pid, code) = (
        r["pairingId"].clone(),
        r["code"].as_str().unwrap().to_owned(),
    );
    let bob = bearer(&c, id, "bob").await;
    let auth = [("authorization", bob.as_str())];
    let (s, _, l) = call(
        &c,
        "POST",
        "/api/auth/pairing/lookup",
        &auth,
        Some(json!({"code": code})),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(
        (&l["pairingId"], &l["deviceName"], &l["systemName"]),
        (&pid, &json!("TV"), &json!("tvOS"))
    );
    assert!(l["requestedAt"].is_string() && l.get("clientIp").is_some());
    let (_, _, pending) = call(&c, "GET", "/api/auth/pairing/pending", &auth, None).await;
    assert_eq!(
        pending,
        json!([]),
        "an unhinted request is in nobody's list"
    );
    let approve = "/api/auth/pairing/approve";
    for body in [
        json!({"code": code}),
        json!({"code": code, "pairingId": "x"}),
    ] {
        let (s, _, _) = call(&c, "POST", approve, &auth, Some(body)).await;
        assert_eq!(s, 404, "an unhinted request needs the looked-up pairingId");
    }
    let body = json!({"code": code, "pairingId": pid.clone()});
    let (s, _, _) = call(&c, "POST", approve, &auth, Some(body)).await;
    assert_eq!(s, 204);
    let status = format!(
        "/api/auth/pairing/status?pairingId={}",
        pid.as_str().unwrap()
    );
    let (_, _, st) = call(&c, "GET", &status, &dev, None).await;
    let minted = format!("Bearer {}", st["accessToken"].as_str().unwrap());
    let (_, _, me) = call(
        &c,
        "GET",
        "/api/auth/me",
        &[("authorization", &minted)],
        None,
    )
    .await;
    assert_eq!(me["id"], json!(id), "the claim mints for the approver");
}

#[sqlx::test(migrations = false)]
async fn pairing_wrong_codes_are_throttled_per_user(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = user(&pool, "bob", Some("[]"), false, true).await;
    let bob = bearer(&c, id, "bob").await;
    let auth = [("authorization", bob.as_str())];
    let wrong = Some(json!({"code": "000000"}));
    let dev = [("x-device-id", "tv")];
    let (_, _, r) = call(
        &c,
        "POST",
        "/api/auth/pairing/request",
        &dev,
        Some(json!({"deviceName": "TV"})),
    )
    .await;
    let own = Some(json!({"code": r["code"]}));
    for _ in 0..4 {
        let (s, _, _) = call(&c, "POST", "/api/auth/pairing/lookup", &auth, wrong.clone()).await;
        assert_eq!(s, 404);
    }
    let (s, _, _) = call(&c, "POST", "/api/auth/pairing/lookup", &auth, own).await;
    assert_eq!(s, 200, "a hit does not reset the failures");
    let (s, _, _) = call(&c, "POST", "/api/auth/pairing/lookup", &auth, wrong.clone()).await;
    assert_eq!(s, 404);
    let (s, _, _) = call(&c, "POST", "/api/auth/pairing/approve", &auth, wrong).await;
    assert_eq!(s, 429, "lookup and approve share the counter");
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
    let bob = bearer(&c, id, "bob").await;
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
    assert_eq!(picker(&c, "8.8.8.8", None).await, roster);
    mode("everyone").await;
    assert_eq!(picker(&c, "8.8.8.8", None).await, roster);
    mode("lan").await;
    assert_eq!(picker(&c, "192.168.1.20", None).await, roster);
    assert_eq!(picker(&c, "127.0.0.1", Some("10.0.0.5")).await, roster);
    assert_eq!(picker(&c, "8.8.8.8", None).await, json!([]));
    // A forged private entry or a public hop in the chain keeps the caller out.
    assert_eq!(picker(&c, "10.0.0.2", Some("8.8.8.8")).await, json!([]));
    assert_eq!(picker(&c, "8.8.8.8", Some("192.168.1.20")).await, json!([]));
    // A public client behind a private proxy chain is public; CGNAT (Tailscale) counts as local.
    assert_eq!(
        picker(&c, "172.18.0.2", Some("8.8.8.8, 10.0.0.1")).await,
        json!([])
    );
    assert_eq!(picker(&c, "100.100.1.1", None).await, roster);
    mode("hidden").await;
    assert_eq!(picker(&c, "192.168.1.20", None).await, json!([]));
}

fn auth_header(b: &Value) -> String {
    format!("Bearer {}", b["accessToken"].as_str().unwrap())
}

#[sqlx::test(migrations = false)]
async fn logout_cuts_the_access_token_and_the_refresh_token_of_its_session(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    user(&pool, "bob", Some("[]"), false, true).await;
    let (first, second) = (login(&c, "bob").await, login(&c, "bob").await);
    let me = |b: &Value| {
        let h = auth_header(b);
        let c = &c;
        async move {
            call(c, "GET", "/api/auth/me", &[("authorization", &h)], None)
                .await
                .0
        }
    };
    assert_eq!(me(&first).await, 200);
    let rt = first["refreshToken"].as_str().unwrap();
    call(
        &c,
        "POST",
        "/api/auth/logout",
        &[],
        Some(json!({"refreshToken": rt})),
    )
    .await;
    assert_eq!(me(&first).await, 401);
    assert_eq!(me(&second).await, 200, "another session is untouched");
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
        (401, json!("Invalid refresh token"))
    );
}

#[sqlx::test(migrations = false)]
async fn refresh_keeps_the_session_and_a_reuse_revokes_it(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    user(&pool, "bob", Some("[]"), false, true).await;
    let b = login(&c, "bob").await;
    let sid =
        c.st.jwt
            .verify(b["accessToken"].as_str().unwrap())
            .unwrap()
            .sid;
    assert!(sid.is_some());
    let rt = b["refreshToken"].as_str().unwrap();
    let refresh = |t: String| {
        let c = &c;
        async move {
            call(
                c,
                "POST",
                "/api/auth/refresh",
                &[],
                Some(json!({ "refreshToken": t })),
            )
            .await
        }
    };
    let (_, _, r) = refresh(rt.to_owned()).await;
    let claims = c.st.jwt.verify(r["accessToken"].as_str().unwrap()).unwrap();
    assert_eq!(claims.sid, sid);
    let (_, _, r2) = refresh(r["refreshToken"].as_str().unwrap().to_owned()).await;
    assert!(r2["accessToken"].is_string());
    // Replaying the first token once its rotation grace is over is theft: past the grace, age it.
    sqlx::query(r#"UPDATE refresh_tokens SET "revokedAt" = now() - interval '1 minute' WHERE "tokenHash" = encode(sha256($1::bytea), 'hex')"#)
        .bind(rt.as_bytes())
        .execute(&pool)
        .await
        .unwrap();
    let uid: i32 = sqlx::query_scalar("SELECT id FROM users WHERE username = 'bob'")
        .fetch_one(&pool)
        .await
        .unwrap();
    let stream =
        c.st.hub
            .connect_session(uid, sid, fliks_server::events::Identity::default());
    let (s, _, e) = refresh(rt.to_owned()).await;
    assert_eq!(
        (s, e["message"].clone()),
        (401, json!("Refresh token reuse detected"))
    );
    assert!(
        !c.st.hub.has_connection(&stream.id),
        "its live stream is cut"
    );
    let h = auth_header(&r2);
    let (s, _, _) = call(&c, "GET", "/api/auth/me", &[("authorization", &h)], None).await;
    assert_eq!(
        s, 401,
        "the stolen chain's access token dies with the session"
    );
}

#[sqlx::test(migrations = false)]
async fn sessions_are_listed_and_revoked_by_their_owner_only(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    user(&pool, "bob", Some("[]"), false, true).await;
    user(&pool, "eve", Some("[]"), false, true).await;
    let (a, b, e) = (
        login(&c, "bob").await,
        login(&c, "bob").await,
        login(&c, "eve").await,
    );
    let (ha, he) = (auth_header(&a), auth_header(&e));
    let (s, _, l) = call(
        &c,
        "GET",
        "/api/auth/sessions",
        &[("authorization", &ha)],
        None,
    )
    .await;
    assert_eq!(s, 200);
    let l = l.as_array().unwrap();
    assert_eq!(l.len(), 2);
    let current: Vec<_> = l.iter().filter(|x| x["current"] == json!(true)).collect();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0]["method"], "password");
    let other = l.iter().find(|x| x["current"] == json!(false)).unwrap()["id"].clone();
    let uri = format!("/api/auth/sessions/{other}");
    let (s, _, _) = call(&c, "DELETE", &uri, &[("authorization", &he)], None).await;
    assert_eq!(s, 404, "another user's session");
    let (s, _, _) = call(&c, "DELETE", &uri, &[("authorization", &ha)], None).await;
    assert_eq!(s, 204);
    let (s, _, _) = call(&c, "DELETE", &uri, &[("authorization", &ha)], None).await;
    assert_eq!(s, 404, "already revoked");
    let hb = auth_header(&b);
    let (s, _, _) = call(&c, "GET", "/api/auth/me", &[("authorization", &hb)], None).await;
    assert_eq!(s, 401);
    let (s, _, l) = call(
        &c,
        "GET",
        "/api/auth/sessions",
        &[("authorization", &ha)],
        None,
    )
    .await;
    assert_eq!((s, l.as_array().unwrap().len()), (200, 1));
    let (s, _, _) = call(
        &c,
        "DELETE",
        "/api/auth/sessions/nope",
        &[("authorization", &ha)],
        None,
    )
    .await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn a_pairing_claim_starts_a_pairing_session(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = user(&pool, "bob", Some("[]"), false, true).await;
    let dev = [("x-device-id", "tv")];
    let req = json!({"userId": id, "deviceName": "TV"});
    let (_, _, r) = call(&c, "POST", "/api/auth/pairing/request", &dev, Some(req)).await;
    let bob = bearer(&c, id, "bob").await;
    let body = Some(json!({"code": r["code"]}));
    call(
        &c,
        "POST",
        "/api/auth/pairing/approve",
        &[("authorization", &bob)],
        body,
    )
    .await;
    let status = format!(
        "/api/auth/pairing/status?pairingId={}",
        r["pairingId"].as_str().unwrap()
    );
    let (_, _, st) = call(&c, "GET", &status, &dev, None).await;
    assert!(
        c.st.jwt
            .verify(st["accessToken"].as_str().unwrap())
            .unwrap()
            .sid
            .is_some()
    );
    let method: String =
        sqlx::query_scalar(r#"SELECT method FROM sessions ORDER BY id DESC LIMIT 1"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(method, "pairing");
}

#[sqlx::test(migrations = false)]
async fn a_logout_without_a_refresh_token_leaves_the_session_usable(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    user(&pool, "bob", Some("[]"), false, true).await;
    let b = login(&c, "bob").await;
    let h = auth_header(&b);
    let (s, _, _) = call(
        &c,
        "POST",
        "/api/auth/logout",
        &[("authorization", &h)],
        Some(json!({"targetId": "dev#tab"})),
    )
    .await;
    assert_eq!(s, 204);
    let (s, _, _) = call(&c, "GET", "/api/auth/me", &[("authorization", &h)], None).await;
    assert_eq!(s, 200, "the profile switch can resume it");
    let rt = b["refreshToken"].as_str().unwrap();
    let body = Some(json!({"refreshToken": rt}));
    let (s, _, _) = call(&c, "POST", "/api/auth/refresh", &[], body).await;
    assert_eq!(s, 201);
}

#[sqlx::test(migrations = false)]
async fn revoking_a_session_drops_only_the_sse_streams_of_that_session(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let id = user(&pool, "bob", Some("[]"), false, true).await;
    let a = login(&c, "bob").await;
    login(&c, "bob").await;
    let ha = auth_header(&a);
    let current =
        c.st.jwt
            .verify(a["accessToken"].as_str().unwrap())
            .unwrap()
            .sid;
    let (_, _, l) = call(
        &c,
        "GET",
        "/api/auth/sessions",
        &[("authorization", &ha)],
        None,
    )
    .await;
    let other = l
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["current"] == json!(false))
        .unwrap()["id"]
        .clone();
    let conn =
        c.st.hub
            .connect_session(id, other.as_i64().map(|s| s as i32), Default::default());
    let kept = c.st.hub.connect_session(id, current, Default::default());
    let uri = format!("/api/auth/sessions/{other}");
    call(&c, "DELETE", &uri, &[("authorization", &ha)], None).await;
    assert!(!c.st.hub.has_connection(&conn.id));
    assert!(
        c.st.hub.has_connection(&kept.id),
        "the caller's own stream stays"
    );
}

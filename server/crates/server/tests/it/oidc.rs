//! OpenID Connect sign-in, links, groups, logout and the provider routes against a fake provider.
use crate::{plugins::net as tls, session};
use axum::{
    Json, Router,
    body::Body,
    extract::{Form, State},
    http::{HeaderMap, Request, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD as B64},
};
use fliks_server::{
    auth::{self, oidc::Oidc},
    config::Config,
    events::Identity,
    net::guard::{Net, SystemNet},
    settings,
    state::AppState,
    users,
};
use futures_util::future::BoxFuture;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const CLIENT_ID: &str = "fliks";
const CLIENT_SECRET: &str = "s3cret";
const BCL: &str = "http://schemas.openid.net/event/backchannel-logout";
const PUBLIC: &str = "https://fliks.test";

struct Key {
    kid: String,
    enc: EncodingKey,
    jwk: Value,
}

fn key(kid: &str) -> Key {
    let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    let raw = kp.public_key_raw();
    let jwk = json!({"kty": "EC", "crv": "P-256", "kid": kid, "use": "sig", "alg": "ES256",
        "x": B64.encode(&raw[1..33]), "y": B64.encode(&raw[33..65])});
    Key {
        kid: kid.into(),
        enc: EncodingKey::from_ec_der(&kp.serialize_der()),
        jwk,
    }
}

struct Code {
    challenge: String,
    redirect_uri: String,
    id_token: String,
}

/// How a token is signed.
enum Signing {
    /// The key at that index of the provider's keys.
    Key(usize),
    /// A key the JWKS does not hold, under the `kid` of the first one.
    Foreign,
    /// `alg: none`, no signature.
    None,
    /// HS256 with a made-up secret.
    Hs256,
}

struct IdpSt {
    base: Mutex<String>,
    keys: Vec<Key>,
    published: Mutex<Vec<String>>,
    algs: Mutex<Vec<&'static str>>,
    methods: Mutex<Vec<&'static str>>,
    s256: AtomicBool,
    codes: Mutex<HashMap<String, Code>>,
    userinfo: Mutex<Option<Value>>,
    jwks_hits: AtomicUsize,
    discovery_hits: AtomicUsize,
    token_auth: Mutex<Vec<&'static str>>,
}

struct Idp {
    base: String,
    st: Arc<IdpSt>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

async fn discovery(State(s): State<Arc<IdpSt>>) -> Json<Value> {
    s.discovery_hits.fetch_add(1, Ordering::SeqCst);
    Json(discovery_doc(&s))
}

fn discovery_doc(s: &IdpSt) -> Value {
    let base = s.base.lock().unwrap().clone();
    let pkce = if s.s256.load(Ordering::SeqCst) {
        "S256"
    } else {
        "plain"
    };
    json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/authorize"),
        "token_endpoint": format!("{base}/token"),
        "jwks_uri": format!("{base}/jwks"),
        "userinfo_endpoint": format!("{base}/userinfo"),
        "end_session_endpoint": format!("{base}/logout"),
        "id_token_signing_alg_values_supported": *s.algs.lock().unwrap(),
        "token_endpoint_auth_methods_supported": *s.methods.lock().unwrap(),
        "code_challenge_methods_supported": [pkce],
        "backchannel_logout_supported": true,
    })
}

async fn redirected(State(s): State<Arc<IdpSt>>) -> Response {
    let base = s.base.lock().unwrap().clone();
    (
        StatusCode::FOUND,
        [(
            header::LOCATION,
            format!("{base}/.well-known/openid-configuration"),
        )],
    )
        .into_response()
}

async fn jwks(State(s): State<Arc<IdpSt>>) -> Json<Value> {
    s.jwks_hits.fetch_add(1, Ordering::SeqCst);
    let published = s.published.lock().unwrap().clone();
    let keys: Vec<Value> = s
        .keys
        .iter()
        .filter(|k| published.contains(&k.kid))
        .map(|k| k.jwk.clone())
        .collect();
    Json(json!({ "keys": keys }))
}

async fn userinfo(State(s): State<Arc<IdpSt>>) -> Response {
    match s.userinfo.lock().unwrap().clone() {
        Some(v) => Json(v).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn token(
    State(s): State<Arc<IdpSt>>,
    headers: HeaderMap,
    Form(f): Form<HashMap<String, String>>,
) -> Response {
    let grant = |why: &str| {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_grant", "why": why})),
        )
            .into_response()
    };
    let basic = format!(
        "Basic {}",
        STANDARD.encode(format!("{CLIENT_ID}:{CLIENT_SECRET}"))
    );
    let style = if headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        == Some(&basic)
    {
        "basic"
    } else if f.get("client_secret").map(String::as_str) == Some(CLIENT_SECRET) {
        "post"
    } else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid_client"})),
        )
            .into_response();
    };
    s.token_auth.lock().unwrap().push(style);
    let Some(code) = f
        .get("code")
        .and_then(|c| s.codes.lock().unwrap().remove(c))
    else {
        return grant("unknown code");
    };
    let verifier = f.get("code_verifier").cloned().unwrap_or_default();
    if B64.encode(Sha256::digest(verifier.as_bytes())) != code.challenge {
        return grant("pkce");
    }
    if f.get("redirect_uri") != Some(&code.redirect_uri) {
        return grant("redirect_uri");
    }
    Json(json!({"access_token": "at-1", "token_type": "Bearer", "id_token": code.id_token}))
        .into_response()
}

impl Idp {
    async fn start() -> Idp {
        let keys = vec![key("k1"), key("k2")];
        let st = Arc::new(IdpSt {
            base: Mutex::default(),
            published: Mutex::new(vec!["k1".into()]),
            keys,
            algs: Mutex::new(vec!["ES256"]),
            methods: Mutex::new(vec!["client_secret_basic", "client_secret_post"]),
            s256: AtomicBool::new(true),
            codes: Mutex::default(),
            userinfo: Mutex::default(),
            jwks_hits: AtomicUsize::new(0),
            discovery_hits: AtomicUsize::new(0),
            token_auth: Mutex::default(),
        });
        let app = Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route(
                "/redirected/.well-known/openid-configuration",
                get(redirected),
            )
            .route("/jwks", get(jwks))
            .route("/userinfo", get(userinfo))
            .route("/token", post(token))
            .with_state(st.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        *st.base.lock().unwrap() = base.clone();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Idp { base, st }
    }

    fn claims(&self, nonce: &str, patch: &Value) -> Value {
        let mut c = json!({"iss": self.base, "aud": CLIENT_ID, "sub": "sub-1", "iat": now(),
            "exp": now() + 300, "nonce": nonce, "preferred_username": "ann",
            "email": "ann@example.test", "email_verified": true});
        for (k, v) in patch.as_object().unwrap() {
            if v.is_null() {
                c.as_object_mut().unwrap().remove(k);
            } else {
                c[k] = v.clone();
            }
        }
        c
    }

    fn sign(&self, claims: &Value, how: Signing) -> String {
        let jwt = |alg, kid: Option<&str>, key: &EncodingKey| {
            let mut h = Header::new(alg);
            h.kid = kid.map(str::to_owned);
            jsonwebtoken::encode(&h, claims, key).unwrap()
        };
        match how {
            Signing::Key(i) => jwt(
                Algorithm::ES256,
                Some(&self.st.keys[i].kid),
                &self.st.keys[i].enc,
            ),
            Signing::Foreign => jwt(Algorithm::ES256, Some("k1"), &key("x").enc),
            Signing::Hs256 => jwt(
                Algorithm::HS256,
                Some("k1"),
                &EncodingKey::from_secret(b"fliks"),
            ),
            Signing::None => format!(
                "{}.{}.",
                B64.encode(br#"{"alg":"none","typ":"JWT"}"#),
                B64.encode(claims.to_string())
            ),
        }
    }

    /// Registers an authorization code that redeems to a token with `patch` applied to the claims.
    fn issue(&self, f: &Flow, patch: Value, how: Signing) -> String {
        let id_token = self.sign(&self.claims(&f.nonce, &patch), how);
        let code = format!("code-{}", self.st.codes.lock().unwrap().len() + 1);
        self.st.codes.lock().unwrap().insert(
            code.clone(),
            Code {
                challenge: f.challenge.clone(),
                redirect_uri: f.redirect_uri.clone(),
                id_token,
            },
        );
        code
    }

    fn logout_token(&self, patch: Value, how: Signing) -> String {
        let mut c = json!({"iss": self.base, "aud": CLIENT_ID, "iat": now(), "exp": now() + 120,
            "jti": "jti-1", "events": {BCL: {}}, "sid": "idp-sid-1"});
        for (k, v) in patch.as_object().unwrap() {
            if v.is_null() {
                c.as_object_mut().unwrap().remove(k);
            } else {
                c[k] = v.clone();
            }
        }
        self.sign(&c, how)
    }
}

struct Flow {
    verifier: String,
    challenge: String,
    state: String,
    nonce: String,
    redirect_uri: String,
}

struct Ctx {
    st: AppState,
    app: Router,
    pool: PgPool,
    idp: Idp,
    admin: String,
}

type Res = (u16, HeaderMap, Value);

fn new_verifier() -> String {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).unwrap();
    B64.encode(b)
}

fn merge(mut base: Value, patch: Value) -> Value {
    for (k, v) in patch.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

async fn ctx(pool: PgPool) -> Ctx {
    ctx_with(pool, |_| {}).await
}

async fn ctx_with(pool: PgPool, tune: impl FnOnce(&mut AppState)) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let mut st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    tune(&mut st);
    let app = Router::new()
        .merge(auth::router())
        .merge(settings::router())
        .merge(users::router())
        .with_state(st.clone());
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('public_url', $1)")
        .bind(PUBLIC)
        .execute(&pool)
        .await
        .unwrap();
    let admin: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin") VALUES ('root', true) RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let admin = format!("Bearer {}", session::token(&st, admin, "root").await);
    Ctx {
        st,
        app,
        pool,
        idp: Idp::start().await,
        admin,
    }
}

impl Ctx {
    async fn send(&self, req: Request<Body>) -> Res {
        let res = self.app.clone().oneshot(req).await.unwrap();
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

    /// `auth` is a full `Authorization` value.
    async fn call(&self, method: &str, uri: &str, auth: Option<&str>, body: Option<Value>) -> Res {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(a) = auth {
            req = req.header("authorization", a);
        }
        let body = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        self.send(req.body(body).unwrap()).await
    }

    async fn admin(&self, method: &str, uri: &str, body: Option<Value>) -> Res {
        self.call(method, uri, Some(&self.admin), body).await
    }

    async fn form(&self, uri: &str, body: String) -> Res {
        let req = Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(Body::from(body))
            .unwrap();
        self.send(req).await
    }

    fn body(&self, patch: Value) -> Value {
        merge(
            json!({"name": "Fake", "issuer": self.idp.base, "clientId": CLIENT_ID,
                   "clientSecret": CLIENT_SECRET, "autoRegister": true}),
            patch,
        )
    }

    async fn try_provider(&self, patch: Value) -> Res {
        self.admin("POST", "/api/oidc-providers", Some(self.body(patch)))
            .await
    }

    async fn provider(&self, patch: Value) -> i32 {
        let (s, _, b) = self.try_provider(patch).await;
        assert_eq!(s, 201, "{b}");
        b["id"].as_i64().unwrap() as i32
    }

    async fn user(&self, name: &str, email: Option<&str>, admin: bool) -> i32 {
        sqlx::query_scalar(
            r#"INSERT INTO users (username, email, "isAdmin") VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(email)
        .bind(admin)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn token_of(&self, id: i32, name: &str) -> String {
        format!("Bearer {}", session::token(&self.st, id, name).await)
    }

    async fn begin_with(&self, pid: i32, body: Value, auth: Option<&str>) -> (Res, Option<Flow>) {
        let verifier = new_verifier();
        let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
        let body = merge(json!({"challenge": challenge, "returnTo": "web"}), body);
        let res = self
            .call(
                "POST",
                &format!("/api/auth/oidc/{pid}/start"),
                auth,
                Some(body),
            )
            .await;
        if res.0 != 201 {
            return (res, None);
        }
        let url = reqwest::Url::parse(res.2["authorizeUrl"].as_str().unwrap()).unwrap();
        let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
        assert_eq!(res.2["state"], q["state"]);
        let f = Flow {
            verifier,
            challenge,
            state: q["state"].clone(),
            nonce: q["nonce"].clone(),
            redirect_uri: q["redirect_uri"].clone(),
        };
        (res, Some(f))
    }

    async fn begin(&self, pid: i32) -> Flow {
        self.begin_with(pid, json!({}), None)
            .await
            .1
            .expect("start")
    }

    async fn callback(&self, pid: i32, query: &str) -> (u16, String) {
        let req = Request::builder()
            .uri(format!("/api/auth/oidc/{pid}/callback?{query}"))
            .body(Body::empty())
            .unwrap();
        let (s, h, _) = self.send(req).await;
        let loc = h
            .get("location")
            .map(|v| v.to_str().unwrap().to_owned())
            .unwrap_or_default();
        (s, loc)
    }

    async fn exchange(&self, f: &Flow, code: &str, verifier: &str, auth: Option<&str>) -> Res {
        let body = json!({"state": f.state, "code": code, "verifier": verifier});
        self.call("POST", "/api/auth/oidc/exchange", auth, Some(body))
            .await
    }

    /// The whole login: start, the provider's code, the callback, the exchange.
    async fn login_with(&self, pid: i32, patch: Value, how: Signing) -> Res {
        let f = self.begin(pid).await;
        let code = self.idp.issue(&f, patch, how);
        let (s, loc) = self
            .callback(pid, &format!("code={code}&state={}", f.state))
            .await;
        assert_eq!(s, 302);
        assert!(
            loc.starts_with(&format!("{PUBLIC}/oidc/complete#code=")),
            "{loc}"
        );
        self.exchange(&f, &code, &f.verifier, None).await
    }

    async fn login(&self, pid: i32, patch: Value) -> Res {
        self.login_with(pid, patch, Signing::Key(0)).await
    }

    /// A refused sign-in leaves its start counted; tests that run many clear it.
    fn unthrottle(&self) {
        self.st.login_throttle.clear(None, "oidc:");
    }

    async fn user_id(&self, name: &str) -> Option<i32> {
        sqlx::query_scalar("SELECT id FROM users WHERE username = $1")
            .bind(name)
            .fetch_optional(&self.pool)
            .await
            .unwrap()
    }

    async fn setting(&self, key: &str, value: &str) -> Res {
        self.admin(
            "PUT",
            &format!("/api/settings/{key}"),
            Some(json!({"value": value})),
        )
        .await
    }
}

fn access(b: &Value) -> String {
    format!("Bearer {}", b["accessToken"].as_str().unwrap())
}

fn error(r: &Res) -> (u16, String) {
    (r.0, r.2["error"].as_str().unwrap_or_default().to_owned())
}

impl Ctx {
    async fn library(&self, name: &str) -> i32 {
        sqlx::query_scalar(
            r#"INSERT INTO libraries (name, icon, color, "mediaTypes") VALUES ($1, 'film', '#3b82f6', '["movie"]') RETURNING id"#,
        )
        .bind(name)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn role(&self, name: &str, perms: &str, default: bool, libs: &[i32]) -> i32 {
        if default {
            sqlx::query(r#"UPDATE roles SET "isDefault" = false"#)
                .execute(&self.pool)
                .await
                .unwrap();
        }
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO roles (name, permissions, "isDefault") VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(perms)
        .bind(default)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        for l in libs {
            sqlx::query(
                r#"INSERT INTO role_default_libraries ("roleId", "libraryId") VALUES ($1, $2)"#,
            )
            .bind(id)
            .bind(l)
            .execute(&self.pool)
            .await
            .unwrap();
        }
        id
    }

    async fn libraries_of(&self, user: i32) -> Vec<i32> {
        sqlx::query_scalar(r#"SELECT "libraryId" FROM library_user_access WHERE "userId" = $1 ORDER BY "libraryId""#)
            .bind(user)
            .fetch_all(&self.pool)
            .await
            .unwrap()
    }

    async fn pw_user(&self, name: &str, admin: bool) -> i32 {
        let hash = bcrypt::hash(format!("{name}-pass"), 4).unwrap();
        sqlx::query_scalar(
            r#"INSERT INTO users (username, "passwordHash", "isAdmin") VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(hash)
        .bind(admin)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }

    async fn password_login(&self, name: &str, password: &str) -> Res {
        self.call(
            "POST",
            "/api/auth/login",
            None,
            Some(json!({"username": name, "password": password})),
        )
        .await
    }

    /// Links `sub` to the user holding `auth`, through the whole flow.
    async fn link(&self, pid: i32, auth: &str, sub: &str) -> Res {
        let (res, f) = self
            .begin_with(pid, json!({"link": true}), Some(auth))
            .await;
        let f = f.unwrap_or_else(|| panic!("start: {res:?}"));
        let code = self.idp.issue(&f, json!({"sub": sub}), Signing::Key(0));
        self.callback(pid, &format!("code={code}&state={}", f.state))
            .await;
        self.exchange(&f, &code, &f.verifier, Some(auth)).await
    }
}

fn refreshed(b: &Value) -> Value {
    json!({"refreshToken": b["refreshToken"]})
}

#[sqlx::test(migrations = false)]
async fn login_creates_a_session_and_answers_like_password_login(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    let (s, h, b) = c.login(pid, json!({"sid": "idp-sid-1"})).await;
    assert_eq!(s, 201, "{b}");
    for k in [
        "accessToken",
        "refreshToken",
        "accessTokenExpiresAt",
        "refreshTokenExpiresAt",
        "user",
    ] {
        assert!(b.get(k).is_some(), "{k}");
    }
    assert_eq!(b["user"]["username"], "ann");
    assert!(b["user"].get("passwordHash").is_none());
    assert!(
        h["set-cookie"]
            .to_str()
            .unwrap()
            .starts_with("fliks_access=")
    );
    let row: (String, i32, Option<String>, Option<String>) = sqlx::query_as(
        r#"SELECT method, "providerId", sid, subject FROM sessions WHERE method = 'oidc'"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        (
            "oidc".into(),
            pid,
            Some("idp-sid-1".into()),
            Some("sub-1".into())
        )
    );
    assert_eq!(c.idp.st.token_auth.lock().unwrap().as_slice(), ["basic"]);

    let (s, _, r) = c
        .call("POST", "/api/auth/refresh", None, Some(refreshed(&b)))
        .await;
    assert_eq!(s, 201);
    assert_ne!(r["refreshToken"], b["refreshToken"]);
    let (s, _, sessions) = c
        .call("GET", "/api/auth/sessions", Some(&access(&b)), None)
        .await;
    assert_eq!(s, 200);
    assert_eq!(
        (
            sessions[0]["method"].clone(),
            sessions[0]["providerName"].clone()
        ),
        (json!("oidc"), json!("Fake"))
    );
    let (s, _, ids) = c
        .call("GET", "/api/auth/oidc/identities", Some(&access(&b)), None)
        .await;
    assert_eq!(s, 200);
    assert_eq!(ids["hasPassword"], false);
    assert_eq!(ids["identities"][0]["name"], "Fake");
    assert_eq!(ids["identities"][0]["email"], "ann@example.test");
}

#[sqlx::test(migrations = false)]
async fn client_secret_goes_in_the_body_when_only_that_is_advertised(pool: PgPool) {
    let c = ctx(pool).await;
    *c.idp.st.methods.lock().unwrap() = vec!["client_secret_post"];
    let pid = c.provider(json!({})).await;
    assert_eq!(c.login(pid, json!({})).await.0, 201);
    assert_eq!(c.idp.st.token_auth.lock().unwrap().as_slice(), ["post"]);
}

#[sqlx::test(migrations = false)]
async fn a_wrong_verifier_is_refused_by_the_provider_and_the_state_is_spent(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    let f = c.begin(pid).await;
    let code = c.idp.issue(&f, json!({}), Signing::Key(0));
    let r = c.exchange(&f, &code, &new_verifier(), None).await;
    assert_eq!(error(&r), (400, "idp".into()));
    let again = c.exchange(&f, &code, &f.verifier, None).await;
    assert_eq!(error(&again), (400, "expired".into()));
    assert!(c.user_id("ann").await.is_none());
}

#[sqlx::test(migrations = false)]
async fn a_state_is_single_use_and_expires(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    let f = c.begin(pid).await;
    let code = c.idp.issue(&f, json!({}), Signing::Key(0));
    assert_eq!(c.exchange(&f, &code, &f.verifier, None).await.0, 201);
    let code = c.idp.issue(&f, json!({}), Signing::Key(0));
    assert_eq!(
        error(&c.exchange(&f, &code, &f.verifier, None).await),
        (400, "expired".into())
    );

    let f = c.begin(pid).await;
    sqlx::query(r#"UPDATE oidc_logins SET "expiresAt" = now() - interval '1 minute'"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let code = c.idp.issue(&f, json!({"sub": "sub-2"}), Signing::Key(0));
    assert_eq!(
        error(&c.exchange(&f, &code, &f.verifier, None).await),
        (400, "expired".into())
    );
    let (_, loc) = c.callback(pid, &format!("code=x&state={}", f.state)).await;
    assert!(loc.contains("error=expired"), "{loc}");
}

#[sqlx::test(migrations = false)]
async fn the_callback_checks_provider_issuer_and_idp_errors(pool: PgPool) {
    let c = ctx(pool).await;
    let (p1, p2) = (
        c.provider(json!({})).await,
        c.provider(json!({"name": "Other"})).await,
    );
    let f = c.begin(p1).await;
    let q = format!("code=c1&state={}", f.state);
    let (s, loc) = c.callback(p2, &q).await;
    assert_eq!(s, 302);
    assert!(
        loc.starts_with(&format!(
            "{PUBLIC}/oidc/complete#error=expired&state={}",
            f.state
        )),
        "{loc}"
    );
    let (_, loc) = c
        .callback(p1, &format!("{q}&iss=https%3A%2F%2Fevil.test"))
        .await;
    assert!(loc.contains("error=expired"), "{loc}");
    let (_, loc) = c
        .callback(p1, &format!("error=access_denied&state={}", f.state))
        .await;
    assert!(loc.contains("error=idp") && loc.contains(&f.state), "{loc}");
    let (_, loc) = c.callback(p1, "code=c1&state=unknown").await;
    assert!(loc.contains("error=expired"), "{loc}");
    let iss =
        reqwest::Url::parse_with_params("http://x/?", [("iss", c.idp.base.as_str())]).unwrap();
    let (_, loc) = c
        .callback(p1, &format!("{q}&{}", iss.query().unwrap()))
        .await;
    assert!(loc.contains("code=c1"), "{loc}");
}

#[sqlx::test(migrations = false)]
async fn return_targets_are_a_closed_set(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    for bad in [
        "https://evil.test",
        "http://127.0.0.1:80/oidc",
        "http://localhost:5000/oidc",
        "http://127.0.0.1:5000/x",
        "",
    ] {
        c.unthrottle();
        let (r, _) = c.begin_with(pid, json!({"returnTo": bad}), None).await;
        assert_eq!(r.0, 400, "{bad}");
    }
    for (rt, prefix) in [
        ("app", "media.fliks.app:/oidc/complete?code="),
        (
            "http://127.0.0.1:45123/oidc",
            "http://127.0.0.1:45123/oidc?code=",
        ),
    ] {
        c.unthrottle();
        let (_, f) = c.begin_with(pid, json!({"returnTo": rt}), None).await;
        let f = f.unwrap();
        let (s, loc) = c.callback(pid, &format!("code=c1&state={}", f.state)).await;
        assert!(s == 302 && loc.starts_with(prefix), "{loc}");
    }
    assert_eq!(
        c.begin_with(pid, json!({"challenge": "short"}), None)
            .await
            .0
            .0,
        400
    );
    assert_eq!(
        c.begin_with(pid, json!({"prompt": "login"}), None)
            .await
            .0
            .0,
        400
    );
    let (r, _) = c.begin_with(pid, json!({"prompt": "none"}), None).await;
    assert!(
        r.2["authorizeUrl"]
            .as_str()
            .unwrap()
            .contains("prompt=none")
    );
    assert_eq!(
        c.begin_with(pid, json!({"link": true}), None).await.0.0,
        401
    );
    assert_eq!(c.begin_with(999, json!({}), None).await.0.0, 404);
}

#[sqlx::test(migrations = false)]
async fn start_is_throttled_per_network_and_a_success_clears_it(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    for _ in 0..29 {
        assert_eq!(c.begin_with(pid, json!({}), None).await.0.0, 201);
    }
    assert_eq!(
        c.login(pid, json!({})).await.0,
        201,
        "the 30th start, then a success"
    );
    for _ in 0..30 {
        assert_eq!(c.begin_with(pid, json!({}), None).await.0.0, 201);
    }
    assert_eq!(c.begin_with(pid, json!({}), None).await.0.0, 429);
}

#[sqlx::test(migrations = false)]
async fn a_silent_run_never_overrides_a_login_or_consent_prompt(pool: PgPool) {
    let c = ctx(pool).await;
    let strict = c.provider(json!({"prompt": "login"})).await;
    let (r, _) = c.begin_with(strict, json!({"prompt": "none"}), None).await;
    assert_eq!(r.0, 409);
    let (r, _) = c.begin_with(strict, json!({}), None).await;
    assert!(
        r.2["authorizeUrl"]
            .as_str()
            .unwrap()
            .contains("prompt=login")
    );
    let soft = c
        .provider(json!({"name": "S", "prompt": "select_account"}))
        .await;
    let (r, _) = c.begin_with(soft, json!({"prompt": "none"}), None).await;
    let url = r.2["authorizeUrl"].as_str().unwrap().to_owned();
    assert!(
        url.contains("prompt=none") && !url.contains("select_account"),
        "{url}"
    );
}

#[sqlx::test(migrations = false)]
async fn a_self_set_email_does_not_hand_over_an_account(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c
        .provider(json!({"matchByEmail": true, "autoRegister": false}))
        .await;
    let hash = bcrypt::hash("pw", 4).unwrap();
    sqlx::query(r#"INSERT INTO users (username, email, "passwordHash") VALUES ('mallory', 'ann@example.test', $1)"#)
        .bind(hash)
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(
        error(&c.login(pid, json!({})).await),
        (403, "no_account".into())
    );
    sqlx::query(
        r#"UPDATE users SET "passwordHash" = NULL, "lastLogin" = now() WHERE username = 'mallory'"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        error(&c.login(pid, json!({})).await),
        (403, "no_account".into()),
        "a user who signed in"
    );
    sqlx::query(r#"UPDATE users SET "lastLogin" = NULL WHERE username = 'mallory'"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, _, b) = c.login(pid, json!({})).await;
    assert_eq!(
        (s, b["user"]["username"].clone()),
        (201, json!("mallory")),
        "an admin-made placeholder"
    );
}

#[sqlx::test(migrations = false)]
async fn a_provider_without_s256_or_a_public_url_cannot_be_enabled(pool: PgPool) {
    let c = ctx(pool).await;
    c.idp.st.s256.store(false, Ordering::SeqCst);
    let (s, _, b) = c.try_provider(json!({})).await;
    assert_eq!(s, 400);
    assert!(b["message"].as_str().unwrap().contains("PKCE"), "{b}");
    let off = c.provider(json!({"enabled": false})).await;
    let put = |enabled: bool| {
        let url = format!("/api/oidc-providers/{off}");
        let body = c.body(json!({"enabled": enabled}));
        let c = &c;
        async move { c.admin("PUT", &url, Some(body)).await }
    };
    assert_eq!(put(true).await.0, 400);
    c.idp.st.s256.store(true, Ordering::SeqCst);
    sqlx::query("DELETE FROM app_settings WHERE key = 'public_url'")
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(put(true).await.0, 400);
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('public_url', $1)")
        .bind(PUBLIC)
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(put(true).await.0, 200);
}

#[sqlx::test(migrations = false)]
async fn without_auto_register_an_unknown_identity_has_no_account(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({"autoRegister": false})).await;
    assert_eq!(
        error(&c.login(pid, json!({})).await),
        (403, "no_account".into())
    );
    assert!(c.user_id("ann").await.is_none());
}

#[sqlx::test(migrations = false)]
async fn auto_register_creates_an_sso_only_user_with_the_default_role_libraries(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.library("Movies").await;
    let role = c.role("Base", "[]", true, &[lib]).await;
    let pid = c.provider(json!({})).await;
    let (s, _, b) = c.login(pid, json!({})).await;
    assert_eq!(s, 201);
    let id = b["user"]["id"].as_i64().unwrap() as i32;
    let (hash, role_id, admin, email, must): (Option<String>, Option<i32>, bool, Option<String>, bool) = sqlx::query_as(
        r#"SELECT "passwordHash", "roleId", "isAdmin", email, "requirePasswordChange" FROM users WHERE id = $1"#,
    )
    .bind(id)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        (hash, role_id, admin, email, must),
        (
            None,
            Some(role),
            false,
            Some("ann@example.test".into()),
            false
        )
    );
    assert_eq!(c.libraries_of(id).await, vec![lib]);
    let (s, _, e) = c.password_login("ann", "anything").await;
    assert_eq!(
        (s, e["message"].clone()),
        (401, json!("Invalid credentials"))
    );
}

#[sqlx::test(migrations = false)]
async fn an_unverified_email_is_not_stored_and_not_matched(pool: PgPool) {
    let c = ctx(pool).await;
    c.user("legacy", Some("ann@example.test"), false).await;
    let pid = c.provider(json!({"matchByEmail": true})).await;
    let (s, _, b) = c.login(pid, json!({"email_verified": false})).await;
    assert_eq!(s, 201);
    assert_eq!(b["user"]["username"], "ann");
    assert!(b["user"]["email"].is_null());
}

#[sqlx::test(migrations = false)]
async fn a_verified_email_adopts_one_existing_user_never_an_admin(pool: PgPool) {
    let c = ctx(pool).await;
    let legacy = c.user("legacy", Some("Ann@Example.test"), false).await;
    let pid = c
        .provider(json!({"matchByEmail": true, "autoRegister": false}))
        .await;
    let (s, _, b) = c.login(pid, json!({})).await;
    assert_eq!((s, b["user"]["id"].as_i64()), (201, Some(legacy as i64)));
    let linked: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM user_identities WHERE "userId" = $1"#)
            .bind(legacy)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(linked, 1);

    c.user("boss", Some("boss@example.test"), true).await;
    let r = c
        .login(pid, json!({"sub": "sub-2", "email": "boss@example.test"}))
        .await;
    assert_eq!(error(&r), (403, "no_account".into()));
}

#[sqlx::test(migrations = false)]
async fn an_ambiguous_email_falls_through(pool: PgPool) {
    let c = ctx(pool).await;
    c.user("one", Some("ann@example.test"), false).await;
    c.user("two", Some("ann@example.test"), false).await;
    let pid = c
        .provider(json!({"matchByEmail": true, "autoRegister": false}))
        .await;
    assert_eq!(
        error(&c.login(pid, json!({})).await),
        (403, "no_account".into())
    );
    let pid2 = c.provider(json!({"name": "B", "matchByEmail": true})).await;
    let (s, _, b) = c.login(pid2, json!({})).await;
    assert_eq!((s, b["user"]["username"].clone()), (201, json!("ann")));
}

#[sqlx::test(migrations = false)]
async fn a_username_clash_adds_a_counter(pool: PgPool) {
    let c = ctx(pool).await;
    c.user("Ann", None, false).await;
    let pid = c.provider(json!({})).await;
    let (_, _, a) = c.login(pid, json!({"sub": "s-a", "email": null})).await;
    let (_, _, b) = c.login(pid, json!({"sub": "s-b", "email": null})).await;
    assert_eq!(
        (a["user"]["username"].clone(), b["user"]["username"].clone()),
        (json!("ann-2"), json!("ann-3"))
    );
    let (_, _, nameless) = c
        .login(
            pid,
            json!({"sub": "s-c", "preferred_username": null, "email": null}),
        )
        .await;
    assert!(
        nameless["user"]["username"]
            .as_str()
            .unwrap()
            .starts_with("user-")
    );
}

#[sqlx::test(migrations = false)]
async fn register_copies_the_default_role_libraries(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.library("Movies").await;
    c.role("Base", "[]", true, &[lib]).await;
    let (s, _, _) = c
        .admin(
            "POST",
            "/api/auth/register",
            Some(json!({"username": "newbie", "password": "pw"})),
        )
        .await;
    assert_eq!(s, 201);
    let id = c.user_id("newbie").await.unwrap();
    assert_eq!(c.libraries_of(id).await, vec![lib]);
}

#[sqlx::test(migrations = false)]
async fn groups_gate_admin_role_and_libraries(pool: PgPool) {
    let c = ctx(pool).await;
    let (l1, l2) = (c.library("A").await, c.library("B").await);
    let base = c.role("Base", "[]", true, &[l1]).await;
    let kids = c.role("Kids", "[]", false, &[l2]).await;
    let vip = c.role("Vip", "[]", false, &[l1, l2]).await;
    let pid = c
        .provider(json!({"groupsClaim": "groups", "allowedGroups": ["users", "kids", "vip", "admins"],
            "adminGroups": ["admins"], "roleMappings": [{"group": "kids", "roleId": kids}, {"group": "vip", "roleId": vip}]}))
        .await;
    let denied = c.login(pid, json!({"groups": ["other"]})).await;
    assert_eq!(error(&denied), (403, "not_allowed".into()));
    assert!(c.user_id("ann").await.is_none());

    let (s, _, b) = c.login(pid, json!({"groups": ["users"]})).await;
    assert_eq!(s, 201);
    let id = b["user"]["id"].as_i64().unwrap() as i32;
    assert_eq!(
        (role_of(&c, id).await, c.libraries_of(id).await),
        ((Some(base), false), vec![l1])
    );

    let conn = c.st.hub.connect(id, Identity::default());
    c.login(pid, json!({"groups": ["vip", "kids"]})).await;
    assert_eq!(
        (role_of(&c, id).await, c.libraries_of(id).await),
        ((Some(kids), false), vec![l2]),
        "first match wins"
    );
    assert!(
        !c.st.hub.has_connection(&conn.id),
        "a changed access drops the streams"
    );

    let conn = c.st.hub.connect(id, Identity::default());
    c.login(pid, json!({"groups": ["kids", "admins"]})).await;
    assert!(role_of(&c, id).await.1);
    assert!(!c.st.hub.has_connection(&conn.id));
    let conn = c.st.hub.connect(id, Identity::default());
    c.login(pid, json!({"groups": ["kids", "admins"]})).await;
    assert!(c.st.hub.has_connection(&conn.id), "no change, no drop");
}

#[sqlx::test(migrations = false)]
async fn parts_that_are_not_configured_stay_untouched(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.library("A").await;
    let role = c.role("Base", "[]", true, &[lib]).await;
    let pid = c
        .provider(json!({"groupsClaim": "groups", "adminGroups": ["admins"]}))
        .await;
    let (_, _, b) = c.login(pid, json!({"groups": []})).await;
    let id = b["user"]["id"].as_i64().unwrap() as i32;
    let other = c.role("Custom", "[]", false, &[]).await;
    sqlx::query(r#"UPDATE users SET "roleId" = $2 WHERE id = $1"#)
        .bind(id)
        .bind(other)
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query(r#"DELETE FROM library_user_access WHERE "userId" = $1"#)
        .bind(id)
        .execute(&c.pool)
        .await
        .unwrap();
    c.login(pid, json!({"groups": ["admins"]})).await;
    let (r, admin): (Option<i32>, bool) =
        sqlx::query_as(r#"SELECT "roleId", "isAdmin" FROM users WHERE id = $1"#)
            .bind(id)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(
        (r, admin, c.libraries_of(id).await),
        (Some(other), true, vec![])
    );
    assert_ne!(r, Some(role));
}

#[sqlx::test(migrations = false)]
async fn the_last_enabled_admin_is_never_demoted_by_a_group_change(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c
        .provider(json!({"groupsClaim": "groups", "adminGroups": ["admins"]}))
        .await;
    sqlx::query("UPDATE users SET enabled = false WHERE username = 'root'")
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, _, b) = c.login(pid, json!({"groups": ["admins"]})).await;
    let id = b["user"]["id"].as_i64().unwrap() as i32;
    let (s, _, _) = c.login(pid, json!({"groups": ["users"]})).await;
    assert_eq!(s, 201);
    let admin: bool = sqlx::query_scalar(r#"SELECT "isAdmin" FROM users WHERE id = $1"#)
        .bind(id)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert!(admin);
    sqlx::query("UPDATE users SET enabled = true WHERE username = 'root'")
        .execute(&c.pool)
        .await
        .unwrap();
    c.login(pid, json!({"groups": ["users"]})).await;
    let admin: bool = sqlx::query_scalar(r#"SELECT "isAdmin" FROM users WHERE id = $1"#)
        .bind(id)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert!(!admin, "demoted once another admin exists");
}

#[sqlx::test(migrations = false)]
async fn userinfo_fills_the_claims_the_id_token_lacks(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c
        .provider(json!({"groupsClaim": "groups", "adminGroups": ["admins"]}))
        .await;
    *c.idp.st.userinfo.lock().unwrap() = Some(json!({"sub": "sub-1", "groups": ["admins"]}));
    let (s, _, b) = c.login(pid, json!({})).await;
    assert_eq!((s, b["user"]["isAdmin"].clone()), (201, json!(true)));
    *c.idp.st.userinfo.lock().unwrap() = Some(json!({"sub": "someone-else", "groups": ["admins"]}));
    assert_eq!(
        error(&c.login(pid, json!({"sub": "sub-2"})).await),
        (400, "idp".into())
    );
    *c.idp.st.userinfo.lock().unwrap() = None;
    assert_eq!(
        error(&c.login(pid, json!({"sub": "sub-3"})).await),
        (400, "idp".into())
    );
}

#[sqlx::test(migrations = false)]
async fn linking_needs_a_session_and_the_right_owner(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({"autoRegister": false})).await;
    let (bob, carol) = (
        c.pw_user("bob", false).await,
        c.pw_user("carol", false).await,
    );
    let (bt, ct) = (
        c.token_of(bob, "bob").await,
        c.token_of(carol, "carol").await,
    );
    assert_eq!(
        c.begin_with(pid, json!({"link": true}), None).await.0.0,
        401
    );

    let r = c.link(pid, &bt, "sub-9").await;
    assert_eq!(r.0, 204, "{:?}", r.2);
    let (_, _, ids) = c
        .call("GET", "/api/auth/oidc/identities", Some(&bt), None)
        .await;
    assert_eq!(
        (
            ids["hasPassword"].clone(),
            ids["identities"][0]["providerId"].clone()
        ),
        (json!(true), json!(pid))
    );
    assert_eq!(
        error(&c.link(pid, &ct, "sub-9").await),
        (409, "already_linked".into())
    );
    let (_, f) = c.begin_with(pid, json!({"link": true}), Some(&bt)).await;
    let f = f.unwrap();
    let code = c.idp.issue(&f, json!({"sub": "sub-10"}), Signing::Key(0));
    assert_eq!(
        error(&c.exchange(&f, &code, &f.verifier, Some(&ct)).await),
        (400, "expired".into()),
        "another user's link"
    );
    assert_eq!(
        c.exchange(&f, &code, &f.verifier, Some(&bt)).await.0,
        400,
        "the row is spent"
    );
    let login = c.login(pid, json!({"sub": "sub-9"})).await;
    assert_eq!(
        (login.0, login.2["user"]["username"].clone()),
        (201, json!("bob"))
    );
}

#[sqlx::test(migrations = false)]
async fn a_password_that_policy_forbids_is_not_a_second_method(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({"autoRegister": false})).await;
    let bob = c.pw_user("bob", false).await;
    let t = c.token_of(bob, "bob").await;
    assert_eq!(c.link(pid, &t, "sub-9").await.0, 204);
    assert_eq!(c.setting("password_login", "admins").await.0, 200);
    let (s, _, e) = c
        .call(
            "DELETE",
            &format!("/api/auth/oidc/identities/{pid}"),
            Some(&t),
            None,
        )
        .await;
    assert_eq!(
        (s, e["message"].clone()),
        (400, json!("oidc.error_last_method"))
    );
    let (_, _, ids) = c
        .call("GET", "/api/auth/oidc/identities", Some(&t), None)
        .await;
    assert_eq!(ids["hasPassword"], false);
}

#[sqlx::test(migrations = false)]
async fn the_last_sign_in_method_cannot_be_unlinked(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    let (_, _, b) = c.login(pid, json!({})).await;
    let (s, _, e) = c
        .call(
            "DELETE",
            &format!("/api/auth/oidc/identities/{pid}"),
            Some(&access(&b)),
            None,
        )
        .await;
    assert_eq!(
        (s, e["message"].clone()),
        (400, json!("oidc.error_last_method"))
    );
    let id = b["user"]["id"].as_i64().unwrap();
    let hash = bcrypt::hash("pw", 4).unwrap();
    sqlx::query(r#"UPDATE users SET "passwordHash" = $2 WHERE id = $1"#)
        .bind(id as i32)
        .bind(hash)
        .execute(&c.pool)
        .await
        .unwrap();
    let url = format!("/api/auth/oidc/identities/{pid}");
    assert_eq!(c.call("DELETE", &url, Some(&access(&b)), None).await.0, 204);
    assert_eq!(c.call("DELETE", &url, Some(&access(&b)), None).await.0, 404);
}

#[sqlx::test(migrations = false)]
async fn a_manager_unlinks_a_user_but_not_an_admin(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({"autoRegister": false})).await;
    let (bob, boss) = (
        c.user("bob", None, false).await,
        c.user("boss", None, true).await,
    );
    for (u, sub) in [(bob, "s-bob"), (boss, "s-boss")] {
        sqlx::query(
            r#"INSERT INTO user_identities ("userId", "providerId", subject) VALUES ($1, $2, $3)"#,
        )
        .bind(u)
        .bind(pid)
        .bind(sub)
        .execute(&c.pool)
        .await
        .unwrap();
    }
    let role = c.role("Mgr", r#"["users.manage"]"#, false, &[]).await;
    let mgr = c.user("mgr", None, false).await;
    sqlx::query(r#"UPDATE users SET "roleId" = $2 WHERE id = $1"#)
        .bind(mgr)
        .bind(role)
        .execute(&c.pool)
        .await
        .unwrap();
    let mt = c.token_of(mgr, "mgr").await;
    let url = |u: i32| format!("/api/users/{u}/oidc/{pid}");
    assert_eq!(c.call("DELETE", &url(boss), Some(&mt), None).await.0, 403);
    assert_eq!(c.call("DELETE", &url(bob), Some(&mt), None).await.0, 204);
    assert_eq!(c.call("DELETE", &url(bob), Some(&mt), None).await.0, 404);
    assert_eq!(c.admin("DELETE", &url(boss), None).await.0, 204);
}

#[sqlx::test(migrations = false)]
async fn every_id_token_check_refuses(pool: PgPool) {
    let c = ctx(pool).await;
    *c.idp.st.algs.lock().unwrap() = vec!["ES256", "HS256"];
    let pid = c.provider(json!({})).await;
    let cases: Vec<(&str, Value, Signing)> = vec![
        ("bad signature", json!({}), Signing::Foreign),
        (
            "wrong iss",
            json!({"iss": "https://evil.test"}),
            Signing::Key(0),
        ),
        ("wrong aud", json!({"aud": "other"}), Signing::Key(0)),
        (
            "several aud without azp",
            json!({"aud": [CLIENT_ID, "other"]}),
            Signing::Key(0),
        ),
        ("another azp", json!({"azp": "other"}), Signing::Key(0)),
        ("expired", json!({"exp": now() - 3600}), Signing::Key(0)),
        ("no exp", json!({"exp": null}), Signing::Key(0)),
        ("wrong nonce", json!({"nonce": "nope"}), Signing::Key(0)),
        ("no nonce", json!({"nonce": null}), Signing::Key(0)),
        ("no iat", json!({"iat": null}), Signing::Key(0)),
        ("no subject", json!({"sub": null}), Signing::Key(0)),
        ("alg none", json!({}), Signing::None),
        ("HS256", json!({}), Signing::Hs256),
    ];
    for (name, patch, how) in cases {
        c.unthrottle();
        let r = c.login_with(pid, patch, how).await;
        assert_eq!(error(&r), (400, "idp".into()), "{name}");
    }
    assert!(c.user_id("ann").await.is_none());
    let ok = c
        .login_with(
            pid,
            json!({"aud": [CLIENT_ID, "other"], "azp": CLIENT_ID}),
            Signing::Key(0),
        )
        .await;
    assert_eq!(ok.0, 201, "{:?}", ok.2);
}

#[sqlx::test(migrations = false)]
async fn an_algorithm_the_provider_does_not_advertise_is_refused(pool: PgPool) {
    let c = ctx(pool).await;
    *c.idp.st.algs.lock().unwrap() = vec!["RS256"];
    let pid = c.provider(json!({})).await;
    assert_eq!(error(&c.login(pid, json!({})).await), (400, "idp".into()));
}

#[sqlx::test(migrations = false)]
async fn an_unknown_kid_refetches_the_keys_at_most_once_a_minute(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    let r = c.login_with(pid, json!({}), Signing::Key(1)).await;
    assert_eq!(error(&r), (400, "idp".into()));
    assert_eq!(
        c.idp.st.jwks_hits.load(Ordering::SeqCst),
        1,
        "the minute has not passed"
    );
}

#[sqlx::test(migrations = false)]
async fn a_rotated_key_is_found_by_one_refetch(pool: PgPool) {
    let c = ctx_with(pool, |st| {
        st.oidc = Arc::new(Oidc::default().with_refetch(Duration::ZERO))
    })
    .await;
    let pid = c.provider(json!({})).await;
    assert_eq!(c.login(pid, json!({})).await.0, 201);
    c.idp.st.published.lock().unwrap().push("k2".into());
    let hits = c.idp.st.jwks_hits.load(Ordering::SeqCst);
    let r = c
        .login_with(pid, json!({"sub": "sub-2"}), Signing::Key(1))
        .await;
    assert_eq!(r.0, 201, "{:?}", r.2);
    assert_eq!(c.idp.st.jwks_hits.load(Ordering::SeqCst), hits + 1);
}

/// Every name resolves to one address; connections are real.
struct Fixed(IpAddr);

impl Net for Fixed {
    fn lookup(&self, _: &str, port: u16) -> BoxFuture<'static, std::io::Result<Vec<SocketAddr>>> {
        let ip = self.0;
        Box::pin(async move { Ok(vec![SocketAddr::new(ip, port)]) })
    }
    fn connect(&self, a: SocketAddr) -> BoxFuture<'static, std::io::Result<tokio::net::TcpStream>> {
        Box::pin(tokio::net::TcpStream::connect(a))
    }
    fn tls(&self) -> Arc<tokio_rustls::rustls::ClientConfig> {
        SystemNet::new().tls()
    }
}

impl Ctx {
    async fn probe(&self, issuer: &str, ca: Option<&str>) -> Value {
        let mut body = json!({"issuer": issuer});
        if let Some(ca) = ca {
            body["caPem"] = json!(ca);
        }
        let (s, _, b) = self
            .admin("POST", "/api/oidc-providers/test", Some(body))
            .await;
        assert_eq!(s, 200, "{b}");
        b
    }
}

#[sqlx::test(migrations = false)]
async fn the_test_route_reports_what_the_provider_supports(pool: PgPool) {
    let c = ctx(pool).await;
    let b = c.probe(&c.idp.base, None).await;
    assert_eq!(
        b,
        json!({"ok": true, "issuer": c.idp.base, "algs": ["ES256"], "pkce": true, "endSession": true, "backchannel": true})
    );
    c.idp.st.s256.store(false, Ordering::SeqCst);
    assert_eq!(c.probe(&c.idp.base, None).await["pkce"], false);
}

#[sqlx::test(migrations = false)]
async fn the_guard_refuses_metadata_and_redirects(pool: PgPool) {
    let c = ctx(pool).await;
    assert_eq!(
        c.probe("http://169.254.169.254", None).await["error"],
        "address refused"
    );
    assert_eq!(
        c.probe(&format!("{}/redirected", c.idp.base), None).await["error"],
        "status 302"
    );
    assert_eq!(
        c.probe("http://127.0.0.1:1", None).await["error"],
        "network error"
    );
    assert_eq!(c.probe("ftp://x.test", None).await["ok"], false);
}

#[sqlx::test(migrations = false)]
async fn plain_http_to_a_public_address_is_refused(pool: PgPool) {
    let c = ctx_with(pool, |st| {
        st.oidc = Arc::new(Oidc::with_net(Arc::new(Fixed(
            "93.184.216.34".parse().unwrap(),
        ))))
    })
    .await;
    assert_eq!(
        c.probe("http://idp.example.test", None).await["error"],
        "http needs a private address"
    );
}

#[sqlx::test(migrations = false)]
async fn a_private_ca_is_trusted_only_when_the_provider_carries_it(pool: PgPool) {
    let c = ctx(pool).await;
    let pki = tls::pki(&["127.0.0.1"]);
    let port: Arc<Mutex<u16>> = Arc::default();
    let p = port.clone();
    let reply: tls::Reply = Arc::new(move |_| {
        let base = format!("https://127.0.0.1:{}", p.lock().unwrap());
        let doc = json!({"issuer": base, "authorization_endpoint": format!("{base}/a"),
            "token_endpoint": format!("{base}/t"), "jwks_uri": format!("{base}/k"),
            "code_challenge_methods_supported": ["S256"]});
        (
            200,
            vec![("content-type".into(), "application/json".into())],
            doc.to_string().into_bytes(),
        )
    });
    let (stub_port, _) = tls::stub(pki.server.clone(), reply).await;
    *port.lock().unwrap() = stub_port;
    let issuer = format!("https://127.0.0.1:{stub_port}");
    assert_eq!(c.probe(&issuer, None).await["error"], "network error");
    let b = c.probe(&issuer, Some(&pki.ca_pem)).await;
    assert_eq!(
        (b["ok"].clone(), b["pkce"].clone()),
        (json!(true), json!(true))
    );
    let (s, _, e) = c
        .try_provider(json!({"issuer": issuer, "caPem": "not a pem"}))
        .await;
    assert_eq!(s, 400, "{e}");
}

#[sqlx::test(migrations = false)]
async fn password_login_can_be_limited_to_admins(pool: PgPool) {
    let c = ctx(pool).await;
    assert_eq!(
        c.setting("password_login", "admins").await.0,
        409,
        "no provider yet"
    );
    let pid = c.provider(json!({})).await;
    assert_eq!(c.setting("password_login", "nobody").await.0, 400);
    assert_eq!(c.setting("password_login", "admins").await.0, 200);
    c.pw_user("bob", false).await;
    c.pw_user("alice", true).await;
    let (s, _, e) = c.password_login("bob", "bob-pass").await;
    assert_eq!(
        (s, e["message"].clone()),
        (401, json!("Password login is disabled"))
    );
    let (s, _, e) = c.password_login("bob", "wrong").await;
    assert_eq!(
        (s, e["message"].clone()),
        (401, json!("Invalid credentials"))
    );
    assert_eq!(c.password_login("alice", "alice-pass").await.0, 201);
    let (_, _, info) = c.call("GET", "/api/auth/oidc", None, None).await;
    assert_eq!(info["passwordLogin"], "admins");

    let off = c
        .admin(
            "PUT",
            &format!("/api/oidc-providers/{pid}"),
            Some(c.body(json!({"enabled": false}))),
        )
        .await;
    assert_eq!(off.0, 409);
    assert_eq!(
        c.admin("DELETE", &format!("/api/oidc-providers/{pid}"), None)
            .await
            .0,
        409
    );
    assert_eq!(c.setting("password_login", "everyone").await.0, 200);
    assert_eq!(
        c.admin("DELETE", &format!("/api/oidc-providers/{pid}"), None)
            .await
            .0,
        204
    );
    assert_eq!(c.password_login("bob", "bob-pass").await.0, 201);
}

#[sqlx::test(migrations = false)]
async fn auto_launch_names_an_enabled_provider(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, _, none) = c.call("GET", "/api/auth/oidc", None, None).await;
    assert_eq!(
        none,
        json!({"providers": [], "autoLaunch": null, "passwordLogin": "everyone", "origin": PUBLIC})
    );
    let a = c.provider(json!({"name": "A"})).await;
    let off = c.provider(json!({"name": "Off", "enabled": false})).await;
    let b = c.provider(json!({"name": "B"})).await;
    assert_eq!(c.setting("oidc_auto_launch", &off.to_string()).await.0, 400);
    assert_eq!(c.setting("oidc_auto_launch", "999").await.0, 400);
    assert_eq!(c.setting("oidc_auto_launch", &b.to_string()).await.0, 200);
    let (_, _, info) = c.call("GET", "/api/auth/oidc", None, None).await;
    assert_eq!(
        info["providers"],
        json!([{"id": a, "name": "A"}, {"id": b, "name": "B"}])
    );
    assert_eq!(info["autoLaunch"], b);
    assert_eq!(c.setting("oidc_auto_launch", "").await.0, 200);
}

#[sqlx::test(migrations = false)]
async fn only_an_admin_manages_providers_and_the_sso_settings(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    let role = c
        .role("Settings", r#"["settings.access"]"#, false, &[])
        .await;
    let id = c.user("ops", None, false).await;
    sqlx::query(r#"UPDATE users SET "roleId" = $2 WHERE id = $1"#)
        .bind(id)
        .bind(role)
        .execute(&c.pool)
        .await
        .unwrap();
    let t = c.token_of(id, "ops").await;
    let call = |m: &'static str, u: String, b: Option<Value>| {
        let t = t.clone();
        let c = &c;
        async move { c.call(m, &u, Some(&t), b).await.0 }
    };
    assert_eq!(call("GET", "/api/oidc-providers".into(), None).await, 403);
    assert_eq!(
        call(
            "POST",
            "/api/oidc-providers".into(),
            Some(c.body(json!({})))
        )
        .await,
        403
    );
    assert_eq!(
        call(
            "PUT",
            format!("/api/oidc-providers/{pid}"),
            Some(c.body(json!({})))
        )
        .await,
        403
    );
    assert_eq!(
        call("DELETE", format!("/api/oidc-providers/{pid}"), None).await,
        403
    );
    assert_eq!(
        call(
            "POST",
            "/api/oidc-providers/test".into(),
            Some(json!({"issuer": c.idp.base}))
        )
        .await,
        403
    );
    assert_eq!(
        call(
            "PUT",
            "/api/settings/password_login".into(),
            Some(json!({"value": "everyone"}))
        )
        .await,
        403
    );
    assert_eq!(
        call(
            "PUT",
            "/api/settings/oidc_auto_launch".into(),
            Some(json!({"value": ""}))
        )
        .await,
        403
    );
    assert_eq!(
        call(
            "PUT",
            "/api/settings".into(),
            Some(json!({"data": {"password_login": "everyone"}}))
        )
        .await,
        403
    );
    assert_eq!(
        call(
            "PUT",
            "/api/settings/users_public_mode".into(),
            Some(json!({"value": "lan"}))
        )
        .await,
        200
    );
}

#[sqlx::test(migrations = false)]
async fn providers_never_return_the_secret_and_keep_it_on_a_blank_write(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, _, b) = c.try_provider(json!({})).await;
    assert_eq!(s, 201);
    assert_eq!(b["clientSecretSet"], true);
    assert!(b.get("clientSecret").is_none());
    let pid = b["id"].as_i64().unwrap();
    let secret = || async {
        sqlx::query_scalar::<_, Option<String>>(r#"SELECT "clientSecret" FROM oidc_providers"#)
            .fetch_one(&c.pool)
            .await
            .unwrap()
    };
    assert_eq!(
        c.put_provider(pid, json!({"clientSecret": "", "name": "Renamed"}))
            .await
            .2["name"],
        "Renamed"
    );
    assert_eq!(secret().await.as_deref(), Some(CLIENT_SECRET));
    c.put_provider(pid, json!({"clientSecret": "rotated"}))
        .await;
    assert_eq!(secret().await.as_deref(), Some("rotated"));
    let (_, _, list) = c.admin("GET", "/api/oidc-providers", None).await;
    assert!(!list.to_string().contains("rotated"));
    let moved = c
        .put_provider(pid, json!({"issuer": "https://other.test", "position": 7}))
        .await
        .2;
    assert_eq!(
        (moved["issuer"].clone(), moved["position"].clone()),
        (json!(c.idp.base), json!(7))
    );
}

#[sqlx::test(migrations = false)]
async fn provider_input_is_validated(pool: PgPool) {
    let c = ctx(pool).await;
    let role = c.role("R", "[]", false, &[]).await;
    for bad in [
        json!({"name": ""}),
        json!({"issuer": "ftp://x"}),
        json!({"prompt": "always"}),
        json!({"scope": "profile"}),
        json!({"accountUrl": "javascript:1"}),
        json!({"allowedGroups": ["a"]}),
        json!({"groupsClaim": "g", "roleMappings": [{"group": "a", "roleId": 9999}]}),
        json!({"groupsClaim": "g", "roleMappings": [{"group": "a", "roleId": role}, {"group": "a", "roleId": role}]}),
        json!({"surprise": 1}),
    ] {
        assert_eq!(c.try_provider(bad.clone()).await.0, 400, "{bad}");
    }
    let (s, _, b) = c.try_provider(json!({"groupsClaim": "realm_access.roles", "roleMappings": [{"group": "a", "roleId": role}]})).await;
    assert_eq!(
        (s, b["roleMappings"].clone()),
        (201, json!([{"group": "a", "roleId": role}]))
    );
}

#[sqlx::test(migrations = false)]
async fn updating_a_provider_drops_its_cached_discovery(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    c.begin(pid).await;
    c.begin(pid).await;
    let cached = c.idp.st.discovery_hits.load(Ordering::SeqCst);
    c.begin(pid).await;
    assert_eq!(c.idp.st.discovery_hits.load(Ordering::SeqCst), cached);
    c.admin(
        "PUT",
        &format!("/api/oidc-providers/{pid}"),
        Some(c.body(json!({"name": "New"}))),
    )
    .await;
    c.begin(pid).await;
    assert_eq!(c.idp.st.discovery_hits.load(Ordering::SeqCst), cached + 1);
}

#[sqlx::test(migrations = false)]
async fn the_admin_user_shows_identities_and_managed_access(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c
        .provider(json!({"groupsClaim": "groups", "adminGroups": ["admins"]}))
        .await;
    let (_, _, b) = c.login(pid, json!({"groups": []})).await;
    let id = b["user"]["id"].as_i64().unwrap();
    let (s, _, u) = c.admin("GET", &format!("/api/users/{id}"), None).await;
    assert_eq!(s, 200);
    assert_eq!(
        (
            u["identities"].clone(),
            u["accessManagedBy"].clone(),
            u["hasPassword"].clone()
        ),
        (
            json!([{"providerId": pid, "name": "Fake"}]),
            json!(pid),
            json!(false)
        )
    );
    let (s, _, made) = c
        .admin(
            "POST",
            "/api/users",
            Some(json!({"username": "sso-only", "email": "x@example.test"})),
        )
        .await;
    assert_eq!((s, made["hasPassword"].clone()), (201, json!(false)));
    let (s, _, _) = c
        .admin(
            "POST",
            "/api/users",
            Some(json!({"username": "short", "password": "x"})),
        )
        .await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn end_session_builds_the_providers_logout_url(pool: PgPool) {
    let c = ctx(pool).await;
    let with = c.provider(json!({"endSessionAtProvider": true})).await;
    let (_, _, b) = c.login(with, json!({})).await;
    let (s, _, e) = c
        .call(
            "POST",
            "/api/auth/oidc/end-session",
            Some(&access(&b)),
            None,
        )
        .await;
    assert_eq!(s, 200);
    let url = reqwest::Url::parse(e["url"].as_str().unwrap()).unwrap();
    let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(
        format!("{}{}", url.origin().ascii_serialization(), url.path()),
        format!("{}/logout", c.idp.base)
    );
    assert_eq!(q["client_id"], CLIENT_ID);
    assert_eq!(
        q["post_logout_redirect_uri"],
        format!("{PUBLIC}/login?autoLaunch=0")
    );
    assert!(q["id_token_hint"].split('.').count() == 3 && q.contains_key("state"));

    let without = c.provider(json!({"name": "Plain"})).await;
    let (_, _, b2) = c.login(without, json!({"sub": "sub-2"})).await;
    assert_eq!(
        c.call(
            "POST",
            "/api/auth/oidc/end-session",
            Some(&access(&b2)),
            None
        )
        .await
        .0,
        204
    );
    let pw = c.pw_user("bob", false).await;
    let t = c.token_of(pw, "bob").await;
    assert_eq!(
        c.call("POST", "/api/auth/oidc/end-session", Some(&t), None)
            .await
            .0,
        204
    );
}

impl Ctx {
    async fn bcl(&self, pid: i32, token: &str) -> Res {
        self.form(
            &format!("/api/auth/oidc/{pid}/backchannel-logout"),
            format!("logout_token={token}"),
        )
        .await
    }
}

#[sqlx::test(migrations = false)]
async fn a_back_channel_logout_revokes_by_sid_then_by_sub(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    let (_, _, b) = c.login(pid, json!({"sid": "idp-sid-1"})).await;
    let (_, _, other) = c.login(pid, json!({"sid": "idp-sid-2"})).await;
    assert_eq!(c.me(&b).await.0, 200);
    let (s, h, _) = c
        .bcl(pid, &c.idp.logout_token(json!({}), Signing::Key(0)))
        .await;
    assert_eq!((s, h["cache-control"].to_str().unwrap()), (200, "no-store"));
    assert_eq!(c.me(&b).await.0, 401, "cut at once");
    assert_eq!(c.me(&other).await.0, 200, "another sid is untouched");
    let (s, _, e) = c
        .call("POST", "/api/auth/refresh", None, Some(refreshed(&b)))
        .await;
    assert_eq!(
        (s, e["message"].clone()),
        (401, json!("Invalid refresh token"))
    );

    let t = c
        .idp
        .logout_token(json!({"sid": null, "sub": "sub-1"}), Signing::Key(0));
    assert_eq!(c.bcl(pid, &t).await.0, 200);
    assert_eq!(c.me(&other).await.0, 401, "by subject");
}

#[sqlx::test(migrations = false)]
async fn a_bad_logout_token_is_refused_and_revokes_nothing(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    let (_, _, b) = c.login(pid, json!({"sid": "idp-sid-1"})).await;
    let cases: Vec<(&str, Value, Signing)> = vec![
        ("no exp", json!({"exp": null}), Signing::Key(0)),
        ("expired", json!({"exp": now() - 3600}), Signing::Key(0)),
        ("no jti", json!({"jti": null}), Signing::Key(0)),
        ("no iat", json!({"iat": null}), Signing::Key(0)),
        ("wrong event", json!({"events": {"x": {}}}), Signing::Key(0)),
        ("nonce", json!({"nonce": "n"}), Signing::Key(0)),
        ("no sid or sub", json!({"sid": null}), Signing::Key(0)),
        (
            "wrong iss",
            json!({"iss": "https://evil.test"}),
            Signing::Key(0),
        ),
        ("wrong aud", json!({"aud": "other"}), Signing::Key(0)),
        ("bad signature", json!({}), Signing::Foreign),
        ("alg none", json!({}), Signing::None),
    ];
    for (name, patch, how) in cases {
        let r = c.bcl(pid, &c.idp.logout_token(patch, how)).await;
        assert_eq!(r.0, 400, "{name}");
    }
    assert_eq!(
        c.form(
            &format!("/api/auth/oidc/{pid}/backchannel-logout"),
            "x=1".into()
        )
        .await
        .0,
        400
    );
    assert_eq!(
        c.call("GET", "/api/auth/me", Some(&access(&b)), None)
            .await
            .0,
        200
    );
}

#[sqlx::test(migrations = false)]
async fn disabling_or_deleting_a_provider_signs_its_users_out(pool: PgPool) {
    let c = ctx(pool).await;
    let (p1, p2) = (
        c.provider(json!({})).await,
        c.provider(json!({"name": "B"})).await,
    );
    let (_, _, a) = c.login(p1, json!({})).await;
    let (_, _, b) = c
        .login(p2, json!({"sub": "sub-2", "preferred_username": "bea"}))
        .await;
    let off = c
        .admin(
            "PUT",
            &format!("/api/oidc-providers/{p1}"),
            Some(c.body(json!({"enabled": false}))),
        )
        .await;
    assert_eq!(off.0, 200);
    assert_eq!(c.me(&a).await.0, 401);
    assert_eq!(
        c.call("POST", "/api/auth/refresh", None, Some(refreshed(&a)))
            .await
            .0,
        401
    );
    assert_eq!(c.me(&b).await.0, 200);
    assert_eq!(
        c.admin("DELETE", &format!("/api/oidc-providers/{p2}"), None)
            .await
            .0,
        204
    );
    assert_eq!(c.me(&b).await.0, 401);
    let left: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM user_identities WHERE "providerId" = $1"#)
            .bind(p2)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(left, 0);
    let users: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users WHERE username IN ('ann', 'bea')")
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(users, 2, "the accounts stay");
}

#[sqlx::test(migrations = false)]
async fn an_oidc_session_cannot_refresh_after_thirty_days(pool: PgPool) {
    let c = ctx(pool).await;
    let pid = c.provider(json!({})).await;
    let (_, _, b) = c.login(pid, json!({})).await;
    let bob = c.pw_user("bob", false).await;
    let (_, _, p) = c.password_login("bob", "bob-pass").await;
    sqlx::query(
        r#"UPDATE sessions SET "createdAt" = now() - interval '31 days' WHERE "userId" <> 0"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let (s, _, e) = c
        .call("POST", "/api/auth/refresh", None, Some(refreshed(&b)))
        .await;
    assert_eq!(
        (s, e["message"].clone()),
        (401, json!("Refresh token expired"))
    );
    assert_eq!(
        c.call("POST", "/api/auth/refresh", None, Some(refreshed(&p)))
            .await
            .0,
        201,
        "a password session has no cap"
    );
    let _ = bob;
}

async fn role_of(c: &Ctx, id: i32) -> (Option<i32>, bool) {
    sqlx::query_as(r#"SELECT "roleId", "isAdmin" FROM users WHERE id = $1"#)
        .bind(id)
        .fetch_one(&c.pool)
        .await
        .unwrap()
}

impl Ctx {
    async fn me(&self, b: &Value) -> Res {
        self.call("GET", "/api/auth/me", Some(&access(b)), None)
            .await
    }

    async fn put_provider(&self, pid: i64, patch: Value) -> Res {
        self.admin(
            "PUT",
            &format!("/api/oidc-providers/{pid}"),
            Some(self.body(patch)),
        )
        .await
    }
}

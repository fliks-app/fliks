//! Extractor behaviour (`docs/spec/auth.md` section B) through a real router on a fresh database.
use axum::{Router, body::Body, extract::State, http::Request, routing::get};
use fliks_domain::acl::{Action, Subject};
use fliks_server::{
    config::Config,
    http::auth::{Authed, OptionalAuthed, SessionAuthed, StreamAuthed, logout_token},
    state::AppState,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

async fn state(pool: PgPool) -> AppState {
    fliks_server::db::migrate(&pool).await.unwrap();
    AppState::new(pool, Config::from_lookup(|_| None), SECRET)
}

fn app(st: &AppState) -> Router {
    async fn who(a: Authed) -> String {
        a.user.id.to_string()
    }
    async fn stream(StreamAuthed(a): StreamAuthed) -> String {
        format!("{}:{}", a.user.id, a.scope.is_some())
    }
    async fn session(SessionAuthed(a): SessionAuthed) -> String {
        a.user.id.to_string()
    }
    async fn optional(OptionalAuthed(a): OptionalAuthed) -> String {
        a.map_or("anon".into(), |a| a.user.id.to_string())
    }
    async fn users_manage(a: Authed) -> Result<&'static str, fliks_server::http::AppError> {
        a.require(Action::Manage, Subject::User)?;
        Ok("ok")
    }
    async fn raw(State(_): State<AppState>) -> &'static str {
        "ok"
    }
    Router::new()
        .route("/who", get(who))
        .route("/stream", get(stream))
        .route("/session", get(session))
        .route("/optional", get(optional))
        .route("/users", get(users_manage))
        .route("/raw", get(raw))
        .with_state(st.clone())
}

async fn user(pool: &PgPool, name: &str, role: Option<&str>, admin: bool, enabled: bool) -> i32 {
    let role_id: Option<i32> = match role {
        None => None,
        Some(perms) => Some(
            sqlx::query_scalar(
                r#"INSERT INTO roles (name, permissions) VALUES ($1, $2) RETURNING id"#,
            )
            .bind(format!("role-{name}"))
            .bind(perms)
            .fetch_one(pool)
            .await
            .unwrap(),
        ),
    };
    sqlx::query_scalar(
        r#"INSERT INTO users (username, "roleId", "isAdmin", enabled) VALUES ($1, $2, $3, $4) RETURNING id"#,
    )
    .bind(name)
    .bind(role_id)
    .bind(admin)
    .bind(enabled)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn get_with(app: &Router, uri: &str, headers: &[(&str, &str)]) -> (u16, String) {
    let mut req = Request::get(uri);
    for (k, v) in headers {
        req = req.header(*k, *v);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

fn unauthorized() -> Value {
    json!({"statusCode": 401, "message": "Unauthorized"})
}

fn cookie(t: &str) -> String {
    format!("fliks_access={t}")
}

fn bearer(t: &str) -> String {
    format!("Bearer {t}")
}

#[sqlx::test(migrations = false)]
async fn token_sources_and_precedence(pool: PgPool) {
    let st = state(pool.clone()).await;
    let (a, b) = (
        user(&pool, "a", None, false, true).await,
        user(&pool, "b", None, false, true).await,
    );
    let ta = st.jwt.sign_access(a, "a").unwrap().token;
    let tb = st.jwt.sign_access(b, "b").unwrap().token;
    let app = app(&st);
    let ok = |id: i32| (200, id.to_string());

    assert_eq!(
        get_with(&app, "/who", &[("cookie", &cookie(&ta))]).await,
        ok(a)
    );
    assert_eq!(
        get_with(&app, "/who", &[("authorization", &bearer(&ta))]).await,
        ok(a)
    );
    assert_eq!(
        get_with(
            &app,
            "/who",
            &[("authorization", &format!("bEaReR   {ta} junk"))]
        )
        .await,
        ok(a)
    );
    assert_eq!(
        get_with(&app, &format!("/who?x=1&token={ta}"), &[]).await,
        ok(a)
    );
    // cookie beats Bearer beats query
    let both = [("cookie", cookie(&ta)), ("authorization", bearer(&tb))];
    let both: Vec<_> = both.iter().map(|(k, v)| (*k, v.as_str())).collect();
    assert_eq!(
        get_with(&app, &format!("/who?token={tb}"), &both).await,
        ok(a)
    );
    assert_eq!(
        get_with(
            &app,
            &format!("/who?token={ta}"),
            &[("authorization", &bearer(&tb))]
        )
        .await,
        ok(b)
    );
    // a stale cookie shadows a valid Bearer (no fall-through on a bad token)
    let (s, body) = get_with(
        &app,
        "/who",
        &[
            ("cookie", &cookie("garbage")),
            ("authorization", &bearer(&ta)),
        ],
    )
    .await;
    assert_eq!(
        (s, serde_json::from_str::<Value>(&body).unwrap()),
        (401, unauthorized())
    );
    // an empty value counts as absent
    assert_eq!(
        get_with(
            &app,
            "/who",
            &[("cookie", "fliks_access="), ("authorization", &bearer(&ta))]
        )
        .await,
        ok(a)
    );
    assert_eq!(
        get_with(
            &app,
            &format!("/who?token={ta}"),
            &[("cookie", "fliks_access=")]
        )
        .await,
        ok(a)
    );
    assert_eq!(get_with(&app, "/who?token=", &[]).await.0, 401);
    // no usable credential at all
    for h in [
        vec![],
        vec![("authorization", "Bearer")],
        vec![("authorization", "Basic abc")],
        vec![("authorization", "Token x y")],
    ] {
        let (s, body) = get_with(&app, "/who", &h).await;
        assert_eq!(
            (s, serde_json::from_str::<Value>(&body).unwrap()),
            (401, unauthorized()),
            "{h:?}"
        );
    }
}

#[sqlx::test(migrations = false)]
async fn token_and_user_validation(pool: PgPool) {
    let st = state(pool.clone()).await;
    let id = user(&pool, "a", None, false, true).await;
    let off = user(&pool, "off", None, false, false).await;
    let app = app(&st);
    let get = |t: String| {
        let app = app.clone();
        async move {
            get_with(&app, "/who", &[("authorization", &bearer(&t))])
                .await
                .0
        }
    };
    assert_eq!(get(st.jwt.sign_access(id, "a").unwrap().token).await, 200);
    assert_eq!(
        get(st.jwt.sign_access(id, "renamed").unwrap().token).await,
        200
    );
    assert_eq!(
        get(st.jwt.sign_access(off, "off").unwrap().token).await,
        401
    );
    assert_eq!(
        get(st.jwt.sign_access(id + 1000, "ghost").unwrap().token).await,
        401
    );
    let other = fliks_server::auth_token::Jwt::new("another secret", 3600, 3600);
    assert_eq!(get(other.sign_access(id, "a").unwrap().token).await, 401);
    let expired = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::HS256),
        &json!({"sub": id, "exp": chrono::Utc::now().timestamp() - 5}),
        &jsonwebtoken::EncodingKey::from_secret(SECRET.as_bytes()),
    )
    .unwrap();
    assert_eq!(get(expired).await, 401);
    // disabling or deleting applies on the next request
    let t = st.jwt.sign_access(id, "a").unwrap().token;
    assert_eq!(get(t.clone()).await, 200);
    sqlx::query(r#"UPDATE users SET enabled = false WHERE id = $1"#)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(get(t.clone()).await, 401);
    sqlx::query(r#"UPDATE users SET enabled = true WHERE id = $1"#)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(get(t.clone()).await, 200);
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(get(t).await, 401);
}

#[sqlx::test(migrations = false)]
async fn a_live_token_is_refused_by_every_extractor(pool: PgPool) {
    let st = state(pool.clone()).await;
    let id = user(&pool, "a", None, false, true).await;
    let app = app(&st);
    let live = st.jwt.sign_live(id, "a", "sid-1").unwrap().token;
    assert_eq!(st.jwt.verify(&live).unwrap().live.as_deref(), Some("sid-1"));
    for uri in ["/who", "/stream", "/session", "/optional"] {
        let (s, _) = get_with(&app, uri, &[("authorization", &bearer(&live))]).await;
        assert_eq!(s, 401, "{uri}");
    }
    assert_eq!(
        get_with(&app, &format!("/stream?token={live}"), &[])
            .await
            .0,
        401
    );
}

#[sqlx::test(migrations = false)]
async fn scoped_tokens_by_extractor(pool: PgPool) {
    let st = state(pool.clone()).await;
    let id = user(&pool, "a", None, false, true).await;
    let app = app(&st);
    let full = st.jwt.sign_access(id, "a").unwrap().token;
    let scoped = st.jwt.sign_stream(id, "a").unwrap().token;
    let call = |uri: &'static str, t: &str| {
        let (app, t) = (app.clone(), bearer(t));
        async move { get_with(&app, uri, &[("authorization", &t)]).await }
    };
    // plain Authed refuses a stream token, StreamAuthed takes it, Session answers a 403
    let (s, body) = call("/who", &scoped).await;
    assert_eq!(
        (s, serde_json::from_str::<Value>(&body).unwrap()),
        (401, unauthorized())
    );
    assert_eq!(call("/stream", &scoped).await, (200, format!("{id}:true")));
    assert_eq!(call("/stream", &full).await, (200, format!("{id}:false")));
    let (s, body) = call("/session", &scoped).await;
    assert_eq!(
        (s, serde_json::from_str::<Value>(&body).unwrap()),
        (
            403,
            json!({"statusCode": 403, "message": "session_token_required", "error": "Forbidden"})
        )
    );
    assert_eq!(call("/session", &full).await.0, 200);
    assert_eq!(call("/optional", &scoped).await.0, 401);
    // via query too, since that is where players put it
    assert_eq!(
        get_with(&app, &format!("/stream?token={scoped}"), &[])
            .await
            .0,
        200
    );
    assert_eq!(
        get_with(&app, &format!("/who?token={scoped}"), &[]).await.0,
        401
    );
}

#[sqlx::test(migrations = false)]
async fn optional_is_anonymous_only_without_credentials(pool: PgPool) {
    let st = state(pool.clone()).await;
    let id = user(&pool, "a", None, false, true).await;
    let app = app(&st);
    assert_eq!(get_with(&app, "/optional", &[]).await, (200, "anon".into()));
    let t = st.jwt.sign_access(id, "a").unwrap().token;
    assert_eq!(
        get_with(&app, "/optional", &[("authorization", &bearer(&t))]).await,
        (200, id.to_string())
    );
    assert_eq!(
        get_with(&app, "/optional", &[("authorization", "Bearer nope")])
            .await
            .0,
        401
    );
}

#[sqlx::test(migrations = false)]
async fn permissions_follow_role_admin_flag_and_missing_role(pool: PgPool) {
    let st = state(pool.clone()).await;
    let manager = user(&pool, "mgr", Some(r#"["users.manage"]"#), false, true).await;
    let plain = user(&pool, "plain", Some(r#"["media.read"]"#), false, true).await;
    let norole = user(&pool, "norole", None, false, true).await;
    let admin = user(&pool, "admin", Some("[]"), true, true).await;
    let broken = user(&pool, "broken", Some("not json"), false, true).await;
    let app = app(&st);
    for (id, want) in [
        (manager, 200),
        (plain, 403),
        (norole, 403),
        (admin, 200),
        (broken, 403),
    ] {
        let t = st.jwt.sign_access(id, "x").unwrap().token;
        let (s, body) = get_with(&app, "/users", &[("authorization", &bearer(&t))]).await;
        assert_eq!(s, want, "user {id}");
        if want == 403 {
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({"statusCode": 403, "message": "Forbidden resource", "error": "Forbidden"})
            );
        }
    }
    // a role change applies on the next request
    let t = st.jwt.sign_access(plain, "plain").unwrap().token;
    sqlx::query(r#"UPDATE roles SET permissions = '["users.manage"]' WHERE name = 'role-plain'"#)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        get_with(&app, "/users", &[("authorization", &bearer(&t))])
            .await
            .0,
        200
    );
}

#[sqlx::test(migrations = false)]
async fn loaded_rows_carry_role_and_columns(pool: PgPool) {
    let st = state(pool.clone()).await;
    let id = user(&pool, "ana", Some(r#"["media.read","bogus"]"#), false, true).await;
    let (u, r) = fliks_server::http::auth::load_enabled(&st.db, id)
        .await
        .unwrap()
        .unwrap();
    let r = r.unwrap();
    assert_eq!(
        (
            u.username.as_str(),
            u.media_server_type.as_str(),
            u.profile_visibility.as_str()
        ),
        ("ana", "local", "private")
    );
    assert_eq!(
        (
            u.library_order.0.clone(),
            u.quota_period_days,
            u.edl_enabled,
            u.share_likes
        ),
        (vec![], 7, true, false)
    );
    assert_eq!(
        (r.name.as_str(), r.permissions),
        (
            "role-ana",
            vec!["media.read".to_owned(), "bogus".to_owned()]
        )
    );
    let v = serde_json::to_value(&u).unwrap();
    assert!(v.get("passwordHash").is_none());
    assert_eq!(v["lastLogin"], Value::Null);
    assert!(v["createdAt"].as_str().unwrap().ends_with('Z'));
}

#[test]
fn logout_token_keeps_an_empty_cookie_and_ignores_the_query() {
    use axum::http::{HeaderMap, HeaderValue};
    let h = |pairs: &[(&'static str, &str)]| {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.append(*k, HeaderValue::from_str(v).unwrap());
        }
        m
    };
    assert_eq!(
        logout_token(&h(&[("cookie", "fliks_access=abc")])).as_deref(),
        Some("abc")
    );
    assert_eq!(
        logout_token(&h(&[
            ("cookie", "fliks_access="),
            ("authorization", "Bearer x")
        ]))
        .as_deref(),
        Some("")
    );
    assert_eq!(
        logout_token(&h(&[("authorization", "Bearer x")])).as_deref(),
        Some("x")
    );
    assert_eq!(logout_token(&h(&[("authorization", "bearer x")])), None);
    assert_eq!(logout_token(&h(&[])), None);
}

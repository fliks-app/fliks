//! `/api/users/*` authorisation, and side effects on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, state::AppState, users};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    Ctx {
        app: users::router().with_state(st.clone()),
        st,
        pool,
    }
}

impl Ctx {
    async fn user(&self, name: &str, perms: &str, admin: bool) -> (i32, String) {
        let role: i32 = sqlx::query_scalar(
            r#"INSERT INTO roles (name, permissions) VALUES ($1, $2) RETURNING id"#,
        )
        .bind(format!("role-{name}"))
        .bind(perms)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "roleId", "isAdmin") VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(role)
        .bind(admin)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        (id, self.st.jwt.sign_access(id, name).unwrap().token)
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
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
        let res = self
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

    async fn column<T>(&self, id: i32, col: &str) -> T
    where
        T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin,
    {
        sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
            r#"SELECT "{col}" FROM users WHERE id = $1"#
        )))
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }
}

async fn put(c: &Ctx, t: &str, id: i32, body: Value) -> (u16, Value) {
    c.call("PUT", &format!("/api/users/{id}"), t, Some(body))
        .await
}

fn bare_403() -> Value {
    json!({"statusCode": 403, "message": "Forbidden"})
}

#[sqlx::test(migrations = false)]
async fn self_and_other_access(pool: PgPool) {
    let c = ctx(pool).await;
    let (a, ta) = c.user("a", "[]", false).await;
    let (b, _) = c.user("b", "[]", false).await;
    let (_, tm) = c.user("m", r#"["users.manage"]"#, false).await;

    assert_eq!(
        c.call("GET", &format!("/api/users/{a}"), &ta, None).await.0,
        200
    );
    assert_eq!(
        c.call("GET", &format!("/api/users/{b}"), &ta, None).await.1,
        bare_403()
    );
    assert_eq!(
        c.call("GET", &format!("/api/users/{b}"), &tm, None).await.0,
        200
    );
    assert_eq!(c.call("GET", "/api/users", &ta, None).await.0, 403);
    assert_eq!(c.call("GET", "/api/users", &tm, None).await.0, 200);
    assert_eq!(c.call("GET", "/api/users/me", &tm, None).await.0, 400);
    assert_eq!(c.call("GET", "/api/users/007", &tm, None).await.0, 400);
    assert_eq!(c.call("GET", "/api/users/9999", &tm, None).await.0, 404);
    assert_eq!(
        c.call("DELETE", &format!("/api/users/{b}"), &ta, None)
            .await
            .0,
        403
    );
    assert_eq!(
        put(&c, &ta, b, json!({"username": "x"})).await.1,
        bare_403()
    );
}

#[sqlx::test(migrations = false)]
async fn self_update_rules(pool: PgPool) {
    let c = ctx(pool).await;
    let (a, ta) = c.user("a", "[]", false).await;

    let (s, b) = put(
        &c,
        &ta,
        a,
        json!({"hideSpoilers": true, "libraryOrder": [3, 1]}),
    )
    .await;
    assert_eq!(
        (s, &b["hideSpoilers"], &b["libraryOrder"]),
        (200, &json!(true), &json!([3, 1]))
    );
    let (s, b) = put(&c, &ta, a, json!({"enabled": true})).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (
            403,
            Some("Only users with users.manage permission can change role or enabled status")
        )
    );
    assert_eq!(
        put(&c, &ta, a, json!({"movieQuotaLimit": 5})).await.1,
        bare_403()
    );
    // Rejected before any write
    let (s, _) = put(
        &c,
        &ta,
        a,
        json!({"hideSpoilers": false, "libraryIds": [1]}),
    )
    .await;
    assert_eq!(s, 403);
    assert!(c.column::<bool>(a, "hideSpoilers").await);
    // Validation
    assert_eq!(
        put(&c, &ta, a, json!({"username": null})).await.1["message"],
        json!(["username must be a string"])
    );
    assert_eq!(put(&c, &ta, a, json!({"shareLikes": null})).await.0, 400);
    assert_eq!(put(&c, &ta, a, json!({"nope": 1})).await.0, 400);
    assert_eq!(put(&c, &ta, a, json!({"email": "bad"})).await.0, 400);
    assert_eq!(put(&c, &ta, a, json!({"password": "short"})).await.0, 400);
    assert_eq!(put(&c, &ta, a, json!({"email": null})).await.0, 200);
}

#[sqlx::test(migrations = false)]
async fn a_quota_period_below_one_day_is_refused(pool: PgPool) {
    let c = ctx(pool).await;
    let (admin, t) = c.user("admin", "[]", true).await;
    for days in [-1, 0] {
        let (s, _) = put(&c, &t, admin, json!({"quotaPeriodDays": days})).await;
        assert_eq!(s, 400, "{days}");
    }
    assert_eq!(
        put(&c, &t, admin, json!({"quotaPeriodDays": 1})).await.0,
        200
    );
    assert_eq!(c.column::<i32>(admin, "quotaPeriodDays").await, 1);
}

#[sqlx::test(migrations = false)]
async fn quota_limits_are_rows_per_kind_and_zero_clears_one(pool: PgPool) {
    let c = ctx(pool).await;
    let (admin, t) = c.user("admin", "[]", true).await;
    let rows = || async {
        sqlx::query_as::<_, (String, i32)>(
            r#"SELECT kind, "limit" FROM user_quotas WHERE "userId" = $1 ORDER BY kind"#,
        )
        .bind(admin)
        .fetch_all(&c.pool)
        .await
        .unwrap()
    };
    let (s, b) = put(
        &c,
        &t,
        admin,
        json!({"movieQuotaLimit": 3, "seriesQuotaLimit": 2}),
    )
    .await;
    assert_eq!(
        (s, &b["movieQuotaLimit"], &b["seriesQuotaLimit"]),
        (200, &json!(3), &json!(2))
    );
    assert_eq!(rows().await, [("movie".into(), 3), ("series".into(), 2)]);
    let (_, b) = put(&c, &t, admin, json!({"movieQuotaLimit": 0})).await;
    assert_eq!(
        (&b["movieQuotaLimit"], &b["seriesQuotaLimit"]),
        (&json!(0), &json!(2))
    );
    assert_eq!(rows().await, [("series".into(), 2)]);
    assert_eq!(
        put(&c, &t, admin, json!({"seriesQuotaLimit": -1})).await.0,
        400
    );
    let (_, me) = c
        .call("GET", &format!("/api/users/{admin}"), &t, None)
        .await;
    assert_eq!(
        (&me["movieQuotaLimit"], &me["seriesQuotaLimit"]),
        (&json!(0), &json!(2))
    );
}

#[sqlx::test(migrations = false)]
async fn admin_guards(pool: PgPool) {
    let c = ctx(pool).await;
    let (admin, tadmin) = c.user("admin", "[]", true).await;
    let (_, tm) = c
        .user("m", r#"["users.manage","roles.manage"]"#, false)
        .await;
    let (n, _) = c.user("n", "[]", false).await;

    assert_eq!(
        put(&c, &tm, admin, json!({"username": "x"})).await.1,
        bare_403()
    );
    assert_eq!(
        c.call("DELETE", &format!("/api/users/{admin}"), &tm, None)
            .await
            .1,
        bare_403()
    );
    assert_eq!(
        put(&c, &tm, n, json!({"isAdmin": true})).await.1,
        bare_403()
    );
    let create = json!({"username": "z", "password": "longenough", "isAdmin": true});
    assert_eq!(
        c.call("POST", "/api/users", &tm, Some(create.clone()))
            .await
            .1,
        bare_403()
    );
    assert_eq!(
        c.call("POST", "/api/users", &tadmin, Some(create)).await.0,
        201
    );

    // two admins: demoting one is fine, the last enabled one is protected
    assert_eq!(put(&c, &tadmin, n, json!({"isAdmin": true})).await.0, 200);
    assert_eq!(put(&c, &tadmin, n, json!({"isAdmin": false})).await.0, 200);
    let z: i32 = sqlx::query_scalar("SELECT id FROM users WHERE username = 'z'")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(put(&c, &tadmin, z, json!({"isAdmin": false})).await.0, 200);
    for body in [json!({"enabled": false}), json!({"isAdmin": false})] {
        let (s, _) = put(&c, &tadmin, admin, body).await;
        assert_eq!(s, 409);
    }
    assert_eq!(
        c.call("DELETE", &format!("/api/users/{z}"), &tadmin, None)
            .await
            .0,
        200
    );
    assert_eq!(
        c.call("DELETE", &format!("/api/users/{admin}"), &tadmin, None)
            .await
            .0,
        409
    );
}

#[sqlx::test(migrations = false)]
async fn create_defaults_and_conflict(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, tm) = c.user("m", r#"["users.manage"]"#, false).await;
    let lib: i32 = sqlx::query_scalar(r#"INSERT INTO libraries (name) VALUES ('l') RETURNING id"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    let role: i32 = sqlx::query_scalar(
        r#"INSERT INTO roles (name, permissions, "isDefault") VALUES ('def', '[]', true) RETURNING id"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO role_default_libraries ("roleId", "libraryId") VALUES ($1, $2)"#)
        .bind(role)
        .bind(lib)
        .execute(&c.pool)
        .await
        .unwrap();

    let new = json!({"username": "u", "password": "longenough"});
    let (s, b) = c.call("POST", "/api/users", &tm, Some(new.clone())).await;
    assert_eq!(
        (s, &b["roleId"], &b["libraryIds"], &b["role"]),
        (201, &json!(role), &json!([lib]), &json!("def"))
    );
    assert!(b.get("passwordHash").is_none() && b.get("features").is_none());
    let (s, b) = c.call("POST", "/api/users", &tm, Some(new)).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (409, Some("Username already taken"))
    );
    let with_role = json!({"username": "v", "password": "longenough", "roleId": role});
    let (s, b) = c.call("POST", "/api/users", &tm, Some(with_role)).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (
            403,
            Some("Only users with roles.manage permission can assign a role")
        )
    );
    let (s, stats) = c
        .call("GET", &format!("/api/users/{}/stats", 1), &tm, None)
        .await;
    assert_eq!(s, 200);
    assert_eq!(
        stats["requests"],
        json!({"pending": 0, "approved": 0, "declined": 0})
    );
}

#[sqlx::test(migrations = false)]
async fn password_change_revokes_every_session_and_share_disabled_tears_down(pool: PgPool) {
    let c = ctx(pool).await;
    let (a, ta) = c.user("a", "[]", false).await;
    for (family, (hash, used)) in [("h1", "2026-01-01"), ("h2", "2026-02-01")]
        .into_iter()
        .enumerate()
    {
        sqlx::query(
            r#"INSERT INTO refresh_tokens ("userId", "tokenHash", "expiresAt", "lastUsedAt", "familyId")
               VALUES ($1, $2, now() + interval '1 day', $3::timestamptz, $4)"#,
        )
        .bind(a)
        .bind(hash)
        .bind(used)
        .bind(family as i32)
        .execute(&c.pool)
        .await
        .unwrap();
    }
    sqlx::query(r#"UPDATE users SET "requirePasswordChange" = true WHERE id = $1"#)
        .bind(a)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, b) = c
        .call(
            "PUT",
            &format!("/api/users/{a}"),
            &ta,
            Some(json!({"password": "longenough", "shareDisabled": true})),
        )
        .await;
    assert_eq!(
        (s, &b["requirePasswordChange"], &b["shareDisabled"]),
        (200, &json!(false), &json!(true))
    );
    let live: Vec<String> =
        sqlx::query_scalar(r#"SELECT "tokenHash" FROM refresh_tokens WHERE "revokedAt" IS NULL"#)
            .fetch_all(&c.pool)
            .await
            .unwrap();
    assert!(live.is_empty(), "{live:?}");
}

#[sqlx::test(migrations = false)]
async fn avatar_upload_and_clear(pool: PgPool) {
    let dir = fliks_server::paths::data_dir();
    let c = ctx(pool).await;
    let (a, ta) = c.user("a", "[]", false).await;
    let send = |ct: &str, name: &str, data: &[u8]| {
        let mut body = format!("--B\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"f.jpg\"\r\nContent-Type: {ct}\r\n\r\n").into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n--B--\r\n");
        let req = Request::post("/api/users/me/avatar")
            .header("authorization", format!("Bearer {ta}"))
            .header("content-type", "multipart/form-data; boundary=B")
            .body(Body::from(body))
            .unwrap();
        let app = c.app.clone();
        async move {
            let res = app.oneshot(req).await.unwrap();
            let s = res.status().as_u16();
            let b = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            (
                s,
                serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null),
            )
        }
    };
    assert_eq!(
        send("image/png", "file", b"x").await.1["message"],
        "Avatar must be a JPEG image"
    );
    assert_eq!(
        send("image/jpeg", "other", b"x").await.1["message"],
        "Unexpected field - other"
    );
    assert_eq!(
        send("image/jpeg", "file", &vec![0; 5 * 1024 * 1024 + 1])
            .await
            .0,
        413
    );
    let (s, b) = send("image/jpeg", "file", b"jpegbytes").await;
    assert_eq!(s, 201);
    assert!(
        b["avatar"]
            .as_str()
            .unwrap()
            .starts_with(&format!("/api/images/user/{a}?v="))
    );
    let file = dir.join("users").join(format!("{a}.jpg"));
    assert_eq!(std::fs::read(&file).unwrap(), b"jpegbytes");
    let (s, b) = c.call("DELETE", "/api/users/me/avatar", &ta, None).await;
    assert_eq!((s, &b["avatar"]), (200, &Value::Null));
    assert!(!file.exists());
}

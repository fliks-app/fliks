//! Roles routes (`docs/spec/roles.md`) through the real router on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, roles, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    admin: String,
    manager: String,
    editor: String,
}

async fn user(
    pool: &PgPool,
    st: &AppState,
    name: &str,
    perms: Option<&str>,
    admin: bool,
) -> String {
    let role: Option<i32> = match perms {
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
        None => None,
    };
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
    let admin = user(&pool, &st, "admin", None, true).await;
    let manager = user(&pool, &st, "manager", Some(r#"["users.manage"]"#), false).await;
    let editor = user(&pool, &st, "editor", Some(r#"["roles.manage"]"#), false).await;
    let app = app::router(
        st,
        fliks_engine::gateway::Upstream::parse("http://127.0.0.1:1").unwrap(),
        None,
        std::env::temp_dir(),
        None,
    );
    Ctx {
        app,
        admin,
        manager,
        editor,
    }
}

async fn call(
    c: &Ctx,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (u16, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
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
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn bad(msgs: &[&str]) -> Value {
    json!({"statusCode": 400, "message": msgs, "error": "Bad Request"})
}

#[sqlx::test(migrations = false)]
async fn seed_is_exact_and_idempotent(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    roles::seed(&pool).await.unwrap();
    let (s, b) = call(&c, "GET", "/api/roles", Some(&c.admin), None).await;
    assert_eq!(s, 200);
    let names: Vec<_> = b
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["id"].as_i64() <= Some(3))
        .map(|r| r["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Admin", "Readonly", "User"]);
    let user = b
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["name"] == "User")
        .unwrap();
    assert_eq!(
        (user["isDefault"].clone(), user["permissions"].clone()),
        (
            json!(true),
            json!(["media.read", "livetv.read", "requests.create"])
        )
    );
}

#[sqlx::test(migrations = false)]
async fn authz_per_route(pool: PgPool) {
    let c = ctx(pool).await;
    let forbidden =
        json!({"statusCode": 403, "message": "Forbidden resource", "error": "Forbidden"});
    for (m, u, body) in [
        ("GET", "/api/roles", None),
        ("GET", "/api/roles/permissions", None),
        ("GET", "/api/roles/1", None),
        (
            "POST",
            "/api/roles",
            Some(json!({"name": "x", "permissions": []})),
        ),
        ("PUT", "/api/roles/1", Some(json!({}))),
        ("DELETE", "/api/roles/1", None),
    ] {
        assert_eq!(call(&c, m, u, None, body.clone()).await.0, 401, "{m} {u}");
        let want_manager = if m == "GET" && u != "/api/roles/permissions" {
            200
        } else {
            403
        };
        let (s, b) = call(&c, m, u, Some(&c.manager), body).await;
        assert_eq!(s, want_manager, "{m} {u}");
        if s == 403 {
            assert_eq!(b, forbidden);
        }
    }
    // invalid body from a non-manager is a 403, not a 400
    let (s, _) = call(
        &c,
        "POST",
        "/api/roles",
        Some(&c.manager),
        Some(json!({"nope": 1})),
    )
    .await;
    assert_eq!(s, 403);
}

#[sqlx::test(migrations = false)]
async fn crud_rules(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    sqlx::query(r#"INSERT INTO libraries (name) VALUES ('Movies'), ('Series')"#)
        .execute(&pool)
        .await
        .unwrap();
    let a = Some(c.admin.as_str());

    let (s, b) = call(&c, "POST", "/api/roles", a, Some(json!({"name": "Ed", "permissions": ["media.read"], "isDefault": true, "defaultLibraryIds": [2, 1, 99]}))).await;
    assert_eq!(s, 201);
    assert_eq!(b["defaultLibraryIds"], json!([1, 2]));
    assert!(
        b["defaultLibraries"][0]
            .get("defaultQualityProfileId")
            .is_none()
    );
    assert_eq!(b["isDefault"], true);
    let id = b["id"].as_i64().unwrap();

    let (s, b) = call(&c, "GET", "/api/roles", a, None).await;
    assert_eq!(s, 200);
    let defaults: Vec<_> = b
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["isDefault"] == true)
        .map(|r| r["name"].clone())
        .collect();
    assert_eq!(defaults, [json!("Ed")]);
    assert!(b[0]["defaultLibraries"].is_array());

    let conflict =
        json!({"statusCode": 409, "message": "Role name already exists", "error": "Conflict"});
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/roles",
            a,
            Some(json!({"name": "Ed", "permissions": []}))
        )
        .await,
        (409, conflict.clone())
    );
    assert_eq!(
        call(
            &c,
            "PUT",
            &format!("/api/roles/{id}"),
            a,
            Some(json!({"name": "Admin"}))
        )
        .await,
        (409, conflict)
    );

    let (s, b) = call(
        &c,
        "PUT",
        &format!("/api/roles/{id}"),
        a,
        Some(json!({"name": "Ed", "defaultLibraryIds": [2], "isDefault": false})),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(
        (b["defaultLibraryIds"].clone(), b["isDefault"].clone()),
        (json!([2]), json!(false))
    );
    assert!(
        b["defaultLibraries"][0]
            .get("defaultQualityProfileId")
            .is_some()
    );

    assert_eq!(
        call(&c, "GET", "/api/roles/9999", a, None).await.1["message"],
        "Role #9999 not found"
    );
    assert_eq!(call(&c, "GET", "/api/roles/abc", a, None).await.0, 400);

    // role in use cannot be deleted
    sqlx::query(r#"UPDATE users SET "roleId" = $1 WHERE username = 'manager'"#)
        .bind(id as i32)
        .execute(&pool)
        .await
        .unwrap();
    let (s, b) = call(&c, "DELETE", &format!("/api/roles/{id}"), a, None).await;
    assert_eq!(
        (s, b["message"].clone()),
        (
            409,
            json!("Cannot delete role \"Ed\": still assigned to 1 user(s)")
        )
    );
    sqlx::query(r#"UPDATE users SET "roleId" = NULL"#)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        call(&c, "DELETE", &format!("/api/roles/{id}"), a, None)
            .await
            .0,
        200
    );
    assert_eq!(
        call(&c, "DELETE", &format!("/api/roles/{id}"), a, None)
            .await
            .0,
        404
    );
}

#[sqlx::test(migrations = false)]
async fn validation_messages(pool: PgPool) {
    let c = ctx(pool).await;
    let a = Some(c.admin.as_str());
    let post = |b: Value| call(&c, "POST", "/api/roles", a, Some(b));
    assert_eq!(
        post(json!({"name": "x"})).await.1,
        bad(&[
            "each value in permissions must be a string",
            "permissions must be an array"
        ])
    );
    assert_eq!(
        post(json!({"name": "x", "permissions": [], "foo": 1}))
            .await
            .1,
        bad(&["property foo should not exist"])
    );
    assert_eq!(
        post(json!({"permissions": []})).await.1,
        bad(&["name must be a string"])
    );
    assert_eq!(
        post(json!({"name": "x", "permissions": [], "defaultLibraryIds": ["a"]}))
            .await
            .1,
        bad(&["each value in defaultLibraryIds must be an integer number"])
    );
    let (s, b) = call(
        &c,
        "PUT",
        "/api/roles/3",
        a,
        Some(json!({"permissions": "media.read"})),
    )
    .await;
    assert_eq!((s, b), (400, bad(&["permissions must be an array"])));
}

#[sqlx::test(migrations = false)]
async fn f12_permissions_are_validated(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let body = |p: Value| Some(json!({"name": "n", "permissions": p}));
    let ed = Some(c.editor.as_str());
    let (s, b) = call(
        &c,
        "POST",
        "/api/roles",
        ed,
        body(json!(["media.read", "bogus"])),
    )
    .await;
    assert_eq!((s, b), (400, bad(&["permissions contains invalid values"])));
    let (s, b) = call(&c, "POST", "/api/roles", ed, body(json!(["manage:all"]))).await;
    assert_eq!(
        (s, b),
        (403, json!({"statusCode": 403, "message": "Forbidden"}))
    );
    assert_eq!(
        call(
            &c,
            "PUT",
            "/api/roles/3",
            ed,
            Some(json!({"permissions": ["manage:all"]}))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/roles",
            Some(&c.admin),
            body(json!(["manage:all"]))
        )
        .await
        .0,
        201
    );

    sqlx::query(r#"INSERT INTO plugin_packages ("pluginId", version, archive, origin, signature, manifest, enabled, status)
        VALUES ('fliks.a', '1', '\x00', 'catalog', 's', '{"kind":"process","permissions":["queue"],"routes":[{"policy":"read:plugin:fliks.a:queue"}]}', true, 'active'),
               ('fliks.b', '1', '\x00', 'catalog', 's', '{"kind":"process","permissions":["q"],"routes":[]}', false, 'active'),
               ('fliks.c', '1', '\x00', 'catalog', 's', '{"kind":"process","permissions":["q"],"routes":[]}', true, 'failed')"#)
        .execute(&pool).await.unwrap();
    let (s, b) = call(&c, "GET", "/api/roles/permissions", Some(&c.admin), None).await;
    assert_eq!(s, 200);
    assert_eq!(b.as_array().unwrap().len(), 13);
    assert_eq!(b[12], "read:plugin:fliks.a:queue");
    assert_eq!(
        call(
            &c,
            "POST",
            "/api/roles",
            ed,
            Some(json!({"name": "p", "permissions": ["read:plugin:fliks.a:queue"]}))
        )
        .await
        .0,
        201
    );
}

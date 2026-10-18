//! `/api/libraries/*` and the ACL helpers (`docs/spec/libraries.md`) through the real router on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, libraries, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    admin: String,
    user: String,
    tmp: std::path::PathBuf,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::query(r#"INSERT INTO roles (name, permissions) VALUES ('lib', '["settings.access","media.read"]')"#)
        .execute(&pool)
        .await
        .unwrap();
    let mut toks = vec![];
    for (name, admin, role) in [("admin", true, false), ("user", false, true)] {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin", "roleId") VALUES ($1, $2, (SELECT id FROM roles WHERE $3 LIMIT 1)) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();
        toks.push(st.jwt.sign_access(id, name).unwrap().token);
    }
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    let tmp = std::env::temp_dir().join(format!("fliks-lib-{}", uuid_like()));
    Ctx {
        app,
        st,
        user: toks.pop().unwrap(),
        admin: toks.pop().unwrap(),
        tmp,
    }
}

fn uuid_like() -> String {
    format!("{:?}-{}", std::thread::current().id(), std::process::id()).replace(['(', ')'], "")
}

async fn call(c: &Ctx, method: &str, uri: &str, tok: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {tok}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = c.app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let b = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

#[sqlx::test(migrations = false)]
async fn path_state_machine_creates_last(pool: PgPool) {
    let c = ctx(pool).await;
    let p = |s: &str| c.tmp.join(s).to_string_lossy().into_owned();
    let (s, lib) = call(
        &c,
        "POST",
        "/api/libraries",
        &c.admin,
        json!({"name": "A", "path": p("a/b")}),
    )
    .await;
    assert_eq!(s, 201);
    assert!(c.tmp.join("a/b").is_dir());
    assert_eq!(lib["disk"]["accessible"], true);
    let id = lib["id"].as_i64().unwrap();
    // relative path and a taken path create nothing
    let (s, _) = call(
        &c,
        "POST",
        "/api/libraries",
        &c.admin,
        json!({"name": "R", "path": "rel/x"}),
    )
    .await;
    assert_eq!(s, 400);
    assert!(!std::path::Path::new("rel/x").exists());
    let (s, b) = call(
        &c,
        "POST",
        "/api/libraries",
        &c.admin,
        json!({"name": "D", "path": p("a/b")}),
    )
    .await;
    assert_eq!(
        (
            s,
            b["message"].as_str().unwrap().contains("already attached")
        ),
        (400, true)
    );
    // library with media: changing the path is refused before mkdir, clearing too
    sqlx::query(r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', $1)"#)
        .bind(id as i32)
        .execute(&c.st.db)
        .await
        .unwrap();
    let (s, _) = call(
        &c,
        "PATCH",
        &format!("/api/libraries/{id}"),
        &c.admin,
        json!({"path": p("moved")}),
    )
    .await;
    assert_eq!(s, 400);
    assert!(!c.tmp.join("moved").exists());
    let (s, _) = call(
        &c,
        "PATCH",
        &format!("/api/libraries/{id}"),
        &c.admin,
        json!({"path": ""}),
    )
    .await;
    assert_eq!(s, 400);
    // same path is a no-op, a missing directory is not recreated
    std::fs::remove_dir_all(c.tmp.join("a")).unwrap();
    let (s, _) = call(
        &c,
        "PATCH",
        &format!("/api/libraries/{id}"),
        &c.admin,
        json!({"path": p("a/b")}),
    )
    .await;
    assert_eq!(s, 200);
    assert!(!c.tmp.join("a").exists());
    let _ = std::fs::remove_dir_all(&c.tmp);
}

#[sqlx::test(migrations = false)]
async fn validation_conflicts_and_acl(pool: PgPool) {
    let c = ctx(pool).await;
    for (body, want) in [
        (json!({"name": "A"}), 201),
        (json!({"name": "A"}), 409),
        (json!({"name": "B", "defaultQualityProfileId": 999}), 400),
        (json!({"name": "B", "userIds": [999]}), 400),
        (json!({"name": "B", "userIds": [1, 1]}), 400),
        (json!({"name": "B", "icon": "x".repeat(49)}), 400),
        (json!({"name": "B", "mediaTypes": ["music"]}), 400),
    ] {
        assert_eq!(
            call(&c, "POST", "/api/libraries", &c.admin, body.clone())
                .await
                .0,
            want,
            "{body}"
        );
    }
    let (s, _) = call(
        &c,
        "PATCH",
        "/api/libraries/1",
        &c.admin,
        json!({"name": null}),
    )
    .await;
    assert_eq!(s, 400);
    let (s, _) = call(&c, "GET", "/api/libraries/007", &c.admin, json!(null)).await;
    assert_eq!(s, 400);
    // non-admin with settings.access: F20 hides libraries outside its rows
    let (s, b) = call(&c, "GET", "/api/libraries/1", &c.user, json!(null)).await;
    assert_eq!(
        (s, b["message"].clone()),
        (404, json!("Library #1 not found"))
    );
    let (s, _) = call(
        &c,
        "PUT",
        "/api/libraries/1/access",
        &c.admin,
        json!({"userIds": [2, 1]}),
    )
    .await;
    assert_eq!(s, 200);
    let (_, ids) = call(&c, "GET", "/api/libraries/1/access", &c.admin, json!(null)).await;
    assert_eq!(ids, json!([2, 1]));
    assert_eq!(
        call(&c, "GET", "/api/libraries/1/access", &c.user, json!(null))
            .await
            .0,
        200
    );
    assert_eq!(
        call(
            &c,
            "PUT",
            "/api/libraries/99/access",
            &c.admin,
            json!({"userIds": []})
        )
        .await
        .0,
        404
    );
    // an update that changes nothing does not bump updatedAt
    let before = call(&c, "GET", "/api/libraries/1", &c.admin, json!(null))
        .await
        .1;
    let after = call(&c, "PATCH", "/api/libraries/1", &c.admin, json!({}))
        .await
        .1;
    assert_eq!(before["updatedAt"], after["updatedAt"]);
    assert_eq!(
        call(&c, "GET", "/api/libraries/mine", &c.user, json!(null))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrations = false)]
async fn acl_helpers(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    for n in ["A", "B"] {
        sqlx::query("INSERT INTO libraries (name) VALUES ($1)")
            .bind(n)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES (2, 1)"#)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO media (title, type, "libraryId") VALUES ('in', 'movie', 1), ('out', 'movie', 2), ('none', 'movie', NULL)"#)
        .execute(&pool)
        .await
        .unwrap();
    let authed = |id: i32| {
        let st = c.st.clone();
        async move {
            let u = fliks_server::http::auth::load_enabled(&st.db, id)
                .await
                .unwrap()
                .unwrap();
            fliks_server::http::auth::Authed {
                perms: fliks_domain::acl::Permissions::from(
                    u.1.as_ref()
                        .map(|r| r.permissions.as_slice())
                        .unwrap_or(&[]),
                    u.0.is_admin,
                ),
                user: u.0,
                role: u.1,
                scope: None,
            }
        }
    };
    sqlx::query(r#"INSERT INTO roles (name, permissions) VALUES ('all', '["manage:all"]')"#)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO users (username, "roleId") VALUES ('root', (SELECT id FROM roles WHERE name = 'all')), ('none', (SELECT id FROM roles WHERE name = 'lib'))"#)
        .execute(&pool)
        .await
        .unwrap();
    let (admin, user) = (authed(1).await, authed(2).await);
    let mut root = libraries::accessible_library_ids(&pool, &authed(3).await)
        .await
        .unwrap();
    root.sort();
    assert_eq!(root, vec![1, 2]);
    assert!(
        libraries::accessible_library_ids(&pool, &authed(4).await)
            .await
            .unwrap()
            .is_empty()
    );
    let mut all = libraries::accessible_library_ids(&pool, &admin)
        .await
        .unwrap();
    all.sort();
    assert_eq!(all, vec![1, 2]);
    let mine = libraries::accessible_library_ids(&pool, &user)
        .await
        .unwrap();
    assert_eq!(mine, vec![1]);
    assert!(
        libraries::assert_media_accessible(&pool, 1, &mine)
            .await
            .is_ok()
    );
    for id in [2, 3, 99] {
        let e = libraries::assert_media_accessible(&pool, id, &mine)
            .await
            .unwrap_err();
        let body = axum::response::IntoResponse::into_response(e);
        assert_eq!(body.status(), 404);
    }
    assert!(
        libraries::assert_media_accessible(&pool, 3, &all)
            .await
            .is_err()
    );
}

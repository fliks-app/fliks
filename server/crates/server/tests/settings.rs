//! `/api/settings/*` and `/api/fs/browse` (`docs/spec/settings.md`) through the real router on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    admin: String,
    plain: String,
    pool: PgPool,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let mut tokens = vec![];
    for (name, admin) in [("admin", true), ("plain", false)] {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin") VALUES ($1, $2) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .fetch_one(&pool)
        .await
        .unwrap();
        tokens.push(st.jwt.sign_access(id, name).unwrap().token);
    }
    let nest = fliks_engine::gateway::Upstream::parse("http://127.0.0.1:1").unwrap();
    let app = app::router(st, nest, None, "/nonexistent".into(), None);
    Ctx {
        app,
        plain: tokens.pop().unwrap(),
        admin: tokens.pop().unwrap(),
        pool,
    }
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (u16, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if let Some(t) = token {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let req = req
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn stored(pool: &PgPool, key: &str) -> Option<Option<String>> {
    sqlx::query_scalar(r#"SELECT "value" FROM app_settings WHERE "key" = $1"#)
        .bind(key)
        .fetch_optional(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrations = false)]
async fn authz_on_every_route(pool: PgPool) {
    let c = ctx(pool).await;
    for (m, uri) in [
        ("GET", "/api/settings"),
        ("PUT", "/api/settings"),
        ("GET", "/api/settings/k"),
        ("PUT", "/api/settings/k"),
        ("GET", "/api/fs/browse"),
    ] {
        assert_eq!(
            call(&c.app, m, uri, None, json!({})).await.0,
            401,
            "{m} {uri}"
        );
        let (s, body) = call(&c.app, m, uri, Some(&c.plain), json!({})).await;
        assert_eq!(
            (s, body["message"].as_str()),
            (403, Some("Forbidden resource")),
            "{m} {uri}"
        );
    }
}

#[sqlx::test(migrations = false)]
async fn crud_and_redaction(pool: PgPool) {
    let c = ctx(pool).await;
    let a = Some(c.admin.as_str());
    let (s, row) = call(
        &c.app,
        "PUT",
        "/api/settings/seerr_api_key",
        a,
        json!({"value": "sk"}),
    )
    .await;
    assert_eq!((s, &row["value"]), (200, &Value::Null));
    call(
        &c.app,
        "PUT",
        "/api/settings/plain",
        a,
        json!({"value": "v"}),
    )
    .await;
    let (_, all) = call(&c.app, "GET", "/api/settings", a, json!({})).await;
    assert_eq!(all, json!({"plain": "v", "secretsSet": ["seerr_api_key"]}));
    let (_, one) = call(&c.app, "GET", "/api/settings/seerr_api_key", a, json!({})).await;
    assert_eq!(
        one,
        json!({"key": "seerr_api_key", "value": null, "secretSet": true})
    );
    let (_, miss) = call(&c.app, "GET", "/api/settings/nope", a, json!({})).await;
    assert_eq!(miss, json!({"key": "nope", "value": null}));

    // blank and absent keep, null clears
    call(
        &c.app,
        "PUT",
        "/api/settings/seerr_api_key",
        a,
        json!({"value": ""}),
    )
    .await;
    call(&c.app, "PUT", "/api/settings/seerr_api_key", a, json!({})).await;
    assert_eq!(
        stored(&c.pool, "seerr_api_key").await,
        Some(Some("sk".into()))
    );
    call(
        &c.app,
        "PUT",
        "/api/settings",
        a,
        json!({"data": {"seerr_api_key": ""}}),
    )
    .await;
    assert_eq!(
        stored(&c.pool, "seerr_api_key").await,
        Some(Some("sk".into()))
    );
    call(
        &c.app,
        "PUT",
        "/api/settings/seerr_api_key",
        a,
        json!({"value": null}),
    )
    .await;
    assert_eq!(stored(&c.pool, "seerr_api_key").await, Some(None));

    // plain key: `{}` clears, non-string and extra property are 400
    call(&c.app, "PUT", "/api/settings/plain", a, json!({})).await;
    assert_eq!(stored(&c.pool, "plain").await, Some(None));
    let (s, b) = call(&c.app, "PUT", "/api/settings/plain", a, json!({"value": 5})).await;
    assert_eq!(
        (s, b["message"].clone()),
        (400, json!(["value must be a string"]))
    );
    let (s, _) = call(&c.app, "PUT", "/api/settings/plain", a, json!({"x": 1})).await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn plugin_secret_fields_from_the_manifest(pool: PgPool) {
    let c = ctx(pool).await;
    let manifest = json!({"ui": {"configPages": [{"id": "p", "fields": [
        {"key": "token", "secret": true}, {"key": "name"}]}]}});
    sqlx::query(
        r#"INSERT INTO plugin_packages ("pluginId", version, archive, origin, signature, manifest)
                   VALUES ('demo', '1', '\x00', 'manual', 's', $1)"#,
    )
    .bind(manifest)
    .execute(&c.pool)
    .await
    .unwrap();
    let a = Some(c.admin.as_str());
    call(
        &c.app,
        "PUT",
        "/api/settings",
        a,
        json!({"data": {"plugin.demo.token": "t", "plugin.demo.name": "n"}}),
    )
    .await;
    let (_, all) = call(&c.app, "GET", "/api/settings", a, json!({})).await;
    assert_eq!(
        all,
        json!({"plugin.demo.name": "n", "secretsSet": ["plugin.demo.token"]})
    );
}

#[sqlx::test(migrations = false)]
async fn bulk_validates_everything_before_writing(pool: PgPool) {
    let c = ctx(pool).await;
    let a = Some(c.admin.as_str());
    let (s, b) = call(
        &c.app,
        "PUT",
        "/api/settings",
        a,
        json!({"data": {"a": "1", "engine_url": "x"}}),
    )
    .await;
    assert_eq!(s, 400);
    assert_eq!(
        b["message"],
        "\"engine_url\" is managed by its own endpoint: PUT /engine/remote"
    );
    assert_eq!(stored(&c.pool, "a").await, None);
    for bad in [
        json!({}),
        json!({"data": []}),
        json!({"data": "x"}),
        json!({"data": null}),
    ] {
        let (s, b) = call(&c.app, "PUT", "/api/settings", a, bad).await;
        assert_eq!(
            (s, b["message"].clone()),
            (400, json!(["data must be an object"]))
        );
    }
    let (s, b) = call(
        &c.app,
        "PUT",
        "/api/settings",
        a,
        json!({"data": {"a": "1", "b": null, "c": 2, "d": false}}),
    )
    .await;
    assert_eq!((s, b), (200, json!({"ok": true})));
    assert_eq!(stored(&c.pool, "a").await, Some(Some("1".into())));
    assert_eq!(stored(&c.pool, "b").await, Some(None));
    assert_eq!(stored(&c.pool, "c").await, Some(Some("2".into())));
    assert_eq!(stored(&c.pool, "d").await, Some(Some("false".into())));
}

#[cfg(unix)]
#[sqlx::test(migrations = false)]
async fn fs_browse_lists_sorted_directories_only(pool: PgPool) {
    let c = ctx(pool).await;
    let root = std::env::temp_dir().join(format!("fliks-fs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for d in ["b", "A", ".hid"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    std::fs::write(root.join("file"), "").unwrap();
    std::os::unix::fs::symlink(root.join("b"), root.join("link")).unwrap();
    let a = Some(c.admin.as_str());
    let dir = root.to_str().unwrap();
    let (s, b) = call(
        &c.app,
        "GET",
        &format!("/api/fs/browse?path={dir}/b/../"),
        a,
        json!({}),
    )
    .await;
    assert_eq!(s, 200);
    let names: Vec<_> = b["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, [".hid", "A", "b"]);
    assert_eq!(b["current"], dir);
    assert_eq!(b["parent"], root.parent().unwrap().to_str().unwrap());
    assert_eq!(b["entries"][0]["isDirectory"], true);
    let (s, b) = call(&c.app, "GET", "/api/fs/browse", a, json!({})).await;
    assert_eq!(
        (s, &b["current"], &b["parent"]),
        (200, &json!("/"), &Value::Null)
    );
    let (s, b) = call(
        &c.app,
        "GET",
        &format!("/api/fs/browse?path={dir}/nope"),
        a,
        json!({}),
    )
    .await;
    assert_eq!(s, 400);
    assert!(
        b["message"]
            .as_str()
            .unwrap()
            .contains("ENOENT: no such file or directory, scandir")
    );
    std::fs::remove_dir_all(&root).unwrap();
}

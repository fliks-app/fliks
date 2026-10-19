//! `/api/settings/*` and `/api/fs/browse` (`docs/spec/settings.md`) through the real router on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    admin: String,
    plain: String,
    pool: PgPool,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let cfg = Config::from_lookup(|_| None);
    let st = AppState::new(pool.clone(), cfg, SECRET);
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
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    Ctx {
        app,
        st,
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

#[sqlx::test(migrations = false)]
async fn engine_values_the_engine_would_refuse_are_400_before_any_write(pool: PgPool) {
    let c = ctx(pool).await;
    let a = Some(c.admin.as_str());
    let bulk = json!({"data": {"a": "1", "streaming_ffmpeg_slots": 2.5}});
    let (s, b) = call(&c.app, "PUT", "/api/settings", a, bulk).await;
    assert_eq!(
        (s, b["message"].clone()),
        (
            400,
            json!(["streaming_ffmpeg_slots must be a positive integer number"])
        )
    );
    assert_eq!(stored(&c.pool, "a").await, None);
    let uri = "/api/settings/streaming_qsv_preset";
    let (s, _) = call(&c.app, "PUT", uri, a, json!({"value": "Fast"})).await;
    assert_eq!(s, 400);
    assert_eq!(stored(&c.pool, "streaming_qsv_preset").await, None);
    let (s, _) = call(&c.app, "PUT", uri, a, json!({"value": "slow"})).await;
    assert_eq!(s, 200);
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

/// Rules 12-13: one `settings.changed` domain event per written key, a kept secret included.
#[sqlx::test(migrations = false)]
async fn every_put_emits_settings_changed_per_key(pool: PgPool) {
    use fliks_server::events::{Bus, DomainEvent};
    let c = ctx(pool).await;
    let mut rx = c.st.hub.subscribe();
    let a = Some(c.admin.as_str());
    for (uri, body) in [
        ("/api/settings/seerr_api_key", json!({"value": "sk"})),
        ("/api/settings/seerr_api_key", json!({"value": ""})),
        (
            "/api/settings",
            json!({"data": {"seerr_api_key": "", "seerr_url": "http://s"}}),
        ),
    ] {
        let (status, b) = call(&c.app, "PUT", uri, a, body).await;
        assert!(status < 300, "{uri}: {b}");
    }
    let mut keys = vec![];
    while let Ok(bus) = rx.try_recv() {
        if let Bus::Domain(DomainEvent::SettingsChanged { key }) = &*bus {
            keys.push(key.clone());
        }
    }
    assert_eq!(
        keys,
        [
            "seerr_api_key",
            "seerr_api_key",
            "seerr_api_key",
            "seerr_url"
        ]
    );
}

/// `setup-checklist.md`: the seven items in order, dismissal stored compact, unknown keys 400.
#[sqlx::test(migrations = false)]
async fn setup_checklist_items_and_dismissal(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (s, items) = call(
        &c.app,
        "GET",
        "/api/setup-checklist",
        Some(&c.admin),
        Value::Null,
    )
    .await;
    assert_eq!(s, 200);
    let keys: Vec<&str> = items
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        [
            "library",
            "quality-profile",
            "language-profile",
            "subtitle-provider",
            "notification",
            "non-admin-user",
            "auto-approval-rule"
        ]
    );
    assert_eq!(
        items[5],
        json!({"key": "non-admin-user", "severity": "recommended", "done": true, "dismissed": false,
        "route": ["/admin", "settings", "users"]})
    );
    assert_eq!(
        call(
            &c.app,
            "GET",
            "/api/setup-checklist",
            Some(&c.plain),
            Value::Null
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &c.app,
            "POST",
            "/api/setup-checklist/nope/dismiss",
            Some(&c.admin),
            Value::Null
        )
        .await,
        (
            400,
            json!({"message": "Unknown checklist key: nope", "error": "Bad Request", "statusCode": 400})
        )
    );
    for key in ["notification", "library", "notification"] {
        assert_eq!(
            call(
                &c.app,
                "POST",
                &format!("/api/setup-checklist/{key}/dismiss"),
                Some(&c.admin),
                Value::Null
            )
            .await,
            (201, json!({"ok": true}))
        );
    }
    assert_eq!(
        stored(&pool, "setup_checklist_dismissed_keys").await,
        Some(Some(r#"["notification","library"]"#.into()))
    );
    assert_eq!(
        call(
            &c.app,
            "DELETE",
            "/api/setup-checklist/notification/dismiss",
            Some(&c.admin),
            Value::Null
        )
        .await,
        (200, json!({"ok": true}))
    );
    sqlx::query(r#"UPDATE app_settings SET value = '["library", 3, "gone"]' WHERE key = 'setup_checklist_dismissed_keys'"#).execute(&pool).await.unwrap();
    let (_, items) = call(
        &c.app,
        "GET",
        "/api/setup-checklist",
        Some(&c.admin),
        Value::Null,
    )
    .await;
    let dismissed: Vec<bool> = items
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["dismissed"] == true)
        .collect();
    assert_eq!(dismissed, [true, false, false, false, false, false, false]);
}

/// `counts.md`: the three counters, each scoped by its own ability.
#[sqlx::test(migrations = false)]
async fn sidebar_counts(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name, "mediaTypes", path) VALUES (1, 'M', '["movie"]', '/nonexistent/m');
           INSERT INTO media (title, type, "tmdbId", "libraryId", "folderName") VALUES ('A', 'movie', 1, 1, 'a'), ('B', 'movie', 2, 1, 'b');
           INSERT INTO requests ("userId", "mediaType", "tmdbId", title, status)
             SELECT id, 'movie', 9, 'R', 'pending' FROM users WHERE username = 'admin';"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        call(&c.app, "GET", "/api/counts", Some(&c.admin), Value::Null).await,
        (
            200,
            json!({"badgeCounts": {}, "pendingRequests": 1, "mediaByLibrary": {"1": 2}})
        )
    );
    assert_eq!(
        call(&c.app, "GET", "/api/counts", Some(&c.plain), Value::Null)
            .await
            .1["pendingRequests"],
        0
    );
    assert_eq!(
        call(&c.app, "GET", "/api/counts", None, Value::Null)
            .await
            .0,
        401
    );
}

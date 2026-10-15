//! The routes (`/api/engine/remote*`, `/engine/resolve`, the live TV config bridge) and the DB-backed
//! parts of the glue through the real router; ports of `engine-resolver.spec.ts`.
use super::{
    testkit::{Fake, RUNTIME, hello_body},
    *,
};
use crate::{app, config::Config, state::AppState};
use axum::{
    Json, Router,
    body::Body,
    extract::{Request, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const BRIDGE: &str = "bridge-token";

type Calls = Arc<Mutex<Vec<(String, String, Value)>>>;

/// Stands in for Nest: records the bridge calls and answers `/engine/resolve` from `live`.
struct FakeNest {
    url: String,
    calls: Calls,
    live: Arc<Mutex<Value>>,
}

#[derive(Clone)]
struct NestState {
    calls: Calls,
    live: Arc<Mutex<Value>>,
    live_status: u16,
}

async fn nest_handler(State(s): State<NestState>, req: Request) -> (StatusCode, Json<Value>) {
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
    let auth = parts
        .headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    s.calls
        .lock()
        .unwrap()
        .push((parts.uri.path().to_owned(), auth, body));
    if parts.uri.path() == "/engine/resolve" {
        (
            StatusCode::from_u16(s.live_status).unwrap(),
            Json(s.live.lock().unwrap().clone()),
        )
    } else {
        (StatusCode::NO_CONTENT, Json(Value::Null))
    }
}

async fn fake_nest(live: Value, live_status: u16) -> FakeNest {
    let calls: Calls = Arc::default();
    let live = Arc::new(Mutex::new(live));
    let state = NestState {
        calls: calls.clone(),
        live: live.clone(),
        live_status,
    };
    let app = Router::new().fallback(nest_handler).with_state(state);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    FakeNest { url, calls, live }
}

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
    fake: Fake,
    nest: FakeNest,
    dir: PathBuf,
}

impl Drop for Ctx {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

async fn ctx(pool: PgPool, boot_engine: bool) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let fake = Fake::start().await;
    fake.hello(Some(hello_body(&RUNTIME, "x")));
    let nest = fake_nest(json!({"allow": true, "ownerId": "1", "ttlS": 0}), 200).await;
    let env = [
        ("FLIKS_ENGINE_URL", fake.url.clone()),
        ("FLIKS_ENGINE_TOKEN", "tok".into()),
        ("FLIKS_NEST_URL", nest.url.clone()),
        ("FLIKS_BRIDGE_TOKEN", BRIDGE.into()),
    ];
    let cfg = Config::from_lookup(|k| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()));
    let st = AppState::new(pool.clone(), cfg, SECRET);
    if boot_engine {
        st.engine.start(pool.clone(), 4849).await;
    }
    let upstream = fliks_engine::gateway::Upstream::parse("http://127.0.0.1:1").unwrap();
    let app = app::router(st.clone(), upstream, None, "/nonexistent".into(), None);
    let dir = std::env::temp_dir().join(format!(
        "fliks-engine-test-{}",
        crate::config::random_hex(6)
    ));
    fs::create_dir_all(&dir).unwrap();
    Ctx {
        app,
        st,
        pool,
        fake,
        nest,
        dir,
    }
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, String)],
    body: Option<Value>,
) -> (u16, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn user(pool: &PgPool, name: &str, admin: bool, enabled: bool) -> i32 {
    sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin", enabled) VALUES ($1, $2, $3) RETURNING id"#,
    )
    .bind(name)
    .bind(admin)
    .bind(enabled)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn auth(token: &str) -> Vec<(&'static str, String)> {
    vec![("authorization", format!("Bearer {token}"))]
}

mod remote {
    use super::*;

    async fn admin_and_plain(c: &Ctx) -> (String, String) {
        let a = user(&c.pool, "admin", true, true).await;
        let p = user(&c.pool, "plain", false, true).await;
        let sign = |id, name| c.st.jwt.sign_access(id, name).unwrap().token;
        (sign(a, "admin"), sign(p, "plain"))
    }

    async fn setting(pool: &PgPool, key: &str) -> Option<String> {
        sqlx::query_scalar(r#"SELECT "value" FROM app_settings WHERE "key" = $1"#)
            .bind(key)
            .fetch_optional(pool)
            .await
            .unwrap()
            .flatten()
    }

    #[sqlx::test(migrations = false)]
    async fn the_three_routes_need_manage_settings(pool: PgPool) {
        let c = ctx(pool, false).await;
        let (_, plain) = admin_and_plain(&c).await;
        for (m, uri) in [
            ("GET", "/api/engine/remote"),
            ("PUT", "/api/engine/remote"),
            ("POST", "/api/engine/remote/test"),
        ] {
            let body = (m != "GET").then(|| json!({"url": "", "token": "", "pathMappings": []}));
            let (s, b) = call(&c.app, m, uri, &[], body.clone()).await;
            assert_eq!(
                (s, b),
                (401, json!({"statusCode": 401, "message": "Unauthorized"})),
                "{m}"
            );
            let (s, b) = call(&c.app, m, uri, &auth(&plain), body).await;
            assert_eq!(
                (s, b["message"].clone()),
                (403, json!("Forbidden resource")),
                "{m}"
            );
        }
    }

    #[sqlx::test(migrations = false)]
    async fn get_never_returns_the_token_and_says_whether_one_is_saved(pool: PgPool) {
        let c = ctx(pool, true).await;
        let (admin, _) = admin_and_plain(&c).await;
        let (s, b) = call(&c.app, "GET", "/api/engine/remote", &auth(&admin), None).await;
        assert_eq!(s, 200);
        assert_eq!(
            b,
            json!({"url": "", "pathMappings": [], "status": "up", "processUrl": c.fake.url})
        );
        store::write_engine_settings(
            &c.pool,
            "http://elsewhere",
            store::TokenWrite::Set(Some("secret".into())),
            &[],
        )
        .await
        .unwrap();
        let (_, b) = call(&c.app, "GET", "/api/engine/remote", &auth(&admin), None).await;
        assert_eq!(b["secretsSet"], json!(["engine_token"]));
        assert!(b.get("token").is_none());
        assert_eq!(
            (b["mismatch"].clone(), b["url"].clone()),
            (json!(true), json!("http://elsewhere"))
        );
    }

    #[sqlx::test(migrations = false)]
    async fn get_reports_down_with_an_error_when_the_engine_stops_answering(pool: PgPool) {
        let c = ctx(pool, true).await;
        let (admin, _) = admin_and_plain(&c).await;
        c.fake.hello(None);
        let epoch = c.st.engine.state().epoch;
        c.st.engine.tick(epoch).await;
        let (_, b) = call(&c.app, "GET", "/api/engine/remote", &auth(&admin), None).await;
        assert_eq!(
            (b["status"].clone(), b["error"].clone()),
            (json!("down"), json!("The streaming engine is unreachable"))
        );
    }

    #[sqlx::test(migrations = false)]
    async fn put_saves_the_three_keys_reconnects_and_tells_nest(pool: PgPool) {
        let c = ctx(pool, true).await;
        let (admin, _) = admin_and_plain(&c).await;
        let other = Fake::start().await;
        other.hello(Some(hello_body(&RUNTIME, "other")));
        let body = json!({"url": other.url, "token": "other-token", "pathMappings": [{"from": " /nas ", "to": "/data"}, {"from": "", "to": "x"}]});
        let (s, b) = call(
            &c.app,
            "PUT",
            "/api/engine/remote",
            &auth(&admin),
            Some(body),
        )
        .await;
        assert_eq!(s, 200, "{b}");
        assert_eq!(b["status"], "up");
        assert_eq!(b["secretsSet"], json!(["engine_token"]));
        assert_eq!(b["pathMappings"], json!([{"from": "/nas", "to": "/data"}]));
        assert_eq!(
            setting(&c.pool, "engine_url").await.as_deref(),
            Some(other.url.as_str())
        );
        assert_eq!(
            setting(&c.pool, "engine_token").await.as_deref(),
            Some("other-token")
        );
        assert_eq!(other.seen("GET", "/v1/hello")[0].auth, "Bearer other-token");
        assert_eq!(
            other.seen("PUT", "/v1/config")[0].body["pathMappings"],
            json!([{"from": "/nas", "to": "/data"}])
        );
        let calls = c.nest.calls.lock().unwrap();
        let (path, bearer, sent) = &calls[0];
        assert_eq!(
            (path.as_str(), bearer.as_str()),
            ("/internal/bridge/settings-changed", "Bearer bridge-token")
        );
        assert_eq!(
            *sent,
            json!({"keys": ["engine_url", "engine_token", "engine_path_mappings"], "origin": "own-module-write"})
        );
    }

    #[sqlx::test(migrations = false)]
    async fn put_keeps_the_token_on_blank_or_absent_and_clears_it_on_null(pool: PgPool) {
        let c = ctx(pool, true).await;
        let (admin, _) = admin_and_plain(&c).await;
        let put = |token: Option<Value>| {
            let mut body = json!({"url": c.fake.url, "pathMappings": []});
            if let Some(t) = token {
                body["token"] = t;
            }
            let (app, admin) = (c.app.clone(), admin.clone());
            async move { call(&app, "PUT", "/api/engine/remote", &auth(&admin), Some(body)).await }
        };
        put(Some(json!("saved"))).await;
        for keep in [Some(json!("")), None] {
            put(keep).await;
            assert_eq!(
                setting(&c.pool, "engine_token").await.as_deref(),
                Some("saved")
            );
        }
        let (_, b) = put(Some(Value::Null)).await;
        assert_eq!(setting(&c.pool, "engine_token").await, None);
        assert!(b.get("secretsSet").is_none());
        let calls = c.nest.calls.lock().unwrap();
        let keys: Vec<_> = calls
            .iter()
            .map(|(_, _, b)| b["keys"].as_array().unwrap().len())
            .collect();
        assert_eq!(
            keys,
            [3, 2, 2, 3],
            "a kept token is not announced as written"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn put_clears_everything_with_an_empty_form_and_no_env_engine(pool: PgPool) {
        let c = ctx(pool, true).await;
        let (admin, _) = admin_and_plain(&c).await;
        let (s, b) = call(
            &c.app,
            "PUT",
            "/api/engine/remote",
            &auth(&admin),
            Some(json!({"url": "", "token": null, "pathMappings": []})),
        )
        .await;
        assert_eq!(s, 200);
        assert_eq!(b["status"], "up", "the process engine takes over");
        assert_eq!(setting(&c.pool, "engine_path_mappings").await, None);
        assert_eq!(setting(&c.pool, "engine_url").await.as_deref(), Some(""));
    }

    #[sqlx::test(migrations = false)]
    async fn bodies_are_validated_with_the_pipes_messages(pool: PgPool) {
        let c = ctx(pool, false).await;
        let (admin, _) = admin_and_plain(&c).await;
        let bad = |msgs: Value| json!({"statusCode": 400, "message": msgs, "error": "Bad Request"});
        for (method, uri, body, msgs) in [
            (
                "PUT",
                "/api/engine/remote",
                json!({"url": 5, "token": "", "pathMappings": []}),
                json!(["url must be a string"]),
            ),
            (
                "PUT",
                "/api/engine/remote",
                json!({"url": "", "token": "", "pathMappings": [{"from": 1}]}),
                json!([
                    "pathMappings.0.from must be a string",
                    "pathMappings.0.to must be a string"
                ]),
            ),
            (
                "POST",
                "/api/engine/remote/test",
                json!({"url": "x", "token": 1}),
                json!(["token must be a string"]),
            ),
            (
                "POST",
                "/api/engine/remote/test",
                json!({"token": "t"}),
                json!(["url must be a string"]),
            ),
        ] {
            let (s, b) = call(&c.app, method, uri, &auth(&admin), Some(body)).await;
            assert_eq!((s, b), (400, bad(msgs)));
        }
        assert_eq!(
            setting(&c.pool, "engine_url").await,
            None,
            "nothing written on a 400"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn test_answers_201_and_never_adopts(pool: PgPool) {
        let c = ctx(pool, false).await;
        let (admin, _) = admin_and_plain(&c).await;
        let (s, b) = call(
            &c.app,
            "POST",
            "/api/engine/remote/test",
            &auth(&admin),
            Some(json!({"url": "http://127.0.0.1:9", "token": "x"})),
        )
        .await;
        assert_eq!(s, 201);
        assert_eq!(
            b,
            json!({"ok": false, "error": "The streaming engine at http://127.0.0.1:9 did not answer"})
        );
        let other = Fake::start().await;
        let (_, b) = call(
            &c.app,
            "POST",
            "/api/engine/remote/test",
            &auth(&admin),
            Some(json!({"url": other.url, "token": "t"})),
        )
        .await;
        assert_eq!(
            (
                b["ok"].clone(),
                b["engineVersion"].clone(),
                b["protocolVersion"].clone()
            ),
            (json!(true), json!("0.2.0"), json!(1))
        );
        assert!(!c.st.engine.enabled());
        let (_, b) = call(
            &c.app,
            "POST",
            "/api/engine/remote/test",
            &auth(&admin),
            Some(json!({"url": c.fake.url})),
        )
        .await;
        assert_eq!(b["ok"], true, "no token: the configured one");
    }

    #[sqlx::test(migrations = false)]
    async fn the_boot_reads_the_saved_engine_and_its_path_mappings_and_reconfigure_rereads_them(
        pool: PgPool,
    ) {
        crate::db::migrate(&pool).await.unwrap();
        let fake = Fake::start().await;
        let map = |to: &str| {
            vec![PathMapping {
                from: "/nas".into(),
                to: to.into(),
            }]
        };
        store::write_engine_settings(
            &pool,
            &fake.url,
            store::TokenWrite::Set(Some("saved".into())),
            &map("/data"),
        )
        .await
        .unwrap();
        let e = Engine::new("http://127.0.0.1:1", "env");
        e.start(pool.clone(), 4849).await;
        assert!(e.enabled());
        assert_eq!(fake.seen("GET", "/v1/hello")[0].auth, "Bearer saved");
        assert_eq!(
            fake.seen("PUT", "/v1/config")[0].body["pathMappings"],
            json!([{"from": "/nas", "to": "/data"}])
        );
        store::write_engine_settings(&pool, &fake.url, store::TokenWrite::Keep, &map("/other"))
            .await
            .unwrap();
        e.reconfigure().await;
        let last = fake.seen("PUT", "/v1/config").pop().unwrap().body;
        assert_eq!(
            last["pathMappings"],
            json!([{"from": "/nas", "to": "/other"}])
        );
        assert_eq!(
            *e.adoptions().borrow(),
            3,
            "boot adoption, the drop and the new adoption"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn the_push_assembles_streaming_from_the_settings_and_a_write_repushes(pool: PgPool) {
        let c = ctx(pool, true).await;
        let set = |k: &'static str, v: &'static str| {
            let pool = c.pool.clone();
            async move {
                sqlx::query(r#"INSERT INTO app_settings ("key", "value") VALUES ($1, $2) ON CONFLICT ("key") DO UPDATE SET "value" = $2"#)
                    .bind(k)
                    .bind(v)
                    .execute(&pool)
                    .await
                    .unwrap();
            }
        };
        assert_eq!(
            c.fake.seen("PUT", "/v1/config")[0].body["streaming"]["cacheMaxBytes"],
            21_474_836_480.0
        );
        set("streaming_cache_max_gb", "1").await;
        set("streaming_qsv_preset", "slow").await;
        c.st.engine
            .settings_changed(&["streaming_cache_max_gb".into()])
            .await;
        let sent = c.fake.seen("PUT", "/v1/config");
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[1].body["streaming"]["cacheMaxBytes"], 1_073_741_824.0);
        assert_eq!(sent[1].body["streaming"]["qsvPreset"], "slow");
        assert_eq!(sent[1].body["revision"], 9);
    }

    #[sqlx::test(migrations = false)]
    async fn the_live_tv_bridge_hands_the_config_to_the_next_push(pool: PgPool) {
        let c = ctx(pool, true).await;
        let cfg = json!({"segmentSeconds": 4, "timeshiftMinutes": 5, "probeSeconds": 3, "channelIdleSeconds": 30, "fastZap": null});
        let bridge = |token: &str| vec![("authorization", format!("Bearer {token}"))];
        let (s, _) = call(
            &c.app,
            "PUT",
            "/internal/engine/livetv-config",
            &bridge("wrong"),
            Some(cfg.clone()),
        )
        .await;
        assert_eq!(s, 401);
        let (s, _) = call(
            &c.app,
            "PUT",
            "/internal/engine/livetv-config",
            &[],
            Some(cfg.clone()),
        )
        .await;
        assert_eq!(s, 401);
        let (s, _) = call(
            &c.app,
            "PUT",
            "/internal/engine/livetv-config",
            &bridge(BRIDGE),
            Some(cfg),
        )
        .await;
        assert_eq!(s, 204);
        let last = c.fake.seen("PUT", "/v1/config").pop().unwrap().body;
        assert_eq!(
            last["livetv"],
            json!({"segmentSeconds": 4, "timeshiftMinutes": 5, "probeSeconds": 3, "channelIdleSeconds": 30})
        );
    }
}

mod resolve {
    use super::*;
    use std::os::unix::fs::symlink;

    struct World {
        c: Ctx,
        /// A user with access to the library, one without, an admin.
        member: (i32, String),
        outsider: (i32, String),
        admin: (i32, String),
        file: i32,
        loose: i32,
        subtitle: i32,
        escaping: i32,
        linked: i32,
        missing: i32,
    }

    async fn world(pool: PgPool) -> World {
        let c = ctx(pool, true).await;
        let p = &c.pool;
        let root = c.dir.join("lib");
        let movie = root.join("Movie");
        fs::create_dir_all(&movie).unwrap();
        fs::write(movie.join("a.mkv"), b"x").unwrap();
        fs::write(movie.join("a.fr.SRT"), b"1").unwrap();
        fs::write(c.dir.join("secret.mkv"), b"s").unwrap();
        symlink(c.dir.join("secret.mkv"), movie.join("link.mkv")).unwrap();
        let lib: i32 = sqlx::query_scalar(
            r#"INSERT INTO libraries (name, path) VALUES ('L', $1) RETURNING id"#,
        )
        .bind(root.to_str().unwrap())
        .fetch_one(p)
        .await
        .unwrap();
        let media: i32 = sqlx::query_scalar(r#"INSERT INTO media (title, type, "libraryId", "folderName") VALUES ('M', 'movie', $1, 'Movie') RETURNING id"#)
            .bind(lib)
            .fetch_one(p)
            .await
            .unwrap();
        let orphan: i32 = sqlx::query_scalar(
            r#"INSERT INTO media (title, type) VALUES ('O', 'movie') RETURNING id"#,
        )
        .fetch_one(p)
        .await
        .unwrap();
        let file = |media: i32, rel: &'static str| {
            let p = p.clone();
            async move {
                sqlx::query_scalar::<_, i32>(r#"INSERT INTO media_files ("relativePath", size, quality, "mediaId") VALUES ($1, 1, 'x', $2) RETURNING id"#)
                    .bind(rel)
                    .bind(media)
                    .fetch_one(&p)
                    .await
                    .unwrap()
            }
        };
        let (ok_file, loose, escaping, linked, missing) = (
            file(media, "a.mkv").await,
            file(orphan, "a.mkv").await,
            file(media, "../secret.mkv").await,
            file(media, "link.mkv").await,
            file(media, "gone.mkv").await,
        );
        let sub = |rel: Option<&'static str>| {
            let p = p.clone();
            async move {
                sqlx::query_scalar::<_, i32>(r#"INSERT INTO subtitle_files (language, "providerType", "filePath", "mediaId") VALUES ('fr', 'disk', $1, $2) RETURNING id"#)
                    .bind(rel)
                    .bind(media)
                    .fetch_one(&p)
                    .await
                    .unwrap()
            }
        };
        let subtitle = sub(Some("a.fr.SRT")).await;
        let mut users = vec![];
        for (name, admin) in [("member", false), ("outsider", false), ("admin", true)] {
            let id = user(p, name, admin, true).await;
            users.push((id, c.st.jwt.sign_access(id, name).unwrap().token));
        }
        sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ($1, $2)"#)
            .bind(users[0].0)
            .bind(lib)
            .execute(p)
            .await
            .unwrap();
        World {
            member: users[0].clone(),
            outsider: users[1].clone(),
            admin: users[2].clone(),
            file: ok_file,
            loose,
            subtitle,
            escaping,
            linked,
            missing,
            c,
        }
    }

    fn host(w: &World) -> Vec<(&'static str, String)> {
        vec![(
            "authorization",
            format!("Bearer {}", w.c.st.engine.host_token()),
        )]
    }

    async fn resolve(w: &World, body: Value) -> (u16, Value) {
        call(&w.c.app, "POST", "/engine/resolve", &host(w), Some(body)).await
    }

    fn denied() -> Value {
        json!({"allow": false, "ttlS": 60.0})
    }

    fn path_of(w: &World, rel: &str) -> String {
        w.c.dir
            .join("lib/Movie")
            .join(rel)
            .to_str()
            .unwrap()
            .to_owned()
    }

    #[sqlx::test(migrations = false)]
    async fn allows_stream_with_every_credential_form(pool: PgPool) {
        let w = world(pool).await;
        let token = w.member.1.clone();
        let scoped = w.c.st.jwt.sign_stream(w.member.0, "member").unwrap().token;
        for (name, credential) in [
            ("bearer", format!("Bearer {token}")),
            ("bare ?token=", token.clone()),
            ("cookie", format!("x=1; fliks_access={token}")),
            ("stream-scoped token", scoped.clone()),
            ("scoped as bearer", format!("Bearer {scoped}")),
        ] {
            let (s, b) = resolve(
                &w,
                json!({"mediaId": w.file, "credential": credential, "purpose": "stream"}),
            )
            .await;
            assert_eq!(s, 200, "{name}");
            assert_eq!(
                b,
                json!({"allow": true, "ownerId": w.member.0.to_string(), "path": path_of(&w, "a.mkv"), "ttlS": 60.0}),
                "{name}"
            );
        }
    }

    #[sqlx::test(migrations = false)]
    async fn download_sprite_and_the_subtitle_purposes(pool: PgPool) {
        let w = world(pool).await;
        let cred = format!("Bearer {}", w.member.1);
        let ask = |extra: Value| {
            let mut body = json!({"mediaId": w.file, "credential": cred});
            body.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            resolve(&w, body)
        };
        let (_, b) = ask(json!({"purpose": "download"})).await;
        assert_eq!(b["path"], path_of(&w, "a.mkv"));
        let (_, b) = ask(json!({"purpose": "sprite"})).await;
        let sprite = b["path"].as_str().unwrap();
        assert!(
            sprite.ends_with(&format!("thumbnails/{}/sprite.jpg", w.file)),
            "{sprite}"
        );
        let (_, b) = ask(json!({"purpose": "subtitle", "subtitleId": w.subtitle})).await;
        assert_eq!(
            (b["format"].clone(), b["path"].clone()),
            (json!("srt"), json!(path_of(&w, "a.fr.SRT")))
        );
        let (_, b) = ask(json!({"purpose": "subtitle", "streamIndex": 2})).await;
        assert_eq!(
            (b["format"].clone(), b["path"].clone()),
            (json!("embedded"), json!(path_of(&w, "a.mkv")))
        );
        assert_eq!(ask(json!({"purpose": "subtitle"})).await.1, denied());
        assert_eq!(
            ask(json!({"purpose": "subtitle", "subtitleId": 99999}))
                .await
                .1,
            denied()
        );
    }

    #[sqlx::test(migrations = false)]
    async fn the_library_acl_decides(pool: PgPool) {
        let w = world(pool).await;
        let ask = |token: &str, id: i32, extra: Value| {
            let mut body = json!({"mediaId": id, "credential": format!("Bearer {token}"), "purpose": "stream"});
            body.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            resolve(&w, body)
        };
        assert_eq!(ask(&w.member.1, w.file, json!({})).await.1["allow"], true);
        assert_eq!(ask(&w.admin.1, w.file, json!({})).await.1["allow"], true);
        assert_eq!(ask(&w.outsider.1, w.file, json!({})).await.1, denied());
        let sub = json!({"purpose": "subtitle", "subtitleId": w.subtitle});
        assert_eq!(ask(&w.outsider.1, w.file, sub.clone()).await.1, denied());
        assert_eq!(ask(&w.admin.1, w.file, sub).await.1["format"], "srt");
        assert_eq!(
            ask(&w.admin.1, w.loose, json!({})).await.1,
            denied(),
            "no library: a 404 for admins too"
        );
        assert_eq!(ask(&w.admin.1, 999_999, json!({})).await.1, denied());
    }

    #[sqlx::test(migrations = false)]
    async fn paths_that_leave_the_media_root_or_the_disk_are_denied(pool: PgPool) {
        let w = world(pool).await;
        for id in [w.escaping, w.linked, w.missing] {
            let (s, b) = resolve(&w, json!({"mediaId": id, "credential": format!("Bearer {}", w.admin.1), "purpose": "stream"})).await;
            assert_eq!((s, b), (200, denied()), "file {id}");
        }
    }

    #[sqlx::test(migrations = false)]
    async fn a_subtitle_without_a_path_or_outside_the_root_is_denied(pool: PgPool) {
        let w = world(pool).await;
        let media: i32 = sqlx::query_scalar(r#"SELECT "mediaId" FROM media_files WHERE id = $1"#)
            .bind(w.file)
            .fetch_one(&w.c.pool)
            .await
            .unwrap();
        for rel in [None, Some("../secret.mkv"), Some("nope.srt"), Some("  ")] {
            let id: i32 = sqlx::query_scalar(r#"INSERT INTO subtitle_files (language, "providerType", "filePath", "mediaId") VALUES ('en', 'disk', $1, $2) RETURNING id"#)
                .bind(rel)
                .bind(media)
                .fetch_one(&w.c.pool)
                .await
                .unwrap();
            let body = json!({"mediaId": w.file, "credential": format!("Bearer {}", w.admin.1), "purpose": "subtitle", "subtitleId": id});
            assert_eq!(resolve(&w, body).await.1, denied(), "{rel:?}");
        }
    }

    #[sqlx::test(migrations = false)]
    async fn bad_users_and_bad_credentials_are_denied(pool: PgPool) {
        let w = world(pool).await;
        let off = user(&w.c.pool, "off", false, false).await;
        let off_token = w.c.st.jwt.sign_access(off, "off").unwrap().token;
        let forged =
            crate::auth_token::Jwt::new("another-secret-of-32-bytes-or-more!!", 3600, 3600)
                .sign_access(w.member.0, "member")
                .unwrap()
                .token;
        let gone = w.c.st.jwt.sign_access(999_999, "gone").unwrap().token;
        for (name, credential) in [
            ("a disabled user", format!("Bearer {off_token}")),
            ("an unknown user", format!("Bearer {gone}")),
            ("a forged token", format!("Bearer {forged}")),
            ("garbage", "Bearer nope".to_owned()),
            ("an empty credential", String::new()),
            ("a cookie without the token", "a=b".to_owned()),
            ("an empty cookie token", "fliks_access=".to_owned()),
        ] {
            let (s, b) = resolve(
                &w,
                json!({"mediaId": w.file, "credential": credential, "purpose": "stream"}),
            )
            .await;
            assert_eq!((s, b), (200, denied()), "{name}");
        }
    }

    #[sqlx::test(migrations = false)]
    async fn media_ids_that_are_not_file_ids_are_denied_and_strings_are_parsed(pool: PgPool) {
        let w = world(pool).await;
        let cred = format!("Bearer {}", w.member.1);
        for bad in [
            json!("abc"),
            json!(0),
            json!(-3),
            json!(1.5),
            json!(true),
            json!(["1"]),
            json!(1e12),
        ] {
            let (s, b) = resolve(
                &w,
                json!({"mediaId": bad, "credential": cred, "purpose": "stream"}),
            )
            .await;
            assert_eq!((s, b), (200, denied()), "{bad}");
        }
        let (_, b) = resolve(
            &w,
            json!({"mediaId": w.file.to_string(), "credential": cred, "purpose": "stream"}),
        )
        .await;
        assert_eq!(b["allow"], true);
    }

    #[sqlx::test(migrations = false)]
    async fn live_goes_to_nest_with_the_user_and_nests_answer_comes_back(pool: PgPool) {
        let w = world(pool).await;
        let ask = |viewer: Value| {
            resolve(
                &w,
                json!({"mediaId": viewer, "credential": format!("Bearer {}", w.member.1), "purpose": "live"}),
            )
        };
        let (s, b) = ask(json!("sid-1")).await;
        assert_eq!(
            (s, b),
            (
                200,
                json!({"allow": true, "ownerId": w.member.0.to_string(), "ttlS": 0.0})
            )
        );
        ask(json!(5)).await;
        let calls = w.c.nest.calls.lock().unwrap().clone();
        let live: Vec<_> = calls
            .iter()
            .filter(|(p, _, _)| p == "/engine/resolve")
            .collect();
        assert_eq!(live[0].1, "Bearer bridge-token");
        assert_eq!(
            live[0].2,
            json!({"mediaId": "sid-1", "userId": w.member.0, "purpose": "live"})
        );
        assert_eq!(live[1].2["mediaId"], "5");
        drop(calls);
        *w.c.nest.live.lock().unwrap() = json!({"allow": false, "ttlS": 60});
        assert_eq!(ask(json!("sid-1")).await.1, denied());
        // Unauthenticated: denied without bothering Nest.
        let before = w.c.nest.calls.lock().unwrap().len();
        let (_, b) = resolve(
            &w,
            json!({"mediaId": "sid", "credential": "Bearer nope", "purpose": "live"}),
        )
        .await;
        assert_eq!(b, denied());
        assert_eq!(w.c.nest.calls.lock().unwrap().len(), before);
    }

    #[sqlx::test(migrations = false)]
    async fn a_nest_that_is_down_is_a_host_fault_not_a_denial(pool: PgPool) {
        crate::db::migrate(&pool).await.unwrap();
        let env = [
            ("FLIKS_NEST_URL", "http://127.0.0.1:1"),
            ("FLIKS_BRIDGE_TOKEN", BRIDGE),
        ];
        let cfg = Config::from_lookup(|k| {
            env.iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| v.to_string())
        });
        let st = AppState::new(pool.clone(), cfg, SECRET);
        let id = user(&pool, "u", false, true).await;
        let token = st.jwt.sign_access(id, "u").unwrap().token;
        let upstream = fliks_engine::gateway::Upstream::parse("http://127.0.0.1:1").unwrap();
        let app = app::router(st.clone(), upstream, None, "/nonexistent".into(), None);
        let host = vec![(
            "authorization",
            format!("Bearer {}", st.engine.host_token()),
        )];
        let (s, _) = call(
            &app,
            "POST",
            "/engine/resolve",
            &host,
            Some(
                json!({"mediaId": "v", "credential": format!("Bearer {token}"), "purpose": "live"}),
            ),
        )
        .await;
        assert_eq!(s, 502);
    }

    #[sqlx::test(migrations = false)]
    async fn only_the_engines_host_token_gets_in_and_bodies_are_validated(pool: PgPool) {
        let w = world(pool).await;
        let body = json!({"mediaId": 1, "credential": "x", "purpose": "stream"});
        let unauthorized = json!({"statusCode": 401, "message": "Unauthorized"});
        for headers in [
            vec![],
            vec![("authorization", String::new())],
            vec![("authorization", "Bearer".into())],
            vec![("authorization", "Bearer wrong".into())],
            vec![("authorization", w.c.st.engine.host_token().to_owned())],
            vec![("authorization", format!("Bearer {}", w.admin.1))],
        ] {
            let (s, b) = call(
                &w.c.app,
                "POST",
                "/engine/resolve",
                &headers,
                Some(body.clone()),
            )
            .await;
            assert_eq!((s, b), (401, unauthorized.clone()), "{headers:?}");
        }
        let bad = |msgs: Value| {
            (
                400,
                json!({"statusCode": 400, "message": msgs, "error": "Bad Request"}),
            )
        };
        assert_eq!(
            resolve(&w, json!({})).await,
            bad(json!([
                "mediaId should not be null or undefined",
                "credential must be a string",
                "purpose must be one of the following values: stream, download, sprite, subtitle, live"
            ]))
        );
        assert_eq!(
            resolve(
                &w,
                json!({"mediaId": 1, "credential": "x", "purpose": "stream", "extra": 1})
            )
            .await,
            bad(json!(["property extra should not exist"]))
        );
        assert_eq!(
            resolve(
                &w,
                json!({"mediaId": 1, "credential": "x", "purpose": "stream", "subtitleId": -1})
            )
            .await,
            bad(json!(["subtitleId must not be less than 0"]))
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_database_fault_surfaces_as_a_5xx_instead_of_a_cached_denial(pool: PgPool) {
        let w = world(pool).await;
        sqlx::query("ALTER TABLE media_files RENAME TO media_files_gone")
            .execute(&w.c.pool)
            .await
            .unwrap();
        let (s, _) = resolve(&w, json!({"mediaId": w.file, "credential": format!("Bearer {}", w.member.1), "purpose": "stream"})).await;
        assert_eq!(s, 500);
    }
}

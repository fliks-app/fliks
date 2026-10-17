//! Route ownership rule (plan §4.3): every Nest route is either owned by Rust with its method
//! (listed in the OpenAPI document) or reaches the forwarder, never a 405.
use axum::{Router, body::Body, http::Request, routing::any};
use fliks_engine::gateway::Upstream;
use fliks_server::{app, config::Config, state::AppState};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;

fn state() -> AppState {
    let pool = PgPoolOptions::new().connect_lazy_with(PgConnectOptions::new());
    AppState::new(pool, Config::from_lookup(|_| None), "secret")
}

const FORWARDED: &str = "x-fake-nest";

async fn fake_nest() -> Upstream {
    let app = Router::new().fallback(any(|| async { ([(FORWARDED, "1")], "nest") }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    Upstream::parse(&url).unwrap()
}

fn concrete(path: &str) -> String {
    let seg = |s: &str| {
        if s.starts_with([':', '*']) {
            "1".into()
        } else {
            s.to_owned()
        }
    };
    path.split('/').map(seg).collect::<Vec<_>>().join("/")
}

fn openapi_path(path: &str) -> String {
    let seg = |s: &str| match s.strip_prefix(':') {
        Some(n) => format!("{{{n}}}"),
        None => s.to_owned(),
    };
    path.split('/').map(seg).collect::<Vec<_>>().join("/")
}

#[tokio::test]
async fn every_nest_route_is_owned_or_forwarded() {
    let routes: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../../contract/nest-routes.json")).unwrap();
    let doc = serde_json::to_value(app::openapi()).unwrap();
    let router = app::router(
        state(),
        fake_nest().await,
        None,
        "/nonexistent".into(),
        None,
    );
    for r in routes {
        let (method, path) = (r["method"].as_str().unwrap(), r["path"].as_str().unwrap());
        // Bridge routes are loopback-only, never forwarded (asserted below).
        if path.starts_with("/internal/") {
            continue;
        }
        let method = if method == "ALL" { "GET" } else { method };
        let owned = doc["paths"][openapi_path(path)][method.to_lowercase()].is_object();
        let req = Request::builder()
            .method(method)
            .uri(concrete(path))
            .body(Body::empty())
            .unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        assert_ne!(res.status(), 405, "{method} {path}");
        assert_eq!(
            res.headers().contains_key(FORWARDED),
            !owned,
            "{method} {path}"
        );
    }
}

#[test]
fn no_openapi_operation_is_in_the_nest_manifest() {
    let routes: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("../../../contract/nest-routes.json")).unwrap();
    let doc = serde_json::to_value(app::openapi()).unwrap();
    for r in routes {
        let (method, path) = (r["method"].as_str().unwrap(), r["path"].as_str().unwrap());
        // Nest keeps the live delegate Rust calls over the bridge (bridge.md).
        if (method, path) == ("POST", "/engine/resolve") {
            continue;
        }
        let ops = &doc["paths"][openapi_path(path)];
        assert!(
            !ops[method.to_lowercase()].is_object() && !(method == "ALL" && ops.is_object()),
            "{method} {path} is in both Nest and OpenAPI"
        );
    }
}

#[tokio::test]
async fn methods_rust_does_not_own_on_owned_paths_are_forwarded() {
    let doc = serde_json::to_value(app::openapi()).unwrap();
    let router = app::router(
        state(),
        fake_nest().await,
        None,
        "/nonexistent".into(),
        None,
    );
    for (path, ops) in doc["paths"].as_object().unwrap() {
        let uri = path.replace(['{', '}'], "");
        let plugin = uri.strip_prefix("/api/plugins/");
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            let m = method.to_lowercase();
            if ops[&m].is_object() {
                continue;
            }
            // The proxy catches `/api/plugins/:id/*splat` and `:id` routes take literal ids, as in Nest.
            let rust = plugin.is_some_and(|r| {
                r.contains('/') || doc["paths"]["/api/plugins/{pluginId}"][&m].is_object()
            });
            let req = Request::builder()
                .method(method)
                .uri(&uri)
                .body(Body::empty())
                .unwrap();
            let res = router.clone().oneshot(req).await.unwrap();
            assert_eq!(
                res.headers().contains_key(FORWARDED),
                !rust,
                "{method} {path}"
            );
        }
    }
}

#[tokio::test]
async fn unknown_api_paths_forward_but_internal_does_not() {
    let router = app::router(
        state(),
        fake_nest().await,
        None,
        "/nonexistent".into(),
        None,
    );
    for (path, forwarded) in [
        ("/api/unknown/thing", true),
        ("/api", true),
        ("/api/system/liveness", true),
        ("/internal/bridge/emit", false),
        ("/internal", false),
    ] {
        let req = Request::post(path).body(Body::empty()).unwrap();
        let res = router.clone().oneshot(req).await.unwrap();
        assert_eq!(res.headers().contains_key(FORWARDED), forwarded, "{path}");
        if !forwarded {
            assert_eq!(res.status(), 404, "{path}");
            let body = axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["message"], format!("Cannot POST {path}"), "{path}");
        }
    }
}

#[tokio::test]
async fn forwarded_methods_on_owned_paths_skip_the_rust_layers() {
    let router = app::router(
        state(),
        fake_nest().await,
        None,
        "/nonexistent".into(),
        None,
    );
    let send = |m: &str| {
        let req = Request::builder()
            .method(m)
            .uri("/api/system/liveness")
            .header("origin", "http://localhost:4200")
            .body(Body::empty())
            .unwrap();
        router.clone().oneshot(req)
    };
    let get = send("GET").await.unwrap();
    assert_eq!(
        get.headers()["access-control-allow-origin"],
        "http://localhost:4200"
    );
    let post = send("POST").await.unwrap();
    assert!(post.headers().contains_key(FORWARDED));
    assert!(!post.headers().contains_key("access-control-allow-origin"));
    assert!(!post.headers().contains_key("vary"));
    let put = Request::patch("/api/playback/media/1/state")
        .header("origin", "http://localhost:4200")
        .body(Body::empty())
        .unwrap();
    let put = router.clone().oneshot(put).await.unwrap();
    assert!(put.headers().contains_key(FORWARDED));
    assert!(!put.headers().contains_key("access-control-allow-origin"));
    // A preflight on a fully owned path stays with the Rust CORS layer.
    let preflight = Request::options("/api/auth/login")
        .header("origin", "http://localhost:4200")
        .header("access-control-request-method", "POST")
        .body(Body::empty())
        .unwrap();
    let preflight = router.clone().oneshot(preflight).await.unwrap();
    assert_eq!(preflight.status(), 204);
    assert!(!preflight.headers().contains_key(FORWARDED));
    assert_eq!(
        preflight.headers()["access-control-allow-origin"],
        "http://localhost:4200"
    );
    let req = Request::get("/engine/resolve").body(Body::empty()).unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert!(res.headers().contains_key(FORWARDED), "GET /engine/resolve");
}

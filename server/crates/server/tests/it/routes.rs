//! The OpenAPI document is the route list: every operation answers on its path, anything else gets
//! the 4.x `Cannot <METHOD> <url>` 404, never a 405.
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::time::Duration;
use tower::ServiceExt;

fn router() -> Router {
    let db = PgConnectOptions::new().host("127.0.0.1").port(1);
    let pool = PgPoolOptions::new()
        .acquire_timeout(Duration::from_millis(200))
        .connect_lazy_with(db);
    let st = AppState::new(pool, Config::from_lookup(|_| None), "secret");
    app::router(st, None, "/nonexistent".into(), None)
}

async fn send(router: &Router, method: &str, uri: &str) -> (u16, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn cannot(method: &str, uri: &str) -> Value {
    Value::String(format!("Cannot {method} {uri}"))
}

#[tokio::test]
async fn every_openapi_operation_answers_on_its_path() {
    let doc = serde_json::to_value(app::openapi()).unwrap();
    let router = router();
    for (path, ops) in doc["paths"].as_object().unwrap() {
        let uri = path.replace(['{', '}'], "");
        for method in ops.as_object().unwrap().keys() {
            let method = method.to_uppercase();
            let (status, body) = send(&router, &method, &uri).await;
            assert_ne!(status, 405, "{method} {path}");
            assert_ne!(body["message"], cannot(&method, &uri), "{method} {path}");
        }
    }
}

#[tokio::test]
async fn undeclared_methods_and_unknown_api_paths_get_the_cannot_method_404() {
    let doc = serde_json::to_value(app::openapi()).unwrap();
    let router = router();
    for (path, ops) in doc["paths"].as_object().unwrap() {
        let uri = path.replace(['{', '}'], "");
        let plugin = uri.strip_prefix("/api/plugins/");
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE"] {
            let m = method.to_lowercase();
            // The proxy catches `/api/plugins/:id/*splat` and `:id` routes take literal ids.
            let proxied = plugin.is_some_and(|r| {
                r.contains('/') || doc["paths"]["/api/plugins/{pluginId}"][&m].is_object()
            });
            if ops[&m].is_object() || proxied {
                continue;
            }
            let (status, body) = send(&router, method, &uri).await;
            assert_eq!(
                (status, &body["message"]),
                (404, &cannot(method, &uri)),
                "{method} {path}"
            );
        }
    }
    for uri in ["/api", "/api/", "/api/unknown/thing", "/engine/resolve"] {
        let (status, body) = send(&router, "GET", uri).await;
        assert_eq!(
            (status, &body["message"]),
            (404, &cannot("GET", uri)),
            "{uri}"
        );
    }
}

#[tokio::test]
async fn undeclared_methods_and_preflights_carry_the_cors_layer() {
    let router = router();
    let req = |m: &str, uri: &str| {
        Request::builder()
            .method(m)
            .uri(uri)
            .header("origin", "http://localhost:4200")
            .header("access-control-request-method", "POST")
            .body(Body::empty())
            .unwrap()
    };
    let preflight = router
        .clone()
        .oneshot(req("OPTIONS", "/api/auth/login"))
        .await
        .unwrap();
    assert_eq!(preflight.status(), 204);
    let post = router
        .clone()
        .oneshot(req("POST", "/api/system/liveness"))
        .await
        .unwrap();
    assert_eq!(post.status(), 404);
    for res in [preflight, post] {
        assert_eq!(
            res.headers()["access-control-allow-origin"],
            "http://localhost:4200"
        );
    }
}

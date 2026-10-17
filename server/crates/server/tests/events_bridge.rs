//! `/internal/events*` and `/internal/activity*` (`docs/bridge.md`): bearer, wire shapes, effects on the hub.
use axum::{body::Body, http::Request};
use fliks_server::{
    config::Config,
    events::{self, Identity},
    state::AppState,
};
use serde_json::{Value, json};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tower::ServiceExt;

fn state() -> AppState {
    let pool = PgPoolOptions::new().connect_lazy_with(PgConnectOptions::new());
    AppState::new(pool, Config::from_lookup(|_| None), "secret")
}

async fn call(
    st: &AppState,
    method: &str,
    uri: &str,
    body: Option<Value>,
    bearer: bool,
) -> (u16, Value) {
    let mut req = Request::builder().method(method).uri(uri);
    if bearer {
        req = req.header("authorization", format!("Bearer {}", st.cfg.bridge_token));
    }
    let body = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Body::from(b.to_string())
        }
        None => Body::empty(),
    };
    let res = events::router()
        .with_state(st.clone())
        .oneshot(req.body(body).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn every_internal_route_needs_the_bridge_bearer() {
    let st = state();
    for (m, u) in [
        ("POST", "/internal/events"),
        ("GET", "/internal/events/stream"),
        ("POST", "/internal/activity"),
        ("POST", "/internal/activity/claim"),
    ] {
        let body = (m == "POST").then(|| json!({}));
        assert_eq!(call(&st, m, u, body, false).await.0, 401, "{m} {u}");
    }
}

#[tokio::test]
async fn posted_events_reach_the_right_connections() {
    let st = state();
    let mut stream = st.hub.subscribe();
    let (_a, _b) = (
        st.hub.connect(1, Identity::default()),
        st.hub.connect(2, Identity::default()),
    );
    let post = |b: Value| call(&st, "POST", "/internal/events", Some(b), true);
    let ev = json!({"type": "queue.updated"});
    assert_eq!(post(json!({"kind": "sse", "event": ev})).await.0, 204);
    assert_eq!(
        post(json!({"kind": "sse", "event": ev, "userId": 1}))
            .await
            .0,
        204
    );
    assert_eq!(
        post(json!({"kind": "sse", "event": ev, "userIds": [1, 2]}))
            .await
            .0,
        204
    );
    let raw = json!({"type": "plugin.a.b", "payload": {"x": 1}});
    assert_eq!(
        post(json!({"kind": "raw", "event": raw, "userIds": [2]}))
            .await
            .0,
        204
    );
    let dom = json!({"type": "settings.changed", "key": "k"});
    assert_eq!(post(json!({"kind": "domain", "event": dom})).await.0, 204);
    for _ in 0..5 {
        stream.try_recv().unwrap();
    }
    assert!(stream.try_recv().is_err());
    for bad in [
        json!({"kind": "sse", "event": ev, "userId": 1, "userIds": [1]}),
        json!({"kind": "raw", "event": {"type": "remote.command", "payload": 1}}),
        json!({"kind": "domain", "event": dom, "userId": 1}),
        json!({"kind": "sse", "event": {"type": "nope"}}),
    ] {
        assert!(post(bad.clone()).await.0 >= 400, "{bad}");
    }
}

#[tokio::test]
async fn activity_and_progress_bridges_round_trip() {
    let st = state();
    let post = |b: Value| call(&st, "POST", "/internal/activity", Some(b), true);
    assert_eq!(
        post(
            json!({"op": "pending", "id": "Rescan:1", "type": "Rescan", "subject": {"title": "T"}})
        )
        .await
        .0,
        204
    );
    assert_eq!(
        post(
            json!({"op": "running", "id": "Rescan:1", "type": "Rescan", "current": 1, "total": 2})
        )
        .await
        .0,
        204
    );
    let claim = || {
        let body = json!({"id": "Rescan:1", "type": "Rescan"});
        call(&st, "POST", "/internal/activity/claim", Some(body), true)
    };
    assert_eq!(claim().await.0, 409);
    assert_eq!(post(json!({"op": "remove", "id": "Rescan:1"})).await.0, 204);
    assert_eq!(claim().await.0, 204);
    assert_eq!(claim().await.0, 409);
}

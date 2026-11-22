//! The listener answers from the first instant: liveness 200 and 503 "starting" elsewhere until
//! the app router is published, so a healthcheck never fails during a long pre-migration dump.
use axum::{
    Router,
    extract::{Request, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use std::sync::{Arc, OnceLock};
use tower::ServiceExt;

pub type Slot = Arc<OnceLock<Router>>;

const LIVENESS: &str = "/api/system/liveness";

pub fn gate(slot: Slot) -> Router {
    Router::new().fallback(forward).with_state(slot)
}

async fn forward(State(slot): State<Slot>, req: Request) -> Response {
    if let Some(app) = slot.get() {
        return app.clone().oneshot(req).await.into_response();
    }
    if req.uri().path() == LIVENESS {
        return crate::system::liveness().await.into_response();
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "5")],
        "starting",
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::get};

    async fn status(app: &Router, path: &str) -> StatusCode {
        let req = Request::get(path).body(Body::empty()).unwrap();
        app.clone().oneshot(req).await.unwrap().status()
    }

    #[tokio::test]
    async fn starting_then_published() {
        let slot = Slot::default();
        let g = gate(slot.clone());
        assert_eq!(status(&g, LIVENESS).await, StatusCode::OK);
        assert_eq!(status(&g, "/api/x").await, StatusCode::SERVICE_UNAVAILABLE);
        let _ = slot.set(Router::new().route("/api/x", get(|| async { "ok" })));
        assert_eq!(status(&g, "/api/x").await, StatusCode::OK);
        assert_eq!(status(&g, "/api/y").await, StatusCode::NOT_FOUND);
    }
}

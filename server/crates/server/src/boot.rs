//! The listener answers from the first instant: liveness 200, the client's files, and 503 "starting"
//! elsewhere until the app router is published, so a healthcheck never fails during a long pre-migration dump.
use axum::{
    Json, Router,
    extract::{Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use std::path::PathBuf;
use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use tower::ServiceExt;

use crate::http::{layers, static_files};

pub type Slot = Arc<OnceLock<Router>>;
/// Set once the boot knows it will run migrations: the server is finishing an update.
pub type Upgrading = Arc<AtomicBool>;

/// The `message` of the boot 503; the client blocks the app until the server answers again.
pub const STARTING: &str = "errors.starting";

pub fn gate(slot: Slot, booting: Router) -> Router {
    Router::new().fallback(forward).with_state((slot, booting))
}

async fn forward(State((slot, booting)): State<(Slot, Router)>, req: Request) -> Response {
    let app = slot.get().unwrap_or(&booting).clone();
    app.oneshot(req).await.into_response()
}

#[derive(Clone)]
struct Booting {
    client: Router,
    dir: Option<PathBuf>,
    upgrading: Upgrading,
}

/// What the gate serves until the app is published, behind the app's own layers (CORS for native clients).
pub fn booting(
    client_dir: Option<PathBuf>,
    cors_origin: Option<String>,
    upgrading: Upgrading,
) -> Router {
    let state = Booting {
        client: static_files::router(client_dir.clone()),
        dir: client_dir,
        upgrading,
    };
    let router = crate::system::router().merge(Router::new().fallback(fallback).with_state(state));
    layers::apply(router, cors_origin, crate::app::BODY_LIMIT_BYTES, |_| true)
}

async fn fallback(State(b): State<Booting>, req: Request) -> Response {
    if let Some(file) = client_file(&b, &req)
        && (file.html
            || tokio::fs::metadata(&file.path)
                .await
                .is_ok_and(|m| m.is_file()))
    {
        return b.client.oneshot(req).await.into_response();
    }
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::RETRY_AFTER, "5")],
        Json(serde_json::json!({
            "message": STARTING,
            "upgrading": b.upgrading.load(Ordering::Relaxed),
        })),
    )
        .into_response()
}

struct ClientFile {
    path: PathBuf,
    html: bool,
}

/// A browser loading the client gets its files; the routes the app owns (API, engine workers, Kobo,
/// Subsonic) wait, so their clients retry instead of reading an SPA page or a 404.
fn client_file(b: &Booting, req: &Request) -> Option<ClientFile> {
    let dir = b.dir.as_ref()?;
    let path = req.uri().path();
    if !matches!(*req.method(), Method::GET | Method::HEAD)
        || path == "/api"
        || path.starts_with("/api/")
        || path.contains("..")
    {
        return None;
    }
    let html = req
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| a.contains("text/html"));
    Some(ClientFile {
        path: dir.join(path.trim_start_matches('/')),
        html,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::get};

    async fn call(app: &Router, method: Method, path: &str, accept: &str) -> Response {
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::ACCEPT, accept)
            .body(Body::empty())
            .unwrap();
        app.clone().oneshot(req).await.unwrap()
    }

    async fn body(res: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn starting_then_published() {
        let dir = std::env::temp_dir().join(format!("fliks-boot-{}", crate::config::random_hex(4)));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<html></html>").unwrap();
        std::fs::write(dir.join("main.js"), "").unwrap();
        let slot = Slot::default();
        let upgrading = Upgrading::default();
        let g = gate(
            slot.clone(),
            booting(Some(dir.clone()), None, upgrading.clone()),
        );
        let html = "text/html,*/*";
        let ok = |r: &Response| r.status() == StatusCode::OK;
        let starting = |r: &Response| r.status() == StatusCode::SERVICE_UNAVAILABLE;
        assert!(ok(
            &call(&g, Method::GET, "/api/system/liveness", "*/*").await
        ));
        assert!(ok(&call(&g, Method::GET, "/", html).await));
        assert!(ok(&call(&g, Method::GET, "/library/1", html).await));
        assert!(ok(&call(&g, Method::GET, "/main.js", "*/*").await));
        assert!(starting(
            &call(&g, Method::GET, "/kobo/t/v1/library/sync", "*/*").await
        ));
        assert!(starting(
            &call(&g, Method::POST, "/engine/workers/hello", "*/*").await
        ));
        assert!(starting(&call(&g, Method::GET, "/api/x", html).await));
        let res = call(&g, Method::GET, "/api/x", "*/*").await;
        assert!(starting(&res));
        assert_eq!(body(res).await["upgrading"], false);
        upgrading.store(true, Ordering::Relaxed);
        let res = call(&g, Method::POST, "/api/x", "*/*").await;
        assert_eq!(body(res).await["upgrading"], true);
        let _ = slot.set(Router::new().route("/api/x", get(|| async { "ok" })));
        assert!(ok(&call(&g, Method::GET, "/api/x", "*/*").await));
        assert_eq!(
            call(&g, Method::GET, "/api/y", "*/*").await.status(),
            StatusCode::NOT_FOUND
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}

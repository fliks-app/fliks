use crate::http::{layers, static_files};
use crate::system;
use axum::{Router, http::StatusCode, routing::any, routing::any_service};
use fliks_engine::gateway::{self, RouteTable, Upstream};
use std::path::PathBuf;
use utoipa::OpenApi;

/// Nest's default JSON limit (`bootstrap.md` rule 10).
pub const BODY_LIMIT_BYTES: usize = 100 * 1024;

/// A route is ported iff it is listed here (plan §4.3).
#[derive(OpenApi)]
#[openapi(info(title = "Fliks", version = "1"), paths(system::liveness))]
pub struct ApiDoc;

/// Rust-owned routes and static files get the layers; the forwarded paths do not, as Nest sets its own CORS headers.
pub fn router(
    nest: Upstream,
    client_dir: Option<PathBuf>,
    cast_dir: PathBuf,
    cors_origin: Option<String>,
) -> Router {
    let forwarder = gateway::router(
        RouteTable::from_json("[]").expect("empty table"),
        nest,
        None,
    );
    let local = system::router(forwarder.clone())
        .route("/internal", any(StatusCode::NOT_FOUND))
        .route("/internal/", any(StatusCode::NOT_FOUND))
        .route("/internal/{*rest}", any(StatusCode::NOT_FOUND))
        .fallback_service(static_files::router(client_dir, cast_dir));
    let local = layers::apply(local, cors_origin, BODY_LIMIT_BYTES);
    // Nest's only unprefixed route is `/engine/resolve` (bootstrap.md rule 1).
    ["/api", "/api/", "/api/{*rest}", "/engine/resolve"]
        .into_iter()
        .fold(local, |r, p| r.route(p, any_service(forwarder.clone())))
}

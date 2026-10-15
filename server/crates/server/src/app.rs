use crate::http::{layers, static_files};
use crate::{events, state::AppState, system, users};
use axum::{Router, extract::Request, response::Response, routing::any, routing::any_service};
use fliks_engine::gateway::{self, RouteTable, Upstream};
use std::path::PathBuf;
use utoipa::OpenApi;

/// Nest's default JSON limit (`bootstrap.md` rule 10).
pub const BODY_LIMIT_BYTES: usize = 100 * 1024;

/// A route is ported iff it is listed here (plan §4.3).
#[derive(OpenApi)]
#[openapi(
    info(title = "Fliks", version = "1"),
    paths(
        system::liveness,
        events::events,
        events::activity,
        users::list,
        users::create,
        users::get_one,
        users::update,
        users::remove,
        users::stats,
        users::set_avatar,
        users::clear_avatar
    )
)]
pub struct ApiDoc;

/// Rust-owned routes and static files get the layers; the forwarded paths do not, as Nest sets its own CORS headers.
pub fn router(
    state: AppState,
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
    let local = system::router()
        .merge(api().with_state(state))
        .route("/internal", any(internal_404))
        .route("/internal/", any(internal_404))
        .route("/internal/{*rest}", any(internal_404))
        .fallback_service(static_files::router(client_dir, cast_dir));
    // Merged after the layers so Nest answers the other methods unlayered instead of a 405.
    let local = layers::apply(local, cors_origin, BODY_LIMIT_BYTES)
        .route(system::LIVENESS, any_service(forwarder.clone()));
    // Nest's only unprefixed route is `/engine/resolve` (bootstrap.md rule 1).
    ["/api", "/api/", "/api/{*rest}", "/engine/resolve"]
        .into_iter()
        .fold(local, |r, p| r.route(p, any_service(forwarder.clone())))
}

/// Ported domain routers are merged here, one `.merge(...)` per domain.
fn api() -> Router<AppState> {
    Router::new()
        .merge(crate::auth::router())
        .merge(crate::roles::router())
        .merge(crate::settings::router())
        .merge(crate::fs::router())
        .merge(users::router())
        .merge(events::router())
}

async fn internal_404(req: Request) -> Response {
    static_files::cannot(&req)
}

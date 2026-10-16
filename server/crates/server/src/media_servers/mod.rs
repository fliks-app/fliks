//! Emby media servers (`docs/spec/media-servers.md`).
use crate::state::AppState;
use axum::Router;
use utoipa::OpenApi;

/// The routes of this domain, merged into the API document by `app::openapi`.
#[derive(OpenApi)]
#[openapi(paths())]
pub struct Doc;

pub fn router() -> Router<AppState> {
    Router::new()
}

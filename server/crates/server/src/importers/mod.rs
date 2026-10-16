//! Radarr, Sonarr and Seerr importers and the NFO reader (`docs/spec/importers.md`).
mod arr;
mod db;
mod dto;
pub mod nfo;
mod seerr;
mod subtitles;

use crate::{
    http::{AppError, auth::Authed, validate::ValidJson},
    outbound::{base_url, client},
    state::AppState,
};
use arr::Arr;
use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use serde_json::Value;
use std::time::Duration;
use utoipa::OpenApi;

/// The routes of this domain, merged into the API document by `app::openapi`.
#[derive(OpenApi)]
#[openapi(paths(
    radarr_test,
    radarr_preview,
    radarr_import,
    sonarr_test,
    sonarr_preview,
    sonarr_import,
    seerr_test,
    seerr_import_requests
))]
pub struct Doc;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/imports/radarr/test", post(radarr_test))
        .route("/api/imports/radarr/preview", post(radarr_preview))
        .route("/api/imports/radarr", post(radarr_import))
        .route("/api/imports/sonarr/test", post(sonarr_test))
        .route("/api/imports/sonarr/preview", post(sonarr_preview))
        .route("/api/imports/sonarr", post(sonarr_import))
        .route("/api/imports/seerr/test", post(seerr_test))
        .route(
            "/api/imports/seerr/import-requests",
            post(seerr_import_requests),
        )
}

/// `GET` with the key header and the call's own timeout.
async fn fetch(
    url: String,
    key: &str,
    timeout: Duration,
) -> Result<reqwest::Response, reqwest::Error> {
    client()
        .get(url)
        .header("X-Api-Key", key)
        .timeout(timeout)
        .send()
        .await
}

/// Both URLs compared without a trailing `/`, scheme and host case-insensitively (F41).
fn same_url(a: &str, b: &str) -> bool {
    let norm = |u: &str| {
        let base = base_url(u, true);
        reqwest::Url::parse(&base).map_or_else(|_| base.to_lowercase(), String::from)
    };
    norm(a) == norm(b)
}

/// `resolveApiKey`: the key sent, else the stored one when the body URL is the stored URL (F41).
async fn resolve_key(
    st: &AppState,
    provided: Option<String>,
    url: &str,
    key_setting: &str,
    url_setting: &str,
) -> Result<String, AppError> {
    if dto::usable_key(&provided).is_some() {
        return Ok(provided.unwrap_or_default());
    }
    let missing = || AppError::bad_request("apiKey is required");
    let stored = crate::settings::setting_value(&st.db, key_setting)
        .await?
        .filter(|k| !k.is_empty());
    let stored_url = crate::settings::setting_value(&st.db, url_setting).await?;
    match (stored, stored_url) {
        (Some(key), Some(u)) if same_url(url, &u) => Ok(key),
        _ => Err(missing()),
    }
}

macro_rules! arr_routes {
    ($arr:expr, $test:ident, $test_path:literal, $preview:ident, $preview_path:literal, $import:ident, $import_path:literal) => {
        #[utoipa::path(post, path = $test_path, responses((status = 201)))]
        pub(crate) async fn $test(
            State(st): State<AppState>,
            a: Authed,
            ValidJson(body): ValidJson<Value>,
        ) -> Result<(StatusCode, Json<Value>), AppError> {
            Ok((StatusCode::CREATED, arr::test(&st, $arr, a, body).await?))
        }
        #[utoipa::path(post, path = $preview_path, responses((status = 201)))]
        pub(crate) async fn $preview(
            State(st): State<AppState>,
            a: Authed,
            ValidJson(body): ValidJson<Value>,
        ) -> Result<(StatusCode, Json<Value>), AppError> {
            Ok((StatusCode::CREATED, arr::preview(&st, $arr, a, body).await?))
        }
        #[utoipa::path(post, path = $import_path, responses((status = 201)))]
        pub(crate) async fn $import(
            State(st): State<AppState>,
            a: Authed,
            ValidJson(body): ValidJson<Value>,
        ) -> Result<(StatusCode, Json<Value>), AppError> {
            arr::import(&st, $arr, a, body).await
        }
    };
}

arr_routes!(
    Arr::Radarr,
    radarr_test,
    "/api/imports/radarr/test",
    radarr_preview,
    "/api/imports/radarr/preview",
    radarr_import,
    "/api/imports/radarr"
);
arr_routes!(
    Arr::Sonarr,
    sonarr_test,
    "/api/imports/sonarr/test",
    sonarr_preview,
    "/api/imports/sonarr/preview",
    sonarr_import,
    "/api/imports/sonarr"
);

#[utoipa::path(post, path = "/api/imports/seerr/test", responses((status = 201)))]
pub(crate) async fn seerr_test(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    Ok((StatusCode::CREATED, seerr::test(&st, a, body).await?))
}

#[utoipa::path(post, path = "/api/imports/seerr/import-requests", responses((status = 201)))]
pub(crate) async fn seerr_import_requests(
    State(st): State<AppState>,
    a: Authed,
) -> Result<(StatusCode, Json<Value>), AppError> {
    seerr::start(st, a).await
}

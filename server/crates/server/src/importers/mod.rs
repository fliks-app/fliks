//! Radarr, Sonarr and Seerr importers and the NFO reader (`docs/spec/importers.md`).
mod arr;
mod db;
mod dto;
mod lidarr;
pub mod nfo;
mod seerr;
mod subtitles;

use crate::{
    http::{AppError, auth::Authed, validate::ValidJson},
    outbound::{client, same_url},
    state::AppState,
};
use arr::Arr;
use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use fliks_domain::acl::{Action, Subject};
use serde::Deserialize;
use serde_json::{Value, json};
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
    lidarr_test,
    lidarr_preview,
    lidarr_import,
    seerr_test,
    seerr_import_requests,
    map_user
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
        .route("/api/imports/lidarr/test", post(lidarr_test))
        .route("/api/imports/lidarr/preview", post(lidarr_preview))
        .route("/api/imports/lidarr", post(lidarr_import))
        .route("/api/imports/seerr/test", post(seerr_test))
        .route(
            "/api/imports/seerr/import-requests",
            post(seerr_import_requests),
        )
        .route("/api/imports/user-mappings", post(map_user))
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

/// `resolveApiKey`: the key sent, else the stored one when the body URL is the stored URL.
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
    let stored = crate::settings::text(&st.db, key_setting)
        .await?
        .filter(|k| !k.is_empty());
    let stored_url = crate::settings::text(&st.db, url_setting).await?;
    match (stored, stored_url) {
        (Some(key), Some(u)) if same_url(url, &u) => Ok(key),
        _ => Err(missing()),
    }
}

macro_rules! arr_routes_no_import {
    ($arr:expr, $test:ident, $test_path:literal, $preview:ident, $preview_path:literal) => {
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
    };
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
arr_routes_no_import!(
    Arr::Lidarr,
    lidarr_test,
    "/api/imports/lidarr/test",
    lidarr_preview,
    "/api/imports/lidarr/preview"
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

#[utoipa::path(post, path = "/api/imports/lidarr", responses((status = 201)))]
pub(crate) async fn lidarr_import(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    lidarr::import(&st, a, body).await
}

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

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct UserMapping {
    provider: String,
    external_id: String,
    user_id: i32,
}

/// `POST /api/imports/user-mappings`: the admin's answer to an import's `unmapped` entries.
#[utoipa::path(post, path = "/api/imports/user-mappings", responses((status = 201)))]
pub(crate) async fn map_user(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<UserMapping>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    a.require(Action::Manage, Subject::User)?;
    let known = body.provider == "seerr"
        || body
            .provider
            .strip_prefix("emby:")
            .is_some_and(|id| id.parse::<i32>().is_ok());
    if !known || body.external_id.trim().is_empty() {
        return Err(AppError::bad_request("provider or externalId is invalid"));
    }
    crate::users::map_external(&st.db, &body.provider, &body.external_id, body.user_id)
        .await
        .map_err(|e| match e.as_database_error() {
            Some(d) if d.is_foreign_key_violation() => AppError::not_found("User not found"),
            _ => e.into(),
        })?;
    Ok((StatusCode::CREATED, Json(json!({"ok": true}))))
}

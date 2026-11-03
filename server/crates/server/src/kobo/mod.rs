//! Emulated Kobo store API (`docs/spec/kobo.md`), authenticated by a `kobo` device token in the path.
mod books;
mod proxy;
mod shelves;
mod state;
mod sync;

use crate::{
    auth::client_ip,
    device_tokens,
    http::{AppError, auth::Authed, cookies::is_secure},
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{ConnectInfo, FromRequestParts, State},
    http::{
        HeaderMap, HeaderValue, StatusCode,
        header::{CACHE_CONTROL, RETRY_AFTER},
        request::Parts,
    },
    response::{IntoResponse, Response},
    routing::{any, get, post, put},
};
use fliks_domain::acl::{Action, Subject};
use serde_json::{Value, json};
use std::net::SocketAddr;

const BOOK_PREFIX: &str = "f11c5b00";
const SHELF_PREFIX: &str = "f11c5a60";
/// No username can hold a NUL, so this bucket of the login limiter is never a user's.
const THROTTLE_KEY: &str = "\0kobo";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/kobo/{token}/v1/initialization", get(initialization))
        .route("/kobo/{token}/v1/library/sync", get(sync::library_sync))
        .route(
            "/kobo/{token}/v1/library/tags",
            get(shelves::list).post(shelves::create),
        )
        .route(
            "/kobo/{token}/v1/library/tags/{tag}",
            put(shelves::rename).delete(shelves::remove),
        )
        .route(
            "/kobo/{token}/v1/library/tags/{tag}/items",
            post(shelves::add_items),
        )
        .route(
            "/kobo/{token}/v1/library/tags/{tag}/items/delete",
            post(shelves::remove_items),
        )
        .route(
            "/kobo/{token}/v1/library/{uuid}/metadata",
            get(books::metadata),
        )
        .route(
            "/kobo/{token}/v1/library/{uuid}/state",
            get(state::get).put(state::put),
        )
        .route(
            "/kobo/{token}/v1/library/{uuid}",
            axum::routing::delete(sync::archive),
        )
        .route(
            "/kobo/{token}/{uuid}/{w}/{h}/{grey}/image.jpg",
            get(books::cover),
        )
        .route(
            "/kobo/{token}/{uuid}/{w}/{h}/{quality}/{grey}/image.jpg",
            get(books::cover_quality),
        )
        .route("/kobo/{token}/v1/{*rest}", any(proxy::fallback))
}

/// The authenticated caller: the enabled owner of the path token and the libraries they read.
pub struct Kobo {
    pub a: Authed,
    pub token_id: i32,
    pub token: String,
    pub base: String,
    pub acl: Vec<i32>,
}

pub enum Reject {
    Unauthorized,
    Throttled,
    Forbidden,
    Fault(AppError),
}

impl From<sqlx::Error> for Reject {
    fn from(e: sqlx::Error) -> Self {
        Self::Fault(e.into())
    }
}

impl IntoResponse for Reject {
    fn into_response(self) -> Response {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED.into_response(),
            Self::Throttled => (
                StatusCode::TOO_MANY_REQUESTS,
                [(RETRY_AFTER, HeaderValue::from_static("900"))],
            )
                .into_response(),
            Self::Forbidden => StatusCode::FORBIDDEN.into_response(),
            Self::Fault(e) => e.into_response(),
        }
    }
}

/// `http(s)://host` of the request as the device reached it.
fn base_of(h: &HeaderMap) -> String {
    let host = ["x-forwarded-host", "host"]
        .iter()
        .find_map(|k| h.get(*k).and_then(|v| v.to_str().ok()))
        .and_then(|v| v.split(',').next())
        .map_or("localhost", str::trim);
    format!("{}://{host}", if is_secure(h) { "https" } else { "http" })
}

impl FromRequestParts<AppState> for Kobo {
    type Rejection = Reject;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Reject> {
        let peer = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| &c.0);
        let ip = client_ip(&parts.headers, peer);
        let token = parts
            .uri
            .path()
            .strip_prefix("/kobo/")
            .and_then(|p| p.split('/').next())
            .unwrap_or_default()
            .to_owned();
        let fail = || {
            if st.login_throttle.attempt(ip, THROTTLE_KEY) {
                Reject::Unauthorized
            } else {
                Reject::Throttled
            }
        };
        if !device_tokens::well_formed(&token) {
            return Err(fail());
        }
        let (token_id, owner) = device_tokens::kobo_owner(&st.db, &token)
            .await?
            .ok_or_else(fail)?;
        let a = Authed::load(&st.db, owner)
            .await?
            .ok_or(Reject::Unauthorized)?;
        a.require(Action::Read, Subject::Media)
            .map_err(|_| Reject::Forbidden)?;
        let acl = accessible_library_ids(&st.db, &a).await?;
        Ok(Self {
            a,
            token_id,
            token,
            base: base_of(&parts.headers),
            acl,
        })
    }
}

/// `prefix-0000-4000-8000-` and the id as 12 hexadecimal digits.
pub fn uuid(prefix: &str, id: i32) -> String {
    format!("{prefix}-0000-4000-8000-{id:012x}")
}

pub fn parse_uuid(prefix: &str, s: &str) -> Option<i32> {
    let hex = s
        .strip_prefix(prefix)?
        .strip_prefix("-0000-4000-8000-")
        .filter(|h| {
            h.len() == 12
                && h.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })?;
    i32::from_str_radix(hex, 16).ok().filter(|n| *n > 0)
}

pub fn iso(t: chrono::DateTime<chrono::Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// A JSON answer that no cache keeps.
pub fn json_response(status: StatusCode, v: Value) -> Response {
    (
        status,
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        Json(v),
    )
        .into_response()
}

async fn initialization(
    State(st): State<AppState>,
    k: Kobo,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let root = format!("{}/kobo/{}", k.base, k.token);
    let ours = json!({
        "image_host": k.base,
        "image_url_template": format!("{root}/{{ImageId}}/{{Width}}/{{Height}}/false/image.jpg"),
        "image_url_quality_template": format!("{root}/{{ImageId}}/{{Width}}/{{Height}}/{{Quality}}/{{IsGreyscale}}/image.jpg"),
        "library_sync": format!("{root}/v1/library/sync"),
        "library_metadata": format!("{root}/v1/library/{{Ids}}/metadata"),
        "tags": format!("{root}/v1/library/tags"),
        "user_profile": format!("{root}/v1/user/profile"),
        "user_loyalty_benefits": format!("{root}/v1/user/loyalty/benefits"),
        "kobo_audiobooks_enabled": "False",
        "kobo_nativeborrow_enabled": "False",
        "kobo_subscriptions_enabled": "False",
        "kobo_superpoints_enabled": "False",
    });
    let mut resources = if proxy::enabled(&st).await? {
        proxy::store_resources(&headers).await.unwrap_or_default()
    } else {
        serde_json::Map::new()
    };
    resources.extend(ours.as_object().cloned().unwrap_or_default());
    let mut res = json_response(StatusCode::OK, json!({ "Resources": resources }));
    res.headers_mut()
        .insert("x-kobo-apitoken", HeaderValue::from_static("e30="));
    Ok(res)
}

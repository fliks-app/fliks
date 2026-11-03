//! Everything the server does not handle (`kobo.md` rules 6 and 25): the optional store proxy, else stubs.
use super::{BOOK_PREFIX, Kobo, json_response, original_path, parse_uuid};
use crate::{http::AppError, settings::setting_value, state::AppState};
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Redirect, Response},
};
use reqwest::{Client, redirect};
use serde_json::{Map, Value, json};
use std::{sync::OnceLock, time::Duration};

const STORE: &str = "https://storeapi.kobo.com";
const CDN: &str = "https://cdn.kobo.com/book-images";
const SETTING: &str = "kobo_store_proxy";
const FORWARDED: [&str; 4] = ["authorization", "content-type", "accept", "user-agent"];
const MAX_BODY: usize = 1 << 20;
const MAX_ANSWER: usize = 8 << 20;

pub async fn enabled(st: &AppState) -> Result<bool, sqlx::Error> {
    Ok(setting_value(&st.db, SETTING).await?.as_deref() == Some("true"))
}

/// Whether `id` is a store book the proxy must answer: not one of ours, and the proxy is on.
pub async fn store_book(st: &AppState, id: &str) -> Result<bool, sqlx::Error> {
    if parse_uuid(BOOK_PREFIX, id).is_some() {
        return Ok(false);
    }
    enabled(st).await
}

/// The store's CDN for the cover of a store book; ids that are no uuid or sizes that are no number name nothing.
pub fn store_cover(id: &str, w: &str, h: &str) -> Response {
    let uuid = id.len() == 36 && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
    if !uuid || w.parse::<u32>().is_err() || h.parse::<u32>().is_err() {
        return StatusCode::NOT_FOUND.into_response();
    }
    Redirect::temporary(&format!("{CDN}/{id}/{w}/{h}/false/image.jpg")).into_response()
}

/// No redirect is followed: the host is fixed.
fn client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .redirect(redirect::Policy::none())
            .build()
            .expect("store client")
    })
}

fn request(
    method: Method,
    url: &str,
    headers: &HeaderMap,
    timeout: u64,
) -> reqwest::RequestBuilder {
    let mut r = client()
        .request(method, url)
        .timeout(Duration::from_secs(timeout));
    for (k, v) in headers {
        if FORWARDED.contains(&k.as_str()) || k.as_str().starts_with("x-kobo-") {
            r = r.header(k, v);
        }
    }
    r
}

/// The store's own `Resources`, for the keys this server does not serve.
pub async fn store_resources(headers: &HeaderMap) -> Option<Map<String, Value>> {
    let res = request(
        Method::GET,
        &format!("{STORE}/v1/initialization"),
        headers,
        5,
    )
    .send()
    .await
    .ok()?;
    let mut body: Value = res.json().await.ok()?;
    match body["Resources"].take() {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// The request, path after the token and all, sent to the store.
pub async fn forward(req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let path = original_path(&parts);
    let tail = path
        .strip_prefix("/kobo/")
        .and_then(|p| p.split_once('/'))
        .map_or("v1", |(_, t)| t);
    let url = match parts.uri.query() {
        Some(q) => format!("{STORE}/{tail}?{q}"),
        None => format!("{STORE}/{tail}"),
    };
    let Ok(body) = to_bytes(body, MAX_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let bad = || StatusCode::BAD_GATEWAY.into_response();
    let Ok(mut res) = request(parts.method, &url, &parts.headers, 30)
        .body(body)
        .send()
        .await
    else {
        return bad();
    };
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let kind = res.headers().get(CONTENT_TYPE).cloned();
    let mut bytes = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(c)) if bytes.len() + c.len() <= MAX_ANSWER => bytes.extend_from_slice(&c),
            Ok(None) => break,
            _ => return bad(),
        }
    }
    let mut out = (status, bytes).into_response();
    if let Some(v) = kind.and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
        out.headers_mut().insert(CONTENT_TYPE, v);
    }
    out
}

fn stub(k: &Kobo, rest: &str, body: &[u8]) -> Value {
    match rest {
        "user/profile" => json!({"UserId": k.a.user.id.to_string(), "Email": ""}),
        "user/loyalty/benefits" => json!({"Benefits": {}}),
        "analytics/gettests" => json!({"Result": "Success", "TestKey": "", "Tests": {}}),
        "auth/device" => {
            let key = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|b| b["UserKey"].as_str().map(str::to_owned))
                .unwrap_or_else(|| "fliks".into());
            json!({
                "AccessToken": "fliks", "RefreshToken": "fliks", "TokenType": "Bearer",
                "TrackingId": "00000000-0000-0000-0000-000000000000", "UserKey": key,
            })
        }
        "user/wishlist" | "deals" => json!([]),
        _ => json!({}),
    }
}

pub async fn fallback(
    State(st): State<AppState>,
    k: Kobo,
    req: Request,
) -> Result<Response, AppError> {
    if enabled(&st).await? {
        return Ok(forward(req).await);
    }
    let (parts, body) = req.into_parts();
    let path = original_path(&parts);
    let rest = path
        .strip_prefix("/kobo/")
        .and_then(|p| p.split_once("/v1/"))
        .map_or("", |(_, r)| r);
    let body = to_bytes(body, MAX_BODY).await.unwrap_or_default();
    Ok(json_response(StatusCode::OK, stub(&k, rest, &body)))
}

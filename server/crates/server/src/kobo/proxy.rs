//! Everything the server does not handle (`kobo.md` rules 6 and 25): the optional store proxy, else stubs.
use super::{Kobo, json_response};
use crate::{http::AppError, outbound, settings::setting_value, state::AppState};
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use serde_json::{Map, Value, json};
use std::time::Duration;

const STORE: &str = "https://storeapi.kobo.com";
const SETTING: &str = "kobo_store_proxy";
const FORWARDED: [&str; 4] = ["authorization", "content-type", "accept", "user-agent"];

pub async fn enabled(st: &AppState) -> Result<bool, sqlx::Error> {
    Ok(setting_value(&st.db, SETTING).await?.as_deref() == Some("true"))
}

fn request(method: Method, url: &str, headers: &HeaderMap) -> reqwest::RequestBuilder {
    let mut r = outbound::client()
        .request(method, url)
        .timeout(Duration::from_secs(30));
    for (k, v) in headers {
        if FORWARDED.contains(&k.as_str()) || k.as_str().starts_with("x-kobo-") {
            r = r.header(k, v);
        }
    }
    r
}

/// The store's own `Resources`, for the keys this server does not serve.
pub async fn store_resources(headers: &HeaderMap) -> Option<Map<String, Value>> {
    let res = request(Method::GET, &format!("{STORE}/v1/initialization"), headers)
        .send()
        .await
        .ok()?;
    let mut body: Value = res.json().await.ok()?;
    match body["Resources"].take() {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn stub(k: &Kobo, rest: &str) -> Value {
    match rest {
        "user/profile" => json!({"UserId": k.a.user.id.to_string(), "Email": ""}),
        "user/loyalty/benefits" => json!({"Benefits": {}}),
        "analytics/gettests" => json!({"Result": "Success", "TestKey": "", "Tests": {}}),
        "auth/device" => json!({
            "AccessToken": "fliks", "RefreshToken": "fliks", "TokenType": "Bearer",
            "TrackingId": "00000000-0000-0000-0000-000000000000", "UserKey": "fliks",
        }),
        "user/wishlist" | "deals" => json!([]),
        _ => json!({}),
    }
}

pub async fn fallback(
    State(st): State<AppState>,
    k: Kobo,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, AppError> {
    let tail = uri
        .path()
        .strip_prefix("/kobo/")
        .and_then(|p| p.split_once('/'))
        .map_or("v1", |(_, t)| t);
    if !enabled(&st).await? {
        let rest = tail.strip_prefix("v1/").unwrap_or_default();
        return Ok(json_response(StatusCode::OK, stub(&k, rest)));
    }
    let url = match uri.query() {
        Some(q) => format!("{STORE}/{tail}?{q}"),
        None => format!("{STORE}/{tail}"),
    };
    let Ok(res) = request(method, &url, &headers).body(body).send().await else {
        return Ok(StatusCode::BAD_GATEWAY.into_response());
    };
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let kind = res.headers().get(CONTENT_TYPE).cloned();
    let Ok(bytes) = res.bytes().await else {
        return Ok(StatusCode::BAD_GATEWAY.into_response());
    };
    let mut out = (status, bytes).into_response();
    if let Some(v) = kind.and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
        out.headers_mut().insert(CONTENT_TYPE, v);
    }
    Ok(out)
}

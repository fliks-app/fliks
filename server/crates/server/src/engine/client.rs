//! HTTP client of the engine control plane (`engine-glue.md` section A): bearer, JSON, no retries.
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use reqwest::{Method, StatusCode, header::HeaderMap};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::time::Duration;

const CONTROL_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// JS `encodeURIComponent`.
const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// One path segment or query value.
pub fn enc(s: &str) -> String {
    utf8_percent_encode(s, COMPONENT).to_string()
}

/// `path` plus `?k=v&k=v` for the entries that are set.
pub fn with_query(path: &str, query: &[(&str, Option<String>)]) -> String {
    let qs: Vec<String> = query
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|v| format!("{}={}", enc(k), enc(v))))
        .collect();
    if qs.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{}", qs.join("&"))
    }
}

/// An engine answer; `body` is only parsed when the content type says JSON.
pub struct Reply {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Option<Value>,
}

impl Reply {
    pub fn ok(&self) -> bool {
        self.status.is_success()
    }

    /// The 2xx JSON body as `T`; `None` on any other status or a body that is not a `T`.
    pub fn data<T: DeserializeOwned>(&self) -> Option<T> {
        self.parse().ok()
    }

    /// The body as `T`, or why it is not one.
    pub fn parse<T: DeserializeOwned>(&self) -> Result<T, String> {
        if !self.ok() {
            return Err(format!("status {}", self.status.as_u16()));
        }
        let body = self.body.as_ref().ok_or("no JSON body")?;
        T::deserialize(body).map_err(|e| e.to_string())
    }

    /// The `code` of an error body (`live_at_capacity`, ...).
    pub fn code(&self) -> Option<String> {
        self.body.as_ref()?.get("code")?.as_str().map(str::to_owned)
    }

    /// `Retry-After` seconds when positive, else 1.
    pub fn retry_after_secs(&self) -> f64 {
        self.headers
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(fliks_engine_core::jsnum::number)
            .filter(|s| *s > 0.0)
            .unwrap_or(1.0)
    }
}

#[derive(Clone)]
pub struct Client {
    control: reqwest::Client,
    events: reqwest::Client,
    base: String,
    token: String,
}

impl Client {
    pub fn new(url: &str, token: &str) -> Self {
        let build = |timeout: Option<Duration>| {
            let mut b = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT);
            if let Some(t) = timeout {
                b = b.timeout(t);
            }
            b.build().expect("reqwest client")
        };
        let url = url.trim();
        Self {
            control: build(Some(CONTROL_TIMEOUT)),
            events: build(None),
            base: url.strip_suffix('/').unwrap_or(url).to_owned(),
            token: token.trim().to_owned(),
        }
    }

    pub async fn get(
        &self,
        path: &str,
        query: &[(&str, Option<String>)],
    ) -> reqwest::Result<Reply> {
        self.finish(self.request(Method::GET, &with_query(path, query)))
            .await
    }

    pub async fn delete(
        &self,
        path: &str,
        query: &[(&str, Option<String>)],
    ) -> reqwest::Result<Reply> {
        self.finish(self.request(Method::DELETE, &with_query(path, query)))
            .await
    }

    /// `Content-Type: application/json` only here, where a body is sent.
    pub async fn send<B: Serialize + ?Sized>(
        &self,
        method: Method,
        path: &str,
        body: &B,
    ) -> reqwest::Result<Reply> {
        self.finish(self.request(method, path).json(body)).await
    }

    /// The raw `GET /v1/events` response: no timeout, the caller owns its lifetime.
    pub async fn events(&self) -> reqwest::Result<reqwest::Response> {
        self.events
            .get(format!("{}/v1/events", self.base))
            .bearer_auth(&self.token)
            .header("accept", "text/event-stream")
            .send()
            .await
    }

    fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.control
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.token)
    }

    async fn finish(&self, req: reqwest::RequestBuilder) -> reqwest::Result<Reply> {
        let res = req.send().await?;
        let (status, headers) = (res.status(), res.headers().clone());
        let json = headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.contains("json"));
        let body = if json {
            res.json::<Value>().await.ok()
        } else {
            None
        };
        Ok(Reply {
            status,
            headers,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn components_and_queries_are_encoded_like_the_host_did() {
        assert_eq!(enc("a b/c?é-_.!~*'()"), "a%20b%2Fc%3F%C3%A9-_.!~*'()");
        let q = with_query(
            "/v1/sessions",
            &[
                ("ownerId", Some("u 1".into())),
                ("mediaFileId", None),
                ("reason", Some("x".into())),
            ],
        );
        assert_eq!(q, "/v1/sessions?ownerId=u%201&reason=x");
        assert_eq!(with_query("/v1/cache", &[("a", None)]), "/v1/cache");
    }

    #[test]
    fn base_loses_one_trailing_slash() {
        assert_eq!(Client::new(" http://e:1// ", "t").base, "http://e:1/");
        assert_eq!(Client::new("http://e:1/", "t").base, "http://e:1");
    }
}

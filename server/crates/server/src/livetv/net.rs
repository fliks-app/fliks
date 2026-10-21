//! Outbound requests of live TV: one identity, validators, idle timeout, redirect limit, body cap.
//! Errors never carry the request URL, userinfo or query.
use crate::vetted;
use reqwest::{
    Client, ClientBuilder, Response, StatusCode, Url,
    header::{
        ETAG, HeaderMap, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, REFERER, USER_AGENT,
    },
    redirect,
};
use std::time::Duration;

/// Providers block the ffmpeg and HTTP-library agents outright: every request goes out as VLC.
pub const DEFAULT_USER_AGENT: &str = "VLC/3.0.20 LibVLC/3.0.20";

/// Largest body read from a provider, after any `Content-Encoding` decoding.
pub const MAX_BODY: usize = 512 * 1024 * 1024;

/// Per-source overrides: the source's columns, or an entry's own.
#[derive(Debug, Clone, Copy, Default)]
pub struct Identity<'a> {
    pub user_agent: Option<&'a str>,
    pub referer: Option<&'a str>,
}

impl Identity<'_> {
    pub fn user_agent(&self) -> &str {
        self.user_agent
            .filter(|u| !u.is_empty())
            .unwrap_or(DEFAULT_USER_AGENT)
    }
}

/// What a conditional refresh remembers between runs.
#[derive(Debug, Clone, Copy, Default)]
pub struct Validators<'a> {
    pub etag: Option<&'a str>,
    pub last_modified: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
pub struct Opts {
    /// Longest silence between two reads (axios' `timeout`).
    pub idle: Duration,
    pub max_redirects: usize,
    /// Probe mode: the host is vetted before every hop.
    pub vetted: bool,
}

impl Opts {
    pub const PLAYLIST: Self = Self::of(30, 5);
    pub const PANEL: Self = Self::of(20, 2);
    pub const GUIDE: Self = Self::of(300, 5);

    const fn of(idle_s: u64, max_redirects: usize) -> Self {
        Self {
            idle: Duration::from_secs(idle_s),
            max_redirects,
            vetted: false,
        }
    }

    pub const fn vetted(self, on: bool) -> Self {
        Self { vetted: on, ..self }
    }
}

/// The answer of a GET: 2xx, or 304 when validators were sent.
pub struct Reply {
    pub response: Response,
}

impl Reply {
    pub fn not_modified(&self) -> bool {
        self.response.status() == StatusCode::NOT_MODIFIED
    }

    /// `ETag` and `Last-Modified` as strings.
    pub fn validators(&self) -> (Option<String>, Option<String>) {
        let h = self.response.headers();
        let text = |n| h.get(n).and_then(|v| v.to_str().ok()).map(str::to_owned);
        (text(ETAG), text(LAST_MODIFIED))
    }
}

/// A transport error as axios words it, without the URL: `target` is the `host:port` that was asked for.
pub fn describe(e: &reqwest::Error, idle: Duration, target: &str) -> String {
    if e.is_timeout() {
        return format!("timeout of {}ms exceeded", idle.as_millis());
    }
    let mut chain = vec![];
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        chain.push(s);
        source = s.source();
    }
    let refused = chain.iter().any(|s| {
        s.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused)
    });
    if refused {
        return format!("connect ECONNREFUSED {target}");
    }
    let text = chain
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>()
        .join(": ");
    if text.contains("dns error") || text.contains("failed to lookup") {
        let host = target.rsplit_once(':').map_or(target, |(h, _)| h);
        return format!("getaddrinfo ENOTFOUND {host}");
    }
    let mut out = e.to_string();
    if let Some(u) = e.url() {
        out = out.replace(u.as_str(), "");
    }
    if text.is_empty() {
        out
    } else {
        format!("{out}: {text}")
    }
}

/// `host:port` of a url, nothing else of it.
pub fn target_of(url: &Url) -> String {
    format!(
        "{}:{}",
        url.host_str().unwrap_or_default(),
        url.port_or_known_default().unwrap_or(80)
    )
}

fn builder(idle: Duration) -> ClientBuilder {
    Client::builder()
        .connect_timeout(idle)
        .read_timeout(idle)
        .gzip(true)
        .deflate(true)
        .brotli(true)
        .zstd(true)
}

fn headers(identity: &Identity, validators: &Validators) -> HeaderMap {
    let mut h = HeaderMap::new();
    let mut put = |name, v: &str| {
        if let Ok(v) = v.parse() {
            h.insert(name, v);
        }
    };
    put(USER_AGENT, identity.user_agent());
    if let Some(r) = identity.referer.filter(|r| !r.is_empty()) {
        put(REFERER, r);
    }
    if let Some(e) = validators.etag.filter(|e| !e.is_empty()) {
        put(IF_NONE_MATCH, e);
    }
    if let Some(m) = validators.last_modified.filter(|m| !m.is_empty()) {
        put(IF_MODIFIED_SINCE, m);
    }
    h
}

/// GET with the live TV identity; any status but 2xx or 304 is an error.
pub async fn get(
    url: &str,
    identity: &Identity<'_>,
    validators: &Validators<'_>,
    opts: Opts,
) -> Result<Reply, String> {
    let mut url = Url::parse(url).map_err(|_| "Invalid URL".to_owned())?;
    let hdrs = headers(identity, validators);
    let open = (!opts.vetted).then(|| {
        builder(opts.idle)
            .redirect(redirect::Policy::limited(opts.max_redirects))
            .build()
    });
    let open = match open {
        Some(c) => Some(c.map_err(|e| describe(&e, opts.idle, &target_of(&url)))?),
        None => None,
    };
    let mut hops = 0;
    loop {
        // A probe re-vets every hop and pins the connection to the address that passed.
        let client = match &open {
            Some(c) => c.clone(),
            None => vetted::client_for(&url, builder(opts.idle)).await?,
        };
        let res = client
            .get(url.clone())
            .headers(hdrs.clone())
            .send()
            .await
            .map_err(|e| describe(&e, opts.idle, &target_of(&url)))?;
        if opts.vetted
            && let Some(next) = vetted::next_hop(&url, res.status(), res.headers())
        {
            hops += 1;
            if hops > opts.max_redirects {
                return Err("Maximum number of redirects exceeded".into());
            }
            url = next;
            continue;
        }
        let status = res.status();
        if status.is_success() || status == StatusCode::NOT_MODIFIED {
            return Ok(Reply { response: res });
        }
        return Err(format!(
            "Request failed with status code {}",
            status.as_u16()
        ));
    }
}

/// The whole body as text (UTF-8, invalid bytes replaced, a leading BOM dropped), capped at [`MAX_BODY`].
pub async fn text(reply: Reply, idle: Duration) -> Result<String, String> {
    let mut res = reply.response;
    let mut body: Vec<u8> = vec![];
    let target = target_of(res.url());
    while let Some(chunk) = res.chunk().await.map_err(|e| describe(&e, idle, &target))? {
        if body.len() + chunk.len() > MAX_BODY {
            return Err("maxContentLength size of 536870912 exceeded".into());
        }
        body.extend_from_slice(&chunk);
    }
    let mut s = String::from_utf8(body)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    if s.starts_with('\u{feff}') {
        s.drain(..3);
    }
    Ok(s)
}

/// A JSON answer; a body that is not JSON stays a string, as axios hands it over.
pub async fn json(reply: Reply, idle: Duration) -> Result<serde_json::Value, String> {
    let raw = text(reply, idle).await?;
    Ok(serde_json::from_str(&raw).unwrap_or(serde_json::Value::String(raw)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, http::HeaderMap as H, response::IntoResponse, routing::get as route};

    async fn serve(app: Router) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        base
    }

    #[tokio::test]
    async fn requests_carry_the_identity_and_validators_and_a_304_is_an_answer() {
        let app = Router::new().route(
            "/p",
            route(|h: H| async move {
                let ua = h.get("user-agent").unwrap().to_str().unwrap().to_owned();
                if h.get("if-none-match").is_some() {
                    return (StatusCode::NOT_MODIFIED, [("x-ua", ua)]).into_response();
                }
                (
                    [
                        ("etag", "\"v1\""),
                        ("x-ua", &ua),
                        (
                            "x-ref",
                            h.get("referer").map_or("", |r| r.to_str().unwrap()),
                        ),
                    ],
                    "\u{feff}#EXTM3U\n",
                )
                    .into_response()
            }),
        );
        let base = serve(app).await;
        let id = Identity {
            user_agent: None,
            referer: Some("http://r/"),
        };
        let r = get(
            &format!("{base}/p"),
            &id,
            &Validators::default(),
            Opts::PLAYLIST,
        )
        .await
        .unwrap();
        assert_eq!(r.response.headers()["x-ua"], DEFAULT_USER_AGENT);
        assert_eq!(r.response.headers()["x-ref"], "http://r/");
        assert_eq!(r.validators().0.as_deref(), Some("\"v1\""));
        assert_eq!(text(r, Duration::from_secs(1)).await.unwrap(), "#EXTM3U\n");
        let v = Validators {
            etag: Some("\"v1\""),
            last_modified: None,
        };
        let r = get(
            &format!("{base}/p"),
            &Identity {
                user_agent: Some("X/1"),
                referer: None,
            },
            &v,
            Opts::PLAYLIST,
        )
        .await
        .unwrap();
        assert!(r.not_modified());
        assert_eq!(r.response.headers()["x-ua"], "X/1");
    }

    #[tokio::test]
    async fn failures_name_the_status_and_never_the_url() {
        let app = Router::new().route("/gone", route(|| async { StatusCode::NOT_FOUND }));
        let base = serve(app).await;
        let url = format!("{base}/gone?password=secret");
        let e = get(
            &url,
            &Identity::default(),
            &Validators::default(),
            Opts::PANEL,
        )
        .await
        .err()
        .unwrap();
        assert_eq!(e, "Request failed with status code 404");
        let e = get(
            "http://127.0.0.1:1/x?password=secret",
            &Identity::default(),
            &Validators::default(),
            Opts::PANEL,
        )
        .await
        .err()
        .unwrap();
        assert!(!e.contains("secret") && !e.contains("127.0.0.1:1/x"), "{e}");
    }

    #[tokio::test]
    async fn a_redirect_limit_is_enforced() {
        let app = Router::new().route(
            "/loop",
            route(|| async { (StatusCode::FOUND, [("location", "/loop")]) }),
        );
        let base = serve(app).await;
        let e = get(
            &format!("{base}/loop"),
            &Identity::default(),
            &Validators::default(),
            Opts::PANEL,
        )
        .await
        .err()
        .unwrap();
        assert!(e.contains("redirect"), "{e}");
    }

    #[tokio::test]
    async fn the_probe_refuses_an_internal_host_and_every_hop_is_vetted() {
        let app = Router::new().route("/x", route(|| async { "ok" }));
        let base = serve(app).await;
        let e = get(
            &format!("{base}/x"),
            &Identity::default(),
            &Validators::default(),
            Opts::PANEL.vetted(true),
        )
        .await
        .err()
        .unwrap();
        assert!(
            e.starts_with("Refused: \"127.0.0.1\" resolves to an internal address"),
            "{e}"
        );
        let e = get(
            "ftp://example.com/x",
            &Identity::default(),
            &Validators::default(),
            Opts::PANEL.vetted(true),
        )
        .await
        .err()
        .unwrap();
        assert!(e.contains("only http"), "{e}");
    }
}

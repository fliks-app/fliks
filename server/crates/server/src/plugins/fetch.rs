//! Host-side fetches of the plugin host: catalog documents (rule 26) and catalog archives with
//! their https redirects (rule 28). Errors are kinds, never URLs.
use crate::net::guard::{self, Net};
use reqwest::{Client, StatusCode, Url, redirect};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;

const CATALOG_TIMEOUT: Duration = Duration::from_secs(10);
const ARCHIVE_TIMEOUT: Duration = Duration::from_secs(300);
const READ_IDLE: Duration = Duration::from_secs(30);
const MAX_HOPS: usize = 5;

#[derive(Debug, Clone, PartialEq)]
pub enum FetchError {
    Network(String),
    Timeout,
    TooLarge,
    Status(u16),
}

impl FetchError {
    /// The kind text of `lastRefreshError`, `failures[]` and the logs.
    pub fn kind(&self) -> String {
        match self {
            FetchError::Network(_) => "network error".into(),
            FetchError::Timeout => "timeout".into(),
            FetchError::TooLarge => "response too large".into(),
            FetchError::Status(s) => format!("status {s}"),
        }
    }
}

/// The clients of the host's fetches; tests add roots and a stub network.
#[derive(Clone)]
pub struct Fetcher {
    pub net: Arc<dyn Net>,
    pub roots: Vec<reqwest::Certificate>,
}

impl Default for Fetcher {
    fn default() -> Self {
        Fetcher {
            net: guard::system(),
            roots: vec![],
        }
    }
}

fn classify(e: reqwest::Error) -> FetchError {
    if e.is_timeout() {
        FetchError::Timeout
    } else {
        FetchError::Network(e.without_url().to_string())
    }
}

impl Fetcher {
    fn builder(&self, timeout: Duration, ua: &str) -> reqwest::ClientBuilder {
        let mut b = Client::builder()
            .redirect(redirect::Policy::none())
            .timeout(timeout)
            .read_timeout(READ_IDLE)
            .user_agent(ua);
        for r in &self.roots {
            b = b.add_root_certificate(r.clone());
        }
        b
    }

    /// A client for an untrusted host: one guarded lookup, the connection pinned to its answer.
    async fn guarded(
        &self,
        url: &Url,
        timeout: Duration,
        ua: &str,
    ) -> Result<Client, guard::Refused> {
        let host = url
            .host_str()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let port = url.port_or_known_default().unwrap_or(443);
        let addrs = guard::vet(&*self.net, &host, port, false).await?;
        #[cfg(any(test, feature = "parity"))]
        let addrs: Vec<_> = addrs.into_iter().map(|a| self.net.route(a)).collect();
        Ok(self
            .builder(timeout, ua)
            .resolve_to_addrs(&host, &addrs)
            .build()
            .expect("reqwest client"))
    }

    /// The whole body, at most `cap` bytes, of a 2xx answer.
    async fn body(
        res: reqwest::Response,
        cap: usize,
        until: Option<Instant>,
    ) -> Result<Vec<u8>, FetchError> {
        if !res.status().is_success() {
            return Err(FetchError::Status(res.status().as_u16()));
        }
        if res.content_length().is_some_and(|l| l as usize > cap) {
            return Err(FetchError::TooLarge);
        }
        let mut res = res;
        let mut out = Vec::new();
        loop {
            let chunk = match until {
                Some(u) => tokio::time::timeout_at(u, res.chunk())
                    .await
                    .map_err(|_| FetchError::Timeout)?,
                None => res.chunk().await,
            };
            match chunk.map_err(classify)? {
                Some(c) => {
                    out.extend_from_slice(&c);
                    if out.len() > cap {
                        return Err(FetchError::TooLarge);
                    }
                }
                None => return Ok(out),
            }
        }
    }

    /// One catalog file: no redirect, 10 s, capped.
    pub async fn catalog_file(&self, url: &str, cap: usize) -> Result<Vec<u8>, FetchError> {
        let c = self
            .builder(CATALOG_TIMEOUT, "Fliks-Plugin-Catalog-Client/1.0")
            .build()
            .expect("reqwest client");
        let res = c.get(url).send().await.map_err(classify)?;
        Self::body(res, cap, None).await
    }

    /// The archive of a catalog version: https only, at most 5 https redirects, 5 min in all, 30 s idle, and
    /// `cap` over the whole chain; a hop off the `zipUrl` host goes through the outbound guard.
    pub async fn archive(&self, zip_url: &str, cap: usize) -> Result<Vec<u8>, ArchiveError> {
        let first =
            Url::parse(zip_url).map_err(|_| ArchiveError::Failed("invalid archive URL".into()))?;
        if first.scheme() != "https" {
            return Err(ArchiveError::Failed("archive URL must be https".into()));
        }
        let until = Instant::now() + ARCHIVE_TIMEOUT;
        let origin = (
            first.host_str().map(str::to_owned),
            first.port_or_known_default(),
        );
        let mut url = first;
        for hop in 0..=MAX_HOPS {
            let trusted = (
                url.host_str().map(str::to_owned),
                url.port_or_known_default(),
            ) == origin;
            const UA: &str = "Fliks-Plugin-Installer/1.0";
            let c = if trusted {
                self.builder(ARCHIVE_TIMEOUT, UA)
                    .build()
                    .expect("reqwest client")
            } else {
                self.guarded(&url, ARCHIVE_TIMEOUT, UA)
                    .await
                    .map_err(|_| ArchiveError::Failed("redirect target refused".into()))?
            };
            let sent = tokio::time::timeout_at(until, c.get(url.clone()).send()).await;
            let res = match sent {
                Err(_) => return Err(ArchiveError::Timeout),
                Ok(Err(e)) if e.is_timeout() => return Err(ArchiveError::Timeout),
                Ok(Err(e)) => return Err(ArchiveError::Failed(e.without_url().to_string())),
                Ok(Ok(r)) => r,
            };
            if res.status().is_redirection() && res.status() != StatusCode::NOT_MODIFIED {
                if hop == MAX_HOPS {
                    return Err(ArchiveError::Failed("too many redirects".into()));
                }
                let next = res
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|l| l.to_str().ok())
                    .and_then(|l| url.join(l).ok())
                    .ok_or_else(|| ArchiveError::Failed("redirect without a location".into()))?;
                if next.scheme() != "https" {
                    return Err(ArchiveError::Failed("redirect to a non-https URL".into()));
                }
                url = next;
                continue;
            }
            return Self::body(res, cap, Some(until))
                .await
                .map_err(|e| match e {
                    FetchError::Timeout => ArchiveError::Timeout,
                    FetchError::TooLarge => ArchiveError::TooLarge,
                    other => ArchiveError::Failed(other.kind()),
                });
        }
        Err(ArchiveError::Failed("too many redirects".into()))
    }

    /// A data-tier webhook POST: resolved once, every address vetted without a grant, the
    /// connection pinned to them; 5 s, no redirect, 64 KiB read.
    pub async fn webhook(&self, url: &str, body: &serde_json::Value) -> Result<(), WebhookError> {
        let u = Url::parse(url).map_err(|_| WebhookError::Refused)?;
        let c = self
            .guarded(&u, Duration::from_secs(5), "Fliks-Plugin-Webhook/1.0")
            .await
            .map_err(|_| WebhookError::Refused)?;
        let res = c
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(|e| WebhookError::Fetch(classify(e)))?;
        Self::body(res, 64 << 10, None)
            .await
            .map(drop)
            .map_err(WebhookError::Fetch)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum WebhookError {
    /// Not https, unparsable, unresolvable or an internal address.
    Refused,
    Fetch(FetchError),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ArchiveError {
    Failed(String),
    Timeout,
    TooLarge,
}

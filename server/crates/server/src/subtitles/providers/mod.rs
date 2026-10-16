//! Subtitle providers (`docs/spec/subtitle-providers.md`): search and download over HTTP, never
//! further than the provider's own origin.
pub mod gestdown;
pub mod limiter;
pub mod opensubtitles;
pub mod subdl;
pub mod subsynchro;
pub mod supersubtitles;
pub mod yify;
pub mod zip;

use super::Shared;
use fliks_domain::subtitle_score::Candidate;
use reqwest::{Response, Url};
use serde_json::Value;

/// What providers read of a search (`SubtitleSearchParams`).
#[derive(Debug, Clone, Default)]
pub struct Query {
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<i64>,
    pub title: String,
    pub year: Option<i32>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub language: String,
    pub moviehash: Option<String>,
}

pub struct TestResult {
    pub ok: bool,
    pub detail: Option<String>,
}

impl TestResult {
    pub fn ok() -> Self {
        Self {
            ok: true,
            detail: None,
        }
    }
    pub fn fail(detail: impl Into<String>) -> Self {
        Self {
            ok: false,
            detail: Some(detail.into()),
        }
    }
}

/// Downloaded bodies are capped (F56).
pub const MAX_BODY: usize = 10 * 1024 * 1024;

pub async fn body_bytes(mut res: Response, cap: usize) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(crate::outbound::error_text)? {
        out.extend_from_slice(&chunk);
        if out.len() > cap {
            return Err("Response body is too large".into());
        }
    }
    Ok(out)
}

pub async fn body_text(res: Response) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&body_bytes(res, MAX_BODY).await?).into_owned())
}

pub async fn body_json(res: Response) -> Result<Value, String> {
    let text = body_text(res).await?;
    serde_json::from_str(&text).map_err(|e| format!("Unexpected response body: {e}"))
}

/// `encodeURIComponent`.
pub fn enc(s: &str) -> String {
    use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
    const KEEP: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    utf8_percent_encode(s, KEEP).to_string()
}

/// Resolves `candidate` against `base`; anything off the base's origin is refused (rule 15).
pub fn provider_url(base: &str, candidate: &str) -> Result<String, String> {
    let base_url = Url::parse(base).map_err(|_| format!("Invalid download path: {candidate}"))?;
    let resolved = base_url
        .join(candidate)
        .map_err(|_| format!("Invalid download path: {candidate}"))?;
    if resolved.origin() != base_url.origin() {
        return Err(format!(
            "Refusing to download from {}",
            resolved.origin().ascii_serialization()
        ));
    }
    Ok(resolved.to_string())
}

pub fn with_params(url: &str, params: &[(&str, String)]) -> Result<Url, String> {
    let mut u = Url::parse(url).map_err(|_| format!("Invalid URL: {url}"))?;
    u.query_pairs_mut()
        .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
    Ok(u)
}

/// `testResultFromResponse`: the status, plus the JSON body's own reason when it states one.
pub async fn test_result(res: Response) -> TestResult {
    if res.status().is_success() {
        return TestResult::ok();
    }
    let (code, text) = (
        res.status().as_u16(),
        res.status().canonical_reason().unwrap_or(""),
    );
    let reason = match body_json(res).await {
        Ok(Value::Object(o)) => ["message", "error", "detail", "error_description"]
            .iter()
            .find_map(|k| {
                o.get(*k)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .map(|s| s.chars().take(200).collect::<String>()),
        _ => None,
    };
    match reason {
        Some(r) => TestResult::fail(format!("HTTP {code}: {r}")),
        None if text.is_empty() => TestResult::fail(format!("HTTP {code}")),
        None => TestResult::fail(format!("HTTP {code} {text}")),
    }
}

pub const TYPES: [&str; 6] = [
    "opensubtitles",
    "subdl",
    "subsynchro",
    "supersubtitles",
    "yify",
    "gestdown",
];

#[allow(clippy::too_many_arguments)]
pub fn candidate(
    ptype: &str,
    name: &str,
    id: String,
    title: String,
    release: Option<String>,
    language: String,
    forced: bool,
    hi: bool,
) -> Candidate {
    Candidate {
        provider_file_id: id,
        title,
        release_name: release,
        imdb_id: None,
        hash_matched: None,
        language,
        forced,
        hearing_impaired: hi,
        score: 0.0,
        download_count: None,
        provider_name: name.into(),
        provider_type: ptype.into(),
    }
}

/// A provider built per call from its row (`SubtitleProviderFactory`).
pub struct Provider<'a> {
    kind: &'a str,
    settings: Value,
    sh: &'a Shared,
}

impl<'a> Provider<'a> {
    pub fn new(kind: &'a str, settings: &Value, sh: &'a Shared) -> Result<Self, String> {
        if TYPES.contains(&kind) {
            Ok(Self {
                kind,
                settings: settings.clone(),
                sh,
            })
        } else {
            Err(format!("Unsupported subtitle provider type: {kind}"))
        }
    }

    pub async fn search(&self, q: &Query) -> Result<Vec<Candidate>, String> {
        let (sh, s) = (self.sh, &self.settings);
        match self.kind {
            "opensubtitles" => opensubtitles::search(sh, s, q).await,
            "subdl" => subdl::search(sh, s, q).await,
            "subsynchro" => subsynchro::search(sh, q).await,
            "supersubtitles" => supersubtitles::search(sh, q).await,
            "yify" => yify::search(sh, q).await,
            _ => gestdown::search(sh, q).await,
        }
    }

    pub async fn download(&self, c: &Candidate) -> Result<Vec<u8>, String> {
        let (sh, s) = (self.sh, &self.settings);
        match self.kind {
            "opensubtitles" => opensubtitles::download(sh, s, c).await,
            "subdl" => subdl::download(sh, c).await,
            "subsynchro" => subsynchro::download(sh, c).await,
            "supersubtitles" => supersubtitles::download(sh, c).await,
            "yify" => yify::download(sh, c).await,
            _ => gestdown::download(sh, c).await,
        }
    }

    pub async fn test(&self) -> TestResult {
        let (sh, s) = (self.sh, &self.settings);
        match self.kind {
            "opensubtitles" => opensubtitles::test(sh, s).await,
            "subdl" => subdl::test(sh, s).await,
            "subsynchro" => subsynchro::test(sh).await,
            "supersubtitles" => supersubtitles::test(sh).await,
            "yify" => yify::test(sh).await,
            _ => gestdown::test(sh).await,
        }
    }
}

/// `str(settings[key])` the way the TS read it: a non-string is absent.
pub fn setting<'a>(s: &'a Value, key: &str) -> Option<&'a str> {
    s.get(key).and_then(Value::as_str)
}

/// Transport errors as the text a provider failure shows (never the URL, F54).
pub fn net(e: reqwest::Error) -> String {
    crate::outbound::error_text(e)
}

/// `<prefix>: <status>`, or `none` when the request was skipped (`res?.status` prints `undefined`).
pub fn failed(prefix: &str, res: Option<&Response>, none: &str) -> String {
    match res {
        Some(r) => format!("{prefix}: {}", r.status().as_u16()),
        None => format!("{prefix}: {none}"),
    }
}

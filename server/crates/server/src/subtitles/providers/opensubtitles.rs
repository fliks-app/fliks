//! OpenSubtitles REST (`subtitle-providers.md` rules 20-25).
use super::{
    MAX_BODY, Query, Shared, TestResult, body_bytes, body_json, body_text, candidate, net, setting,
    test_result, with_params,
};
use fliks_domain::subtitle_score::Candidate;
use reqwest::{RequestBuilder, Url};
use serde_json::{Value, json};
use std::time::Duration;

const T: &str = "opensubtitles";
/// The app's consumer key, not a secret (rule 47).
const DEFAULT_API_KEY: &str = "KXXhBJcOUG9xTxmPzIIkE56obyHtyCyd";
const USER_AGENT: &str = "Fliks v1.0";
const TOKEN_TTL_MS: i64 = 23 * 60 * 60 * 1000;

fn api_key(s: &Value) -> String {
    setting(s, "apiKey")
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .unwrap_or(DEFAULT_API_KEY)
        .to_owned()
}

fn token_key(s: &Value) -> String {
    format!(
        "{}:{}",
        api_key(s),
        setting(s, "username").unwrap_or("undefined")
    )
}

fn token(sh: &Shared, s: &Value) -> Option<String> {
    let mut cache = sh.os_tokens.lock().unwrap_or_else(|e| e.into_inner());
    let key = token_key(s);
    match cache.get(&key) {
        Some((t, exp)) if *exp > super::limiter::now_ms() => Some(t.clone()),
        Some(_) => {
            cache.remove(&key);
            None
        }
        None => None,
    }
}

fn with_headers(sh: &Shared, s: &Value, b: RequestBuilder) -> RequestBuilder {
    let b = b
        .header("Api-Key", api_key(s))
        .header("Content-Type", "application/json")
        .header("User-Agent", USER_AGENT);
    match token(sh, s) {
        Some(t) => b.header("Authorization", format!("Bearer {t}")),
        None => b,
    }
}

async fn ensure_token(sh: &Shared, s: &Value) {
    let (user, pass) = (
        setting(s, "username").unwrap_or(""),
        setting(s, "password").unwrap_or(""),
    );
    if token(sh, s).is_some() || user.is_empty() || pass.is_empty() || sh.limiter.is_rate_limited(T)
    {
        return;
    }
    let url = format!("{}/login", sh.bases.opensubtitles);
    let body = json!({"username": user, "password": pass}).to_string();
    let key = api_key(s);
    let res = sh
        .limiter
        .fetch(
            T,
            || {
                sh.http
                    .post(&url)
                    .header("Api-Key", &key)
                    .header("Content-Type", "application/json")
                    .header("User-Agent", USER_AGENT)
                    .body(body.clone())
            },
            2,
            60.0,
        )
        .await;
    let Some(res) = res else { return };
    if res.status().is_success() {
        if let Ok(v) = body_json(res).await
            && let Some(t) = v["token"].as_str()
        {
            sh.os_tokens
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(
                    token_key(s),
                    (t.to_owned(), super::limiter::now_ms() + TOKEN_TTL_MS),
                );
            tracing::info!("OpenSubtitles: authenticated successfully");
        }
    } else {
        let status = res.status().as_u16();
        let text = body_text(res).await.unwrap_or_default();
        tracing::warn!(
            "OpenSubtitles login failed: {status} {}",
            text.chars().take(200).collect::<String>()
        );
    }
}

pub async fn search(sh: &Shared, s: &Value, q: &Query) -> Result<Vec<Candidate>, String> {
    if sh.limiter.is_rate_limited(T) {
        return Ok(vec![]);
    }
    ensure_token(sh, s).await;
    let mut p: Vec<(&str, String)> = vec![];
    if let Some(h) = q.moviehash.as_deref().filter(|h| !h.is_empty()) {
        p.push(("moviehash", h.to_owned()));
    }
    if let Some(i) = q.imdb_id.as_deref().filter(|i| !i.is_empty()) {
        p.push(("imdb_id", i.to_owned()));
    }
    if let Some(t) = q.tmdb_id.filter(|t| *t != 0) {
        p.push(("tmdb_id", t.to_string()));
    }
    if p.is_empty() {
        p.push(("query", q.title.clone()));
        if let Some(y) = q.year.filter(|y| *y != 0) {
            p.push(("year", y.to_string()));
        }
    }
    p.push(("languages", q.language.clone()));
    if let Some(n) = q.season {
        p.push(("season_number", n.to_string()));
    }
    if let Some(n) = q.episode {
        p.push(("episode_number", n.to_string()));
    }
    let url: Url = with_params(&format!("{}/subtitles", sh.bases.opensubtitles), &p)?;
    let Some(res) = sh
        .limiter
        .fetch(T, || with_headers(sh, s, sh.http.get(url.clone())), 2, 5.0)
        .await
    else {
        return Ok(vec![]);
    };
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = body_text(res).await.unwrap_or_default();
        tracing::warn!(
            "OpenSubtitles search failed: {status} {}",
            text.chars().take(200).collect::<String>()
        );
        return Ok(vec![]);
    }
    let body = body_json(res).await?;
    let data = body["data"]
        .as_array()
        .ok_or("Cannot read properties of undefined (reading 'map')")?;
    data.iter()
        .map(|item| {
            let a = &item["attributes"];
            let files = a["files"]
                .as_array()
                .ok_or("Cannot read properties of undefined (reading '0')")?;
            let id = files
                .first()
                .map(|f| &f["file_id"])
                .filter(|v| !v.is_null())
                .or(Some(&item["id"]))
                .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                .unwrap_or_default();
            let release = a["release"].as_str().unwrap_or("").to_owned();
            let mut c = candidate(
                T,
                "OpenSubtitles",
                id,
                release.clone(),
                Some(release),
                a["language"].as_str().unwrap_or("").to_owned(),
                a["foreign_parts_only"].as_bool().unwrap_or(false),
                a["hearing_impaired"].as_bool().unwrap_or(false),
            );
            c.imdb_id = a["feature_details"]["imdb_id"]
                .as_i64()
                .map(|n| n.to_string())
                .or_else(|| a["feature_details"]["imdb_id"].as_str().map(str::to_owned));
            c.hash_matched = a["moviehash_match"].as_bool();
            c.download_count = a["download_count"].as_f64();
            Ok(c)
        })
        .collect()
}

pub async fn download(sh: &Shared, s: &Value, c: &Candidate) -> Result<Vec<u8>, String> {
    if sh.limiter.is_rate_limited(T) {
        return Err("OpenSubtitles is rate-limited, try again later".into());
    }
    ensure_token(sh, s).await;
    let url = format!("{}/download", sh.bases.opensubtitles);
    // `Number(x)` of a non-number is NaN, which JSON sends as null.
    let file_id = c
        .provider_file_id
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite());
    let body = match file_id {
        Some(n) if n.fract() == 0.0 && n.abs() < 9e15 => json!({"file_id": n as i64}),
        Some(n) => json!({"file_id": n}),
        None => json!({"file_id": null}),
    }
    .to_string();
    let res = sh
        .limiter
        .fetch(
            T,
            || with_headers(sh, s, sh.http.post(&url)).body(body.clone()),
            2,
            60.0,
        )
        .await;
    let res = match res {
        Some(r) if r.status().is_success() => r,
        Some(r) => {
            let text = body_text(r).await.unwrap_or_default();
            return Err(format!("OpenSubtitles download failed: {text}"));
        }
        None => return Err("OpenSubtitles download failed: rate-limited".into()),
    };
    let v = body_json(res).await?;
    if v["remaining"].as_f64().is_some_and(|r| r <= 0.0) {
        tracing::warn!("OpenSubtitles download quota exhausted");
        sh.limiter.mark_rate_limited(T, None, 3600.0);
    }
    let link =
        Url::parse(v["link"].as_str().unwrap_or("")).map_err(|_| "Invalid URL".to_owned())?;
    if link.scheme() != "https" && !(sh.bases.allow_http_link && link.scheme() == "http") {
        return Err(format!(
            "OpenSubtitles returned a non-https link ({}:)",
            link.scheme()
        ));
    }
    let file = sh
        .http
        .get(link)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(net)?;
    if !file.status().is_success() {
        return Err(format!(
            "Failed to fetch subtitle file: {}",
            file.status().as_u16()
        ));
    }
    body_bytes(file, MAX_BODY).await
}

pub async fn test(sh: &Shared, s: &Value) -> TestResult {
    let (user, pass) = (
        setting(s, "username").unwrap_or(""),
        setting(s, "password").unwrap_or(""),
    );
    if user.is_empty() || pass.is_empty() {
        return TestResult::fail("missing username or password");
    }
    let res = sh
        .http
        .post(format!("{}/login", sh.bases.opensubtitles))
        .header("Api-Key", api_key(s))
        .header("Content-Type", "application/json")
        .header("User-Agent", USER_AGENT)
        .timeout(super::limiter::FETCH_TIMEOUT)
        .body(json!({"username": user, "password": pass}).to_string())
        .send()
        .await;
    match res {
        Ok(r) => test_result(r).await,
        Err(e) => TestResult::fail(net(e)),
    }
}

//! Subdl (`subtitle-providers.md` rules 26-27).
use super::{
    MAX_BODY, Query, Shared, TestResult, body_bytes, body_json, body_text, candidate, failed, net,
    provider_url, setting, test_result, with_params,
};
use fliks_domain::subtitle_score::Candidate;
use serde_json::Value;

const T: &str = "subdl";
const UA: &str = "Fliks/1.0";

pub async fn search(sh: &Shared, s: &Value, q: &Query) -> Result<Vec<Candidate>, String> {
    if sh.limiter.is_rate_limited(T) {
        return Ok(vec![]);
    }
    let mut p: Vec<(&str, String)> = vec![(
        "api_key",
        setting(s, "apiKey").unwrap_or("undefined").to_owned(),
    )];
    let imdb = q.imdb_id.as_deref().filter(|i| !i.is_empty());
    let tmdb = q.tmdb_id.filter(|t| *t != 0);
    if let Some(i) = imdb {
        p.push(("imdb_id", i.to_owned()));
    }
    if let Some(t) = tmdb {
        p.push(("tmdb_id", t.to_string()));
    }
    if imdb.is_none() && tmdb.is_none() {
        p.push(("film_name", q.title.clone()));
        if let Some(y) = q.year.filter(|y| *y != 0) {
            p.push(("year", y.to_string()));
        }
    }
    p.push(("languages", q.language.clone()));
    p.push((
        "type",
        if q.season.is_some() { "tv" } else { "movie" }.into(),
    ));
    if let Some(n) = q.season {
        p.push(("season_number", n.to_string()));
    }
    if let Some(n) = q.episode {
        p.push(("episode_number", n.to_string()));
    }
    p.push(("subs_per_page", "30".into()));
    let url = with_params(&sh.bases.subdl_api, &p)?;
    let Some(res) = sh
        .limiter
        .fetch(
            T,
            || sh.http.get(url.clone()).header("User-Agent", UA),
            2,
            60.0,
        )
        .await
    else {
        return Ok(vec![]);
    };
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let text = body_text(res).await.unwrap_or_default();
        tracing::warn!(
            "Subdl search failed: {status} - {}",
            text.chars().take(200).collect::<String>()
        );
        return Ok(vec![]);
    }
    let body = body_json(res).await?;
    if !body["status"].as_bool().unwrap_or(false) {
        match body["error"].as_str() {
            Some(e) if e.to_lowercase().contains("can't find") => tracing::debug!("Subdl: {e}"),
            e => tracing::warn!("Subdl API error: {}", e.unwrap_or("undefined")),
        }
        return Ok(vec![]);
    }
    Ok(body["subtitles"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|i| {
            let rel = i["release_name"].as_str().unwrap_or("").to_owned();
            candidate(
                T,
                "Subdl",
                i["url"].as_str().unwrap_or("").to_owned(),
                rel.clone(),
                Some(rel),
                i["language"].as_str().unwrap_or("").to_owned(),
                false,
                i["hi"].as_bool().unwrap_or(false),
            )
        })
        .collect())
}

pub async fn download(sh: &Shared, c: &Candidate) -> Result<Vec<u8>, String> {
    if sh.limiter.is_rate_limited(T) {
        return Err("Subdl is rate-limited, try again later".into());
    }
    let url = provider_url(&sh.bases.subdl_dl, &c.provider_file_id)?;
    let res = sh
        .limiter
        .fetch(T, || sh.http.get(&url).header("User-Agent", UA), 2, 60.0)
        .await;
    let res = match res {
        Some(r) if r.status().is_success() => r,
        other => {
            return Err(failed(
                "Subdl download failed",
                other.as_ref(),
                "rate-limited",
            ));
        }
    };
    super::zip::extract_subtitle(&body_bytes(res, MAX_BODY).await?, false)
}

pub async fn test(sh: &Shared, s: &Value) -> TestResult {
    let key = setting(s, "apiKey").unwrap_or("undefined");
    let url = match with_params(
        &sh.bases.subdl_api,
        &[("api_key", key.to_owned()), ("imdb_id", "tt0111161".into())],
    ) {
        Ok(u) => u,
        Err(e) => return TestResult::fail(e),
    };
    match sh
        .http
        .get(url)
        .header("User-Agent", UA)
        .timeout(super::limiter::FETCH_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => test_result(r).await,
        Err(e) => TestResult::fail(net(e)),
    }
}

//! Gestdown: TV only, over its JSON API (`subtitle-providers.md` rule 36).
use super::yify::language_name;
use super::{
    MAX_BODY, Query, Shared, TestResult, body_bytes, body_json, candidate, enc, failed, net,
    provider_url, test_result,
};
use fliks_domain::subtitle_score::Candidate;

const T: &str = "gestdown";
const UA: &str = "Fliks/1.0";

pub async fn search(sh: &Shared, q: &Query) -> Result<Vec<Candidate>, String> {
    if sh.limiter.is_rate_limited(T) {
        return Ok(vec![]);
    }
    let (Some(season), Some(episode)) = (q.season, q.episode) else {
        return Ok(vec![]);
    };
    let Some(lang) = language_name(&q.language) else {
        return Ok(vec![]);
    };
    let Some(show) = resolve_show(sh, q).await? else {
        return Ok(vec![]);
    };
    let url = format!(
        "{}/subtitles/get/{show}/{season}/{episode}/{lang}",
        sh.bases.gestdown
    );
    let res = sh
        .limiter
        .fetch(T, || sh.http.get(&url).header("User-Agent", UA), 2, 5.0)
        .await;
    let Some(res) = res.filter(|r| r.status().is_success()) else {
        return Ok(vec![]);
    };
    let body = body_json(res).await?;
    let text =
        |v: &serde_json::Value, k: &str| v[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    Ok(body["matchingSubtitles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| s["completed"].as_bool().unwrap_or(false))
        .map(|s| {
            let (version, release) = (text(s, "version"), text(s, "release"));
            let title = [
                Some(q.title.clone()).filter(|t| !t.is_empty()),
                version.clone(),
                release.clone(),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" - ");
            let mut c = candidate(
                T,
                "Gestdown",
                s["downloadUri"].as_str().unwrap_or("").to_owned(),
                title,
                s["release"].as_str().map(str::to_owned).or(version),
                q.language.clone(),
                false,
                s["hearingImpaired"].as_bool().unwrap_or(false),
            );
            c.download_count = s["downloadCount"].as_f64();
            c
        })
        .collect())
}

async fn resolve_show(sh: &Shared, q: &Query) -> Result<Option<String>, String> {
    let url = format!("{}/shows/search/{}", sh.bases.gestdown, enc(&q.title));
    let res = sh
        .limiter
        .fetch(T, || sh.http.get(&url).header("User-Agent", UA), 2, 5.0)
        .await;
    let res = match res {
        Some(r) if r.status().is_success() => r,
        Some(r) => {
            tracing::warn!("Gestdown show search failed: {}", r.status().as_u16());
            return Ok(None);
        }
        None => return Ok(None),
    };
    let body = body_json(res).await?;
    let shows = body["shows"].as_array().filter(|s| !s.is_empty());
    let Some(shows) = shows else { return Ok(None) };
    let id = |s: &serde_json::Value| s["id"].as_str().map(str::to_owned);
    if let Some(t) = q.tmdb_id.filter(|t| *t != 0)
        && let Some(m) = shows.iter().find(|s| s["tmdbId"].as_i64() == Some(t))
    {
        return Ok(id(m));
    }
    Ok(id(&shows[0]))
}

pub async fn download(sh: &Shared, c: &Candidate) -> Result<Vec<u8>, String> {
    if sh.limiter.is_rate_limited(T) {
        return Err("Gestdown is rate-limited, try again later".into());
    }
    let url = provider_url(&sh.bases.gestdown, &c.provider_file_id)?;
    let res = match sh
        .limiter
        .fetch(T, || sh.http.get(&url).header("User-Agent", UA), 2, 5.0)
        .await
    {
        Some(r) if r.status().is_success() => r,
        other => {
            return Err(failed(
                "Gestdown download failed",
                other.as_ref(),
                "undefined",
            ));
        }
    };
    body_bytes(res, MAX_BODY).await
}

pub async fn test(sh: &Shared) -> TestResult {
    let url = format!("{}/shows/search/test", sh.bases.gestdown);
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

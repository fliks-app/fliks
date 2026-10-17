//! Subsynchro: a JSON endpoint of a French site (`subtitle-providers.md` rule 28).
use super::{
    MAX_BODY, Query, Shared, TestResult, body_bytes, body_json, candidate, failed, net,
    provider_url, test_result, with_params,
};
use fliks_domain::subtitle_score::Candidate;

const T: &str = "subsynchro";
const UA: &str = "Fliks";

fn search_url(sh: &Shared) -> String {
    format!("{}/include/ajax/subMarin.php", sh.bases.subsynchro)
}

pub async fn search(sh: &Shared, q: &Query) -> Result<Vec<Candidate>, String> {
    if sh.limiter.is_rate_limited(T) || q.season.is_some() || q.episode.is_some() {
        return Ok(vec![]);
    }
    let mut p = vec![("title", q.title.clone())];
    if let Some(y) = q.year.filter(|y| *y != 0) {
        p.push(("year", y.to_string()));
    }
    let url = with_params(&search_url(sh), &p)?;
    let get = || {
        sh.http
            .get(url.clone())
            .header("User-Agent", UA)
            .header("Referer", &sh.bases.subsynchro)
    };
    let Some(res) = sh.limiter.fetch(T, get, 2, 60.0).await else {
        return Ok(vec![]);
    };
    if !res.status().is_success() {
        tracing::warn!("Subsynchro search failed: {}", res.status().as_u16());
        return Ok(vec![]);
    }
    let body = body_json(res).await?;
    let (true, Some(data)) = (body["status"] == 200, body["data"].as_array()) else {
        return Ok(vec![]);
    };
    let text =
        |v: &serde_json::Value, k: &str| v[k].as_str().filter(|s| !s.is_empty()).map(str::to_owned);
    Ok(data
        .iter()
        .map(|i| {
            let release = text(i, "release").or_else(|| text(i, "filename"));
            let label = release
                .clone()
                .or_else(|| text(i, "titre_original"))
                .or_else(|| text(i, "titre"))
                .unwrap_or_default();
            candidate(
                T,
                "Subsynchro",
                i["telechargement"].as_str().unwrap_or("").to_owned(),
                label,
                release,
                "fr".into(),
                false,
                false,
            )
        })
        .collect())
}

pub async fn download(sh: &Shared, c: &Candidate) -> Result<Vec<u8>, String> {
    let url = provider_url(&sh.bases.subsynchro, &c.provider_file_id)?;
    if sh.limiter.is_rate_limited(T) {
        return Err("Subsynchro is rate-limited, try again later".into());
    }
    let get = || {
        sh.http
            .get(&url)
            .header("User-Agent", UA)
            .header("Referer", &sh.bases.subsynchro)
    };
    let res = match sh.limiter.fetch(T, get, 2, 60.0).await {
        Some(r) if r.status().is_success() => r,
        other => {
            return Err(failed(
                "Subsynchro download failed",
                other.as_ref(),
                "undefined",
            ));
        }
    };
    let buf = body_bytes(res, MAX_BODY).await?;
    if buf.len() > 4 && buf.starts_with(b"PK") {
        return super::zip::extract_subtitle(&buf, true);
    }
    Ok(buf)
}

pub async fn test(sh: &Shared) -> TestResult {
    let url = match with_params(&search_url(sh), &[("title", "test".into())]) {
        Ok(u) => u,
        Err(e) => return TestResult::fail(e),
    };
    let req = sh
        .http
        .get(url)
        .header("User-Agent", UA)
        .header("Referer", &sh.bases.subsynchro);
    match req.timeout(super::limiter::FETCH_TIMEOUT).send().await {
        Ok(r) => test_result(r).await,
        Err(e) => TestResult::fail(net(e)),
    }
}

//! Supersubtitles = feliratok.eu (`subtitle-providers.md` rules 29-32); the movie page is scraped.
use super::{
    MAX_BODY, Query, Shared, TestResult, body_bytes, body_text, candidate, enc, failed, net,
    test_result,
};
use fliks_domain::subtitle_score::Candidate;
use serde_json::Value;
use std::sync::LazyLock;

const T: &str = "supersubtitles";
const AGENTS: [&str; 4] = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

fn agent() -> &'static str {
    let mut b = [0u8; 1];
    getrandom::fill(&mut b).expect("os rng");
    AGENTS[b[0] as usize % AGENTS.len()]
}

fn get(sh: &Shared, url: &str) -> reqwest::RequestBuilder {
    sh.http
        .get(url)
        .header("User-Agent", agent())
        .header("Referer", format!("{}/index.php", sh.bases.supersubtitles))
}

fn map_language(lang: &str) -> String {
    let l = lang.to_lowercase();
    if l.contains("magyar") || l.contains("hungarian") || l == "hu" {
        "hu".into()
    } else if l.contains("angol") || l.contains("english") || l == "en" {
        "en".into()
    } else {
        l
    }
}

pub async fn search(sh: &Shared, q: &Query) -> Result<Vec<Candidate>, String> {
    if sh.limiter.is_rate_limited(T) {
        return Ok(vec![]);
    }
    if q.season.is_some() && q.episode.is_some() {
        episode(sh, q).await
    } else {
        movie(sh, q).await
    }
}

/// An empty or non-JSON body is `None`, never an error.
async fn parse_json(res: reqwest::Response) -> Result<Option<Value>, String> {
    let text = body_text(res).await?;
    if text.trim().is_empty() {
        return Ok(None);
    }
    Ok(serde_json::from_str(&text).ok())
}

async fn series_id(sh: &Shared, title: &str) -> Result<Option<String>, String> {
    let url = format!(
        "{}/index.php?term={}&nyelv=0&action=autoname",
        sh.bases.supersubtitles,
        enc(title)
    );
    let Some(res) = sh
        .limiter
        .fetch(T, || get(sh, &url), 2, 60.0)
        .await
        .filter(|r| r.status().is_success())
    else {
        return Ok(None);
    };
    let Some(Value::Array(rows)) = parse_json(res).await? else {
        return Ok(None);
    };
    let norm = title.to_lowercase();
    let norm = norm.trim();
    let hit = rows
        .iter()
        .find(|r| {
            r["name"]
                .as_str()
                .is_some_and(|n| n.to_lowercase().trim() == norm)
        })
        .or_else(|| rows.first());
    let id = hit
        .map(|h| match &h["ID"] {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            _ => String::new(),
        })
        .filter(|i| !i.is_empty() && i.bytes().all(|b| b.is_ascii_digit()));
    Ok(id)
}

async fn episode(sh: &Shared, q: &Query) -> Result<Vec<Candidate>, String> {
    let Some(sid) = series_id(sh, &q.title).await? else {
        return Ok(vec![]);
    };
    let (season, ep) = (q.season.unwrap_or(1), q.episode.unwrap_or(1));
    let url = format!(
        "{}/index.php?action=xbmc&sid={sid}&ev={season}&rtol={ep}",
        sh.bases.supersubtitles
    );
    let Some(res) = sh.limiter.fetch(T, || get(sh, &url), 2, 60.0).await else {
        return Ok(vec![]);
    };
    if !res.status().is_success() {
        tracing::warn!(
            "Supersubtitles episode search failed: {}",
            res.status().as_u16()
        );
        return Ok(vec![]);
    }
    let items: Vec<Value> = match parse_json(res).await? {
        Some(Value::Object(o)) => o.into_iter().map(|(_, v)| v).collect(),
        Some(Value::Array(a)) => a,
        _ => return Ok(vec![]),
    };
    let s = |v: &Value, k: &str| -> String {
        match &v[k] {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        }
    };
    let mut out = vec![];
    for i in &items {
        let felirat = match &i["felirat"] {
            Value::Null | Value::Bool(false) => continue,
            Value::Number(n) if n.as_f64() == Some(0.0) => continue,
            Value::String(t) if t.is_empty() => continue,
            v => v.as_str().map_or_else(|| v.to_string(), str::to_owned),
        };
        if i["evadpakk"] == "1" {
            continue;
        }
        let lang = map_language(&s(i, "language"));
        if !q.language.is_empty() && lang != q.language {
            continue;
        }
        let (fnev, nev) = (s(i, "fnev"), s(i, "nev"));
        let label = [&fnev, &nev]
            .into_iter()
            .find(|v| !v.is_empty())
            .cloned()
            .unwrap_or_else(|| format!("S{}E{} - {}", s(i, "evad"), s(i, "ep"), q.title));
        let release = [&fnev, &nev].into_iter().find(|v| !v.is_empty()).cloned();
        let forced = nev.to_lowercase().contains("forced");
        out.push(candidate(
            T,
            "Supersubtitles",
            felirat,
            label,
            release,
            lang,
            forced,
            false,
        ));
    }
    Ok(out)
}

async fn movie(sh: &Shared, q: &Query) -> Result<Vec<Candidate>, String> {
    let url = format!(
        "{}/index.php?search={}&soriSorszam=&nyelv=&tab=film",
        sh.bases.supersubtitles,
        enc(&q.title)
    );
    let Some(res) = sh.limiter.fetch(T, || get(sh, &url), 2, 60.0).await else {
        return Ok(vec![]);
    };
    if !res.status().is_success() {
        tracing::warn!(
            "Supersubtitles movie search failed: {}",
            res.status().as_u16()
        );
        return Ok(vec![]);
    }
    Ok(parse_movie_results(&body_text(res).await?, &q.language))
}

fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&#39;", "'")
}

pub fn parse_movie_results(html: &str, language: &str) -> Vec<Candidate> {
    static LINK: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"action=letolt[^"']*?[&?](?:amp;)?felirat=([0-9]+)"#).expect("static")
    });
    static LANG: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)class="lang"[^>]*>\s*<small>([^<]+)</small>"#).expect("static")
    });
    static RELEASE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)class="eredeti"[^>]*>([^<]*)<"#).expect("static")
    });
    static ROW: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)<tr[^>]*>").expect("static"));
    let mut out = vec![];
    for row in ROW.split(html) {
        let Some(link) = LINK.captures(row) else {
            continue;
        };
        let id = link[1].to_owned();
        let lang = LANG
            .captures(row)
            .map_or_else(|| "hu".to_owned(), |m| map_language(m[1].trim()));
        if !language.is_empty() && lang != language {
            continue;
        }
        let release = RELEASE
            .captures(row)
            .map(|m| m[1].trim().to_owned())
            .filter(|r| !r.is_empty());
        let label = decode_entities(&release.unwrap_or_else(|| format!("Movie subtitle #{id}")));
        let forced = row.to_lowercase().contains("forced") || row.contains("szinkronoshoz");
        out.push(candidate(
            T,
            "Supersubtitles",
            id,
            label.clone(),
            Some(label),
            lang,
            forced,
            false,
        ));
    }
    out
}

pub async fn download(sh: &Shared, c: &Candidate) -> Result<Vec<u8>, String> {
    if sh.limiter.is_rate_limited(T) {
        return Err("Supersubtitles is rate-limited, try again later".into());
    }
    let url = format!(
        "{}/index.php?action=letolt&felirat={}",
        sh.bases.supersubtitles,
        enc(&c.provider_file_id)
    );
    let res = match sh.limiter.fetch(T, || get(sh, &url), 2, 60.0).await {
        Some(r) if r.status().is_success() => r,
        other => {
            return Err(failed(
                "Supersubtitles download failed",
                other.as_ref(),
                "undefined",
            ));
        }
    };
    let body = body_bytes(res, MAX_BODY).await?;
    // The site may answer a ZIP.
    if body.starts_with(b"PK\x03\x04") {
        return super::zip::extract_subtitle(&body, true);
    }
    Ok(body)
}

pub async fn test(sh: &Shared) -> TestResult {
    let url = format!(
        "{}/index.php?term=test&nyelv=0&action=autoname",
        sh.bases.supersubtitles
    );
    match get(sh, &url)
        .timeout(super::limiter::FETCH_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => test_result(r).await,
        Err(e) => TestResult::fail(net(e)),
    }
}

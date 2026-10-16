//! YIFY: HTML scraper of a movie page and its subtitle pages (`subtitle-providers.md` rules 33-35).
use super::{
    MAX_BODY, Query, Shared, TestResult, body_bytes, body_text, candidate, failed, net,
    provider_url, test_result,
};
use fliks_domain::subtitle_score::Candidate;
use std::sync::LazyLock;

const T: &str = "yify";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/// ISO 639-1 to the language name the site prints; shared with Gestdown.
pub const LANGUAGES: [(&str, &str); 31] = [
    ("en", "English"),
    ("fr", "French"),
    ("es", "Spanish"),
    ("de", "German"),
    ("it", "Italian"),
    ("pt", "Portuguese"),
    ("nl", "Dutch"),
    ("pl", "Polish"),
    ("ro", "Romanian"),
    ("tr", "Turkish"),
    ("ar", "Arabic"),
    ("bg", "Bulgarian"),
    ("hr", "Croatian"),
    ("cs", "Czech"),
    ("da", "Danish"),
    ("fi", "Finnish"),
    ("el", "Greek"),
    ("he", "Hebrew"),
    ("hu", "Hungarian"),
    ("id", "Indonesian"),
    ("ja", "Japanese"),
    ("ko", "Korean"),
    ("no", "Norwegian"),
    ("ru", "Russian"),
    ("sr", "Serbian"),
    ("sl", "Slovenian"),
    ("sv", "Swedish"),
    ("th", "Thai"),
    ("uk", "Ukrainian"),
    ("vi", "Vietnamese"),
    ("zh", "Chinese"),
];

pub fn language_name(iso: &str) -> Option<&'static str> {
    LANGUAGES.iter().find(|(k, _)| *k == iso).map(|(_, v)| *v)
}

pub async fn search(sh: &Shared, q: &Query) -> Result<Vec<Candidate>, String> {
    let Some(imdb) = q.imdb_id.as_deref().filter(|i| !i.is_empty()) else {
        return Ok(vec![]);
    };
    if sh.limiter.is_rate_limited(T) || q.season.is_some() {
        return Ok(vec![]);
    }
    let url = format!("{}/movie-imdb/{imdb}", sh.bases.yify);
    let Some(res) = sh
        .limiter
        .fetch(T, || sh.plain.get(&url).header("User-Agent", UA), 2, 60.0)
        .await
    else {
        return Ok(vec![]);
    };
    if res.status().as_u16() >= 300 {
        return Ok(vec![]);
    }
    let html = body_text(res).await?;
    let target = language_name(&q.language).map(str::to_lowercase);
    Ok(parse_results(&html, target.as_deref(), &q.language))
}

fn strip_tags(html: &str) -> String {
    static TAG: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"<[^>]+>").expect("static"));
    TAG.replace_all(html, "").into_owned()
}

pub fn parse_results(html: &str, target: Option<&str>, iso: &str) -> Vec<Candidate> {
    static TABLE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
            r#"(?i)<table[^>]*class="[^"]*other-subs[^"]*"[^>]*>[\s\S]*?<tbody>([\s\S]*?)</tbody>"#,
        )
        .expect("static")
    });
    static ROW: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)<tr[^>]*>([\s\S]*?)</tr>").expect("static"));
    static CELL: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)<td[^>]*>([\s\S]*?)</td>").expect("static"));
    static LANG: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"(?i)class="sub-lang"[^>]*>([\s\S]*?)</span>"#).expect("static")
    });
    static HREF: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r#"href="([^"]+)""#).expect("static"));
    static ANCHOR: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)<a[^>]*>([\s\S]*?)</a>").expect("static"));
    static LEAD: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"(?i)^\s*subtitle\s*").expect("static"));
    let Some(tbody) = TABLE.captures(html) else {
        return vec![];
    };
    let mut out = vec![];
    for row in ROW.captures_iter(&tbody[1]) {
        let cells: Vec<&str> = CELL
            .captures_iter(row.get(1).map_or("", |m| m.as_str()))
            .filter_map(|c| c.get(1))
            .map(|m| m.as_str())
            .collect();
        if cells.len() < 5 {
            continue;
        }
        let language = LANG
            .captures(cells[1])
            .map(|m| strip_tags(&m[1]).trim().to_lowercase())
            .unwrap_or_default();
        if target.is_some_and(|t| language != t) {
            continue;
        }
        let Some(href) = HREF.captures(cells[2]) else {
            continue;
        };
        let page = href[1].trim().to_owned();
        let raw = ANCHOR
            .captures(cells[2])
            .map(|m| strip_tags(&m[1]))
            .unwrap_or_default();
        let release = LEAD.replace(&raw, "").trim().to_owned();
        if release.is_empty() {
            continue;
        }
        let hi = regex::Regex::new(r"(?i)hi-subtitle")
            .expect("static")
            .is_match(cells[3]);
        out.push(candidate(
            T,
            "YIFY",
            page,
            release.clone(),
            Some(release),
            iso.to_owned(),
            false,
            hi,
        ));
    }
    out
}

pub async fn download(sh: &Shared, c: &Candidate) -> Result<Vec<u8>, String> {
    if sh.limiter.is_rate_limited(T) {
        return Err("YIFY is rate-limited, try again later".into());
    }
    let page_url = provider_url(&sh.bases.yify, &c.provider_file_id)?;
    let page = match sh
        .limiter
        .fetch(
            T,
            || sh.http.get(&page_url).header("User-Agent", UA),
            2,
            60.0,
        )
        .await
    {
        Some(r) if r.status().is_success() => r,
        other => {
            return Err(failed(
                "YIFY subtitle page failed",
                other.as_ref(),
                "undefined",
            ));
        }
    };
    let html = body_text(page).await?;
    static LINK: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r#"class="download-subtitle"[^>]*href="([^"]+)""#).expect("static")
    });
    let Some(link) = LINK.captures(&html) else {
        return Err("YIFY: download link not found on subtitle page".into());
    };
    let url = provider_url(&sh.bases.yify, &link[1])?;
    let res = match sh
        .limiter
        .fetch(T, || sh.http.get(&url).header("User-Agent", UA), 2, 60.0)
        .await
    {
        Some(r) if r.status().is_success() => r,
        other => return Err(failed("YIFY download failed", other.as_ref(), "undefined")),
    };
    super::zip::extract_subtitle(&body_bytes(res, MAX_BODY).await?, false)
}

pub async fn test(sh: &Shared) -> TestResult {
    let url = format!("{}/movie-imdb/tt0111161", sh.bases.yify);
    match sh
        .plain
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

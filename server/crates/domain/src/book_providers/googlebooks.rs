//! Google Books (keyless): URL builders and parsers.
use super::util::*;
use super::{BookRecord, Format, Level, ParseError, Person, Provider, Rating, SearchPage};
use serde_json::Value;

const BASE: &str = "https://www.googleapis.com/books/v1";

#[derive(Debug, Default, Clone)]
pub struct Search<'a> {
    pub title: Option<&'a str>,
    pub author: Option<&'a str>,
    pub isbn: Option<&'a str>,
    /// Free text, appended after the `intitle:`/`inauthor:`/`isbn:` terms.
    pub text: Option<&'a str>,
    /// Restricts results to this language (ISO 639-1).
    pub lang: Option<&'a str>,
    /// At most 40.
    pub max_results: Option<u32>,
    pub start_index: Option<u32>,
}

/// `None` when there is nothing to search for.
pub fn search_url(s: &Search) -> Option<String> {
    let isbn = s.isbn.and_then(isbn13);
    let terms = [
        isbn.map(|i| format!("isbn:{i}")),
        s.title.and_then(clean).map(|t| format!("intitle:{t}")),
        s.author.and_then(clean).map(|a| format!("inauthor:{a}")),
        s.text.and_then(clean),
    ];
    let q: Vec<String> = terms.into_iter().flatten().collect();
    if q.is_empty() {
        return None;
    }
    let (max, start) = (
        s.max_results.map(|n| n.to_string()),
        s.start_index.map(|n| n.to_string()),
    );
    let mut p = vec![("q", q.join(" ")), ("printType", "books".into())];
    let opt = [
        ("langRestrict", s.lang.map(String::from)),
        ("maxResults", max),
        ("startIndex", start),
    ];
    p.extend(opt.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))));
    Some(
        url::Url::parse_with_params(&format!("{BASE}/volumes"), p)
            .expect("constant base")
            .into(),
    )
}

pub fn volume_url(id: &str) -> Option<String> {
    let ok = !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then(|| format!("{BASE}/volumes/{id}"))
}

fn check_error(v: &Value) -> Result<(), ParseError> {
    let Some(e) = v.get("error") else {
        return Ok(());
    };
    let reason = e
        .pointer("/errors/0/reason")
        .and_then(Value::as_str)
        .unwrap_or("");
    let limited = e.get("code").and_then(Value::as_u64) == Some(429)
        || matches!(
            reason,
            "rateLimitExceeded" | "dailyLimitExceeded" | "userRateLimitExceeded" | "quotaExceeded"
        );
    if limited {
        return Err(ParseError::RateLimited);
    }
    if e.get("code").and_then(Value::as_u64) == Some(404) {
        return Err(ParseError::NotFound);
    }
    Err(ParseError::Api(
        text(e, "message").unwrap_or_else(|| reason.into()),
    ))
}

/// `http` to `https`, curl-edge effect dropped.
fn cover_url(u: &str) -> String {
    u.replacen("http://", "https://", 1)
        .replace("&edge=curl", "")
}

fn item(v: &Value) -> Option<BookRecord> {
    let info = v.get("volumeInfo")?;
    let mut r = BookRecord::new(Provider::GoogleBooks, Level::Edition, text(info, "title")?);
    r.ids.edition = text(v, "id");
    let ids = info.get("industryIdentifiers").and_then(Value::as_array);
    for i in ids.into_iter().flatten() {
        if matches!(text(i, "type").as_deref(), Some("ISBN_13" | "ISBN_10")) {
            text(i, "identifier")
                .iter()
                .for_each(|x| add_isbn(&mut r.ids.isbn13, x));
        }
    }
    r.subtitle = text(info, "subtitle");
    r.authors = texts(info, "authors")
        .into_iter()
        .map(|n| Person {
            name: Some(n),
            id: None,
        })
        .collect();
    r.language = text(info, "language").and_then(|l| language(&l));
    r.publisher = text(info, "publisher");
    r.published = text(info, "publishedDate").and_then(|d| partial_date(&d));
    r.description = text(info, "description");
    for c in texts(info, "categories") {
        push_unique(&mut r.subjects, c);
    }
    r.page_count = uint(info, "pageCount").filter(|n| *n > 0);
    let links = info.get("imageLinks");
    let sizes = [
        "extraLarge",
        "large",
        "medium",
        "small",
        "thumbnail",
        "smallThumbnail",
    ];
    r.covers = sizes
        .iter()
        .filter_map(|s| links?.get(s)?.as_str())
        .map(cover_url)
        .collect();
    r.rating = info
        .get("averageRating")
        .and_then(Value::as_f64)
        .map(|a| Rating {
            average: round2(a),
            count: uint(info, "ratingsCount"),
        });
    r.format = v
        .pointer("/saleInfo/isEbook")
        .and_then(Value::as_bool)
        .map(|e| if e { Format::Ebook } else { Format::Print });
    Some(r)
}

/// `volumes?q=`: `items` is absent when nothing matched.
pub fn parse_volumes(body: &str) -> Result<SearchPage, ParseError> {
    let v = json(body)?;
    check_error(&v)?;
    let items = v.get("items").and_then(Value::as_array);
    Ok(SearchPage {
        total: v.get("totalItems").and_then(Value::as_u64),
        records: items.into_iter().flatten().filter_map(item).collect(),
    })
}

/// `volumes/{id}`.
pub fn parse_volume(body: &str) -> Result<BookRecord, ParseError> {
    let v = json(body)?;
    check_error(&v)?;
    item(&v).ok_or(ParseError::NotFound)
}

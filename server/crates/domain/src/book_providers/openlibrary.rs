//! OpenLibrary: URL builders and parsers (works, editions, search, authors).
use super::util::*;
use super::{
    BookRecord, Format, Level, ParseError, Person, PersonRecord, Provider, Rating, SearchPage,
};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const BASE: &str = "https://openlibrary.org";
const COVERS: &str = "https://covers.openlibrary.org";
const SEARCH_FIELDS: &str = "key,title,subtitle,author_name,author_key,first_publish_year,edition_count,isbn,cover_i,number_of_pages_median,subject,ratings_average,ratings_count";

#[derive(Debug, Default, Clone)]
pub struct Search<'a> {
    pub title: Option<&'a str>,
    pub author: Option<&'a str>,
    pub isbn: Option<&'a str>,
    pub q: Option<&'a str>,
    /// Prefers editions in this language.
    pub lang: Option<&'a str>,
    pub limit: Option<u32>,
    pub page: Option<u32>,
}

fn url(path: &str, params: &[(&str, &str)]) -> String {
    let full = format!("{BASE}{path}");
    let parsed = if params.is_empty() {
        url::Url::parse(&full)
    } else {
        url::Url::parse_with_params(&full, params)
    };
    parsed.expect("constant base").into()
}

/// `kind` is `W` (work), `M` (edition) or `A` (author).
fn olid(id: &str, kind: char) -> Option<&str> {
    let digits = id.strip_prefix("OL")?.strip_suffix(kind)?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(id)
}

pub fn search_url(s: &Search) -> String {
    let (limit, page) = (
        s.limit.map(|n| n.to_string()),
        s.page.map(|n| n.to_string()),
    );
    let mut p = vec![("fields", SEARCH_FIELDS)];
    let opt = [
        ("title", s.title),
        ("author", s.author),
        ("isbn", s.isbn),
        ("q", s.q),
        ("lang", s.lang),
        ("limit", limit.as_deref()),
        ("page", page.as_deref()),
    ];
    p.extend(opt.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))));
    url("/search.json", &p)
}

/// Redirects (302) to the edition: the client must follow it.
pub fn isbn_url(isbn: &str) -> Option<String> {
    Some(url(&format!("/isbn/{}.json", isbn13(isbn)?), &[]))
}

/// Up to one call for a batch of ISBNs, answered by `parse_isbn_batch`.
pub fn isbn_batch_url(isbns: &[&str]) -> Option<String> {
    let keys: Vec<String> = isbns
        .iter()
        .filter_map(|i| isbn13(i))
        .map(|i| format!("ISBN:{i}"))
        .collect();
    (!keys.is_empty()).then(|| {
        url(
            "/api/books",
            &[
                ("bibkeys", &keys.join(",")),
                ("format", "json"),
                ("jscmd", "data"),
            ],
        )
    })
}

pub fn work_url(id: &str) -> Option<String> {
    Some(url(&format!("/works/{}.json", olid(id, 'W')?), &[]))
}

pub fn work_editions_url(id: &str, limit: u32, offset: u32) -> Option<String> {
    let (l, o) = (limit.to_string(), offset.to_string());
    Some(url(
        &format!("/works/{}/editions.json", olid(id, 'W')?),
        &[("limit", &l), ("offset", &o)],
    ))
}

pub fn edition_url(id: &str) -> Option<String> {
    Some(url(&format!("/books/{}.json", olid(id, 'M')?), &[]))
}

pub fn author_url(id: &str) -> Option<String> {
    Some(url(&format!("/authors/{}.json", olid(id, 'A')?), &[]))
}

fn cover(id: i64) -> Option<String> {
    (id > 0).then(|| format!("{COVERS}/b/id/{id}-L.jpg"))
}

fn covers(v: &Value, key: &str) -> Vec<String> {
    let ids = v.get(key).and_then(Value::as_array);
    ids.into_iter()
        .flatten()
        .filter_map(Value::as_i64)
        .filter_map(cover)
        .collect()
}

/// `/works/OL1W` to `OL1W`.
fn last_segment(key: &str) -> Option<String> {
    key.rsplit('/').next().and_then(clean)
}

fn key_id(v: &Value) -> Option<String> {
    v.get("key").and_then(Value::as_str).and_then(last_segment)
}

/// A plain string or `{"type": "/type/text", "value": ...}`.
fn rich_text(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::String(s) => clean(s),
        o => o.get("value").and_then(Value::as_str).and_then(clean),
    }
}

/// `{key}` (edition) or `{author: {key}}` (work).
fn author_refs(v: &Value) -> Vec<Person> {
    let list = v.get("authors").and_then(Value::as_array);
    list.into_iter()
        .flatten()
        .filter_map(|a| key_id(a).or_else(|| a.get("author").and_then(key_id)))
        .map(|id| Person {
            name: None,
            id: Some(id),
        })
        .collect()
}

fn check_error(v: &Value) -> Result<(), ParseError> {
    if v.get("error").is_some() {
        return Err(ParseError::NotFound);
    }
    let kind = v.pointer("/type/key").and_then(Value::as_str);
    match kind {
        Some("/type/redirect") => Err(ParseError::Moved(
            text(v, "location").as_deref().and_then(last_segment),
        )),
        Some("/type/delete") => Err(ParseError::Moved(None)),
        _ => Ok(()),
    }
}

fn format_of(physical: &str) -> Option<Format> {
    let p = physical.to_lowercase();
    let has = |w: &[&str]| w.iter().any(|w| p.contains(w));
    if has(&["audio", "cassette", "mp3"]) {
        Some(Format::Audio)
    } else if has(&["ebook", "electronic", "kindle", "epub", "pdf", "digital"]) {
        Some(Format::Ebook)
    } else if has(&[
        "paperback",
        "hardcover",
        "hardback",
        "board",
        "print",
        "leather",
        "spiral",
        "pocket",
        "mass market",
        "cloth",
    ]) {
        Some(Format::Print)
    } else {
        None
    }
}

static PAGES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{1,5})\s*p\b").unwrap());

fn edition_record(v: &Value) -> Result<BookRecord, ParseError> {
    check_error(v)?;
    let title = text(v, "title").ok_or(ParseError::NotFound)?;
    let mut r = BookRecord::new(Provider::OpenLibrary, Level::Edition, title);
    r.ids.edition = key_id(v);
    r.ids.work = v.pointer("/works/0").and_then(key_id);
    for k in ["isbn_13", "isbn_10"] {
        texts(v, k)
            .iter()
            .for_each(|i| add_isbn(&mut r.ids.isbn13, i));
    }
    r.subtitle = text(v, "subtitle");
    r.series = texts(v, "series")
        .iter()
        .filter_map(|s| series_label(s))
        .collect();
    r.authors = author_refs(v);
    let contributors = v.get("contributors").and_then(Value::as_array);
    for c in contributors.into_iter().flatten() {
        let person = Person {
            name: text(c, "name"),
            id: None,
        };
        let role = text(c, "role").unwrap_or_default().to_lowercase();
        if role.contains("translat") {
            r.translators.push(person);
        } else if role.contains("narrat") || role.contains("read by") {
            r.narrators.push(person);
        }
    }
    r.language = v
        .pointer("/languages/0")
        .and_then(key_id)
        .and_then(|l| language(&l));
    r.publisher = texts(v, "publishers").into_iter().next();
    r.published = text(v, "publish_date").and_then(|d| partial_date(&d));
    r.description = rich_text(v, "description");
    r.subjects = texts(v, "subjects");
    r.page_count = uint(v, "number_of_pages").filter(|n| *n > 0).or_else(|| {
        let p = text(v, "pagination")?;
        PAGES.captures_iter(&p).last()?[1].parse().ok()
    });
    r.covers = covers(v, "covers");
    r.format = text(v, "physical_format").and_then(|f| format_of(&f));
    Ok(r)
}

pub fn parse_edition(body: &str) -> Result<BookRecord, ParseError> {
    edition_record(&json(body)?)
}

/// `/works/{id}/editions.json`: `{entries: [edition]}`; entries without a title are dropped.
pub fn parse_editions(body: &str) -> Result<SearchPage, ParseError> {
    let v = json(body)?;
    let entries = v.get("entries").and_then(Value::as_array);
    let records = entries
        .into_iter()
        .flatten()
        .filter_map(|e| edition_record(e).ok())
        .collect();
    Ok(SearchPage {
        total: v.get("size").and_then(Value::as_u64),
        records,
    })
}

pub fn parse_work(body: &str) -> Result<BookRecord, ParseError> {
    let v = json(body)?;
    check_error(&v)?;
    let title = text(&v, "title").ok_or(ParseError::NotFound)?;
    let mut r = BookRecord::new(Provider::OpenLibrary, Level::Work, title);
    r.ids.work = key_id(&v);
    r.subtitle = text(&v, "subtitle");
    r.authors = author_refs(&v);
    r.description = rich_text(&v, "description");
    r.subjects = texts(&v, "subjects");
    r.published = text(&v, "first_publish_date").and_then(|d| partial_date(&d));
    r.covers = covers(&v, "covers");
    Ok(r)
}

pub fn parse_search(body: &str) -> Result<SearchPage, ParseError> {
    let v = json(body)?;
    let docs = v
        .get("docs")
        .and_then(Value::as_array)
        .ok_or_else(|| ParseError::Malformed("no docs".into()))?;
    let records = docs.iter().filter_map(search_doc).collect();
    let total = v
        .get("numFound")
        .or_else(|| v.get("num_found"))
        .and_then(Value::as_u64);
    Ok(SearchPage { total, records })
}

fn search_doc(d: &Value) -> Option<BookRecord> {
    let mut r = BookRecord::new(Provider::OpenLibrary, Level::Work, text(d, "title")?);
    r.ids.work = key_id(d);
    texts(d, "isbn")
        .iter()
        .for_each(|i| add_isbn(&mut r.ids.isbn13, i));
    r.subtitle = text(d, "subtitle");
    let (names, keys) = (texts(d, "author_name"), texts(d, "author_key"));
    r.authors = (0..names.len().max(keys.len()))
        .map(|i| Person {
            name: names.get(i).cloned(),
            id: keys.get(i).cloned(),
        })
        .collect();
    r.published = d
        .get("first_publish_year")
        .and_then(Value::as_u64)
        .map(|y| y.to_string());
    r.page_count = uint(d, "number_of_pages_median");
    r.subjects = texts(d, "subject");
    r.covers = d
        .get("cover_i")
        .and_then(Value::as_i64)
        .and_then(cover)
        .into_iter()
        .collect();
    r.rating = d
        .get("ratings_average")
        .and_then(Value::as_f64)
        .map(|a| Rating {
            average: round2(a),
            count: uint(d, "ratings_count"),
        });
    Some(r)
}

/// `/api/books?bibkeys=...&jscmd=data`: `{"ISBN:...": {...}}`, one record per known ISBN (sorted by key).
pub fn parse_isbn_batch(body: &str) -> Result<Vec<BookRecord>, ParseError> {
    let v = json(body)?;
    let map = v
        .as_object()
        .ok_or_else(|| ParseError::Malformed("not an object".into()))?;
    let names = |v: &Value, k: &str| -> Vec<Value> {
        v.get(k)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    Ok(map
        .iter()
        .filter_map(|(key, b)| {
            let mut r = BookRecord::new(Provider::OpenLibrary, Level::Edition, text(b, "title")?);
            r.ids.edition = key_id(b);
            add_isbn(&mut r.ids.isbn13, key.trim_start_matches("ISBN:"));
            for k in ["isbn_13", "isbn_10"] {
                let ids = b.pointer(&format!("/identifiers/{k}"));
                let ids = ids
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str);
                ids.for_each(|i| add_isbn(&mut r.ids.isbn13, i));
            }
            r.subtitle = text(b, "subtitle");
            r.authors = names(b, "authors")
                .iter()
                .map(|a| Person {
                    name: text(a, "name"),
                    id: text(a, "url").and_then(|u| u.split('/').rev().nth(1).and_then(clean)),
                })
                .collect();
            r.publisher = names(b, "publishers").iter().find_map(|p| text(p, "name"));
            r.published = text(b, "publish_date").and_then(|d| partial_date(&d));
            r.page_count = uint(b, "number_of_pages");
            r.subjects = names(b, "subjects")
                .iter()
                .filter_map(|s| text(s, "name"))
                .collect();
            r.covers = ["large", "medium", "small"]
                .iter()
                .filter_map(|s| {
                    b.pointer(&format!("/cover/{s}"))?
                        .as_str()
                        .map(String::from)
                })
                .collect();
            Some(r)
        })
        .collect())
}

pub fn parse_author(body: &str) -> Result<PersonRecord, ParseError> {
    let v = json(body)?;
    check_error(&v)?;
    let name = text(&v, "name")
        .or_else(|| text(&v, "personal_name"))
        .ok_or(ParseError::NotFound)?;
    let photos = v
        .get("photos")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    Ok(PersonRecord {
        provider: Provider::OpenLibrary,
        id: key_id(&v).ok_or_else(|| ParseError::Malformed("no key".into()))?,
        name,
        alternate_names: texts(&v, "alternate_names"),
        bio: rich_text(&v, "bio"),
        birth_date: text(&v, "birth_date"),
        death_date: text(&v, "death_date"),
        photos: photos
            .filter_map(Value::as_i64)
            .filter(|id| *id > 0)
            .map(|id| format!("{COVERS}/a/id/{id}-L.jpg"))
            .collect(),
        remote_ids: v
            .get("remote_ids")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str().and_then(clean)?)))
            .collect(),
    })
}

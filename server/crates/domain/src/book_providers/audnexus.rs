//! Audnexus (`api.audnex.us`) by ASIN: books, chapters, authors.
use super::audible::Region;
use super::util::*;
use super::{
    BookRecord, Format, Level, ParseError, Person, PersonRecord, Provider, Rating, Series,
};
use serde::Serialize;
use serde_json::Value;

const BASE: &str = "https://api.audnex.us";

fn asin_url(kind: &str, suffix: &str, asin: &str, region: Option<Region>) -> Option<String> {
    let ok = asin.len() == 10
        && asin
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    let path = format!("{BASE}/{kind}/{asin}{suffix}");
    ok.then(|| match region {
        Some(r) => format!("{path}?region={}", r.code()),
        None => path,
    })
}

/// Without `region` the API answers for `us`.
pub fn book_url(asin: &str, region: Option<Region>) -> Option<String> {
    asin_url("books", "", asin, region)
}

pub fn chapters_url(asin: &str, region: Option<Region>) -> Option<String> {
    asin_url("books", "/chapters", asin, region)
}

/// `asin` is the author ASIN (`B0...`) from a book's `authors`.
pub fn author_url(asin: &str, region: Option<Region>) -> Option<String> {
    asin_url("authors", "", asin, region)
}

fn check_error(v: &Value) -> Result<(), ParseError> {
    let Some(e) = v.get("error") else {
        return Ok(());
    };
    match e.get("code").and_then(Value::as_str).unwrap_or("") {
        // Also the answer for an unknown ASIN.
        "REGION_UNAVAILABLE" => Err(ParseError::NotFound),
        c if c.ends_with("NOT_FOUND") => Err(ParseError::NotFound),
        "RATE_LIMIT_EXCEEDED" => Err(ParseError::RateLimited),
        c => Err(ParseError::Api(
            text(e, "message").unwrap_or_else(|| c.into()),
        )),
    }
}

fn people(v: &Value, key: &str) -> Vec<Person> {
    let list = v.get(key).and_then(Value::as_array);
    list.into_iter()
        .flatten()
        .filter_map(|p| {
            Some(Person {
                name: Some(text(p, "name")?),
                id: text(p, "asin"),
            })
        })
        .collect()
}

pub fn parse_book(body: &str) -> Result<BookRecord, ParseError> {
    let v = json(body)?;
    check_error(&v)?;
    let title = text(&v, "title").ok_or(ParseError::NotFound)?;
    let mut r = BookRecord::new(Provider::Audnexus, Level::Edition, title);
    r.ids.asin = text(&v, "asin");
    text(&v, "isbn")
        .iter()
        .for_each(|i| add_isbn(&mut r.ids.isbn13, i));
    r.subtitle = text(&v, "subtitle");
    for k in ["seriesPrimary", "seriesSecondary"] {
        if let Some(s) = v.get(k).filter(|s| s.is_object()) {
            let name = text(s, "name");
            r.series.extend(name.map(|name| Series {
                name,
                position: text(s, "position"),
                id: text(s, "asin"),
            }));
        }
    }
    r.authors = people(&v, "authors");
    r.narrators = people(&v, "narrators");
    r.language = text(&v, "language").and_then(|l| language(&l));
    r.publisher = text(&v, "publisherName");
    r.published = text(&v, "releaseDate").and_then(|d| partial_date(&d));
    // `summary` keeps the HTML and the full text; `description` is the shorter plain form.
    r.description = text(&v, "summary").or_else(|| text(&v, "description"));
    for g in v
        .get("genres")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        text(g, "name")
            .into_iter()
            .for_each(|n| push_unique(&mut r.subjects, n));
    }
    r.duration_secs = uint(&v, "runtimeLengthMin")
        .filter(|m| *m > 0)
        .map(|m| m * 60);
    r.covers = text(&v, "image").into_iter().collect();
    r.rating = text(&v, "rating")
        .and_then(|s| s.parse::<f64>().ok())
        .map(|a| Rating {
            average: round2(a),
            count: None,
        });
    r.format = Some(Format::Audio);
    Ok(r)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub title: String,
    pub start_ms: u64,
    pub length_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapters {
    pub asin: Option<String>,
    pub runtime_ms: Option<u64>,
    /// `false` when Audnexus derived the chapters instead of reading them.
    pub accurate: Option<bool>,
    pub brand_intro_ms: Option<u64>,
    pub brand_outro_ms: Option<u64>,
    pub chapters: Vec<Chapter>,
}

pub fn parse_chapters(body: &str) -> Result<Chapters, ParseError> {
    let v = json(body)?;
    check_error(&v)?;
    let list = v
        .get("chapters")
        .and_then(Value::as_array)
        .ok_or_else(|| ParseError::Malformed("no chapters".into()))?;
    let ms = |c: &Value, k: &str| c.get(k).and_then(Value::as_u64);
    let chapters = list
        .iter()
        .filter_map(|c| {
            Some(Chapter {
                title: text(c, "title").unwrap_or_default(),
                start_ms: ms(c, "startOffsetMs")?,
                length_ms: ms(c, "lengthMs")?,
            })
        })
        .collect();
    Ok(Chapters {
        asin: text(&v, "asin"),
        runtime_ms: ms(&v, "runtimeLengthMs"),
        accurate: v.get("isAccurate").and_then(Value::as_bool),
        brand_intro_ms: ms(&v, "brandIntroDurationMs"),
        brand_outro_ms: ms(&v, "brandOutroDurationMs"),
        chapters,
    })
}

pub fn parse_author(body: &str) -> Result<PersonRecord, ParseError> {
    let v = json(body)?;
    check_error(&v)?;
    Ok(PersonRecord {
        provider: Provider::Audnexus,
        id: text(&v, "asin").ok_or(ParseError::NotFound)?,
        name: text(&v, "name").ok_or(ParseError::NotFound)?,
        alternate_names: vec![],
        bio: text(&v, "description"),
        birth_date: None,
        death_date: None,
        photos: text(&v, "image").into_iter().collect(),
        remote_ids: Default::default(),
    })
}

//! Audible catalog (unofficial `api.audible.<tld>/1.0/catalog/products`): URL builders and parsers.
use super::util::*;
use super::{BookRecord, Format, Level, ParseError, Person, Provider, SearchPage, Series};
use serde_json::Value;

const RESPONSE_GROUPS: &str = "contributors,media,product_attrs,product_desc,product_details,product_extended_attrs,rating,series,category_ladders";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    Us,
    Uk,
    Fr,
    De,
    It,
    Es,
    Ca,
    Au,
    Jp,
    In,
}

impl Region {
    pub const ALL: [Region; 10] = [
        Self::Us,
        Self::Uk,
        Self::Fr,
        Self::De,
        Self::It,
        Self::Es,
        Self::Ca,
        Self::Au,
        Self::Jp,
        Self::In,
    ];

    /// Domain suffix of `api.audible.<tld>`.
    pub fn tld(self) -> &'static str {
        match self {
            Self::Us => "com",
            Self::Uk => "co.uk",
            Self::Fr => "fr",
            Self::De => "de",
            Self::It => "it",
            Self::Es => "es",
            Self::Ca => "ca",
            Self::Au => "com.au",
            Self::Jp => "co.jp",
            Self::In => "in",
        }
    }

    /// Two-letter code, also the Audnexus `region` value.
    pub fn code(self) -> &'static str {
        match self {
            Self::Us => "us",
            Self::Uk => "uk",
            Self::Fr => "fr",
            Self::De => "de",
            Self::It => "it",
            Self::Es => "es",
            Self::Ca => "ca",
            Self::Au => "au",
            Self::Jp => "jp",
            Self::In => "in",
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|r| r.code() == code.to_lowercase())
    }
}

#[derive(Debug, Default, Clone)]
pub struct Search<'a> {
    pub title: Option<&'a str>,
    pub author: Option<&'a str>,
    pub narrator: Option<&'a str>,
    pub keywords: Option<&'a str>,
    /// At most 50.
    pub num_results: Option<u32>,
    /// 0-based.
    pub page: Option<u32>,
}

fn base(region: Region) -> String {
    format!("https://api.audible.{}/1.0/catalog/products", region.tld())
}

/// `None` when there is nothing to search for.
pub fn search_url(region: Region, s: &Search) -> Option<String> {
    let (n, page) = (
        s.num_results.map(|n| n.to_string()),
        s.page.map(|n| n.to_string()),
    );
    let opt = [
        ("title", s.title),
        ("author", s.author),
        ("narrator", s.narrator),
        ("keywords", s.keywords),
        ("num_results", n.as_deref()),
        ("page", page.as_deref()),
    ];
    let mut p: Vec<(&str, &str)> = opt
        .into_iter()
        .filter_map(|(k, v)| Some((k, clean_ref(v?)?)))
        .collect();
    if !p
        .iter()
        .any(|(k, _)| matches!(*k, "title" | "author" | "narrator" | "keywords"))
    {
        return None;
    }
    p.extend([
        ("response_groups", RESPONSE_GROUPS),
        ("image_sizes", "1024,500"),
        ("products_sort_by", "Relevance"),
    ]);
    Some(
        url::Url::parse_with_params(&base(region), p)
            .expect("constant base")
            .into(),
    )
}

fn clean_ref(s: &str) -> Option<&str> {
    let t = s.trim();
    (!t.is_empty()).then_some(t)
}

/// ASINs are 10 uppercase alphanumerics.
pub fn product_url(region: Region, asin: &str) -> Option<String> {
    let ok = asin.len() == 10
        && asin
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit());
    ok.then(|| {
        let p = [
            ("response_groups", RESPONSE_GROUPS),
            ("image_sizes", "1024,500"),
        ];
        let u = url::Url::parse_with_params(&format!("{}/{asin}", base(region)), p)
            .expect("constant base");
        u.into()
    })
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

fn product(p: &Value) -> Option<BookRecord> {
    // An unknown ASIN answers 200 with a skeleton (asin, rating): no title, no product.
    let mut r = BookRecord::new(Provider::Audible, Level::Edition, text(p, "title")?);
    r.ids.asin = text(p, "asin");
    text(p, "isbn")
        .iter()
        .for_each(|i| add_isbn(&mut r.ids.isbn13, i));
    r.subtitle = text(p, "subtitle");
    let series = p.get("series").and_then(Value::as_array);
    r.series = series
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some(Series {
                name: text(s, "title")?,
                position: text(s, "sequence"),
                id: text(s, "asin"),
            })
        })
        .collect();
    r.authors = people(p, "authors");
    r.narrators = people(p, "narrators");
    r.language = text(p, "language").and_then(|l| language(&l));
    r.publisher = text(p, "publisher_name");
    let date = ["release_date", "issue_date", "publication_datetime"]
        .iter()
        .find_map(|k| text(p, k));
    r.published = date.and_then(|d| partial_date(&d));
    let desc = [
        "publisher_summary",
        "merchandising_summary",
        "extended_product_description",
    ];
    r.description = desc.iter().find_map(|k| text(p, k));
    let ladders = p.get("category_ladders").and_then(Value::as_array);
    for step in ladders
        .into_iter()
        .flatten()
        .filter_map(|l| l.get("ladder")?.as_array())
        .flatten()
    {
        text(step, "name")
            .into_iter()
            .for_each(|n| push_unique(&mut r.subjects, n));
    }
    r.duration_secs = uint(p, "runtime_length_min")
        .filter(|m| *m > 0)
        .and_then(|m| m.checked_mul(60));
    if let Some(images) = p.get("product_images").and_then(Value::as_object) {
        let mut sized: Vec<(u32, &str)> = images
            .iter()
            .filter_map(|(k, v)| Some((k.parse().ok()?, v.as_str()?)))
            .collect();
        sized.sort_by_key(|a| std::cmp::Reverse(a.0));
        r.covers = sized.into_iter().filter_map(|(_, u)| https(u)).collect();
    }
    let dist = p.pointer("/rating/overall_distribution");
    let count = dist.and_then(|d| uint(d, "num_ratings")).filter(|n| *n > 0);
    r.rating = dist
        .and_then(|d| d.get("average_rating")?.as_f64())
        .zip(count)
        .and_then(|(a, c)| rating(a, Some(c)));
    r.format = Some(Format::Audio);
    Some(r)
}

fn check_error(v: &Value) -> Result<(), ParseError> {
    match v.get("error") {
        None => Ok(()),
        Some(e) => Err(ParseError::Api(e.to_string())),
    }
}

pub fn parse_search(body: &str) -> Result<SearchPage, ParseError> {
    let v = json(body)?;
    check_error(&v)?;
    let products = v
        .get("products")
        .and_then(Value::as_array)
        .ok_or_else(|| ParseError::Malformed("no products".into()))?;
    Ok(SearchPage {
        total: v.get("total_results").and_then(Value::as_u64),
        records: products.iter().filter_map(product).collect(),
    })
}

/// `products/{asin}`: `{product: {...}}`.
pub fn parse_product(body: &str) -> Result<BookRecord, ParseError> {
    let v = json(body)?;
    check_error(&v)?;
    v.get("product")
        .and_then(product)
        .ok_or(ParseError::NotFound)
}

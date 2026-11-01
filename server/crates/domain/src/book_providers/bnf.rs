//! BnF catalogue SRU, `unimarcxchange` records: URL builders and parser.
use super::util::*;
use super::{BookRecord, Format, Level, ParseError, Person, Provider, SearchPage, Series};
use quick_xml::{
    Reader,
    escape::resolve_predefined_entity,
    events::{BytesStart, Event},
};
use regex::Regex;
use std::sync::LazyLock;

const BASE: &str = "https://catalogue.bnf.fr/api/SRU";

fn url(query: &str, start: u32, max: u32) -> String {
    let (s, m) = (start.to_string(), max.to_string());
    let p = [
        ("version", "1.2"),
        ("operation", "searchRetrieve"),
        ("query", query),
        ("recordSchema", "unimarcxchange"),
        ("startRecord", &s),
        ("maximumRecords", &m),
    ];
    url::Url::parse_with_params(BASE, p)
        .expect("constant base")
        .into()
}

/// Backslash-escapes the CQL specials inside a quoted term.
fn term(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        if matches!(c, '\\' | '"' | '*' | '?' | '^') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

pub fn isbn_url(isbn: &str) -> Option<String> {
    Some(url(&format!("bib.isbn adj \"{}\"", isbn13(isbn)?), 1, 5))
}

/// Printed text only (`bib.doctype any "a"`): a bare title query also returns DVDs and scores.
pub fn title_author_url(title: &str, author: Option<&str>, start: u32, max: u32) -> Option<String> {
    let t = term(title);
    if t.is_empty() {
        return None;
    }
    let mut q = format!("bib.title all \"{t}\"");
    if let Some(a) = author.map(term).filter(|a| !a.is_empty()) {
        q.push_str(&format!(" and bib.author all \"{a}\""));
    }
    q.push_str(" and bib.doctype any \"a\"");
    Some(url(&q, start, max))
}

/// `ark` is the notice name, e.g. `cb99900011d`.
pub fn record_url(ark: &str) -> Option<String> {
    let ok = ark.starts_with("cb") && ark.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then(|| url(&format!("bib.persistentid any \"ark:/12148/{ark}\""), 1, 1))
}

#[derive(Default)]
struct Field {
    tag: String,
    ind2: String,
    subs: Vec<(char, String)>,
}

impl Field {
    fn first(&self, code: char) -> Option<String> {
        self.subs
            .iter()
            .find(|(c, _)| *c == code)
            .and_then(|(_, v)| clean(v))
    }
}

#[derive(Default)]
struct Marc {
    ark: Option<String>,
    fields: Vec<Field>,
}

impl Marc {
    fn tag<'a>(&'a self, tags: &'a [&str]) -> impl Iterator<Item = &'a Field> {
        self.fields
            .iter()
            .filter(|f| tags.contains(&f.tag.as_str()))
    }
}

struct Response {
    total: Option<u64>,
    records: Vec<Marc>,
    diagnostic: Option<String>,
}

fn attr(e: &BytesStart, name: &str) -> Option<String> {
    let a = e
        .attributes()
        .flatten()
        .find(|a| a.key.local_name().as_ref() == name)?;
    Some(
        a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .ok()?
            .into_owned(),
    )
}

fn read(body: &str) -> Result<Response, ParseError> {
    let mut xml = Reader::from_str(body);
    let mut resp = Response {
        total: None,
        records: vec![],
        diagnostic: None,
    };
    let (mut cur, mut field, mut sub, mut buf): (
        Option<Marc>,
        Option<Field>,
        Option<char>,
        String,
    ) = (None, None, None, String::new());
    loop {
        let ev = xml
            .read_event()
            .map_err(|e| ParseError::Malformed(e.to_string()))?;
        match ev {
            Event::Start(e) => {
                buf.clear();
                match e.local_name().as_ref() {
                    // Only the MARC record carries `format`; the SRU wrapper `record` does not.
                    "record" if attr(&e, "format").is_some() => {
                        let ark = attr(&e, "id").and_then(|i| i.rsplit('/').next().and_then(clean));
                        cur = Some(Marc {
                            ark,
                            fields: vec![],
                        });
                    }
                    "datafield" if cur.is_some() => {
                        field = Some(Field {
                            tag: attr(&e, "tag").unwrap_or_default(),
                            ind2: attr(&e, "ind2").unwrap_or_default(),
                            subs: vec![],
                        });
                    }
                    "subfield" if field.is_some() => {
                        sub = attr(&e, "code").and_then(|c| c.chars().next())
                    }
                    _ => {}
                }
            }
            Event::Text(t) => buf.push_str(t.as_ref()),
            Event::CData(t) => buf.push_str(t.as_ref()),
            Event::GeneralRef(r) => {
                let name = r.as_ref().to_string();
                match r.resolve_char_ref() {
                    Ok(Some(c)) => buf.push(c),
                    _ => buf.push_str(resolve_predefined_entity(&name).unwrap_or_default()),
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                "numberOfRecords" => resp.total = buf.trim().parse().ok(),
                "message" => resp.diagnostic = clean(&buf),
                "subfield" => {
                    if let (Some(f), Some(c)) = (field.as_mut(), sub.take()) {
                        f.subs.push((c, std::mem::take(&mut buf)));
                    }
                }
                "datafield" => {
                    if let (Some(m), Some(f)) = (cur.as_mut(), field.take()) {
                        m.fields.push(f);
                    }
                }
                "record" => resp.records.extend(cur.take()),
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(resp)
}

/// 700-702 `$4` relator codes: `070` author (also absent on 700 and 701), `730` translator; the rest is skipped.
fn contributors(m: &Marc, r: &mut BookRecord) {
    for f in m.tag(&["700", "701", "702"]) {
        let Some(family) = f.first('a') else { continue };
        let name = match f.first('b') {
            Some(given) => format!("{given} {family}"),
            None => family,
        };
        let p = Person {
            name: Some(name),
            id: f.first('3'),
        };
        // Without `$4` only the principal responsibility (700, 701) is an author.
        match f.first('4').as_deref() {
            None if f.tag != "702" => r.authors.push(p),
            Some("070") => r.authors.push(p),
            Some("730") => r.translators.push(p),
            _ => {}
        }
    }
}

static PAGES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{1,5})\s*p\b").unwrap());

fn record(m: &Marc) -> Option<BookRecord> {
    let t = m.tag(&["200"]).next()?;
    let title_a = t.first('a')?;
    let title = match t.first('i') {
        Some(part) => format!("{title_a}. {part}"),
        None => title_a.clone(),
    };
    let mut r = BookRecord::new(Provider::Bnf, Level::Edition, title);
    r.ids.edition = m.ark.clone();
    for f in m.tag(&["010", "073"]) {
        f.first('a')
            .iter()
            .for_each(|i| add_isbn(&mut r.ids.isbn13, i));
    }
    r.subtitle = t.first('e');
    // 461 is the linked series entry; 225 is the series statement as printed.
    let series = m
        .tag(&["461"])
        .next()
        .and_then(|f| Some((f.first('t')?, f.first('v'), f.first('0'))));
    let series = series.or_else(|| {
        m.tag(&["225"])
            .next()
            .and_then(|f| Some((f.first('a')?, f.first('v'), None)))
    });
    match series {
        Some((name, position, id)) => r.series.push(Series { name, position, id }),
        // A volume number with no series entry: the title is the multi-volume work.
        None => {
            if let Some(n) = t.first('h') {
                r.series.push(Series {
                    name: title_a,
                    position: Some(n),
                    id: None,
                });
            }
        }
    }
    contributors(m, &mut r);
    r.language = m
        .tag(&["101"])
        .next()
        .and_then(|f| f.first('a'))
        .and_then(|l| language(&l));
    let imprint = m.tag(&["214", "210"]).find(|f| f.ind2 != "3");
    r.publisher = imprint.and_then(|f| f.first('c'));
    r.published = imprint
        .and_then(|f| f.first('d'))
        .and_then(|d| partial_date(&d));
    r.description = m.tag(&["330"]).next().and_then(|f| f.first('a'));
    for f in m.tag(&["606", "608"]) {
        f.first('a')
            .into_iter()
            .for_each(|s| push_unique(&mut r.subjects, s));
    }
    let extent = m.tag(&["215"]).next().and_then(|f| f.first('a'));
    r.page_count = extent.and_then(|e| PAGES.captures_iter(&e).last()?[1].parse().ok());
    // RDA media type: n unmediated, c computer, s audio.
    let media = m.tag(&["182"]).find_map(|f| f.first('c'));
    r.format = match media.as_deref() {
        Some("n") => Some(Format::Print),
        Some("c") => Some(Format::Ebook),
        Some("s") => Some(Format::Audio),
        _ => None,
    };
    Some(r)
}

/// A search or record response; a `<diagnostics>` message is an error, zero records is an empty page.
pub fn parse_search(body: &str) -> Result<SearchPage, ParseError> {
    let resp = read(body)?;
    if let Some(d) = resp.diagnostic {
        return Err(ParseError::Api(d));
    }
    Ok(SearchPage {
        total: resp.total,
        records: resp.records.iter().filter_map(record).collect(),
    })
}

/// The first record of a `record_url` / `isbn_url` response.
pub fn parse_record(body: &str) -> Result<BookRecord, ParseError> {
    parse_search(body)?
        .records
        .into_iter()
        .next()
        .ok_or(ParseError::NotFound)
}

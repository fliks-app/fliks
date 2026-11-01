//! EPUB 2 and 3 package metadata (`books-files.md` rules 4-28): a tolerant reader over the OPF and
//! `META-INF/container.xml` bytes. Nothing is rejected: what cannot be read is absent.
use super::isbn::{self, Isbn};
use crate::js::rx;
use crate::language::normalize_language_code;
use quick_xml::{
    Reader,
    events::{BytesStart, Event},
};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Aut,
    Nrt,
    Trl,
    Edt,
    Ill,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Creator {
    pub name: String,
    pub role: Role,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_as: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Series {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
}

/// Absent values are omitted, never `null`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpfMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub creators: Vec<Creator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub isbns: Vec<Isbn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub google_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goodreads_id: Option<String>,
    pub subjects: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series: Option<Series>,
    /// A manifest `href` as written, relative to the OPF; see [`resolve_href`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_href: Option<String>,
}

/// XML bytes as text: a BOM or the declared encoding decides; undeclared bytes that are not UTF-8 are windows-1252.
fn decode_xml(bytes: &[u8]) -> String {
    if let Some((enc, _)) = encoding_rs::Encoding::for_bom(bytes) {
        return enc.decode_with_bom_removal(bytes).0.into_owned();
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(200)]);
    let declared = rx!(i r#"^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']"#)
        .captures(&head)
        .and_then(|c| encoding_rs::Encoding::for_label(c[1].as_bytes()));
    match declared {
        Some(enc) if enc != encoding_rs::UTF_8 => {
            enc.decode_without_bom_handling(bytes).0.into_owned()
        }
        _ => match std::str::from_utf8(bytes) {
            Ok(s) => s.to_owned(),
            Err(_) => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
        },
    }
}

/// Numeric and the few named references XML knows (plus `nbsp`); any other name stays as written.
fn decode_entities(raw: &str) -> String {
    rx!(r"&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);")
        .replace_all(raw, |c: &regex::Captures| {
            let name = &c[1];
            let ch = if let Some(h) = name.strip_prefix("#x") {
                u32::from_str_radix(h, 16).ok().and_then(char::from_u32)
            } else if let Some(d) = name.strip_prefix('#') {
                d.parse().ok().and_then(char::from_u32)
            } else {
                match name {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some('\u{a0}'),
                    _ => None,
                }
            };
            ch.map_or_else(|| c[0].to_owned(), String::from)
        })
        .into_owned()
}

/// A parsed element: lowercase local name, attributes by local name, and all the text beneath it.
#[derive(Default)]
struct El {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    kids: Vec<El>,
}

impl El {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    fn find(&self, name: &str) -> Option<&El> {
        if self.name == name {
            return Some(self);
        }
        self.kids.iter().find_map(|k| k.find(name))
    }

    fn text(&self) -> String {
        collapse(&self.text)
    }
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or("").to_lowercase()
}

fn open(e: &BytesStart) -> El {
    let attrs = e
        .attributes()
        .with_checks(false)
        .flatten()
        .map(|a| (local(a.key.as_ref()), decode_entities(&a.value)))
        .collect();
    El {
        name: local(e.name().as_ref()),
        attrs,
        ..El::default()
    }
}

/// The document as a tree. A malformed tail ends the read and keeps what was read.
fn parse_tree(xml: &str) -> El {
    let mut reader = Reader::from_str(xml);
    let cfg = reader.config_mut();
    cfg.check_end_names = false;
    cfg.allow_unmatched_ends = true;
    let mut stack = vec![El::default()];
    let close = |stack: &mut Vec<El>| {
        if stack.len() > 1 {
            let el = stack.pop().unwrap();
            let parent = stack.last_mut().unwrap();
            parent.text.push_str(&el.text);
            parent.kids.push(el);
        }
    };
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => stack.push(open(&e)),
            Ok(Event::Empty(e)) => {
                stack.push(open(&e));
                close(&mut stack);
            }
            // An end tag closes the nearest open element of that name, and nothing when none is open.
            Ok(Event::End(e)) => {
                let name = local(e.name().as_ref());
                if let Some(depth) = stack
                    .iter()
                    .rposition(|el| el.name == name)
                    .filter(|d| *d > 0)
                {
                    while stack.len() > depth {
                        close(&mut stack);
                    }
                }
            }
            Ok(Event::Text(t)) => {
                stack
                    .last_mut()
                    .unwrap()
                    .text
                    .push_str(&decode_entities(&t));
            }
            Ok(Event::CData(c)) => stack.last_mut().unwrap().text.push_str(&c),
            Ok(Event::GeneralRef(r)) => {
                let whole = format!("&{};", &*r);
                stack
                    .last_mut()
                    .unwrap()
                    .text
                    .push_str(&decode_entities(&whole));
            }
            Ok(Event::Eof) | Err(_) => break,
            Ok(_) => {}
        }
    }
    while stack.len() > 1 {
        close(&mut stack);
    }
    stack.pop().unwrap()
}

/// The package path of `META-INF/container.xml`: the OPF rootfile, else the first rootfile.
pub fn container_rootfile(bytes: &[u8]) -> Option<String> {
    let root = parse_tree(&decode_xml(bytes));
    let mut files = vec![];
    collect(&root, "rootfile", &mut files);
    let path = |e: &&El| {
        e.attr("full-path")
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(String::from)
    };
    files
        .iter()
        .find(|e| {
            e.attr("media-type")
                .is_some_and(|m| m.contains("oebps-package"))
        })
        .and_then(path)
        .or_else(|| files.iter().find_map(path))
}

fn collect<'a>(el: &'a El, name: &str, out: &mut Vec<&'a El>) {
    if el.name == name {
        out.push(el);
    }
    for k in &el.kids {
        collect(k, name, out);
    }
}

/// Where a manifest `href` lives in the archive: joined to the OPF's folder, percent-decoded, without
/// fragment, query or `.`/`..` segments.
pub fn resolve_href(opf_path: &str, href: &str) -> String {
    let href = href.split(['#', '?']).next().unwrap_or("");
    let decoded = percent_encoding::percent_decode_str(href).decode_utf8_lossy();
    let mut parts: Vec<&str> = if decoded.starts_with('/') {
        vec![]
    } else {
        let dir = opf_path.rsplit_once('/').map_or("", |(d, _)| d);
        dir.split('/').filter(|s| !s.is_empty()).collect()
    };
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

/// `refines` metas by (target id, property), in document order.
struct Refines(HashMap<(String, String), Vec<String>>);

impl Refines {
    fn new(metas: &[&El]) -> Self {
        let mut map: HashMap<(String, String), Vec<String>> = HashMap::new();
        for m in metas {
            let (Some(target), Some(prop)) = (m.attr("refines"), m.attr("property")) else {
                continue;
            };
            let value = m.text();
            if !value.is_empty() {
                map.entry((
                    target.trim_start_matches('#').to_owned(),
                    prop.to_lowercase(),
                ))
                .or_default()
                .push(value);
            }
        }
        Self(map)
    }

    fn get(&self, el: &El, prop: &str) -> Option<&str> {
        let id = el.attr("id")?;
        self.0
            .get(&(id.to_owned(), prop.to_owned()))
            .and_then(|v| v.first())
            .map(String::as_str)
    }
}

fn role_of(code: &str) -> Option<Role> {
    Some(match code.trim().to_lowercase().as_str() {
        "aut" => Role::Aut,
        "nrt" => Role::Nrt,
        "trl" => Role::Trl,
        "edt" => Role::Edt,
        "ill" => Role::Ill,
        _ => return None,
    })
}

fn first_text(metadata: &El, name: &str) -> Option<String> {
    metadata
        .kids
        .iter()
        .filter(|k| k.name == name)
        .map(El::text)
        .find(|t| !t.is_empty())
}

fn year_of(date: &str) -> Option<i32> {
    let y: i32 = rx!(r"^\s*(\d{4})")
        .captures(date)
        .or_else(|| rx!(r"\b(\d{4})\b").captures(date))?[1]
        .parse()
        .ok()?;
    (1000..=2100).contains(&y).then_some(y)
}

fn push_identifier(out: &mut OpfMetadata, scheme: &str, value: &str) {
    let (mut scheme, mut value) = (scheme.trim().to_lowercase(), value.trim().to_owned());
    if let Some(c) =
        rx!(i r"^(?:urn:)?([A-Za-z][A-Za-z0-9-]*)[:=]\s*(.+)$").captures(&value.clone())
    {
        let prefix = c[1].to_lowercase();
        let known = [
            "isbn",
            "uuid",
            "asin",
            "mobi-asin",
            "amazon",
            "google",
            "goodreads",
        ];
        if known.contains(&prefix.as_str()) || value.to_lowercase().starts_with("urn:") {
            if scheme.is_empty() || known.contains(&prefix.as_str()) {
                scheme = prefix;
            }
            value = c[2].trim().to_owned();
        }
    }
    let slot = match scheme.as_str() {
        "asin" | "mobi-asin" | "amazon" => &mut out.asin,
        "google" => &mut out.google_id,
        "goodreads" => &mut out.goodreads_id,
        "uuid" => &mut out.uuid,
        _ => {
            if let Some(i) = isbn::parse(&value) {
                if !out.isbns.iter().any(|x| x.isbn13 == i.isbn13) {
                    out.isbns.push(i);
                }
            } else if scheme.is_empty()
                && rx!(
                    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
                )
                .is_match(&value)
            {
                out.uuid.get_or_insert(value.to_lowercase());
            }
            return;
        }
    };
    if !value.is_empty() {
        let v = if scheme == "uuid" {
            value.to_lowercase()
        } else {
            value
        };
        slot.get_or_insert(v);
    }
}

/// The package metadata of an OPF document, whatever its EPUB version, prefixes or encoding.
pub fn parse(bytes: &[u8]) -> OpfMetadata {
    let root = parse_tree(&decode_xml(bytes));
    let mut out = OpfMetadata::default();
    let Some(metadata) = root.find("metadata") else {
        return out;
    };
    let mut metas = vec![];
    collect(metadata, "meta", &mut metas);
    let refines = Refines::new(&metas);
    let calibre = |key: &str| {
        metas
            .iter()
            .find(|m| m.attr("name").is_some_and(|n| n.eq_ignore_ascii_case(key)))
            .and_then(|m| m.attr("content"))
            .map(collapse)
            .filter(|v| !v.is_empty())
    };

    let titles: Vec<&El> = metadata
        .kids
        .iter()
        .filter(|k| k.name == "title" && !k.text().is_empty())
        .collect();
    let kind = |t: &El| refines.get(t, "title-type").map(str::to_lowercase);
    let main = titles
        .iter()
        .find(|t| kind(t).as_deref() == Some("main"))
        .or_else(|| titles.iter().find(|t| kind(t).is_none()))
        .or(titles.first());
    out.title = main.map(|t| t.text());
    out.sort_title = main
        .and_then(|t| {
            t.attr("file-as")
                .map(collapse)
                .or_else(|| refines.get(t, "file-as").map(String::from))
        })
        .filter(|s| !s.is_empty())
        .or_else(|| calibre("calibre:title_sort"));
    out.subtitle = titles
        .iter()
        .find(|t| kind(t).as_deref() == Some("subtitle"))
        .map(|t| t.text());

    for k in metadata
        .kids
        .iter()
        .filter(|k| k.name == "creator" || k.name == "contributor")
    {
        let name = k.text();
        let code = k.attr("role").or_else(|| refines.get(k, "role"));
        let role = match (code, k.name.as_str()) {
            (Some(c), _) => role_of(c),
            (None, "creator") => Some(Role::Aut),
            _ => None,
        };
        let Some(role) = role.filter(|_| !name.is_empty()) else {
            continue;
        };
        if out
            .creators
            .iter()
            .any(|c| c.name == name && c.role == role)
        {
            continue;
        }
        let file_as = k
            .attr("file-as")
            .map(collapse)
            .or_else(|| refines.get(k, "file-as").map(String::from))
            .filter(|s| !s.is_empty());
        out.creators.push(Creator {
            name,
            role,
            file_as,
        });
    }

    out.language = first_text(metadata, "language")
        .map(|l| normalize_language_code(Some(&l)))
        .filter(|l| l != "und");
    out.publisher = first_text(metadata, "publisher");
    let dates: Vec<&El> = metadata.kids.iter().filter(|k| k.name == "date").collect();
    let event = |d: &El| d.attr("event").unwrap_or("").to_lowercase();
    let date = dates
        .iter()
        .find(|d| event(d) == "publication")
        .or_else(|| {
            dates
                .iter()
                .find(|d| !matches!(event(d).as_str(), "creation" | "modification"))
        })
        .or(dates.first())
        .map(|d| d.text());
    if let Some((d, y)) = date.and_then(|d| year_of(&d).map(|y| (d, y))) {
        out.date = Some(d);
        out.year = Some(y);
    }
    out.description = metadata
        .kids
        .iter()
        .filter(|k| k.name == "description")
        .map(|k| k.text.trim().to_owned())
        .find(|t| !t.is_empty());
    for k in metadata.kids.iter().filter(|k| k.name == "subject") {
        let s = k.text();
        if !s.is_empty() && !out.subjects.contains(&s) {
            out.subjects.push(s);
        }
    }

    for k in metadata.kids.iter().filter(|k| k.name == "identifier") {
        let scheme = k
            .attr("scheme")
            .or_else(|| refines.get(k, "identifier-type"))
            .unwrap_or("");
        push_identifier(&mut out, scheme, &k.text());
    }
    // EPUB 3 keeps the print edition's ISBN in dc:source.
    for k in metadata.kids.iter().filter(|k| k.name == "source") {
        if let Some(i) =
            isbn::parse(&k.text()).filter(|i| !out.isbns.iter().any(|x| x.isbn13 == i.isbn13))
        {
            out.isbns.push(i);
        }
    }

    out.series = series(&metas, &refines, &calibre);

    let mut items = vec![];
    collect(&root, "item", &mut items);
    let is_image = |i: &El| {
        i.attr("media-type")
            .is_none_or(|m| m.to_lowercase().starts_with("image/"))
    };
    let href = |i: &&El| {
        i.attr("href")
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .map(String::from)
    };
    out.cover_href = items
        .iter()
        .find(|i| {
            i.attr("properties")
                .is_some_and(|p| p.split_whitespace().any(|t| t == "cover-image"))
        })
        .and_then(href)
        .or_else(|| {
            let id = calibre("cover")?;
            items
                .iter()
                .find(|i| i.attr("id") == Some(id.as_str()) && is_image(i))
                .and_then(href)
        })
        .or_else(|| {
            items
                .iter()
                .find(|i| {
                    i.attr("id")
                        .is_some_and(|id| id.to_lowercase().contains("cover"))
                        && i.attr("media-type")
                            .is_some_and(|m| m.to_lowercase().starts_with("image/"))
                })
                .and_then(href)
        });
    out
}

fn series(
    metas: &[&El],
    refines: &Refines,
    calibre: &impl Fn(&str) -> Option<String>,
) -> Option<Series> {
    let position = |s: &str| {
        s.trim()
            .replace(',', ".")
            .parse::<f64>()
            .ok()
            .filter(|p| p.is_finite())
    };
    let collections: Vec<&&El> = metas
        .iter()
        .filter(|m| {
            m.attr("property")
                .is_some_and(|p| p.eq_ignore_ascii_case("belongs-to-collection"))
                && m.attr("refines").is_none()
        })
        .collect();
    let kind = |m: &El| refines.get(m, "collection-type").map(str::to_lowercase);
    let epub3 = collections
        .iter()
        .find(|m| kind(m).as_deref() == Some("series"))
        .or_else(|| collections.iter().find(|m| kind(m).is_none()));
    if let Some(m) = epub3.filter(|m| !m.text().is_empty()) {
        return Some(Series {
            name: m.text(),
            position: refines.get(m, "group-position").and_then(position),
        });
    }
    let name = calibre("calibre:series")?;
    Some(Series {
        name,
        position: calibre("calibre:series_index").and_then(|p| position(&p)),
    })
}

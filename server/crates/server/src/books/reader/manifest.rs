//! The Readium manifest and positions of an EPUB (`docs/spec/books-reader.md` rules 5-10), pure over
//! the parsed package.
use super::sanitize::Kind;
use fliks_domain::books::{
    opf::{self, OpfMetadata, Role},
    package::{Package, TocEntry},
};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');
const POSITION_BYTES: u64 = 1024;
pub const MAX_POSITIONS: usize = 100_000;

#[derive(Clone, Copy, PartialEq)]
pub enum Class {
    Markup(Kind),
    Plain,
}

/// A manifest item the reader may fetch: its archive entry and its canonical media type.
pub struct Resource {
    pub path: String,
    pub media_type: &'static str,
    pub class: Class,
}

impl Resource {
    pub fn content_type(&self) -> String {
        match self.class {
            Class::Plain => self.media_type.into(),
            Class::Markup(_) => format!("{}; charset=utf-8", self.media_type),
        }
    }
}

const PLAIN: &[&str] = &[
    "text/css",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/avif",
    "font/otf",
    "font/ttf",
    "font/sfnt",
    "font/woff",
    "font/woff2",
    "application/font-woff",
    "application/font-woff2",
    "application/vnd.ms-opentype",
    "application/x-font-ttf",
    "application/x-font-opentype",
    "application/font-sfnt",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/opus",
    "audio/webm",
    "audio/wav",
    "video/mp4",
    "video/webm",
    "video/ogg",
];

/// `None` for a type off the exact allowlist (rule 12), JavaScript and `a/b,c/d` tricks included; the
/// answer is the allowlisted string itself, never the manifest's.
fn classify(media_type: &str) -> Option<(Class, &'static str)> {
    let t = media_type.split(';').next()?.trim().to_lowercase();
    let markup = |k, c| Some((Class::Markup(k), c));
    match t.as_str() {
        "application/xhtml+xml" | "text/html" => markup(Kind::Xhtml, "application/xhtml+xml"),
        "image/svg+xml" => markup(Kind::Svg, "image/svg+xml"),
        "application/x-dtbncx+xml" => markup(Kind::Xml, "application/x-dtbncx+xml"),
        "application/xml" => markup(Kind::Xml, "application/xml"),
        "text/xml" => markup(Kind::Xml, "text/xml"),
        "application/smil+xml" => markup(Kind::Xml, "application/smil+xml"),
        _ => PLAIN.iter().find(|p| **p == t).map(|p| (Class::Plain, *p)),
    }
}

fn has_scheme(href: &str) -> bool {
    href.starts_with("//")
        || href
            .split(['/', '?', '#'])
            .next()
            .is_some_and(|s| s.contains(':'))
}

/// The servable items of a package, indexed by id and by archive path (the first of a duplicate wins).
pub struct Resources {
    list: Vec<Resource>,
    by_id: HashMap<String, usize>,
    by_path: HashMap<String, usize>,
}

impl Resources {
    pub fn by_path(&self, path: &str) -> Option<&Resource> {
        self.by_path.get(path).map(|i| &self.list[*i])
    }

    fn by_id(&self, id: &str) -> Option<&Resource> {
        self.by_id.get(id).map(|i| &self.list[*i])
    }

    fn iter(&self) -> impl Iterator<Item = &Resource> {
        self.list.iter()
    }
}

pub fn resources(opf_path: &str, pkg: &Package, exists: impl Fn(&str) -> bool) -> Resources {
    let mut out = Resources {
        list: vec![],
        by_id: HashMap::new(),
        by_path: HashMap::new(),
    };
    for i in pkg.items.iter().filter(|i| !has_scheme(&i.href)) {
        let Some((class, media_type)) = classify(&i.media_type) else {
            continue;
        };
        let path = opf::resolve_href(opf_path, &i.href);
        if !exists(&path) || out.by_path.contains_key(&path) {
            continue;
        }
        let n = out.list.len();
        out.by_path.insert(path.clone(), n);
        out.by_id.entry(i.id.clone()).or_insert(n);
        out.list.push(Resource {
            path,
            media_type,
            class,
        });
    }
    out
}

pub fn href(path: &str) -> String {
    path.split('/')
        .map(|s| utf8_percent_encode(s, SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

/// The linear spine items that are XHTML: the reader cannot be given a CSP meta for any other markup.
fn reading_order<'a>(pkg: &Package, res: &'a Resources) -> Vec<&'a Resource> {
    pkg.spine
        .iter()
        .filter(|s| s.linear)
        .filter_map(|s| res.by_id(&s.idref))
        .filter(|r| r.class == Class::Markup(Kind::Xhtml))
        .collect()
}

/// A toc entry whose target is a listed resource; `href` is the encoded path with its fragment.
pub struct TocNode {
    path: String,
    title: String,
    href: String,
    children: Vec<TocNode>,
}

pub fn resolve_toc(entries: &[TocEntry], doc: &str, res: &Resources) -> Vec<TocNode> {
    entries
        .iter()
        .flat_map(|e| {
            let (target, frag) = e.href.split_once('#').unwrap_or((&e.href, ""));
            let path = if target.is_empty() {
                doc.to_owned()
            } else {
                opf::resolve_href(doc, target)
            };
            let children = resolve_toc(&e.children, doc, res);
            if has_scheme(target) || res.by_path(&path).is_none() {
                return children;
            }
            let href = if frag.is_empty() {
                href(&path)
            } else {
                format!("{}#{frag}", href(&path))
            };
            vec![TocNode {
                path,
                title: e.title.clone(),
                href,
                children,
            }]
        })
        .collect()
}

fn toc_json(nodes: &[TocNode]) -> Vec<Value> {
    nodes
        .iter()
        .map(|n| {
            let mut v = json!({ "title": n.title, "href": n.href });
            if !n.children.is_empty() {
                v["children"] = toc_json(&n.children).into();
            }
            v
        })
        .collect()
}

/// The title of each target path, the first in document order winning.
fn titles<'a>(nodes: &'a [TocNode], out: &mut HashMap<&'a str, &'a str>) {
    for n in nodes {
        out.entry(n.path.as_str()).or_insert(n.title.as_str());
        titles(&n.children, out);
    }
}

pub fn base(item: i32) -> String {
    format!("/api/books/{item}/pub/")
}

pub fn manifest(
    item: i32,
    meta: &OpfMetadata,
    pkg: &Package,
    res: &Resources,
    toc: &[TocNode],
) -> Value {
    let order = reading_order(pkg, res);
    let mut titled = HashMap::new();
    titles(toc, &mut titled);
    let link = |r: &Resource| json!({ "href": href(&r.path), "type": r.media_type });
    let reading: Vec<Value> = order
        .iter()
        .map(|r| {
            let mut l = link(r);
            if let Some(t) = titled.get(r.path.as_str()) {
                l["title"] = (*t).into();
            }
            l
        })
        .collect();
    let ordered: HashSet<&str> = order.iter().map(|r| r.path.as_str()).collect();
    let resources: Vec<Value> = res
        .iter()
        .filter(|r| !ordered.contains(r.path.as_str()))
        .map(link)
        .collect();
    let identifier = meta
        .uuid
        .as_ref()
        .map(|u| format!("urn:uuid:{u}"))
        .or_else(|| meta.isbns.first().map(|i| format!("urn:isbn:{}", i.isbn13)))
        .unwrap_or_else(|| format!("urn:fliks:item:{item}"));
    let authors: Vec<&str> = meta
        .creators
        .iter()
        .filter(|c| c.role == Role::Aut)
        .map(|c| c.name.as_str())
        .collect();
    let mut m = json!({
        "@type": "http://schema.org/Book",
        "conformsTo": "https://readium.org/webpub-manifest/profiles/epub",
        "identifier": identifier,
        "title": meta.title.as_deref().unwrap_or(""),
        "language": meta.language.iter().collect::<Vec<_>>(),
        "author": authors,
        "subject": meta.subjects,
    });
    for (key, v) in [
        ("publisher", &meta.publisher),
        ("published", &meta.date),
        ("description", &meta.description),
        ("readingProgression", &pkg.direction),
    ] {
        if let Some(v) = v {
            m[key] = v.as_str().into();
        }
    }
    if pkg.fixed_layout {
        m["layout"] = "fixed".into();
    }
    json!({
        "@context": "https://readium.org/webpub-manifest/context.jsonld",
        "metadata": m,
        "links": [
            { "rel": "self", "href": format!("{}manifest.json", base(item)), "type": "application/webpub+json" },
            { "rel": "http://readium.org/restricted/positions", "href": "positions.json",
              "type": "application/vnd.readium.position-list+json" },
        ],
        "readingOrder": reading,
        "resources": resources,
        "toc": toc_json(toc),
    })
}

/// `size` is the declared size of an archive entry, already capped by the caller.
pub fn positions(pkg: &Package, res: &Resources, mut size: impl FnMut(&str) -> u64) -> Value {
    let order = reading_order(pkg, res);
    let counts: Vec<u64> = order
        .iter()
        .map(|r| {
            if pkg.fixed_layout {
                1
            } else {
                size(&r.path).div_ceil(POSITION_BYTES).max(1)
            }
        })
        .collect();
    let total = counts.iter().sum::<u64>().min(MAX_POSITIONS as u64);
    let mut out = Vec::new();
    let mut n = 0u64;
    'all: for (r, count) in order.iter().zip(&counts) {
        for k in 0..*count {
            if n == total {
                break 'all;
            }
            n += 1;
            out.push(json!({
                "href": href(&r.path), "type": r.media_type,
                "locations": {
                    "position": n,
                    "progression": k as f64 / *count as f64,
                    "totalProgression": (n - 1) as f64 / total as f64,
                },
            }));
        }
    }
    json!({ "total": total, "positions": out })
}

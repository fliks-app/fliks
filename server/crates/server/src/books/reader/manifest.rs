//! The Readium manifest and positions of an EPUB (`docs/spec/books-reader.md` rules 5-10), pure over
//! the parsed package.
use fliks_domain::books::{
    opf::{self, OpfMetadata, Role},
    package::{Package, TocEntry},
};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};

const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');
const POSITION_BYTES: u64 = 1024;
pub const MAX_POSITIONS: usize = 100_000;

#[derive(Clone, Copy, PartialEq)]
pub enum Class {
    Xhtml,
    Svg,
    Xml,
    Plain,
}

/// A manifest item the reader may fetch: its archive entry and its normalised media type.
pub struct Resource {
    pub id: String,
    pub path: String,
    pub media_type: String,
    pub class: Class,
}

impl Resource {
    pub fn content_type(&self) -> String {
        match self.class {
            Class::Xhtml => "application/xhtml+xml; charset=utf-8".into(),
            Class::Plain => self.media_type.clone(),
            _ => format!("{}; charset=utf-8", self.media_type),
        }
    }
}

/// `None` for a type the reader never serves (rule 12), JavaScript included.
fn classify(media_type: &str) -> Option<(Class, String)> {
    let t = media_type.split(';').next()?.trim().to_lowercase();
    let class = match t.as_str() {
        "application/xhtml+xml" | "text/html" => Class::Xhtml,
        "image/svg+xml" => Class::Svg,
        "application/x-dtbncx+xml" | "application/xml" | "text/xml" | "application/smil+xml" => {
            Class::Xml
        }
        "text/css"
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp"
        | "image/avif"
        | "application/font-woff"
        | "application/vnd.ms-opentype"
        | "application/x-font-ttf"
        | "application/x-font-opentype"
        | "application/font-sfnt" => Class::Plain,
        _ if ["font/", "audio/", "video/"]
            .iter()
            .any(|p| t.starts_with(p)) =>
        {
            Class::Plain
        }
        _ => return None,
    };
    Some((
        class,
        if class == Class::Xhtml {
            "application/xhtml+xml".into()
        } else {
            t
        },
    ))
}

fn has_scheme(href: &str) -> bool {
    href.starts_with("//")
        || href
            .split(['/', '?', '#'])
            .next()
            .is_some_and(|s| s.contains(':'))
}

pub fn resources(opf_path: &str, pkg: &Package, exists: impl Fn(&str) -> bool) -> Vec<Resource> {
    let mut seen = std::collections::HashSet::new();
    pkg.items
        .iter()
        .filter(|i| !has_scheme(&i.href))
        .filter_map(|i| {
            let (class, media_type) = classify(&i.media_type)?;
            let path = opf::resolve_href(opf_path, &i.href);
            (exists(&path) && seen.insert(path.clone())).then(|| Resource {
                id: i.id.clone(),
                path,
                media_type,
                class,
            })
        })
        .collect()
}

pub fn href(path: &str) -> String {
    path.split('/')
        .map(|s| utf8_percent_encode(s, SEGMENT).to_string())
        .collect::<Vec<_>>()
        .join("/")
}

fn reading_order<'a>(pkg: &Package, res: &'a [Resource]) -> Vec<&'a Resource> {
    pkg.spine
        .iter()
        .filter(|s| s.linear)
        .filter_map(|s| res.iter().find(|r| r.id == s.idref))
        .collect()
}

/// A toc entry whose target is a listed resource; `href` is the encoded path with its fragment.
pub struct TocNode {
    path: String,
    title: String,
    href: String,
    children: Vec<TocNode>,
}

pub fn resolve_toc(entries: &[TocEntry], doc: &str, res: &[Resource]) -> Vec<TocNode> {
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
            if has_scheme(target) || !res.iter().any(|r| r.path == path) {
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

fn title_of<'a>(nodes: &'a [TocNode], path: &str) -> Option<&'a str> {
    nodes.iter().find_map(|n| {
        (n.path == path)
            .then_some(n.title.as_str())
            .or_else(|| title_of(&n.children, path))
    })
}

pub fn base(item: i32) -> String {
    format!("/api/books/{item}/pub/")
}

pub fn manifest(
    item: i32,
    meta: &OpfMetadata,
    pkg: &Package,
    res: &[Resource],
    toc: &[TocNode],
) -> Value {
    let order = reading_order(pkg, res);
    let link = |r: &Resource| json!({ "href": href(&r.path), "type": r.media_type });
    let reading: Vec<Value> = order
        .iter()
        .map(|r| {
            let mut l = link(r);
            if let Some(t) = title_of(toc, &r.path) {
                l["title"] = t.into();
            }
            l
        })
        .collect();
    let resources: Vec<Value> = res
        .iter()
        .filter(|r| !order.iter().any(|o| o.path == r.path))
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
pub fn positions(pkg: &Package, res: &[Resource], mut size: impl FnMut(&str) -> u64) -> Value {
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

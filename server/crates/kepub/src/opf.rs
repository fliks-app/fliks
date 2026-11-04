//! Package-document transforms of kepubify's `TransformOPF` and dummy title page.
use crate::dom::{Element, Node, local};
use percent_encoding::percent_decode_str;

pub const DUMMY_HREF: &str = "kepubify-titlepage-dummy.xhtml";
pub const DUMMY_ID: &str = "kepubify-titlepage-dummy";
pub const DUMMY_BODY: &str = r#"<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title></title></head><body><p style="text-align: center; margin: 4em 0; font-size: .7em; font-style: italic;">Page intentionally left blank by kepubify.</p></body></html>"#;

pub fn root(nodes: &mut [Node]) -> Option<&mut Element> {
    nodes.iter_mut().find_map(|n| match n {
        Node::Element(e) if e.local() == "package" => Some(e),
        _ => None,
    })
}

fn items(pkg: &Element) -> impl Iterator<Item = &Element> {
    pkg.child("manifest").into_iter().flat_map(|m| {
        m.children.iter().filter_map(|n| match n {
            Node::Element(e) if e.local() == "item" => Some(e),
            _ => None,
        })
    })
}

/// `href` relative to the directory of `base`, percent-decoded, `..` folded; `None` if it leaves the archive.
pub fn resolve(base: &str, href: &str) -> Option<String> {
    let href = href.split(['#', '?']).next().unwrap_or("");
    let href = percent_decode_str(href).decode_utf8().ok()?;
    let dir = base.rsplit_once('/').map_or("", |(d, _)| d);
    let mut parts: Vec<&str> = if href.starts_with('/') {
        vec![]
    } else {
        dir.split('/').filter(|p| !p.is_empty()).collect()
    };
    for p in href.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            p => parts.push(p),
        }
    }
    Some(parts.join("/"))
}

fn ext(href: &str) -> String {
    href.rsplit_once('.')
        .map_or(String::new(), |(_, e)| e.to_ascii_lowercase())
}

fn is_content_ext(href: &str) -> bool {
    matches!(ext(href).as_str(), "htm" | "html" | "xhtml")
}

pub fn content_docs(pkg: &Element, opf_path: &str) -> Vec<String> {
    items(pkg)
        .filter(|i| {
            matches!(
                i.attr("media-type"),
                Some("application/xhtml+xml" | "text/html")
            ) || i.attr("href").is_some_and(is_content_ext)
        })
        .filter_map(|i| resolve(opf_path, i.attr("href")?))
        .collect()
}

/// Kobo reads only the EPUB3 `cover-image` property, not the EPUB2 `meta name="cover"` form.
pub(crate) fn cover_image(pkg: &mut Element) {
    fn find_meta(e: &Element) -> Option<String> {
        e.children.iter().find_map(|n| match n {
            Node::Element(c) if c.local() == "meta" && c.attr("name") == Some("cover") => {
                Some(c.attr("content").unwrap_or("cover").to_string())
            }
            Node::Element(c) => find_meta(c),
            _ => None,
        })
    }
    let id = find_meta(pkg).unwrap_or_else(|| "cover".into());
    let Some(Node::Element(manifest)) = pkg
        .children
        .iter_mut()
        .find(|n| matches!(n, Node::Element(e) if e.local() == "manifest"))
    else {
        return;
    };
    let has_cover = |e: &Element| {
        e.attr("properties")
            .is_some_and(|v| v.split_ascii_whitespace().any(|t| t == "cover-image"))
    };
    let flagged = manifest
        .children
        .iter()
        .any(|n| matches!(n, Node::Element(e) if e.local() == "item" && has_cover(e)));
    if flagged {
        return;
    }
    let item = manifest.children.iter_mut().find_map(|n| match n {
        Node::Element(e)
            if e.local() == "item"
                && e.attr("id") == Some(&id)
                && e.attr("media-type")
                    .is_some_and(|t| t.starts_with("image/")) =>
        {
            Some(e)
        }
        _ => None,
    });
    if let Some(item) = item {
        match item.attrs.iter_mut().find(|(k, _)| k == "properties") {
            Some((_, v)) if v.split_ascii_whitespace().any(|t| t == "cover-image") => {}
            Some((_, v)) => *v = format!("{v} cover-image").trim().to_string(),
            None => item.attrs.push(("properties".into(), "cover-image".into())),
        }
    }
}

fn calibre_meta(nodes: &mut Vec<Node>) {
    nodes.retain_mut(|n| match n {
        Node::Element(e) => {
            let attr = |k: &str| {
                e.attrs
                    .iter()
                    .find(|(a, _)| local(a) == k)
                    .map(|(_, v)| v.as_str())
            };
            let drop = (e.local() == "meta" && attr("name") == Some("calibre:timestamp"))
                || (e.local() == "contributor" && attr("role") == Some("bkp"));
            if !drop {
                calibre_meta(&mut e.children);
            }
            !drop
        }
        _ => true,
    });
}

pub fn transform(pkg: &mut Element) {
    cover_image(pkg);
    let mut kids = std::mem::take(&mut pkg.children);
    calibre_meta(&mut kids);
    pkg.children = kids;
}

/// The first linear spine document, when it is a content document by extension.
pub fn first_spine_doc(pkg: &Element, opf_path: &str) -> Option<String> {
    let spine = pkg.child("spine")?;
    let idref = spine.children.iter().find_map(|n| match n {
        Node::Element(e) if e.local() == "itemref" && e.attr("linear") != Some("no") => {
            e.attr("idref")
        }
        _ => None,
    })?;
    let href = items(pkg)
        .find(|i| i.attr("id") == Some(idref))?
        .attr("href")?;
    if !is_content_ext(href) {
        return None;
    }
    let base = href.rsplit('/').next().unwrap_or(href).to_lowercase();
    if base.contains("cover") || base.contains("title") {
        return None;
    }
    resolve(opf_path, href)
}

/// Kobo treats the first spine entry as a full-screen cover; adds a blank page unless the id is taken.
pub fn add_titlepage(pkg: &mut Element) -> bool {
    if items(pkg).any(|i| i.attr("id") == Some(DUMMY_ID)) {
        return false;
    }
    let prefix = |e: &Element| {
        e.name
            .rsplit_once(':')
            .map_or(String::new(), |(p, _)| format!("{p}:"))
    };
    let mut added = false;
    for n in &mut pkg.children {
        let Node::Element(e) = n else { continue };
        let p = prefix(e);
        match e.local() {
            "manifest" => {
                let attrs = [
                    ("id", DUMMY_ID),
                    ("href", DUMMY_HREF),
                    ("media-type", "application/xhtml+xml"),
                ];
                e.children.push(Node::Element(Element::new(
                    &format!("{p}item"),
                    &attrs,
                    vec![],
                )));
                added = true;
            }
            "spine" => {
                let at = e
                    .children
                    .iter()
                    .position(|c| matches!(c, Node::Element(_)))
                    .unwrap_or(0);
                let it = Element::new(&format!("{p}itemref"), &[("idref", DUMMY_ID)], vec![]);
                e.children.insert(at, Node::Element(it));
            }
            _ => {}
        }
    }
    added
}

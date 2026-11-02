//! The reading structure of an EPUB package (`docs/spec/books-reader.md` rules 3-4): manifest, spine and
//! table of contents, over the same tolerant tree as `opf::parse`. Nothing is rejected.
use super::opf::{El, collect, decode_xml, parse_tree};
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Item {
    pub id: String,
    /// As written, relative to the OPF; see `opf::resolve_href`.
    pub href: String,
    pub media_type: String,
    pub properties: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpineRef {
    pub idref: String,
    pub linear: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Package {
    pub items: Vec<Item>,
    pub spine: Vec<SpineRef>,
    /// The `toc` attribute of the spine: the manifest id of the NCX.
    pub toc_id: Option<String>,
    pub direction: Option<String>,
    pub fixed_layout: bool,
}

impl Package {
    pub fn item(&self, id: &str) -> Option<&Item> {
        self.items.iter().find(|i| i.id == id)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TocEntry {
    pub title: String,
    pub href: String,
    pub children: Vec<TocEntry>,
}

pub fn parse(bytes: &[u8]) -> Package {
    let root = parse_tree(&decode_xml(bytes));
    let attr = |e: &El, k: &str| e.attr(k).map(|v| v.trim().to_owned());
    let mut out = Package::default();
    let mut found = vec![];
    collect(&root, "item", &mut found);
    for e in found {
        let (Some(id), Some(href)) = (attr(e, "id"), attr(e, "href")) else {
            continue;
        };
        out.items.push(Item {
            id,
            href,
            media_type: attr(e, "media-type").unwrap_or_default(),
            properties: e
                .attr("properties")
                .unwrap_or("")
                .split_whitespace()
                .map(str::to_owned)
                .collect(),
        });
    }
    if let Some(spine) = root.find("spine") {
        out.toc_id = attr(spine, "toc").filter(|s| !s.is_empty());
        out.direction = attr(spine, "page-progression-direction")
            .map(|d| d.to_lowercase())
            .filter(|d| d == "ltr" || d == "rtl");
        for r in spine.elems().filter(|r| r.name == "itemref") {
            if let Some(idref) = attr(r, "idref") {
                let linear = !attr(r, "linear").is_some_and(|l| l.eq_ignore_ascii_case("no"));
                out.spine.push(SpineRef { idref, linear });
            }
        }
    }
    let mut metas = vec![];
    collect(&root, "meta", &mut metas);
    out.fixed_layout = metas.iter().any(|m| {
        m.attr("property") == Some("rendition:layout")
            && m.text().eq_ignore_ascii_case("pre-paginated")
    });
    out
}

fn entry(children: Vec<TocEntry>, title: String, href: Option<&str>) -> Vec<TocEntry> {
    match (
        title.is_empty(),
        href.map(str::trim).filter(|h| !h.is_empty()),
    ) {
        (false, Some(h)) => vec![TocEntry {
            title,
            href: h.to_owned(),
            children,
        }],
        _ => children,
    }
}

fn nav_list(ol: &El) -> Vec<TocEntry> {
    ol.elems()
        .filter(|li| li.name == "li")
        .flat_map(|li| {
            let a = li.elems().find(|k| k.name == "a" || k.name == "span");
            let children = li
                .elems()
                .filter(|k| k.name == "ol")
                .flat_map(nav_list)
                .collect();
            match a {
                Some(a) => entry(children, a.text(), a.attr("href")),
                None => children,
            }
        })
        .collect()
}

pub fn nav_toc(bytes: &[u8]) -> Vec<TocEntry> {
    let root = parse_tree(&decode_xml(bytes));
    let mut navs = vec![];
    collect(&root, "nav", &mut navs);
    let toc = navs.into_iter().find(|n| {
        n.attr("type")
            .is_some_and(|t| t.split_whitespace().any(|w| w == "toc"))
    });
    toc.and_then(|n| n.elems().find(|k| k.name == "ol"))
        .map(nav_list)
        .unwrap_or_default()
}

fn ncx_points(parent: &El) -> Vec<TocEntry> {
    parent
        .elems()
        .filter(|p| p.name == "navpoint")
        .flat_map(|p| {
            let title = p
                .elems()
                .find(|k| k.name == "navlabel")
                .map(|l| l.text())
                .unwrap_or_default();
            let content = p.elems().find(|k| k.name == "content");
            entry(ncx_points(p), title, content.and_then(|c| c.attr("src")))
        })
        .collect()
}

pub fn ncx_toc(bytes: &[u8]) -> Vec<TocEntry> {
    let root = parse_tree(&decode_xml(bytes));
    root.find("navmap").map(ncx_points).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_reads_manifest_spine_and_layout() {
        let p = parse(
            br#"<package><metadata><meta property="rendition:layout">pre-paginated</meta></metadata>
            <manifest><item id="a" href="a%20b.xhtml" media-type="application/xhtml+xml" properties="nav scripted"/>
            <item id="n" href="t.ncx" media-type="application/x-dtbncx+xml"/><item href="x"/></manifest>
            <spine toc="n" page-progression-direction="RTL"><itemref idref="a"/><itemref idref="b" linear="no"/></spine></package>"#,
        );
        assert_eq!(p.items.len(), 2);
        assert_eq!(p.items[0].properties, ["nav", "scripted"]);
        assert_eq!(p.toc_id.as_deref(), Some("n"));
        assert_eq!(p.direction.as_deref(), Some("rtl"));
        assert!(p.fixed_layout);
        assert_eq!(
            p.spine.iter().map(|s| s.linear).collect::<Vec<_>>(),
            [true, false]
        );
    }

    #[test]
    fn nav_and_ncx_toc_nest_and_drop_untitled() {
        let nav = nav_toc(
            br#"<html><body><nav epub:type="landmarks"><ol><li><a href="x">L</a></li></ol></nav>
            <nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a><ol><li><a href="c1.xhtml#s">Sub</a></li></ol></li>
            <li><span>No link</span><ol><li><a href="c2.xhtml"> Two </a></li></ol></li><li><a href="">Empty</a></li></ol></nav></body></html>"#,
        );
        assert_eq!(nav.len(), 2);
        assert_eq!(nav[0].children[0].href, "c1.xhtml#s");
        assert_eq!(nav[1].title, "Two");
        let ncx = ncx_toc(
            br#"<ncx><navMap><navPoint><navLabel><text>One</text></navLabel><content src="c1.xhtml"/>
            <navPoint><navLabel><text>Sub</text></navLabel><content src="c1.xhtml#s"/></navPoint></navPoint></navMap></ncx>"#,
        );
        assert_eq!(ncx[0].title, "One");
        assert_eq!(ncx[0].children[0].title, "Sub");
    }
}

//! OPDS 1.2 Atom rendering (`docs/spec/opds.md`): plain structs in, one XML string out.
use std::fmt::Write;

pub const ACQUISITION: &str = "http://opds-spec.org/acquisition";
pub const NAV_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=navigation";
pub const ACQ_TYPE: &str = "application/atom+xml;profile=opds-catalog;kind=acquisition";

pub const PSE_STREAM: &str = "http://vaemendis.net/opds-pse/stream";

/// The OPDS-PSE attributes of a stream link; `last_read` is 1-based.
#[derive(Debug, Clone, Default)]
pub struct Pse {
    pub count: i64,
    pub last_read: Option<i64>,
    pub last_read_date: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Link {
    pub rel: Option<String>,
    pub href: String,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub length: Option<i64>,
    pub pse: Option<Pse>,
}

impl Link {
    pub fn new(rel: &str, href: impl Into<String>, kind: &str) -> Self {
        Self {
            rel: Some(rel.to_owned()),
            href: href.into(),
            kind: Some(kind.to_owned()),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub updated: String,
    pub authors: Vec<String>,
    pub content: Option<String>,
    pub summary: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub issued: Option<String>,
    pub links: Vec<Link>,
}

#[derive(Debug, Clone, Default)]
pub struct Feed {
    pub id: String,
    pub title: String,
    pub updated: String,
    pub links: Vec<Link>,
    pub entries: Vec<Entry>,
}

/// XML-escapes `s` and drops the characters XML 1.0 forbids.
pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&apos;"),
            '\t' | '\n' | '\r' => o.push(c),
            c if (c as u32) < 0x20 || matches!(c, '\u{FFFE}' | '\u{FFFF}') => {}
            c => o.push(c),
        }
    }
    o
}

fn link(o: &mut String, l: &Link) {
    o.push_str("<link");
    if let Some(r) = &l.rel {
        let _ = write!(o, " rel=\"{}\"", esc(r));
    }
    let _ = write!(o, " href=\"{}\"", esc(&l.href));
    if let Some(t) = &l.kind {
        let _ = write!(o, " type=\"{}\"", esc(t));
    }
    if let Some(t) = &l.title {
        let _ = write!(o, " title=\"{}\"", esc(t));
    }
    if let Some(n) = l.length {
        let _ = write!(o, " length=\"{n}\"");
    }
    if let Some(p) = &l.pse {
        let _ = write!(o, " pse:count=\"{}\"", p.count);
        if let Some(n) = p.last_read {
            let _ = write!(o, " pse:lastRead=\"{n}\"");
        }
        if let Some(d) = &p.last_read_date {
            let _ = write!(o, " pse:lastReadDate=\"{}\"", esc(d));
        }
    }
    o.push_str("/>");
}

fn text(o: &mut String, tag: &str, v: &str) {
    let _ = write!(o, "<{tag}>{}</{tag}>", esc(v));
}

pub fn render(f: &Feed) -> String {
    let mut o = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<feed xmlns=\"http://www.w3.org/2005/Atom\" \
         xmlns:dc=\"http://purl.org/dc/terms/\" xmlns:opds=\"http://opds-spec.org/2010/catalog\" \
         xmlns:pse=\"http://vaemendis.net/opds-pse/ns\">",
    );
    text(&mut o, "id", &f.id);
    text(&mut o, "title", &f.title);
    text(&mut o, "updated", &f.updated);
    o.push_str("<author><name>Fliks</name></author>");
    f.links.iter().for_each(|l| link(&mut o, l));
    for e in &f.entries {
        o.push_str("<entry>");
        text(&mut o, "title", &e.title);
        text(&mut o, "id", &e.id);
        text(&mut o, "updated", &e.updated);
        for a in &e.authors {
            o.push_str("<author>");
            text(&mut o, "name", a);
            o.push_str("</author>");
        }
        if let Some(v) = &e.language {
            text(&mut o, "dc:language", v);
        }
        if let Some(v) = &e.publisher {
            text(&mut o, "dc:publisher", v);
        }
        if let Some(v) = &e.issued {
            text(&mut o, "dc:issued", v);
        }
        if let Some(v) = &e.summary {
            let _ = write!(o, "<summary type=\"text\">{}</summary>", esc(v));
        }
        if let Some(v) = &e.content {
            let _ = write!(o, "<content type=\"text\">{}</content>", esc(v));
        }
        e.links.iter().for_each(|l| link(&mut o, l));
        o.push_str("</entry>");
    }
    o.push_str("</feed>");
    o
}

/// The OpenSearch description pointing at the Atom search route.
pub fn opensearch(template: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<OpenSearchDescription \
         xmlns=\"http://a9.com/-/spec/opensearch/1.1/\"><ShortName>Fliks</ShortName>\
         <Description>Search the Fliks books</Description><InputEncoding>UTF-8</InputEncoding>\
         <Url type=\"{ACQ_TYPE}\" template=\"{}\"/></OpenSearchDescription>",
        esc(template)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_is_escaped_and_forbidden_characters_dropped() {
        assert_eq!(
            esc("a&b<c>\"'\u{0}\u{b}\tz"),
            "a&amp;b&lt;c&gt;&quot;&apos;\tz"
        );
    }

    #[test]
    fn a_stream_link_carries_the_pse_attributes() {
        let mut o = String::new();
        link(
            &mut o,
            &Link {
                pse: Some(Pse {
                    count: 35,
                    last_read: Some(10),
                    last_read_date: Some("2010-01-10T10:01:11Z".into()),
                }),
                ..Link::new(PSE_STREAM, "/p/{pageNumber}?width={maxWidth}", "image/jpeg")
            },
        );
        assert!(o.contains(
            "pse:count=\"35\" pse:lastRead=\"10\" pse:lastReadDate=\"2010-01-10T10:01:11Z\"/>"
        ));
    }

    #[test]
    fn a_feed_renders_well_formed_xml_with_its_entries() {
        let f = Feed {
            id: "urn:x".into(),
            title: "T & co".into(),
            updated: "2026-01-01T00:00:00Z".into(),
            links: vec![Link::new("self", "/api/opds?a=1&b=2", NAV_TYPE)],
            entries: vec![Entry {
                id: "urn:b".into(),
                title: "Book".into(),
                authors: vec!["A <B>".into()],
                links: vec![Link {
                    length: Some(5),
                    ..Link::new(
                        ACQUISITION,
                        "/api/stream/1?download=1",
                        "application/epub+zip",
                    )
                }],
                ..Entry::default()
            }],
        };
        let x = render(&f);
        assert!(x.contains("<title>T &amp; co</title>"));
        assert!(x.contains("href=\"/api/opds?a=1&amp;b=2\""));
        assert!(x.contains("<name>A &lt;B&gt;</name>"));
        assert!(x.contains("length=\"5\""));
        assert!(x.contains("xmlns:pse=\"http://vaemendis.net/opds-pse/ns\""));
        let mut r = quick_xml::Reader::from_str(&x);
        while r.read_event().unwrap() != quick_xml::events::Event::Eof {}
    }
}

//! The markup rewriter of the reader routes (`docs/spec/books-reader.md` rules 14-16): a strict XML pass
//! that drops active content and prepends a CSP meta, so a hostile EPUB cannot act with the app's cookie.
use quick_xml::{
    Reader,
    escape::{escape, unescape},
    events::{BytesStart, Event},
};

pub const META_CSP: &str =
    "script-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const MAX_DEPTH: usize = 512;
const DROPPED: &[&str] = &[
    "script", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "base", "set",
    "animate",
];
const URL_ATTRS: &[&str] = &[
    "href",
    "src",
    "action",
    "formaction",
    "data",
    "poster",
    "background",
];

#[derive(Debug, PartialEq)]
pub enum Error {
    /// Not UTF-8 or not well-formed XML.
    Malformed,
    TooLarge,
}

fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or("").to_lowercase()
}

fn valid_name(n: &str) -> bool {
    !n.is_empty()
        && n.chars()
            .all(|c| c.is_alphanumeric() || "-_.:".contains(c) || !c.is_ascii())
}

fn scripted(value: &str) -> bool {
    let v: String = value
        .chars()
        .filter(|c| *c > ' ')
        .collect::<String>()
        .to_lowercase();
    v.starts_with("javascript:") || v.starts_with("vbscript:")
}

/// The attributes worth keeping, as ` name="value"` text; `Err` for a name or a duplicate that is not XML.
fn attributes(e: &BytesStart) -> Result<(String, bool), Error> {
    let mut out = String::new();
    let mut http_equiv = false;
    for a in e.attributes() {
        let a = a.map_err(|_| Error::Malformed)?;
        let key = a.key.as_ref();
        if !valid_name(key) {
            return Err(Error::Malformed);
        }
        let name = local(key);
        http_equiv |= name == "http-equiv";
        let ns = key == "xmlns" || key.starts_with("xmlns:");
        if !ns && (name.starts_with("on") || name == "srcdoc") {
            continue;
        }
        let Ok(value) = unescape(&a.value) else {
            continue;
        };
        if URL_ATTRS.contains(&name.as_str()) && scripted(&value) {
            continue;
        }
        out.push_str(&format!(" {key}=\"{}\"", escape(&*value)));
    }
    Ok((out, http_equiv))
}

#[derive(PartialEq)]
enum Head {
    Before,
    AfterHtml,
    Done,
}

/// `meta_csp`: XHTML, which gets the CSP meta in its `head`; SVG and other XML only get the rewrite.
pub fn sanitize(input: &[u8], meta_csp: bool, cap: usize) -> Result<Vec<u8>, Error> {
    if input.len() > cap {
        return Err(Error::TooLarge);
    }
    let input = input.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(input);
    let text = std::str::from_utf8(input).map_err(|_| Error::Malformed)?;
    let mut reader = Reader::from_str(text);
    let mut out = br#"<?xml version="1.0" encoding="UTF-8"?>"#.to_vec();
    let (mut skip, mut depth) = (0usize, 0usize);
    let mut head = if meta_csp { Head::Before } else { Head::Done };
    let mut prefix = String::new();
    let meta = |p: &str| {
        format!("<{p}meta http-equiv=\"Content-Security-Policy\" content=\"{META_CSP}\"/>")
    };
    loop {
        if out.len() > cap {
            return Err(Error::TooLarge);
        }
        let ev = reader.read_event().map_err(|_| Error::Malformed)?;
        if skip > 0 {
            match ev {
                Event::Start(_) => skip += 1,
                Event::End(_) => skip -= 1,
                Event::Eof => return Err(Error::Malformed),
                _ => {}
            }
            continue;
        }
        match ev {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(ev, Event::Empty(_));
                let qname = e.name().as_ref().to_owned();
                if !valid_name(&qname) {
                    return Err(Error::Malformed);
                }
                let name = local(&qname);
                let (attrs, http_equiv) = attributes(e)?;
                if DROPPED.contains(&name.as_str()) || (name == "meta" && http_equiv) {
                    if !empty {
                        skip = 1;
                    }
                    continue;
                }
                let p = qname.rfind(':').map_or("", |i| &qname[..=i]);
                if head == Head::AfterHtml && name != "head" {
                    out.extend(format!("<{p}head>{}</{p}head>", meta(p)).bytes());
                    head = Head::Done;
                }
                let at_root = depth == 0;
                out.extend(format!("<{qname}{attrs}").bytes());
                if head == Head::AfterHtml {
                    out.push(b'>');
                    out.extend(meta(p).bytes());
                    if empty {
                        out.extend(format!("</{qname}>").bytes());
                    } else {
                        depth += 1;
                    }
                    head = Head::Done;
                    continue;
                }
                if empty {
                    out.extend(b"/>");
                } else {
                    out.push(b'>');
                    depth += 1;
                    if depth > MAX_DEPTH {
                        return Err(Error::Malformed);
                    }
                    if head == Head::Before && at_root && name == "html" {
                        head = Head::AfterHtml;
                        prefix = p.to_owned();
                    }
                }
            }
            Event::End(e) => {
                if head == Head::AfterHtml {
                    out.extend(format!("<{prefix}head>{}</{prefix}head>", meta(&prefix)).bytes());
                    head = Head::Done;
                }
                out.extend(b"</");
                out.extend(e.name().as_ref().as_bytes());
                out.push(b'>');
                depth = depth.saturating_sub(1);
            }
            Event::Text(t) => out.extend(t.as_bytes()),
            Event::CData(c) => {
                out.extend(b"<![CDATA[");
                out.extend(c.as_bytes());
                out.extend(b"]]>");
            }
            Event::GeneralRef(r) => {
                out.push(b'&');
                out.extend(r.as_bytes());
                out.push(b';');
            }
            Event::DocType(d) if !d.contains(['[', '<', '>']) => {
                out.extend(b"<!DOCTYPE ");
                out.extend(d.as_bytes());
                out.push(b'>');
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if depth != 0 {
        return Err(Error::Malformed);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: usize = 1 << 20;
    const XHTML: &str = r#"<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:svg="http://www.w3.org/2000/svg">
<head><title>T</title><script>alert(1)</script><meta http-equiv="refresh" content="0;url=http://x"/><meta charset="utf-8"/>
<script src="evil.js"/><base href="http://x/"/></head>
<body onload="x()"><p id="a" ONCLICK="x()" class='k"q'>Hello &amp; &nbsp; <b>bold</b></p>
<img src="a.png" onerror="x()" alt="ok"/><svg:svg onload="x()"><svg:script>x()</svg:script><svg:set attributeName="href" to="javascript:x()"/></svg:svg>
<iframe src="javascript:x()">fallback</iframe><iframe srcdoc="&lt;script&gt;"/><object data="x.svg"><p>in</p></object><embed src="x"/>
<a href="javascript:x()">1</a><a href=" Java&#09;Script:x()">2</a><a href="&#106;avascript:x()">3</a><a href="vbscript:x">4</a>
<a href="ch2.xhtml#s">ok</a><form action="/x"><input/></form><a xlink:href="javascript:x()">5</a></body></html>"#;

    fn out(src: &str) -> String {
        String::from_utf8(sanitize(src.as_bytes(), true, CAP).unwrap()).unwrap()
    }

    #[test]
    fn active_content_is_removed() {
        let o = out(XHTML);
        for bad in [
            "script",
            "alert",
            "iframe",
            "srcdoc",
            "object",
            "embed",
            "<form",
            "<base",
            "refresh",
            "onload",
            "onerror",
            "ONCLICK",
            "<svg:set",
            "javascript",
            "vbscript",
            "evil.js",
            "fallback",
        ] {
            let body = o.replace(META_CSP, "");
            assert!(!body.to_lowercase().contains(bad), "{bad} survived: {o}");
        }
        for good in [
            "Hello &amp; &nbsp;",
            "<b>bold</b>",
            r#"src="a.png""#,
            r#"href="ch2.xhtml#s""#,
            "<title>T</title>",
            r#"<meta charset="utf-8"/>"#,
        ] {
            assert!(o.contains(good), "{good} lost: {o}");
        }
        assert!(o.contains(r#"class="k&quot;q""#), "{o}");
    }

    #[test]
    fn the_csp_meta_is_the_first_child_of_head() {
        let o = out(XHTML);
        let head = o.split("<head>").nth(1).unwrap();
        assert!(
            head.starts_with("<meta http-equiv=\"Content-Security-Policy\""),
            "{o}"
        );
        assert_eq!(o.matches("Content-Security-Policy").count(), 1);
        assert!(o.starts_with(r#"<?xml version="1.0" encoding="UTF-8"?><html"#));
    }

    #[test]
    fn a_missing_or_empty_head_is_created_and_a_prefix_kept() {
        for src in [
            "<html><body><p>x</p></body></html>",
            "<html><head/><body/></html>",
            "<html></html>",
        ] {
            let o = out(src);
            assert_eq!(o.matches("<head><meta http-equiv").count(), 1, "{o}");
            assert_eq!(o.matches("Content-Security-Policy").count(), 1, "{o}");
        }
        let o =
            out(r#"<h:html xmlns:h="http://www.w3.org/1999/xhtml"><h:head/><h:body/></h:html>"#);
        assert!(o.contains("<h:head><h:meta http-equiv"), "{o}");
        assert!(o.contains("</h:head>"), "{o}");
    }

    #[test]
    fn prefixed_dangerous_elements_are_dropped() {
        let o = out(
            r#"<html xmlns:x="http://www.w3.org/1999/xhtml"><head/><body><x:script>a()</x:script><x:iframe/><p>k</p></body></html>"#,
        );
        let body = o.replace(META_CSP, "");
        assert!(
            !body.contains("script") && !body.contains("iframe") && o.contains("<p>k</p>"),
            "{o}"
        );
    }

    #[test]
    fn svg_and_xml_are_cleaned_without_a_meta() {
        let o = String::from_utf8(
            sanitize(br#"<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script><a href="javascript:x()"><rect/></a></svg>"#, false, CAP).unwrap(),
        )
        .unwrap();
        assert!(
            !o.contains("script") && !o.contains("onload") && !o.contains("Content-Security"),
            "{o}"
        );
        assert!(o.contains("<rect/>"));
    }

    #[test]
    fn doctype_with_an_internal_subset_is_dropped() {
        let o = out(r#"<!DOCTYPE html [<!ENTITY a "b">]><html><head/><body/></html>"#);
        assert!(!o.contains("DOCTYPE") && !o.contains("ENTITY"), "{o}");
        let o = out(r#"<!DOCTYPE html><html><head/><body/></html>"#);
        assert!(o.contains("<!DOCTYPE html>"));
    }

    #[test]
    fn malformed_and_non_utf8_input_is_refused() {
        for bad in [
            &b"<html><body></html>"[..],
            b"<a><b></a></b>",
            b"<a x='1' x='2'/>",
            b"<a>",
            b"\xFF\xFE<\0a\0/\0>\0",
            b"<a>\xE9</a>",
            b"<a\"b/>",
            b"<a on\"x=''/>",
        ] {
            assert_eq!(sanitize(bad, true, CAP), Err(Error::Malformed), "{bad:?}");
        }
        assert_eq!(sanitize(b"<a><script>", true, CAP), Err(Error::Malformed));
    }

    #[test]
    fn output_and_input_are_capped() {
        assert_eq!(sanitize(&[b' '; 11], true, 10), Err(Error::TooLarge));
        let doc = format!("<html><head/><body>{}</body></html>", "x".repeat(100));
        assert_eq!(
            sanitize(doc.as_bytes(), true, doc.len() + 5),
            Err(Error::TooLarge)
        );
    }

    #[test]
    fn nesting_is_capped() {
        let deep = format!("{}{}", "<a>".repeat(600), "</a>".repeat(600));
        assert_eq!(sanitize(deep.as_bytes(), false, CAP), Err(Error::Malformed));
    }

    #[test]
    fn a_utf8_bom_is_dropped() {
        let o = String::from_utf8(sanitize(b"\xEF\xBB\xBF<p>\xC3\xA9</p>", false, CAP).unwrap())
            .unwrap();
        assert!(o.ends_with("<p>\u{e9}</p>") && !o.contains('\u{feff}'));
    }
}

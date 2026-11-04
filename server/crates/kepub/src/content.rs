//! Content-document transforms of kepubify's `TransformContent`.
use crate::dom::{self, DomError, Element, Node};

const STYLE_CLASS: &str = "kobostylehacks";
const STYLE_CSS: &str = "div#book-inner { margin-top: 0; margin-bottom: 0;}";

/// Bytes to text: BOM first, then valid UTF-8, else the declared charset (windows-1252 when
/// undeclared, unknown or claiming UTF-8 over bytes that are not).
pub fn decode(b: &[u8]) -> String {
    if let Some(r) = b.strip_prefix(&[0xFF, 0xFE]) {
        return encoding_rs::UTF_16LE
            .decode_without_bom_handling(r)
            .0
            .into_owned();
    }
    if let Some(r) = b.strip_prefix(&[0xFE, 0xFF]) {
        return encoding_rs::UTF_16BE
            .decode_without_bom_handling(r)
            .0
            .into_owned();
    }
    let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(b);
    if let Ok(s) = std::str::from_utf8(b) {
        return s.to_string();
    }
    let enc = declared_charset(b)
        .filter(|e| *e != encoding_rs::UTF_8)
        .unwrap_or(encoding_rs::WINDOWS_1252);
    enc.decode_without_bom_handling(b).0.into_owned()
}

/// The `encoding="..."` of the XML declaration or the `charset=...` of a meta, in the first KiB.
fn declared_charset(b: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let head = String::from_utf8_lossy(&b[..b.len().min(1024)]).to_ascii_lowercase();
    let at = head
        .find("encoding=")
        .map(|i| i + 9)
        .or_else(|| head.find("charset=").map(|i| i + 8))?;
    let label: String = head[at..]
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .collect();
    encoding_rs::Encoding::for_label(label.as_bytes())
}

pub fn parse_doc(b: &[u8]) -> Result<Vec<Node>, DomError> {
    let mut nodes = dom::parse(&decode(b), true)?;
    normalize(&mut nodes);
    Ok(nodes)
}

pub fn transform(b: &[u8]) -> Result<Vec<u8>, DomError> {
    let mut nodes = parse_doc(b)?;
    let html = html_mut(&mut nodes);
    charset(html);
    let body = body_mut(html);
    wrap_divs(body);
    if !has_class(&body.children, "koboSpan") {
        let children = std::mem::take(&mut body.children);
        let left = dom::MAX_NODES.saturating_sub(count(&children));
        let mut st = State {
            left,
            ..State::default()
        };
        body.children = spans(children, false, &mut st)?;
    }
    head_mut(html)
        .children
        .push(style_node(STYLE_CLASS, STYLE_CSS));
    clean(&mut nodes);
    Ok(dom::serialize(&nodes, true).into_bytes())
}

fn style_node(class: &str, css: &str) -> Node {
    let mut e = Element::new("style", &[("type", "text/css"), ("class", class)], vec![]);
    e.children.push(Node::Raw(css.into()));
    Node::Element(e)
}

/// Guarantees one html > head + body; anything outside the first `html` goes into the body.
fn normalize(nodes: &mut Vec<Node>) {
    let (mut raws, mut html, mut before, mut after) = (vec![], None, vec![], vec![]);
    for n in std::mem::take(nodes) {
        match n {
            Node::Raw(_) => raws.push(n),
            Node::Element(e) if html.is_none() && e.name == "html" => html = Some(e),
            other if html.is_none() => before.push(other),
            other => after.push(other),
        }
    }
    let mut html = html.unwrap_or_else(|| Element::new("html", &[], std::mem::take(&mut before)));
    let is = |n: &Node, name: &str| matches!(n, Node::Element(e) if e.name == name);
    if !html.children.iter().any(|n| is(n, "head")) {
        html.children
            .insert(0, Node::Element(Element::new("head", &[], vec![])));
    }
    if !html.children.iter().any(|n| is(n, "body")) {
        let (head, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut html.children)
            .into_iter()
            .partition(|n| is(n, "head"));
        html.children = head;
        html.children
            .push(Node::Element(Element::new("body", &[], rest)));
    }
    if html.attr("xmlns").is_none() {
        html.attrs
            .insert(0, ("xmlns".into(), "http://www.w3.org/1999/xhtml".into()));
    }
    let body = child_mut(&mut html, "body");
    body.children.splice(0..0, before);
    body.children.extend(after);
    *nodes = raws;
    nodes.push(Node::Element(html));
}

fn html_mut(nodes: &mut [Node]) -> &mut Element {
    nodes
        .iter_mut()
        .find_map(|n| match n {
            Node::Element(e) if e.name == "html" => Some(e),
            _ => None,
        })
        .expect("normalized")
}

fn child_mut<'a>(e: &'a mut Element, name: &str) -> &'a mut Element {
    e.children
        .iter_mut()
        .find_map(|n| match n {
            Node::Element(c) if c.name == name => Some(c),
            _ => None,
        })
        .expect("normalized")
}

fn head_mut(html: &mut Element) -> &mut Element {
    child_mut(html, "head")
}

fn body_mut(html: &mut Element) -> &mut Element {
    child_mut(html, "body")
}

fn charset(html: &mut Element) {
    fn walk(e: &mut Element) {
        if e.name == "meta" {
            if let Some(a) = e.attrs.iter_mut().find(|(k, _)| k == "charset") {
                a.1 = "UTF-8".into();
            }
            let ct = e
                .attr("http-equiv")
                .is_some_and(|v| v.eq_ignore_ascii_case("content-type"));
            let content = e.attrs.iter_mut().find(|(k, _)| ct && k == "content");
            let at = content
                .as_ref()
                .and_then(|a| a.1.to_ascii_lowercase().find("charset="));
            if let (Some(a), Some(i)) = (content, at) {
                let tail = a.1[i + 8..]
                    .find(';')
                    .map_or("", |t| &a.1[i + 8 + t..])
                    .to_string();
                a.1 = format!("{}charset=utf-8{tail}", &a.1[..i]);
            }
        }
        for c in &mut e.children {
            if let Node::Element(c) = c {
                walk(c);
            }
        }
    }
    walk(head_mut(html));
}

fn has_class(nodes: &[Node], class: &str) -> bool {
    nodes.iter().any(|n| match n {
        Node::Element(e) => {
            e.attr("class")
                .is_some_and(|c| c.split_ascii_whitespace().any(|t| t == class))
                || has_class(&e.children, class)
        }
        _ => false,
    })
}

fn wrap_divs(body: &mut Element) {
    let id = |n: &Node, v: &str| matches!(n, Node::Element(e) if e.attr("id") == Some(v));
    let done = body.children.iter().any(|c| {
        id(c, "book-columns")
            && matches!(c, Node::Element(e) if e.children.iter().any(|g| id(g, "book-inner")))
    });
    if done {
        return;
    }
    for layer in ["book-inner", "book-columns"] {
        let inner = std::mem::take(&mut body.children);
        body.children
            .push(Node::Element(Element::new("div", &[("id", layer)], inner)));
    }
}

#[derive(Default)]
struct State {
    para: u32,
    seg: u32,
    inc_next: bool,
    /// Nodes the spans may still add, from the same budget as the parser.
    left: usize,
}

impl State {
    fn spend(&mut self, n: usize) -> Result<(), DomError> {
        self.left = self.left.checked_sub(n).ok_or(DomError::TooComplex)?;
        Ok(())
    }
}

fn count(nodes: &[Node]) -> usize {
    nodes
        .iter()
        .map(|n| match n {
            Node::Element(e) => 1 + count(&e.children),
            _ => 1,
        })
        .sum()
}

fn span(para: u32, seg: u32, children: Vec<Node>) -> Node {
    let id = format!("kobo.{para}.{seg}");
    Node::Element(Element::new(
        "span",
        &[("class", "koboSpan"), ("id", &id)],
        children,
    ))
}

fn spans(children: Vec<Node>, parent_is_p: bool, st: &mut State) -> Result<Vec<Node>, DomError> {
    let mut out = Vec::with_capacity(children.len());
    for n in children {
        match n {
            Node::Text(t) => {
                for s in split_sentences(&t) {
                    if is_space(s) && !parent_is_p {
                        st.spend(1)?;
                        out.push(Node::Text(s.into()));
                        continue;
                    }
                    if st.inc_next {
                        st.para += 1;
                        st.seg = 0;
                        st.inc_next = false;
                    }
                    st.seg += 1;
                    st.spend(2)?;
                    out.push(span(st.para, st.seg, vec![Node::Text(s.into())]));
                }
            }
            Node::Element(mut e) => match e.name.as_str() {
                "img" => {
                    st.para += 1;
                    st.seg = 1;
                    st.inc_next = false;
                    st.spend(1)?;
                    out.push(span(st.para, st.seg, vec![Node::Element(e)]));
                }
                "script" | "style" | "pre" | "audio" | "video" => out.push(Node::Element(e)),
                _ if matches!(e.local().to_ascii_lowercase().as_str(), "svg" | "math") => {
                    out.push(Node::Element(e))
                }
                name => {
                    if matches!(
                        name,
                        "p" | "ol" | "ul" | "table" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    ) {
                        st.inc_next = true;
                    }
                    let is_p = name == "p";
                    e.children = spans(std::mem::take(&mut e.children), is_p, st)?;
                    out.push(Node::Element(e));
                }
            },
            raw => out.push(raw),
        }
    }
    Ok(out)
}

fn is_space(s: &str) -> bool {
    s.chars().all(char::is_whitespace)
}

/// A sentence ends at `.`, `!` or `?` (repeated, then one optional quote), followed by ASCII
/// whitespace; the whitespace stays with the sentence it ends.
pub fn split_sentences(s: &str) -> Vec<&str> {
    #[derive(Clone, Copy, PartialEq)]
    enum St {
        Default,
        AfterPunct,
        AfterExtra,
        AfterSpace,
    }
    let mut out = vec![];
    let (mut state, mut start) = (St::Default, 0);
    for (i, c) in s.char_indices() {
        let punct = matches!(c, '.' | '!' | '?');
        let extra = matches!(
            c,
            '\'' | '"' | '\u{201D}' | '\u{2019}' | '\u{201C}' | '\u{2026}'
        );
        let space = matches!(c, '\t' | '\n' | '\x0C' | '\r' | ' ');
        if state == St::AfterSpace && !space {
            out.push(&s[start..i]);
            start = i;
        }
        state = match (state, punct, extra, space) {
            (St::AfterSpace, false, false, true) => St::AfterSpace,
            (St::AfterPunct | St::AfterExtra, _, _, true) => St::AfterSpace,
            (St::AfterPunct, false, true, false) => St::AfterExtra,
            (_, true, _, _) => St::AfterPunct,
            (St::AfterSpace, ..)
            | (St::Default, ..)
            | (St::AfterPunct, ..)
            | (St::AfterExtra, ..) => St::Default,
        };
    }
    if start < s.len() || out.is_empty() {
        out.push(&s[start..]);
    }
    out
}

fn clean(nodes: &mut Vec<Node>) {
    nodes.retain_mut(|n| match n {
        Node::Text(t) => {
            if t.contains('\u{FFFD}') {
                *t = t.replace('\u{FFFD}', "");
            }
            true
        }
        Node::Element(e) => {
            let adept = e.name == "meta"
                && matches!(
                    e.attr("name"),
                    Some("Adept.expected.resource" | "Adept.resource")
                );
            let office = (e.name == "o:p" || e.name.starts_with("st1:"))
                && e.children
                    .iter()
                    .all(|c| matches!(c, Node::Text(t) if is_space(t)));
            if adept || office {
                return false;
            }
            let ty = match e.name.as_str() {
                "script" => "text/javascript",
                "style" => "text/css",
                _ => "",
            };
            if !ty.is_empty() && e.attr("type").is_none() {
                e.attrs.push(("type".into(), ty.into()));
            }
            clean(&mut e.children);
            true
        }
        Node::Raw(_) => true,
    });
}

/// Words and images in the first spine document, deciding if a dummy title page is needed.
pub fn needs_titlepage(nodes: &[Node]) -> bool {
    struct C {
        words: u32,
        paras: u32,
        images: u32,
    }
    fn walk(nodes: &[Node], c: &mut C) -> bool {
        for n in nodes {
            match n {
                Node::Text(t) => {
                    c.words += t.split_whitespace().filter(|w| w.len() > 3).count() as u32;
                    if c.words > 20 {
                        return true;
                    }
                }
                Node::Element(e) => match e.name.as_str() {
                    "p" => {
                        c.paras += 1;
                        if c.paras > 4 {
                            return true;
                        }
                    }
                    "img" | "svg" => c.images += 1,
                    "script" | "style" | "pre" | "audio" | "video" | "math" => {}
                    _ => {
                        if walk(&e.children, c) {
                            return true;
                        }
                    }
                },
                Node::Raw(_) => {}
            }
        }
        false
    }
    let mut c = C {
        words: 0,
        paras: 0,
        images: 0,
    };
    let body = nodes.iter().find_map(|n| match n {
        Node::Element(h) => h.child("body"),
        _ => None,
    });
    let Some(body) = body else { return false };
    walk(&body.children, &mut c) || (c.images == 0 && c.words < 5) || c.images > 4
}

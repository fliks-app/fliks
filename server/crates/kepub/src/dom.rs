//! A lenient markup tree: XHTML, HTML4 and malformed documents parse without error.
use crate::entities::ENTITIES;
use std::borrow::Cow;

pub const MAX_DEPTH: usize = 256;
pub const MAX_NODES: usize = 500_000;

#[derive(Debug)]
pub enum Node {
    Element(Element),
    Text(String),
    /// Written verbatim: script and style bodies, the XML declaration, the doctype.
    Raw(String),
}

#[derive(Debug)]
pub struct Element {
    pub name: String,
    pub attrs: Vec<(String, String)>,
    pub children: Vec<Node>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum DomError {
    TooDeep,
    TooComplex,
}

impl Element {
    pub fn new(name: &str, attrs: &[(&str, &str)], children: Vec<Node>) -> Self {
        Element {
            name: name.into(),
            attrs: attrs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            children,
        }
    }

    pub fn attr(&self, key: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    pub fn local(&self) -> &str {
        local(&self.name)
    }

    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find_map(|n| match n {
            Node::Element(e) if e.local() == name => Some(e),
            _ => None,
        })
    }
}

pub fn local(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];
const BLOCK: &[&str] = &[
    "address",
    "blockquote",
    "div",
    "dl",
    "fieldset",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
    "li",
    "figure",
    "aside",
    "article",
];

pub fn is_void(name: &str) -> bool {
    VOID.contains(&name)
}

fn named_entity(name: &str) -> Option<char> {
    let i = ENTITIES.binary_search_by(|(n, _)| (*n).cmp(name)).ok()?;
    char::from_u32(ENTITIES[i].1)
}

/// Unknown or oversized references stay literal text.
fn decode_into(s: &str, out: &mut String) {
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        let end = rest.bytes().take(33).position(|b| b == b';');
        let decoded = end.and_then(|e| {
            let name = &rest[..e];
            let c = if let Some(num) = name.strip_prefix('#') {
                let n = match num.strip_prefix(['x', 'X']) {
                    Some(h) => u32::from_str_radix(h, 16),
                    None => num.parse(),
                };
                match n {
                    Ok(0) | Err(_) => return None,
                    Ok(n) => char::from_u32(n).unwrap_or('\u{FFFD}'),
                }
            } else {
                named_entity(name)?
            };
            Some((c, e))
        });
        match decoded {
            Some((c, e)) => {
                out.push(c);
                rest = &rest[e + 1..];
            }
            None => out.push('&'),
        }
    }
    out.push_str(rest);
}

fn find_ci(hay: &str, needle: &str) -> Option<usize> {
    let (h, n) = (hay.as_bytes(), needle.as_bytes());
    (0..h.len().checked_sub(n.len())? + 1).find(|&i| h[i..i + n.len()].eq_ignore_ascii_case(n))
}

fn name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-')
}

fn valid_name(n: &str) -> bool {
    n.bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && n.bytes().all(name_char)
        && n.matches(':').count() <= 1
        && !n.ends_with(':')
}

fn tag_name_len(s: &str) -> usize {
    s.bytes().skip(1).take_while(|b| name_char(*b)).count()
}

struct Builder {
    stack: Vec<Element>,
    root: Vec<Node>,
    nodes: usize,
    html: bool,
}

impl Builder {
    fn push_node(&mut self, n: Node) -> Result<(), DomError> {
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(DomError::TooComplex);
        }
        match self.stack.last_mut() {
            Some(e) => e.children.push(n),
            None => self.root.push(n),
        }
        Ok(())
    }

    fn pop(&mut self) -> Result<(), DomError> {
        if let Some(e) = self.stack.pop() {
            self.push_node(Node::Element(e))?;
        }
        Ok(())
    }

    fn flush(&mut self, text: &mut String) -> Result<(), DomError> {
        if text.is_empty() {
            return Ok(());
        }
        // Whitespace between top-level nodes carries nothing.
        if self.stack.is_empty() && text.trim().is_empty() {
            text.clear();
            return Ok(());
        }
        self.push_node(Node::Text(std::mem::take(text)))
    }

    fn implied_end(&mut self, name: &str) -> Result<(), DomError> {
        let Some(top) = self.stack.last().map(|e| e.name.as_str()) else {
            return Ok(());
        };
        let close = match name {
            "p" | "li" | "dt" | "dd" | "tr" | "option" | "thead" | "tbody" => top == name,
            "td" | "th" => top == "td" || top == "th",
            _ => top == "p" && BLOCK.contains(&name),
        };
        if close {
            self.pop()?;
        }
        Ok(())
    }
}

pub fn parse(src: &str, html: bool) -> Result<Vec<Node>, DomError> {
    let mut b = Builder {
        stack: vec![],
        root: vec![],
        nodes: 0,
        html,
    };
    let mut text = String::new();
    let mut i = 0;
    while i < src.len() {
        let rest = &src[i..];
        let Some(lt) = rest.find('<') else {
            decode_into(rest, &mut text);
            break;
        };
        decode_into(&rest[..lt], &mut text);
        i += lt;
        let rest = &src[i..];
        let next = rest.as_bytes().get(1).copied().unwrap_or(0);
        if let Some(r) = rest.strip_prefix("<!--") {
            b.flush(&mut text)?;
            i += r.find("-->").map_or(rest.len(), |e| 4 + e + 3);
        } else if rest.starts_with("<![CDATA[") {
            let end = rest.find("]]>").unwrap_or(rest.len());
            text.push_str(&rest[9..end.max(9)]);
            i += (end + 3).min(rest.len());
        } else if let Some(r) = rest.strip_prefix("<!") {
            b.flush(&mut text)?;
            let (head_end, end) = match rest.find('>') {
                None => (rest.len(), rest.len()),
                Some(g) => match rest[..g].find('[') {
                    Some(l) => {
                        let close = rest[l..]
                            .find(']')
                            .and_then(|r| rest[l + r..].find('>').map(|g| l + r + g + 1));
                        (l, close.unwrap_or(rest.len()))
                    }
                    None => (g, g + 1),
                },
            };
            if b.stack.is_empty()
                && r.get(..7)
                    .is_some_and(|d| d.eq_ignore_ascii_case("doctype"))
            {
                // The internal subset is dropped: it is where entity bombs live.
                b.push_node(Node::Raw(format!(
                    "<!DOCTYPE{}>",
                    rest[9..head_end].trim_end()
                )))?;
            }
            i += end;
        } else if rest.starts_with("<?") {
            b.flush(&mut text)?;
            let end = rest.find("?>").map_or(rest.len(), |e| e + 2);
            if b.stack.is_empty() && rest.starts_with("<?xml") {
                b.push_node(Node::Raw(utf8_decl(&rest[..end])))?;
            }
            i += end;
        } else if next == b'/' && rest.as_bytes().get(2).is_some_and(u8::is_ascii_alphabetic) {
            b.flush(&mut text)?;
            let end = rest.find('>').map_or(rest.len(), |e| e + 1);
            let name = rest[2..end]
                .trim_end_matches('>')
                .split_whitespace()
                .next()
                .unwrap_or("");
            let name = if html {
                Cow::Owned(name.to_ascii_lowercase())
            } else {
                Cow::Borrowed(name)
            };
            let skip = html && matches!(name.as_ref(), "html" | "body");
            let open = b
                .stack
                .iter()
                .rposition(|e| e.name.eq_ignore_ascii_case(&name));
            if let Some(k) = open.filter(|_| !skip) {
                while b.stack.len() > k {
                    b.pop()?;
                }
            }
            i += end;
        } else if next.is_ascii_alphabetic() && valid_name(&rest[1..1 + tag_name_len(rest)]) {
            b.flush(&mut text)?;
            i += start_tag(&mut b, &src[i..])?;
            let raw_el = b
                .stack
                .last()
                .filter(|e| html && matches!(e.name.as_str(), "script" | "style"));
            if let Some(close) = raw_el.map(|e| format!("</{}", e.name)) {
                let rest = &src[i..];
                let end = find_ci(rest, &close).unwrap_or(rest.len());
                if end > 0 {
                    b.push_node(Node::Raw(rest[..end].to_string()))?;
                }
                i += end;
            }
        } else {
            text.push('<');
            i += 1;
        }
    }
    b.flush(&mut text)?;
    while !b.stack.is_empty() {
        b.pop()?;
    }
    Ok(b.root)
}

fn utf8_decl(decl: &str) -> String {
    let Some(k) = decl.find("encoding") else {
        return decl.to_string();
    };
    let after = &decl[k..];
    let Some(q) = after.find(['"', '\'']) else {
        return decl.to_string();
    };
    let quote = after.as_bytes()[q] as char;
    let Some(e) = after[q + 1..].find(quote) else {
        return decl.to_string();
    };
    format!("{}encoding={quote}UTF-8{}", &decl[..k], &after[q + 1 + e..])
}

/// Parses one start tag at the head of `s`, pushes it, returns the bytes consumed.
fn start_tag(b: &mut Builder, s: &str) -> Result<usize, DomError> {
    let bytes = s.as_bytes();
    let mut i = 1;
    while i < bytes.len() && name_char(bytes[i]) {
        i += 1;
    }
    let raw = &s[1..i];
    let foreign =
        |n: &str| local(n).eq_ignore_ascii_case("svg") || local(n).eq_ignore_ascii_case("math");
    let fold = b.html && !b.stack.iter().any(|e| foreign(&e.name)) && !foreign(raw);
    let name = if fold {
        raw.to_ascii_lowercase()
    } else {
        raw.to_string()
    };
    let mut attrs: Vec<(String, String)> = vec![];
    let mut selfclose = false;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        match bytes.get(i) {
            None => return Ok(s.len()),
            Some(b'>') => {
                i += 1;
                break;
            }
            Some(b'/') => {
                if bytes.get(i + 1) == Some(&b'>') {
                    selfclose = true;
                    i += 2;
                    break;
                }
                i += 1;
                continue;
            }
            _ => {}
        }
        let st = i;
        while i < bytes.len()
            && !matches!(bytes[i], b'=' | b'>' | b'/')
            && !bytes[i].is_ascii_whitespace()
        {
            i += 1;
        }
        let key = &s[st..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut val = String::new();
        if bytes.get(i) == Some(&b'=') {
            i += 1;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            match bytes.get(i) {
                Some(&q @ (b'"' | b'\'')) => {
                    let e = s[i + 1..].find(q as char).map_or(s.len(), |e| i + 1 + e);
                    decode_into(&s[i + 1..e], &mut val);
                    i = (e + 1).min(s.len());
                }
                _ => {
                    let st = i;
                    while i < bytes.len() && !bytes[i].is_ascii_whitespace() && bytes[i] != b'>' {
                        i += 1;
                    }
                    decode_into(&s[st..i], &mut val);
                }
            }
        } else if b.html {
            val = key.to_ascii_lowercase();
        }
        let key = if fold {
            key.to_ascii_lowercase()
        } else {
            key.to_string()
        };
        if valid_name(&key) && !attrs.iter().any(|(k, _)| *k == key) {
            attrs.push((key, val));
        }
    }
    if b.html {
        b.implied_end(&name)?;
    }
    let empty = selfclose || (b.html && is_void(&name));
    let el = Element {
        name,
        attrs,
        children: vec![],
    };
    if empty {
        b.push_node(Node::Element(el))?;
    } else {
        if b.stack.len() >= MAX_DEPTH {
            return Err(DomError::TooDeep);
        }
        b.stack.push(el);
    }
    Ok(i)
}

fn xml_char(c: char) -> bool {
    !matches!(c, '\0'..='\u{8}' | '\u{B}' | '\u{C}' | '\u{E}'..='\u{1F}' | '\u{FFFE}' | '\u{FFFF}')
}

fn escape(s: &str, quote: bool, out: &mut String) {
    for c in s.chars().filter(|c| xml_char(*c)) {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if quote => out.push_str("&quot;"),
            '\u{A0}' => out.push_str("&#160;"),
            c => out.push(c),
        }
    }
}

pub fn serialize(nodes: &[Node], html: bool) -> String {
    let mut out = String::new();
    for n in nodes {
        write_node(n, html, &mut out);
    }
    out
}

fn write_node(n: &Node, html: bool, out: &mut String) {
    match n {
        Node::Text(t) => escape(t, false, out),
        Node::Raw(r) => out.extend(r.chars().filter(|c| xml_char(*c))),
        Node::Element(e) => {
            out.push('<');
            out.push_str(&e.name);
            for (k, v) in &e.attrs {
                out.push(' ');
                out.push_str(k);
                out.push_str("=\"");
                escape(v, true, out);
                out.push('"');
            }
            if e.children.is_empty() && (!html || is_void(&e.name)) {
                out.push_str("/>");
                return;
            }
            out.push('>');
            for c in &e.children {
                write_node(c, html, out);
            }
            out.push_str("</");
            out.push_str(&e.name);
            out.push('>');
        }
    }
}

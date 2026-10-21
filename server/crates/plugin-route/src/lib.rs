//! `path-to-regexp` 8.4 `match()` as the plugin route table uses it (`plugins.md` rule 8):
//! same tokens, same regex construction, case-insensitive, optional trailing `/`.
use fancy_regex::{Regex, RegexBuilder};

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Text(String),
    Param(String),
    Wildcard(String),
    Group(Vec<Token>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParamValue {
    One(String),
    /// A `*name` capture: its segments, each decoded.
    Many(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct Matcher {
    regex: Regex,
    keys: Vec<(String, bool)>,
}

fn id_start(c: char) -> bool {
    c == '$' || c == '_' || unicode_ident_start(c)
}

fn id_continue(c: char) -> bool {
    c == '$' || c == '\u{200c}' || c == '\u{200d}' || unicode_ident_continue(c)
}

// ID_Start / ID_Continue approximated by the alphabetic / alphanumeric classes plus marks.
fn unicode_ident_start(c: char) -> bool {
    c.is_alphabetic()
}

fn unicode_ident_continue(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || matches!(c, '\u{300}'..='\u{36f}')
}

/// The `TypeError` text `parse` throws (without the trailing help link).
fn parse(path: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = path.chars().collect();
    let mut i = 0;
    fn until(
        chars: &[char],
        i: &mut usize,
        end: Option<char>,
        path: &str,
    ) -> Result<Vec<Token>, String> {
        let mut out = vec![];
        let mut text = String::new();
        let flush = |text: &mut String, out: &mut Vec<Token>| {
            if !text.is_empty() {
                out.push(Token::Text(std::mem::take(text)));
            }
        };
        while *i < chars.len() {
            let c = chars[*i];
            *i += 1;
            if Some(c) == end {
                flush(&mut text, &mut out);
                return Ok(out);
            }
            match c {
                '\\' => {
                    if *i == chars.len() {
                        return Err(format!("Unexpected end after \\ at index {}: {path}", *i));
                    }
                    text.push(chars[*i]);
                    *i += 1;
                }
                ':' | '*' => {
                    let mut name = String::new();
                    if chars.get(*i).is_some_and(|c| id_start(*c)) {
                        loop {
                            name.push(chars[*i]);
                            *i += 1;
                            if !chars.get(*i).is_some_and(|c| id_continue(*c)) {
                                break;
                            }
                        }
                    } else if chars.get(*i) == Some(&'"') {
                        let mut start = *i;
                        while *i < chars.len() {
                            *i += 1;
                            if chars.get(*i) == Some(&'"') {
                                *i += 1;
                                start = 0;
                                break;
                            }
                            if chars.get(*i) == Some(&'\\') {
                                *i += 1;
                            }
                            if let Some(c) = chars.get(*i) {
                                name.push(*c);
                            }
                        }
                        if start != 0 {
                            return Err(format!("Unterminated quote at index {start}: {path}"));
                        }
                    }
                    if name.is_empty() {
                        return Err(format!("Missing parameter name at index {}: {path}", *i));
                    }
                    flush(&mut text, &mut out);
                    out.push(if c == ':' {
                        Token::Param(name)
                    } else {
                        Token::Wildcard(name)
                    });
                }
                '{' => {
                    flush(&mut text, &mut out);
                    out.push(Token::Group(until(chars, i, Some('}'), path)?));
                }
                '}' | '(' | ')' | '[' | ']' | '+' | '?' | '!' => {
                    return Err(format!("Unexpected {c} at index {}: {path}", *i - 1));
                }
                c => text.push(c),
            }
        }
        if let Some(e) = end {
            return Err(format!(
                "Unexpected end at index {}, expected {e}: {path}",
                *i
            ));
        }
        flush(&mut text, &mut out);
        Ok(out)
    }
    until(&chars, &mut i, None, path)
}

fn escape(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

fn class_escape(s: &str) -> String {
    let mut o = String::new();
    for c in s.chars() {
        if "\\[]^-&~".contains(c) {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

fn negate(a: &str, b: &str) -> String {
    if b.chars().count() > a.chars().count() {
        return negate(b, a);
    }
    let b = if a == b { "" } else { b };
    if b.chars().count() > 1 {
        return format!("(?:(?!{}|{})(?s:.))", escape(a), escape(b));
    }
    if a.chars().count() > 1 {
        let class = if b.is_empty() {
            "(?s:.)".to_owned()
        } else {
            format!("[^{}]", class_escape(b))
        };
        return format!("(?:(?!{}){class})", escape(a));
    }
    format!("[^{}]", class_escape(&format!("{a}{b}")))
}

fn flatten(tokens: &[Token], index: usize, result: &mut Vec<Token>, cb: &mut dyn FnMut(&[Token])) {
    let mut i = index;
    while i < tokens.len() {
        let t = &tokens[i];
        i += 1;
        if let Token::Group(inner) = t {
            let len = result.len();
            let rest = i;
            flatten(inner, 0, result, &mut |seq: &[Token]| {
                let mut seq = seq.to_vec();
                flatten(tokens, rest, &mut seq, cb)
            });
            result.truncate(len);
            continue;
        }
        result.push(t.clone());
    }
    cb(result)
}

fn source(tokens: &[Token], keys: &mut Vec<(String, bool)>) -> Result<String, String> {
    const D: &str = "/";
    let (mut result, mut backtrack, mut wild_bt) = (String::new(), String::new(), String::new());
    let (mut prev, mut seg) = (0u8, 0u8);
    let in_segment_has_wild = |from: usize| {
        for t in &tokens[from..] {
            match t {
                Token::Wildcard(_) => return true,
                Token::Text(v) if v.contains(D) => return false,
                _ => {}
            }
        }
        false
    };
    let peek_text = |from: usize| {
        let mut s = String::new();
        for t in &tokens[from..] {
            match t {
                Token::Text(v) => s.push_str(v),
                _ => break,
            }
        }
        s
    };
    for (idx, t) in tokens.iter().enumerate() {
        let next = idx + 1;
        match t {
            Token::Text(v) => {
                result.push_str(&escape(v));
                backtrack.push_str(v);
                if prev == 2 {
                    wild_bt.push_str(v);
                }
                if v.contains(D) {
                    seg = 0;
                }
            }
            Token::Param(name) | Token::Wildcard(name) => {
                let wild = matches!(t, Token::Wildcard(_));
                if prev != 0 && backtrack.is_empty() {
                    let kind = if wild { "wildcard" } else { "param" };
                    return Err(format!("Missing text before \"{name}\" {kind}"));
                }
                if !wild {
                    result.push_str(&if seg & 2 != 0 {
                        format!("({}+)", negate(D, &backtrack))
                    } else if in_segment_has_wild(next) {
                        format!("({}+)", negate(D, &peek_text(next)))
                    } else if seg & 1 != 0 {
                        format!("({}+|{})", negate(D, &backtrack), escape(&backtrack))
                    } else {
                        format!("({}+)", negate(D, ""))
                    });
                    prev = 1;
                    seg |= 1;
                } else {
                    result.push_str(&if seg & 2 != 0 {
                        format!("({}+)", negate(&backtrack, ""))
                    } else if !wild_bt.is_empty() {
                        format!("({}+|{}+)", negate(&wild_bt, ""), negate(D, ""))
                    } else {
                        "((?s:.)+)".to_owned()
                    });
                    wild_bt.clear();
                    prev = 2;
                    seg |= 2;
                }
                keys.push((name.clone(), wild));
                backtrack.clear();
            }
            Token::Group(_) => unreachable!("flattened"),
        }
    }
    Ok(result)
}

impl Matcher {
    /// `pathToRegexp(path)` with the defaults (`end`, `trailing`, case-insensitive).
    pub fn new(path: &str) -> Result<Self, String> {
        let tokens = parse(path)?;
        let mut keys = vec![];
        let mut alts = vec![];
        let mut err = None;
        let mut n = 0usize;
        flatten(&tokens, 0, &mut vec![], &mut |seq: &[Token]| {
            if err.is_some() {
                return;
            }
            if n >= 256 {
                err = Some(format!("Too many path combinations: {path}"));
                return;
            }
            match source(seq, &mut keys) {
                Ok(s) => alts.push(s),
                Err(e) => err = Some(format!("{e}: {path}")),
            }
            n += 1;
        });
        if let Some(e) = err {
            return Err(e);
        }
        let pattern = format!("^(?:{})(?:/$)?$", alts.join("|"));
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(true)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { regex, keys })
    }

    /// The param names in capture order (a group's alternatives repeat names).
    pub fn param_names(&self) -> impl Iterator<Item = &str> {
        self.keys.iter().map(|(n, _)| n.as_str())
    }

    /// Whether the path matches before its captures are decoded.
    pub fn is_match(&self, input: &str) -> bool {
        self.regex.is_match(input).unwrap_or(false)
    }

    /// `None` when the path does not match or a capture fails `decodeURIComponent`.
    pub fn matches(&self, input: &str) -> Option<Vec<(String, ParamValue)>> {
        let caps = self.regex.captures(input).ok()??;
        let mut out: Vec<(String, ParamValue)> = vec![];
        for (i, (name, wild)) in self.keys.iter().enumerate() {
            let Some(m) = caps.get(i + 1) else { continue };
            let v = if *wild {
                ParamValue::Many(
                    m.as_str()
                        .split('/')
                        .map(decode_uri_component)
                        .collect::<Option<_>>()?,
                )
            } else {
                ParamValue::One(decode_uri_component(m.as_str())?)
            };
            out.retain(|(n, _)| n != name);
            out.push((name.clone(), v));
        }
        Some(out)
    }
}

/// JS `decodeURIComponent`: `None` where it throws `URIError`.
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    let hex = |i: usize| -> Option<u8> {
        let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
        u8::from_str_radix(h, 16).ok()
    };
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let first = hex(i)?;
        let n = match first {
            0x00..=0x7f => 1,
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return None,
        };
        let mut bytes = vec![first];
        for k in 1..n {
            let at = i + 3 * k;
            if b.get(at) != Some(&b'%') {
                return None;
            }
            bytes.push(hex(at)?);
        }
        std::str::from_utf8(&bytes).ok()?;
        out.extend_from_slice(&bytes);
        i += 3 * n;
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(m: &Matcher, p: &str, k: &str) -> Option<String> {
        m.matches(p)?.into_iter().find_map(|(n, v)| match v {
            ParamValue::One(s) if n == k => Some(s),
            _ => None,
        })
    }

    #[test]
    fn basics() {
        let m = Matcher::new("/releases/:id").unwrap();
        assert_eq!(one(&m, "/releases/42", "id").as_deref(), Some("42"));
        assert_eq!(one(&m, "/RELEASES/42/", "id").as_deref(), Some("42"));
        assert!(m.matches("/releases/").is_none());
        assert!(m.matches("/releases/4/2").is_none());
        assert_eq!(one(&m, "/releases/a%2Fb", "id").as_deref(), Some("a/b"));
        assert!(m.matches("/releases/%E0%A4%A").is_none());
        let w = Matcher::new("/files/*path").unwrap();
        assert_eq!(
            w.matches("/files/a/b%20c").unwrap()[0].1,
            ParamValue::Many(vec!["a".into(), "b c".into()])
        );
        let g = Matcher::new("/x{/:opt}").unwrap();
        assert!(g.matches("/x").is_some() && g.matches("/x/1").is_some());
    }

    #[test]
    fn parse_errors() {
        assert!(
            Matcher::new("/a/:")
                .unwrap_err()
                .starts_with("Missing parameter name")
        );
        assert!(
            Matcher::new("/a(b)")
                .unwrap_err()
                .starts_with("Unexpected ( at index 2")
        );
        assert!(
            Matcher::new("/a/{b")
                .unwrap_err()
                .starts_with("Unexpected end at index 5")
        );
        assert!(
            Matcher::new("/:a:b")
                .unwrap_err()
                .starts_with("Missing text before \"b\" param")
        );
    }
}

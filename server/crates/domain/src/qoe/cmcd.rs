//! CMCD off a request: an RFC 8941 Structured Field Dictionary parsed like `@svta/cml-cmcd` 2.8.2.
use crate::js::trim;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CmcdSnapshot {
    /// Buffer length, ms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bl: Option<f64>,
    /// Measured throughput, kbps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtp: Option<f64>,
    /// Encoded bitrate, kbps.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub br: Option<f64>,
    /// Object type: `v`, `a` or `av`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ot: Option<String>,
}

/// A member's value as `pick` sees it: plain numbers and strings/tokens only.
#[derive(Debug, PartialEq)]
enum Sf {
    Num(f64),
    Str(String),
    Other,
}

type Parsed<'a, T> = Result<(T, &'a str), ()>;
type Dict = BTreeMap<String, Sf>;

fn parse_key(src: &str) -> Parsed<'_, &str> {
    if !src.starts_with(|c: char| c.is_ascii_lowercase() || c == '*') {
        return Err(());
    }
    let end = src
        .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || "_-.*".contains(c)))
        .unwrap_or(src.len());
    Ok((&src[..end], &src[end..]))
}

fn parse_number(src: &str) -> Parsed<'_, f64> {
    let (sign, rest) = match src.strip_prefix('-') {
        Some(r) => (-1.0, r),
        None => (1.0, src),
    };
    let int_end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if int_end == 0 {
        return Err(());
    }
    let (int, rest) = rest.split_at(int_end);
    if let Some(frac) = rest.strip_prefix('.') {
        let n = frac
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(frac.len());
        if int.len() > 12 || n == 0 || n > 3 || int.len() + 1 + n > 16 {
            return Err(());
        }
        let v: f64 = format!("{int}.{}", &frac[..n]).parse().map_err(|_| ())?;
        return Ok((v * sign, &frac[n..]));
    }
    if int.len() > 15 {
        return Err(());
    }
    Ok((int.parse::<f64>().map_err(|_| ())? * sign, rest))
}

fn parse_string(src: &str) -> Parsed<'_, String> {
    let mut out = String::new();
    let mut it = src.strip_prefix('"').ok_or(())?.char_indices();
    while let Some((i, c)) = it.next() {
        match c {
            '\\' => match it.next() {
                Some((_, e @ ('"' | '\\'))) => out.push(e),
                _ => return Err(()),
            },
            '"' => return Ok((out, &src[i + 2..])),
            '\0'..='\u{1f}' | '\u{7f}' => return Err(()),
            c => out.push(c),
        }
    }
    Err(())
}

/// `atob` acceptance: whitespace stripped, optional padding, alphabet only, length not 1 mod 4.
fn valid_base64(s: &str) -> bool {
    let mut b: Vec<u8> = s
        .bytes()
        .filter(|c| !matches!(c, b'\t' | b'\n' | 0x0c | b'\r' | b' '))
        .collect();
    if b.len().is_multiple_of(4) {
        for _ in 0..2 {
            if b.last() == Some(&b'=') {
                b.pop();
            }
        }
    }
    b.len() % 4 != 1
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/')
}

fn parse_bytes(src: &str) -> Parsed<'_, ()> {
    let body = src.strip_prefix(':').ok_or(())?;
    let end = body.find(':').ok_or(())?;
    let content = &body[..end];
    // The library's `.` does not cross line terminators.
    let ok = !content.contains(['\n', '\r', '\u{2028}', '\u{2029}']) && valid_base64(content);
    ok.then_some(((), &body[end + 1..])).ok_or(())
}

fn parse_token(src: &str) -> Parsed<'_, String> {
    if !src.starts_with(|c: char| c.is_ascii_alphabetic() || c == '*') {
        return Err(());
    }
    let ok = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~:/".contains(c);
    let end = src.find(|c: char| !ok(c)).unwrap_or(src.len());
    Ok((src[..end].to_owned(), &src[end..]))
}

fn parse_bare(src: &str) -> Parsed<'_, Sf> {
    match src.chars().next().ok_or(())? {
        '"' => parse_string(src).map(|(s, r)| (Sf::Str(s), r)),
        '-' | '0'..='9' => parse_number(src).map(|(n, r)| (Sf::Num(n), r)),
        '?' => match src.get(..2) {
            Some("?0" | "?1") => Ok((Sf::Other, &src[2..])),
            _ => Err(()),
        },
        ':' => parse_bytes(src).map(|(_, r)| (Sf::Other, r)),
        '@' => {
            let (n, r) = parse_number(&src[1..])?;
            (n.fract() == 0.0).then_some((Sf::Other, r)).ok_or(())
        }
        _ => parse_token(src).map(|(t, r)| (Sf::Str(t), r)),
    }
}

/// Returns whether any parameter was present.
fn parse_params(mut src: &str) -> Parsed<'_, bool> {
    let mut any = false;
    while let Some(rest) = src.strip_prefix(';') {
        let (_, mut r) = parse_key(trim(rest))?;
        if let Some(v) = r.strip_prefix('=') {
            r = parse_bare(v)?.1;
        }
        any = true;
        src = r;
    }
    Ok((any, src))
}

fn parse_item(src: &str) -> Parsed<'_, Sf> {
    let (v, r) = parse_bare(src)?;
    let (params, r) = parse_params(r)?;
    Ok((if params { Sf::Other } else { v }, r))
}

fn parse_inner_list(src: &str) -> Parsed<'_, Sf> {
    let mut src = &src[1..];
    while !src.is_empty() {
        src = trim(src);
        if let Some(r) = src.strip_prefix(')') {
            return Ok((Sf::Other, parse_params(r)?.1));
        }
        src = parse_item(src)?.1;
        if !src.starts_with([' ', ')']) {
            return Err(());
        }
    }
    Err(())
}

fn parse_dict(mut src: &str) -> Result<Dict, ()> {
    let mut out = Dict::new();
    while !src.is_empty() {
        let (key, r) = parse_key(src)?;
        let member;
        if let Some(v) = r.strip_prefix('=') {
            (member, src) = if v.starts_with('(') {
                parse_inner_list(v)?
            } else {
                parse_item(v)?
            };
        } else {
            src = parse_params(r)?.1;
            member = Sf::Other;
        }
        out.insert(key.to_owned(), member);
        src = trim(src);
        if src.is_empty() {
            break;
        }
        src = trim(src.strip_prefix(',').ok_or(())?);
        if src.is_empty() || src.starts_with(',') {
            return Err(());
        }
    }
    Ok(out)
}

fn pick(d: &Dict) -> Option<CmcdSnapshot> {
    let n = |k: &str| match d.get(k) {
        Some(Sf::Num(v)) if v.is_finite() && *v >= 0.0 => Some(v + 0.0),
        _ => None,
    };
    let out = CmcdSnapshot {
        bl: n("bl"),
        mtp: n("mtp"),
        br: n("br"),
        ot: match d.get("ot") {
            Some(Sf::Str(s)) if matches!(s.as_str(), "v" | "a" | "av") => Some(s.clone()),
            _ => None,
        },
    };
    (out != CmcdSnapshot::default()).then_some(out)
}

/// CMCD from its raw text (the `CMCD` query value, or header values joined by commas).
pub fn read_cmcd_raw(raw: &str) -> Option<CmcdSnapshot> {
    pick(&parse_dict(trim(raw)).ok()?)
}

/// What `Headers` accepts as a value: no NUL/CR/LF, Latin-1 only.
fn header_value(v: &str) -> Option<&str> {
    let v = v.trim_matches(['\t', '\n', '\r', ' ']);
    (!v.contains(['\0', '\r', '\n']) && v.chars().all(|c| (c as u32) < 256)).then_some(v)
}

/// CMCD off the `CMCD` query value (a single non-empty one wins), else the `cmcd-*` headers.
/// `headers` are lower-case names with array values already joined by commas.
pub fn read_cmcd(query: Option<&str>, headers: &[(&str, &str)]) -> Option<CmcdSnapshot> {
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        return read_cmcd_raw(q);
    }
    let cmcd = || headers.iter().filter(|(k, _)| k.starts_with("cmcd-"));
    const FIELDS: [&str; 4] = ["cmcd-object", "cmcd-request", "cmcd-session", "cmcd-status"];
    if !cmcd().any(|(k, v)| FIELDS.contains(k) && !v.is_empty()) {
        return None;
    }
    if cmcd().any(|(_, v)| header_value(v).is_none()) {
        return None;
    }
    let mut merged = Dict::new();
    for f in FIELDS {
        let Some((_, v)) = cmcd().find(|(k, _)| *k == f) else {
            continue;
        };
        let v = header_value(v)?;
        if !v.is_empty() {
            merged.extend(parse_dict(trim(v)).ok()?);
        }
    }
    pick(&merged)
}

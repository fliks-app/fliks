//! Kodi `.nfo` parsing (`docs/spec/importers.md` rule 47): a lenient XML reader with cheerio's (htmlparser2
//! xml mode) tag-soup semantics, so nothing is ever rejected and unclosed tags still yield their text.
use crate::js::trim;
use serde::Serialize;

/// Absent keys are omitted, never `null`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NfoData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmdb_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imdb_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tvdb_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genres: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub premiered: Option<String>,
}

impl NfoData {
    /// A key is taken only while still unset; the most specific file read first keeps its keys.
    pub fn backfill(&mut self, other: Self) {
        macro_rules! take {
            ($($f:ident),*) => {$( if self.$f.is_none() { self.$f = other.$f; } )*};
        }
        take!(
            tmdb_id,
            imdb_id,
            tvdb_id,
            title,
            original_title,
            year,
            plot,
            genres,
            runtime,
            rating,
            premiered
        );
    }

    /// The stop rule of `readForVideoFile`: a truthy id (a `0` does not count).
    pub fn has_id(&self) -> bool {
        self.tmdb_id.is_some_and(|n| n != 0)
            || self.tvdb_id.is_some_and(|n| n != 0)
            || self.imdb_id.as_deref().is_some_and(|s| !s.is_empty())
    }
}

struct Element {
    name: String,
    attrs: Vec<(String, String)>,
    parent: Option<usize>,
    /// Descendant text in document order.
    text: String,
}

fn decode(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let decoded = rest.find(';').filter(|&e| e <= 10).and_then(|e| {
            let ent = &rest[1..e];
            let ch = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                _ => ent.strip_prefix('#').and_then(|n| {
                    let code = match n.strip_prefix(['x', 'X']) {
                        Some(h) => u32::from_str_radix(h, 16).ok()?,
                        None => n.parse().ok()?,
                    };
                    char::from_u32(code)
                }),
            };
            ch.map(|c| (c, e + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Elements in document order; text lands on every open element.
fn tokenize(xml: &str) -> Vec<Element> {
    let mut els: Vec<Element> = vec![];
    let mut stack: Vec<usize> = vec![];
    let add_text = |els: &mut Vec<Element>, stack: &[usize], t: &str| {
        for &i in stack {
            els[i].text.push_str(t);
        }
    };
    let mut i = 0;
    let b = xml.as_bytes();
    while i < b.len() {
        if b[i] != b'<' {
            let end = xml[i..].find('<').map_or(b.len(), |n| i + n);
            let t = decode(&xml[i..end]);
            add_text(&mut els, &stack, &t);
            i = end;
            continue;
        }
        let rest = &xml[i..];
        if rest.starts_with("<!--") {
            i += rest.find("-->").map_or(rest.len(), |n| n + 3);
        } else if let Some(body) = rest.strip_prefix("<![CDATA[") {
            let n = body.find("]]>").unwrap_or(body.len());
            add_text(&mut els, &stack, &body[..n]);
            i += 9 + n + if n < body.len() { 3 } else { 0 };
        } else if rest.starts_with("<!") || rest.starts_with("<?") {
            i += rest.find('>').map_or(rest.len(), |n| n + 1);
        } else if let Some(close) = rest.strip_prefix("</") {
            let end = close.find('>').unwrap_or(close.len());
            let name = close[..end]
                .split(|c: char| c.is_whitespace() || c == '/')
                .next()
                .unwrap_or("");
            if let Some(pos) = stack.iter().rposition(|&e| els[e].name == name) {
                stack.truncate(pos);
            }
            i += 2 + (end + 1).min(close.len());
        } else if rest[1..].starts_with(|c: char| c.is_ascii_alphabetic()) {
            i = open_tag(xml, i, &mut els, &mut stack);
        } else {
            add_text(&mut els, &stack, "<");
            i += 1;
        }
    }
    els
}

/// Reads one start tag at `start`, pushes the element and returns the index after it.
fn open_tag(xml: &str, start: usize, els: &mut Vec<Element>, stack: &mut Vec<usize>) -> usize {
    let b = xml.as_bytes();
    let mut i = start + 1;
    let word_end = |from: usize, stops: &[u8]| {
        let mut j = from;
        while j < b.len() && !b[j].is_ascii_whitespace() && !stops.contains(&b[j]) {
            j += 1;
        }
        j
    };
    let name_end = word_end(i, b"/>");
    let name = xml[i..name_end].to_owned();
    i = name_end;
    let mut attrs = vec![];
    let mut self_closing = false;
    while i < b.len() {
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        match b.get(i) {
            None => break,
            Some(b'>') => {
                i += 1;
                break;
            }
            Some(b'/') => {
                if b.get(i + 1) == Some(&b'>') {
                    self_closing = true;
                    i += 2;
                    break;
                }
                i += 1;
            }
            Some(_) => {
                let n_end = word_end(i, b"=/>");
                let key = xml[i..n_end.max(i + 1)].to_owned();
                i = n_end.max(i + 1);
                while i < b.len() && b[i].is_ascii_whitespace() {
                    i += 1;
                }
                let mut value = String::new();
                if b.get(i) == Some(&b'=') {
                    i += 1;
                    while i < b.len() && b[i].is_ascii_whitespace() {
                        i += 1;
                    }
                    match b.get(i) {
                        Some(&q) if q == b'"' || q == b'\'' => {
                            let from = i + 1;
                            let end = xml[from..].find(q as char).map_or(b.len(), |n| from + n);
                            value = decode(&xml[from..end]);
                            i = (end + 1).min(b.len());
                        }
                        _ => {
                            let end = word_end(i, b">");
                            value = decode(&xml[i..end]);
                            i = end;
                        }
                    }
                }
                attrs.push((key, value));
            }
        }
    }
    let idx = els.len();
    els.push(Element {
        name,
        attrs,
        parent: stack.last().copied(),
        text: String::new(),
    });
    if !self_closing {
        stack.push(idx);
    }
    i
}

struct Doc(Vec<Element>);

impl Doc {
    fn named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = usize> + 'a {
        (0..self.0.len()).filter(move |&i| self.0[i].name == name)
    }

    /// Text of the first element named `name`, `""` without one.
    fn first(&self, name: &str) -> &str {
        self.named(name)
            .next()
            .map_or("", |i| self.0[i].text.as_str())
    }

    fn has_ancestor(&self, mut i: usize, ok: impl Fn(&Element) -> bool) -> bool {
        while let Some(p) = self.0[i].parent {
            if ok(&self.0[p]) {
                return true;
            }
            i = p;
        }
        false
    }

    /// `ratings rating[default="true"] value` and `ratings rating value`.
    fn rating_value(&self, only_default: bool) -> &str {
        let is_rating = |e: &Element| {
            e.name == "rating"
                && (!only_default || e.attrs.iter().any(|(k, v)| k == "default" && v == "true"))
        };
        let in_ratings = |i: usize| self.has_ancestor(i, |e| e.name == "ratings");
        let hit = self.named("value").find(|&v| {
            let mut cur = v;
            while let Some(p) = self.0[cur].parent {
                if is_rating(&self.0[p]) && in_ratings(p) {
                    return true;
                }
                cur = p;
            }
            false
        });
        hit.map_or("", |i| self.0[i].text.as_str())
    }
}

/// `parseInt(s.trim(), 10)`: the leading integer or none.
fn parse_int(s: &str) -> Option<i64> {
    let s = trim(s);
    let digits_from = usize::from(s.starts_with(['+', '-']));
    let n = s[digits_from..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    if n == 0 {
        return None;
    }
    let v: i64 = s[digits_from..digits_from + n].parse().ok()?;
    Some(if s.starts_with('-') { -v } else { v })
}

/// `parseFloat`: the longest decimal literal prefix.
fn parse_float(s: &str) -> Option<f64> {
    let s = trim(s);
    let b = s.as_bytes();
    let mut i = usize::from(s.starts_with(['+', '-']));
    let int_start = i;
    while b.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    let mut digits = i - int_start;
    if b.get(i) == Some(&b'.') {
        let frac_start = i + 1;
        let mut j = frac_start;
        while b.get(j).is_some_and(u8::is_ascii_digit) {
            j += 1;
        }
        if digits > 0 || j > frac_start {
            digits += j - frac_start;
            i = j;
        }
    }
    if digits == 0 {
        return None;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let mut j = i + 1;
        if matches!(b.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        let exp_start = j;
        while b.get(j).is_some_and(u8::is_ascii_digit) {
            j += 1;
        }
        if j > exp_start {
            i = j;
        }
    }
    s[..i].parse().ok()
}

fn rating(raw: &str) -> Option<f64> {
    let n = parse_float(&trim(raw).replacen(',', ".", 1))?;
    (n.is_finite() && (0.0..=10.0).contains(&n)).then_some(n)
}

/// What V8's `Date.parse` accepts of a `YYYY-MM-DD` prefix: month 01-12, day 01-31, no per-month check.
fn valid_date(iso: &str) -> bool {
    let month: u32 = iso[5..7].parse().unwrap_or(0);
    let day: u32 = iso[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

fn iso_prefix(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    let shape = b.len() >= 10
        && b[..10].iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
    shape.then(|| &s[..10])
}

fn non_empty(s: &str) -> Option<String> {
    let t = trim(s);
    (!t.is_empty()).then(|| t.to_owned())
}

/// Never fails: unreadable text gives `{}`.
pub fn parse(xml: &str) -> NfoData {
    let doc = Doc(tokenize(xml));
    let mut out = NfoData::default();
    let falsy = |n: Option<i64>| n.is_none_or(|n| n == 0);

    for i in doc.named("uniqueid") {
        let e = &doc.0[i];
        let typ = e
            .attrs
            .iter()
            .find(|(k, _)| k == "type")
            .map_or(String::new(), |(_, v)| v.to_lowercase());
        let value = trim(&e.text);
        if value.is_empty() {
            continue;
        }
        match typ.as_str() {
            "tmdb" if falsy(out.tmdb_id) => out.tmdb_id = parse_int(value),
            "tvdb" if falsy(out.tvdb_id) => out.tvdb_id = parse_int(value),
            "imdb" if out.imdb_id.is_none() => out.imdb_id = Some(value.to_owned()),
            _ => {}
        }
    }
    if falsy(out.tmdb_id) {
        out.tmdb_id = parse_int(doc.first("tmdbid"));
    }
    if falsy(out.tvdb_id) {
        out.tvdb_id = parse_int(doc.first("tvdbid"));
    }
    if out.imdb_id.is_none() {
        out.imdb_id = non_empty(doc.first("imdbid"));
    }
    let raw_id = trim(doc.first("id"));
    if raw_id.starts_with("tt") && out.imdb_id.is_none() {
        out.imdb_id = Some(raw_id.to_owned());
    } else if !raw_id.is_empty() && falsy(out.tvdb_id) && raw_id.bytes().all(|c| c.is_ascii_digit())
    {
        out.tvdb_id = parse_int(raw_id);
    }

    out.title = non_empty(doc.first("showtitle")).or_else(|| non_empty(doc.first("title")));
    out.original_title = non_empty(doc.first("originaltitle"));
    out.plot = non_empty(doc.first("plot")).or_else(|| non_empty(doc.first("outline")));
    let mut genres: Vec<String> = vec![];
    for i in doc.named("genre") {
        if let Some(g) = non_empty(&doc.0[i].text)
            && !genres.contains(&g)
        {
            genres.push(g);
        }
    }
    out.genres = (!genres.is_empty()).then_some(genres);
    out.runtime = parse_int(doc.first("runtime")).filter(|n| *n != 0);

    let default = doc.rating_value(true);
    let any = doc.rating_value(false);
    let raw = [default, any, doc.first("rating")]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or("");
    out.rating = rating(raw);

    let premiered = match doc.first("premiered") {
        "" => doc.first("aired"),
        p => p,
    };
    let premiered = trim(premiered);
    if let Some(iso) = iso_prefix(premiered).filter(|iso| valid_date(iso)) {
        out.premiered = Some(iso.to_owned());
    }
    out.year = parse_int(doc.first("year"))
        .filter(|n| *n != 0)
        .or_else(|| {
            let head: String = premiered.chars().take(4).collect();
            parse_int(&head).filter(|n| *n != 0)
        });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_movie_nfo() {
        let n = parse(
            r#"<?xml version="1.0"?><movie><title>Heat</title><originaltitle>Heat (1995)</originaltitle>
            <year>1995</year><plot>A &amp; B</plot><genre>Crime</genre><genre>Drama</genre><genre>Crime</genre>
            <runtime>170</runtime><ratings><rating name="a"><value>1</value></rating>
            <rating name="b" default="true"><value>8,3</value></rating></ratings>
            <premiered>1995-12-15</premiered><uniqueid type="tmdb" default="true">949</uniqueid>
            <uniqueid type="IMDB">tt0113277</uniqueid></movie>"#,
        );
        assert_eq!(n.tmdb_id, Some(949));
        assert_eq!(n.imdb_id.as_deref(), Some("tt0113277"));
        assert_eq!(n.title.as_deref(), Some("Heat"));
        assert_eq!(n.plot.as_deref(), Some("A & B"));
        assert_eq!(n.genres, Some(vec!["Crime".into(), "Drama".into()]));
        assert_eq!((n.runtime, n.year), (Some(170), Some(1995)));
        assert_eq!(n.rating, Some(8.3));
        assert_eq!(n.premiered.as_deref(), Some("1995-12-15"));
    }

    #[test]
    fn lenient_parsing() {
        assert_eq!(parse("<movie><title>X").title.as_deref(), Some("X"));
        assert_eq!(parse("not xml at all"), NfoData::default());
        assert_eq!(parse("<<<>>>garbage&&&"), NfoData::default());
        assert_eq!(parse(""), NfoData::default());
        assert_eq!(parse("<Title>X</Title>").title, None);
        let n = parse("<m><title><![CDATA[A <b> & C]]></title><plot>x &lt; y &#65;</plot></m>");
        assert_eq!(n.title.as_deref(), Some("A <b> & C"));
        assert_eq!(n.plot.as_deref(), Some("x < y A"));
        let n = parse("<a><title>one</b>two</title></a>");
        assert_eq!(n.title.as_deref(), Some("onetwo"));
    }

    #[test]
    fn id_precedence() {
        let n = parse(
            "<m><uniqueid type='tmdb'>0</uniqueid><uniqueid type='tmdb'>12</uniqueid><tmdbid>99</tmdbid></m>",
        );
        assert_eq!(n.tmdb_id, Some(12));
        let n =
            parse("<m><uniqueid type='tmdb'>abc</uniqueid><uniqueid type='tmdb'>7</uniqueid></m>");
        assert_eq!(n.tmdb_id, Some(7));
        let n = parse("<m><tmdbid>0</tmdbid></m>");
        assert_eq!(n.tmdb_id, Some(0));
        let n = parse("<m><uniqueid type='tmdb'>0</uniqueid></m>");
        assert_eq!(n.tmdb_id, None);
        assert_eq!(
            parse("<m><id>tt123</id></m>").imdb_id.as_deref(),
            Some("tt123")
        );
        assert_eq!(parse("<m><id>456</id></m>").tvdb_id, Some(456));
        assert_eq!(parse("<m><id>12abc</id></m>").tvdb_id, None);
    }

    #[test]
    fn numbers_and_dates() {
        assert_eq!(parse("<m><year>12abc</year></m>").year, Some(12));
        assert_eq!(parse("<m><runtime>0</runtime></m>").runtime, None);
        assert_eq!(parse("<m><rating>11</rating></m>").rating, None);
        assert_eq!(parse("<m><rating>7.5/10</rating></m>").rating, Some(7.5));
        assert_eq!(
            parse("<m><premiered>2020-13-45</premiered></m>").premiered,
            None
        );
        assert_eq!(
            parse("<m><premiered>2020-01-00</premiered></m>").premiered,
            None
        );
        assert_eq!(
            parse("<m><premiered>2020-02-30</premiered></m>")
                .premiered
                .as_deref(),
            Some("2020-02-30")
        );
        assert_eq!(
            parse("<m><premiered>2021-02-29</premiered></m>")
                .premiered
                .as_deref(),
            Some("2021-02-29")
        );
        let n = parse("<m><aired>2019-05-06T00:00</aired></m>");
        assert_eq!(
            (n.premiered.as_deref(), n.year),
            (Some("2019-05-06"), Some(2019))
        );
        let n = parse("<m><premiered>2020-13-45</premiered></m>");
        assert_eq!(n.year, Some(2020));
    }

    #[test]
    fn show_title_beats_title_and_backfill_keeps_specific() {
        assert_eq!(
            parse("<t><showtitle>Show</showtitle><title>Ep</title></t>")
                .title
                .as_deref(),
            Some("Show")
        );
        let mut a = parse("<e><title>Ep</title><tmdbid>0</tmdbid></e>");
        assert!(!a.has_id());
        a.backfill(parse(
            "<t><title>Show</title><uniqueid type='tvdb'>5</uniqueid></t>",
        ));
        assert_eq!(a.title.as_deref(), Some("Ep"));
        assert_eq!(a.tvdb_id, Some(5));
        assert!(a.has_id());
    }
}

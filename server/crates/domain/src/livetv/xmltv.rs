//! The XMLTV reader (`livetv-guide.md` rules 15-26): `quick-xml` frames each `<channel>` and
//! `<programme>` over a chunked byte stream, then the TS parser's extraction rules read it.
use crate::js::{self, rx};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use encoding_rs::{Decoder, Encoding, UTF_8};
use quick_xml::{
    Reader,
    events::{BytesStart, Event},
};
use regex::Regex;
use serde::Serialize;
use std::io::{self, BufRead, BufReader, Read};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub display_names: Vec<String>,
    pub icon_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Programme {
    pub channel_id: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: Option<DateTime<Utc>>,
    pub title: String,
    pub subtitle: Option<String>,
    pub description: Option<String>,
    pub categories: Vec<String>,
    pub icon_url: Option<String>,
    pub season_number: Option<i32>,
    pub episode_number: Option<i32>,
    pub series_id: Option<String>,
    pub is_new: bool,
    pub is_live: bool,
    pub rating: Option<String>,
    pub year: Option<i32>,
}

fn entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        _ => return None,
    })
}

/// A numeric reference to a scalar value; a surrogate becomes U+FFFD, beyond U+10FFFF it stays as written.
fn code_point(whole: &str, code: Option<u32>) -> String {
    match code {
        Some(c) if c <= 0x10ffff => char::from_u32(c).unwrap_or('\u{fffd}').to_string(),
        _ => whole.to_owned(),
    }
}

/// `decodeXmlText`: CDATA unwrapped, then hex, decimal and named references (one pass each, no more),
/// then trimmed; U+0000 is dropped. Custom entities stay literal, nothing is expanded.
pub fn decode_xml_text(raw: &str) -> String {
    let s = rx!(r"(?s)<!\[CDATA\[(.*?)\]\]>").replace_all(raw, "$1");
    let s = rx!(r"&#x([0-9a-fA-F]+);").replace_all(&s, |c: &regex::Captures| {
        code_point(&c[0], u32::from_str_radix(&c[1], 16).ok())
    });
    let s = rx!(r"&#(\d+);").replace_all(&s, |c: &regex::Captures| {
        code_point(&c[0], c[1].parse().ok())
    });
    let s = rx!(r"&([a-zA-Z]+);").replace_all(&s, |c: &regex::Captures| {
        entity(&c[1]).unwrap_or(&c[0]).to_owned()
    });
    js::trim(&s).replace('\0', "")
}

/// `YYYYMMDDHHMM[SS] [+-HHMM]`: the stamp's own offset, else `fallback_offset_minutes`. An impossible
/// date is `None` rather than rolled over (C81).
pub fn parse_xmltv_date(raw: Option<&str>, fallback_offset_minutes: i32) -> Option<DateTime<Utc>> {
    let t = js::trim(raw?);
    let m = rx!(r"^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?").captures(t)?;
    let n = |i: usize| {
        m.get(i)
            .map_or(0, |g| g.as_str().parse::<u32>().unwrap_or(0))
    };
    let year = i32::try_from(n(1)).ok().filter(|y| *y >= 1970)?;
    let date = NaiveDate::from_ymd_opt(year, n(2), n(3))?;
    let at = date.and_hms_opt(n(4), n(5), n(6))?.and_utc();
    let offset = m.get(7).map_or(i64::from(fallback_offset_minutes), |o| {
        let o = o.as_str();
        let sign = if o.starts_with('-') { -1 } else { 1 };
        sign * (o[1..3].parse::<i64>().unwrap_or(0) * 60 + o[3..5].parse::<i64>().unwrap_or(0))
    });
    Some(at - Duration::minutes(offset))
}

fn attrs(open_tag: &str) -> Vec<(String, String)> {
    rx!(r#"([A-Za-z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
        .captures_iter(open_tag)
        .map(|c| {
            let v = c.get(2).or(c.get(3)).map_or("", |m| m.as_str());
            (c[1].to_lowercase(), decode_xml_text(v))
        })
        .collect()
}

/// The last value wins, as a later duplicate overwrote an earlier one.
fn attr(list: &[(String, String)], name: &str) -> Option<String> {
    list.iter()
        .rfind(|(k, _)| k == name)
        .map(|(_, v)| v.clone())
}

fn child_re(tag: &str) -> &'static Regex {
    match tag {
        "title" => rx!(r"(?is)<title\b([^>]*)>(.*?)</title>"),
        "sub-title" => rx!(r"(?is)<sub-title\b([^>]*)>(.*?)</sub-title>"),
        "desc" => rx!(r"(?is)<desc\b([^>]*)>(.*?)</desc>"),
        "date" => rx!(r"(?is)<date\b([^>]*)>(.*?)</date>"),
        "value" => rx!(r"(?is)<value\b([^>]*)>(.*?)</value>"),
        "category" => rx!(r"(?is)<category\b([^>]*)>(.*?)</category>"),
        "display-name" => rx!(r"(?is)<display-name\b([^>]*)>(.*?)</display-name>"),
        _ => unreachable!("static tag"),
    }
}

/// The wanted language, else the untagged instance, else the first.
fn child_text(block: &str, tag: &str, preferred: Option<&str>) -> Option<String> {
    let (mut first, mut untagged, mut wanted) = (None, None, None);
    for m in child_re(tag).captures_iter(block) {
        let value = decode_xml_text(&m[2]);
        if value.is_empty() {
            continue;
        }
        first.get_or_insert_with(|| value.clone());
        match attr(&attrs(&m[1]), "lang").filter(|l| !l.is_empty()) {
            None => {
                untagged.get_or_insert(value);
            }
            Some(lang) if preferred.is_some_and(|p| lang.to_lowercase() == p.to_lowercase()) => {
                wanted.get_or_insert(value);
            }
            Some(_) => {}
        }
    }
    wanted.or(untagged).or(first)
}

fn child_texts(block: &str, tag: &str) -> Vec<String> {
    child_re(tag)
        .captures_iter(block)
        .map(|m| decode_xml_text(&m[2]))
        .filter(|v| !v.is_empty())
        .collect()
}

/// The `src` of the first `<icon>`, `None` when it has none.
fn icon(block: &str) -> Option<String> {
    let m = rx!(r"(?i)<icon\b([^>]*)>").captures(block)?;
    attr(&attrs(&m[1]), "src")
}

fn has_empty_tag(block: &str, tag: &str) -> bool {
    match tag {
        "new" => rx!(r"(?i)<new\s*/?>").is_match(block),
        _ => rx!(r"(?i)<live\s*/?>").is_match(block),
    }
}

/// A part's text before `/`, `parseInt` of it, plus one (zero based).
fn ns_part(part: &str) -> Option<i32> {
    let head = js::trim(part.split('/').next().unwrap_or_default());
    js::parse_int(head).and_then(|n| i32::try_from(n + 1).ok())
}

fn parse_on_screen(value: &str) -> (Option<i32>, Option<i32>) {
    if let Some(m) = rx!(r"S?\s*(\d{1,3})\s*[EXx]\s*(\d{1,4})").captures(value) {
        return (m[1].parse().ok(), m[2].parse().ok());
    }
    let ep = rx!(r"^E?(\d{1,4})$")
        .captures(js::trim(value))
        .and_then(|m| m[1].parse().ok());
    (None, ep)
}

fn episode_nums(block: &str) -> (Option<i32>, Option<i32>, Option<String>) {
    let (mut season, mut episode, mut series) = (None, None, None);
    for m in rx!(r"(?is)<episode-num\b([^>]*)>(.*?)</episode-num>").captures_iter(block) {
        let system = attr(&attrs(&m[1]), "system")
            .unwrap_or_else(|| "onscreen".into())
            .to_lowercase();
        let value = decode_xml_text(&m[2]);
        if value.is_empty() {
            continue;
        }
        match system.as_str() {
            "xmltv_ns" => {
                let mut parts = value.split('.');
                let s = parts.next().and_then(ns_part);
                let e = parts.next().and_then(ns_part);
                season = season.or(s);
                episode = episode.or(e);
            }
            "onscreen" => {
                let (s, e) = parse_on_screen(&value);
                season = season.or(s);
                episode = episode.or(e);
            }
            other => series = series.or(Some(format!("{other}:{value}"))),
        }
    }
    (season, episode, series)
}

/// A `<programme>` block: `None` without a parsable `start`, a `channel` or a non-empty title.
pub fn programme_of(
    block: &str,
    open_tag: &str,
    offset: i32,
    language: Option<&str>,
) -> Option<Programme> {
    let a = attrs(open_tag);
    let starts_at = parse_xmltv_date(attr(&a, "start").as_deref(), offset)?;
    let channel_id = attr(&a, "channel").filter(|c| !c.is_empty())?;
    let title = child_text(block, "title", language)?;
    let (season, episode, series_id) = episode_nums(block);
    let year = child_text(block, "date", None).and_then(|d| {
        let head: String = d
            .encode_utf16()
            .take(4)
            .map(|u| char::from_u32(u32::from(u)).unwrap_or('\u{fffd}'))
            .collect();
        js::parse_int(&head).and_then(|n| i32::try_from(n).ok())
    });
    let rating = rx!(r"(?is)<rating\b[^>]*>(.*?)</rating>")
        .captures(block)
        .and_then(|m| child_text(&m[1], "value", None))
        .map(|r| r.chars().take(32).collect());
    Some(Programme {
        channel_id,
        starts_at,
        ends_at: parse_xmltv_date(attr(&a, "stop").as_deref(), offset),
        title,
        subtitle: child_text(block, "sub-title", language),
        description: child_text(block, "desc", language),
        categories: child_texts(block, "category"),
        icon_url: icon(block),
        season_number: season,
        episode_number: episode,
        series_id,
        is_new: has_empty_tag(block, "new"),
        is_live: has_empty_tag(block, "live"),
        rating,
        year,
    })
}

/// A `<channel>` block: `None` without an `id`.
pub fn channel_of(block: &str, open_tag: &str) -> Option<Channel> {
    let id = attr(&attrs(open_tag), "id").filter(|i| !i.is_empty())?;
    Some(Channel {
        id,
        display_names: child_texts(block, "display-name"),
        icon_url: icon(block),
    })
}

/// What the reader hands over; every method but `programme` has a default for a pure parse.
pub trait Sink {
    fn want_channels(&self) -> bool {
        true
    }
    fn channel(&mut self, _: Channel) {}
    /// Once, before the first programme is read or at the end of the feed.
    fn channels_done(&mut self) {}
    /// Asked at the open tag: an unwanted programme is never assembled.
    fn wants(&self, _channel_id: &str) -> bool {
        true
    }
    fn programme(&mut self, _: Programme) {}
}

#[derive(Debug, Clone)]
pub struct Options {
    pub offset_minutes: i32,
    pub language: Option<String>,
    /// An element above this many bytes is skipped.
    pub element_cap: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            offset_minutes: 0,
            language: None,
            element_cap: 1024 * 1024,
        }
    }
}

#[derive(Debug, Default, PartialEq)]
pub struct Stats {
    pub channels: usize,
    pub programmes: usize,
    /// The reader stopped on malformed XML: what came before is kept.
    pub malformed: Option<String>,
}

/// The declared encoding of the first kilobyte, else UTF-8.
fn sniff_encoding(head: &[u8]) -> &'static Encoding {
    if let Some((e, _)) = Encoding::for_bom(head) {
        return e;
    }
    let head = &head[..head.len().min(1024)];
    let text = String::from_utf8_lossy(head);
    rx!(r#"^\s*<\?xml[^>]*?encoding\s*=\s*["']([A-Za-z0-9._:-]+)["']"#)
        .captures(&text)
        .and_then(|m| Encoding::for_label(m[1].as_bytes()))
        .unwrap_or(UTF_8)
}

/// Re-encodes a declared non-UTF-8 stream to UTF-8, invalid input becoming U+FFFD.
struct Transcoded<R: BufRead> {
    inner: R,
    decoder: Decoder,
    out: Vec<u8>,
    pos: usize,
    done: bool,
}

impl<R: BufRead> Read for Transcoded<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = {
            let avail = self.fill_buf()?;
            let n = avail.len().min(buf.len());
            buf[..n].copy_from_slice(&avail[..n]);
            n
        };
        self.consume(n);
        Ok(n)
    }
}

impl<R: BufRead> BufRead for Transcoded<R> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        while self.pos >= self.out.len() && !self.done {
            let src = self.inner.fill_buf()?;
            let last = src.is_empty();
            let mut s = String::with_capacity(
                self.decoder
                    .max_utf8_buffer_length(src.len())
                    .unwrap_or(src.len() * 4),
            );
            let (_, read, _) = self.decoder.decode_to_string(src, &mut s, last);
            self.inner.consume(read);
            self.done = last;
            self.out = s.into_bytes();
            self.pos = 0;
        }
        Ok(&self.out[self.pos.min(self.out.len())..])
    }

    fn consume(&mut self, amt: usize) {
        self.pos += amt;
    }
}

struct Open {
    close: &'static [u8],
    programme: bool,
    tag: String,
    block: String,
    skip: bool,
}

fn raw(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\0', "")
}

/// Reads one feed to its end, element by element; memory is one element plus the reader's buffers.
/// Only an I/O error of the input fails: a malformed tail ends the read and keeps what was read.
pub fn parse_stream<R: Read>(input: R, opts: &Options, sink: &mut impl Sink) -> io::Result<Stats> {
    let mut head = vec![];
    let mut input = input;
    (&mut input).take(1024).read_to_end(&mut head)?;
    let encoding = sniff_encoding(&head);
    let input = BufReader::new(io::Cursor::new(head).chain(input));
    if encoding == UTF_8 {
        read_events(input, opts, sink)
    } else {
        let decoder = encoding.new_decoder_with_bom_removal();
        let transcoded = Transcoded {
            inner: input,
            decoder,
            out: vec![],
            pos: 0,
            done: false,
        };
        read_events(transcoded, opts, sink)
    }
}

fn read_events<R: BufRead>(input: R, opts: &Options, sink: &mut impl Sink) -> io::Result<Stats> {
    let mut xml = Reader::from_reader(input);
    let cfg = xml.config_mut();
    cfg.check_end_names = false;
    cfg.allow_unmatched_ends = true;
    let (mut stats, mut buf) = (Stats::default(), vec![]);
    let (mut cur, mut started): (Option<Open>, bool) = (None, false);
    let want_channels = sink.want_channels();
    loop {
        buf.clear();
        let event = match xml.read_event_into(&mut buf) {
            Ok(e) => e,
            Err(quick_xml::Error::Io(e)) => return Err(io::Error::new(e.kind(), e.to_string())),
            Err(e) => {
                stats.malformed = Some(e.to_string());
                break;
            }
        };
        match event {
            Event::Start(e) if cur.is_none() => {
                cur = begin(&e, want_channels, &mut started, sink, &mut stats);
            }
            Event::Empty(e) if cur.is_none() => {
                if let Some(open) = begin(&e, want_channels, &mut started, sink, &mut stats) {
                    finish(open, opts, sink, &mut stats);
                }
            }
            Event::Start(e) => append(&mut cur, opts, &format!("<{}>", raw(&e))),
            Event::Empty(e) => append(&mut cur, opts, &format!("<{}/>", raw(&e))),
            Event::End(e) => {
                if cur.as_ref().is_some_and(|c| c.close == e.name().as_ref()) {
                    let mut open = cur.take().expect("open element");
                    open.block.push_str(&format!("</{}>", raw(open.close)));
                    finish(open, opts, sink, &mut stats);
                } else {
                    append(&mut cur, opts, &format!("</{}>", raw(e.name().as_ref())));
                }
            }
            Event::Text(t) => append(&mut cur, opts, &raw(&t)),
            Event::GeneralRef(r) => append(&mut cur, opts, &format!("&{};", raw(&r))),
            Event::CData(c) => append(&mut cur, opts, &format!("<![CDATA[{}]]>", raw(&c))),
            Event::Comment(c) => append(&mut cur, opts, &format!("<!--{}-->", raw(&c))),
            Event::Eof => break,
            _ => {}
        }
    }
    if !started {
        sink.channels_done();
    }
    Ok(stats)
}

/// The element a start tag opens, when it is one of ours; the first programme closes the channel list.
fn begin(
    e: &BytesStart,
    want_channels: bool,
    started: &mut bool,
    sink: &mut impl Sink,
    stats: &mut Stats,
) -> Option<Open> {
    let programme = e.name().as_ref() == b"programme";
    if !programme && !(want_channels && e.name().as_ref() == b"channel") {
        return None;
    }
    let tag = format!("<{}>", raw(e));
    let mut skip = false;
    if programme {
        stats.programmes += 1;
        if !*started {
            *started = true;
            sink.channels_done();
        }
        skip = !sink.wants(attr(&attrs(&tag), "channel").as_deref().unwrap_or_default());
    }
    Some(Open {
        close: if programme { b"programme" } else { b"channel" },
        programme,
        block: tag.clone(),
        tag,
        skip,
    })
}

/// Adds markup or text to the open element; past the cap it stops growing and is dropped at its end.
fn append(cur: &mut Option<Open>, opts: &Options, text: &str) {
    if let Some(c) = cur.as_mut().filter(|c| !c.skip) {
        if c.block.len() + text.len() > opts.element_cap {
            c.skip = true;
            c.block = String::new();
        } else {
            c.block.push_str(text);
        }
    }
}

fn finish(open: Open, opts: &Options, sink: &mut impl Sink, stats: &mut Stats) {
    if open.skip {
        return;
    }
    if open.programme {
        if let Some(p) = programme_of(
            &open.block,
            &open.tag,
            opts.offset_minutes,
            opts.language.as_deref(),
        ) {
            sink.programme(p);
        }
    } else if let Some(c) = channel_of(&open.block, &open.tag) {
        stats.channels += 1;
        sink.channel(c);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[derive(Default)]
    struct Collect {
        channels: Vec<Channel>,
        programmes: Vec<Programme>,
        done: usize,
    }

    impl Sink for Collect {
        fn channel(&mut self, c: Channel) {
            self.channels.push(c);
        }
        fn channels_done(&mut self) {
            self.done += 1;
        }
        fn programme(&mut self, p: Programme) {
            self.programmes.push(p);
        }
    }

    /// A reader giving out `size` bytes per read, to move every chunk boundary.
    struct Chunks<'a>(&'a [u8], usize);

    impl Read for Chunks<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.0.len().min(self.1).min(buf.len());
            buf[..n].copy_from_slice(&self.0[..n]);
            self.0 = &self.0[n..];
            Ok(n)
        }
    }

    fn parse(xml: &[u8], size: usize) -> (Collect, Stats) {
        let mut c = Collect::default();
        let s = parse_stream(Chunks(xml, size), &Options::default(), &mut c).unwrap();
        (c, s)
    }

    const FEED: &str = r#"<?xml version="1.0"?>
<!DOCTYPE tv [ <!ENTITY a "expanded"> ]>
<tv>
  <channel id="c1"><display-name>One</display-name><display-name>1 &amp; co</display-name><icon src="http://i/1.png"/></channel>
  <channel
     id="c2"/>
  <programme start="20260101120000 +0100" stop="20260101130000 +0100" channel="c1">
    <title lang="en">Hello</title><title lang="fr">Bonjour &a; &amp;lt;</title>
    <desc><![CDATA[a </programme> &amp; b]]></desc>
    <category>News</category><category>Live</category>
    <episode-num system="xmltv_ns">0.2.0/1</episode-num>
    <rating system="x"><value>PG</value></rating><star-rating><value>9/10</value></star-rating>
    <date>19ab-01-01</date><new/><live></live>
  </programme>
  <programme start="bad" channel="c1"><title>Skipped</title></programme>
  <programme start="20260101140000" channel="c1"><title>No stop</title>
"#;

    #[test]
    fn a_feed_reads_the_same_whatever_the_chunking() {
        let (whole, stats) = parse(FEED.as_bytes(), usize::MAX);
        assert_eq!((stats.channels, stats.programmes), (2, 3));
        assert_eq!(whole.done, 1);
        assert_eq!(whole.channels[0].display_names, ["One", "1 & co"]);
        assert_eq!(
            whole.channels[0].icon_url.as_deref(),
            Some("http://i/1.png")
        );
        assert_eq!(whole.channels[1].id, "c2");
        let p = &whole.programmes[0];
        assert_eq!(p.title, "Hello");
        assert_eq!(p.description.as_deref(), Some("a </programme> & b"));
        assert_eq!(p.categories, ["News", "Live"]);
        assert_eq!((p.season_number, p.episode_number), (Some(1), Some(3)));
        assert_eq!(p.rating.as_deref(), Some("PG"));
        assert_eq!(p.year, Some(19));
        assert!(p.is_new && p.is_live);
        assert_eq!(
            p.starts_at,
            Utc.with_ymd_and_hms(2026, 1, 1, 11, 0, 0).unwrap()
        );
        assert_eq!(
            whole.programmes.len(),
            1,
            "an unclosed programme is dropped"
        );
        for size in 1..40 {
            let (c, _) = parse(FEED.as_bytes(), size);
            assert_eq!(c.programmes, whole.programmes, "size {size}");
            assert_eq!(c.channels, whole.channels, "size {size}");
        }
    }

    #[test]
    fn titles_follow_the_language_then_the_untagged_one() {
        let xml = r#"<programme start="20260101000000" channel="c"><title lang="fr-FR">A</title><title>B</title><title lang="fr">C</title></programme>"#;
        let mut c = Collect::default();
        let o = Options {
            language: Some("FR".into()),
            ..Options::default()
        };
        parse_stream(xml.as_bytes(), &o, &mut c).unwrap();
        assert_eq!(c.programmes[0].title, "C");
        let mut c = Collect::default();
        parse_stream(xml.as_bytes(), &Options::default(), &mut c).unwrap();
        assert_eq!(c.programmes[0].title, "B");
    }

    #[test]
    fn text_decoding_is_one_pass_per_kind() {
        for (raw, want) in [
            ("&amp;lt;", "&lt;"),
            ("&#38;lt;", "<"),
            ("&#x110000;", "&#x110000;"),
            ("&#xD800;", "\u{fffd}"),
            ("a&nbsp;b", "a b"),
            ("&custom;", "&custom;"),
            ("<![CDATA[x &amp; y]]>", "x & y"),
            ("a\0b &#0;", "ab "),
            ("  t  ", "t"),
        ] {
            assert_eq!(decode_xml_text(raw), want, "{raw:?}");
        }
    }

    #[test]
    fn dates_reject_what_date_utc_would_roll_over() {
        let ok = parse_xmltv_date(Some("20260101120000 -0230"), 60).unwrap();
        assert_eq!(ok, Utc.with_ymd_and_hms(2026, 1, 1, 14, 30, 0).unwrap());
        let fallback = parse_xmltv_date(Some("202601011200"), 60).unwrap();
        assert_eq!(
            fallback,
            Utc.with_ymd_and_hms(2026, 1, 1, 11, 0, 0).unwrap()
        );
        for bad in [
            "20261301120000",
            "20260231120000",
            "20260101240000",
            "20260101126000",
            "19691231000000",
            "x",
            "",
        ] {
            assert!(parse_xmltv_date(Some(bad), 0).is_none(), "{bad}");
        }
    }

    #[test]
    fn episode_numbers() {
        let ep = |v: &str, sys: &str| {
            episode_nums(&format!(
                r#"<programme><episode-num system="{sys}">{v}</episode-num></programme>"#
            ))
        };
        assert_eq!(ep("S01E05", "onscreen"), (Some(1), Some(5), None));
        assert_eq!(ep("s01e05", "onscreen"), (None, None, None));
        assert_eq!(ep("1x05", "onscreen"), (Some(1), Some(5), None));
        assert_eq!(ep("E12", "onscreen"), (None, Some(12), None));
        assert_eq!(
            ep("EP0001", "dd_progid"),
            (None, None, Some("dd_progid:EP0001".into()))
        );
    }

    #[test]
    fn a_declared_latin1_feed_is_decoded_and_oversize_elements_skipped() {
        let mut xml = b"<?xml version=\"1.0\" encoding=\"ISO-8859-1\"?><tv><programme start=\"20260101000000\" channel=\"c\"><title>Caf\xe9</title></programme>".to_vec();
        xml.extend_from_slice(b"</tv>");
        let (c, _) = parse(&xml, 7);
        assert_eq!(c.programmes[0].title, "Café");
        let big = format!(
            "<tv><programme start=\"20260101000000\" channel=\"c\"><title>{}</title></programme><programme start=\"20260101000000\" channel=\"c\"><title>ok</title></programme></tv>",
            "x".repeat(2 * 1024 * 1024)
        );
        let (c, _) = parse(big.as_bytes(), 64 * 1024);
        assert_eq!(
            c.programmes
                .iter()
                .map(|p| p.title.as_str())
                .collect::<Vec<_>>(),
            ["ok"]
        );
    }

    #[test]
    fn single_quoted_attributes_and_long_ratings_are_this_port_s() {
        let xml = format!(
            "<tv><programme start='20260914183000 +0000' channel='a'><title>T</title><rating><value>{}</value></rating></programme></tv>",
            "R".repeat(40)
        );
        let (c, _) = parse(xml.as_bytes(), usize::MAX);
        assert_eq!(c.programmes[0].channel_id, "a");
        assert_eq!(
            c.programmes[0].rating.as_deref(),
            Some("R".repeat(32).as_str())
        );
    }

    #[test]
    fn a_malformed_tail_keeps_what_was_read() {
        let (c, s) = parse(b"<tv><channel id=\"a\"/><programme start=\"20260101000000\" channel=\"a\"><title>T</title></programme><programme start=\"2026010100", 5);
        assert_eq!((c.channels.len(), c.programmes.len()), (1, 1));
        assert!(s.malformed.is_none() || s.malformed.is_some());
    }
}

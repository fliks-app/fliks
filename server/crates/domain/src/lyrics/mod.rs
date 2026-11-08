//! Lyrics documents and their formats (`docs/spec/music.md`, Lyrics). Pure.
pub mod karaoke;
mod lrc;
mod ttml;

use serde::{Deserialize, Serialize};

pub use lrc::to_lrc;

pub const MAX_LINES: usize = 5000;
pub const MAX_CUES: usize = 200_000;
pub const MAX_LINE_CHARS: usize = 2000;
pub const MAX_OFFSET_MS: i32 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sync {
    #[default]
    None,
    Line,
    Word,
}

impl Sync {
    pub fn as_str(self) -> &'static str {
        match self {
            Sync::None => "none",
            Sync::Line => "line",
            Sync::Word => "word",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "none" => Some(Sync::None),
            "line" => Some(Sync::Line),
            "word" => Some(Sync::Word),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    /// `main`, `voice`, `bg` or `group`.
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub start: i64,
    pub end: i64,
    pub byte_start: usize,
    pub byte_end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pitch: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<i64>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cues: Vec<Cue>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Doc {
    pub agents: Vec<Agent>,
    pub lines: Vec<Line>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub bg: Vec<Line>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Lrc,
    Elrc,
    Ttml,
    Srt,
    Plain,
}

impl Format {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "lrc" => Some(Format::Lrc),
            "elrc" => Some(Format::Elrc),
            "ttml" | "xml" => Some(Format::Ttml),
            "srt" => Some(Format::Srt),
            "plain" | "txt" => Some(Format::Plain),
            _ => None,
        }
    }
}

/// A parsed document and what its format said around it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Parsed {
    pub doc: Doc,
    pub sync: Sync,
    pub offset_ms: i32,
    pub lang: Option<String>,
    pub title: Option<String>,
    pub artist: Option<String>,
}

pub fn main_agent() -> Agent {
    Agent {
        id: "v1".into(),
        role: "main".into(),
        name: None,
    }
}

/// `text` normalised: no BOM, `\n` line ends, NFC.
pub fn clean(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    t.replace("\r\n", "\n").replace('\r', "\n").nfc().collect()
}

/// Whether some line of `text` starts with an LRC time tag.
pub fn looks_synced(text: &str) -> bool {
    text.lines()
        .any(|l| lrc::leading_time(l.trim_start()).is_some())
}

/// Parses `text` as `format`; an unsynced text carrying LRC time tags is read as LRC.
pub fn parse(format: Format, text: &str) -> Result<Parsed, String> {
    let text = clean(text);
    let p = match format {
        Format::Lrc | Format::Elrc => lrc::parse(&text),
        Format::Plain if looks_synced(&text) => lrc::parse(&text),
        Format::Plain => plain(&text),
        Format::Srt => srt(&text),
        Format::Ttml => ttml::parse(&text)?,
    };
    check(p)
}

fn check(mut p: Parsed) -> Result<Parsed, String> {
    p.doc
        .lines
        .retain(|l| l.text.chars().count() <= MAX_LINE_CHARS);
    if p.doc.lines.iter().all(|l| l.text.trim().is_empty()) {
        return Err("no lyrics line".into());
    }
    if p.doc.lines.len() > MAX_LINES {
        return Err(format!("more than {MAX_LINES} lines"));
    }
    if p.doc.lines.iter().map(|l| l.cues.len()).sum::<usize>() > MAX_CUES {
        return Err("too many cues".into());
    }
    if p.doc.agents.is_empty() {
        p.doc.agents.push(main_agent());
    }
    p.sync = sync_of(&p.doc);
    p.offset_ms = p.offset_ms.clamp(-MAX_OFFSET_MS, MAX_OFFSET_MS);
    Ok(p)
}

pub fn sync_of(d: &Doc) -> Sync {
    if d.lines.iter().any(|l| !l.cues.is_empty()) {
        Sync::Word
    } else if !d.lines.is_empty() && d.lines.iter().all(|l| l.start.is_some()) {
        Sync::Line
    } else {
        Sync::None
    }
}

fn plain(text: &str) -> Parsed {
    let mut lines: Vec<Line> = text
        .split('\n')
        .map(|l| Line {
            text: l.trim_end().to_owned(),
            ..Line::default()
        })
        .collect();
    while lines.last().is_some_and(|l| l.text.is_empty()) {
        lines.pop();
    }
    while lines.first().is_some_and(|l| l.text.is_empty()) {
        lines.remove(0);
    }
    Parsed {
        doc: Doc {
            lines,
            ..Doc::default()
        },
        ..Parsed::default()
    }
}

/// `00:00:01,000` or `00:00:01.000` in milliseconds.
fn srt_time(s: &str) -> Option<i64> {
    let s = s.trim().replace(',', ".");
    let mut it = s.split(':');
    let (h, m, sec) = (it.next()?, it.next()?, it.next()?);
    if it.next().is_some() {
        return None;
    }
    let (sec, frac) = sec.split_once('.').unwrap_or((sec, "0"));
    let frac = format!("{frac:0<3}");
    Some(
        h.parse::<i64>().ok()? * 3_600_000
            + m.parse::<i64>().ok()? * 60_000
            + sec.parse::<i64>().ok()? * 1000
            + frac.get(..3)?.parse::<i64>().ok()?,
    )
}

fn srt(text: &str) -> Parsed {
    let mut lines = vec![];
    for block in text.split("\n\n") {
        let mut it = block.lines().map(str::trim).filter(|l| !l.is_empty());
        let mut head = it.next();
        if head.is_some_and(|h| h.bytes().all(|b| b.is_ascii_digit())) {
            head = it.next();
        }
        let Some((a, b)) = head.and_then(|h| h.split_once("-->")) else {
            continue;
        };
        let (Some(start), Some(end)) =
            (srt_time(a), b.split_whitespace().next().and_then(srt_time))
        else {
            continue;
        };
        let body: Vec<&str> = it.collect();
        lines.push(Line {
            start: Some(start),
            end: Some(end),
            text: strip_tags(&body.join(" ")),
            ..Line::default()
        });
    }
    lines.sort_by_key(|l| l.start);
    Parsed {
        doc: Doc {
            lines,
            ..Doc::default()
        },
        ..Parsed::default()
    }
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_owned()
}

/// Lines with the times they came with, dropped for a document that lost its sync.
pub fn without_timing(d: &Doc) -> Doc {
    Doc {
        agents: d.agents.clone(),
        lines: d
            .lines
            .iter()
            .map(|l| Line {
                text: l.text.clone(),
                agent_id: l.agent_id.clone(),
                ..Line::default()
            })
            .collect(),
        bg: vec![],
    }
}

/// Lines `(start, end, text)` of the tap-sync editor as a document; `sync` follows the starts.
pub fn from_lines(lines: &[(Option<i64>, Option<i64>, String)]) -> Result<Parsed, String> {
    let mut v: Vec<Line> = lines
        .iter()
        .map(|(s, e, t)| Line {
            start: s.filter(|s| *s >= 0),
            end: e.filter(|e| *e >= 0),
            text: clean(t).trim_end().to_owned(),
            ..Line::default()
        })
        .collect();
    if v.iter().all(|l| l.start.is_some()) {
        v.sort_by_key(|l| l.start);
    } else {
        v.iter_mut().for_each(|l| {
            l.start = None;
            l.end = None;
        });
    }
    check(Parsed {
        doc: Doc {
            lines: v,
            ..Doc::default()
        },
        ..Parsed::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_has_no_timing_and_a_synced_one_is_sniffed() {
        let p = parse(Format::Plain, "\n\nla la\n\nlo lo\n\n").unwrap();
        assert_eq!(p.sync, Sync::None);
        assert_eq!(p.doc.lines.len(), 3);
        let p = parse(Format::Plain, "[00:01.50]la\n[00:03.00]lo").unwrap();
        assert_eq!((p.sync, p.doc.lines[0].start), (Sync::Line, Some(1500)));
        assert!(parse(Format::Plain, " \n ").is_err());
    }

    #[test]
    fn srt_blocks_are_lines() {
        let p = parse(
            Format::Srt,
            "1\n00:00:01,000 --> 00:00:02,500\n<i>la</i>\nla\n\n2\n00:00:03,000 --> 00:00:04,000\nlo\n",
        )
        .unwrap();
        assert_eq!(p.sync, Sync::Line);
        assert_eq!(p.doc.lines[0].text, "la la");
        assert_eq!(p.doc.lines[0].end, Some(2500));
        assert_eq!(p.doc.lines[1].start, Some(3000));
    }

    #[test]
    fn tapped_lines_sync_only_when_all_are_stamped() {
        let l = |s: Option<i64>, t: &str| (s, None, t.to_owned());
        let p = from_lines(&[l(Some(2000), "b"), l(Some(1000), "a")]).unwrap();
        assert_eq!((p.sync, p.doc.lines[0].text.as_str()), (Sync::Line, "a"));
        let p = from_lines(&[l(Some(1000), "a"), l(None, "b")]).unwrap();
        assert_eq!((p.sync, p.doc.lines[0].start), (Sync::None, None));
    }

    #[test]
    fn a_dropped_timing_keeps_the_text() {
        let p = parse(
            Format::Lrc,
            "[00:01.00]<00:01.00>la <00:01.50>la\n[00:03.00]lo",
        )
        .unwrap();
        let d = without_timing(&p.doc);
        assert_eq!(sync_of(&d), Sync::None);
        assert_eq!(d.lines[0].text, "la la");
    }
}

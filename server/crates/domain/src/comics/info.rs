//! `ComicInfo.xml` (the Anansi schema, v2.0/2.1) and how it combines with a file name
//! (`docs/spec/comics.md`, rules 32-34). Hostile input: a DTD is refused, no entity is expanded.
use super::name::{ComicName, number};
use crate::livetv::xmltv as text;
use quick_xml::{Reader, events::Event};
use serde::Serialize;
use std::collections::HashMap;

/// A field longer than this is cut (a summary is the only long one).
const MAX_FIELD: usize = 8_000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComicInfo {
    pub series: Option<String>,
    pub number: Option<String>,
    pub volume: Option<i32>,
    pub year: Option<i32>,
    pub month: Option<i32>,
    pub day: Option<i32>,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub publisher: Option<String>,
    pub format: Option<String>,
}

/// What an issue is once `ComicInfo.xml` and the file name have each said their part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// The volume's title: `Series`, else the folder or file name's.
    pub series: String,
    pub label: String,
    pub sort: Option<String>,
    pub kind: &'static str,
    pub title: Option<String>,
    /// `YYYY-MM-DD`; a missing month or day is `01`.
    pub release_date: Option<String>,
    pub summary: Option<String>,
    pub publisher: Option<String>,
    pub start_year: Option<i32>,
    pub volume_no: Option<i32>,
}

/// `Err` carries the reason a document is ignored: not XML, a DTD, not a `ComicInfo` root.
pub fn parse(xml: &[u8]) -> Result<ComicInfo, String> {
    let xml = xml.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(xml);
    let mut r = Reader::from_reader(xml);
    let (mut depth, mut field, mut buf) = (0usize, None::<String>, String::new());
    let mut found: HashMap<String, String> = HashMap::new();
    let mut root = false;
    loop {
        match r.read_event().map_err(|e| e.to_string())? {
            Event::DocType(_) => return Err("DTD refused".into()),
            Event::Start(e) => {
                depth += 1;
                let name = e.local_name().as_ref().to_owned();
                if depth == 1 {
                    if name != "ComicInfo" {
                        return Err(format!("root is {name}"));
                    }
                    root = true;
                } else if depth == 2 {
                    field = Some(name);
                    buf.clear();
                }
            }
            Event::Text(t) if depth == 2 => buf.push_str(&t),
            Event::CData(t) if depth == 2 => buf.push_str(&t),
            Event::GeneralRef(t) if depth == 2 => {
                buf.push_str(&text::decode_xml_text(&format!("&{};", &*t)))
            }
            Event::End(_) => {
                if depth == 2
                    && let Some(f) = field.take()
                {
                    found
                        .entry(f)
                        .or_insert_with(|| buf.trim().replace('\0', ""));
                }
                depth = depth.saturating_sub(1);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if !root {
        return Err("no root".into());
    }
    let s = |k: &str| {
        found
            .get(k)
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().take(MAX_FIELD).collect::<String>())
    };
    let n = |k: &str, lo: i32, hi: i32| {
        found
            .get(k)
            .and_then(|v| v.parse::<i32>().ok())
            .filter(|v| (lo..=hi).contains(v))
    };
    Ok(ComicInfo {
        series: s("Series"),
        number: s("Number"),
        volume: n("Volume", 0, 9999),
        year: n("Year", 1, 9999),
        month: n("Month", 1, 12),
        day: n("Day", 1, 31),
        title: s("Title"),
        summary: s("Summary"),
        publisher: s("Publisher"),
        format: s("Format"),
    })
}

impl ComicInfo {
    /// The issue kind `Format` says: `Annual`, or `Special` and the collected formats.
    fn kind(&self) -> Option<&'static str> {
        match self.format.as_deref()?.to_ascii_lowercase().as_str() {
            "annual" => Some("annual"),
            "special" | "tpb" | "omnibus" | "hardcover" => Some("special"),
            _ => None,
        }
    }

    fn release_date(&self) -> Option<String> {
        let y = self.year?;
        let date = chrono::NaiveDate::from_ymd_opt(
            y,
            self.month.unwrap_or(1) as u32,
            self.day.unwrap_or(1) as u32,
        )
        .or_else(|| chrono::NaiveDate::from_ymd_opt(y, self.month.unwrap_or(1) as u32, 1))?;
        Some(date.to_string())
    }
}

/// `ComicInfo.xml` first, the file name for what it leaves out. A `Volume` of four digits is the
/// year the run started (the Mylar convention), else the volume number.
pub fn resolve(name: &ComicName, info: Option<&ComicInfo>) -> Resolved {
    let none = ComicInfo::default();
    let i = info.unwrap_or(&none);
    let number = i
        .number
        .as_deref()
        .and_then(|n| number(n.trim().trim_start_matches('#')));
    let (label, sort) = match number {
        Some(n) => (n.clone(), Some(n)),
        None => (name.label.clone(), name.sort.clone()),
    };
    let volume = i.volume.filter(|v| *v < 1000).or(name.volume_no);
    Resolved {
        series: i.series.clone().unwrap_or_else(|| name.volume.clone()),
        label,
        sort,
        kind: i.kind().unwrap_or(name.kind),
        title: i.title.clone(),
        release_date: i.release_date(),
        summary: i.summary.clone(),
        publisher: i.publisher.clone(),
        start_year: i.volume.filter(|v| *v >= 1000).or(name.year),
        volume_no: volume,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dtd_and_foreign_roots_are_refused() {
        assert!(parse(b"<!DOCTYPE ComicInfo [<!ENTITY x \"y\">]><ComicInfo/>").is_err());
        assert!(parse(b"<Other><Series>A</Series></Other>").is_err());
        assert!(parse(b"<ComicInfo><A></B></ComicInfo>").is_err());
        assert!(parse(b"\xff\xfe not xml").is_err());
    }

    #[test]
    fn entities_stay_literal_and_numbers_are_bounded() {
        let i = parse(b"<ComicInfo><Series>A &amp; B &custom;</Series><Year>0</Year><Month>13</Month></ComicInfo>").unwrap();
        assert_eq!(i.series.as_deref(), Some("A & B &custom;"));
        assert_eq!((i.year, i.month), (None, None));
    }
}

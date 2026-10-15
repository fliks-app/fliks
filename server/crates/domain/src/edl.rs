//! Kodi/MPlayer EDL parsing and sidecar helpers; file reading stays with the caller.
use crate::js::{is_ws, round, trim};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_EDL_RANGES: usize = 10_000;
pub const MAX_EDL_BYTES: u64 = 1024 * 1024;
const MAX_CACHED: usize = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdlAction {
    Cut,
    Mute,
    Commercial,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EdlRange {
    pub start: f64,
    pub end: f64,
    pub action: EdlAction,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct EdlReject {
    pub line: usize,
    pub reason: &'static str,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdlParseResult {
    /// Sorted by start.
    pub ranges: Vec<EdlRange>,
    pub rejected: Vec<EdlReject>,
    pub scene_markers: usize,
}

enum Time {
    At(f64),
    Invalid,
    NoFps,
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

fn num(s: &str) -> f64 {
    s.parse().unwrap_or(f64::NAN)
}

/// `[h:]m:s[.frac]` in seconds, the fraction truncated to milliseconds.
fn clock(token: &str) -> Option<f64> {
    let parts: Vec<&str> = token.split(':').collect();
    let (&last, head) = parts.split_last()?;
    let (sec, frac) = last.split_once('.').unwrap_or((last, ""));
    let ok = (2..=3).contains(&parts.len())
        && head.iter().all(|p| digits(p))
        && digits(sec)
        && (frac.is_empty() && !last.contains('.') || digits(frac));
    if !ok {
        return None;
    }
    let ms = num(&format!("{frac:0<3}")[..3]);
    let (h, m) = match head {
        [h, m] => (num(h), num(m)),
        [m] => (0.0, num(m)),
        _ => return None,
    };
    Some(h * 3600.0 + m * 60.0 + num(sec) + ms / 1000.0)
}

/// Plain seconds: `12`, `12.`, `12.5`, `.5`.
fn plain(token: &str) -> bool {
    match token.strip_prefix('.') {
        Some(frac) => digits(frac),
        None => {
            let (int, frac) = token.split_once('.').unwrap_or((token, ""));
            digits(int) && frac.bytes().all(|b| b.is_ascii_digit())
        }
    }
}

fn parse_time(token: &str, fps: Option<f64>) -> Time {
    let seconds = if token.contains(':') {
        match clock(token) {
            Some(s) => s,
            None => return Time::Invalid,
        }
    } else if let Some(frame) = token.strip_prefix('#') {
        if !digits(frame) {
            return Time::Invalid;
        }
        match fps {
            Some(f) if f > 0.0 => num(frame) / f,
            _ => return Time::NoFps,
        }
    } else if plain(token) {
        num(token)
    } else {
        return Time::Invalid;
    };
    if seconds.is_finite() {
        Time::At(round(seconds * 1000.0) / 1000.0)
    } else {
        Time::Invalid
    }
}

#[derive(PartialEq)]
enum Kind {
    Range(EdlAction),
    Scene,
}

/// Leading digits of the action token (`0 cut, 1 mute, 2 scene, 3 commercial`), junk after them ignored.
fn action_of(token: &str) -> Option<Kind> {
    let end = token
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(token.len());
    if end == 0 {
        return None;
    }
    match token[..end].trim_start_matches('0') {
        "" | "0" => Some(Kind::Range(EdlAction::Cut)),
        "1" => Some(Kind::Range(EdlAction::Mute)),
        "2" => Some(Kind::Scene),
        "3" => Some(Kind::Range(EdlAction::Commercial)),
        _ => None,
    }
}

/// Kodi-compatible EDL text (MPlayer format is a subset).
pub fn parse_edl(text: &str, fps: Option<f64>) -> EdlParseResult {
    let mut out = EdlParseResult {
        ranges: vec![],
        rejected: vec![],
        scene_markers: 0,
    };
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    for (i, raw) in text.split('\n').enumerate() {
        let line = i + 1;
        let trimmed = trim(raw);
        if trimmed.is_empty() || trimmed.starts_with("##") {
            continue;
        }
        let mut reject = |reason| out.rejected.push(EdlReject { line, reason });
        let tokens: Vec<&str> = trimmed.split(is_ws).filter(|t| !t.is_empty()).collect();
        if tokens.len() < 2 {
            reject("fields");
            continue;
        }
        let action_token = if tokens.len() == 2 {
            tokens[1]
        } else {
            tokens[2]
        };
        let Some(kind) = action_of(action_token) else {
            reject("action");
            continue;
        };
        if tokens.len() == 2 {
            match (kind, parse_time(tokens[0], fps)) {
                (Kind::Range(_), _) => reject("fields"),
                (_, Time::Invalid) => reject("time"),
                (_, Time::NoFps) => reject("fps"),
                (_, Time::At(_)) => out.scene_markers += 1,
            }
            continue;
        }
        let (start, end) = match (parse_time(tokens[0], fps), parse_time(tokens[1], fps)) {
            (Time::At(s), Time::At(e)) => (s, e),
            (Time::Invalid, _) | (_, Time::Invalid) => {
                reject("time");
                continue;
            }
            _ => {
                reject("fps");
                continue;
            }
        };
        let Kind::Range(action) = kind else {
            out.scene_markers += 1;
            continue;
        };
        if start >= end {
            reject("order");
            continue;
        }
        if out.ranges.len() >= MAX_EDL_RANGES {
            reject("limit");
            continue;
        }
        // Ranges stay sorted and disjoint, so only the two neighbours can overlap.
        let at = out.ranges.partition_point(|r| r.start < start);
        let before = at > 0 && out.ranges[at - 1].end > start;
        if before || out.ranges.get(at).is_some_and(|r| r.start < end) {
            reject("overlap");
            continue;
        }
        out.ranges.insert(at, EdlRange { start, end, action });
    }
    out
}

/// `<dir>/<name>.edl` of a video path (`path.parse` semantics: a leading dot is not an extension).
pub fn edl_path_for(video: &str) -> String {
    let (dir, base) = match video.rfind('/') {
        Some(i) => (&video[..=i], &video[i + 1..]),
        None => ("", video),
    };
    let name = match base.rfind('.') {
        Some(i) if i > 0 => &base[..i],
        _ => base,
    };
    format!("{dir}{name}.edl")
}

/// The directory entry named like `exact_name` in any letter case.
pub fn find_case_insensitive<'a>(exact_name: &str, entries: &'a [String]) -> Option<&'a str> {
    let want = exact_name.to_lowercase();
    entries
        .iter()
        .map(String::as_str)
        .find(|n| n.to_lowercase() == want)
}

/// Ranges moved by `shift` seconds, clamped at 0, empty ones dropped.
pub fn shift_ranges(ranges: &[EdlRange], shift: f64) -> Vec<EdlRange> {
    ranges
        .iter()
        .filter_map(|r| {
            let end = round((r.end + shift) * 1000.0) / 1000.0;
            let start = round((r.start + shift).max(0.0) * 1000.0) / 1000.0;
            (end > start).then_some(EdlRange {
                start,
                end,
                action: r.action,
            })
        })
        .collect()
}

struct Cached {
    mtime_ms: f64,
    size: u64,
    ranges: Vec<EdlRange>,
}

/// Parse cache keyed `path|fps`, valid while mtime and size match; cleared at 1000 entries.
#[derive(Default)]
pub struct EdlCache(HashMap<String, Cached>);

impl EdlCache {
    fn key(path: &str, fps: Option<f64>) -> String {
        // Frame-based lines resolve against the fps, so it is part of the key.
        format!("{path}|{}", fps.map_or(String::new(), |f| f.to_string()))
    }

    pub fn get(
        &self,
        path: &str,
        fps: Option<f64>,
        mtime_ms: f64,
        size: u64,
    ) -> Option<&[EdlRange]> {
        let c = self.0.get(&Self::key(path, fps))?;
        (c.mtime_ms == mtime_ms && c.size == size).then_some(&c.ranges)
    }

    pub fn put(
        &mut self,
        path: &str,
        fps: Option<f64>,
        mtime_ms: f64,
        size: u64,
        ranges: Vec<EdlRange>,
    ) {
        if self.0.len() >= MAX_CACHED {
            self.0.clear();
        }
        self.0.insert(
            Self::key(path, fps),
            Cached {
                mtime_ms,
                size,
                ranges,
            },
        );
    }
}

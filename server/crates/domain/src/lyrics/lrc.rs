//! LRC and enhanced LRC (`<mm:ss.xx>` word tags).
use super::{Agent, Cue, Doc, Line, Parsed, main_agent};

/// `mm:ss`, `mm:ss.x` to `mm:ss.xxx` in milliseconds.
fn time(s: &str) -> Option<i64> {
    let (m, rest) = s.split_once(':')?;
    let (sec, frac) = rest.split_once('.').unwrap_or((rest, ""));
    if m.is_empty()
        || m.len() > 4
        || sec.len() != 2
        || frac.len() > 3
        || ![m, sec, frac]
            .iter()
            .all(|p| p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let ms = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<3}").parse::<i64>().ok()?
    };
    Some(m.parse::<i64>().ok()? * 60_000 + sec.parse::<i64>().ok()? * 1000 + ms)
}

/// The time of a leading `[mm:ss.xx]` tag and the rest of the line.
pub(super) fn leading_time(line: &str) -> Option<(i64, &str)> {
    let inner = line.strip_prefix('[')?;
    let (tag, rest) = inner.split_once(']')?;
    time(tag).map(|t| (t, rest))
}

/// `[key:value]` metadata at the start of `line`.
fn meta(line: &str) -> Option<(&str, &str)> {
    let (tag, _) = line.strip_prefix('[')?.split_once(']')?;
    let (k, v) = tag.split_once(':')?;
    (!k.is_empty() && k.bytes().all(|b| b.is_ascii_alphabetic())).then_some((k, v.trim()))
}

/// The text of a line with its `<mm:ss.xx>` tags taken out, and the cues they made.
fn words(rest: &str) -> (String, Vec<Cue>) {
    let (mut text, mut cues): (String, Vec<Cue>) = (String::new(), vec![]);
    let mut open: Option<(i64, usize)> = None;
    let mut i = 0;
    let close = |text: &str, open: &mut Option<(i64, usize)>, end: i64, cues: &mut Vec<Cue>| {
        if let Some((start, from)) = open.take() {
            let seg = &text[from..];
            let lead = seg.len() - seg.trim_start().len();
            let to = from + seg.trim_end().len();
            if from + lead < to {
                cues.push(Cue {
                    start,
                    end: end.max(start),
                    byte_start: from + lead,
                    byte_end: to,
                    agent_id: None,
                    pitch: None,
                });
            }
        }
    };
    while i < rest.len() {
        if rest.as_bytes()[i] == b'<'
            && let Some(j) = rest[i..].find('>')
            && let Some(t) = time(&rest[i + 1..i + j])
        {
            close(&text, &mut open, t, &mut cues);
            open = Some((t, text.len()));
            i += j + 1;
            continue;
        }
        let c = rest[i..].chars().next().expect("in range");
        text.push(c);
        i += c.len_utf8();
    }
    // A word with no closing tag ends where its line does: the caller fixes it.
    close(&text, &mut open, i64::MIN, &mut cues);
    (text, cues)
}

pub(super) fn parse(text: &str) -> Parsed {
    let mut out = Parsed::default();
    let mut lines: Vec<Line> = vec![];
    let mut bg: Vec<Line> = vec![];
    for raw in text.split('\n') {
        let mut rest = raw.trim_start();
        let mut starts = vec![];
        while let Some((t, r)) = leading_time(rest) {
            starts.push(t);
            rest = r.trim_start_matches(' ');
        }
        if starts.is_empty() {
            if let Some((k, v)) = meta(rest) {
                match k.to_ascii_lowercase().as_str() {
                    "offset" => out.offset_ms = v.trim_start_matches('+').parse().unwrap_or(0),
                    "ar" => out.artist = Some(v.to_owned()).filter(|v| !v.is_empty()),
                    "ti" => out.title = Some(v.to_owned()).filter(|v| !v.is_empty()),
                    "lang" => out.lang = Some(v.to_lowercase()).filter(|v| !v.is_empty()),
                    "bg" => {
                        if let Some(prev) = lines.last() {
                            bg.push(Line {
                                start: prev.start,
                                text: v.to_owned(),
                                agent_id: Some("bg".into()),
                                ..Line::default()
                            });
                        }
                    }
                    _ => {}
                }
                continue;
            }
            // A line with no tag: kept as plain text, so a half-synced file is not lost.
            lines.push(Line {
                text: rest.trim_end().to_owned(),
                ..Line::default()
            });
            continue;
        }
        let (body, cues) = words(rest);
        let lead = body.len() - body.trim_start().len();
        let cues: Vec<Cue> = cues
            .into_iter()
            .map(|c| Cue {
                byte_start: c.byte_start - lead,
                byte_end: c.byte_end - lead,
                ..c
            })
            .collect();
        let text = body.trim().to_owned();
        for s in starts {
            lines.push(Line {
                start: Some(s),
                end: None,
                text: text.clone(),
                agent_id: None,
                cues: cues.iter().map(|c| shifted(c, s, cues[0].start)).collect(),
            });
        }
    }
    if lines.iter().any(|l| l.start.is_some()) {
        lines.retain(|l| l.start.is_some());
        lines.sort_by_key(|l| l.start);
        let starts: Vec<Option<i64>> = lines.iter().map(|l| l.start).collect();
        for (i, l) in lines.iter_mut().enumerate() {
            l.end = starts.get(i + 1).copied().flatten();
            let end = l.end.or(l.start).unwrap_or(0);
            for c in &mut l.cues {
                if c.end < c.start {
                    c.end = end.max(c.start);
                }
            }
        }
        for b in &mut bg {
            b.end = lines
                .iter()
                .find(|l| l.start == b.start)
                .and_then(|l| l.end);
        }
    } else {
        bg.clear();
    }
    out.doc = Doc {
        agents: vec![main_agent()],
        lines,
        bg,
    };
    if !out.doc.bg.is_empty() {
        out.doc.agents.push(Agent {
            id: "bg".into(),
            role: "bg".into(),
            name: None,
        });
    }
    out
}

/// A repeated line (several tags) keeps its word times relative to its first word.
fn shifted(c: &Cue, start: i64, first: i64) -> Cue {
    let d = start - first;
    Cue {
        start: c.start + d,
        end: if c.end == i64::MIN { c.end } else { c.end + d },
        ..c.clone()
    }
}

fn stamp(ms: i64, open: char, close: char) -> String {
    let ms = ms.max(0);
    format!(
        "{open}{:02}:{:02}.{:02}{close}",
        ms / 60_000,
        ms / 1000 % 60,
        ms % 1000 / 10
    )
}

/// The LRC text of a document: enhanced (word tags) when `enhanced`, else one tag per line. `offset_ms` is
/// written as `[offset:]` when it is not zero. A document with no timing is its plain text.
pub fn to_lrc(doc: &Doc, offset_ms: i32, enhanced: bool) -> String {
    let mut out = String::new();
    if offset_ms != 0 {
        out.push_str(&format!("[offset:{offset_ms}]\n"));
    }
    for l in &doc.lines {
        let Some(start) = l.start else {
            out.push_str(&l.text);
            out.push('\n');
            continue;
        };
        out.push_str(&stamp(start, '[', ']'));
        if enhanced && !l.cues.is_empty() {
            let mut at = 0;
            for c in &l.cues {
                out.push_str(&l.text[at..c.byte_start.min(l.text.len())]);
                out.push_str(&stamp(c.start, '<', '>'));
                out.push_str(&l.text[c.byte_start.min(l.text.len())..c.byte_end.min(l.text.len())]);
                at = c.byte_end.min(l.text.len());
            }
            if let Some(last) = l.cues.last() {
                out.push_str(&stamp(last.end, '<', '>'));
            }
            out.push_str(&l.text[at..]);
        } else {
            out.push_str(&l.text);
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::{Format, Sync, parse as parse_any};

    #[test]
    fn line_tags_offset_and_repeats() {
        let p = parse_any(
            Format::Lrc,
            "[ti:Night]\n[ar:Ana]\n[offset:+250]\n[lang:FR]\n[00:12.5]one\n[00:01.000][00:20.00]two\n\n[00:30.00]",
        )
        .unwrap();
        assert_eq!(p.sync, Sync::Line);
        assert_eq!((p.offset_ms, p.lang.as_deref()), (250, Some("fr")));
        assert_eq!(p.title.as_deref(), Some("Night"));
        let starts: Vec<_> = p
            .doc
            .lines
            .iter()
            .map(|l| (l.start, l.text.as_str()))
            .collect();
        assert_eq!(
            starts,
            [
                (Some(1000), "two"),
                (Some(12500), "one"),
                (Some(20000), "two"),
                (Some(30000), "")
            ]
        );
        assert_eq!(p.doc.lines[1].end, Some(20000));
    }

    #[test]
    fn word_tags_make_cues_with_byte_ranges() {
        let p = parse_any(
            Format::Elrc,
            "[00:12.00] <00:12.00>caf\u{e9} <00:12.40>noir <00:13.10>\n[00:14.00]<00:14.00>x",
        )
        .unwrap();
        assert_eq!(p.sync, Sync::Word);
        let l = &p.doc.lines[0];
        assert_eq!(l.text, "caf\u{e9} noir");
        let c: Vec<_> = l
            .cues
            .iter()
            .map(|c| (c.start, c.end, c.byte_start, c.byte_end))
            .collect();
        assert_eq!(c, [(12000, 12400, 0, 5), (12400, 13100, 6, 10)]);
        assert_eq!(&l.text[6..10], "noir");
        // An unclosed last word ends with its line.
        assert_eq!(p.doc.lines[1].cues[0].end, 14000);
    }

    #[test]
    fn a_background_line_follows_its_line_and_a_timeless_text_is_plain() {
        let p = parse_any(Format::Lrc, "[00:01.00]main\n[bg:oh oh]\n[00:05.00]next").unwrap();
        assert_eq!(
            (p.doc.bg.len(), p.doc.bg[0].start, p.doc.bg[0].end),
            (1, Some(1000), Some(5000))
        );
        let p = parse_any(Format::Lrc, "just\ntext").unwrap();
        assert_eq!(p.sync, Sync::None);
    }

    #[test]
    fn writing_then_reading_keeps_the_words() {
        let src = "[00:12.00]<00:12.00>la <00:12.40>la<00:13.10>\n[00:14.00]plain";
        let p = parse_any(Format::Elrc, src).unwrap();
        let text = super::to_lrc(&p.doc, 0, true);
        assert_eq!(parse_any(Format::Elrc, &text).unwrap().doc, p.doc);
        assert!(!super::to_lrc(&p.doc, 100, false).contains('<'));
    }
}

//! TTML as Apple-style lyrics: `p` lines, timed `span` words, `ttm:agent` voices and `x-bg` spans. A DTD is refused.
use super::{Agent, Cue, Doc, Line, Parsed, main_agent};
use crate::livetv::xmltv::decode_xml_text;
use quick_xml::{
    Reader,
    events::{BytesStart, Event},
};

/// `h:mm:ss.fff`, `mm:ss.fff`, `12.5s` or `300ms` in milliseconds.
fn clock(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Some(v) = s.strip_suffix("ms") {
        return v.parse::<f64>().ok().map(|v| v.round() as i64);
    }
    if let Some(v) = s.strip_suffix('s') {
        return v.parse::<f64>().ok().map(|v| (v * 1000.0).round() as i64);
    }
    let parts: Vec<&str> = s.split(':').collect();
    let secs: f64 = parts.last()?.parse().ok()?;
    let mut ms = (secs * 1000.0).round() as i64;
    let mut unit = 60_000;
    for p in parts[..parts.len() - 1].iter().rev() {
        ms += p.parse::<i64>().ok()? * unit;
        unit *= 60;
    }
    (parts.len() <= 3 && ms >= 0).then_some(ms)
}

fn attr(e: &BytesStart<'_>, name: &str) -> Option<String> {
    e.attributes().with_checks(false).flatten().find_map(|a| {
        let key: &str = a.key.as_ref();
        (key.rsplit(':').next() == Some(name)).then(|| decode_xml_text(&a.value))
    })
}

#[derive(Default)]
struct Pending {
    start: Option<i64>,
    end: Option<i64>,
    agent: Option<String>,
    text: String,
    cues: Vec<Cue>,
}

pub(super) fn parse(xml: &str) -> Result<Parsed, String> {
    let mut r = Reader::from_str(xml);
    let mut agents: Vec<Agent> = vec![];
    let mut lines: Vec<Line> = vec![];
    let mut bg: Vec<Line> = vec![];
    let mut lang = None;
    let mut line: Option<Pending> = None;
    // The open span: (start, end, background, text so far).
    let mut span: Option<(Option<i64>, Option<i64>, bool, String)> = None;
    let mut root = false;
    loop {
        match r.read_event().map_err(|e| e.to_string())? {
            Event::DocType(_) => return Err("DTD refused".into()),
            Event::Eof => break,
            Event::Start(e) | Event::Empty(e) => {
                let name = e.local_name().as_ref().to_owned();
                match name.as_str() {
                    "tt" => {
                        root = true;
                        lang = attr(&e, "lang").map(|l| l.to_lowercase());
                    }
                    "agent" => {
                        if let Some(id) = attr(&e, "id") {
                            let role = if agents.is_empty() { "main" } else { "voice" };
                            agents.push(Agent {
                                id,
                                role: role.into(),
                                name: None,
                            });
                        }
                    }
                    "p" => {
                        line = Some(Pending {
                            start: attr(&e, "begin").and_then(|b| clock(&b)),
                            end: attr(&e, "end").and_then(|b| clock(&b)),
                            agent: attr(&e, "agent"),
                            ..Pending::default()
                        });
                    }
                    "span" if line.is_some() && span.is_none() => {
                        let bgs = attr(&e, "role").is_some_and(|r| r == "x-bg");
                        span = Some((
                            attr(&e, "begin").and_then(|b| clock(&b)),
                            attr(&e, "end").and_then(|b| clock(&b)),
                            bgs,
                            String::new(),
                        ));
                    }
                    "br" => {
                        if let Some(l) = line.as_mut() {
                            l.text.push(' ');
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(t) => push_text(&mut line, &mut span, &t),
            Event::CData(t) => push_text(&mut line, &mut span, &t),
            Event::GeneralRef(t) => push_text(
                &mut line,
                &mut span,
                &decode_xml_text(&format!("&{};", &*t)),
            ),
            Event::End(e) => match e.local_name().as_ref() {
                "span" => {
                    if let (Some((start, end, background, text)), Some(l)) =
                        (span.take(), line.as_mut())
                    {
                        if background {
                            let t = text.trim().trim_matches(['(', ')']).trim().to_owned();
                            if !t.is_empty() {
                                bg.push(Line {
                                    start: start.or(l.start),
                                    end: end.or(l.end),
                                    text: t,
                                    agent_id: Some("bg".into()),
                                    ..Line::default()
                                });
                            }
                        } else {
                            let from = l.text.len();
                            l.text.push_str(&text);
                            let seg = &l.text[from..];
                            let lead = seg.len() - seg.trim_start().len();
                            let to = from + seg.trim_end().len();
                            if let (Some(s), true) = (start, from + lead < to) {
                                l.cues.push(Cue {
                                    start: s,
                                    end: end.unwrap_or(s).max(s),
                                    byte_start: from + lead,
                                    byte_end: to,
                                    agent_id: None,
                                    pitch: None,
                                });
                            }
                        }
                    }
                }
                "p" => {
                    if let Some(l) = line.take() {
                        let lead = l.text.len() - l.text.trim_start().len();
                        let text = l.text.trim().to_owned();
                        let cues = l
                            .cues
                            .into_iter()
                            .filter(|c| c.byte_start >= lead && c.byte_end - lead <= text.len())
                            .map(|c| Cue {
                                byte_start: c.byte_start - lead,
                                byte_end: c.byte_end - lead,
                                agent_id: l.agent.clone(),
                                ..c
                            })
                            .collect::<Vec<_>>();
                        let start = l.start.or_else(|| cues.first().map(|c| c.start));
                        lines.push(Line {
                            start,
                            end: l.end.or_else(|| cues.last().map(|c| c.end)),
                            text,
                            agent_id: l.agent,
                            cues,
                        });
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    if !root {
        return Err("not a TTML document".into());
    }
    if lines.iter().any(|l| l.start.is_none()) {
        lines.iter_mut().for_each(|l| {
            l.start = None;
            l.end = None;
            l.cues.clear();
        });
        bg.clear();
    } else {
        lines.sort_by_key(|l| l.start);
    }
    if agents.is_empty() {
        agents.push(main_agent());
    }
    if !bg.is_empty() {
        agents.push(Agent {
            id: "bg".into(),
            role: "bg".into(),
            name: None,
        });
    }
    Ok(Parsed {
        doc: Doc { agents, lines, bg },
        lang,
        ..Parsed::default()
    })
}

fn push_text(
    line: &mut Option<Pending>,
    span: &mut Option<(Option<i64>, Option<i64>, bool, String)>,
    t: &str,
) {
    match (span.as_mut(), line.as_mut()) {
        (Some(s), _) => s.3.push_str(t),
        (None, Some(l)) => l.text.push_str(t),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Format, Sync, parse};

    const DOC: &str = r#"<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="fr">
<head><metadata><ttm:agent xml:id="v1" type="person"/><ttm:agent xml:id="v2" type="person"/></metadata></head>
<body><div>
<p begin="0:12.000" end="0:14.000" ttm:agent="v1"><span begin="12.0s" end="12.5s">Hello</span> <span begin="12.5s" end="14s">world</span><span ttm:role="x-bg" begin="13s" end="14s">(oh)</span></p>
<p begin="00:00:15.000" end="00:00:17.000" ttm:agent="v2">Plain line</p>
</div></body></tt>"#;

    #[test]
    fn spans_agents_and_background() {
        let p = parse(Format::Ttml, DOC).unwrap();
        assert_eq!((p.sync, p.lang.as_deref()), (Sync::Word, Some("fr")));
        assert_eq!(p.doc.agents.len(), 3);
        let l = &p.doc.lines[0];
        assert_eq!(
            (l.text.as_str(), l.start, l.agent_id.as_deref()),
            ("Hello world", Some(12000), Some("v1"))
        );
        let c: Vec<_> = l
            .cues
            .iter()
            .map(|c| (c.start, c.end, c.byte_start, c.byte_end))
            .collect();
        assert_eq!(c, [(12000, 12500, 0, 5), (12500, 14000, 6, 11)]);
        assert_eq!(p.doc.bg[0].text, "oh");
        assert_eq!(p.doc.lines[1].start, Some(15000));
    }

    #[test]
    fn a_dtd_or_a_foreign_root_is_refused() {
        assert!(parse(Format::Ttml, "<!DOCTYPE x [<!ENTITY a \"b\">]><tt/>").is_err());
        assert!(parse(Format::Ttml, "<html><p>x</p></html>").is_err());
    }
}

//! UltraStar `.txt`: syllable notes become word cues with a MIDI pitch, `P1`/`P2` become agents.
use super::{Agent, Cue, Doc, Line, Parsed, main_agent};

/// An UltraStar file carries a `#BPM:` header.
pub(super) fn looks_like(text: &str) -> bool {
    text.lines()
        .any(|l| l.get(..5).is_some_and(|h| h.eq_ignore_ascii_case("#BPM:")))
}

struct Open {
    text: String,
    cues: Vec<Cue>,
    agent: &'static str,
}

fn flush(open: &mut Option<Open>, lines: &mut Vec<Line>) {
    let Some(o) = open.take() else { return };
    let text = o.text.trim_end().to_owned();
    let cues: Vec<Cue> = o
        .cues
        .into_iter()
        .filter(|c| c.byte_start < text.len())
        .map(|mut c| {
            c.byte_end = c.byte_end.min(text.len());
            c
        })
        .collect();
    if cues.is_empty() {
        return;
    }
    lines.push(Line {
        start: cues.first().map(|c| c.start),
        end: cues.last().map(|c| c.end),
        text,
        agent_id: Some(o.agent.into()),
        cues,
    });
}

pub(super) fn parse(text: &str) -> Result<Parsed, String> {
    let (mut bpm, mut gap) = (0f64, 0f64);
    let (mut title, mut artist) = (None, None);
    let mut lines = vec![];
    let mut open: Option<Open> = None;
    let mut player: &'static str = "v1";
    let mut duet = false;
    let mut notes = vec![];
    for raw in text.lines() {
        if let Some(h) = raw.strip_prefix('#') {
            let (k, v) = h.split_once(':').unwrap_or((h, ""));
            let v = v.trim();
            match k.to_ascii_uppercase().as_str() {
                "BPM" => bpm = v.replace(',', ".").parse().map_err(|_| "bad BPM")?,
                "GAP" => gap = v.replace(',', ".").parse().unwrap_or(0.0),
                "RELATIVE" if v.eq_ignore_ascii_case("yes") => {
                    return Err("relative UltraStar not supported".into());
                }
                "TITLE" => title = Some(v.to_owned()),
                "ARTIST" => artist = Some(v.to_owned()),
                _ => {}
            }
        } else {
            notes.push(raw);
        }
    }
    if bpm <= 0.0 {
        return Err("no BPM".into());
    }
    let ms = |beat: i64| (gap + beat as f64 * 15_000.0 / bpm).round() as i64;
    for raw in notes {
        let kind = raw.chars().next().unwrap_or(' ');
        match kind {
            'E' => break,
            'P' => {
                flush(&mut open, &mut lines);
                player = if raw.trim() == "P2" { "v2" } else { "v1" };
                duet |= player == "v2";
            }
            '-' => flush(&mut open, &mut lines),
            ':' | '*' | 'F' | 'R' | 'G' => {
                let mut it = raw[1..].trim_start_matches(' ').splitn(4, ' ');
                let (Some(s), Some(d), Some(p), syl) = (
                    it.next().and_then(|v| v.parse::<i64>().ok()),
                    it.next().and_then(|v| v.parse::<i64>().ok()),
                    it.next().and_then(|v| v.parse::<i32>().ok()),
                    it.next().unwrap_or(""),
                ) else {
                    continue;
                };
                let (start, end) = (ms(s), ms(s + d.max(1)));
                let o = open.get_or_insert(Open {
                    text: String::new(),
                    cues: vec![],
                    agent: player,
                });
                if syl.trim() == "~" {
                    if let Some(c) = o.cues.last_mut() {
                        c.end = end;
                    }
                    continue;
                }
                let from = o.text.len();
                o.text.push_str(syl);
                let lead = syl.len() - syl.trim_start().len();
                let to = from + syl.trim_end().len();
                if from + lead >= to {
                    continue;
                }
                o.cues.push(Cue {
                    start,
                    end,
                    byte_start: from + lead,
                    byte_end: to,
                    agent_id: Some(o.agent.to_owned()),
                    pitch: (kind != 'F' && kind != 'R').then(|| (60 + p) as f32),
                    golden: kind == '*' || kind == 'G',
                });
            }
            _ => {}
        }
    }
    flush(&mut open, &mut lines);
    let mut agents = vec![main_agent()];
    if duet {
        agents.push(Agent {
            id: "v2".into(),
            role: "voice".into(),
            name: None,
        });
    }
    Ok(Parsed {
        doc: Doc {
            agents,
            lines,
            bg: vec![],
        },
        title,
        artist,
        ..Parsed::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SONG: &str = "#TITLE:T\n#ARTIST:A\n#BPM:120\n#GAP:1000\nP1\n: 0 4 0 Hel\n* 4 4 2 lo \n: 8 4 4 world\n- 16\nP2\nF 16 4 0 la\n: 20 2 -1 ~\nE\n";

    #[test]
    fn notes_become_cues() {
        assert!(looks_like(SONG));
        let p = parse(SONG).unwrap();
        assert_eq!(
            (p.title.as_deref(), p.artist.as_deref()),
            (Some("T"), Some("A"))
        );
        assert_eq!(p.doc.agents.len(), 2);
        let l = &p.doc.lines[0];
        assert_eq!(l.text, "Hello world");
        assert_eq!((l.start, l.end), (Some(1000), Some(2500)));
        assert_eq!(l.cues[1].pitch, Some(62.0));
        assert!(l.cues[1].golden && !l.cues[0].golden);
        assert_eq!(&l.text[l.cues[1].byte_start..l.cues[1].byte_end], "lo");
        let l2 = &p.doc.lines[1];
        assert_eq!(l2.agent_id.as_deref(), Some("v2"));
        assert_eq!(l2.cues[0].pitch, None);
        assert_eq!(l2.cues[0].end, 1000 + 22 * 125);
    }

    #[test]
    fn refuses_relative() {
        assert!(parse("#BPM:100\n#RELATIVE:YES\n: 0 1 0 a\n").is_err());
    }
}

//! UltraStar `.txt`: syllable notes become word cues with a MIDI pitch, `P1`/`P2` become agents.
use super::{Agent, Cue, CueNote, Doc, Line, Parsed, main_agent, main_pitch};

/// An UltraStar file carries a `#BPM:` header.
pub(super) fn looks_like(text: &str) -> bool {
    text.lines()
        .any(|l| l.get(..5).is_some_and(|h| h.eq_ignore_ascii_case("#BPM:")))
}

/// The `#VOCALS` and `#INSTRUMENTAL` file names of an UltraStar text, when it is one.
pub(super) fn stems(text: &str) -> Option<(Option<String>, Option<String>)> {
    if !looks_like(text) {
        return None;
    }
    let header = |key: &str| {
        text.lines()
            .filter_map(|l| l.strip_prefix('#')?.split_once(':'))
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    };
    Some((header("VOCALS"), header("INSTRUMENTAL")))
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
                let pitch = (kind != 'F' && kind != 'R').then(|| (60 + p) as f32);
                if syl.trim() == "~" {
                    if let Some(c) = o.cues.last_mut() {
                        if let Some(pitch) = pitch {
                            if let (true, Some(first)) = (c.notes.is_empty(), c.pitch) {
                                let (start, end) = (c.start, c.end);
                                c.notes.push(CueNote {
                                    start,
                                    end,
                                    pitch: first,
                                });
                            }
                            c.notes.push(CueNote { start, end, pitch });
                            c.pitch = main_pitch(&c.notes);
                        }
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
                    pitch,
                    notes: vec![],
                    golden: kind == '*' || kind == 'G',
                });
            }
            _ => {}
        }
    }
    flush(&mut open, &mut lines);
    lines.sort_by_key(|l| l.start);
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
        assert_eq!(l2.cues[0].pitch, Some(59.0));
        assert_eq!(l2.cues[0].end, 1000 + 22 * 125);
    }

    #[test]
    fn a_duet_file_is_sorted_and_a_shared_line_keeps_both_copies() {
        let p = parse(
            "#BPM:120\n#GAP:0\nP1\n: 0 4 0 la\n- 8\n: 16 4 2 lo\n- 24\nP2\n: 8 4 5 li\n- 12\n: 16 4 9 lo\nE\n",
        )
        .unwrap();
        let l: Vec<_> = p
            .doc
            .lines
            .iter()
            .map(|l| (l.start, l.agent_id.as_deref(), l.cues[0].pitch))
            .collect();
        assert_eq!(
            l,
            [
                (Some(0), Some("v1"), Some(60.0)),
                (Some(1000), Some("v2"), Some(65.0)),
                (Some(2000), Some("v1"), Some(62.0)),
                (Some(2000), Some("v2"), Some(69.0)),
            ]
        );
    }

    #[test]
    fn a_held_syllable_adds_a_note_to_its_cue() {
        let p = parse("#BPM:120\n#GAP:0\n: 0 4 0 Hel\n: 4 4 3 ~\n: 8 4 5 lo\nE\n").unwrap();
        let c = &p.doc.lines[0].cues;
        assert_eq!((c[0].pitch, c[0].end), (Some(60.0), 1000));
        assert_eq!(
            c[0].notes
                .iter()
                .map(|n| (n.start, n.end, n.pitch))
                .collect::<Vec<_>>(),
            [(0, 500, 60.0), (500, 1000, 63.0)]
        );
        assert!(c[1].notes.is_empty());
    }

    #[test]
    fn a_held_note_after_a_freestyle_syllable_is_kept_and_the_longest_is_the_pitch() {
        let p = parse("#BPM:120\n#GAP:0\nF 0 4 0 la\n: 4 8 3 ~\n: 12 2 5 ~\nE\n").unwrap();
        let c = &p.doc.lines[0].cues[0];
        assert_eq!(c.pitch, Some(63.0));
        assert_eq!(
            c.notes.iter().map(|n| (n.start, n.end)).collect::<Vec<_>>(),
            [(500, 1500), (1500, 1750)]
        );
        let p = parse("#BPM:120\n#GAP:0\n: 0 2 0 a\n: 2 6 3 ~\nE\n").unwrap();
        assert_eq!(p.doc.lines[0].cues[0].pitch, Some(63.0));
    }

    #[test]
    fn stem_headers() {
        let t = "#BPM:100\n#VOCALS:v.mp3\n#instrumental: i.ogg \n: 0 1 0 a\n";
        assert_eq!(stems(t), Some((Some("v.mp3".into()), Some("i.ogg".into()))));
        assert_eq!(stems("#VOCALS:v.mp3\n"), None);
    }

    #[test]
    fn refuses_relative() {
        assert!(parse("#BPM:100\n#RELATIVE:YES\n: 0 1 0 a\n").is_err());
    }
}

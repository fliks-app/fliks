//! The documents karaoke jobs read and write (`docs/spec/karaoke.md` rules 18, 19). Pure.
use super::{Cue, CueNote, Doc, Line, main_agent};

/// A word the engine timed, with its byte range in the request line's text.
pub struct Word {
    pub byte_start: usize,
    pub byte_end: usize,
    pub start: i64,
    pub end: i64,
}

/// A line the engine placed: `line` indexes the request lines.
pub struct Placed {
    pub line: usize,
    pub start: i64,
    pub end: i64,
    pub words: Vec<Word>,
}

/// An `Align` request line: the text, the known times and where it sits in the source document.
pub struct Request {
    pub text: String,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub source_line: usize,
}

/// The non-empty main lines of `doc`, in order; times only when every line has one.
pub fn align_request(doc: &Doc) -> Vec<Request> {
    let timed = doc.lines.iter().all(|l| l.start.is_some());
    doc.lines
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.text.trim().is_empty())
        .map(|(i, l)| Request {
            text: l.text.clone(),
            start: l.start.filter(|_| timed),
            end: l.end.filter(|_| timed),
            source_line: i,
        })
        .collect()
}

/// The word-synced document of an alignment. Cues keep ascending, char-aligned, non-overlapping byte
/// ranges inside their text (`to_lrc` slices on them): a word that breaks that is dropped.
pub fn from_alignment(src: &Doc, req: &[Request], placed: &[Placed]) -> Doc {
    let lines = placed
        .iter()
        .filter_map(|p| {
            let r = req.get(p.line)?;
            let agent_id = src.lines.get(r.source_line)?.agent_id.clone();
            let mut at = 0;
            let cues: Vec<Cue> = p
                .words
                .iter()
                .filter(|w| {
                    let ok = w.end >= w.start
                        && w.byte_start >= at
                        && r.text
                            .get(w.byte_start..w.byte_end)
                            .is_some_and(|t| !t.is_empty());
                    if ok {
                        at = w.byte_end;
                    }
                    ok
                })
                .map(|w| Cue {
                    start: w.start,
                    end: w.end,
                    byte_start: w.byte_start,
                    byte_end: w.byte_end,
                    agent_id: agent_id.clone(),
                    pitch: None,
                    notes: vec![],
                    golden: false,
                })
                .collect();
            (!cues.is_empty()).then(|| Line {
                start: Some(p.start),
                end: Some(p.end),
                text: r.text.clone(),
                agent_id,
                cues,
            })
        })
        .collect();
    let mut agents = src.agents.clone();
    if agents.is_empty() {
        agents.push(main_agent());
    }
    Doc {
        agents,
        lines,
        bg: vec![],
    }
}

/// The `(start, end)` of every line that has cues, in document order: from the line's start (or its
/// first cue) to its last cue, so a note sung off its word's timing is still found.
pub fn line_spans(doc: &Doc) -> Vec<(i64, i64)> {
    doc.lines
        .iter()
        .filter_map(|l| {
            let (first, last) = (l.cues.first()?, l.cues.last()?);
            let start = l.start.map_or(first.start, |s| s.min(first.start));
            let end = l.cues.iter().map(|c| c.end).max().unwrap_or(last.end);
            Some((start, end.max(start + 1)))
        })
        .collect()
}

/// A note `(start, end, midi)` found in a span.
pub type Note = (i64, i64, f64);

/// Writes the notes of each line (`notes[i]` is the span of the i-th line of `line_spans`) into its
/// cues: a note goes to the cue holding its midpoint, else the nearest. A cue's `pitch` is its longest
/// note, the earliest on a tie; both absent when it gets none.
pub fn apply_pitch(doc: &mut Doc, notes: &[Vec<Note>]) {
    let mut spans = notes.iter();
    for line in doc.lines.iter_mut().filter(|l| !l.cues.is_empty()) {
        let n = spans.next().map(Vec::as_slice).unwrap_or_default();
        for cue in &mut line.cues {
            cue.notes.clear();
        }
        for &(start, end, m) in n {
            let mid = (start + end) / 2;
            let off = |c: &Cue| (c.start - mid).max(mid - c.end).max(0);
            if let Some(c) = line.cues.iter_mut().min_by_key(|c| off(c)) {
                c.notes.push(CueNote {
                    start,
                    end,
                    pitch: m as f32,
                });
            }
        }
        for cue in &mut line.cues {
            cue.pitch = cue
                .notes
                .iter()
                .fold(None::<&CueNote>, |best, c| match best {
                    Some(b) if b.end - b.start >= c.end - c.start => Some(b),
                    _ => Some(c),
                })
                .map(|n| n.pitch);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Doc {
        Doc {
            agents: vec![main_agent()],
            lines: vec![
                Line {
                    start: Some(1000),
                    end: Some(3000),
                    text: "la la".into(),
                    ..Line::default()
                },
                Line {
                    start: Some(3000),
                    text: "  ".into(),
                    ..Line::default()
                },
                Line {
                    start: Some(4000),
                    text: "lo".into(),
                    ..Line::default()
                },
            ],
            bg: vec![],
        }
    }

    #[test]
    fn the_request_skips_blank_lines_and_keeps_times_only_when_complete() {
        let r = align_request(&doc());
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].start, r[1].source_line), (Some(1000), 2));
        let mut d = doc();
        d.lines[2].start = None;
        assert!(align_request(&d).iter().all(|r| r.start.is_none()));
    }

    #[test]
    fn an_alignment_becomes_cues_and_a_repeat_is_its_own_line() {
        let src = doc();
        let req = align_request(&src);
        let w = |a, b, s, e| Word {
            byte_start: a,
            byte_end: b,
            start: s,
            end: e,
        };
        let placed = vec![
            Placed {
                line: 0,
                start: 1000,
                end: 2000,
                words: vec![w(0, 2, 1000, 1400), w(3, 5, 1500, 2000)],
            },
            Placed {
                line: 0,
                start: 2000,
                end: 3000,
                words: vec![w(0, 2, 2000, 2400), w(3, 9, 2500, 3000)],
            },
            Placed {
                line: 1,
                start: 4000,
                end: 4500,
                words: vec![w(0, 2, 4000, 4500)],
            },
        ];
        let d = from_alignment(&src, &req, &placed);
        assert_eq!(d.lines.len(), 3);
        assert_eq!(d.lines[1].cues.len(), 1, "the out-of-range word is dropped");
        assert_eq!(d.lines[2].text, "lo");
        assert_eq!(super::super::sync_of(&d), super::super::Sync::Word);
    }

    #[test]
    fn a_note_goes_to_the_word_at_its_midpoint_and_the_longest_is_the_pitch() {
        let mut d = from_alignment(
            &doc(),
            &align_request(&doc()),
            &[Placed {
                line: 0,
                start: 0,
                end: 10,
                words: vec![
                    Word {
                        byte_start: 0,
                        byte_end: 2,
                        start: 0,
                        end: 5,
                    },
                    Word {
                        byte_start: 3,
                        byte_end: 5,
                        start: 5,
                        end: 10,
                    },
                ],
            }],
        );
        assert_eq!(line_spans(&d), [(0, 10)]);
        apply_pitch(&mut d, &[vec![(0, 2, 60.0), (2, 5, 62.5), (9, 14, 64.0)]]);
        let c = &d.lines[0].cues;
        assert_eq!((c[0].pitch, c[1].pitch), (Some(62.5), Some(64.0)));
        assert_eq!(
            c[0].notes
                .iter()
                .map(|n| (n.start, n.pitch))
                .collect::<Vec<_>>(),
            [(0, 60.0), (2, 62.5)]
        );
        assert_eq!(c[1].notes.len(), 1);
    }
}

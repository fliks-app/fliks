//! Rules of `music.md` (rules 32 and 33): which file belongs to which track, shared by the layout of a
//! scan and the merge of two editions.
use super::tags::TrackTags;

/// How far a file's length may be from its track's for a pairing by position or title.
pub const DURATION_TOLERANCE_MS: i32 = 3000;

/// What the pairing reads of a file or a track.
#[derive(Clone, Default)]
pub struct Key {
    recording: Option<String>,
    isrc: Option<String>,
    disc: i32,
    number: Option<i32>,
    duration_ms: Option<i32>,
    plain: String,
}

impl Key {
    pub fn new(
        (recording, isrc): (Option<String>, Option<String>),
        (disc, number): (i32, Option<i32>),
        duration_ms: Option<i32>,
        title: Option<&str>,
    ) -> Key {
        Key {
            recording,
            isrc,
            disc,
            number,
            duration_ms,
            plain: title.map(plain_title).unwrap_or_default(),
        }
    }

    pub fn of(t: &TrackTags) -> Key {
        Key::new(
            (t.recording.clone(), t.isrc.clone()),
            (t.disc_number(), t.track),
            t.duration_ms,
            t.title.as_deref(),
        )
    }

    /// Whether the lengths, when both are known, are within the tolerance.
    fn near(&self, o: &Key) -> bool {
        match (self.duration_ms, o.duration_ms) {
            (Some(a), Some(b)) => (a - b).abs() <= DURATION_TOLERANCE_MS,
            _ => true,
        }
    }

    /// The pass that pairs `self` with `o` (0 recording, 1 ISRC, 2 disc and number, 3 title), or `None`.
    /// An id only confirms a pair (a recording has several ISRCs, a merged recording another id);
    /// positions and titles need near lengths.
    fn rank(&self, o: &Key) -> Option<u8> {
        let same = |a: &Option<String>, b: &Option<String>| {
            a.as_ref()
                .zip(b.as_ref())
                .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
        };
        if same(&self.recording, &o.recording) {
            return Some(0);
        }
        if same(&self.isrc, &o.isrc) {
            return Some(1);
        }
        if !self.near(o) {
            return None;
        }
        if self.number.is_some() && (self.disc, self.number) == (o.disc, o.number) {
            return Some(2);
        }
        (!self.plain.is_empty() && self.plain == o.plain).then_some(3)
    }

    /// Whether the lengths allow the pairing, when no pass found one.
    pub fn compatible(&self, o: &Key) -> bool {
        self.near(o)
    }

    /// Whether some pass pairs the two.
    pub fn pairs(&self, o: &Key) -> bool {
        self.rank(o).is_some()
    }
}

/// For each file, the index of its track: every file takes part in a pass before the next pass starts.
pub fn assign(files: &[Key], tracks: &[Key]) -> Vec<Option<usize>> {
    let mut out = vec![None; files.len()];
    let mut taken = vec![false; tracks.len()];
    for pass in 0..4 {
        for (i, f) in files.iter().enumerate() {
            if out[i].is_some() {
                continue;
            }
            if let Some(j) =
                (0..tracks.len()).find(|j| !taken[*j] && f.rank(&tracks[*j]) == Some(pass))
            {
                out[i] = Some(j);
                taken[j] = true;
            }
        }
    }
    out
}

/// A title as the pairing compares it: lowercase letters and digits, parenthesised parts dropped.
fn plain_title(s: &str) -> String {
    let mut depth = 0;
    s.chars()
        .filter(|c| match c {
            '(' | '[' => {
                depth += 1;
                false
            }
            ')' | ']' => {
                depth = (depth - 1).max(0);
                false
            }
            _ => depth == 0 && c.is_alphanumeric(),
        })
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(title: &str, number: i32, ms: Option<i32>) -> Key {
        Key::new((None, None), (1, Some(number)), ms, Some(title))
    }

    fn with_ids(mut k: Key, recording: Option<&str>, isrc: Option<&str>) -> Key {
        k.recording = recording.map(str::to_owned);
        k.isrc = isrc.map(str::to_owned);
        k
    }

    #[test]
    fn a_file_of_another_length_does_not_pair_by_position_or_title() {
        let studio = key("Song", 3, Some(237_000));
        assert!(!key("Song", 3, Some(306_000)).pairs(&studio));
        assert!(key("Song", 3, Some(239_500)).pairs(&studio));
        assert!(key("Song", 3, Some(306_000)).pairs(&key("Song", 3, None)));
    }

    #[test]
    fn an_isrc_pairs_whatever_the_title_and_the_length() {
        let track = with_ids(key("Song", 3, Some(237_000)), None, Some("QZAAA2100001"));
        let file = with_ids(key("Other", 9, Some(10_000)), None, Some("qzaaa2100001"));
        assert!(file.pairs(&track));
    }

    #[test]
    fn another_isrc_or_recording_id_does_not_refuse_a_pair_by_position() {
        let track = with_ids(key("Song", 3, None), Some("a"), Some("QZAAA2100001"));
        let file = with_ids(key("Song", 3, None), Some("b"), Some("QZAAA2100002"));
        assert!(file.pairs(&track));
    }

    #[test]
    fn a_recording_id_wins_over_an_earlier_track_with_the_same_number() {
        let r3 = with_ids(key("Three", 3, None), Some("r3"), None);
        let r5 = with_ids(key("Five", 5, None), Some("r5"), None);
        let file = key("Five", 3, None);
        let tagged = with_ids(key("Five", 3, None), Some("r5"), None);
        let got = assign(&[file, tagged], &[r3, r5]);
        assert_eq!(got, vec![Some(0), Some(1)]);
    }
}

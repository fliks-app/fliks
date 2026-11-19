//! Rules of `music.md` (rules 32 and 33): which file belongs to which track, shared by the layout of a
//! scan and the merge of two editions.
use super::tags::TrackTags;

/// How far a file's length may be from its track's for a pairing by position or title.
pub const DURATION_TOLERANCE_MS: i32 = 3000;

/// What the pairing reads of a file or a track.
#[derive(Clone, Default)]
pub struct Key {
    pub recording: Option<String>,
    pub isrc: Option<String>,
    pub disc: i32,
    pub number: Option<i32>,
    pub duration_ms: Option<i32>,
    pub title: Option<String>,
}

impl Key {
    pub fn of(t: &TrackTags) -> Key {
        Key {
            recording: t.recording.clone(),
            isrc: t.isrc.clone(),
            disc: t.disc_number(),
            number: t.track,
            duration_ms: t.duration_ms,
            title: t.title.clone(),
        }
    }

    /// Whether the lengths, when both are known, are within the tolerance.
    pub fn near(&self, o: &Key) -> bool {
        match (self.duration_ms, o.duration_ms) {
            (Some(a), Some(b)) => (a - b).abs() <= DURATION_TOLERANCE_MS,
            _ => true,
        }
    }

    /// Whether nothing known contradicts the pairing: near lengths and no differing id.
    pub fn compatible(&self, o: &Key) -> bool {
        self.near(o)
            && ids_agree(&self.recording, &o.recording) != Some(false)
            && ids_agree(&self.isrc, &o.isrc) != Some(false)
    }

    /// The pass that pairs `self` with `o` (0 recording, 1 ISRC, 2 disc and number, 3 title), or `None`.
    /// An id known on both sides that differs rejects the pair; positions and titles need near lengths.
    fn rank(&self, o: &Key) -> Option<u8> {
        match ids_agree(&self.recording, &o.recording) {
            Some(true) => return Some(0),
            Some(false) => return None,
            None => {}
        }
        match ids_agree(&self.isrc, &o.isrc) {
            Some(true) => return Some(1),
            Some(false) => return None,
            None => {}
        }
        if !self.near(o) {
            return None;
        }
        if self.number.is_some() && (self.disc, self.number) == (o.disc, o.number) {
            return Some(2);
        }
        let (a, b) = (
            plain_title(self.title.as_deref()?),
            plain_title(o.title.as_deref()?),
        );
        (!a.is_empty() && a == b).then_some(3)
    }

    /// Whether some pass pairs the two.
    pub fn pairs(&self, o: &Key) -> bool {
        self.rank(o).is_some()
    }
}

/// Whether two ids agree, `None` when either is unknown.
fn ids_agree(a: &Option<String>, b: &Option<String>) -> Option<bool> {
    a.as_ref()
        .zip(b.as_ref())
        .map(|(a, b)| a.eq_ignore_ascii_case(b))
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
        Key {
            disc: 1,
            number: Some(number),
            duration_ms: ms,
            title: Some(title.into()),
            ..Default::default()
        }
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
        let mut track = key("Song", 3, Some(237_000));
        track.isrc = Some("QZAAA2100001".into());
        let file = Key {
            title: Some("Other".into()),
            isrc: Some("qzaaa2100001".into()),
            duration_ms: Some(10_000),
            ..Default::default()
        };
        assert!(file.pairs(&track));
    }

    #[test]
    fn a_known_id_that_differs_rejects_the_pair() {
        let mut track = key("Song", 3, None);
        track.recording = Some("a".into());
        let mut file = key("Song", 3, None);
        file.recording = Some("b".into());
        assert!(!file.pairs(&track));
    }

    #[test]
    fn a_recording_id_wins_over_an_earlier_track_with_the_same_number() {
        let mut r3 = key("Three", 3, None);
        r3.recording = Some("r3".into());
        let mut r5 = key("Five", 5, None);
        r5.recording = Some("r5".into());
        let mut file = key("Five", 3, None);
        file.recording = None;
        let mut tagged = key("Five", 3, None);
        tagged.recording = Some("r5".into());
        let got = assign(&[file, tagged], &[r3.clone(), r5.clone()]);
        assert_eq!(got, vec![Some(0), Some(1)]);
    }
}

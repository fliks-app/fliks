//! The distance between the tags of a folder and a release (`docs/spec/music.md`, section Identification):
//! weighted penalties, the tracks assigned by the Hungarian method.
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

const W_ARTIST: f64 = 3.0;
const W_ALBUM: f64 = 3.0;
const W_TRACK_TITLE: f64 = 3.0;
const W_TRACKS: f64 = 2.0;
const W_TRACK_ARTIST: f64 = 2.0;
const W_TRACK_LENGTH: f64 = 2.0;
const W_RECORDING: f64 = 10.0;
const W_DISCS: f64 = 1.0;
const W_MEDIA: f64 = 1.0;
const W_YEAR: f64 = 1.0;
const W_TRACK_INDEX: f64 = 1.0;
const W_UNMATCHED: f64 = 0.9;
const W_MISSING: f64 = 0.6;
const W_COUNTRY: f64 = 0.5;
const W_LABEL: f64 = 0.5;
const W_CATALOG: f64 = 0.5;
/// A length gap of this many seconds or more is a full penalty.
const LENGTH_SPAN_S: f64 = 10.0;
/// A pair of tracks further than this is the worst track of the album.
pub const WORST_TRACK: f64 = 0.4;
/// The Hungarian method is cubic: a larger album is assigned greedily.
const EXACT_LIMIT: usize = 400;

/// The thresholds and the pressing preferences of a library, from the settings.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    /// The largest distance applied without asking (0.10: 90 % alike).
    pub auto: f64,
    /// The largest distance worth a review (0.20: 80 % alike).
    pub review: f64,
    /// Preferred release countries and media, best first, lower-case media.
    pub countries: Vec<String>,
    pub media: Vec<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self::from_percent(90.0, 80.0, vec![], vec![])
    }
}

impl Config {
    /// Similarities in percent; the review threshold never rises above the automatic one.
    pub fn from_percent(
        auto: f64,
        review: f64,
        countries: Vec<String>,
        media: Vec<String>,
    ) -> Self {
        let dist = |p: f64| (1.0 - p.clamp(0.0, 100.0) / 100.0).clamp(0.0, 1.0);
        let auto = dist(auto);
        Self {
            auto,
            review: dist(review).max(auto),
            countries: countries.into_iter().map(|c| c.to_uppercase()).collect(),
            media: media.into_iter().map(|m| m.to_lowercase()).collect(),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct LocalTrack {
    pub title: String,
    pub artist: String,
    pub disc: Option<i32>,
    pub number: Option<i32>,
    pub duration_ms: Option<i32>,
    pub recording: Option<String>,
}

/// What the files of a folder say about their album.
#[derive(Debug, Clone, Default)]
pub struct Local {
    pub album: String,
    pub artist: String,
    pub year: Option<i32>,
    pub media: Option<String>,
    pub label: Option<String>,
    pub catalog: Option<String>,
    pub discs: Option<i32>,
    pub tracks: Vec<LocalTrack>,
}

#[derive(Debug, Clone, Default)]
pub struct RemoteTrack {
    pub title: String,
    pub artist: String,
    pub disc: Option<i32>,
    pub number: Option<i32>,
    pub duration_ms: Option<i32>,
    pub recording: Option<String>,
}

/// A release of a provider, with its tracklist.
#[derive(Debug, Clone, Default)]
pub struct Remote {
    pub album: String,
    pub artist: String,
    pub year: Option<i32>,
    pub country: Option<String>,
    pub media: Option<String>,
    pub label: Option<String>,
    pub catalog: Option<String>,
    pub discs: Option<i32>,
    pub tracks: Vec<RemoteTrack>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Auto,
    Review,
    Reject,
}

#[derive(Debug, Clone)]
pub struct Scored {
    /// 0 is the same release, 1 has nothing in common.
    pub distance: f64,
    pub worst_track: f64,
    /// For each local track, the index of the remote track it was assigned to.
    pub assignment: Vec<Option<usize>>,
}

impl Scored {
    pub fn similarity(&self) -> f64 {
        1.0 - self.distance
    }

    /// A worst track too far from its match keeps an otherwise close album in review.
    pub fn verdict(&self, cfg: &Config) -> Verdict {
        if self.distance <= cfg.auto && self.worst_track <= WORST_TRACK {
            Verdict::Auto
        } else if self.distance <= cfg.review {
            Verdict::Review
        } else {
            Verdict::Reject
        }
    }
}

/// Lower case without accents or punctuation, `&` read as `and`, one space between words.
pub fn normalize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.nfkd().filter(|c| !is_combining_mark(*c)) {
        if c == '&' {
            out.push_str(" and ");
        } else if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else {
            out.push(' ');
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            cur.push(
                (prev[j] + usize::from(ca != cb))
                    .min(prev[j + 1] + 1)
                    .min(cur[j] + 1),
            );
        }
        prev = cur;
    }
    prev[b.len()]
}

/// 0 for the same text once normalised, 1 for none in common.
pub fn text_distance(a: &str, b: &str) -> f64 {
    let (a, b): (Vec<char>, Vec<char>) = (
        normalize(a).chars().collect(),
        normalize(b).chars().collect(),
    );
    let longest = a.len().max(b.len());
    if longest == 0 {
        return 0.0;
    }
    levenshtein(&a, &b) as f64 / longest as f64
}

/// Weighted penalties: the distance is their weighted mean.
#[derive(Default)]
struct Penalties(Vec<(f64, f64)>);

impl Penalties {
    fn add(&mut self, weight: f64, penalty: f64) {
        self.0.push((weight, penalty.clamp(0.0, 1.0)));
    }

    fn text(&mut self, weight: f64, a: &str, b: &str) {
        self.add(weight, text_distance(a, b));
    }

    fn distance(&self) -> f64 {
        let max: f64 = self.0.iter().map(|(w, _)| w).sum();
        if max == 0.0 {
            return 0.0;
        }
        self.0.iter().map(|(w, p)| w * p).sum::<f64>() / max
    }
}

pub fn track_distance(l: &LocalTrack, r: &RemoteTrack) -> f64 {
    let mut p = Penalties::default();
    p.text(W_TRACK_TITLE, &l.title, &r.title);
    if !l.artist.is_empty() && !r.artist.is_empty() {
        p.text(W_TRACK_ARTIST, &l.artist, &r.artist);
    }
    if let (Some(a), Some(b)) = (l.duration_ms, r.duration_ms) {
        p.add(
            W_TRACK_LENGTH,
            f64::from((a - b).abs()) / 1000.0 / LENGTH_SPAN_S,
        );
    }
    if let (Some(a), Some(b)) = (l.number, r.number) {
        p.add(W_TRACK_INDEX, f64::from(a != b));
    }
    if let (Some(a), Some(b)) = (&l.recording, &r.recording) {
        p.add(W_RECORDING, f64::from(a != b));
    }
    p.distance()
}

/// The preferred entry's rank in `prefs`: 0 for the first, rising to 1 for one not listed.
fn preference(prefs: &[String], value: Option<&str>) -> Option<f64> {
    if prefs.is_empty() {
        return None;
    }
    let rank = value.and_then(|v| prefs.iter().position(|p| p.eq_ignore_ascii_case(v)));
    Some(rank.map_or(1.0, |i| i as f64 / prefs.len() as f64))
}

/// The minimum-cost assignment of `rows` to columns: `Some(column)` per row, at most one row per column.
/// The Hungarian method (shortest augmenting paths, O(n^3)) up to `EXACT_LIMIT`, greedy beyond.
pub fn assign(cost: &[Vec<f64>]) -> Vec<Option<usize>> {
    let (n, m) = (cost.len(), cost.first().map_or(0, Vec::len));
    if n == 0 || m == 0 {
        return vec![None; n];
    }
    if n.max(m) > EXACT_LIMIT {
        return greedy(cost);
    }
    // Square matrix padded with the worst cost, rows are 1-based in the potentials arrays.
    let size = n.max(m);
    let at = |i: usize, j: usize| if i < n && j < m { cost[i][j] } else { 1.0 };
    let (mut u, mut v) = (vec![0.0; size + 1], vec![0.0; size + 1]);
    let (mut p, mut way) = (vec![0usize; size + 1], vec![0usize; size + 1]);
    for i in 1..=size {
        p[0] = i;
        let mut j0 = 0;
        let mut minv = vec![f64::INFINITY; size + 1];
        let mut used = vec![false; size + 1];
        loop {
            used[j0] = true;
            let (i0, mut delta, mut j1) = (p[j0], f64::INFINITY, 0);
            for j in 1..=size {
                if used[j] {
                    continue;
                }
                let cur = at(i0 - 1, j - 1) - u[i0] - v[j];
                if cur < minv[j] {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if minv[j] < delta {
                    delta = minv[j];
                    j1 = j;
                }
            }
            for j in 0..=size {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        loop {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
            if j0 == 0 {
                break;
            }
        }
    }
    let mut out = vec![None; n];
    for j in 1..=size {
        if p[j] >= 1 && p[j] <= n && j <= m {
            out[p[j] - 1] = Some(j - 1);
        }
    }
    out
}

fn greedy(cost: &[Vec<f64>]) -> Vec<Option<usize>> {
    let mut cells: Vec<(f64, usize, usize)> = cost
        .iter()
        .enumerate()
        .flat_map(|(i, r)| r.iter().enumerate().map(move |(j, c)| (*c, i, j)))
        .collect();
    cells.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out = vec![None; cost.len()];
    let mut taken = vec![false; cost.first().map_or(0, Vec::len)];
    for (_, i, j) in cells {
        if out[i].is_none() && !taken[j] {
            (out[i], taken[j]) = (Some(j), true);
        }
    }
    out
}

/// The distance of `local` to `remote` and the tracks assigned between them.
pub fn score(local: &Local, remote: &Remote, cfg: &Config) -> Scored {
    let mut p = Penalties::default();
    p.text(W_ALBUM, &local.album, &remote.album);
    if !local.artist.is_empty() && !remote.artist.is_empty() {
        p.text(W_ARTIST, &local.artist, &remote.artist);
    }
    if let (Some(a), Some(b)) = (local.year, remote.year) {
        p.add(W_YEAR, f64::from((a - b).abs()) / 4.0);
    }
    match (&local.media, &remote.media) {
        (Some(a), Some(b)) => p.add(W_MEDIA, f64::from(!a.eq_ignore_ascii_case(b))),
        _ => {
            if let Some(pen) = preference(&cfg.media, remote.media.as_deref()) {
                p.add(W_MEDIA, pen);
            }
        }
    }
    if let (Some(a), Some(b)) = (local.discs, remote.discs) {
        p.add(W_DISCS, f64::from(a != b));
    }
    if let (Some(a), Some(b)) = (&local.label, &remote.label) {
        p.text(W_LABEL, a, b);
    }
    if let (Some(a), Some(b)) = (&local.catalog, &remote.catalog) {
        p.text(W_CATALOG, a, b);
    }
    if let Some(pen) = preference(&cfg.countries, remote.country.as_deref()) {
        p.add(W_COUNTRY, pen);
    }

    let cost: Vec<Vec<f64>> = local
        .tracks
        .iter()
        .map(|l| remote.tracks.iter().map(|r| track_distance(l, r)).collect())
        .collect();
    let assignment = assign(&cost);
    let mut worst: f64 = 0.0;
    for (i, j) in assignment.iter().enumerate() {
        if let Some(j) = j {
            p.add(W_TRACKS, cost[i][*j]);
            worst = worst.max(cost[i][*j]);
        }
    }
    let matched = assignment.iter().flatten().count();
    let ratio = |n: usize, of: usize| if of == 0 { 0.0 } else { n as f64 / of as f64 };
    p.add(
        W_UNMATCHED,
        ratio(local.tracks.len() - matched, local.tracks.len()),
    );
    p.add(
        W_MISSING,
        ratio(remote.tracks.len() - matched, remote.tracks.len()),
    );
    Scored {
        distance: p.distance(),
        worst_track: worst,
        assignment,
    }
}

/// The distance of the album and artist alone, to rank the hits of a search before any release is fetched.
pub fn album_distance(
    album: &str,
    artist: &str,
    year: Option<i32>,
    hit: (&str, &str, Option<i32>),
) -> f64 {
    let mut p = Penalties::default();
    p.text(W_ALBUM, album, hit.0);
    if !artist.is_empty() && !hit.1.is_empty() {
        p.text(W_ARTIST, artist, hit.1);
    }
    if let (Some(a), Some(b)) = (year, hit.2) {
        p.add(W_YEAR, f64::from((a - b).abs()) / 4.0);
    }
    p.distance()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lt(title: &str, number: i32, secs: i32) -> LocalTrack {
        LocalTrack {
            title: title.into(),
            number: Some(number),
            duration_ms: Some(secs * 1000),
            ..Default::default()
        }
    }

    fn rt(title: &str, number: i32, secs: i32) -> RemoteTrack {
        RemoteTrack {
            title: title.into(),
            number: Some(number),
            duration_ms: Some(secs * 1000),
            ..Default::default()
        }
    }

    fn release(titles: &[&str]) -> Remote {
        Remote {
            album: "Alpha".into(),
            artist: "Ana".into(),
            year: Some(1999),
            tracks: titles
                .iter()
                .enumerate()
                .map(|(i, t)| rt(t, i as i32 + 1, 200))
                .collect(),
            ..Default::default()
        }
    }

    fn folder(titles: &[&str]) -> Local {
        Local {
            album: "alpha".into(),
            artist: "ANA".into(),
            year: Some(1999),
            tracks: titles
                .iter()
                .enumerate()
                .map(|(i, t)| lt(t, i as i32 + 1, 200))
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn the_hungarian_method_finds_the_cheapest_pairing() {
        let cost = vec![
            vec![4.0, 1.0, 3.0],
            vec![2.0, 0.0, 5.0],
            vec![3.0, 2.0, 2.0],
        ];
        let total: f64 = assign(&cost)
            .iter()
            .enumerate()
            .map(|(i, j)| cost[i][j.unwrap()])
            .sum();
        assert_eq!(total, 5.0);
        // More local tracks than remote ones: one stays unassigned.
        let wide = vec![vec![0.0], vec![0.5], vec![0.2]];
        let got = assign(&wide);
        assert_eq!(got.iter().flatten().count(), 1);
        assert_eq!(got[0], Some(0));
        assert!(assign(&[]).is_empty());
    }

    #[test]
    fn an_album_in_another_order_is_still_the_same_release() {
        let titles = ["One", "Two", "Three"];
        let mut local = folder(&titles);
        local.tracks.reverse();
        for (i, t) in local.tracks.iter_mut().enumerate() {
            t.number = Some(3 - i as i32);
        }
        let s = score(&local, &release(&titles), &Config::default());
        assert!(s.distance < 0.01, "{}", s.distance);
        assert_eq!(s.verdict(&Config::default()), Verdict::Auto);
        assert_eq!(s.assignment, [Some(2), Some(1), Some(0)]);
    }

    #[test]
    fn a_missing_track_lowers_the_similarity_and_another_album_is_rejected() {
        let all = release(&["One", "Two", "Three", "Four"]);
        let s = score(&folder(&["One", "Two", "Three"]), &all, &Config::default());
        assert!(s.distance > 0.0 && s.similarity() > 0.85, "{}", s.distance);
        let other = Local {
            album: "Totally Else".into(),
            artist: "Zed".into(),
            year: Some(1980),
            ..folder(&["Nine", "Ten"])
        };
        assert_eq!(
            score(&other, &all, &Config::default()).verdict(&Config::default()),
            Verdict::Reject
        );
    }

    #[test]
    fn a_matching_recording_id_outweighs_a_retitled_track() {
        let id = Some("5b11f4ce-a62d-471e-81fc-a69a8278c7da".to_owned());
        let mut l = folder(&["Intro (remastered)"]);
        l.tracks[0].recording = id.clone();
        let mut r = release(&["Intro"]);
        r.tracks[0].recording = id;
        let with = score(&l, &r, &Config::default());
        l.tracks[0].recording = None;
        r.tracks[0].recording = None;
        assert!(with.distance < score(&l, &r, &Config::default()).distance + 0.001);
        assert!(with.worst_track < 0.2);
    }

    #[test]
    fn pressing_preferences_rank_two_releases_of_one_album() {
        let cfg = Config::from_percent(
            90.0,
            80.0,
            vec!["fr".into(), "us".into()],
            vec!["vinyl".into()],
        );
        let mut fr = release(&["One"]);
        fr.country = Some("FR".into());
        fr.media = Some("vinyl".into());
        let mut jp = release(&["One"]);
        jp.country = Some("JP".into());
        jp.media = Some("cd".into());
        let local = folder(&["One"]);
        assert!(score(&local, &fr, &cfg).distance < score(&local, &jp, &cfg).distance);
    }

    #[test]
    fn thresholds_are_similarities_and_never_cross() {
        let c = Config::from_percent(70.0, 90.0, vec![], vec![]);
        assert!((c.auto - 0.3).abs() < 1e-9 && c.review >= c.auto);
        assert_eq!(normalize("Beyoncé & Jay-Z!"), "beyonce and jay z");
        assert_eq!(text_distance("Café", "cafe"), 0.0);
    }

    #[test]
    fn a_far_track_keeps_a_close_album_in_review() {
        let mut local = folder(&[
            "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
        ]);
        local.tracks[0].title = "Zzzzzz".into();
        let remote = release(&[
            "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
        ]);
        let s = score(&local, &remote, &Config::default());
        assert!(s.worst_track > WORST_TRACK && s.distance <= Config::default().review);
        assert_eq!(s.verdict(&Config::default()), Verdict::Review);
    }
}

//! "More like this" scoring (`scoreSimilarity`, rule 55); float operations keep the TS order.
use std::collections::HashSet;

const W_KEYWORD: f64 = 1.6;
const KEYWORD_CAP: f64 = 4.8;
const W_GENRE: f64 = 2.5;
const W_DIRECTOR: f64 = 2.0;
const W_YEAR: f64 = 0.5;
const YEAR_SPAN: f64 = 20.0;
/// Below this a title only shares one broad genre.
pub const MIN_SCORE: f64 = 1.0;

#[derive(Debug, Clone, Copy, Default)]
pub struct Signals<'a> {
    pub genres: &'a [String],
    pub year: Option<i64>,
    pub keywords: &'a [String],
}

/// Entries of `b` whose lower-case is among the lower-cased `a` (duplicates of `b` counted).
pub fn shared_count(a: &[String], b: &[String]) -> usize {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let set: HashSet<String> = a.iter().map(|v| v.to_lowercase()).collect();
    b.iter().filter(|v| set.contains(&v.to_lowercase())).count()
}

/// Overlap normalised by both list lengths.
pub fn cosine_overlap(a: &[String], b: &[String]) -> f64 {
    match shared_count(a, b) {
        0 => 0.0,
        shared => shared as f64 / ((a.len() * b.len()) as f64).sqrt(),
    }
}

pub fn score_similarity(source: Signals, candidate: Signals, same_director: bool) -> f64 {
    let mut score = 0.0;
    let hits = shared_count(source.keywords, candidate.keywords);
    score += (hits as f64 * W_KEYWORD).min(KEYWORD_CAP);
    score += cosine_overlap(source.genres, candidate.genres) * W_GENRE;
    if same_director {
        score += W_DIRECTOR;
    }
    if let (Some(a), Some(b)) = (
        source.year.filter(|y| *y != 0),
        candidate.year.filter(|y| *y != 0),
    ) {
        let gap = (a - b).abs() as f64;
        score += (1.0 - gap / YEAR_SPAN).max(0.0) * W_YEAR;
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn two_keywords_beat_an_identical_genre_pair() {
        let g = v(&["Action", "Thriller"]);
        let k = v(&["heist", "dream"]);
        let src = Signals {
            genres: &g,
            year: Some(2010),
            keywords: &k,
        };
        let by_kw = Signals {
            genres: &[],
            year: Some(2010),
            keywords: &k,
        };
        let by_genre = Signals {
            genres: &g,
            year: Some(2010),
            keywords: &[],
        };
        assert!(score_similarity(src, by_kw, false) > score_similarity(src, by_genre, false));
    }
}

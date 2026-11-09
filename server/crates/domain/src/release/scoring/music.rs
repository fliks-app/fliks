//! Score, reject and sort the search hits of an album (`docs/spec/release.md`): the book pipeline plus the artist and the pack shape.
use super::book::{BookScoreOptions, Parsed, ScoredBookRelease, score_one};
use super::pipeline::{Blocked, FormatScore, ReleaseCandidate};
use super::rejection::ReleaseRejection;
use super::sort::sort_releases_by_relevance;
use super::titles::{
    WhenUnreadable, index_title_expectations, matches_indexed_expectation, release_title_tokens,
};
use crate::books::filename::BookNameGuess;
use crate::js::rx;
use crate::language::{AppLanguage, ENGLISH_LANGUAGE};
use crate::media::family::Family;
use crate::release::audio::music::parse_music_release;

/// What the search wants of an album besides its title.
#[derive(Debug, Clone, Default)]
pub struct MusicExpectation {
    /// The album artists' names: a release must name one of them.
    pub artists: Vec<String>,
    /// A discography pack is accepted (a want of the whole catalogue).
    pub allow_discography: bool,
}

/// A title naming no language has none: the parser's English default is a video convention.
fn stated_languages(title: &str, parsed: Vec<&'static AppLanguage>) -> Vec<&'static AppLanguage> {
    let says_english = rx!(i r"\b(english|eng)\b").is_match(title);
    if parsed.as_slice() == [ENGLISH_LANGUAGE] && !says_english {
        return Vec::new();
    }
    parsed
}

fn rej(code: &str) -> ReleaseRejection {
    ReleaseRejection {
        code: code.to_owned(),
        params: None,
    }
}

pub fn score_and_sort_music_releases(
    releases: Vec<ReleaseCandidate>,
    opts: &BookScoreOptions,
    want: &MusicExpectation,
    score_custom_formats: FormatScore,
    is_blocked: Blocked,
) -> Vec<ScoredBookRelease> {
    let artists = index_title_expectations(&want.artists);
    let rows = releases
        .into_iter()
        .map(|r| {
            let m = parse_music_release(&r.title);
            let p = Parsed {
                quality: m.audio.quality,
                languages: stated_languages(&r.title, m.audio.languages),
                retail: matches!(m.source, Some("cd" | "web")),
                names: BookNameGuess {
                    title: m.album.clone(),
                    year: m.year,
                    ..Default::default()
                },
                comic: None,
            };
            let named = matches_indexed_expectation(
                &release_title_tokens(&r.title),
                &artists,
                WhenUnreadable::Match,
            );
            let mut s = score_one(Family::Audio, r, p, opts, score_custom_formats, is_blocked);
            if !named {
                s.rejections.push(rej("ARTIST_MISMATCH"));
            }
            if m.discography && !want.allow_discography {
                s.rejections.push(rej("DISCOGRAPHY"));
            }
            s
        })
        .collect();
    sort_releases_by_relevance(rows, false)
}

#[cfg(test)]
mod language_tests {
    use super::*;

    #[test]
    fn music_default_english_is_unknown() {
        let parse = |t: &str| stated_languages(t, crate::release::book::parse_book_language(t));
        assert!(parse("Artist - Album (1985) [MP3 128]").is_empty());
        assert_eq!(parse("Artist - Album [English] [MP3 128]").len(), 1);
        assert!(!parse("Artist - Album [FR] [MP3 128]").is_empty());
    }
}

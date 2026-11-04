//! Release-name parsing and scoring (`docs/spec/release.md`).
pub mod audio;
pub mod book;
pub mod comic;
pub mod image;
pub mod parsing;
pub mod scene;
pub mod scoring;
pub mod text;

use crate::js::rx;
use crate::media::kind::MediaKind;

/// The media kinds a release name can be for; `None` when the name says nothing, any kind then fits.
pub fn fitting_kinds(title: &str, has_episode: bool) -> Option<&'static [MediaKind]> {
    let t = title.replace(['.', '_'], " ").to_lowercase();
    if has_episode
        || rx!(r"\b(?:2160p?|1080[pi]?|720p|480p|4k|uhd|blu-?ray|bdrip|brrip|web-?dl|web-?rip|hdtv|dvdrip|remux|x26[45]|hevc)\b")
            .is_match(&t)
    {
        return Some(&[MediaKind::Movie, MediaKind::Series]);
    }
    if rx!(r"\b(?:cbz|cbr|cb7)\b").is_match(&t) {
        return Some(&[MediaKind::Comic]);
    }
    if text::quality::parse_text_release(title).format.is_some()
        || audio::quality::parse_audio_release(title).format.is_some()
    {
        return Some(&[MediaKind::Book]);
    }
    comic::parse_comic_release(title)
        .number
        .map(|_| &[MediaKind::Comic][..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_release_name_picks_its_kind() {
        let kind = |t| fitting_kinds(t, false);
        assert_eq!(
            kind("Shared.Title.2021.2160p.WEB-DL.x265").unwrap()[0],
            MediaKind::Movie
        );
        assert_eq!(
            kind("Some Author - Shared Title (1965) [EPUB]"),
            Some(&[MediaKind::Book][..])
        );
        assert_eq!(
            kind("Shared Title 012 (2016) (digital).cbz"),
            Some(&[MediaKind::Comic][..])
        );
        assert_eq!(
            kind("Shared Title 012 (2016) (digital)"),
            Some(&[MediaKind::Comic][..])
        );
        assert_eq!(kind("Shared Title"), None);
    }
}

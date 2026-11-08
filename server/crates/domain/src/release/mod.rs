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
    if rx!(r"\b(?:cbz|cbr|cb7)\b").is_match(&t) {
        return Some(&[MediaKind::Comic]);
    }
    if has_episode {
        return Some(&[MediaKind::Series]);
    }
    if rx!(r"\b(?:2160p?|1080[pi]?|720p|576p|480p|360p|4k|8k|uhd|blu-?ray|bdrip|brrip|web-?dl|web-?rip|hdtv|hdrip|dvd(?:rip|r|scr)?|hdcam|telesync|remux|xvid|divx|av1|h ?26[45]|x26[45]|hevc)\b")
        .is_match(&t)
    {
        return Some(&[MediaKind::Movie, MediaKind::Series]);
    }
    let issue = comic::parse_comic_release(title).number.is_some();
    if issue && rx!(r"\bpdf\b").is_match(&t) {
        return Some(&[MediaKind::Comic, MediaKind::Book]);
    }
    let audio = audio::quality::parse_audio_release(title);
    let text = text::quality::parse_text_release(title);
    if audio.format.is_some() && text.format.is_none() {
        return Some(audio_kinds(&t, &audio));
    }
    if text.format.is_some() || audio.format.is_some() {
        return Some(&[MediaKind::Book]);
    }
    issue.then_some(&[MediaKind::Comic][..])
}

/// An audio release is an audiobook by its words (`audiobook`, `unabridged`, `.m4b`), music by its markers
/// (lossless, a source, a discography, MP3 V0 or 320), either when it says neither.
fn audio_kinds(t: &str, audio: &audio::quality::AudioRelease) -> &'static [MediaKind] {
    if audio.format == Some("m4b")
        || rx!(r"\b(?:audiobook|unabridged|abridged|narrated|read by)\b").is_match(t)
    {
        return &[MediaKind::Book];
    }
    let music = audio::music::parse_music_release(t);
    if audio.codec == Some("lossless")
        || music.source.is_some()
        || music.discography
        || matches!(audio.quality.id, 116 | 117)
    {
        return &[MediaKind::Album];
    }
    &[MediaKind::Book, MediaKind::Album]
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

    #[test]
    fn an_audio_release_is_music_an_audiobook_or_either() {
        let kind = |t| fitting_kinds(t, false);
        assert_eq!(
            kind("Cora Vell - Salt Meadows (2019) [FLAC]"),
            Some(&[MediaKind::Album][..])
        );
        assert_eq!(
            kind("Cora Vell - Salt Meadows [MP3 320]"),
            Some(&[MediaKind::Album][..])
        );
        assert_eq!(
            kind("Some Author - Shared Title (2020) [Audiobook] [MP3 128kbps]"),
            Some(&[MediaKind::Book][..])
        );
        assert_eq!(
            kind("Some Author - Shared Title [M4B]"),
            Some(&[MediaKind::Book][..])
        );
        assert_eq!(
            kind("Cora Vell - Salt Meadows [MP3 192kbps]"),
            Some(&[MediaKind::Book, MediaKind::Album][..])
        );
    }

    #[test]
    fn marker_edge_cases() {
        let kind = |t| fitting_kinds(t, false);
        let movie = Some(&[MediaKind::Movie, MediaKind::Series][..]);
        for t in [
            "Shared.Title.2021.WEB.H264-GRP",
            "Shared.Title.2005.XviD.MP3-GRP",
            "Shared.Title.2021.WEB.H264.AAC.2.0",
        ] {
            assert_eq!(kind(t), movie, "{t}");
        }
        assert_eq!(
            kind("Shared Title 001 (2016) (Webrip) (DCP).cbr"),
            Some(&[MediaKind::Comic][..])
        );
        assert_eq!(
            fitting_kinds("Shared.Title.S01E02.1080p", true),
            Some(&[MediaKind::Series][..])
        );
        assert_eq!(
            kind("Shared Title 012 (2016).pdf"),
            Some(&[MediaKind::Comic, MediaKind::Book][..])
        );
    }
}

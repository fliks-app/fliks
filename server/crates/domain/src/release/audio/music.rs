//! `parse_music_release`: the artist, album, year, source and pack shape of a music release name (`docs/spec/release.md`).
use super::quality::{AudioRelease, parse_audio_release};
use crate::js::rx;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicRelease {
    pub audio: AudioRelease,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<i32>,
    /// A discography, a collection or a multi-year run: more than one album.
    pub discography: bool,
    /// `web`, `cd` or `vinyl`.
    pub source: Option<&'static str>,
    pub tracks: Option<u32>,
}

fn source_of(t: &str) -> Option<&'static str> {
    [
        (
            rx!(r"\b(web|web-?dl|webrip|itunes|bandcamp|qobuz|tidal)\b"),
            "web",
        ),
        (rx!(r"\b(vinyl|lp|vinyl-?rip|24bit vinyl)\b"), "vinyl"),
        (rx!(r"\b(cd|cdda|cdr|cd-?rip)\b"), "cd"),
    ]
    .into_iter()
    .find(|(r, _)| r.is_match(t))
    .map(|(_, s)| s)
}

/// Words that end the album part of a scene name (`Artist-Album-WEB-2020-GRP`).
fn is_tag(w: &str) -> bool {
    let w = w.to_lowercase();
    matches!(
        w.as_str(),
        "web"
            | "cd"
            | "cdda"
            | "cdr"
            | "vinyl"
            | "lp"
            | "flac"
            | "mp3"
            | "aac"
            | "m4a"
            | "opus"
            | "ogg"
            | "v0"
            | "v2"
            | "320"
            | "256"
            | "192"
            | "128"
            | "16bit"
            | "24bit"
            | "single"
            | "ep"
            | "remastered"
    ) || (w.len() == 4 && w.bytes().all(|b| b.is_ascii_digit()))
}

fn clean(s: &str) -> Option<String> {
    let s = s.trim_matches(|c: char| c.is_whitespace() || "-_.,;".contains(c));
    (!s.is_empty()).then(|| s.to_owned())
}

/// `(artist, album)` of the name once its bracketed groups are gone.
fn names(title: &str) -> (Option<String>, Option<String>) {
    let bare = rx!(r"[\[\(\{][^\]\)\}]*[\]\)\}]").replace_all(title, " ");
    let spaced = if bare.contains(' ') {
        bare.into_owned()
    } else {
        bare.replace(['.', '_'], " ")
    };
    let parts: Vec<&str> = rx!(r"\s[-\u{2013}\u{2014}]\s").split(&spaced).collect();
    if parts.len() >= 2 {
        return (clean(parts[0]), clean(&parts[1..].join(" - ")));
    }
    let words: Vec<&str> = spaced.split('-').collect();
    let end = words
        .iter()
        .skip(1)
        .position(|w| is_tag(w.trim()))
        .map_or(words.len(), |p| p + 1);
    if end >= 2 {
        return (clean(words[0]), clean(&words[1..end].join(" ")));
    }
    (None, clean(&spaced))
}

pub fn parse_music_release(title: &str) -> MusicRelease {
    let audio = parse_audio_release(title);
    let t = title.replace(['.', '_'], " ").to_lowercase();
    let (artist, album) = names(title);
    let range = rx!(r"\b((?:19|20)\d{2})\s?-\s?((?:19|20)\d{2})\b").is_match(&t);
    let discography = range
        || rx!(
            r"\b(discograph(?:y|ie|ies)|complete (?:collection|albums|studio)|anthology|box ?set)\b"
        )
        .is_match(&t);
    let year =
        rx!(r"[\[\(\s-]((?:19|20)\d{2})[\]\)\s-]|[\[\(]((?:19|20)\d{2})[\]\)]|\b((?:19|20)\d{2})$")
            .captures(&t)
            .and_then(|c| (1..=3).find_map(|i| c.get(i)))
            .and_then(|m| m.as_str().parse().ok());
    let tracks = rx!(r"\b(\d{1,3}) ?(?:tracks?|trk|pistes)\b")
        .captures(&t)
        .and_then(|c| c[1].parse().ok());
    MusicRelease {
        audio,
        artist,
        album,
        year: year.filter(|_| !discography),
        discography,
        source: source_of(&t),
        tracks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_named_album_has_its_parts() {
        let r = parse_music_release("Cora Vell - Salt Meadows (2019) [FLAC 24-96] [WEB]");
        assert_eq!(r.artist.as_deref(), Some("Cora Vell"));
        assert_eq!(r.album.as_deref(), Some("Salt Meadows"));
        assert_eq!(
            (r.year, r.source, r.discography),
            (Some(2019), Some("web"), false)
        );
        assert_eq!((r.audio.quality.id, r.audio.bit_depth), (115, Some(24)));
    }

    #[test]
    fn a_scene_name_is_cut_at_its_first_tag() {
        let r = parse_music_release("Cora_Vell-Salt_Meadows-WEB-FLAC-2019-GRP");
        assert_eq!(r.artist.as_deref(), Some("Cora Vell"));
        assert_eq!(r.album.as_deref(), Some("Salt Meadows"));
        assert_eq!(r.audio.quality.id, 114);
    }

    #[test]
    fn a_discography_is_not_one_album() {
        for t in [
            "Cora Vell - Discography (1998-2020) FLAC",
            "Cora Vell - Complete Collection MP3 320",
        ] {
            assert!(parse_music_release(t).discography, "{t}");
        }
        assert!(!parse_music_release("Cora Vell - Salt Meadows (2019) MP3").discography);
    }

    #[test]
    fn mp3_320_and_v0_have_their_rows() {
        let q = |t| parse_music_release(t).audio.quality.id;
        assert_eq!(q("Cora Vell - Salt Meadows [MP3 320]"), 116);
        assert_eq!(q("Cora Vell - Salt Meadows MP3 320kbps"), 116);
        assert_eq!(q("Cora Vell - Salt Meadows MP3 V0"), 117);
        assert_eq!(q("Cora Vell - Salt Meadows MP3 256kbps"), 104);
        assert_eq!(q("Cora Vell - Salt Meadows MP3"), 101);
    }

    #[test]
    fn the_track_count_is_read() {
        assert_eq!(
            parse_music_release("Cora Vell - Salt Meadows [12 tracks] FLAC").tracks,
            Some(12)
        );
    }
}

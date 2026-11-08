//! Pure rules of the catalog read routes (`docs/spec/media-query.md`).
pub mod bonus;
pub mod family;
pub mod finish;
pub mod kind;
pub mod path;
pub mod query;
pub mod release;
pub mod search;
pub mod similarity;
pub mod wants;

/// Container extensions treated as a playable video file (lower-case, dot-prefixed).
pub const VIDEO_EXTS: [&str; 14] = [
    ".mkv", ".mp4", ".avi", ".mov", ".ts", ".m2ts", ".wmv", ".flv", ".webm", ".m4v", ".mpg",
    ".mpeg", ".ogm", ".mts",
];

/// Audio file extensions of a book (lower-case, dot-prefixed).
pub const AUDIO_EXTS: [&str; 7] = [".m4b", ".m4a", ".mp3", ".flac", ".ogg", ".opus", ".aac"];

/// Audio file extensions of an album track: books' audio plus the uncompressed and lossless containers
/// a music library holds (lower-case, dot-prefixed). `AUDIO_EXTS` stays the books' own.
pub const MUSIC_EXTS: [&str; 13] = [
    ".m4b", ".m4a", ".mp3", ".flac", ".ogg", ".opus", ".aac", ".wav", ".aiff", ".aif", ".ape",
    ".wv", ".dsf",
];

/// A book format naming an audio medium: an audio file extension or a provider's `audio`.
pub fn is_audio_format(format: &str) -> bool {
    let f = format.to_ascii_lowercase();
    f == "audio" || AUDIO_EXTS.iter().any(|e| e[1..] == f)
}

/// Text file extensions of a book (lower-case, dot-prefixed).
pub const TEXT_EXTS: [&str; 6] = [".epub", ".pdf", ".azw3", ".mobi", ".fb2", ".cbz"];

#[cfg(test)]
mod tests {
    #[test]
    fn music_extensions_are_a_superset_of_the_books_audio() {
        assert!(
            super::AUDIO_EXTS
                .iter()
                .all(|e| super::MUSIC_EXTS.contains(e))
        );
        assert!(!super::AUDIO_EXTS.contains(&".wav"));
    }

    #[test]
    fn audio_formats() {
        for f in ["mp3", "M4B", "audio", "AUDIO"] {
            assert!(super::is_audio_format(f), "{f}");
        }
        for f in ["epub", "print", "ebook", "audiobook"] {
            assert!(!super::is_audio_format(f), "{f}");
        }
    }
}

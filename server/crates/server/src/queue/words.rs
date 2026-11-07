//! Renaming by words: only the technical words already in a file name that the new file made wrong are
//! replaced (the dictionary is `attributes.rs`); a name without such words never changes.
use fliks_domain::release::parsing::attributes::parse_release_attributes;
use regex::Regex;
use std::sync::LazyLock;

macro_rules! re {
    ($p:expr) => {{
        static R: LazyLock<Regex> = LazyLock::new(|| Regex::new($p).expect("static regex"));
        &*R
    }};
}
use fliks_engine_core::api::MediaInfo;

fn video_word(old: &str, codec: &str) -> Option<&'static str> {
    let l = old.to_lowercase();
    match (codec, l.as_str()) {
        ("hevc", "x264") => Some("x265"),
        ("hevc", "h264") => Some("h265"),
        ("hevc", "h.264") => Some("H.265"),
        ("hevc", "avc") => Some("HEVC"),
        ("av1", _) => Some("AV1"),
        _ => None,
    }
}

fn audio_word(codec: &str) -> Option<&'static str> {
    Some(match codec {
        "eac3" => "EAC3",
        "ac3" => "AC3",
        "aac" => "AAC",
        "opus" => "Opus",
        "flac" => "FLAC",
        _ => return None,
    })
}

/// The file name for the new streams and container, or `None` when no word is wrong.
pub fn renamed(name: &str, new: &MediaInfo, ext: &str) -> Option<String> {
    let (stem, old_ext) = name.rsplit_once('.')?;
    let mut out = stem.to_owned();
    let attrs = parse_release_attributes(stem);
    if let Some(v) = new.video.first() {
        let codec = v.codec.as_str();
        let wrong = match codec {
            "hevc" => attrs.video_codec == Some("h264"),
            "av1" => matches!(attrs.video_codec, Some("h264" | "h265")),
            _ => false,
        };
        if wrong
            && let Some(m) = re!(r"(?i)\b(x264|x265|h\.?264|h\.?265|avc|hevc)\b").find(&out.clone())
            && let Some(w) = video_word(m.as_str(), codec)
        {
            out.replace_range(m.range(), w);
        }
        if v.bit_depth == Some(10)
            && let Some(m) = re!(r"(?i)\b8[ ._-]?bit\b").find(&out.clone())
        {
            out.replace_range(m.range(), "10bit");
        }
    }
    if let Some(a) = new.audio.first()
        && let Some(w) = audio_word(&a.codec)
        && attrs.audio_codec.is_some_and(|c| c != a.codec)
        && let Some(m) =
            re!(r"(?i)\b(dts-?hd|dts|e-?ac-?3|ac-?3|truehd|ddp|dd5)\b").find(&out.clone())
    {
        out.replace_range(m.range(), w);
    }
    let ext = if ext.is_empty() { old_ext } else { ext };
    let name_new = format!("{out}.{ext}");
    (name_new != name).then_some(name_new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(video: &str, depth: u32, audio: &str) -> MediaInfo {
        serde_json::from_value(serde_json::json!({
            "video": [{"streamIndex": 0, "codec": video, "bitDepth": depth}],
            "audio": [{"streamIndex": 1, "codec": audio, "language": "eng"}],
            "subtitles": []
        }))
        .unwrap()
    }

    #[test]
    fn only_wrong_words_are_replaced() {
        let i = info("hevc", 10, "eac3");
        assert_eq!(
            renamed("Movie.2020.1080p.BluRay.x264.8bit.DTS-GRP.mkv", &i, ""),
            Some("Movie.2020.1080p.BluRay.x265.10bit.EAC3-GRP.mkv".into())
        );
        assert_eq!(renamed("Movie (2020).mkv", &i, ""), None);
        assert_eq!(renamed("Movie.x265.EAC3.mkv", &i, ""), None);
    }

    #[test]
    fn the_extension_follows_the_container() {
        let i = info("hevc", 8, "aac");
        assert_eq!(renamed("Movie.mp4", &i, "mkv"), Some("Movie.mkv".into()));
    }
}

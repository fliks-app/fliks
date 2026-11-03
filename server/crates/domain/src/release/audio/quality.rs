//! `AUDIO_QUALITIES` and `parse_audio_release`: `resolution` is the bitrate bucket (lossless: bit depth), `source` the codec.
use crate::books::filename::BookNameGuess;
use crate::js::rx;
use crate::language::AppLanguage;
use crate::release::book::{parse_book_language, parse_book_release_name};
use crate::release::parsing::quality::AppQuality;
use serde::Serialize;

const fn q(
    id: u32,
    name: &'static str,
    resolution: u32,
    source: &'static str,
    rank: u32,
) -> AppQuality {
    AppQuality {
        id,
        name,
        resolution,
        source,
        rank,
    }
}

pub static AUDIO_QUALITIES: [AppQuality; 15] = [
    q(101, "Unknown-audio", 0, "unknown", 5),
    q(102, "MP3-64k", 64, "mp3", 10),
    q(103, "MP3-128k", 128, "mp3", 20),
    q(104, "MP3-256k", 256, "mp3", 30),
    q(105, "Vorbis-64k", 64, "vorbis", 12),
    q(106, "Vorbis-128k", 128, "vorbis", 22),
    q(107, "Vorbis-256k", 256, "vorbis", 32),
    q(108, "AAC-64k", 64, "aac", 13),
    q(109, "AAC-128k", 128, "aac", 23),
    q(110, "AAC-256k", 256, "aac", 33),
    q(111, "Opus-64k", 64, "opus", 15),
    q(112, "Opus-128k", 128, "opus", 25),
    q(113, "Opus-256k", 256, "opus", 35),
    q(114, "Lossless-16bit", 16, "lossless", 50),
    q(115, "Lossless-24bit", 24, "lossless", 60),
];

pub fn audio_quality_by_id(id: i64) -> Option<&'static AppQuality> {
    AUDIO_QUALITIES.iter().find(|q| i64::from(q.id) == id)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRelease {
    pub quality: &'static AppQuality,
    pub format: Option<&'static str>,
    pub codec: Option<&'static str>,
    pub bitrate_kbps: Option<u32>,
    pub bit_depth: Option<u32>,
    pub language: &'static AppLanguage,
    pub names: BookNameGuess,
}

/// `(format, codec)` of the first pattern that matches.
fn format_of(t: &str) -> Option<(&'static str, &'static str)> {
    [
        (rx!(r"\bflac\b"), "flac", "lossless"),
        (rx!(r"\bopus\b"), "opus", "opus"),
        (rx!(r"\bm4b\b"), "m4b", "aac"),
        (rx!(r"\bm4a\b"), "m4a", "aac"),
        (rx!(r"\baac\b"), "aac", "aac"),
        (rx!(r"\b(ogg|vorbis)\b"), "ogg", "vorbis"),
        (rx!(r"\bmp3\b"), "mp3", "mp3"),
    ]
    .into_iter()
    .find(|(r, ..)| r.is_match(t))
    .map(|(_, f, c)| (f, c))
}

fn bitrate_of(t: &str, codec: Option<&str>) -> Option<u32> {
    let kbps = rx!(r"\b(\d{2,3}) ?(?:kbps|kb/s|kbit/s|kbit|kb|k)\b")
        .captures(t)
        .and_then(|c| c[1].parse().ok())
        .filter(|k| (32..=512).contains(k));
    if kbps.is_some() || codec != Some("mp3") {
        return kbps;
    }
    match rx!(r"\bv([02])\b").captures(t) {
        Some(c) if &c[1] == "0" => Some(245),
        Some(_) => Some(190),
        None => None,
    }
}

fn quality_of(
    codec: Option<&str>,
    bitrate: Option<u32>,
    depth: Option<u32>,
) -> &'static AppQuality {
    let by = |res, source| {
        AUDIO_QUALITIES
            .iter()
            .find(|q| q.resolution == res && q.source == source)
    };
    let quality = match codec {
        None => None,
        Some("lossless") => by(if depth.unwrap_or(16) >= 24 { 24 } else { 16 }, "lossless"),
        Some(c) => bitrate.and_then(|b| {
            by(
                match b {
                    ..96 => 64,
                    96..192 => 128,
                    _ => 256,
                },
                c,
            )
        }),
    };
    quality.unwrap_or(&AUDIO_QUALITIES[0])
}

pub fn parse_audio_release(title: &str) -> AudioRelease {
    let t = title.replace(['.', '_'], " ").to_lowercase();
    let (format, codec) = format_of(&t).unzip();
    let bitrate_kbps = bitrate_of(&t, codec);
    let bit_depth = (codec == Some("lossless")).then(|| {
        match rx!(r"\b(16|24|32) ?-?bit\b")
            .captures(&t)
            .map(|c| c[1].to_owned())
            .as_deref()
        {
            Some("24" | "32") => 24,
            _ => 16,
        }
    });
    AudioRelease {
        quality: quality_of(codec, bitrate_kbps, bit_depth),
        format,
        codec,
        bitrate_kbps,
        bit_depth,
        language: parse_book_language(title),
        names: parse_book_release_name(title),
    }
}

#[cfg(test)]
mod format_tests {
    use super::*;
    use crate::media::AUDIO_EXTS;

    #[test]
    fn every_parsed_format_is_ingested() {
        for f in AUDIO_EXTS.iter().map(|e| &e[1..]) {
            let r = parse_audio_release(&format!("Title {f}"));
            assert_eq!(r.format, Some(f));
        }
        for f in ["wav", "alac", "wma"] {
            assert_eq!(parse_audio_release(&format!("Title {f}")).format, None);
        }
    }
}

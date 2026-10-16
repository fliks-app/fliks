//! Generic release-name attributes (`attributes.parser.ts`).
use crate::js::rx;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAttributes {
    pub resolution: u32,
    pub source: Option<&'static str>,
    pub video_codec: Option<&'static str>,
    pub audio_codec: Option<&'static str>,
    pub edition: Option<&'static str>,
    pub release_group: Option<String>,
    pub hearing_impaired: bool,
}

/// First pattern that matches wins; the table order is the spec's.
fn first(t: &str, table: &[(&'static str, &regex::Regex)]) -> Option<&'static str> {
    table.iter().find(|(_, r)| r.is_match(t)).map(|(v, _)| *v)
}

fn detect_resolution(t: &str) -> u32 {
    if rx!(r"\b(4320p?|8k)\b").is_match(t) {
        4320
    } else if rx!(r"\b(2160p?|4k|uhd)\b").is_match(t) {
        2160
    } else if rx!(r"\b1080[ip]?\b").is_match(t) {
        1080
    } else if rx!(r"\b720[ip]?\b").is_match(t) {
        720
    } else {
        rx!(r"\b(576|480|360)p?\b")
            .captures(t)
            .map_or(0, |m| m[1].parse().unwrap_or(0))
    }
}

fn detect_source(t: &str) -> Option<&'static str> {
    first(
        t,
        &[
            ("remux", rx!(r"\bremux\b")),
            ("bluray", rx!(r"\b(bluray|blu-?ray|bdrip|brrip|bdr)\b")),
            ("web-dl", rx!(r"\bweb-?dl\b")),
            ("webrip", rx!(r"\bweb-?rip\b")),
            ("hdtv", rx!(r"\bhdtv\b")),
            ("dvd", rx!(r"\b(dvd|dvdrip|dvd-?r)\b")),
            ("sdtv", rx!(r"\bsdtv\b")),
            ("cam", rx!(r"\bcam\b")),
            ("ts", rx!(r"\b(ts|telesync)\b")),
            ("tc", rx!(r"\btc\b|telecine")),
        ],
    )
}

fn detect_video_codec(t: &str) -> Option<&'static str> {
    first(
        t,
        &[
            ("h265", rx!(r"\b(h\.?265|x265|hevc)\b")),
            ("h264", rx!(r"\b(h\.?264|x264|avc)\b")),
            ("av1", rx!(r"\bav1\b")),
            ("vp9", rx!(r"\bvp9\b")),
            ("xvid", rx!(r"\bxvid\b")),
            ("mpeg2", rx!(r"\b(mpeg-?2|mpg2)\b")),
        ],
    )
}

fn detect_audio_codec(t: &str) -> Option<&'static str> {
    first(
        t,
        &[
            ("truehd", rx!(r"\btruehd\b")),
            ("dts-hd", rx!(r"\bdts-?hd\b")),
            ("dts", rx!(r"\bdts\b")),
            ("eac3", rx!(r"\be-?ac-?3\b|\bddp\b")),
            ("ac3", rx!(r"\bac-?3\b|\bdd5\b")),
            ("flac", rx!(r"\bflac\b")),
            ("aac", rx!(r"\baac\b")),
            ("opus", rx!(r"\bopus\b")),
            ("mp3", rx!(r"\bmp3\b")),
        ],
    )
}

fn detect_edition(t: &str) -> Option<&'static str> {
    first(
        t,
        &[
            ("directors-cut", rx!(r"\b(director'?s?[\s\-_]?cut|dc)\b")),
            ("extended", rx!(r"\bextended\b")),
            ("theatrical", rx!(r"\btheatrical\b")),
            ("uncut", rx!(r"\buncut\b")),
            ("remastered", rx!(r"\bremastered\b")),
            ("criterion", rx!(r"\bcriterion\b")),
            ("imax", rx!(r"\bimax\b")),
        ],
    )
}

fn detect_release_group(raw: &str) -> Option<String> {
    let stem = rx!(r"\.[a-zA-Z0-9]{2,4}$").replace(raw, "");
    let group = rx!(r"-([a-zA-Z0-9_]+)$").captures(&stem)?[1].to_lowercase();
    const FALSE_POSITIVES: [&str; 14] = [
        "1080p", "720p", "2160p", "480p", "hevc", "x264", "x265", "av1", "h264", "h265", "dvd",
        "web", "bluray", "remux",
    ];
    (!FALSE_POSITIVES.contains(&group.as_str())).then_some(group)
}

pub fn parse_release_attributes(title: &str) -> ReleaseAttributes {
    let t = title.replace('.', " ").to_lowercase();
    ReleaseAttributes {
        resolution: detect_resolution(&t),
        source: detect_source(&t),
        video_codec: detect_video_codec(&t),
        audio_codec: detect_audio_codec(&t),
        edition: detect_edition(&t),
        release_group: detect_release_group(title),
        hearing_impaired: rx!(r"\b(sdh|hi|hearing[\s\-_]?impaired|cc|closed[\s\-_]?caption)\b")
            .is_match(&t),
    }
}

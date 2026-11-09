//! Target video codec, decided at queue time from the profile, the devices seen and the workers.
use super::profile::{CodecChoice, Goal, Video};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Target {
    Hevc,
    Av1,
}

impl Target {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hevc => "hevc",
            Self::Av1 => "av1",
        }
    }
}

/// The codec name the profile and this module use for an ffprobe codec name.
pub fn canonical(name: &str) -> Option<&'static str> {
    Some(match name.to_ascii_lowercase().as_str() {
        "h264" | "avc" | "avc1" => "h264",
        "hevc" | "h265" => "hevc",
        "av1" => "av1",
        "vc1" => "vc1",
        "mpeg2video" | "mpeg2" => "mpeg2",
        "mpeg4" => "mpeg4",
        _ => return None,
    })
}

/// AV1 > HEVC > H.264 > VC-1, MPEG-2, MPEG-4 ASP; none for a codec we never replace.
fn efficiency(canon: &str) -> Option<u8> {
    Some(match canon {
        "av1" => 4,
        "hevc" => 3,
        "h264" => 2,
        "vc1" | "mpeg2" | "mpeg4" => 1,
        _ => return None,
    })
}

/// A re-encode only goes to a codec strictly more efficient than the source's.
pub fn improves(target: Target, source_codec: &str) -> bool {
    let src = canonical(source_codec).and_then(efficiency);
    src.is_some_and(|s| efficiency(target.as_str()).is_some_and(|t| t > s))
}

/// AV1 is always 10-bit; HEVC keeps the source depth.
pub fn bit_depth(target: Target, source_depth: Option<u32>) -> u32 {
    match target {
        Target::Av1 => 10,
        Target::Hevc => source_depth.unwrap_or(8),
    }
}

/// What a device decodes, from its `client_codecs."directPlayProfiles"`.
#[derive(Debug, Clone, Default)]
pub struct Device {
    pub video: HashSet<&'static str>,
    pub audio: HashSet<String>,
}

impl Device {
    pub fn from_profiles(direct_play_profiles: &Value) -> Self {
        let entries = || direct_play_profiles.as_array().into_iter().flatten();
        let list = |entry: &Value, key: &str| {
            entry
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| c.as_str().map(str::to_ascii_lowercase))
                .collect::<Vec<_>>()
        };
        // An audio-files entry (no video codec) says nothing about the audio of a video file.
        let video_entries = || entries().filter(|e| !list(e, "videoCodecs").is_empty());
        Self {
            video: video_entries()
                .flat_map(|e| list(e, "videoCodecs"))
                .filter_map(|c| canonical(&c))
                .collect(),
            audio: video_entries()
                .flat_map(|e| list(e, "audioCodecs"))
                .collect(),
        }
    }
}

/// Audio codecs every device plays; the common ones when no device is known yet.
pub fn audio_playable(devices: &[Device]) -> HashSet<String> {
    let mut it = devices.iter().map(|d| d.audio.clone());
    match it.next() {
        Some(first) => it.fold(first, |a, b| a.intersection(&b).cloned().collect()),
        None => ["aac", "ac3", "eac3", "mp3"].map(String::from).into(),
    }
}

/// DTS, TrueHD and PCM: not played everywhere.
pub fn audio_incompatible(codec: &str) -> bool {
    matches!(codec, "dts" | "truehd") || codec.starts_with("pcm_")
}

/// What the workers can do; `encodable` is the union over the known workers.
#[derive(Debug, Clone)]
pub struct Capabilities {
    pub encodable: Vec<Target>,
    pub main_decodes_av1_hw: bool,
}

impl Capabilities {
    pub fn can_encode(&self, t: Target) -> bool {
        self.encodable.contains(&t)
    }
}

/// The codec a profile asks for, before the per-file "more efficient than the source" check.
/// `devices` holds one decoded-codec set per device seen in the last 90 days.
pub fn resolve(video: &Video, devices: &[Device], caps: &Capabilities) -> Option<Target> {
    let target = match video.codec {
        CodecChoice::Hevc => Target::Hevc,
        CodecChoice::Av1 => Target::Av1,
        CodecChoice::Auto => match video.goal {
            Goal::Space if caps.can_encode(Target::Av1) && caps.main_decodes_av1_hw => Target::Av1,
            Goal::Space => Target::Hevc,
            Goal::Compatibility => [Target::Av1, Target::Hevc].into_iter().find(|t| {
                !devices.is_empty() && devices.iter().all(|d| d.video.contains(t.as_str()))
            })?,
        },
    };
    caps.can_encode(target).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::optimize::profile::Preset;

    fn caps(av1_hw: bool) -> Capabilities {
        Capabilities {
            encodable: vec![Target::Hevc, Target::Av1],
            main_decodes_av1_hw: av1_hw,
        }
    }

    #[test]
    fn auto_follows_the_goal() {
        let mut v = Preset::Balanced.document().video;
        assert_eq!(resolve(&v, &[], &caps(true)), Some(Target::Av1));
        assert_eq!(resolve(&v, &[], &caps(false)), Some(Target::Hevc));
        v.goal = Goal::Compatibility;
        assert_eq!(resolve(&v, &[], &caps(true)), None);
        let dev = |c: &[&'static str]| Device {
            video: c.iter().copied().collect(),
            audio: HashSet::new(),
        };
        let hevc_only = dev(&["h264", "hevc"]);
        let all = dev(&["h264", "hevc", "av1"]);
        assert_eq!(
            resolve(&v, &[hevc_only, all.clone()], &caps(true)),
            Some(Target::Hevc)
        );
        assert_eq!(resolve(&v, &[all], &caps(true)), Some(Target::Av1));
    }

    #[test]
    fn the_audio_files_entry_is_not_a_video_audio_codec() {
        let d = Device::from_profiles(&serde_json::json!([
            {"containers": ["mp4"], "videoCodecs": ["H264"], "audioCodecs": ["aac"]},
            {"containers": ["flac"], "videoCodecs": [], "audioCodecs": ["flac"]},
        ]));
        assert_eq!(d.audio, ["aac".to_string()].into());
        assert_eq!(d.video, ["h264"].into());
    }

    #[test]
    fn never_re_encodes_to_the_same_or_a_worse_codec() {
        assert!(improves(Target::Hevc, "h264") && improves(Target::Av1, "hevc"));
        assert!(
            !improves(Target::Hevc, "hevc")
                && !improves(Target::Hevc, "av1")
                && !improves(Target::Hevc, "vp9")
        );
    }
}

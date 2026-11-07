//! The profile document stored in `optimize_profiles."document"` and its three preset templates.
use super::languages;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodecChoice {
    Auto,
    Hevc,
    Av1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Goal {
    Space,
    Compatibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    Small,
    Balanced,
    Faithful,
}

/// `source` or a height in lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MaxResolution {
    #[serde(rename = "source")]
    Source,
    #[serde(rename = "2160")]
    P2160,
    #[serde(rename = "1080")]
    P1080,
    #[serde(rename = "720")]
    P720,
}

impl MaxResolution {
    pub fn height(self) -> Option<u32> {
        match self {
            Self::Source => None,
            Self::P2160 => Some(2160),
            Self::P1080 => Some(1080),
            Self::P720 => Some(720),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TooSlow {
    Hardware,
    Skip,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Incompatible {
    Keep,
    Add,
    Replace,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageSubs {
    Keep,
    Drop,
    OcrThenDrop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Container {
    Keep,
    Mkv,
    Mp4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Vmaf {
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Eligible {
    pub min_age_days: u32,
    pub skip_hardlinked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoWhen {
    pub codec: Vec<String>,
    pub min_bitrate: Option<u32>,
    pub only_if_transcoding_here: bool,
    pub skip_hdr10plus_dv: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Video {
    pub enabled: bool,
    pub when: VideoWhen,
    pub codec: CodecChoice,
    pub goal: Goal,
    pub quality: Quality,
    pub max_resolution: MaxResolution,
    pub prefer_software: bool,
    pub software_max_hours: u32,
    pub too_slow: TooSlow,
    pub crop_in_file: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Audio {
    pub languages: Vec<String>,
    pub drop_other_languages: bool,
    pub drop: Vec<String>,
    pub default: Vec<String>,
    pub reorder: bool,
    pub incompatible: Incompatible,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subtitles {
    pub languages: Vec<String>,
    pub drop_other_languages: bool,
    pub image: ImageSubs,
    pub reorder: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct File {
    pub clean: bool,
    pub container: Container,
    pub rename_tokens: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Guards {
    pub min_savings_pct: u32,
    pub vmaf_sample: Vmaf,
}

/// The whole document. Every section is required: the editor always sends the full document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub eligible: Eligible,
    pub video: Video,
    pub audio: Audio,
    pub subtitles: Subtitles,
    pub file: File,
    pub guards: Guards,
}

/// Audio `drop` entries.
pub const DROP_KINDS: [&str; 2] = ["commentary", "audio_description"];
const VIDEO_CODECS: [&str; 6] = ["h264", "hevc", "av1", "vc1", "mpeg2", "mpeg4"];

impl Profile {
    /// Every violated rule, in document order; empty when the document is valid.
    pub fn problems(&self) -> Vec<String> {
        let mut p = Vec::new();
        let mut check = |ok: bool, msg: &str| {
            if !ok {
                p.push(msg.to_owned());
            }
        };
        check(
            self.video.software_max_hours >= 1,
            "video.software_max_hours must be at least 1",
        );
        check(
            self.video.when.min_bitrate != Some(0),
            "video.when.min_bitrate must be positive or null",
        );
        check(
            self.guards.min_savings_pct <= 100,
            "guards.min_savings_pct must be between 0 and 100",
        );
        check(
            self.video
                .when
                .codec
                .iter()
                .all(|c| VIDEO_CODECS.contains(&c.as_str())),
            "video.when.codec must list h264, hevc, av1, vc1, mpeg2 or mpeg4",
        );
        check(
            self.audio
                .drop
                .iter()
                .all(|d| DROP_KINDS.contains(&d.as_str())),
            "audio.drop must list commentary or audio_description",
        );
        for (field, list) in [
            ("audio.languages", &self.audio.languages),
            ("audio.default", &self.audio.default),
            ("subtitles.languages", &self.subtitles.languages),
        ] {
            check(
                list.iter().all(|t| languages::is_token(t)),
                &format!("{field} must hold original, media_profile or ISO 639 codes"),
            );
        }
        check(
            !self.audio.drop_other_languages || !self.audio.languages.is_empty(),
            "audio.drop_other_languages needs audio.languages",
        );
        check(
            !self.subtitles.drop_other_languages || !self.subtitles.languages.is_empty(),
            "subtitles.drop_other_languages needs subtitles.languages",
        );
        p
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Preset {
    Balanced,
    CleanupOnly,
    DirectPlayback,
}

impl Preset {
    pub const ALL: [Self; 3] = [Self::Balanced, Self::CleanupOnly, Self::DirectPlayback];

    pub fn document(self) -> Profile {
        let langs = || vec!["original".to_owned(), "media_profile".to_owned()];
        let mut p = Profile {
            eligible: Eligible {
                min_age_days: 14,
                skip_hardlinked: true,
            },
            video: Video {
                enabled: true,
                when: VideoWhen {
                    codec: ["h264", "vc1", "mpeg2"].map(String::from).to_vec(),
                    min_bitrate: None,
                    only_if_transcoding_here: false,
                    skip_hdr10plus_dv: true,
                },
                codec: CodecChoice::Auto,
                goal: Goal::Space,
                quality: Quality::Balanced,
                max_resolution: MaxResolution::Source,
                prefer_software: false,
                software_max_hours: 12,
                too_slow: TooSlow::Hardware,
                crop_in_file: false,
            },
            audio: Audio {
                languages: langs(),
                drop_other_languages: false,
                drop: DROP_KINDS.map(String::from).to_vec(),
                default: langs(),
                reorder: true,
                incompatible: Incompatible::Add,
            },
            subtitles: Subtitles {
                languages: langs(),
                drop_other_languages: false,
                image: ImageSubs::OcrThenDrop,
                reorder: true,
            },
            file: File {
                clean: true,
                container: Container::Keep,
                rename_tokens: true,
            },
            guards: Guards {
                min_savings_pct: 20,
                vmaf_sample: Vmaf::Auto,
            },
        };
        match self {
            Self::Balanced => {}
            Self::CleanupOnly => {
                p.video.enabled = false;
                p.audio.incompatible = Incompatible::Keep;
                p.subtitles.image = ImageSubs::Keep;
            }
            Self::DirectPlayback => {
                p.video.when.only_if_transcoding_here = true;
                p.video.goal = Goal::Compatibility;
                p.video.when.codec.clear();
            }
        }
        p
    }
}

//! The difference between a profile's wanted state and a file, from its stored probe only.
//! Entry point: [`compute`]. Nothing here reads the disk (`nlink`, real savings and OCR success
//! are settled at queue time or by the worker).
use super::codec::{self, Target};
use super::languages::{self, Kind, Languages};
use super::profile::{Container, ImageSubs, Incompatible, Profile};
use fliks_domain::{release::parsing::attributes::parse_release_attributes, subtitle_flags};
use fliks_engine_core::api::{
    AudioStreamInfo, CropInfo, MediaInfo, OptimizeLevel, SubtitleStreamInfo,
};
use serde::Serialize;
use std::collections::HashSet;

/// Rows whose probe is older than this (or absent) are not compared.
pub use crate::ingest::rescan::PROBE_VERSION;

/// What the profile is compared with, beyond the file.
pub struct Env<'a> {
    pub profile: &'a Profile,
    pub allow_rename: bool,
    /// `codec::resolve`, computed once per library.
    pub target: Option<Target>,
    pub audio_playable: &'a HashSet<String>,
}

pub struct File<'a> {
    pub relative_path: &'a str,
    pub info: &'a MediaInfo,
    pub probe_version: Option<i32>,
    pub age_days: i64,
    pub languages: &'a Languages,
    /// Transcoded in the last 30 days (`playback_qoe_sessions."transcodeReasons"` not empty).
    pub transcoded_recently: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Excluded {
    ProbeOutdated,
    ProbeFailed,
    NotVideo,
    TooRecent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Skipped {
    Container,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Audio,
    Subtitle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DropReason {
    Commentary,
    AudioDescription,
    Language,
    ImageSubtitle,
    Replaced,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Change {
    #[serde(rename_all = "camelCase")]
    Reencode {
        codec: Target,
        bit_depth: u32,
        crop: Option<CropInfo>,
        max_height: Option<u32>,
        /// The crop alone justifies the re-encode: the minimum savings does not apply.
        crop_only: bool,
    },
    #[serde(rename_all = "camelCase")]
    Drop {
        kind: TrackKind,
        stream_index: u32,
        language: Option<String>,
        reason: DropReason,
    },
    #[serde(rename_all = "camelCase")]
    Ocr {
        stream_index: u32,
    },
    #[serde(rename_all = "camelCase")]
    AddAudio {
        source_stream: u32,
    },
    Reorder {
        kind: TrackKind,
    },
    #[serde(rename_all = "camelCase")]
    Default {
        stream_index: u32,
    },
    #[serde(rename_all = "camelCase")]
    Language {
        kind: TrackKind,
        stream_index: u32,
        code: String,
    },
    #[serde(rename_all = "camelCase")]
    Flags {
        kind: TrackKind,
        stream_index: u32,
    },
    #[serde(rename_all = "camelCase")]
    Title {
        kind: TrackKind,
        stream_index: u32,
    },
    StatisticsTags,
    Hvc1,
    Container {
        to: &'static str,
    },
    Rename,
}

impl Change {
    fn level(&self) -> OptimizeLevel {
        match self {
            Self::Reencode { .. } => OptimizeLevel::Reencode,
            Self::Drop { .. }
            | Self::Ocr { .. }
            | Self::AddAudio { .. }
            | Self::Reorder { .. }
            | Self::Hvc1
            | Self::Container { .. } => OptimizeLevel::Remux,
            _ => OptimizeLevel::Metadata,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Warning {
    /// The filters would remove every audio track: none is removed.
    NoAudioWouldRemain,
    #[serde(rename_all = "camelCase")]
    ProfileSubtitleKept { language: String },
    /// `incompatible: replace` drops a lossless or immersive track.
    #[serde(rename_all = "camelCase")]
    LosslessReplaced { stream_index: u32 },
    #[serde(rename_all = "camelCase")]
    VideoCopied { reason: &'static str },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    pub level: LevelOut,
    pub changes: Vec<Change>,
    pub warnings: Vec<Warning>,
}

/// `OptimizeLevel` on the wire, comparable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LevelOut {
    Metadata,
    Remux,
    Reencode,
}

impl From<OptimizeLevel> for LevelOut {
    fn from(l: OptimizeLevel) -> Self {
        match l {
            OptimizeLevel::Metadata => Self::Metadata,
            OptimizeLevel::Remux => Self::Remux,
            OptimizeLevel::Reencode => Self::Reencode,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    Excluded { why: Excluded },
    Skipped { why: Skipped },
    Conform { warnings: Vec<Warning> },
    Diff(Diff),
}

pub fn compute(env: &Env, f: &File) -> Outcome {
    let info = f.info;
    if f.probe_version.is_none_or(|v| v < PROBE_VERSION) {
        return Outcome::Excluded {
            why: Excluded::ProbeOutdated,
        };
    }
    if info.error.is_some() {
        return Outcome::Excluded {
            why: Excluded::ProbeFailed,
        };
    }
    if info.video.is_empty() {
        return Outcome::Excluded {
            why: Excluded::NotVideo,
        };
    }
    if f.age_days < i64::from(env.profile.eligible.min_age_days) {
        return Outcome::Excluded {
            why: Excluded::TooRecent,
        };
    }
    let mut b = Builder {
        env,
        f,
        changes: vec![],
        warnings: vec![],
    };
    let reencode = b.video();
    let kept_subs = b.tracks();
    b.clean();
    match b.container(reencode, &kept_subs) {
        Ok(()) => {}
        Err(()) => {
            return Outcome::Skipped {
                why: Skipped::Container,
            };
        }
    }
    b.rename();
    let Builder {
        changes, warnings, ..
    } = b;
    if changes.is_empty() {
        return Outcome::Conform { warnings };
    }
    let mut level = changes
        .iter()
        .map(Change::level)
        .map(LevelOut::from)
        .max()
        .unwrap_or(LevelOut::Metadata);
    let only_rename = changes.iter().all(|c| matches!(c, Change::Rename));
    if level == LevelOut::Metadata && !only_rename && !is_mkv(info, f.relative_path) {
        level = LevelOut::Remux;
    }
    Outcome::Diff(Diff {
        level,
        changes,
        warnings,
    })
}

struct Builder<'a> {
    env: &'a Env<'a>,
    f: &'a File<'a>,
    changes: Vec<Change>,
    warnings: Vec<Warning>,
}

fn ext(path: &str) -> String {
    path.rsplit('.').next().unwrap_or("").to_ascii_lowercase()
}

fn is_mkv(info: &MediaInfo, path: &str) -> bool {
    info.format_name.as_deref().map_or_else(
        || matches!(ext(path).as_str(), "mkv" | "mka"),
        |n| n.contains("matroska"),
    )
}

fn is_mp4(path: &str) -> bool {
    matches!(ext(path).as_str(), "mp4" | "m4v" | "mov")
}

impl Builder<'_> {
    /// Adds the video change when one is due; returns whether the video is re-encoded.
    fn video(&mut self) -> bool {
        let p = self.env.profile;
        let v = &p.video;
        let Some(src) = self.f.info.video.first() else {
            return false;
        };
        if !v.enabled {
            return false;
        }
        let src_codec = codec::canonical(&src.codec);
        let protected = src.dv_profile.is_some() || src.hdr10_plus == Some(true);
        let hard_stop = if src.field_order.is_some() {
            Some("interlaced")
        } else if src.dv_profile == Some(5) || (protected && v.when.skip_hdr10plus_dv) {
            Some("hdr")
        } else {
            None
        };
        // The crop exception ignores the condition and the "already efficient" rule.
        let crop = src.crop.clone().filter(|c| {
            v.crop_in_file
                && src.crop_stable == Some(true)
                && src
                    .width
                    .zip(src.height)
                    .is_some_and(|(w, h)| c.width < w || c.height < h)
        });
        let when = &v.when;
        let bitrate = src.bit_rate.or(self.f.info.format_bit_rate);
        let matches_when = (when.codec.is_empty()
            || src_codec.is_some_and(|c| when.codec.iter().any(|w| w == c)))
            && when
                .min_bitrate
                .is_none_or(|m| bitrate.is_some_and(|b| b >= m))
            && (!when.only_if_transcoding_here || self.f.transcoded_recently);
        let max_h = v
            .max_resolution
            .height()
            .filter(|h| src.height.is_some_and(|sh| sh > *h));
        let improving = self.env.target.filter(|t| codec::improves(*t, &src.codec));
        // A reduction without an improving codec keeps a codec the encoders know.
        let same = match src_codec {
            Some("hevc") => Some(Target::Hevc),
            Some("av1") => Some(Target::Av1),
            _ => None,
        };
        let codec_change = matches_when && improving.is_some();
        let resize = matches_when && max_h.is_some();
        if !(codec_change || resize || crop.is_some()) {
            return false;
        }
        let Some(t) = improving.or(same) else {
            return false;
        };
        let crop_only = !(codec_change || resize);
        if let Some(reason) = hard_stop {
            self.warnings.push(Warning::VideoCopied { reason });
            return false;
        }
        self.changes.push(Change::Reencode {
            codec: t,
            bit_depth: codec::bit_depth(t, src.bit_depth),
            crop,
            max_height: max_h,
            crop_only,
        });
        true
    }

    /// Audio and subtitle changes; returns the kept subtitle codecs for the container check.
    fn tracks(&mut self) -> Vec<String> {
        self.audio();
        self.subtitles()
    }

    fn audio(&mut self) {
        let p = &self.env.profile.audio;
        let info = self.f.info;
        let wanted = self.f.languages.resolve(&p.languages, Kind::Audio);
        let single = info.audio.len() == 1;
        let lang_of = |t: &AudioStreamInfo| -> Option<String> {
            languages::known(&t.language).or_else(|| {
                (single && t.language_from_title != Some(true))
                    .then(|| self.f.languages.original.clone())
                    .flatten()
            })
        };
        let langs: Vec<Option<String>> = info.audio.iter().map(lang_of).collect();
        for (t, l) in info.audio.iter().zip(&langs) {
            let declared = languages::known(&t.language);
            if let Some(code) = l
                && (declared.is_none() || t.language_from_title == Some(true))
            {
                self.changes.push(Change::Language {
                    kind: TrackKind::Audio,
                    stream_index: t.stream_index,
                    code: code.clone(),
                });
            }
        }
        // Removal marks, then the two fixed guards.
        let mut reason: Vec<Option<DropReason>> = info
            .audio
            .iter()
            .zip(&langs)
            .map(|(t, l)| {
                if t.commentary == Some(true) && p.drop.iter().any(|d| d == "commentary") {
                    Some(DropReason::Commentary)
                } else if t.audio_description == Some(true)
                    && p.drop.iter().any(|d| d == "audio_description")
                {
                    Some(DropReason::AudioDescription)
                } else if p.drop_other_languages && l.as_ref().is_some_and(|c| !wanted.contains(c))
                {
                    Some(DropReason::Language)
                } else {
                    None
                }
            })
            .collect();
        for code in &wanted {
            let idx: Vec<usize> = (0..langs.len())
                .filter(|i| langs[*i].as_ref() == Some(code))
                .collect();
            if !idx.is_empty() && idx.iter().all(|i| reason[*i].is_some()) {
                reason[idx[0]] = None;
            }
        }
        if !reason.is_empty() && reason.iter().all(Option::is_some) {
            self.warnings.push(Warning::NoAudioWouldRemain);
            reason.fill(None);
        }
        // Not playable everywhere: add (or replace by) a playable version, once per language.
        let mut seen: HashSet<Option<String>> = HashSet::new();
        for (i, t) in info.audio.iter().enumerate() {
            if p.incompatible == Incompatible::Keep
                || reason[i].is_some()
                || !codec::audio_incompatible(&t.codec)
            {
                continue;
            }
            let playable_exists = (0..langs.len()).any(|j| {
                langs[j] == langs[i]
                    && self
                        .env
                        .audio_playable
                        .contains(&info.audio[j].codec.to_ascii_lowercase())
            });
            if playable_exists || !seen.insert(langs[i].clone()) {
                continue;
            }
            self.changes.push(Change::AddAudio {
                source_stream: t.stream_index,
            });
            if p.incompatible == Incompatible::Replace {
                reason[i] = Some(DropReason::Replaced);
                self.warnings.push(Warning::LosslessReplaced {
                    stream_index: t.stream_index,
                });
            }
        }
        for (t, (r, l)) in info.audio.iter().zip(reason.iter().zip(&langs)) {
            if let Some(reason) = r {
                self.changes.push(Change::Drop {
                    kind: TrackKind::Audio,
                    stream_index: t.stream_index,
                    language: l.clone(),
                    reason: *reason,
                });
            }
        }
        let kept: Vec<usize> = (0..info.audio.len())
            .filter(|i| reason[*i].is_none())
            .collect();
        if p.reorder {
            let mut order = kept.clone();
            order.sort_by_key(|i| {
                let t = &info.audio[*i];
                let rank = langs[*i]
                    .as_ref()
                    .and_then(|c| wanted.iter().position(|w| w == c))
                    .unwrap_or(wanted.len());
                (
                    rank,
                    std::cmp::Reverse((t.channels.unwrap_or(0), t.bit_rate.unwrap_or(0))),
                )
            });
            if order != kept {
                self.changes.push(Change::Reorder {
                    kind: TrackKind::Audio,
                });
            }
        }
        let defaults = self.f.languages.resolve(&p.default, Kind::Audio);
        if !defaults.is_empty() {
            let pick = defaults
                .iter()
                .find_map(|d| kept.iter().find(|i| langs[**i].as_ref() == Some(d)))
                .map(|i| &info.audio[*i]);
            if let Some(t) = pick {
                let only_it = info
                    .audio
                    .iter()
                    .filter(|a| a.is_default == Some(true))
                    .count()
                    == 1
                    && t.is_default == Some(true);
                if !only_it {
                    self.changes.push(Change::Default {
                        stream_index: t.stream_index,
                    });
                }
            }
        } else if info
            .audio
            .iter()
            .filter(|a| a.is_default == Some(true))
            .count()
            > 1
        {
            self.changes.push(Change::Flags {
                kind: TrackKind::Audio,
                stream_index: info.audio[0].stream_index,
            });
        }
    }

    fn subtitles(&mut self) -> Vec<String> {
        let p = &self.env.profile.subtitles;
        let info = self.f.info;
        let listed = self.f.languages.resolve(&p.languages, Kind::Subtitle);
        let protected = self
            .f
            .languages
            .resolve(&["media_profile".to_owned()], Kind::Subtitle);
        let mut keep_langs = listed.clone();
        for c in &protected {
            if !keep_langs.contains(c) {
                keep_langs.push(c.clone());
                if p.drop_other_languages {
                    self.warnings.push(Warning::ProfileSubtitleKept {
                        language: c.clone(),
                    });
                }
            }
        }
        let mut kept: Vec<&SubtitleStreamInfo> = vec![];
        for t in &info.subtitles {
            let lang = languages::known(&t.language);
            let reason = if t.is_image_based && p.image == ImageSubs::Drop {
                Some(DropReason::ImageSubtitle)
            } else if p.drop_other_languages
                && lang.as_ref().is_some_and(|c| !keep_langs.contains(c))
            {
                Some(DropReason::Language)
            } else {
                None
            };
            if let Some(reason) = reason {
                self.changes.push(Change::Drop {
                    kind: TrackKind::Subtitle,
                    stream_index: t.stream_index,
                    language: lang,
                    reason,
                });
                continue;
            }
            if t.is_image_based
                && p.image == ImageSubs::OcrThenDrop
                && subtitle_flags::is_ocr_supported_codec(Some(&t.codec))
            {
                self.changes.push(Change::Ocr {
                    stream_index: t.stream_index,
                });
                continue;
            }
            if let Some(code) = &lang
                && t.language_from_title == Some(true)
            {
                self.changes.push(Change::Language {
                    kind: TrackKind::Subtitle,
                    stream_index: t.stream_index,
                    code: code.clone(),
                });
            }
            kept.push(t);
        }
        if p.reorder {
            let rank = |t: &SubtitleStreamInfo| {
                languages::known(&t.language)
                    .and_then(|c| keep_langs.iter().position(|w| *w == c))
                    .unwrap_or(keep_langs.len())
            };
            if kept.windows(2).any(|w| rank(w[0]) > rank(w[1])) {
                self.changes.push(Change::Reorder {
                    kind: TrackKind::Subtitle,
                });
            }
        }
        kept.iter().map(|t| t.codec.clone()).collect()
    }

    /// "Clean the file": what the probe sees against what the file declares.
    fn clean(&mut self) {
        if !self.env.profile.file.clean {
            return;
        }
        let info = self.f.info;
        let path = self.f.relative_path;
        let stale = info
            .video
            .iter()
            .any(|v| v.has_statistics_tags == Some(false))
            || info
                .audio
                .iter()
                .any(|a| a.has_statistics_tags == Some(false))
            || info
                .subtitles
                .iter()
                .any(|s| s.has_statistics_tags == Some(false));
        if stale && is_mkv(info, path) {
            self.changes.push(Change::StatisticsTags);
        }
        for a in &info.audio {
            if a.title
                .as_deref()
                .is_some_and(|t| title_contradicts(t, &a.codec, a.channels))
            {
                self.changes.push(Change::Title {
                    kind: TrackKind::Audio,
                    stream_index: a.stream_index,
                });
            }
        }
        for s in &info.subtitles {
            let title = s.title.as_deref().unwrap_or("").to_ascii_lowercase();
            let says_forced = title.contains("forced") || title.contains("forcé");
            let says_hi = title.contains("sdh") || title.contains("hearing");
            if (says_forced && !s.forced) || (says_hi && !s.hearing_impaired) {
                self.changes.push(Change::Flags {
                    kind: TrackKind::Subtitle,
                    stream_index: s.stream_index,
                });
            }
        }
        if is_mp4(path)
            && info
                .video
                .first()
                .is_some_and(|v| v.codec_tag.as_deref() == Some("hev1"))
        {
            self.changes.push(Change::Hvc1);
        }
    }

    /// The output container, and the permission a different extension needs.
    fn container(&mut self, reencode: bool, kept_subs: &[String]) -> Result<(), ()> {
        let path = self.f.relative_path;
        let cur = ext(path);
        let wanted = match self.env.profile.file.container {
            Container::Mkv => Some("mkv"),
            Container::Mp4 => Some("mp4"),
            Container::Keep => (reencode
                && matches!(
                    cur.as_str(),
                    "avi" | "wmv" | "asf" | "flv" | "mpg" | "mpeg" | "vob"
                ))
            .then_some("mkv"),
        };
        let to_mp4 = wanted == Some("mp4") || (wanted.is_none() && is_mp4(path));
        let mp4_unfit = kept_subs.iter().any(|c| {
            matches!(
                c.as_str(),
                "ass" | "ssa" | "hdmv_pgs_subtitle" | "dvd_subtitle"
            )
        });
        let to = if to_mp4 && mp4_unfit {
            Some("mkv")
        } else {
            wanted
        };
        let Some(to) = to.filter(|t| {
            !(*t == "mkv" && matches!(cur.as_str(), "mkv")) && !(*t == "mp4" && is_mp4(path))
        }) else {
            return Ok(());
        };
        if !self.env.allow_rename {
            return Err(());
        }
        self.changes.push(Change::Container { to });
        Ok(())
    }

    /// Known technical words of the name that the file no longer matches.
    fn rename(&mut self) {
        if !self.env.allow_rename || !self.env.profile.file.rename_tokens {
            return;
        }
        let stem = self.f.relative_path.rsplit('/').next().unwrap_or("");
        let word = parse_release_attributes(stem).video_codec;
        let video = self.changes.iter().find_map(|c| match c {
            Change::Reencode { codec, .. } => Some(*codec),
            _ => None,
        });
        let final_word = match video {
            Some(Target::Hevc) => Some("h265"),
            Some(Target::Av1) => Some("av1"),
            None => self
                .f
                .info
                .video
                .first()
                .and_then(|v| match codec::canonical(&v.codec) {
                    Some("hevc") => Some("h265"),
                    Some("h264") => Some("h264"),
                    Some("av1") => Some("av1"),
                    _ => None,
                }),
        };
        let name_wrong = word.zip(final_word).is_some_and(|(w, f)| w != f);
        if name_wrong
            || self
                .changes
                .iter()
                .any(|c| matches!(c, Change::Container { .. }))
        {
            self.changes.push(Change::Rename);
        }
    }
}

/// A title naming a channel layout or codec the stream does not have.
fn title_contradicts(title: &str, codec: &str, channels: Option<u32>) -> bool {
    let t = title.to_ascii_lowercase();
    let layout = [
        ("7.1", 8),
        ("5.1", 6),
        ("2.0", 2),
        ("stereo", 2),
        ("mono", 1),
    ]
    .iter()
    .find(|(w, _)| t.contains(w))
    .map(|(_, n)| *n);
    if let (Some(l), Some(c)) = (layout, channels)
        && l != c
    {
        return true;
    }
    let named = [
        ("truehd", "truehd"),
        ("e-ac3", "eac3"),
        ("eac3", "eac3"),
        ("dts", "dts"),
        ("flac", "flac"),
        ("aac", "aac"),
        ("opus", "opus"),
    ]
    .iter()
    .find(|(w, _)| t.contains(w))
    .map(|(_, c)| *c);
    named.is_some_and(|n| n != codec.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::optimize::profile::Preset;
    use fliks_engine_core::api::VideoStreamInfo;

    fn audio(i: u32, lang: &str, codec: &str, ch: u32) -> AudioStreamInfo {
        AudioStreamInfo {
            stream_index: i,
            codec: codec.into(),
            language: lang.into(),
            channels: Some(ch),
            ..Default::default()
        }
    }

    fn info(video: &str, audio: Vec<AudioStreamInfo>) -> MediaInfo {
        MediaInfo {
            video: vec![VideoStreamInfo {
                codec: video.into(),
                width: Some(1920),
                height: Some(1080),
                ..Default::default()
            }],
            audio,
            format_name: Some("matroska,webm".into()),
            ..Default::default()
        }
    }

    fn run(preset: Preset, path: &str, info: &MediaInfo, original: Option<&str>) -> Outcome {
        let profile = preset.document();
        let playable: HashSet<String> = ["aac", "ac3", "eac3"].map(String::from).into();
        let env = Env {
            profile: &profile,
            allow_rename: false,
            target: Some(Target::Hevc),
            audio_playable: &playable,
        };
        let languages = Languages {
            original: original.map(Into::into),
            ..Default::default()
        };
        let f = File {
            relative_path: path,
            info,
            probe_version: Some(PROBE_VERSION),
            age_days: 30,
            languages: &languages,
            transcoded_recently: false,
        };
        compute(&env, &f)
    }

    fn diff(o: Outcome) -> Diff {
        match o {
            Outcome::Diff(d) => d,
            other => panic!("expected a diff, got {other:?}"),
        }
    }

    #[test]
    fn an_h264_file_is_re_encoded_and_an_hevc_one_is_left_alone() {
        let a = vec![audio(1, "eng", "eac3", 6)];
        let d = diff(run(
            Preset::Balanced,
            "a.mkv",
            &info("h264", a.clone()),
            Some("en"),
        ));
        assert_eq!(d.level, LevelOut::Reencode);
        assert!(matches!(
            run(Preset::Balanced, "a.mkv", &info("hevc", a), Some("en")),
            Outcome::Conform { .. }
        ));
    }

    #[test]
    fn old_probes_and_young_files_are_excluded() {
        let i = info("h264", vec![audio(1, "eng", "aac", 2)]);
        let profile = Preset::Balanced.document();
        let playable = HashSet::new();
        let env = Env {
            profile: &profile,
            allow_rename: false,
            target: None,
            audio_playable: &playable,
        };
        let l = Languages::default();
        let mut f = File {
            relative_path: "a.mkv",
            info: &i,
            probe_version: Some(PROBE_VERSION - 1),
            age_days: 30,
            languages: &l,
            transcoded_recently: false,
        };
        assert!(matches!(
            compute(&env, &f),
            Outcome::Excluded {
                why: Excluded::ProbeOutdated
            }
        ));
        f.probe_version = Some(PROBE_VERSION);
        f.age_days = 1;
        assert!(matches!(
            compute(&env, &f),
            Outcome::Excluded {
                why: Excluded::TooRecent
            }
        ));
    }

    #[test]
    fn commentary_is_dropped_but_never_the_last_track_of_a_language() {
        let mut c = audio(2, "eng", "aac", 2);
        c.commentary = Some(true);
        let two = info("hevc", vec![audio(1, "eng", "eac3", 6), c.clone()]);
        let d = diff(run(Preset::CleanupOnly, "a.mkv", &two, Some("en")));
        assert!(d.changes.iter().any(|x| matches!(
            x,
            Change::Drop {
                stream_index: 2,
                reason: DropReason::Commentary,
                ..
            }
        )));
        let only = info("hevc", vec![c]);
        assert!(
            !matches!(run(Preset::CleanupOnly, "a.mkv", &only, Some("en")), Outcome::Diff(d) if d.changes.iter().any(|x| matches!(x, Change::Drop { .. })))
        );
    }

    #[test]
    fn a_lone_unknown_audio_track_takes_the_original_language_at_metadata_level() {
        let i = info("hevc", vec![audio(1, "und", "eac3", 6)]);
        let d = diff(run(Preset::CleanupOnly, "a.mkv", &i, Some("fr")));
        assert_eq!(d.level, LevelOut::Metadata);
        assert!(
            d.changes
                .iter()
                .any(|c| matches!(c, Change::Language { code, .. } if code == "fr"))
        );
    }

    #[test]
    fn dts_gets_a_playable_companion_unless_one_exists() {
        let dts = info("hevc", vec![audio(1, "eng", "dts", 6)]);
        let d = diff(run(Preset::Balanced, "a.mkv", &dts, Some("en")));
        assert!(
            d.changes
                .iter()
                .any(|c| matches!(c, Change::AddAudio { source_stream: 1 }))
        );
        let both = info(
            "hevc",
            vec![audio(1, "eng", "dts", 6), audio(2, "eng", "ac3", 6)],
        );
        assert!(
            !matches!(run(Preset::Balanced, "a.mkv", &both, Some("en")), Outcome::Diff(d) if d.changes.iter().any(|c| matches!(c, Change::AddAudio { .. })))
        );
    }

    #[test]
    fn an_extension_change_needs_the_renaming_permission() {
        let i = MediaInfo {
            format_name: Some("avi".into()),
            ..info("mpeg4", vec![audio(1, "eng", "ac3", 2)])
        };
        assert!(matches!(
            run(Preset::Balanced, "a.avi", &i, Some("en")),
            Outcome::Skipped {
                why: Skipped::Container
            }
        ));
    }

    #[test]
    fn a_stable_crop_re_encodes_even_a_file_already_in_hevc() {
        let mut i = info("hevc", vec![audio(1, "eng", "eac3", 6)]);
        i.video[0].crop = Some(CropInfo {
            width: 1920,
            height: 800,
            x: 0,
            y: 140,
        });
        i.video[0].crop_stable = Some(true);
        let mut profile = Preset::Balanced.document();
        profile.video.crop_in_file = true;
        let playable: HashSet<String> = ["eac3".to_owned()].into();
        let env = Env {
            profile: &profile,
            allow_rename: false,
            target: Some(Target::Hevc),
            audio_playable: &playable,
        };
        let l = Languages {
            original: Some("en".into()),
            ..Default::default()
        };
        let f = File {
            relative_path: "a.mkv",
            info: &i,
            probe_version: Some(PROBE_VERSION),
            age_days: 30,
            languages: &l,
            transcoded_recently: false,
        };
        let d = diff(compute(&env, &f));
        assert!(matches!(
            d.changes[0],
            Change::Reencode {
                crop_only: true,
                ..
            }
        ));
    }
}

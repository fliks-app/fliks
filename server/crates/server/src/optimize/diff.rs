//! The difference between a profile's wanted state and a file, from its stored probe only.
//! Entry point: [`compute`]. Nothing here reads the disk (`nlink`, real savings and OCR success
//! are settled at queue time or by the worker).
use super::codec::{self, Target};
use super::languages::{self, Kind, Languages};
use super::profile::{Container, ImageSubs, Incompatible, Profile, Quality, TooSlow};
use fliks_domain::track_markers::{Marker, audio_markers};
use fliks_domain::{release::parsing::attributes::parse_release_attributes, subtitle_flags};
use fliks_engine_core::api::{
    AudioStreamInfo, CropInfo, ExtraSubtitle, MediaInfo, OptimizeContainer, OptimizeLevel,
    OptimizePlan, OptimizeQuality, OptimizeTooSlow, StreamEncode, StreamPlan, SubtitleStreamInfo,
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
    /// "Force re-encode": the video is re-encoded to the target whatever the condition and its codec.
    pub force: bool,
}

pub struct File<'a> {
    pub relative_path: &'a str,
    pub info: &'a MediaInfo,
    pub probe_version: Option<i32>,
    pub age_days: i64,
    pub languages: &'a Languages,
    /// Transcoded in the last 30 days (`playback_qoe_sessions."transcodeReasons"` not empty).
    pub transcoded_recently: bool,
    /// Image tracks whose last OCR run failed: the difference does not list them again (`force` does).
    pub ocr_failed: &'a [u32],
    /// An earlier job with this video setting copied the video, so a new pass would copy it again.
    pub video_copied: bool,
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
        /// The kept streams in their final order.
        order: Vec<u32>,
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
    /// The global title is the release name or the file name.
    ClearTitle,
    /// The declared duration is wrong: remux.
    SegmentDuration,
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
            | Self::SegmentDuration
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

impl From<LevelOut> for OptimizeLevel {
    fn from(l: LevelOut) -> Self {
        match l {
            LevelOut::Metadata => Self::Metadata,
            LevelOut::Remux => Self::Remux,
            LevelOut::Reencode => Self::Reencode,
        }
    }
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

fn stream(plan: &mut OptimizePlan, index: u32) -> &mut StreamPlan {
    let at = match plan.streams.iter().position(|s| s.stream_index == index) {
        Some(i) => i,
        None => {
            plan.streams.push(StreamPlan {
                stream_index: index,
                keep: true,
                language: None,
                title: None,
                default: None,
                encode: None,
                keep_original: false,
            });
            plan.streams.len() - 1
        }
    };
    &mut plan.streams[at]
}

impl Diff {
    /// The part of the difference the engine's plan carries: the video settings, dropped, tagged,
    /// retitled and default tracks, playable audio, OCR subtitles, container, `hvc1`, statistics
    /// tags. `extra` holds the finished OCR of an image track; without it the track stays.
    /// None when nothing of it is due.
    pub fn plan(
        &self,
        profile: &Profile,
        info: &MediaInfo,
        audio_playable: &HashSet<String>,
        extra: &[(u32, ExtraSubtitle)],
    ) -> Option<OptimizePlan> {
        let v = &profile.video;
        let mut plan = OptimizePlan {
            level: self.level.into(),
            codec: None,
            crop: None,
            streams: vec![],
            hvc1_tag: false,
            quality: None,
            software: false,
            max_software_hours: None,
            too_slow: OptimizeTooSlow::Hardware,
            min_savings_pct: None,
            skip_hdr10plus_dv: None,
            container: None,
            clear_title: false,
            extra_subtitles: vec![],
            rename: false,
        };
        let mut any = false;
        for c in &self.changes {
            any |=
                match c {
                    Change::Reencode {
                        codec,
                        crop,
                        crop_only,
                        ..
                    } => {
                        plan.codec = Some(codec.as_str().to_owned());
                        plan.crop = crop.clone();
                        plan.quality = Some(match v.quality {
                            Quality::Small => OptimizeQuality::Small,
                            Quality::Balanced => OptimizeQuality::Balanced,
                            Quality::Faithful => OptimizeQuality::Faithful,
                        });
                        plan.software = v.prefer_software;
                        plan.max_software_hours = Some(f64::from(v.software_max_hours));
                        plan.too_slow = match v.too_slow {
                            TooSlow::Hardware => OptimizeTooSlow::Hardware,
                            TooSlow::Skip => OptimizeTooSlow::Skip,
                        };
                        plan.min_savings_pct =
                            (!crop_only).then_some(f64::from(profile.guards.min_savings_pct));
                        plan.skip_hdr10plus_dv = Some(v.when.skip_hdr10plus_dv);
                        true
                    }
                    Change::Drop {
                        stream_index,
                        reason,
                        ..
                    } => {
                        // A replaced track is kept: its encode takes its place (`AddAudio`).
                        if *reason != DropReason::Replaced {
                            stream(&mut plan, *stream_index).keep = false;
                        }
                        *reason != DropReason::Replaced
                    }
                    Change::Ocr { stream_index } => {
                        match extra.iter().find(|(i, _)| i == stream_index) {
                            Some((_, e)) => {
                                stream(&mut plan, *stream_index).keep = false;
                                plan.extra_subtitles.push(e.clone());
                                true
                            }
                            None => false,
                        }
                    }
                    Change::AddAudio { source_stream } => {
                        let replaced = self.changes.iter().any(|c| {
                        matches!(c, Change::Drop { stream_index, reason: DropReason::Replaced, .. }
                            if stream_index == source_stream)
                    });
                        let eac3 = audio_playable.contains("eac3");
                        let src = info.audio.iter().find(|a| a.stream_index == *source_stream);
                        let s = stream(&mut plan, *source_stream);
                        s.encode = Some(if eac3 {
                            StreamEncode::Eac3
                        } else {
                            StreamEncode::Aac
                        });
                        s.keep_original = !replaced;
                        // The copied title and default flag would describe the source track.
                        s.title = Some(encoded_title(src, eac3));
                        if !replaced {
                            s.default = Some(false);
                        }
                        true
                    }
                    Change::Language {
                        stream_index, code, ..
                    } => {
                        let tag = fliks_domain::language::iso639_2(code).unwrap_or(code);
                        stream(&mut plan, *stream_index).language = Some(tag.to_owned());
                        true
                    }
                    Change::Default { stream_index } => {
                        for a in info.audio.iter().filter(|a| {
                            a.is_default == Some(true) && a.stream_index != *stream_index
                        }) {
                            stream(&mut plan, a.stream_index).default = Some(false);
                        }
                        stream(&mut plan, *stream_index).default = Some(true);
                        true
                    }
                    Change::Title { stream_index, .. } => {
                        stream(&mut plan, *stream_index).title = Some(String::new());
                        true
                    }
                    Change::Container { to } => {
                        plan.container = Some(if *to == "mp4" {
                            OptimizeContainer::Mp4
                        } else {
                            OptimizeContainer::Mkv
                        });
                        true
                    }
                    Change::Hvc1 => {
                        plan.hvc1_tag = true;
                        true
                    }
                    Change::StatisticsTags | Change::SegmentDuration => true,
                    Change::ClearTitle => {
                        plan.clear_title = true;
                        true
                    }
                    Change::Reorder { .. } => true,
                    Change::Flags { stream_index, .. } => {
                        for a in info.audio.iter().filter(|a| {
                            a.is_default == Some(true) && a.stream_index != *stream_index
                        }) {
                            stream(&mut plan, a.stream_index).default = Some(false);
                        }
                        true
                    }
                    Change::Rename => {
                        plan.rename = true;
                        false
                    }
                };
        }
        // Every kept stream of a reordered kind is listed, in its final order: the engine sorts by it.
        for c in &self.changes {
            if let Change::Reorder { order, .. } = c {
                for i in order {
                    stream(&mut plan, *i);
                }
                let mut at: Vec<usize> = order
                    .iter()
                    .filter_map(|i| plan.streams.iter().position(|s| s.stream_index == *i))
                    .collect();
                let entries: Vec<StreamPlan> = order
                    .iter()
                    .filter_map(|i| plan.streams.iter().find(|s| s.stream_index == *i).cloned())
                    .collect();
                at.sort_unstable();
                for (slot, e) in at.into_iter().zip(entries) {
                    plan.streams[slot] = e;
                }
            }
        }
        // Never a file without audio, whatever the changes say.
        let audio_kept = info.audio.iter().any(|a| {
            plan.streams
                .iter()
                .find(|s| s.stream_index == a.stream_index)
                .is_none_or(|s| s.keep)
        });
        (any && (info.audio.is_empty() || audio_kept)).then_some(plan)
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
        let matches_when = self.env.force
            || (when.codec.is_empty()
                || src_codec.is_some_and(|c| when.codec.iter().any(|w| w == c)))
                && when
                    .min_bitrate
                    .is_none_or(|m| bitrate.is_some_and(|b| b >= m))
                && (!when.only_if_transcoding_here || self.f.transcoded_recently);
        let max_h = v
            .max_resolution
            .height()
            .filter(|h| src.height.is_some_and(|sh| sh > *h));
        let improving = self
            .env
            .target
            .filter(|t| self.env.force || codec::improves(*t, &src.codec));
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
        if self.f.video_copied && !self.env.force && !crop_only {
            return false;
        }
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
                let marks = audio_markers(&serde_json::to_value(t).unwrap_or_default());
                if marks.contains(&Marker::Commentary) && p.drop.iter().any(|d| d == "commentary") {
                    Some(DropReason::Commentary)
                } else if marks.contains(&Marker::AudioDescription)
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
                reason[j].is_none()
                    && langs[j] == langs[i]
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
                    order: order.iter().map(|i| info.audio[*i].stream_index).collect(),
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
                && (self.env.force || !self.f.ocr_failed.contains(&t.stream_index))
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
                let mut sorted = kept.clone();
                sorted.sort_by_key(|t| rank(t));
                self.changes.push(Change::Reorder {
                    kind: TrackKind::Subtitle,
                    order: sorted.iter().map(|t| t.stream_index).collect(),
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
        let stem = path.rsplit('/').next().unwrap_or("");
        let stem = stem.rsplit_once('.').map_or(stem, |(s, _)| s);
        if info
            .tags
            .as_ref()
            .and_then(|t| t.title.as_deref())
            .is_some_and(|t| {
                let r = parse_release_attributes(t);
                t == stem
                    || r.resolution > 0
                    || r.video_codec.is_some()
                    || r.source.is_some()
                    || r.release_group.is_some()
            })
        {
            self.changes.push(Change::ClearTitle);
        }
        // A Matroska whose declared duration is off the latest stream end: a remux writes it right.
        let end = info
            .video
            .iter()
            .filter_map(|v| v.end_seconds)
            .chain(info.audio.iter().filter_map(|a| a.end_seconds))
            .fold(None, |m: Option<f64>, e| Some(m.map_or(e, |m| m.max(e))));
        if is_mkv(info, path)
            && info
                .duration_seconds
                .zip(end)
                .is_some_and(|(d, e)| (d - e).abs() > 1.0)
        {
            self.changes.push(Change::SegmentDuration);
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
        let dropped = |i: u32| {
            self.changes.iter().any(|c| {
                matches!(c, Change::Drop { stream_index, kind: TrackKind::Audio, .. } if *stream_index == i)
            })
        };
        let mp4_unfit = kept_subs.iter().any(|c| {
            matches!(
                c.as_str(),
                "ass" | "ssa" | "hdmv_pgs_subtitle" | "dvd_subtitle"
            )
        }) || self.f.info.audio.iter().any(|a| {
            let c = a.codec.to_ascii_lowercase();
            !dropped(a.stream_index) && (c == "truehd" || c == "mlp" || c.starts_with("pcm_"))
        }) || self.f.info.video.len() > 1;
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
        let rewriting = self
            .changes
            .iter()
            .any(|c| matches!(c, Change::Reencode { .. } | Change::Container { .. }));
        // A name alone never starts a job: the plan has nothing else to write.
        if rewriting
            && (name_wrong
                || self
                    .changes
                    .iter()
                    .any(|c| matches!(c, Change::Container { .. })))
        {
            self.changes.push(Change::Rename);
        }
    }
}

/// "<language> <layout> <codec>" of an encoded track; the engine keeps the source's channels.
fn encoded_title(src: Option<&fliks_engine_core::api::AudioStreamInfo>, eac3: bool) -> String {
    let layout = match src.and_then(|a| a.channels) {
        Some(1) => "Mono".to_owned(),
        Some(2) | None => "Stereo".to_owned(),
        Some(6) => "5.1".to_owned(),
        Some(8) => "7.1".to_owned(),
        Some(n) => format!("{n}ch"),
    };
    let lang = src.map_or("", |a| a.language.as_str());
    let codec = if eac3 { "E-AC3" } else { "AAC" };
    format!("{lang} {layout} {codec}").trim_start().to_owned()
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
            is_default: Some(i == 1),
            has_statistics_tags: Some(true),
            ..Default::default()
        }
    }

    fn info(video: &str, audio: Vec<AudioStreamInfo>) -> MediaInfo {
        MediaInfo {
            video: vec![VideoStreamInfo {
                codec: video.into(),
                width: Some(1920),
                height: Some(1080),
                has_statistics_tags: Some(true),
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
            force: false,
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
            ocr_failed: &[],
            video_copied: false,
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
            force: false,
        };
        let l = Languages::default();
        let mut f = File {
            relative_path: "a.mkv",
            info: &i,
            probe_version: Some(PROBE_VERSION - 1),
            age_days: 30,
            languages: &l,
            transcoded_recently: false,
            ocr_failed: &[],
            video_copied: false,
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
            ..info("mpeg2video", vec![audio(1, "eng", "ac3", 2)])
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
            force: false,
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
            ocr_failed: &[],
            video_copied: false,
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

    #[test]
    fn the_plan_carries_drops_and_language_tags_and_nothing_for_unsupported_changes() {
        let mut c = audio(2, "eng", "aac", 2);
        c.commentary = Some(true);
        let two = info("hevc", vec![audio(1, "eng", "eac3", 6), c]);
        let profile = Preset::CleanupOnly.document();
        let none = HashSet::new();
        let plan = diff(run(Preset::CleanupOnly, "a.mkv", &two, Some("en")))
            .plan(&profile, &two, &none, &[])
            .unwrap();
        assert!(plan.streams.iter().any(|s| s.stream_index == 2 && !s.keep));
        let lone = info("hevc", vec![audio(1, "und", "eac3", 6)]);
        let plan = diff(run(Preset::CleanupOnly, "a.mkv", &lone, Some("fr")))
            .plan(&profile, &lone, &none, &[])
            .unwrap();
        assert!(
            plan.streams
                .iter()
                .any(|s| s.stream_index == 1 && s.language.as_deref() == Some("fra"))
        );
        let reorder_only = Diff {
            level: LevelOut::Remux,
            changes: vec![Change::Reorder {
                kind: TrackKind::Audio,
                order: vec![1],
            }],
            warnings: vec![],
        };
        assert_eq!(
            reorder_only
                .plan(&profile, &lone, &none, &[])
                .map(|p| p.streams.len()),
            Some(1)
        );
    }

    #[test]
    fn the_plan_carries_the_profile_video_settings_container_and_defaults() {
        let mut profile = Preset::Balanced.document();
        profile.video.prefer_software = true;
        profile.video.too_slow = TooSlow::Skip;
        let mut a = audio(1, "eng", "aac", 2);
        a.is_default = Some(true);
        let b = audio(2, "fra", "aac", 2);
        let i = info("h264", vec![a, b]);
        let d = Diff {
            level: LevelOut::Reencode,
            changes: vec![
                Change::Reencode {
                    codec: Target::Hevc,
                    bit_depth: 8,
                    crop: None,
                    max_height: None,
                    crop_only: false,
                },
                Change::Default { stream_index: 2 },
                Change::Container { to: "mkv" },
            ],
            warnings: vec![],
        };
        let p = d.plan(&profile, &i, &HashSet::new(), &[]).unwrap();
        assert!(p.software && p.too_slow == OptimizeTooSlow::Skip);
        assert_eq!(p.min_savings_pct, Some(20.0));
        assert_eq!(p.container, Some(OptimizeContainer::Mkv));
        let default = |n| {
            p.streams
                .iter()
                .find(|s| s.stream_index == n)
                .unwrap()
                .default
        };
        assert_eq!((default(1), default(2)), (Some(false), Some(true)));
    }

    #[test]
    fn a_video_copied_by_an_earlier_job_is_not_re_encoded_again() {
        let profile = Preset::Balanced.document();
        let playable: HashSet<String> = ["aac"].map(String::from).into();
        let env = Env {
            profile: &profile,
            allow_rename: false,
            target: Some(Target::Hevc),
            audio_playable: &playable,
            force: false,
        };
        let i = info("h264", vec![audio(1, "eng", "aac", 2)]);
        let languages = Languages::default();
        let mk = |video_copied, ocr_failed: &'static [u32]| File {
            relative_path: "a.mkv",
            info: &i,
            probe_version: Some(PROBE_VERSION),
            age_days: 30,
            languages: &languages,
            transcoded_recently: false,
            ocr_failed,
            video_copied,
        };
        assert!(matches!(compute(&env, &mk(false, &[])), Outcome::Diff(_)));
        assert!(matches!(
            compute(&env, &mk(true, &[])),
            Outcome::Conform { .. }
        ));
    }

    #[test]
    fn a_reorder_lists_the_kept_streams_in_their_final_order_and_flags_clear_the_extra_defaults() {
        let profile = Preset::Balanced.document();
        let mut a = audio(1, "eng", "aac", 2);
        a.is_default = Some(true);
        let mut b = audio(2, "fra", "aac", 2);
        b.is_default = Some(true);
        let i = info("hevc", vec![a, b, audio(3, "deu", "aac", 2)]);
        let none = HashSet::new();
        let d = Diff {
            level: LevelOut::Remux,
            changes: vec![
                Change::Reorder {
                    kind: TrackKind::Audio,
                    order: vec![3, 1, 2],
                },
                Change::Flags {
                    kind: TrackKind::Audio,
                    stream_index: 1,
                },
            ],
            warnings: vec![],
        };
        let p = d.plan(&profile, &i, &none, &[]).unwrap();
        let order: Vec<u32> = p.streams.iter().map(|s| s.stream_index).collect();
        assert_eq!(order, [3, 1, 2]);
        let s2 = p.streams.iter().find(|s| s.stream_index == 2).unwrap();
        assert_eq!(s2.default, Some(false));
    }

    #[test]
    fn matroska_only_audio_keeps_the_file_out_of_mp4() {
        let i = info("h264", vec![audio(1, "eng", "truehd", 8)]);
        // The only container that holds TrueHD is MKV, which needs the rename permission.
        assert!(matches!(
            run(Preset::Balanced, "a.mp4", &i, Some("en")),
            Outcome::Skipped {
                why: Skipped::Container
            }
        ));
    }

    #[test]
    fn an_added_track_is_titled_and_never_default() {
        let profile = Preset::Balanced.document();
        let i = info("h264", vec![audio(1, "eng", "dts", 8)]);
        let playable: HashSet<String> = ["eac3".to_owned()].into();
        let d = Diff {
            level: LevelOut::Remux,
            changes: vec![Change::AddAudio { source_stream: 1 }],
            warnings: vec![],
        };
        let s = d
            .plan(&profile, &i, &playable, &[])
            .unwrap()
            .streams
            .remove(0);
        assert!(s.keep_original);
        assert_eq!(s.default, Some(false));
        assert_eq!(s.title.as_deref(), Some("eng 7.1 E-AC3"));
    }

    #[test]
    fn replacing_a_lossless_track_encodes_it_in_place_and_never_leaves_the_file_silent() {
        let mut profile = Preset::Balanced.document();
        profile.audio.incompatible = Incompatible::Replace;
        let i = info("h264", vec![audio(1, "eng", "dts", 6)]);
        let playable: HashSet<String> = ["eac3".to_owned()].into();
        let d = Diff {
            level: LevelOut::Remux,
            changes: vec![
                Change::AddAudio { source_stream: 1 },
                Change::Drop {
                    kind: TrackKind::Audio,
                    stream_index: 1,
                    language: Some("en".into()),
                    reason: DropReason::Replaced,
                },
            ],
            warnings: vec![],
        };
        let p = d.plan(&profile, &i, &playable, &[]).unwrap();
        let s = &p.streams[0];
        assert!(s.keep && s.encode == Some(StreamEncode::Eac3) && !s.keep_original);
        assert_eq!(s.title.as_deref(), Some("eng 5.1 E-AC3"));
        assert_eq!(s.default, None, "a replacing encode keeps the source flag");
        assert!(!title_contradicts(
            s.title.as_deref().unwrap(),
            "eac3",
            Some(6)
        ));
        let only_drop = Diff {
            changes: vec![Change::Drop {
                kind: TrackKind::Audio,
                stream_index: 1,
                language: None,
                reason: DropReason::Language,
            }],
            ..d
        };
        assert!(only_drop.plan(&profile, &i, &playable, &[]).is_none());
    }

    #[test]
    fn missing_statistics_tags_and_a_wrong_duration_are_found_in_matroska() {
        let mut i = info("hevc", vec![audio(1, "eng", "eac3", 6)]);
        i.video[0].has_statistics_tags = Some(false);
        let d = diff(run(Preset::Balanced, "a.mkv", &i, Some("en")));
        assert!(d.changes.contains(&Change::StatisticsTags));
        d.plan(&Preset::Balanced.document(), &i, &HashSet::new(), &[])
            .unwrap();
        let mut j = info("hevc", vec![audio(1, "eng", "eac3", 6)]);
        j.duration_seconds = Some(7200.0);
        j.video[0].end_seconds = Some(5400.0);
        let d = diff(run(Preset::Balanced, "a.mkv", &j, Some("en")));
        assert_eq!(
            (d.level, &d.changes[..]),
            (LevelOut::Remux, &[Change::SegmentDuration][..])
        );
    }

    #[test]
    fn a_release_name_as_global_title_is_cleared() {
        let mut i = info("hevc", vec![audio(1, "eng", "eac3", 6)]);
        i.tags = Some(fliks_engine_core::api::MediaTags {
            title: Some("Movie.2020.1080p.BluRay.x264-GRP".into()),
            ..Default::default()
        });
        let d = diff(run(Preset::Balanced, "a.mkv", &i, Some("en")));
        assert_eq!(
            (d.level, &d.changes[..]),
            (LevelOut::Metadata, &[Change::ClearTitle][..])
        );
        i.tags.as_mut().unwrap().title = Some("A Real Title".into());
        assert!(matches!(
            run(Preset::Balanced, "a.mkv", &i, Some("en")),
            Outcome::Conform { .. }
        ));
    }

    #[test]
    fn a_commentary_known_by_its_title_is_dropped() {
        let mut c = audio(2, "eng", "aac", 2);
        c.title = Some("Director's Commentary".into());
        let i = info("hevc", vec![audio(1, "eng", "eac3", 6), c]);
        let d = diff(run(Preset::Balanced, "a.mkv", &i, Some("en")));
        assert!(d.changes.iter().any(|c| matches!(
            c,
            Change::Drop {
                stream_index: 2,
                reason: DropReason::Commentary,
                ..
            }
        )));
    }
}

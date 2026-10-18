//! Track markers of the player menus: the probed dispositions, the codec profile, then the title.
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Marker {
    Forced,
    HearingImpaired,
    Commentary,
    AudioDescription,
    Descriptions,
    Original,
    Dub,
    MusicAndEffects,
    Karaoke,
    Lyrics,
    Atmos,
    DtsX,
}

fn title_re(words: &str) -> Regex {
    Regex::new(&format!(r"(?i)\b(?:{words})\b")).expect("title regex")
}

static COMMENTARY: LazyLock<Regex> = LazyLock::new(|| title_re("commentar(?:y|ies)|commentaires?"));
static AUDIO_DESCRIPTION: LazyLock<Regex> = LazyLock::new(|| {
    title_re(r"audio[\s._-]?descri(?:ption|bed)|description[\s._-]audio|ad|malvoyants?")
});
static SDH: LazyLock<Regex> = LazyLock::new(|| {
    title_re(r"sdh|cc|sme|hearing[\s._-]?impaired|closed[\s._-]?captions?|sourds|malentendants")
});
static FORCED: LazyLock<Regex> = LazyLock::new(|| title_re("forced|forcée?s?"));
static NOT_FORCED: LazyLock<Regex> =
    LazyLock::new(|| title_re(r"(?:non|not)[\s._-]?forc(?:ed|ée?s?)"));

fn flag(s: &Value, key: &str) -> bool {
    s.get(key).and_then(Value::as_bool) == Some(true)
}

fn title_has(s: &Value, re: &Regex) -> bool {
    s.get("title")
        .and_then(Value::as_str)
        .is_some_and(|t| re.is_match(t))
}

/// An audio entry of `streamInfo.audio`.
pub fn audio_markers(s: &Value) -> Vec<Marker> {
    let profile = s
        .get("profile")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    [
        (Marker::HearingImpaired, flag(s, "hearingImpaired")),
        (
            Marker::Commentary,
            flag(s, "commentary") || title_has(s, &COMMENTARY),
        ),
        (
            Marker::AudioDescription,
            flag(s, "audioDescription") || title_has(s, &AUDIO_DESCRIPTION),
        ),
        (Marker::Original, flag(s, "original")),
        (Marker::Dub, flag(s, "dub")),
        (Marker::MusicAndEffects, flag(s, "cleanEffects")),
        (Marker::Karaoke, flag(s, "karaoke")),
        (Marker::Atmos, profile.contains("atmos")),
        (Marker::DtsX, profile.contains("dts:x")),
    ]
    .into_iter()
    .filter_map(|(m, on)| on.then_some(m))
    .collect()
}

/// A subtitle entry of `streamInfo.subtitles`.
pub fn subtitle_markers(s: &Value) -> Vec<Marker> {
    let forced = flag(s, "forced") || title_has(s, &FORCED) && !title_has(s, &NOT_FORCED);
    [
        (Marker::Forced, forced),
        (
            Marker::HearingImpaired,
            flag(s, "hearingImpaired") || title_has(s, &SDH),
        ),
        (
            Marker::Commentary,
            flag(s, "commentary") || title_has(s, &COMMENTARY),
        ),
        (Marker::Descriptions, flag(s, "descriptions")),
        (Marker::Lyrics, flag(s, "lyrics")),
    ]
    .into_iter()
    .filter_map(|(m, on)| on.then_some(m))
    .collect()
}

/// Adds `markers` to every audio and subtitle entry of a `streamInfo` blob.
pub fn annotate(info: &mut Value) {
    for (key, derive) in [
        ("audio", audio_markers as fn(&Value) -> Vec<Marker>),
        ("subtitles", subtitle_markers),
    ] {
        let Some(list) = info.get_mut(key).and_then(Value::as_array_mut) else {
            continue;
        };
        for s in list {
            let m = serde_json::to_value(derive(s)).expect("markers");
            if let Some(o) = s.as_object_mut() {
                o.insert("trackMarkers".into(), m);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Marker::*;
    use serde_json::json;

    #[test]
    fn audio_flags_and_profile() {
        let s = json!({"codec": "eac3", "profile": "Dolby Digital Plus + Dolby Atmos",
            "commentary": true, "audioDescription": true, "hearingImpaired": true, "original": true,
            "dub": true, "cleanEffects": true, "karaoke": true});
        assert_eq!(
            audio_markers(&s),
            [
                HearingImpaired,
                Commentary,
                AudioDescription,
                Original,
                Dub,
                MusicAndEffects,
                Karaoke,
                Atmos
            ]
        );
        assert_eq!(
            audio_markers(&json!({"profile": "Dolby TrueHD + Dolby Atmos"})),
            [Atmos]
        );
        assert_eq!(
            audio_markers(&json!({"profile": "DTS-HD MA + DTS:X"})),
            [DtsX]
        );
        assert_eq!(
            audio_markers(&json!({"profile": "DTS-HD MA", "commentary": false})),
            []
        );
    }

    #[test]
    fn audio_title_fallback_en_fr() {
        let t = |title: &str| audio_markers(&json!({ "title": title }));
        assert_eq!(t("Commentary by director Jane Doe"), [Commentary]);
        assert_eq!(t("Commentaire du réalisateur"), [Commentary]);
        assert_eq!(t("Audio Description"), [AudioDescription]);
        assert_eq!(t("English AD"), [AudioDescription]);
        assert_eq!(t("Audiodescription"), [AudioDescription]);
        assert_eq!(t("Français (malvoyants)"), [AudioDescription]);
        assert_eq!(t("Advanced mix"), []);
        assert_eq!(t("English DDP 5.1"), []);
    }

    #[test]
    fn subtitle_flags_and_title_fallback() {
        let s = json!({"forced": true, "hearingImpaired": true, "commentary": true,
            "descriptions": true, "lyrics": true});
        assert_eq!(
            subtitle_markers(&s),
            [Forced, HearingImpaired, Commentary, Descriptions, Lyrics]
        );
        let t = |title: &str| subtitle_markers(&json!({ "title": title, "forced": false }));
        assert_eq!(t("English SDH"), [HearingImpaired]);
        assert_eq!(t("Français (sourds et malentendants)"), [HearingImpaired]);
        assert_eq!(t("Forced"), [Forced]);
        assert_eq!(t("Français forcés"), [Forced]);
        assert_eq!(t("Sous-titres forcée"), [Forced]);
        assert_eq!(t("VF forcées"), [Forced]);
        assert_eq!(t("Version non forcées"), []);
        assert_eq!(t("Non-Forced"), []);
        assert_eq!(t("Français non forcés"), []);
        assert_eq!(t("Commentary"), [Commentary]);
        assert_eq!(t("Accented"), []);
    }

    #[test]
    fn annotate_adds_markers_to_every_track() {
        let mut info = json!({"audio": [{"title": "Commentary"}, {}], "subtitles": [{"forced": true}],
            "video": [{}]});
        annotate(&mut info);
        assert_eq!(info["audio"][0]["trackMarkers"], json!(["commentary"]));
        assert_eq!(info["audio"][1]["trackMarkers"], json!([]));
        assert_eq!(info["subtitles"][0]["trackMarkers"], json!(["forced"]));
        assert!(info["video"][0].get("trackMarkers").is_none());
        annotate(&mut json!({"error": "x"}));
    }
}

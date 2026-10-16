//! Golden vectors of the subtitle text helpers (`fixtures/subtitle-files/cases.json`).
mod common;

use common::replay;
use fliks_domain::{
    srt::{parse_srt, serialize_srt},
    subtitle_clean::{CleanOptions, clean_subtitle},
    subtitle_flags::*,
    subtitle_name::{resolve_language_code, strip_hi_from_filename},
    subtitle_path::*,
    subtitle_post as post,
};
use serde_json::{Value, json};

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn mode(v: &Value) -> Option<HiMode> {
    serde_json::from_value(v.clone()).ok()
}

fn flags(v: &Value) -> Flags {
    Flags {
        forced: v["forced"].as_bool().unwrap(),
        hearing_impaired: v["hearingImpaired"].as_bool().unwrap(),
    }
}

fn request(v: &Value) -> RequestFlags {
    RequestFlags {
        forced: v["forced"].as_bool(),
        hearing_impaired_mode: mode(&v["hearingImpairedMode"]),
    }
}

#[test]
fn subtitle_files_reproduce_expected() {
    replay("subtitle-files", 867, |i| match s(&i["fn"]) {
        "cleanSubtitle" => json!(clean_subtitle(
            s(&i["content"]),
            &CleanOptions {
                remove_ads: i["removeAds"].as_bool().unwrap(),
                remove_hi_tags: i["removeHiTags"].as_bool().unwrap(),
                custom_exclusions: i["customExclusions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| s(p).to_owned())
                    .collect(),
            }
        )),
        "removeStyleTags" => json!(post::remove_style_tags(s(&i["content"]))),
        "removeEmoji" => json!(post::remove_emoji(s(&i["content"]))),
        "fixOcr" => json!(post::fix_ocr(s(&i["content"]))),
        "fixUppercase" => json!(post::fix_uppercase(s(&i["content"]))),
        "reverseRtl" => json!(post::reverse_rtl(s(&i["content"]))),
        "assToSrt" => json!(post::ass_to_srt(s(&i["content"]))),
        "commonFixes" => json!(post::common_fixes(s(&i["content"]), i["language"].as_str())),
        "adjustTimes" => json!(post::adjust_times(
            s(&i["content"]),
            i["offsetMs"].as_f64().unwrap()
        )),
        "changeFrameRate" => json!(post::change_frame_rate(
            s(&i["content"]),
            i["fromFps"].as_f64().unwrap(),
            i["toFps"].as_f64().unwrap()
        )),
        "sidecarLangSuffix" => json!(sidecar_lang_suffix(
            s(&i["lang"]),
            i["forced"].as_bool().unwrap(),
            i["hi"].as_bool().unwrap()
        )),
        "assertSafeLangSuffix" => json!(is_safe_lang_suffix(s(&i["suffix"]))),
        "resolveSubtitleAbsolutePath" => {
            json!(resolve_subtitle_absolute_path(
                s(&i["root"]),
                s(&i["stored"])
            ))
        }
        "relativePathUnderMediaRoot" => {
            json!(relative_path_under_root(s(&i["root"]), s(&i["file"])))
        }
        "stripHiFromFilename" => json!(strip_hi_from_filename(s(&i["name"]))),
        "resolveLanguageCode" => json!(resolve_language_code(s(&i["token"]))),
        "matchesRequestedFlags" => json!(matches_requested_flags(
            flags(&i["sub"]),
            request(&i["req"])
        )),
        "prefersHearingImpaired" => json!(prefers_hearing_impaired(request(&i["req"]))),
        "requestFlagsOf" => {
            let item: LanguageItem = serde_json::from_value(i["item"].clone()).unwrap();
            let r = item.request_flags();
            json!({
                "forced": r.forced,
                "hearingImpairedMode": r.hearing_impaired_mode.map(|m| format!("{m:?}").to_lowercase()),
            })
        }
        "hasCoveringSub" => {
            let item: LanguageItem = serde_json::from_value(i["item"].clone()).unwrap();
            let subs: Vec<Servable> = i["subs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| Servable {
                    language: s(&v["language"]),
                    forced: v["forced"].as_bool().unwrap(),
                    hearing_impaired: v["hearingImpaired"].as_bool().unwrap(),
                    codec: v["codec"].as_str(),
                    status: v["status"].as_str(),
                })
                .collect();
            json!(has_covering_sub(
                &subs,
                &item,
                i["imageTracksCount"].as_bool().unwrap()
            ))
        }
        "parseSrt" => Value::Array(
            parse_srt(s(&i["content"]))
                .into_iter()
                .map(|c| json!({"timing": c.timing, "text": c.text}))
                .collect(),
        ),
        _ => json!(serialize_srt(&parse_srt(s(&i["content"])))),
    });
}

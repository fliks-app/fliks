//! Golden release-parsing vectors (`fixtures/release-parsing`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::language::APP_LANGUAGES;
use fliks_domain::release::parsing::attributes::parse_release_attributes;
use fliks_domain::release::parsing::language::{parse_release_language, resolve_unknown_language};
use fliks_domain::release::parsing::quality_from_resolution::*;
use fliks_domain::release::parsing::season_episode::*;
use fliks_domain::release::parsing::title::*;
use serde_json::{Value, json};

#[test]
fn release_parsing_reproduces_expected() {
    replay("release-parsing", 3435, |i| {
        let s = |k: &str| i[k].as_str().unwrap();
        let dim = |k: &str| i[k].as_f64();
        match s("fn") {
            "parseSeasonEpisode" => json!(parse_season_episode(s("title"))),
            "releaseCoverage" => json!(release_coverage(s("title"))),
            "within" => {
                let r: Span = serde_json::from_value(i["range"].clone()).unwrap();
                json!(within(&r, i["n"].as_i64().unwrap()))
            }
            "parseReleaseAttributes" => json!(parse_release_attributes(s("title"))),
            "parseReleaseLanguage" => json!(parse_release_language(s("title"))),
            "resolveUnknownLanguage" => {
                let id = i["id"].as_u64().unwrap() as u32;
                let parsed = APP_LANGUAGES.iter().find(|l| l.id == id).unwrap();
                json!(resolve_unknown_language(parsed, i["iso"].as_str()))
            }
            "extractMediaTitle" => json!(extract_media_title(s("name"))),
            "decodeHtmlEntities" => json!(decode_html_entities(s("s"))),
            "qualityFromResolution" => {
                json!(quality_from_resolution(
                    s("text"),
                    dim("width"),
                    dim("height")
                ))
            }
            "bucketResolutionHeight" => {
                json!(bucket_resolution_height(dim("width"), dim("height")))
            }
            f => Value::String(format!("unknown fn {f}")),
        }
    });
}

#[test]
fn surrogate_code_points_decode_to_the_replacement_character() {
    assert_eq!(
        decode_html_entities("a&#55296;b&#xDFFF;"),
        "a\u{fffd}b\u{fffd}"
    );
}

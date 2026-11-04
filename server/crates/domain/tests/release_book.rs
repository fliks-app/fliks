//! Golden audio and text release vectors (`fixtures/release-audio`, `release-text`, `release-book-scoring`, `audio-qualities`, `text-qualities`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::media::family::Family;
use fliks_domain::release::audio::quality::*;
use fliks_domain::release::image::quality::*;
use fliks_domain::release::scoring::*;
use fliks_domain::release::text::quality::*;
use serde_json::{Map, Value, json};

#[test]
fn audio_releases_reproduce_expected() {
    replay("release-audio", 57, |i| {
        json!(parse_audio_release(i["title"].as_str().unwrap()))
    });
}

#[test]
fn text_releases_reproduce_expected() {
    replay("release-text", 52, |i| {
        json!(parse_text_release(i["title"].as_str().unwrap()))
    });
}

#[test]
fn comic_releases_reproduce_expected() {
    replay("release-comics", 29, |i| {
        json!(parse_image_release(i["title"].as_str().unwrap()))
    });
}

#[test]
fn quality_tables_reproduce_expected() {
    replay("image-qualities", 1, |_| json!(IMAGE_QUALITIES));
    replay("audio-qualities", 1, |_| json!(AUDIO_QUALITIES));
    replay("text-qualities", 1, |_| json!(TEXT_QUALITIES));
}

/// `[[key, value], ...]` to `{key: value}`, which serde reads into a `BTreeMap`.
fn maps(v: &Value, keys: &[&str]) -> Value {
    let mut v = v.clone();
    for k in keys {
        if let Some(pairs) = v[*k].as_array() {
            let obj: Map<String, Value> = pairs
                .iter()
                .map(|p| (p[0].to_string(), p[1].clone()))
                .collect();
            v[*k] = Value::Object(obj);
        }
    }
    v
}

#[test]
fn book_scoring_reproduces_expected() {
    replay("release-book-scoring", 9, |i| {
        let family = Family::parse(i["family"].as_str().unwrap()).unwrap();
        let opts: BookScoreOptions = serde_json::from_value(maps(
            &i["opts"],
            &["sizeByQuality", "sourceMinSeeders", "sourceUnknownLang"],
        ))
        .unwrap();
        let pairs = |k: &str| i[k].as_array().unwrap().clone();
        let (scores, blocked) = (pairs("customFormatScores"), pairs("blocked"));
        let releases: Vec<ReleaseCandidate> =
            serde_json::from_value(i["releases"].clone()).unwrap();
        let out = score_and_sort_book_releases(
            family,
            releases,
            &opts,
            &|t, _| {
                scores
                    .iter()
                    .find(|p| p[0] == t)
                    .map_or(0, |p| p[1].as_i64().unwrap())
            },
            &|t, s| blocked.iter().any(|p| p[0] == t && p[1] == s),
        );
        json!(out)
    });
}

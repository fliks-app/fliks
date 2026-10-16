//! Golden release-quality vectors (`fixtures/release-quality`, `fixtures/app-qualities`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::release::parsing::quality::*;
use serde_json::{Value, json};

#[test]
fn release_quality_reproduces_expected() {
    replay("release-quality", 746, |i| {
        match i["fn"].as_str().unwrap() {
            "parseReleaseQuality" => {
                json!(parse_release_quality(i["title"].as_str().unwrap()))
            }
            "rankFromQualityString" => json!(rank_from_quality_string(i["quality"].as_str())),
            _ => app_quality_by_id(i["id"].as_i64().unwrap()).map_or(Value::Null, |q| json!(q)),
        }
    });
}

#[test]
fn app_qualities_reproduces_expected() {
    replay("app-qualities", 1, |_| json!(APP_QUALITIES));
}

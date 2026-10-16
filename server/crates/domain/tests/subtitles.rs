//! Golden subtitle-name vectors (`fixtures/subtitles/cases.json`, `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::subtitle_name::*;
use serde_json::{Value, json};

#[test]
fn subtitles_reproduce_expected() {
    replay("subtitles", 338, |i| match i["fn"].as_str().unwrap() {
        "parseSubtitleFilename" => match parse_subtitle_filename(i["name"].as_str().unwrap()) {
            Some(p) => json!({
                "language": p.language,
                "forced": p.forced,
                "hearingImpaired": p.hearing_impaired,
                "hiPart": p.hi_part,
            }),
            None => Value::Null,
        },
        _ => {
            let (media, dir) = (i["mediaPath"].as_str().unwrap(), i["dir"].as_str().unwrap());
            let files: Vec<(&str, bool)> = i["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| {
                    let rel = f.as_str().unwrap();
                    let parent = format!("{media}/{rel}");
                    (rel, parent.rsplit_once('/').unwrap().0 == dir)
                })
                .collect();
            let hit = match_subtitle_video(
                i["entry"].as_str().unwrap(),
                &files,
                i["hasOwnFolder"].as_bool().unwrap(),
            );
            json!(hit)
        }
    });
}

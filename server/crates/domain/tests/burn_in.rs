//! Golden burn-in vectors (`fixtures/burn-in/cases.json`, `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::burn_in::*;
use serde_json::{Value, json};

fn list(i: &Value) -> Value {
    let embedded: Vec<EmbeddedSubtitle> = serde_json::from_value(i["embedded"].clone()).unwrap();
    // A failing external query keeps the embedded results.
    let external: Vec<ExternalSubtitle> = if i["externalFails"] == true {
        vec![]
    } else {
        serde_json::from_value(i["external"].clone()).unwrap()
    };
    serde_json::to_value(text_subtitle_renditions(&embedded, &external)).unwrap()
}

#[test]
fn burn_in_reproduces_expected() {
    replay("burn-in", 133, |i| match i["fn"].as_str().unwrap() {
        "atCueTime" => json!(at_cue_time(
            i["filter"].as_str().unwrap(),
            i["offset"].as_f64().unwrap_or(0.0)
        )),
        "buildFilter" => {
            let info: BurnInInfo = serde_json::from_value(i["info"].clone()).unwrap();
            json!(build_filter(&info))
        }
        "listTextSubtitleRenditions" => list(i),
        f => panic!("fn {f}"),
    });
}

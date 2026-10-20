//! Golden burn-in filter vectors (`fixtures/burn-in/cases.json`) replayed against the engine.
use fliks_engine_core::jobs::subtitles::{BurnInSource, at_cue_time, burn_in_filter};
use serde_json::{Value, json};

fn run(i: &Value) -> Value {
    match i["fn"].as_str().unwrap() {
        "atCueTime" => json!(at_cue_time(
            i["filter"].as_str().unwrap(),
            i["offset"].as_f64().unwrap_or(0.0)
        )),
        "buildFilter" => {
            // The engine names the embedded `si` ordinal `streamIndex`.
            let mut info = i["info"].clone();
            if let Some(o) = info
                .as_object_mut()
                .and_then(|m| m.remove("subtitleOrdinal"))
            {
                info["streamIndex"] = o;
            }
            let src: BurnInSource = serde_json::from_value(info).unwrap();
            json!(burn_in_filter(&src))
        }
        _ => Value::Null,
    }
}

#[test]
fn burn_in_filter_reproduces_expected() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/burn-in/cases.json"
    );
    let root: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases: Vec<&Value> = root["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| matches!(c["input"]["fn"].as_str(), Some("atCueTime" | "buildFilter")))
        .collect();
    // Together with the 39 `listTextSubtitleRenditions` cases of fliks_domain: the 133 recorded.
    assert_eq!(cases.len(), 94);
    let failed: Vec<String> = cases
        .iter()
        .filter(|c| run(&c["input"]) != c["expected"])
        .map(|c| {
            format!(
                "{} got {} expected {}",
                c["input"],
                run(&c["input"]),
                c["expected"]
            )
        })
        .collect();
    assert!(
        failed.is_empty(),
        "{} fail:\n{}",
        failed.len(),
        failed.join("\n")
    );
}

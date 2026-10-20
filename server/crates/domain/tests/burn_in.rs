//! Golden burn-in vectors (`fixtures/burn-in/cases.json`, `BLESS=1` rewrites `expected`).
mod common;

use common::replay_where;
use fliks_domain::burn_in::*;
use serde_json::Value;

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
    // `atCueTime` (28) and `buildFilter` (66) replay in fliks-server against the engine.
    replay_where(
        "burn-in",
        39,
        |i| i["fn"] == "listTextSubtitleRenditions",
        list,
    );
}

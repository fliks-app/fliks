//! Golden custom-format vectors (`fixtures/custom-formats`, `fixtures/app-languages`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::language::APP_LANGUAGES;
use fliks_domain::release::scoring::*;
use serde_json::{Value, json};

#[test]
fn custom_formats_reproduce_expected() {
    replay("custom-formats", 2227, |i| {
        if i["fn"] == "validateTitleRegexes" {
            let specs: Vec<CustomFormatSpec> = serde_json::from_value(i["specs"].clone()).unwrap();
            return validate_title_regexes(&specs)
                .err()
                .map_or(Value::Null, Value::String);
        }
        let formats: Vec<CustomFormat> = serde_json::from_value(i["formats"].clone()).unwrap();
        let title = i["title"].as_str().unwrap();
        let flags: Vec<String> = serde_json::from_value(i["flags"].clone()).unwrap_or_default();
        json!({
            "test": test_release(&formats, title, &flags),
            "score": score_release_with(&formats, title, &flags),
        })
    });
}

#[test]
fn app_languages_reproduce_expected() {
    replay("app-languages", 1, |_| json!(&APP_LANGUAGES[..]));
}

// Documents the unbounded `title_regex` (release.md rule 50); run it by hand with `--ignored`.
#[test]
#[ignore = "no backtracking budget: this pattern runs for a very long time"]
fn catastrophic_title_regex_is_unbounded() {
    let fmt = CustomFormat {
        id: 1,
        name: "f".into(),
        score: 1,
        specs: vec![CustomFormatSpec {
            kind: "title_regex".into(),
            value: "(a+)+$".into(),
            negate: false,
            required: false,
        }],
    };
    let title = format!("{}!", "a".repeat(40));
    assert!(!matches_format(&title, &fmt, &[]));
}

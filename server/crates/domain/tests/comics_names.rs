//! Golden comic-name vectors (`fixtures/comics-names`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::comics::name;
use serde_json::json;

#[test]
fn names_reproduce_expected() {
    replay("comics-names", 35, |i| {
        json!(name::parse_path(i["path"].as_str().unwrap()))
    });
}

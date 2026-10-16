//! Golden NFO parser vectors (`fixtures/nfo`; `BLESS=1` rewrites `expected`).
mod common;

use common::replay;
use fliks_domain::nfo::parse;
use serde_json::json;

#[test]
fn nfo_reproduces_expected() {
    replay("nfo", 344, |i| json!(parse(i["xml"].as_str().unwrap())));
}

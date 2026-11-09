//! Golden `ComicInfo.xml` vectors (`fixtures/comics-info`; `BLESS=1` rewrites `expected`).
use crate::common::replay;
use fliks_domain::comics::{info, name};
use serde_json::json;

#[test]
fn info_reproduces_expected() {
    replay("comics-info", 19, |i| {
        let xml = i["xml"].as_str().unwrap();
        let n = name::parse_path(i["path"].as_str().unwrap());
        match info::parse(xml.as_bytes()) {
            Ok(c) => json!({"info": c, "resolved": info::resolve(&n, Some(&c))}),
            Err(e) => json!({"error": e, "resolved": info::resolve(&n, None)}),
        }
    });
}

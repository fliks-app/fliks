//! The static resources of the Kobo store API (`kobo.md` rule 5): the data of Calibre-Web's `NATIVE_KOBO_RESOURCES`.
use serde_json::{Map, Value};

pub fn native() -> Map<String, Value> {
    serde_json::from_str(include_str!("resources.json")).expect("resources.json is an object")
}

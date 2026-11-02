//! The identify and attach seams of books (`docs/spec/book-metadata.md`).
pub mod identify;
pub mod link;
pub mod merge;
#[cfg(test)]
mod tests;

use fliks_domain::external_id::ExternalProvider;
use serde_json::{Map, Value};

/// The namespace of a work id (`books.md` rule 11): the one provider `fetch_work` and `search` answer works for.
pub const ANCHOR: ExternalProvider = ExternalProvider::OpenLibrary;

/// `v` as a work id of the anchor.
pub(crate) fn work_id(v: &str) -> Option<String> {
    ANCHOR.normalize(v).filter(|w| w.ends_with('W'))
}

pub(crate) fn text(m: &Map<String, Value>, key: &str) -> Option<String> {
    let s = m.get(key)?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

/// The names and ids of a list of `{name, id}` (or bare names); an entry with no name is dropped.
pub(crate) fn people(m: &Map<String, Value>, key: &str) -> Vec<(String, Option<String>)> {
    let Some(Value::Array(list)) = m.get(key) else {
        return vec![];
    };
    list.iter()
        .filter_map(|v| {
            let name = v.as_str().or_else(|| v.get("name")?.as_str())?.trim();
            let id = v.get("id").and_then(Value::as_str).map(str::to_owned);
            (!name.is_empty()).then(|| (name.to_owned(), id))
        })
        .collect()
}

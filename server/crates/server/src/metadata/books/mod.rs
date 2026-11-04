//! The identify and attach seams of books (`docs/spec/book-metadata.md`).
pub mod absorb;
pub mod identify;
pub mod link;
pub mod merge;
#[cfg(test)]
mod route_tests;
pub mod routes;
#[cfg(test)]
pub(crate) mod tests;

use crate::{
    metadata::{Search, Upstream},
    state::AppState,
};
use fliks_domain::{
    external_id::{ExternalProvider, Namespace},
    media::{kind::MediaKind, wants::same_name},
    metadata::{language::Resolved, limiter::Priority},
};
use serde_json::{Map, Value};

const PAGES: u32 = 3;

/// The namespace of a work id (`books.md` rule 11): the one provider `fetch_work` and `search` answer works for.
pub const ANCHOR: Namespace = Namespace::OPENLIBRARY;

/// `v` as a work id of the anchor.
pub(crate) fn work_id(v: &str) -> Option<String> {
    ExternalProvider::OpenLibrary
        .normalize(v)
        .filter(|w| w.ends_with('W'))
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

/// The anchor's work hits (deduplicated by work id) of a book search, paged until an empty page.
async fn works_paged<'a>(
    st: &AppState,
    lang: &Resolved,
    prio: Priority,
    search: impl Fn(u32) -> Search<'a>,
    keep: impl Fn(&Map<String, Value>) -> bool,
) -> Result<Vec<Map<String, Value>>, Upstream> {
    let mut found: Vec<Map<String, Value>> = vec![];
    for page in 1..=PAGES {
        let hits = st
            .metadata
            .of(ANCHOR)
            .search(&search(page), lang, prio)
            .await?;
        if hits.is_empty() {
            break;
        }
        for r in hits.into_iter().filter_map(|h| match h {
            Value::Object(r) => Some(r),
            _ => None,
        }) {
            let Some(w) = text(&r, "externalId").and_then(|e| work_id(&e)) else {
                continue;
            };
            if keep(&r)
                && !found
                    .iter()
                    .any(|f| text(f, "externalId").and_then(|e| work_id(&e)).as_deref() == Some(&w))
            {
                found.push(r);
            }
        }
    }
    Ok(found)
}

/// The works of an author: the hits credited to `olid`, else (no id) to a person named `name`.
pub(crate) async fn author_works(
    st: &AppState,
    lang: &Resolved,
    name: &str,
    olid: Option<&str>,
    prio: Priority,
) -> Result<Vec<Map<String, Value>>, Upstream> {
    works_paged(
        st,
        lang,
        prio,
        |page| Search {
            kind: MediaKind::Book,
            query: name,
            year: None,
            title: None,
            author: Some(name),
            author_id: olid,
            isbn: None,
            language: None,
            page,
        },
        |r| {
            people(r, "authors").iter().any(|(n, id)| match olid {
                Some(o) => id.as_deref().is_some_and(|i| i.eq_ignore_ascii_case(o)),
                None => same_name(n, name),
            })
        },
    )
    .await
}

/// The works of a series: the hits whose first series is named `name`.
pub(crate) async fn series_works(
    st: &AppState,
    lang: &Resolved,
    name: &str,
    author: Option<&str>,
    prio: Priority,
) -> Result<Vec<Map<String, Value>>, Upstream> {
    works_paged(
        st,
        lang,
        prio,
        |page| Search {
            kind: MediaKind::Book,
            query: name,
            year: None,
            title: Some(name),
            author,
            author_id: None,
            isbn: None,
            language: None,
            page,
        },
        |r| {
            r.get("series")
                .and_then(|s| s.as_array()?.first()?.get("name")?.as_str())
                .is_some_and(|n| same_name(n, name))
        },
    )
    .await
}

//! Reads the records of a book and merges them per level (`book-metadata.md` rules 7-9).
use super::ANCHOR;
use crate::{
    metadata::{MetaError, Metadata},
    state::AppState,
};
use fliks_domain::{
    external_id::ExternalProvider,
    media::{family::Family, kind::MediaKind},
    metadata::{
        field::Field,
        language::Resolved,
        limiter::Priority,
        merge::{FieldOrder, Provenance, merge},
    },
};
use serde_json::{Map, Value};

pub type Records = Vec<(ExternalProvider, Map<String, Value>)>;

/// The fields the work merge writes to the work.
pub const WORK_FIELDS: [Field; 9] = [
    Field::Title,
    Field::Subtitle,
    Field::Overview,
    Field::Year,
    Field::PosterUrl,
    Field::Rating,
    Field::Authors,
    Field::Series,
    Field::ReleaseDates,
];

/// The fields the edition merge writes to the edition.
pub const EDITION_FIELDS: [Field; 9] = [
    Field::Title,
    Field::Language,
    Field::Publisher,
    Field::PageCount,
    Field::Duration,
    Field::Format,
    Field::Narrators,
    Field::Translators,
    Field::ReleaseDates,
];

pub type Merged = (Map<String, Value>, Provenance);

/// The providers that support books and have their key, in the default order.
pub fn providers(m: &Metadata) -> Vec<ExternalProvider> {
    FieldOrder::book(Family::Text, &[])
        .providers()
        .iter()
        .copied()
        .filter(|p| m.available(*p) && m.get(*p).is_some_and(|x| x.supports(MediaKind::Book)))
        .collect()
}

/// The record of every edition ref from every provider that has one; a provider that fails or does not
/// know the ref is skipped.
pub async fn edition_records(
    st: &AppState,
    refs: &[(ExternalProvider, String)],
    lang: &Resolved,
    prio: Priority,
) -> Result<Records, MetaError> {
    let mut out = vec![];
    for p in providers(&st.metadata) {
        for (ns, value) in refs {
            match st.metadata.edition(p, (*ns, value), lang, prio).await {
                Ok(Some(Value::Object(r))) => out.push((p, r)),
                Ok(_) => {}
                Err(MetaError::Upstream(e)) => {
                    tracing::warn!("{p} edition {ns}:{value} skipped: {e}");
                }
                Err(e) => return Err(e),
            }
        }
    }
    Ok(out)
}

fn only(prov: Provenance, fields: &[Field]) -> Provenance {
    prov.into_iter()
        .filter(|(f, _)| fields.contains(f))
        .collect()
}

/// The work merge (the anchor's work record and the edition records) and, when `edition_locked` is
/// given, the edition merge (the edition records alone), each with the provenance of its own fields.
pub fn levels(
    work: Map<String, Value>,
    editions: &Records,
    order: &FieldOrder,
    work_locked: &[Field],
    edition_locked: Option<&[Field]>,
) -> (Merged, Option<Merged>) {
    let mut all: Records = vec![(ANCHOR, work)];
    all.extend(editions.iter().cloned());
    let (map, prov) = merge(&all, order, work_locked);
    let edition = edition_locked.map(|locked| {
        let (map, prov) = merge(editions, order, locked);
        (map, only(prov, &EDITION_FIELDS))
    });
    ((map, only(prov, &WORK_FIELDS)), edition)
}

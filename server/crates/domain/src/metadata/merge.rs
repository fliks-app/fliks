//! The per-field merge of provider records (`metadata-orchestrator.md` rules 25-27).
use super::field::{Field, blank};
use crate::{
    external_id::{ExternalProvider, Namespace},
    media::{family::Family, kind::MediaKind},
};
use serde_json::{Map, Value};

/// The providers each field is read from, first to last: one order per kind, a few fields with their own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldOrder {
    base: Vec<Namespace>,
    fields: Vec<(Field, Vec<Namespace>)>,
}

impl FieldOrder {
    /// `first` (the season's, the media's, the library's preferred provider, most specific first),
    /// then the kind's default order. A book reads like a text edition (`FieldOrder::book`).
    pub fn new(kind: MediaKind, first: &[Namespace]) -> Self {
        match kind {
            MediaKind::Movie | MediaKind::Series => {
                Self::build(first, &[Namespace::TMDB, Namespace::TVDB], &[])
            }
            MediaKind::Book => Self::book(Family::Text, first),
        }
    }

    /// The book orders of `book-metadata.md` rule 7: identity `openlibrary`, `bnf`; description and cover
    /// `googlebooks`, `openlibrary`; series `openlibrary`, `bnf` (text) or `audible` (audio); narrators
    /// `file`, `audible`. Every field then falls back on the rest of the default order.
    pub fn book(family: Family, first: &[Namespace]) -> Self {
        use ExternalProvider::{Audible, Audnexus, Bnf, File, GoogleBooks, OpenLibrary};
        let [audible, audnexus, bnf, file, googlebooks, openlibrary] =
            [Audible, Audnexus, Bnf, File, GoogleBooks, OpenLibrary].map(Namespace::Core);
        let series: &[Namespace] = match family {
            Family::Audio => &[audible],
            _ => &[openlibrary, bnf],
        };
        let described = [googlebooks, openlibrary];
        Self::build(
            first,
            &[openlibrary, bnf, googlebooks, audible, audnexus],
            &[
                (Field::Overview, &described),
                (Field::PosterUrl, &described),
                (Field::Series, series),
                (Field::Narrators, &[file, audible]),
            ],
        )
    }

    fn build(first: &[Namespace], base: &[Namespace], own: &[(Field, &[Namespace])]) -> Self {
        let list = |head: &[Namespace]| {
            let mut order: Vec<Namespace> = vec![];
            for p in first.iter().chain(head).chain(base).copied() {
                if !order.contains(&p) {
                    order.push(p);
                }
            }
            order
        };
        Self {
            base: list(&[]),
            fields: own.iter().map(|(f, head)| (*f, list(head))).collect(),
        }
    }

    /// The order of the fields that have none of their own.
    pub fn providers(&self) -> &[Namespace] {
        &self.base
    }

    /// The order of `field`; every key no field owns reads the default one.
    pub fn providers_for(&self, field: Option<Field>) -> &[Namespace] {
        field
            .and_then(|f| self.fields.iter().find(|(o, _)| *o == f))
            .map_or(&self.base, |(_, order)| order)
    }
}

pub type Provenance = Vec<(Field, Namespace)>;

type Record = (Namespace, Map<String, Value>);

/// Merges `records` key by key: the first provider of the field's order with a non-empty value wins,
/// else the first record that has the key supplies it as it is. Locked fields are left out.
pub fn merge(
    records: &[Record],
    order: &FieldOrder,
    locked: &[Field],
) -> (Map<String, Value>, Provenance) {
    let empty = |key: &str, v: &Value| Field::of_key(key).map_or(blank(v), |f| f.is_empty(v));
    let winner = |key: &str| -> Option<(Namespace, &Value)> {
        let ranks = order.providers_for(Field::of_key(key));
        let rank = |p: Namespace| ranks.iter().position(|o| *o == p).unwrap_or(usize::MAX);
        let mut has: Vec<_> = records
            .iter()
            .filter_map(|(p, r)| Some((*p, r.get(key)?)))
            .collect();
        has.sort_by_key(|(p, _)| rank(*p));
        has.iter()
            .find(|(_, v)| !empty(key, v))
            .or(has.first())
            .copied()
    };
    let mut out = Map::new();
    for (_, r) in records {
        for key in r.keys() {
            let owner = Field::of_key(key);
            if out.contains_key(key) || owner.is_some_and(|f| locked.contains(&f)) {
                continue;
            }
            if let Some((_, v)) = winner(key) {
                out.insert(key.clone(), v.clone());
            }
        }
    }
    let provenance = Field::ALL
        .into_iter()
        .filter(|f| !locked.contains(f))
        .filter_map(|f| {
            f.keys()
                .iter()
                .filter_map(|k| winner(k).filter(|(_, v)| !empty(k, v)))
                .map(|(p, _)| (f, p))
                .next()
        })
        .collect();
    (out, provenance)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rec(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn one_record_merges_to_itself() {
        let r = rec(
            json!({"title": "A", "overview": "", "year": null, "genres": [], "provider": "tmdb"}),
        );
        let order = FieldOrder::new(MediaKind::Movie, &[]);
        let (m, p) = merge(&[(Namespace::TMDB, r.clone())], &order, &[]);
        assert_eq!(m, r);
        assert_eq!(p, [(Field::Title, Namespace::TMDB)]);
    }

    #[test]
    fn order_puts_the_preferred_provider_first_without_duplicates() {
        let o = FieldOrder::new(MediaKind::Series, &[Namespace::TVDB, Namespace::TVDB]);
        assert_eq!(o.providers(), [Namespace::TVDB, Namespace::TMDB]);
        assert_eq!(
            FieldOrder::new(MediaKind::Movie, &[]).providers(),
            [Namespace::TMDB, Namespace::TVDB]
        );
    }

    #[test]
    fn book_fields_have_their_own_orders_and_the_family_picks_the_series() {
        use ExternalProvider::{Audible, Audnexus, Bnf, File, GoogleBooks, OpenLibrary};
        let [audible, audnexus, bnf, file, googlebooks, openlibrary] =
            [Audible, Audnexus, Bnf, File, GoogleBooks, OpenLibrary].map(Namespace::Core);
        let o = FieldOrder::book(Family::Text, &[]);
        assert_eq!(
            o.providers(),
            [openlibrary, bnf, googlebooks, audible, audnexus]
        );
        let of = |o: &FieldOrder, f| o.providers_for(Some(f)).to_vec();
        assert_eq!(
            of(&o, Field::Overview),
            [googlebooks, openlibrary, bnf, audible, audnexus]
        );
        assert_eq!(
            of(&o, Field::Series),
            [openlibrary, bnf, googlebooks, audible, audnexus]
        );
        let audio = FieldOrder::book(Family::Audio, &[]);
        assert_eq!(of(&audio, Field::Series)[0], audible);
        assert_eq!(of(&audio, Field::Narrators)[..2], [file, audible]);
        assert_eq!(
            FieldOrder::new(MediaKind::Book, &[bnf]),
            FieldOrder::book(Family::Text, &[bnf])
        );
        assert_eq!(
            of(&FieldOrder::book(Family::Text, &[bnf]), Field::Overview)[0],
            bnf
        );
        assert_eq!(o.providers_for(None), o.providers());
    }
}

//! The per-field merge of provider records (`metadata-orchestrator.md` rules 25-27).
use super::field::{Field, blank};
use crate::{external_id::ExternalProvider, media::kind::MediaKind};
use serde_json::{Map, Value};

/// The providers a field is read from, first to last.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldOrder(Vec<ExternalProvider>);

impl FieldOrder {
    /// `first` (the season's, the media's, the library's preferred provider, most specific first),
    /// then the kind's default order.
    pub fn new(kind: MediaKind, first: &[ExternalProvider]) -> Self {
        let defaults = match kind {
            MediaKind::Movie | MediaKind::Series => {
                [ExternalProvider::Tmdb, ExternalProvider::Tvdb]
            }
        };
        let mut order: Vec<ExternalProvider> = vec![];
        for p in first.iter().copied().chain(defaults) {
            if !order.contains(&p) {
                order.push(p);
            }
        }
        Self(order)
    }

    pub fn providers(&self) -> &[ExternalProvider] {
        &self.0
    }
}

pub type Provenance = Vec<(Field, ExternalProvider)>;

type Record = (ExternalProvider, Map<String, Value>);

/// Merges `records` key by key: the first provider of `order` with a non-empty value wins, else the
/// first record that has the key supplies it as it is. Locked fields are left out.
pub fn merge(
    records: &[Record],
    order: &FieldOrder,
    locked: &[Field],
) -> (Map<String, Value>, Provenance) {
    let rank = |p: ExternalProvider| order.0.iter().position(|o| *o == p).unwrap_or(usize::MAX);
    let mut ranked: Vec<&Record> = records.iter().collect();
    ranked.sort_by_key(|(p, _)| rank(*p));
    let empty = |key: &str, v: &Value| Field::of_key(key).map_or(blank(v), |f| f.is_empty(v));
    let winner = |key: &str| -> Option<(ExternalProvider, &Value)> {
        let has = || ranked.iter().filter_map(|(p, r)| Some((*p, r.get(key)?)));
        has().find(|(_, v)| !empty(key, v)).or_else(|| has().next())
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
    use ExternalProvider::{Tmdb, Tvdb};
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
        let (m, p) = merge(&[(Tmdb, r.clone())], &order, &[]);
        assert_eq!(m, r);
        assert_eq!(p, [(Field::Title, Tmdb)]);
    }

    #[test]
    fn order_puts_the_preferred_provider_first_without_duplicates() {
        let o = FieldOrder::new(MediaKind::Series, &[Tvdb, Tvdb]);
        assert_eq!(o.providers(), [Tvdb, Tmdb]);
        assert_eq!(
            FieldOrder::new(MediaKind::Movie, &[]).providers(),
            [Tmdb, Tvdb]
        );
    }
}

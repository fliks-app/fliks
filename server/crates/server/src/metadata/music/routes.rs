//! Album hits as a search card (`docs/spec/music.md`).
use crate::metadata::hit_core;
use fliks_domain::{
    external_id::{Namespace, Namespaces},
    media::kind::MediaKind,
    music::provider::{self, Album},
};
use serde_json::{Value, json};

fn card(p: Namespace, a: &Album) -> Value {
    let mut h = hit_core(
        p,
        &a.external_id,
        MediaKind::Album,
        &a.title,
        a.year.map(i64::from),
        a.poster_url.as_deref(),
    );
    let artists: Vec<&str> = a.artists.iter().map(|c| c.name.as_str()).collect();
    for (k, v) in [
        ("overview", json!(a.overview)),
        ("artists", json!(artists)),
        ("primaryType", json!(a.primary_type)),
        ("secondaryTypes", json!(a.secondary_types)),
        (
            "firstReleaseDate",
            json!(a.first_release_date.map(|d| d.to_string())),
        ),
        ("isCompilation", json!(a.is_compilation)),
        ("releaseCount", json!(a.release_count)),
        ("popularity", json!(a.popularity)),
        ("sourceUrl", json!(a.source_url)),
    ] {
        h.insert(k.into(), v);
    }
    Value::Object(h)
}

/// A hit as a card; `None` for a record with no id or title, or an id the namespace refuses.
pub(crate) fn hit(known: &Namespaces, p: Namespace, v: &Value) -> Option<Value> {
    let mut a = provider::album(v).ok()?;
    a.external_id = known.normalize(p, &a.external_id)?;
    Some(card(p, &a))
}

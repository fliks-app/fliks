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

fn text(v: &Value, k: &str) -> Option<String> {
    v.get(k)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// An artist hit (`docs/spec/metadata.md` rule 52); `None` for a record with no id the namespace accepts or no name.
pub(crate) fn artist_hit(known: &Namespaces, p: Namespace, v: &Value) -> Option<Value> {
    let id = known.normalize(p, &text(v, "externalId")?)?;
    Some(json!({
        "provider": p.as_str(), "externalId": id, "name": text(v, "name")?,
        "sortName": text(v, "sortName"), "disambiguation": text(v, "disambiguation"),
        "artistType": text(v, "artistType"), "country": text(v, "country"), "personId": null,
    }))
}

/// A recording hit with its release group as an album hit; `None` when the recording has no id or title or no group.
pub(crate) fn recording_hit(known: &Namespaces, p: Namespace, v: &Value) -> Option<Value> {
    let id = known.normalize(p, &text(v, "externalId")?)?;
    let album = hit(known, p, v.get("album")?)?;
    let artists: Vec<String> = v["artists"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| text(a, "name").or_else(|| a.as_str().map(str::to_owned)))
        .collect();
    Some(json!({
        "provider": p.as_str(), "externalId": id, "title": text(v, "title")?, "artists": artists,
        "durationMs": v["durationMs"].as_u64().filter(|d| *d > 0), "album": album, "trackId": null,
    }))
}

//! Album hits as a search card (`docs/spec/music.md`).
use super::target::main_release;
use crate::{
    http::{AppError, auth::Authed},
    metadata::{
        hit_core, mark_existing,
        routes::{Ids, Res, lang},
    },
    state::AppState,
};
use axum::{Json, Router, extract::State, routing::get};
use fliks_domain::{
    external_id::{Namespace, Namespaces},
    media::kind::MediaKind,
    metadata::limiter::Priority,
    music::{
        profile::MetadataProfile,
        provider::{self, Album, Credit},
    },
};
use serde_json::{Value, json};

pub fn routes(r: Router<AppState>) -> Router<AppState> {
    r.route(
        "/api/metadata/{provider}/album/{externalId}",
        get(preview_album),
    )
}

fn credit_json(c: &Credit) -> Value {
    json!({"name": c.name, "creditedName": c.credited_name, "joinPhrase": c.join_phrase, "externalId": c.id})
}

/// `GET /api/metadata/{provider}/album/{externalId}` (`docs/spec/music.md` rule 75).
#[utoipa::path(get, path = "/api/metadata/{provider}/album/{externalId}", responses((status = 200)))]
pub async fn preview_album(State(st): State<AppState>, a: Authed, ids: Ids) -> Res {
    a.require(
        fliks_domain::acl::Action::Read,
        fliks_domain::acl::Subject::Media,
    )?;
    let crate::http::validate::PathParams((name, id)) = ids?;
    let known = st.namespaces();
    let ns = known
        .parse(&name)
        .filter(|n| st.metadata.serves(*n, MediaKind::Album))
        .ok_or_else(|| crate::metadata::books::routes::unknown_provider(&name))?;
    let group = known
        .normalize(ns, &id)
        .ok_or_else(|| AppError::bad_request("externalId is not a provider id"))?;
    let lang = lang(&st).await?;
    let (fetched, edition) = if ns == Namespace::MUSICBRAINZ {
        main_release(
            &st,
            &group,
            &lang,
            &MetadataProfile::default(),
            Priority::Interactive,
        )
        .await?
    } else {
        (
            super::fetch(&st, ns, &group, &lang, Priority::Interactive).await?,
            None,
        )
    };
    let mut album = fetched.album;
    album.external_id = group;
    let mut out = card(ns, &album);
    out["artists"] = album.artists.iter().map(credit_json).collect();
    let (release, tracks) = match &edition {
        Some(e) => (
            json!({"externalId": e.release.external_id, "title": e.release.title, "country": e.release.country,
                   "releaseDate": e.release.release_date.map(|d| d.to_string())}),
            e.tracks
                .iter()
                .map(|t| {
                    json!({"recordingId": t.recording_id, "discNumber": t.disc_number, "position": t.position,
                           "number": t.number, "title": t.title, "durationMs": t.duration_ms})
                })
                .collect(),
        ),
        None => (Value::Null, vec![]),
    };
    out["trackCount"] = tracks.len().into();
    out["durationMs"] = edition
        .iter()
        .flat_map(|e| &e.tracks)
        .filter_map(|t| t.duration_ms)
        .map(i64::from)
        .sum::<i64>()
        .into();
    out["release"] = release;
    out["tracks"] = tracks.into();
    let mut one = [out];
    mark_existing(&st.db, &a, MediaKind::Album, &mut one).await?;
    let [out] = one;
    Ok(Json(out))
}

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

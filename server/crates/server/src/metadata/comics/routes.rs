//! Comic hits and preview (`docs/spec/comics.md` rules 39-40).
use super::{Fetched, describe, fetch};
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    metadata::{
        books::routes::unknown_provider,
        routes::{Ids, Res, lang},
        {hit_core, mark_existing},
    },
    state::AppState,
};
use axum::{Json, Router, extract::State, routing::get};
use fliks_domain::{
    comics::provider::{self, Work},
    external_id::{Namespace, Namespaces},
    media::kind::MediaKind,
    metadata::limiter::Priority,
};
use serde_json::{Value, json};

const GO: Priority = Priority::Interactive;

pub fn routes(r: Router<AppState>) -> Router<AppState> {
    r.route(
        "/api/metadata/{provider}/comic/{externalId}",
        get(preview_comic),
    )
}

/// A registered provider that supports comics.
pub(crate) fn comic_provider(st: &AppState, name: &str) -> Result<Namespace, AppError> {
    st.namespaces()
        .parse(name)
        .filter(|p| {
            st.metadata
                .get(*p)
                .is_some_and(|x| x.supports(MediaKind::Comic))
        })
        .ok_or_else(|| unknown_provider(name))
}

/// The fields of a comic hit, without `existingMediaId`.
fn card(p: Namespace, w: &Work) -> Value {
    let mut h = hit_core(
        p,
        &w.external_id,
        MediaKind::Comic,
        &w.title,
        w.year.map(i64::from),
        w.poster_url.as_deref(),
    );
    for (k, v) in [
        ("publisher", json!(w.publisher)),
        ("volume", json!(w.volume)),
        ("issueCount", json!(w.issue_count)),
        ("overview", json!(w.overview)),
        ("sourceUrl", json!(w.source_url)),
    ] {
        h.insert(k.into(), v);
    }
    Value::Object(h)
}

/// A hit as a card; `None` for one with no id or title, or an id the namespace refuses.
pub(crate) fn hit(known: &Namespaces, p: Namespace, v: &Value) -> Option<Value> {
    let mut w = provider::work(v).ok()?;
    w.external_id = known.normalize(p, &w.external_id)?;
    Some(card(p, &w))
}

/// `GET /api/metadata/{provider}/comic/{externalId}` (rule 40).
#[utoipa::path(get, path = "/api/metadata/{provider}/comic/{externalId}", responses((status = 200)))]
pub async fn preview_comic(State(st): State<AppState>, a: Authed, ids: Ids) -> Res {
    let PathParams((name, id)) = ids?;
    let ns = comic_provider(&st, &name)?;
    let known = st.namespaces();
    let id = known
        .normalize(ns, &id)
        .ok_or_else(|| AppError::bad_request(format!("Invalid id for provider: {name}")))?;
    let lang = lang(&st).await?;
    let Fetched { work, issues } = fetch(&st, ns, &id, &lang, GO).await?;
    let mut out = card(
        ns,
        &Work {
            external_id: id,
            ..work
        },
    );
    out["description"] = out["overview"].clone();
    out["issues"] = issues
        .iter()
        .map(|i| {
            json!({"number": i.label, "sort": i.sort, "kind": i.kind, "title": i.title,
                   "releaseDate": i.release_date})
        })
        .collect();
    out["attribution"] = describe(&st.db, &[ns.as_str().to_owned()])
        .await?
        .into_iter()
        .next()
        .unwrap_or_else(|| json!({"provider": ns.as_str(), "name": known.label(ns), "url": null}));
    let mut one = [out];
    mark_existing(&st.db, &a, MediaKind::Comic, &mut one).await?;
    let [out] = one;
    Ok(Json(out))
}

/// `serving.comic` of `GET /api/metadata/providers` (rule 38).
pub async fn serving(st: &AppState) -> Result<Vec<Value>, sqlx::Error> {
    let known = st.namespaces();
    let names: Vec<String> = st
        .metadata
        .serving(MediaKind::Comic)
        .into_iter()
        .map(|p| p.as_str().to_owned())
        .collect();
    let described = describe(&st.db, &names).await?;
    Ok(names
        .iter()
        .map(|n| {
            let d = described.iter().find(|d| d["provider"] == *n);
            json!({"provider": n,
                   "label": d.map_or_else(|| known.parse(n).map(|p| known.label(p)).unwrap_or_default(), |d| d["name"].as_str().unwrap_or_default().to_owned()),
                   "url": d.map_or(Value::Null, |d| d["url"].clone())})
        })
        .collect())
}

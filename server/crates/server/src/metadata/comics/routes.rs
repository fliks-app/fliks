//! Comic search and preview (`docs/spec/comics.md` rules 39-40).
use super::{Fetched, describe, fetch};
use crate::{
    http::{AppError, auth::Authed, validate::PathParams},
    libraries::accessible_library_ids,
    metadata::{
        Metadata, Search,
        books::routes::{page, unknown_provider},
        routes::{Ids, Pairs, Res, bare, lang, unavailable, year},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{Query, State},
    routing::get,
};
use fliks_domain::{
    comics::provider::{self, Work},
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::limiter::Priority,
};
use serde_json::{Value, json};
use sqlx::PgPool;

const GO: Priority = Priority::Interactive;

pub fn routes(r: Router<AppState>) -> Router<AppState> {
    r.route("/api/metadata/search/comic", get(search_comic))
        .route(
            "/api/metadata/{provider}/comic/{externalId}",
            get(preview_comic),
        )
}

/// A registered provider that supports comics.
pub(crate) fn comic_provider(md: &Metadata, name: &str) -> Result<Namespace, AppError> {
    Namespace::parse(name)
        .filter(|p| md.get(*p).is_some_and(|x| x.supports(MediaKind::Comic)))
        .ok_or_else(|| unknown_provider(name))
}

/// The fields of a `ComicSearchResult`, without `mediaId`.
fn card(p: Namespace, w: &Work) -> Value {
    json!({
        "provider": p.as_str(), "externalId": w.external_id, "kind": "comic", "title": w.title,
        "year": w.year, "publisher": w.publisher, "volume": w.volume, "issueCount": w.issue_count,
        "overview": w.overview, "coverUrl": w.poster_url, "sourceUrl": w.source_url,
        "mediaId": Value::Null,
    })
}

/// A hit as a card; `None` for one with no id or title, or an id the namespace refuses.
fn hit(p: Namespace, v: &Value) -> Option<Value> {
    let mut w = provider::work(v).ok()?;
    w.external_id = p.normalize(&w.external_id)?;
    Some(card(p, &w))
}

/// Sets `mediaId` of each card: the lowest readable comic holding its id.
async fn with_media_ids(db: &PgPool, acl: &[i32], hits: &mut [Value]) -> Result<(), sqlx::Error> {
    let key = |h: &Value| {
        (
            h["provider"].as_str().unwrap_or_default().to_owned(),
            h["externalId"].as_str().unwrap_or_default().to_owned(),
        )
    };
    let (ns, ids): (Vec<_>, Vec<_>) = hits.iter().map(key).unzip();
    let rows: Vec<(i32, i32)> = sqlx::query_as(
        r#"SELECT q.i::int, min(m.id) FROM UNNEST($1::text[], $2::text[]) WITH ORDINALITY AS q(p, v, i)
           JOIN media_external_ids e ON e.kind = 'comic' AND e.provider = q.p AND e.value = q.v
           JOIN media m ON m.id = e."mediaId" AND m."libraryId" = ANY($3)
           GROUP BY q.i"#,
    )
    .bind(&ns)
    .bind(&ids)
    .bind(acl)
    .fetch_all(db)
    .await?;
    for (i, media) in rows {
        if let Some(h) = hits.get_mut(i as usize - 1) {
            h["mediaId"] = media.into();
        }
    }
    Ok(())
}

/// `GET /api/metadata/search/comic` (rule 39).
#[utoipa::path(get, path = "/api/metadata/search/comic", responses((status = 200)))]
pub async fn search_comic(State(st): State<AppState>, a: Authed, Query(q): Pairs) -> Res {
    let page = page(&q)?;
    let named = bare(&q, "provider")
        .filter(|p| !p.is_empty())
        .map(|p| comic_provider(&st.metadata, &p))
        .transpose()?;
    let query = bare(&q, "q")
        .map(|v| v.trim().to_owned())
        .unwrap_or_default();
    if query.is_empty() {
        return Ok(Json(json!([])));
    }
    let year = year(bare(&q, "year").as_deref());
    let md = &st.metadata;
    let mut order: Vec<Namespace> = md
        .order(MediaKind::Comic)
        .into_iter()
        .filter(|p| md.available(*p) && md.of(*p).has_search(MediaKind::Comic))
        .collect();
    if let Some(p) = named.filter(|p| md.available(*p)) {
        order.retain(|o| *o != p);
        order.insert(0, p);
    }
    let search = Search {
        page,
        ..Search::text(MediaKind::Comic, &query, year)
    };
    let lang = lang(&st).await?;
    let (mut found, mut answered, mut failed) = (None, false, None);
    for p in order {
        match md.of(p).search(&search, &lang, GO).await {
            Ok(r) if r.is_empty() => answered = true,
            Ok(r) => {
                found = Some((p, r));
                break;
            }
            Err(e) => {
                tracing::warn!("{p} comic search skipped: {e}");
                failed = Some((p, e));
            }
        }
    }
    let mut hits: Vec<Value> = match found {
        Some((p, r)) => r.iter().filter_map(|v| hit(p, v)).collect(),
        None if answered || failed.is_none() => vec![],
        None => {
            let (p, e) = failed.expect("checked");
            return Err(unavailable("search", p, &e));
        }
    };
    let acl = accessible_library_ids(&st.db, &a).await?;
    with_media_ids(&st.db, &acl, &mut hits).await?;
    Ok(Json(Value::Array(hits)))
}

/// `GET /api/metadata/{provider}/comic/{externalId}` (rule 40).
#[utoipa::path(get, path = "/api/metadata/{provider}/comic/{externalId}", responses((status = 200)))]
pub async fn preview_comic(State(st): State<AppState>, a: Authed, ids: Ids) -> Res {
    let PathParams((name, id)) = ids?;
    let ns = comic_provider(&st.metadata, &name)?;
    let id = ns
        .normalize(&id)
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
        .unwrap_or_else(|| json!({"provider": ns.as_str(), "name": ns.label(), "url": null}));
    let acl = accessible_library_ids(&st.db, &a).await?;
    let mut one = [out];
    with_media_ids(&st.db, &acl, &mut one).await?;
    let [out] = one;
    Ok(Json(out))
}

/// `serving.comic` of `GET /api/metadata/providers` (rule 38).
pub async fn serving(st: &AppState) -> Result<Vec<Value>, sqlx::Error> {
    let md = &st.metadata;
    let names: Vec<String> = md
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
                   "label": d.map_or_else(|| Namespace::parse(n).map(|p| p.label()).unwrap_or_default(), |d| d["name"].as_str().unwrap_or_default().to_owned()),
                   "url": d.map_or(Value::Null, |d| d["url"].clone())})
        })
        .collect())
}

//! Comic providers (`docs/spec/comics.md` rules 38-44): reads, the write shared by import, identify
//! and refresh, search, preview and attribution.
mod apply;
pub mod routes;
#[cfg(test)]
mod tests;

pub(crate) use apply::language_of_library;
pub use apply::{refresh, write};

use super::{MetaError, Upstream, fail, unavailable};
use crate::{http::AppError, state::AppState};
use fliks_domain::{
    comics::provider::{self, Issue, Work},
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{language::Resolved, limiter::Priority},
};
use serde_json::{Value, json};
use sqlx::PgPool;

/// A volume and its checked issues, as the provider answered them.
pub struct Fetched {
    pub work: Work,
    pub issues: Vec<Issue>,
}

pub(crate) fn meta_fail(p: Namespace, e: MetaError) -> AppError {
    match e {
        MetaError::Upstream(e) => fail(p, &e, true),
        MetaError::Db(e) => e.into(),
    }
}

/// The work and the children of `id`, through their snapshots; a work that breaks rule 60 fails
/// the read, a child that breaks rule 61 is dropped (`provider-plugins.md`).
pub async fn fetch(
    st: &AppState,
    ns: Namespace,
    id: &str,
    lang: &Resolved,
    prio: Priority,
) -> Result<Fetched, AppError> {
    if !st.metadata.available(ns) {
        return Err(unavailable(
            "request",
            ns,
            &Upstream::new(None, "the provider is unavailable"),
        ));
    }
    let kind = MediaKind::Comic;
    let record = st
        .metadata
        .work(ns, kind, id, lang, prio)
        .await
        .map_err(|e| meta_fail(ns, e))?;
    let work = provider::work(&record).map_err(|why| {
        unavailable(
            "request",
            ns,
            &Upstream::new(None, format!("malformed work record: {why}")),
        )
    })?;
    let children = st
        .metadata
        .children(ns, kind, id, lang, prio)
        .await
        .map_err(|e| meta_fail(ns, e))?;
    let got = provider::issues(&children);
    if got.invalid + got.repeats > 0 {
        tracing::warn!(
            "{ns} volume {id}: {} issues dropped ({}), {} repeated",
            got.invalid,
            got.first_reason.unwrap_or("none"),
            got.repeats
        );
    }
    Ok(Fetched {
        work,
        issues: got.kept,
    })
}

/// `{provider, name, url}` of each plugin namespace named: its stored label and the `homepage` of
/// the package's manifest (null once the package is gone).
pub async fn describe(db: &PgPool, names: &[String]) -> sqlx::Result<Vec<Value>> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        r#"SELECT n.name::text, n.label::text, p.manifest ->> 'homepage'
           FROM provider_namespaces n LEFT JOIN plugin_packages p ON p."pluginId" = n."pluginId"
           WHERE n.name = ANY($1) ORDER BY n.name"#,
    )
    .bind(names)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(provider, name, url)| json!({"provider": provider, "name": name, "url": url}))
        .collect())
}

/// `ComicDetail.providers` (rule 44): the namespaces that hold an id or a field of the volume.
pub async fn attribution(db: &PgPool, media: i32) -> sqlx::Result<Vec<Value>> {
    let names: Vec<String> = sqlx::query_scalar(
        r#"SELECT provider::text FROM media_external_ids WHERE "mediaId" = $1
           UNION SELECT provider::text FROM media_field_sources WHERE "mediaId" = $1 AND provider IS NOT NULL"#,
    )
    .bind(media)
    .fetch_all(db)
    .await?;
    describe(db, &names).await
}

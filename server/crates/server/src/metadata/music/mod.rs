//! Album providers (`docs/spec/music.md`): the reads, and the apply path of a release group and its
//! releases, which never deletes anything a provider stops listing.
pub mod aliases;
mod apply;
pub mod people;
pub mod routes;
pub mod target;
#[cfg(test)]
pub(crate) mod tests;
pub mod works;

pub use apply::{Written, refresh, write_album, write_edition};

use super::{MetaError, Upstream, fail, unavailable};
use crate::{http::AppError, state::AppState};
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{language::Resolved, limiter::Priority},
    music::provider::{self, Album, Edition, Release},
};

/// A release group and its checked releases, as the provider answered them.
pub struct Fetched {
    pub album: Album,
    pub releases: Vec<Release>,
}

pub(crate) fn meta_fail(p: Namespace, e: MetaError) -> AppError {
    match e {
        MetaError::Upstream(e) => fail(p, &e, true),
        MetaError::Db(e) => e.into(),
    }
}

fn malformed(ns: Namespace, why: &str) -> AppError {
    unavailable(
        "request",
        ns,
        &Upstream::new(None, format!("malformed record: {why}")),
    )
}

/// The release group `id` and its releases, through their snapshots.
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
    let record = st
        .metadata
        .work(ns, MediaKind::Album, id, lang, prio)
        .await
        .map_err(|e| meta_fail(ns, e))?;
    let album = provider::album(&record).map_err(|why| malformed(ns, why))?;
    let children = st
        .metadata
        .children(ns, MediaKind::Album, id, None, lang, prio)
        .await
        .map_err(|e| meta_fail(ns, e))?;
    let got = provider::releases(&children);
    if got.invalid + got.repeats > 0 {
        tracing::warn!(
            "{ns} release group {id}: {} releases dropped ({}), {} repeated",
            got.invalid,
            got.first_reason.unwrap_or("none"),
            got.repeats
        );
    }
    Ok(Fetched {
        album,
        releases: got.kept,
    })
}

/// The release `id` with its tracklist.
pub async fn fetch_edition(
    st: &AppState,
    ns: Namespace,
    id: &str,
    lang: &Resolved,
    prio: Priority,
) -> Result<Edition, AppError> {
    let record = st
        .metadata
        .edition(ns, (ns, id), lang, prio)
        .await
        .map_err(|e| meta_fail(ns, e))?
        .ok_or_else(|| AppError::not_found("not_found"))?;
    let edition = provider::edition(&record).map_err(|why| malformed(ns, why))?;
    if edition.dropped > 0 {
        tracing::warn!("{ns} release {id}: {} tracks dropped", edition.dropped);
    }
    Ok(edition)
}

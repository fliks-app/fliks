//! The release an album is (`docs/spec/music.md` rules 41 and 51): the one a caller names, or the one the
//! library's profile picks in a release group the caller names.
use super::{Fetched, fetch, fetch_edition, malformed};
use crate::{http::AppError, ingest::music::identify, state::AppState};
use axum::http::StatusCode;
use fliks_domain::{
    external_id::Namespace,
    metadata::{language::Resolved, limiter::Priority},
    music::{
        profile::MetadataProfile,
        provider::{Edition, Track},
        target::pick_target,
    },
};

/// A release with its tracklist and the release group it belongs to.
pub struct Source {
    pub fetched: Fetched,
    pub edition: Edition,
}

impl Source {
    pub fn release(&self) -> &str {
        &self.edition.release.external_id
    }
}

/// What an id names: a release group, or one release.
pub enum Asked {
    Group(Box<Fetched>),
    Release(Box<Source>),
}

fn unavailable() -> AppError {
    AppError::with_message(
        StatusCode::SERVICE_UNAVAILABLE,
        "The album's releases are not available yet",
    )
}

/// Reads `id` as a release group, else as a release.
pub async fn classify(
    st: &AppState,
    ns: Namespace,
    id: &str,
    lang: &Resolved,
    prio: Priority,
) -> Result<Asked, AppError> {
    match fetch(st, ns, id, lang, prio).await {
        Ok(fetched) => Ok(Asked::Group(Box::new(fetched))),
        Err(e) if e.status() == StatusCode::NOT_FOUND => {
            let edition = fetch_edition(st, ns, id, lang, prio).await?;
            let group = edition
                .release_group_id
                .clone()
                .ok_or_else(|| malformed(ns, "the release names no release group"))?;
            let fetched = fetch(st, ns, &group, lang, prio).await?;
            Ok(Asked::Release(Box::new(Source { fetched, edition })))
        }
        Err(e) => Err(e),
    }
}

impl Asked {
    /// The release: the named one, or `pick_target` among the group's releases (`among` limits the choice).
    pub async fn pick(
        self,
        st: &AppState,
        ns: Namespace,
        lang: &Resolved,
        profile: &MetadataProfile,
        among: Option<&[String]>,
        prio: Priority,
    ) -> Result<Source, AppError> {
        let fetched = match self {
            Self::Release(source) => return Ok(*source),
            Self::Group(fetched) => *fetched,
        };
        let cfg = identify::config(st).await;
        let release = pick_target(&fetched.releases, profile, &cfg, among)
            .ok_or_else(unavailable)?
            .external_id
            .clone();
        let edition = fetch_edition(st, ns, &release, lang, prio).await?;
        Ok(Source { fetched, edition })
    }
}

/// The release `id` names, or the one the library's profile picks in the group it names.
pub async fn resolve(
    st: &AppState,
    ns: Namespace,
    id: &str,
    lang: &Resolved,
    profile: &MetadataProfile,
    prio: Priority,
) -> Result<Source, AppError> {
    classify(st, ns, id, lang, prio)
        .await?
        .pick(st, ns, lang, profile, None, prio)
        .await
}

/// The tracklist of the release a new album of `library` would be; empty when its group lists no release.
pub async fn tracklist(
    st: &AppState,
    id: &str,
    library: i32,
    prio: Priority,
) -> Result<Vec<Track>, AppError> {
    let lang = crate::metadata::library_language(st, library).await?;
    let profile = crate::libraries::metadata_profile(&st.db, library).await?;
    match classify(st, Namespace::MUSICBRAINZ, id, &lang, prio).await? {
        Asked::Group(f) if f.releases.is_empty() => Ok(vec![]),
        asked => Ok(asked
            .pick(st, Namespace::MUSICBRAINZ, &lang, &profile, None, prio)
            .await?
            .edition
            .tracks),
    }
}

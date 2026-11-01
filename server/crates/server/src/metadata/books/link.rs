//! Writes what a `BookMatch` says (`book-metadata.md`); filled by the fusion track.
use super::identify::BookMatch;
use crate::{metadata::MetaError, state::AppState};
use fliks_domain::metadata::limiter::Priority;

/// Links the work and the edition ids, fetches, merges and writes work and edition facts, credits, series.
pub async fn attach(
    _st: &AppState,
    _media: i32,
    _edition: Option<i32>,
    _m: &BookMatch,
    _p: Priority,
) -> Result<(), MetaError> {
    Ok(())
}

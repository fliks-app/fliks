//! Finds the work and edition ids of a set of hints (`book-metadata.md`); filled by the fusion track.
use crate::{metadata::MetaError, state::AppState};
use fliks_domain::{
    external_id::ExternalProvider, media::family::Family, metadata::limiter::Priority,
};

pub struct BookHints {
    pub family: Family,
    pub isbns: Vec<String>,
    pub asin: Option<String>,
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub narrators: Vec<String>,
    pub language: Option<String>,
    pub series: Option<(String, Option<String>)>,
    pub year: Option<i32>,
}

pub struct BookMatch {
    /// The OpenLibrary work id (`OL...W`).
    pub work: String,
    pub edition: Vec<(ExternalProvider, String)>,
    pub confidence: u8,
}

pub async fn identify(
    _st: &AppState,
    _h: &BookHints,
    _p: Priority,
) -> Result<Option<BookMatch>, MetaError> {
    Ok(None)
}

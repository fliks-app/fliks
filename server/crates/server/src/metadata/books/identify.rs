//! Finds the work and edition ids of a set of hints (`docs/spec/book-metadata.md` rule 12).
use super::{ANCHOR, merge, people, text, work_id};
use crate::{
    media::external_ids::edition_id,
    metadata::{MetaError, Override, Search},
    state::AppState,
};
use fliks_domain::{
    external_id::ExternalProvider,
    media::{family::Family, kind::MediaKind},
    metadata::{
        book_match::{Candidate, Hints, MIN_CONFIDENCE, score},
        limiter::Priority,
    },
};
use serde_json::Value;

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
    st: &AppState,
    h: &BookHints,
    p: Priority,
) -> Result<Option<BookMatch>, MetaError> {
    if !st.metadata.available(ANCHOR) {
        return Ok(None);
    }
    let lang = st
        .metadata
        .lang
        .resolve(Some(&Override {
            language: h.language.clone(),
            region: None,
        }))
        .await?;
    let mut edition: Vec<(ExternalProvider, String)> = vec![];
    let hinted = h
        .isbns
        .iter()
        .map(|i| (ExternalProvider::Isbn, i.as_str()))
        .chain(h.asin.as_deref().map(|a| (ExternalProvider::Asin, a)));
    for (ns, v) in hinted {
        if let Some(v) = edition_id(ns, v)
            && !edition.contains(&(ns, v.clone()))
        {
            edition.push((ns, v));
        }
    }
    let found = |work, edition: &[_]| BookMatch {
        work,
        edition: edition.to_vec(),
        confidence: 100,
    };

    let providers = merge::providers(&st.metadata);
    for (ns, v) in &edition {
        for pr in &providers {
            match st.metadata.of(*pr).find_by(*ns, v, &lang, p).await {
                Ok(Some((id, _))) if work_id(&id).is_some() => {
                    return Ok(work_id(&id).map(|w| found(w, &edition)));
                }
                Ok(_) => {}
                Err(e) => tracing::warn!("{pr} lookup of {ns}:{v} skipped: {e}"),
            }
        }
    }

    let mut title = h.title.clone().filter(|t| !t.trim().is_empty());
    let mut authors = h.authors.clone();
    if title.is_none() {
        let records = merge::edition_records(st, &edition, &lang, p).await?;
        if let Some((_, r)) = records.iter().find(|(_, r)| text(r, "title").is_some()) {
            title = text(r, "title");
            if authors.is_empty() {
                authors = people(r, "authors").into_iter().map(|(n, _)| n).collect();
            }
        }
    }
    let Some(title) = title else { return Ok(None) };
    let first_author = authors.first().cloned();
    let query = format!("{title} {}", first_author.as_deref().unwrap_or_default());
    let search = Search {
        kind: MediaKind::Book,
        query: query.trim(),
        year: h.year.map(i64::from),
        title: Some(&title),
        author: first_author.as_deref(),
        author_id: None,
        isbn: None,
        language: h.language.as_deref(),
        page: 1,
    };
    let results = st.metadata.of(ANCHOR).search(&search, &lang, p).await?;
    let hints = Hints {
        title: &title,
        authors: &authors,
        year: h.year,
    };
    let best = results
        .iter()
        .filter_map(|v| {
            let r = v.as_object()?;
            let work = work_id(&text(r, "externalId")?)?;
            let listed: Vec<String> = people(r, "authors").into_iter().map(|(n, _)| n).collect();
            let (title, subtitle) = (text(r, "title")?, text(r, "subtitle"));
            let c = Candidate {
                title: &title,
                subtitle: subtitle.as_deref(),
                authors: &listed,
                year: r.get("year").and_then(Value::as_i64).map(|y| y as i32),
            };
            Some((work, score(&hints, &c)))
        })
        .fold(None::<(String, u8)>, |best, c| match best {
            Some(b) if b.1 >= c.1 => Some(b),
            _ => Some(c),
        });
    Ok(best
        .filter(|(_, s)| *s >= MIN_CONFIDENCE)
        .map(|(work, s)| BookMatch {
            work,
            edition,
            confidence: s.min(100),
        }))
}

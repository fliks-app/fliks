//! The media kinds a client renders, declared in `X-Fliks-Kinds` (`client-kinds.md`).
use axum::http::HeaderMap;
use fliks_domain::media::kind::MediaKind;

pub const HEADER: &str = "x-fliks-kinds";

/// Kinds of a client that sends no usable `X-Fliks-Kinds`: the 6.0.x apps render books and comics.
const DEFAULT: [MediaKind; 4] = [
    MediaKind::Movie,
    MediaKind::Series,
    MediaKind::Book,
    MediaKind::Comic,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kinds(Vec<MediaKind>);

impl Kinds {
    /// Every kind, for callers that are no client of the web API (device tokens, background work).
    pub fn all() -> Self {
        Self(MediaKind::ALL.to_vec())
    }

    /// The recognised names of the header values; none recognised falls back to the default.
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let declared: Vec<MediaKind> = headers
            .get_all(HEADER)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .filter_map(|s| MediaKind::parse(&s.trim().to_ascii_lowercase()))
            .collect();
        if declared.is_empty() {
            return Self(DEFAULT.to_vec());
        }
        Self(
            MediaKind::ALL
                .into_iter()
                .filter(|k| declared.contains(k))
                .collect(),
        )
    }

    pub fn has(&self, kind: MediaKind) -> bool {
        self.0.contains(&kind)
    }

    /// Wire names, for a SQL `media.type = ANY(...)` bound.
    pub fn names(&self) -> Vec<String> {
        self.0.iter().map(|k| k.as_str().to_owned()).collect()
    }

    /// A library shows unless every kind it holds is undeclared; one holding none shows.
    pub fn sees_library(&self, media_types: &[String]) -> bool {
        media_types.is_empty() || media_types.iter().any(|t| self.has_name(t))
    }

    /// Whether a stored kind name is declared; unknown names are not.
    pub fn has_name(&self, name: &str) -> bool {
        MediaKind::parse(name).is_some_and(|k| self.has(k))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(v: &[&str]) -> Kinds {
        let mut h = HeaderMap::new();
        for s in v {
            h.append(HEADER, s.parse().unwrap());
        }
        Kinds::from_headers(&h)
    }

    #[test]
    fn default_without_header() {
        assert_eq!(kinds(&[]).names(), ["movie", "series", "book", "comic"]);
    }

    #[test]
    fn declared_set_ignores_unknown_and_case() {
        assert_eq!(
            kinds(&["Movie, album ,tape", "comic"]).names(),
            ["movie", "comic", "album"]
        );
    }

    #[test]
    fn nothing_recognised_is_the_default() {
        assert_eq!(
            kinds(&["tape,,"]).names(),
            ["movie", "series", "book", "comic"]
        );
    }
}

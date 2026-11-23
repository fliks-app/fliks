//! The app a request comes from, declared in `X-Fliks-Client: <platform>/<version>` (`compatibility.md`).
use axum::http::HeaderMap;

const HEADER: &str = "x-fliks-client";
const MAX: usize = 64;

/// The trimmed header value, cut to its first 64 characters; none when absent or blank.
pub fn from_headers(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(HEADER)?.to_str().ok()?.trim();
    (!v.is_empty()).then(|| v.chars().take(MAX).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blank_header_is_none_and_a_long_one_is_cut() {
        let mut h = HeaderMap::new();
        assert_eq!(from_headers(&h), None);
        h.insert(HEADER, " ".parse().unwrap());
        assert_eq!(from_headers(&h), None);
        h.insert(
            HEADER,
            format!(" ios/7.1.0{}", "x".repeat(80)).parse().unwrap(),
        );
        let c = from_headers(&h).unwrap();
        assert!(c.starts_with("ios/7.1.0") && c.chars().count() == MAX);
    }
}

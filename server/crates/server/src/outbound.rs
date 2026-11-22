//! HTTP client and URL helpers shared by the importers and the media servers (`importers.md` rules 37-39, 46).
use reqwest::{Client, Url, redirect};
use std::{sync::OnceLock, time::Duration};

pub const TEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const LIST_TIMEOUT: Duration = Duration::from_secs(60);
pub const ITEM_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_REDIRECTS: usize = 5;

/// Follows a redirect only to the scheme, host and port of the previous URL, or the https upgrade of an
/// `http` URL on its default port, so `X-Api-Key` never leaves the host. reqwest drops `Authorization`
/// on the upgrade (the port changes): a caller that sends one follows by hand with `no_redirect_client` and `follows`.
pub fn client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        crate::net::guard::open_builder()
            .redirect(redirect::Policy::custom(|a| {
                let same = a.previous().last().is_some_and(|p| follows(p, a.url()));
                if a.previous().len() >= MAX_REDIRECTS {
                    a.error("too many redirects")
                } else if same {
                    a.follow()
                } else {
                    a.stop()
                }
            }))
            .build()
            .expect("outbound client")
    })
}

/// A client that never follows a redirect, for a caller that follows by hand.
pub fn no_redirect_client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        crate::net::guard::open_builder()
            .redirect(redirect::Policy::none())
            .build()
            .expect("outbound client")
    })
}

/// Whether a redirect from `from` to `to` may be followed.
pub fn follows(from: &Url, to: &Url) -> bool {
    same_origin(from, to) || upgrade(from, to)
}

fn same_origin(from: &Url, to: &Url) -> bool {
    from.host_str() == to.host_str()
        && from.scheme() == to.scheme()
        && from.port_or_known_default() == to.port_or_known_default()
}

/// The https upgrade of an `http` URL on its default port; a Basic userinfo would be dropped by it.
fn upgrade(from: &Url, to: &Url) -> bool {
    from.host_str() == to.host_str()
        && from.scheme() == "http"
        && to.scheme() == "https"
        && from.port().is_none()
        && to.port().is_none()
        && from.username().is_empty()
        && from.password().is_none()
}

/// A transport error as text, without the request URL that `Display` would embed.
pub fn error_text(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

/// `raw` with trailing `/` removed (`all`, or just one); userinfo stays for the request (Basic auth), never in text.
pub fn base_url(raw: &str, all: bool) -> String {
    let mut s = Url::parse(raw)
        .ok()
        .filter(Url::has_host)
        .map_or_else(|| raw.to_owned(), String::from);
    // `Url` always keeps one `/` after a bare host.
    if all {
        s.truncate(s.trim_end_matches('/').len());
    } else if s.ends_with('/') {
        s.pop();
    }
    s
}

/// Both URLs compared without a trailing `/`, scheme and host case-insensitively.
pub fn same_url(a: &str, b: &str) -> bool {
    let norm = |u: &str| {
        let base = base_url(u, true);
        Url::parse(&base).map_or_else(|_| base.to_lowercase(), String::from)
    };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_redirect_stays_on_the_host_and_may_upgrade_to_https() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(follows(&u("http://h/a"), &u("http://h/b")));
        assert!(follows(&u("http://h/a"), &u("https://h/b")));
        assert!(!follows(&u("https://h/a"), &u("http://h/b")));
        assert!(!follows(&u("http://h/a"), &u("https://h:8443/b")));
        assert!(!follows(&u("http://h/a"), &u("https://other/b")));
        assert!(!follows(&u("http://user:pw@h/a"), &u("https://h/b")));
    }

    #[test]
    fn same_url_ignores_slash_and_case() {
        assert!(same_url("HTTP://Host:80/", "http://host"));
        assert!(!same_url("http://host", "http://other"));
    }

    #[test]
    fn strips_slashes_and_keeps_userinfo() {
        assert_eq!(base_url("http://u:p@h:7878//", true), "http://u:p@h:7878");
        assert_eq!(base_url("http://h/x/", false), "http://h/x");
        assert_eq!(base_url("http://h/x//", false), "http://h/x/");
        assert_eq!(base_url("localhost:7878/", true), "localhost:7878");
    }
}

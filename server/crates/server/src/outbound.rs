//! HTTP client and URL helpers shared by the importers and the media servers (`importers.md` rules 37-39, 46).
use reqwest::{Client, Url, redirect};
use std::{sync::OnceLock, time::Duration};

pub const TEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const LIST_TIMEOUT: Duration = Duration::from_secs(60);
pub const ITEM_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;

/// Follows a redirect only to the scheme, host and port of the previous URL, so `X-Api-Key` never leaves them.
pub fn client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .redirect(redirect::Policy::custom(|a| {
                let same = a.previous().last().is_some_and(|p| {
                    p.scheme() == a.url().scheme()
                        && p.host_str() == a.url().host_str()
                        && p.port_or_known_default() == a.url().port_or_known_default()
                });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_slashes_and_keeps_userinfo() {
        assert_eq!(base_url("http://u:p@h:7878//", true), "http://u:p@h:7878");
        assert_eq!(base_url("http://h/x/", false), "http://h/x");
        assert_eq!(base_url("http://h/x//", false), "http://h/x/");
        assert_eq!(base_url("localhost:7878/", true), "localhost:7878");
    }
}

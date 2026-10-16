//! HTTP client and URL helpers shared by the importers and the media servers (`importers.md` rules 37-39, 46).
use reqwest::{Client, Url, redirect};
use std::{sync::OnceLock, time::Duration};

pub const TEST_TIMEOUT: Duration = Duration::from_secs(15);
pub const LIST_TIMEOUT: Duration = Duration::from_secs(60);
pub const ITEM_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;

/// Follows a redirect only to the host of the previous URL, so `X-Api-Key` never reaches another host.
pub fn client() -> &'static Client {
    static C: OnceLock<Client> = OnceLock::new();
    C.get_or_init(|| {
        Client::builder()
            .redirect(redirect::Policy::custom(|a| {
                let same = a
                    .previous()
                    .last()
                    .is_some_and(|p| p.host_str() == a.url().host_str());
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

/// A transport error as text, without the request URL that `Display` would embed (F29).
pub fn error_text(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

/// `raw` without its userinfo and with trailing `/` removed (`all`, or just one); a non-URL stays as typed.
pub fn base_url(raw: &str, all: bool) -> String {
    let mut s = Url::parse(raw).ok().filter(|u| u.has_host()).map_or_else(
        || raw.to_owned(),
        |mut u| {
            let _ = (u.set_username(""), u.set_password(None));
            u.to_string()
        },
    );
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
    fn strips_userinfo_and_slashes() {
        assert_eq!(base_url("http://u:p@h:7878//", true), "http://h:7878");
        assert_eq!(base_url("http://h/x/", false), "http://h/x");
        assert_eq!(base_url("http://h/x//", false), "http://h/x/");
        assert_eq!(base_url("localhost:7878/", true), "localhost:7878");
    }
}

//! Outbound requests to an address vetted once (`livetv-sources.md` rule 14): the guard resolves the
//! host a single time, every address is checked, and the connection goes to the address that passed.
use crate::net::guard::{self, Refused};
use reqwest::{Client, Url, header::LOCATION, redirect};

/// A client for one hop: `url`'s host resolved once through the guard, every address public, and
/// `base` pinned to them with no redirect of its own. The error is the text the probe reports.
pub async fn client_for(url: &Url, base: reqwest::ClientBuilder) -> Result<Client, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Refused: only http and https are allowed".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Could not resolve \"\": no host".to_owned())?;
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs = guard::vet(&*guard::system(), bare, port, false, &[])
        .await
        .map_err(|r| match r {
            Refused::Address(_, ip) => {
                format!("Refused: \"{host}\" resolves to an internal address ({ip})")
            }
            Refused::Timeout => format!("Could not resolve \"{host}\": lookup timed out"),
            Refused::NotFound | Refused::Lookup => {
                format!("Could not resolve \"{host}\": getaddrinfo ENOTFOUND {bare}")
            }
        })?;
    base.no_proxy()
        .redirect(redirect::Policy::none())
        .resolve_to_addrs(host, &addrs)
        .build()
        .map_err(|e| e.to_string())
}

/// The next hop of a redirect answer, relative locations resolved; `None` when it is not one.
pub fn next_hop(
    from: &Url,
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
) -> Option<Url> {
    if !status.is_redirection() {
        return None;
    }
    let loc = headers.get(LOCATION)?.to_str().ok()?;
    from.join(loc).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_loopback_host_is_refused_and_a_scheme_other_than_http_too() {
        let e = client_for(
            &Url::parse("http://127.0.0.1:9/x").unwrap(),
            guard::open_builder(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            e,
            "Refused: \"127.0.0.1\" resolves to an internal address (127.0.0.1)"
        );
        let e = client_for(
            &Url::parse("ftp://example.com/x").unwrap(),
            guard::open_builder(),
        )
        .await
        .unwrap_err();
        assert!(e.contains("only http"));
    }
}

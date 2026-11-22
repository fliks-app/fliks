//! Where a request came from and which origin it reached: the only readers of the forwarded headers.
use super::cookies::is_secure;
use crate::{settings, state::AppState};
use axum::http::HeaderMap;
use fliks_domain::net::{Cidr, Class, classify};
use std::net::{IpAddr, SocketAddr};

/// The `trusted_proxies` setting: a JSON array of CIDRs, `None` when unset (loopback and private ranges).
async fn trusted_proxies(st: &AppState) -> Option<Vec<Cidr>> {
    let raw = settings::text(&st.db, "trusted_proxies")
        .await
        .ok()
        .flatten()?;
    let list: Vec<String> = serde_json::from_str(&raw).ok()?;
    Some(list.iter().filter_map(|c| Cidr::parse(c)).collect())
}

/// The client address (`auth.md` rule 63): `X-Forwarded-For` entries then the socket peer, walked
/// from the right past the trusted proxies to the first hop outside them.
pub async fn client_ip(
    st: &AppState,
    headers: &HeaderMap,
    peer: Option<&SocketAddr>,
) -> Option<IpAddr> {
    walk(headers, peer, trusted_proxies(st).await.as_deref())
}

fn walk(
    headers: &HeaderMap,
    peer: Option<&SocketAddr>,
    trusted: Option<&[Cidr]>,
) -> Option<IpAddr> {
    let is_trusted = |ip: IpAddr| match trusted {
        Some(list) => list.iter().any(|c| c.contains(ip)),
        None => classify(ip) == Class::Private,
    };
    let mut chain: Vec<IpAddr> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|h| h.trim().parse::<IpAddr>().ok())
        .map(|ip| ip.to_canonical())
        .collect();
    chain.extend(peer.map(|a| a.ip().to_canonical()));
    chain
        .iter()
        .rev()
        .find(|ip| !is_trusted(**ip))
        .or(chain.first())
        .copied()
}

/// The server's public base URL: the `public_url` setting, else the origin this request reached.
pub async fn public_base(st: &AppState, headers: &HeaderMap) -> String {
    if let Some(u) = settings::public_url(&st.db).await.ok().flatten() {
        return u;
    }
    base_of(headers, st.cfg.port)
}

fn base_of(headers: &HeaderMap, port: u16) -> String {
    request_host(headers).map_or_else(
        || format!("http://localhost:{port}"),
        |host| scheme_host(headers, host),
    )
}

/// `http(s)://host` of the request as the client reached it, which a device on the LAN needs.
pub fn request_origin(headers: &HeaderMap) -> String {
    scheme_host(headers, request_host(headers).unwrap_or("localhost"))
}

/// The host the client asked for: `X-Forwarded-Host` (first value) else `Host`.
fn request_host(headers: &HeaderMap) -> Option<&str> {
    ["x-forwarded-host", "host"].iter().find_map(|k| {
        let v = headers.get(*k)?.to_str().ok()?;
        Some(v.split(',').next()?.trim()).filter(|h| !h.is_empty())
    })
}

fn scheme_host(headers: &HeaderMap, host: &str) -> String {
    format!(
        "{}://{host}",
        if is_secure(headers) { "https" } else { "http" }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;
    use std::net::IpAddr;

    fn ip(xff: &[&str], peer: &str) -> Option<IpAddr> {
        walk_with(xff, peer, None)
    }

    fn walk_with(xff: &[&str], peer: &str, trusted: Option<&[&str]>) -> Option<IpAddr> {
        let mut h = HeaderMap::new();
        for x in xff {
            h.append("x-forwarded-for", x.parse().unwrap());
        }
        let list: Option<Vec<Cidr>> =
            trusted.map(|t| t.iter().map(|c| Cidr::parse(c).unwrap()).collect());
        walk(
            &h,
            Some(&format!("{peer}:1").parse().unwrap()),
            list.as_deref(),
        )
    }

    #[test]
    fn the_client_is_the_first_hop_outside_the_trusted_proxies() {
        let want = Some("8.8.8.8".parse().unwrap());
        assert_eq!(ip(&[], "8.8.8.8"), want);
        assert_eq!(ip(&["8.8.8.8"], "172.18.0.2"), want, "docker gateway");
        assert_eq!(
            ip(&["8.8.8.8, 10.0.0.1"], "127.0.0.1"),
            want,
            "lan proxy chain"
        );
        assert_eq!(
            ip(&["1.1.1.1", "8.8.8.8"], "10.0.0.1"),
            want,
            "forged left entry"
        );
        assert_eq!(
            ip(&["1.1.1.1"], "8.8.8.8"),
            want,
            "forged entry, public peer"
        );
        assert_eq!(ip(&["::ffff:8.8.8.8"], "10.0.0.1"), want);
    }

    #[test]
    fn the_origin_prefers_the_forwarded_host_and_scheme() {
        let mut h = HeaderMap::new();
        h.insert("host", "127.0.0.1:4849".parse().unwrap());
        assert_eq!(request_origin(&h), "http://127.0.0.1:4849");
        h.insert("x-forwarded-host", "fliks.example, proxy".parse().unwrap());
        h.insert("x-forwarded-proto", "https".parse().unwrap());
        assert_eq!(request_origin(&h), "https://fliks.example");
        assert_eq!(request_host(&HeaderMap::new()), None);
    }

    #[test]
    fn a_blank_forwarded_host_falls_back_to_host_and_then_localhost() {
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-host", " ".parse().unwrap());
        h.insert("host", "nas.lan:4848".parse().unwrap());
        assert_eq!(base_of(&h, 4849), "http://nas.lan:4848");
        assert_eq!(base_of(&HeaderMap::new(), 4849), "http://localhost:4849");
    }

    #[test]
    fn a_lan_client_is_the_leftmost_hop_when_every_hop_is_trusted() {
        assert_eq!(
            ip(&["192.168.1.7"], "127.0.0.1"),
            Some("192.168.1.7".parse().unwrap())
        );
        assert_eq!(ip(&[], "192.168.1.7"), Some("192.168.1.7".parse().unwrap()));
        assert_eq!(
            ip(&["garbage"], "10.0.0.1"),
            Some("10.0.0.1".parse().unwrap())
        );
    }

    #[test]
    fn an_admin_list_narrows_the_proxies_and_closes_the_lan_spoof() {
        let engine_only = Some(&["127.0.0.0/8"][..]);
        assert_eq!(
            walk_with(&["1.1.1.1", "192.168.1.7"], "127.0.0.1", engine_only),
            Some("192.168.1.7".parse().unwrap()),
            "the hop the engine saw wins over a claimed one"
        );
        let caddy = Some(&["127.0.0.0/8", "192.168.1.2"][..]);
        assert_eq!(
            walk_with(&["8.8.8.8", "192.168.1.2"], "127.0.0.1", caddy),
            Some("8.8.8.8".parse().unwrap())
        );
        assert_eq!(
            walk_with(&["8.8.8.8"], "127.0.0.1", Some(&[])),
            Some("127.0.0.1".parse().unwrap()),
            "an empty list trusts nobody"
        );
    }
}

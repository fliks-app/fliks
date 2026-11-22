//! Where a request came from and which origin it reached: the only readers of the forwarded headers.
use super::cookies::is_secure;
use crate::{settings, state::AppState};
use axum::http::HeaderMap;
use fliks_domain::net::{Class, classify};
use std::net::{IpAddr, SocketAddr};

/// The client address (`auth.md` rule 63): `X-Forwarded-For` entries then the socket peer, walked
/// from the right past private hops (trusted proxies) to the first public one.
pub fn client_ip(headers: &HeaderMap, peer: Option<&SocketAddr>) -> Option<IpAddr> {
    let hops: Vec<IpAddr> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|h| h.trim().parse::<IpAddr>().ok())
        .map(|ip| ip.to_canonical())
        .collect();
    let peer = peer.map(|a| a.ip().to_canonical());
    hops.iter()
        .copied()
        .chain(peer)
        .rev()
        .find(|ip| classify(*ip) == Class::Public)
        .or_else(|| hops.last().copied().or(peer))
}

/// The server's public base URL: the `public_url` setting, else the origin this request reached.
pub async fn public_base(st: &AppState, headers: &HeaderMap) -> String {
    if let Some(u) = settings::public_url(&st.db).await.ok().flatten() {
        return u;
    }
    match headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .filter(|h| !h.is_empty())
    {
        Some(host) => scheme_host(headers, host),
        None => format!("http://localhost:{}", st.cfg.port),
    }
}

/// `http(s)://host` of the request as the client reached it, which a device on the LAN needs.
pub fn request_origin(headers: &HeaderMap) -> String {
    let host = ["x-forwarded-host", "host"]
        .iter()
        .find_map(|k| headers.get(*k).and_then(|v| v.to_str().ok()))
        .and_then(|v| v.split(',').next())
        .map_or("localhost", str::trim);
    scheme_host(headers, host)
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
        let mut h = HeaderMap::new();
        for x in xff {
            h.append("x-forwarded-for", x.parse().unwrap());
        }
        client_ip(&h, Some(&format!("{peer}:1").parse().unwrap()))
    }

    #[test]
    fn the_client_is_the_first_public_hop_from_the_right() {
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
    fn a_lan_client_is_the_nearest_reported_hop() {
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
}

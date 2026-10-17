//! Outbound requests to an address vetted once (`livetv-sources.md` rule 14, F70): the host is resolved
//! a single time, every address checked, and the connection goes to the address that passed.
use reqwest::{Client, Url, header::LOCATION, redirect};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

const BLOCKED_V4: [(Ipv4Addr, u32); 14] = [
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(100, 64, 0, 0), 10),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 0, 0, 0), 24),
    (Ipv4Addr::new(192, 0, 2, 0), 24),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(198, 18, 0, 0), 15),
    (Ipv4Addr::new(198, 51, 100, 0), 24),
    (Ipv4Addr::new(203, 0, 113, 0), 24),
    (Ipv4Addr::new(224, 0, 0, 0), 4),
    (Ipv4Addr::new(240, 0, 0, 0), 4),
];

fn blocked_v4(ip: Ipv4Addr) -> bool {
    BLOCKED_V4.iter().any(|(base, bits)| {
        let mask = u32::MAX.checked_shl(32 - bits).unwrap_or(0);
        u32::from(ip) & mask == u32::from(*base) & mask
    })
}

/// Loopback, private, link-local, site-local, CGNAT, reserved, documentation, Teredo and multicast space;
/// IPv4-mapped, -compatible, NAT64 and 6to4 addresses are judged on the IPv4 they carry.
pub fn is_internal(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => blocked_v4(v4),
        IpAddr::V6(v6) => internal_v6(v6),
    }
}

fn internal_v6(ip: Ipv6Addr) -> bool {
    let g = ip.segments();
    let embedded =
        |g: [u16; 8]| Ipv4Addr::new((g[6] >> 8) as u8, g[6] as u8, (g[7] >> 8) as u8, g[7] as u8);
    let mapped = g[..5].iter().all(|x| *x == 0) && g[5] == 0xffff;
    let nat64 = g[0] == 0x64 && g[1] == 0xff9b && g[2..6].iter().all(|x| *x == 0);
    if mapped || nat64 || (g[..6].iter().all(|x| *x == 0) && (g[6] | g[7]) > 1) {
        return blocked_v4(embedded(g));
    }
    if g[0] == 0x2002 {
        return blocked_v4(Ipv4Addr::new(
            (g[1] >> 8) as u8,
            g[1] as u8,
            (g[2] >> 8) as u8,
            g[2] as u8,
        ));
    }
    if g[0] == 0x2001 && g[1] == 0 {
        return true;
    }
    ip.is_unspecified()
        || ip.is_loopback()
        || g[0] & 0xffc0 == 0xfe80
        || g[0] & 0xffc0 == 0xfec0
        || g[0] & 0xfe00 == 0xfc00
        || g[0] & 0xff00 == 0xff00
}

/// The addresses of `url`'s host, all of them public; the error is the text the probe reports.
pub async fn resolve(url: &Url) -> Result<(String, Vec<SocketAddr>), String> {
    let host = url
        .host_str()
        .ok_or_else(|| "Could not resolve \"\": no host".to_owned())?
        .to_owned();
    let port = url.port_or_known_default().unwrap_or(80);
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare, port))
        .await
        .map_err(|_| format!("Could not resolve \"{host}\": getaddrinfo ENOTFOUND {bare}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("Could not resolve \"{host}\": no address"));
    }
    if let Some(a) = addrs.iter().find(|a| is_internal(a.ip())) {
        return Err(format!(
            "Refused: \"{host}\" resolves to an internal address ({})",
            a.ip()
        ));
    }
    Ok((host, addrs))
}

/// A client for one hop: `base` pinned to the vetted addresses, no redirect of its own.
pub async fn client_for(url: &Url, base: reqwest::ClientBuilder) -> Result<Client, String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Refused: only http and https are allowed".into());
    }
    let (host, addrs) = resolve(url).await?;
    base.redirect(redirect::Policy::none())
        .resolve_to_addrs(&host, &addrs)
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

    #[test]
    fn internal_ranges() {
        for ip in [
            "0.1.2.3",
            "10.1.1.1",
            "100.64.0.1",
            "100.127.255.255",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "172.31.255.255",
            "192.0.0.1",
            "192.0.2.5",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.255",
            "198.51.100.1",
            "203.0.113.9",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fe80::1",
            "febf::1",
            "fc00::1",
            "fd12::1",
            "ff02::1",
            "::ffff:127.0.0.1",
            "0:0:0:0:0:ffff:7f00:1",
            "64:ff9b::a00:1",
            "::ffff:192.168.0.1",
        ] {
            assert!(is_internal(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "fec0::1",
            "2002:7f00:1::1",
            "2002:0a00:1::",
            "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "::7f00:1",
            "::a00:1",
        ] {
            assert!(is_internal(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["2002:0808:0808::1", "::808:808"] {
            assert!(!is_internal(ip.parse().unwrap()), "{ip}");
        }
        for ip in [
            "8.8.8.8",
            "100.63.255.255",
            "100.128.0.1",
            "172.15.0.1",
            "172.32.0.1",
            "192.0.1.1",
            "198.17.0.1",
            "198.20.0.1",
            "223.255.255.255",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
        ] {
            assert!(!is_internal(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn a_loopback_host_is_refused_and_a_scheme_other_than_http_too() {
        let e = resolve(&Url::parse("http://127.0.0.1:9/x").unwrap())
            .await
            .unwrap_err();
        assert_eq!(
            e,
            "Refused: \"127.0.0.1\" resolves to an internal address (127.0.0.1)"
        );
        let e = client_for(
            &Url::parse("ftp://example.com/x").unwrap(),
            Client::builder(),
        )
        .await
        .unwrap_err();
        assert!(e.contains("only http"));
    }
}

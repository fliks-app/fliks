//! Outbound address classes (plugins.md "Outbound HTTP guard", livetv-sources.md rule 14).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Public,
    /// Lifted by the `network.internal` grant.
    Private,
    /// Never reachable: reserved, multicast, documentation, link-local, 6to4, Teredo.
    Refused,
}

impl Class {
    pub fn name(self) -> &'static str {
        match self {
            Class::Public => "public",
            Class::Private => "private",
            Class::Refused => "reserved",
        }
    }
}

pub fn classify(ip: IpAddr) -> Class {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

fn in_v4(ip: Ipv4Addr, net: [u8; 4], bits: u32) -> bool {
    let mask = if bits == 0 {
        0
    } else {
        u32::MAX << (32 - bits)
    };
    u32::from(ip) & mask == u32::from(Ipv4Addr::from(net)) & mask
}

fn classify_v4(ip: Ipv4Addr) -> Class {
    const REFUSED: [([u8; 4], u32); 10] = [
        ([0, 0, 0, 0], 8),
        ([192, 0, 0, 0], 24),
        ([192, 0, 2, 0], 24),
        ([198, 18, 0, 0], 15),
        ([198, 51, 100, 0], 24),
        ([203, 0, 113, 0], 24),
        ([224, 0, 0, 0], 4),
        ([240, 0, 0, 0], 4),
        ([169, 254, 0, 0], 16),
        ([255, 255, 255, 255], 32),
    ];
    const PRIVATE: [([u8; 4], u32); 5] = [
        ([10, 0, 0, 0], 8),
        ([100, 64, 0, 0], 10),
        ([127, 0, 0, 0], 8),
        ([172, 16, 0, 0], 12),
        ([192, 168, 0, 0], 16),
    ];
    if REFUSED.iter().any(|(n, b)| in_v4(ip, *n, *b)) {
        Class::Refused
    } else if PRIVATE.iter().any(|(n, b)| in_v4(ip, *n, *b)) {
        Class::Private
    } else {
        Class::Public
    }
}

fn in_v6(ip: Ipv6Addr, net: u128, bits: u32) -> bool {
    let mask = if bits == 0 {
        0
    } else {
        u128::MAX << (128 - bits)
    };
    u128::from(ip) & mask == net & mask
}

/// The IPv4 address an IPv6 one carries: `::ffff:0:0/96`, `64:ff9b::/96`, the deprecated
/// IPv4-compatible `::/96`, and `64:ff9b:1::/48` (RFC 8215, address bits per RFC 6052).
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let bits = u128::from(ip);
    let compatible = bits >> 32 == 0 && bits > 1;
    if compatible || in_v6(ip, 0xffff << 32, 96) || in_v6(ip, 0x0064_ff9b << 96, 96) {
        return Some(Ipv4Addr::from(bits as u32));
    }
    let o = ip.octets();
    in_v6(ip, 0x0064_ff9b_0001 << 80, 48).then(|| Ipv4Addr::new(o[6], o[7], o[9], o[10]))
}

/// Loopback or a cloud metadata service (`100.100.100.200`, `fd00:ec2::254`), embedded IPv4 included.
pub fn is_loopback_or_metadata(ip: IpAddr) -> bool {
    const AWS_V6: Ipv6Addr = Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254);
    let ip = match ip {
        IpAddr::V6(v6) => embedded_v4(v6).map_or(ip, IpAddr::V4),
        v4 => v4,
    };
    ip.is_loopback() || ip == IpAddr::from([100, 100, 100, 200]) || ip == IpAddr::V6(AWS_V6)
}

fn classify_v6(ip: Ipv6Addr) -> Class {
    if let Some(v4) = embedded_v4(ip) {
        return classify_v4(v4);
    }
    const REFUSED: [(u128, u32); 6] = [
        (0, 128),
        (0xff << 120, 8),
        (0x2002 << 112, 16),
        (0x2001 << 112, 32),
        (0x2001_0db8 << 96, 32),
        (0xfe80 << 112, 10),
    ];
    if REFUSED.iter().any(|(n, b)| in_v6(ip, *n, *b)) {
        Class::Refused
    } else if ip == Ipv6Addr::LOCALHOST || in_v6(ip, 0xfc << 120, 7) || in_v6(ip, 0xfec0 << 112, 10)
    {
        Class::Private
    } else {
        Class::Public
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes() {
        let cases = [
            ("8.8.8.8", Class::Public),
            ("93.184.216.34", Class::Public),
            ("10.1.2.3", Class::Private),
            ("127.0.0.1", Class::Private),
            ("100.64.0.1", Class::Private),
            ("172.31.255.255", Class::Private),
            ("172.32.0.1", Class::Public),
            ("192.168.1.1", Class::Private),
            ("169.254.169.254", Class::Refused),
            ("0.0.0.0", Class::Refused),
            ("224.0.0.1", Class::Refused),
            ("203.0.113.9", Class::Refused),
            ("::1", Class::Private),
            ("::", Class::Refused),
            ("fd00::1", Class::Private),
            ("fe80::1", Class::Refused),
            ("ff02::1", Class::Refused),
            ("2002::1", Class::Refused),
            ("2001::1", Class::Refused),
            ("2001:db8::1", Class::Refused),
            ("::ffff:10.0.0.1", Class::Private),
            ("::ffff:8.8.8.8", Class::Public),
            ("64:ff9b::a9fe:a9fe", Class::Refused),
            ("2606:4700::1111", Class::Public),
            ("fec0::1", Class::Private),
            ("::7f00:1", Class::Private),
            ("::808:808", Class::Public),
            ("2002:0808:0808::1", Class::Refused),
            ("64:ff9b:1:7f00:0:100::", Class::Private),
            ("64:ff9b:1:808:8:800::", Class::Public),
        ];
        for (ip, want) in cases {
            assert_eq!(classify(ip.parse().unwrap()), want, "{ip}");
        }
    }
}

#[cfg(test)]
mod never_tests {
    use super::*;

    #[test]
    fn loopback_and_metadata_through_embedding() {
        for ip in [
            "127.0.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "64:ff9b::7f00:1",
            "64:ff9b::6464:64c8",
            "::7f00:1",
            "64:ff9b:1:7f00:0:100::",
            "100.100.100.200",
            "fd00:ec2::254",
        ] {
            assert!(is_loopback_or_metadata(ip.parse().unwrap()), "{ip}");
        }
        assert!(!is_loopback_or_metadata("10.0.0.1".parse().unwrap()));
        assert!(!is_loopback_or_metadata(
            "64:ff9b::808:808".parse().unwrap()
        ));
    }
}

//! The outbound guard (`plugins.md` "Outbound HTTP guard"): one lookup, every address
//! vetted by `fliks_domain::net`, the connection made to the vetted addresses.
use fliks_domain::net::{Class, classify, is_loopback_or_metadata, is_metadata};
use futures_util::future::BoxFuture;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_rustls::rustls;

pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(5);

/// Name resolution, connect and TLS roots: replaceable by a stub in tests.
pub trait Net: Send + Sync {
    fn lookup(&self, host: &str, port: u16) -> BoxFuture<'static, io::Result<Vec<SocketAddr>>>;
    fn connect(&self, addr: SocketAddr) -> BoxFuture<'static, io::Result<TcpStream>>;
    fn tls(&self) -> Arc<rustls::ClientConfig>;
    /// Where a host-side client dials a vetted address; only a test or `parity` build redirects it.
    #[cfg(any(test, feature = "parity"))]
    fn route(&self, addr: SocketAddr) -> SocketAddr {
        addr
    }
}

pub struct SystemNet {
    tls: Arc<rustls::ClientConfig>,
}

impl SystemNet {
    pub fn new() -> Self {
        Self::with_roots(rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.into(),
        })
    }
    pub fn with_roots(roots: rustls::RootCertStore) -> Self {
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .expect("ring supports the default versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
        SystemNet { tls: Arc::new(tls) }
    }
}

impl Default for SystemNet {
    fn default() -> Self {
        Self::new()
    }
}

impl Net for SystemNet {
    fn lookup(&self, host: &str, port: u16) -> BoxFuture<'static, io::Result<Vec<SocketAddr>>> {
        let host = host.to_owned();
        Box::pin(async move { Ok(tokio::net::lookup_host((host, port)).await?.collect()) })
    }
    fn connect(&self, addr: SocketAddr) -> BoxFuture<'static, io::Result<TcpStream>> {
        Box::pin(TcpStream::connect(addr))
    }
    fn tls(&self) -> Arc<rustls::ClientConfig> {
        self.tls.clone()
    }
}

/// The builder of a client that pins vetted addresses: no proxy, which would dial instead of them.
pub fn client_builder() -> reqwest::ClientBuilder {
    open_builder().no_proxy()
}

/// The builder of a client to a destination the operator or the app fixes, proxy environment honoured.
/// The only `reqwest::Client::builder` of the crate (`clippy.toml`).
#[allow(clippy::disallowed_methods)]
pub fn open_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
}

pub fn system() -> Arc<dyn Net> {
    static NET: OnceLock<Arc<dyn Net>> = OnceLock::new();
    NET.get_or_init(|| Arc::new(SystemNet::new())).clone()
}

/// Why a host is refused, or could not be resolved.
#[derive(Debug, Clone, PartialEq)]
pub enum Refused {
    /// One address of the answer is in a refused class (`class` names it).
    Address(&'static str, IpAddr),
    /// Not found, or no address: final.
    NotFound,
    /// Any other resolver failure.
    Lookup,
    Timeout,
}

fn not_found(e: &io::Error) -> bool {
    let m = e.to_string();
    e.kind() == io::ErrorKind::NotFound
        || m.contains("Name or service not known")
        || m.contains("No address associated with hostname")
        || m.contains("nodename nor servname")
}

/// Resolves once and vets every address; an IP literal is vetted as is. A metadata address is refused
/// always, loopback on `own_ports` (this server's listeners) even when `internal` lifts the private class.
pub async fn vet(
    net: &dyn Net,
    host: &str,
    port: u16,
    internal: bool,
    own_ports: &[u16],
) -> Result<Vec<SocketAddr>, Refused> {
    let addrs = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => match tokio::time::timeout(LOOKUP_TIMEOUT, net.lookup(host, port)).await {
            Err(_) => return Err(Refused::Timeout),
            Ok(Err(e)) if not_found(&e) => return Err(Refused::NotFound),
            Ok(Err(_)) => return Err(Refused::Lookup),
            Ok(Ok(a)) => a,
        },
    };
    if addrs.is_empty() {
        return Err(Refused::NotFound);
    }
    for a in &addrs {
        let ip = a.ip();
        let class = classify(ip);
        if is_metadata(ip) {
            return Err(Refused::Address("metadata", ip));
        }
        if class == Class::Refused || (class == Class::Private && !internal) {
            return Err(Refused::Address(class.name(), ip));
        }
        if own_ports.contains(&a.port()) && is_loopback_or_metadata(ip) {
            return Err(Refused::Address("own", ip));
        }
    }
    Ok(addrs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn internal_lifts_the_private_class_but_not_metadata_or_own_ports() {
        let net = SystemNet::new();
        let ok = |h: &'static str, p| vet(&net, h, p, true, &[4849]);
        assert!(ok("127.0.0.1", 8080).await.is_ok());
        assert!(matches!(
            ok("127.0.0.1", 4849).await,
            Err(Refused::Address("own", _))
        ));
        assert!(matches!(
            ok("::1", 4849).await,
            Err(Refused::Address("own", _))
        ));
        assert!(matches!(
            ok("100.100.100.200", 80).await,
            Err(Refused::Address("metadata", _))
        ));
        assert!(matches!(
            ok("fd00:ec2::254", 80).await,
            Err(Refused::Address("metadata", _))
        ));
        assert!(ok("192.168.1.5", 4849).await.is_ok());
    }
}

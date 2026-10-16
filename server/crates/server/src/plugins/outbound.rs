//! Guest outbound HTTP: one lookup, every address vetted, connect to the vetted address.

use bytes::Bytes;
use fliks_domain::net::{Class, classify};
use futures_util::future::BoxFuture;
use http_body_util::BodyExt;
use std::future::{Future, poll_fn};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::pin::{Pin, pin};
use std::sync::Arc;
use std::task::{Context, Poll, ready};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_rustls::rustls::{self, pki_types::ServerName};
use wasmtime_wasi_http::io::TokioIo;
use wasmtime_wasi_http::{Error, RequestOptions, WasiBody, WasiHttpHooks};

pub trait Net: Send + Sync {
    fn lookup(&self, host: &str, port: u16) -> BoxFuture<'static, io::Result<Vec<SocketAddr>>>;
    fn connect(&self, addr: SocketAddr) -> BoxFuture<'static, io::Result<TcpStream>>;
    fn tls(&self) -> Arc<rustls::ClientConfig>;
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

pub struct Outbound {
    pub plugin_id: Arc<str>,
    pub internal: bool,
    pub net: Arc<dyn Net>,
}

type IoFuture = Box<dyn Future<Output = Result<(), Error>> + Send>;
type Sent = Result<(http::Response<WasiBody>, IoFuture), Error>;

impl WasiHttpHooks for Outbound {
    fn send_request(
        &mut self,
        request: http::Request<WasiBody>,
        options: Option<RequestOptions>,
        fut: IoFuture,
    ) -> Box<dyn Future<Output = Sent> + Send> {
        drop(fut);
        let net = self.net.clone();
        let id = self.plugin_id.clone();
        let internal = self.internal;
        Box::new(async move {
            let (res, io) = send(net, id, internal, request, options).await?;
            Ok((res.map(BodyExt::boxed_unsync), Box::new(io) as IoFuture))
        })
    }
}

/// The addresses a guest request may connect to, in resolver order, or the refusal.
pub async fn vet(
    net: &dyn Net,
    id: &str,
    internal: bool,
    host: &str,
    port: u16,
) -> Result<Vec<SocketAddr>, Error> {
    let addrs = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => net.lookup(host, port).await.map_err(|e| Error::DnsError {
            rcode: Some(e.kind().to_string()),
            info_code: None,
        })?,
    };
    if addrs.is_empty() {
        return Err(Error::DestinationNotFound);
    }
    for a in &addrs {
        let class = classify(a.ip());
        if class == Class::Refused || (class == Class::Private && !internal) {
            tracing::warn!(
                "plugin \"{id}\" outbound refused: {host} resolves to {} address",
                class.name()
            );
            return Err(Error::HttpRequestDenied);
        }
    }
    Ok(addrs)
}

trait Stream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Sync + Unpin + 'static {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Sync + Unpin + 'static> Stream for T {}

const CONNECT: Duration = Duration::from_secs(10);
const FIRST_BYTE: Duration = Duration::from_secs(60);
const BETWEEN_BYTES: Duration = Duration::from_secs(60);

async fn send(
    net: Arc<dyn Net>,
    id: Arc<str>,
    internal: bool,
    mut req: http::Request<WasiBody>,
    options: Option<RequestOptions>,
) -> Result<
    (
        http::Response<IncomingBody>,
        impl Future<Output = Result<(), Error>> + Send,
    ),
    Error,
> {
    let uri = req.uri();
    let tls = uri.scheme() == Some(&http::uri::Scheme::HTTPS);
    let host = uri
        .host()
        .ok_or(Error::HttpRequestUriInvalid)?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = uri.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let pick = |f: fn(&RequestOptions) -> Option<Duration>, cap: Duration| {
        options.as_ref().and_then(f).map_or(cap, |d| d.min(cap))
    };
    let connect_timeout = pick(|o| o.connect_timeout, CONNECT);
    let first_byte = pick(|o| o.first_byte_timeout, FIRST_BYTE);
    let between = pick(|o| o.between_bytes_timeout, BETWEEN_BYTES).max(Duration::new(0, 1));

    let addrs = vet(&*net, &id, internal, &host, port).await?;
    let mut last = None;
    let mut stream = None;
    for a in addrs {
        match tokio::time::timeout(connect_timeout, net.connect(a)).await {
            Ok(Ok(s)) => {
                stream = Some(s);
                break;
            }
            Ok(Err(e)) => last = Some(Error::Connect(e)),
            Err(_) => last = Some(Error::ConnectionTimeout),
        }
    }
    let stream = stream.ok_or_else(|| last.unwrap_or(Error::ConnectionRefused))?;
    let stream: Box<dyn Stream> = if tls {
        let name = match host.parse::<IpAddr>() {
            Ok(ip) => ServerName::from(ip),
            Err(_) => {
                ServerName::try_from(host.clone()).map_err(|_| Error::HttpRequestUriInvalid)?
            }
        };
        let connector = tokio_rustls::TlsConnector::from(net.tls());
        match tokio::time::timeout(connect_timeout, connector.connect(name, stream)).await {
            Ok(Ok(s)) => Box::new(s),
            Ok(Err(e)) => return Err(Error::Tls(e)),
            Err(_) => return Err(Error::ConnectionTimeout),
        }
    } else {
        Box::new(stream)
    };
    let (mut sender, conn) = tokio::time::timeout(
        connect_timeout,
        hyper::client::conn::http1::Builder::new().handshake(TokioIo::new(stream)),
    )
    .await
    .map_err(|_| Error::ConnectionTimeout)??;
    *req.uri_mut() = http::Uri::builder()
        .path_and_query(req.uri().path_and_query().map_or("/", |p| p.as_str()))
        .build()
        .expect("comes from a valid request");

    let send = async move {
        let res = tokio::time::timeout(first_byte, sender.send_request(req))
            .await
            .map_err(|_| Error::ConnectionReadTimeout)?
            .map_err(Error::from)?;
        let mut timeout = tokio::time::interval(between);
        timeout.reset();
        Ok::<_, Error>(res.map(|incoming| IncomingBody { incoming, timeout }))
    };
    let mut send = pin!(send);
    let mut conn = Some(conn);
    let res = poll_fn(|cx| match send.as_mut().poll(cx) {
        Poll::Ready(r) => Poll::Ready(r),
        Poll::Pending => {
            let Some(c) = conn.as_mut() else {
                return Poll::Pending;
            };
            let r = ready!(Pin::new(c).poll(cx));
            conn = None;
            match r {
                Ok(()) => send.as_mut().poll(cx),
                Err(e) => Poll::Ready(Err(Error::from(e))),
            }
        }
    })
    .await?;
    Ok((res, async move {
        match conn.take() {
            Some(c) => c.await.map_err(Error::from),
            None => Ok(()),
        }
    }))
}

pub struct IncomingBody {
    incoming: hyper::body::Incoming,
    timeout: tokio::time::Interval,
}

impl http_body::Body for IncomingBody {
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, Error>>> {
        match Pin::new(&mut self.incoming).poll_frame(cx) {
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(Error::from(e)))),
            Poll::Ready(Some(Ok(f))) => {
                self.timeout.reset();
                Poll::Ready(Some(Ok(f)))
            }
            Poll::Pending => {
                ready!(self.timeout.poll_tick(cx));
                Poll::Ready(Some(Err(Error::ConnectionReadTimeout)))
            }
        }
    }
    fn is_end_stream(&self) -> bool {
        self.incoming.is_end_stream()
    }
}

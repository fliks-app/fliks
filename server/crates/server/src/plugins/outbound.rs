//! Guest outbound HTTP: one lookup, every address vetted, connect to the vetted address.

use crate::net::guard::{self, Net, Refused};
use bytes::Bytes;
use http_body_util::BodyExt;
use std::future::{Future, poll_fn};
use std::net::{IpAddr, SocketAddr};
use std::pin::{Pin, pin};
use std::sync::Arc;
use std::task::{Context, Poll, ready};
use std::time::Duration;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_rustls::rustls::pki_types::ServerName;
use wasmtime_wasi_http::io::TokioIo;
use wasmtime_wasi_http::{Error, RequestOptions, WasiBody, WasiHttpHooks};

/// Most outbound requests one plugin has in flight; the rest queue within the call's deadline.
pub const MAX_IN_FLIGHT: usize = 32;

pub struct Outbound {
    pub plugin_id: Arc<str>,
    pub internal: bool,
    pub net: Arc<dyn Net>,
    pub permits: Arc<Semaphore>,
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
        let permits = self.permits.clone();
        Box::new(async move {
            // The call's deadline aborts a guest still queued here, like any other host wait.
            let permit = Arc::new(permits.acquire_owned().await.expect("never closed"));
            let (res, io) = send(net, id, internal, request, options, permit).await?;
            Ok((res.map(BodyExt::boxed_unsync), Box::new(io) as IoFuture))
        })
    }
}

/// The addresses a guest request may connect to, or the `wasi:http` error it sees.
pub async fn vet(
    net: &dyn Net,
    id: &str,
    internal: bool,
    host: &str,
    port: u16,
) -> Result<Vec<SocketAddr>, Error> {
    guard::vet(net, host, port, internal)
        .await
        .map_err(|r| match r {
            Refused::Address(class) => {
                tracing::warn!(
                    "plugin \"{id}\" outbound refused: {host} resolves to {class} address"
                );
                Error::HttpRequestDenied
            }
            Refused::NotFound => Error::DnsError {
                rcode: Some("NXDOMAIN".into()),
                info_code: None,
            },
            Refused::Lookup => Error::DnsError {
                rcode: Some("SERVFAIL".into()),
                info_code: None,
            },
            Refused::Timeout => Error::DnsTimeout,
        })
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
    permit: Arc<OwnedSemaphorePermit>,
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

    let body_permit = permit.clone();
    let send = async move {
        let res = tokio::time::timeout(first_byte, sender.send_request(req))
            .await
            .map_err(|_| Error::ConnectionReadTimeout)?
            .map_err(Error::from)?;
        let mut timeout = tokio::time::interval(between);
        timeout.reset();
        Ok::<_, Error>(res.map(|incoming| IncomingBody {
            incoming,
            timeout,
            _permit: body_permit,
        }))
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
        let _permit = permit;
        match conn.take() {
            Some(c) => c.await.map_err(Error::from),
            None => Ok(()),
        }
    }))
}

pub struct IncomingBody {
    incoming: hyper::body::Incoming,
    timeout: tokio::time::Interval,
    _permit: Arc<OwnedSemaphorePermit>,
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

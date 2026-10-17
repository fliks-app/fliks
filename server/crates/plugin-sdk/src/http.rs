//! Blocking HTTP client over `wasi:http/outgoing-handler`; the host vets every address.

use crate::bindings::wasi::http::outgoing_handler;
use crate::bindings::wasi::http::types::{
    ErrorCode, Fields, IncomingBody, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// The host's outbound guard refused the address; its text is fixed by plugins.md.
    Denied,
    Dns(String),
    Refused,
    Timeout,
    Tls,
    InvalidUrl,
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Denied => f.write_str("target address is not allowed"),
            Error::Dns(d) => write!(f, "DNS lookup failed: {d}"),
            Error::Refused => f.write_str("connection refused"),
            Error::Timeout => f.write_str("timeout"),
            Error::Tls => f.write_str("TLS error"),
            Error::InvalidUrl => f.write_str("not a valid URL"),
            Error::Other(t) => f.write_str(t),
        }
    }
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, Vec<u8>)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<String> {
        let (_, v) = self
            .headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))?;
        Some(String::from_utf8_lossy(v).into_owned())
    }
}

pub struct Request {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub timeout: Duration,
    /// Response bytes kept; the rest is drained and dropped.
    pub body_cap: usize,
}

impl Request {
    pub fn new(method: Method, url: impl Into<String>) -> Self {
        Request {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: Vec::new(),
            timeout: Duration::from_secs(60),
            body_cap: 32 << 20,
        }
    }
    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }
    /// Connect, first byte and between bytes all use this value.
    pub fn timeout(mut self, t: Duration) -> Self {
        self.timeout = t;
        self
    }
    pub fn body_cap(mut self, cap: usize) -> Self {
        self.body_cap = cap;
        self
    }

    pub fn send(self) -> Result<Response, Error> {
        let (scheme, rest) = self.url.split_once("://").ok_or(Error::InvalidUrl)?;
        let scheme = match scheme.to_ascii_lowercase().as_str() {
            "https" => Scheme::Https,
            "http" => Scheme::Http,
            _ => return Err(Error::InvalidUrl),
        };
        let (authority, path) = match rest.find(['/', '?']) {
            Some(i) if rest.as_bytes()[i] == b'/' => (&rest[..i], rest[i..].to_owned()),
            Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
            None => (rest, "/".to_owned()),
        };
        if authority.is_empty() {
            return Err(Error::InvalidUrl);
        }
        let fields = Fields::new();
        for (n, v) in &self.headers {
            fields
                .append(n, v.as_bytes())
                .map_err(|e| Error::Other(format!("header {n}: {e:?}")))?;
        }
        // A known length, so receivers that refuse chunked bodies still accept it.
        if !self.body.is_empty() {
            let len = self.body.len().to_string().into_bytes();
            fields
                .append("content-length", &len)
                .map_err(|e| Error::Other(format!("content-length: {e:?}")))?;
        }
        let req = OutgoingRequest::new(fields);
        let bad = |_| Error::InvalidUrl;
        req.set_method(&self.method).map_err(bad)?;
        req.set_scheme(Some(&scheme)).map_err(bad)?;
        req.set_authority(Some(authority)).map_err(bad)?;
        req.set_path_with_query(Some(&path)).map_err(bad)?;
        let out = req.body().map_err(|_| Error::Other("body taken".into()))?;
        let opts = RequestOptions::new();
        let ns = self.timeout.as_nanos() as u64;
        let _ = opts.set_connect_timeout(Some(ns));
        let _ = opts.set_first_byte_timeout(Some(ns));
        let _ = opts.set_between_bytes_timeout(Some(ns));
        let fut = outgoing_handler::handle(req, Some(opts)).map_err(map_code)?;
        {
            let stream = out
                .write()
                .map_err(|_| Error::Other("body stream".into()))?;
            for chunk in self.body.chunks(4096) {
                stream
                    .blocking_write_and_flush(chunk)
                    .map_err(|e| Error::Other(format!("write: {e:?}")))?;
            }
        }
        OutgoingBody::finish(out, None).map_err(map_code)?;
        fut.subscribe().block();
        let resp = fut
            .get()
            .ok_or_else(|| Error::Other("response not ready".into()))?
            .map_err(|_| Error::Other("response taken".into()))?
            .map_err(map_code)?;
        let status = resp.status();
        let headers = resp.headers().entries();
        let incoming = resp
            .consume()
            .map_err(|_| Error::Other("body taken".into()))?;
        let body = read_body(&incoming, self.body_cap)?;
        IncomingBody::finish(incoming);
        Ok(Response {
            status,
            headers,
            body,
        })
    }
}

fn read_body(incoming: &IncomingBody, cap: usize) -> Result<Vec<u8>, Error> {
    let stream = incoming
        .stream()
        .map_err(|_| Error::Other("body stream".into()))?;
    let mut body = Vec::new();
    loop {
        match stream.blocking_read(64 * 1024) {
            Ok(bytes) => {
                let room = cap.saturating_sub(body.len());
                body.extend_from_slice(&bytes[..bytes.len().min(room)]);
            }
            Err(crate::bindings::wasi::io::streams::StreamError::Closed) => break,
            Err(e) => return Err(Error::Other(format!("read: {e:?}"))),
        }
    }
    Ok(body)
}

fn map_code(code: ErrorCode) -> Error {
    match code {
        ErrorCode::HttpRequestDenied | ErrorCode::DestinationIpProhibited => Error::Denied,
        ErrorCode::DnsError(p) => Error::Dns(p.rcode.unwrap_or_else(|| "lookup failed".into())),
        ErrorCode::DnsTimeout => Error::Dns("timeout".into()),
        ErrorCode::DestinationNotFound => Error::Dns("not found".into()),
        ErrorCode::ConnectionRefused => Error::Refused,
        ErrorCode::ConnectionTimeout
        | ErrorCode::ConnectionReadTimeout
        | ErrorCode::HttpResponseTimeout => Error::Timeout,
        ErrorCode::TlsProtocolError
        | ErrorCode::TlsCertificateError
        | ErrorCode::TlsAlertReceived(_) => Error::Tls,
        ErrorCode::HttpRequestUriInvalid => Error::InvalidUrl,
        other => Error::Other(format!("{other:?}")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn denied_text() {
        assert_eq!(
            super::Error::Denied.to_string(),
            "target address is not allowed"
        );
    }
}

//! A loopback HTTP server for the client unit tests.
use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

/// What the server answers: status, `Retry-After`, JSON body.
pub type Reply = (u16, Option<String>, String);

/// Answers each request with `handler(path without query, request number from 0)`; returns the base
/// URL and the request counter.
pub async fn serve(
    handler: impl Fn(&str, u32) -> Reply + Send + 'static,
) -> (String, Arc<AtomicU32>) {
    let hits = Arc::new(AtomicU32::new(0));
    let seen = hits.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = listener.accept().await.unwrap();
            let n = seen.fetch_add(1, Ordering::Relaxed);
            let mut buf = [0u8; 4096];
            let read = sock.read(&mut buf).await.unwrap_or(0);
            let line = String::from_utf8_lossy(&buf[..read]);
            let target = line.split_whitespace().nth(1).unwrap_or("/");
            let path = target.split('?').next().unwrap_or("/");
            let (status, after, body) = handler(path, n);
            let retry = after.map_or(String::new(), |a| format!("Retry-After: {a}\r\n"));
            let reply = format!(
                "HTTP/1.1 {status} X\r\n{retry}Content-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(reply.as_bytes()).await;
        }
    });
    (url, hits)
}

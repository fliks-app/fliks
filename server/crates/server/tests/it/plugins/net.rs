//! The outbound guard guest requests, catalog archive redirects, webhooks.
use super::harness::*;
use fliks_server::net::guard::Net;
use fliks_server::plugins::fetch::{ArchiveError, Fetcher};
use fliks_server::plugins::outbound;
use fliks_server::plugins::runtime::{HttpRequest, Principal};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::rustls;

pub struct Pki {
    pub roots: rustls::RootCertStore,
    pub server: Arc<rustls::ServerConfig>,
    pub ca_pem: String,
}

pub fn pki(names: &[&str]) -> Pki {
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let ca_cert = ca.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca, ca_key);
    let leaf_key = rcgen::KeyPair::generate().unwrap();
    let leaf =
        rcgen::CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
            .unwrap()
            .signed_by(&leaf_key, &issuer)
            .unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca_cert.der().clone()).unwrap();
    let key = rustls::pki_types::PrivateKeyDer::Pkcs8(leaf_key.serialize_der().into());
    let server = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![leaf.der().clone()], key)
    .unwrap();
    Pki {
        roots,
        server: Arc::new(server),
        ca_pem: ca_cert.pem(),
    }
}

#[derive(Clone, Debug)]
pub struct Hit {
    pub sni: Option<String>,
    pub path: String,
    pub body: String,
    pub head: String,
}

pub type Reply = Arc<dyn Fn(&str) -> (u16, Vec<(String, String)>, Vec<u8>) + Send + Sync>;

/// A TLS stub on an ephemeral port: every request is recorded and answered by `reply`.
pub async fn stub(tls: Arc<rustls::ServerConfig>, reply: Reply) -> (u16, Arc<Mutex<Vec<Hit>>>) {
    let hits: Arc<Mutex<Vec<Hit>>> = Arc::default();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let acceptor = tokio_rustls::TlsAcceptor::from(tls);
    let h = hits.clone();
    tokio::spawn(async move {
        loop {
            let Ok((s, _)) = listener.accept().await else {
                return;
            };
            let (acceptor, h, reply) = (acceptor.clone(), h.clone(), reply.clone());
            tokio::spawn(async move {
                let Ok(mut s) = acceptor.accept(s).await else {
                    return;
                };
                let sni = s.get_ref().1.server_name().map(str::to_owned);
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let head_end = loop {
                    let Ok(n) = s.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i + 4;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let len: usize = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap_or(0))
                    })
                    .unwrap_or(0);
                while buf.len() < head_end + len {
                    let Ok(n) = s.read(&mut chunk).await else {
                        return;
                    };
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let path = head.split_whitespace().nth(1).unwrap_or("").to_owned();
                h.lock().unwrap().push(Hit {
                    sni,
                    path: path.clone(),
                    body: String::from_utf8_lossy(&buf[head_end..]).to_string(),
                    head,
                });
                let (code, headers, body) = reply(&path);
                let mut out = format!(
                    "HTTP/1.1 {code} X\r\ncontent-length: {}\r\nconnection: close\r\n",
                    body.len()
                )
                .into_bytes();
                for (k, v) in headers {
                    out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
                }
                out.extend_from_slice(b"\r\n");
                out.extend_from_slice(&body);
                let _ = s.write_all(&out).await;
                let _ = s.shutdown().await;
            });
        }
    });
    (port, hits)
}

/// Answers each name from a queue (the last answer repeats); every connection goes to the stub.
pub struct StubNet {
    answers: Mutex<HashMap<String, VecDeque<Vec<IpAddr>>>>,
    pub lookups: Mutex<Vec<String>>,
    pub connects: Mutex<Vec<SocketAddr>>,
    port: u16,
    tls: Arc<rustls::ClientConfig>,
    slow: Vec<String>,
    failing: Vec<String>,
}

impl StubNet {
    pub fn new(
        port: u16,
        roots: rustls::RootCertStore,
        answers: &[(&str, &[&[&str]])],
    ) -> Arc<Self> {
        let answers = answers
            .iter()
            .map(|(n, a)| {
                (
                    (*n).to_owned(),
                    a.iter()
                        .map(|ips| ips.iter().map(|ip| ip.parse().unwrap()).collect())
                        .collect(),
                )
            })
            .collect();
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        Arc::new(StubNet {
            answers: Mutex::new(answers),
            lookups: Mutex::default(),
            connects: Mutex::default(),
            port,
            tls: Arc::new(tls),
            slow: vec!["slow.test".into()],
            failing: vec!["servfail.test".into()],
        })
    }
}

impl Net for StubNet {
    fn lookup(
        &self,
        host: &str,
        port: u16,
    ) -> BoxFuture<'static, std::io::Result<Vec<SocketAddr>>> {
        self.lookups.lock().unwrap().push(host.to_owned());
        if self.slow.iter().any(|s| s == host) {
            return Box::pin(async {
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(vec![])
            });
        }
        if self.failing.iter().any(|s| s == host) {
            return Box::pin(async { Err(std::io::Error::other("resolver unreachable")) });
        }
        let mut a = self.answers.lock().unwrap();
        let r = match a.get_mut(host) {
            Some(q) if q.len() > 1 => Ok(q.pop_front().unwrap()),
            Some(q) => Ok(q[0].clone()),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no such host",
            )),
        };
        Box::pin(async move {
            r.map(|ips| {
                ips.into_iter()
                    .map(|ip| SocketAddr::new(ip, port))
                    .collect()
            })
        })
    }
    fn connect(&self, addr: SocketAddr) -> BoxFuture<'static, std::io::Result<TcpStream>> {
        self.connects.lock().unwrap().push(addr);
        let port = self.port;
        Box::pin(async move { TcpStream::connect(("127.0.0.1", port)).await })
    }
    fn tls(&self) -> Arc<rustls::ClientConfig> {
        self.tls.clone()
    }
    fn route(&self, addr: SocketAddr) -> SocketAddr {
        self.connects.lock().unwrap().push(addr);
        SocketAddr::from(([127, 0, 0, 1], self.port))
    }
}

const ANSWERS: &[(&str, &[&[&str]])] = &[
    ("pub.test", &[&["93.184.216.34"]]),
    ("other.test", &[&["93.184.216.34"]]),
    ("rebind.test", &[&["93.184.216.35"], &["10.0.0.9"]]),
    ("mixed.test", &[&["93.184.216.36", "10.0.0.5"]]),
    ("priv.test", &[&["10.0.0.7"]]),
    ("meta.test", &[&["169.254.169.254"]]),
    ("sixtofour.test", &[&["2002:c000:0204::1"]]),
];

fn fetch(url: &str) -> HttpRequest {
    HttpRequest {
        method: "GET".into(),
        path: "/test/fetch".into(),
        query: vec![("url".into(), url.into())],
        body: vec![],
        principal: Principal::Delegated(1),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn guest_outbound_guard() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("guard").await else {
        return;
    };
    let p = pki(&["pub.test", "rebind.test", "priv.test"]);
    let reply: Reply = Arc::new(|path| {
        if path == "/redirect" {
            (
                302,
                vec![("location".into(), "https://pub.test/next".into())],
                b"ok".to_vec(),
            )
        } else {
            (200, vec![], b"ok".to_vec())
        }
    });
    let (port, hits) = stub(p.server.clone(), reply).await;
    for internal in [false, true] {
        let net = StubNet::new(port, p.roots.clone(), ANSWERS);
        let n2 = net.clone();
        let h = harness_with(&s, "guard", Arc::new(|_| {}), move |o| {
            o.fetch.net = n2.clone()
        })
        .await;
        allow_unsigned(&h).await;
        let mut man = m.clone();
        if internal {
            man["network"] = json!({"internal": true});
        }
        let _ = h
            .call("DELETE", "/api/plugins/fliks.fixture", Some(&h.admin), None)
            .await;
        assert_eq!(
            h.install(&pack(&man, "0.1.0", &w, None)).await["status"],
            "active"
        );
        let rt = h.st.plugins.rt("fliks.fixture").unwrap();
        let mut o = HashMap::new();
        let mut refused = vec![];
        for (name, url) in [
            ("public", "https://pub.test/a"),
            ("cert-mismatch", "https://other.test/a"),
            ("rebind", "https://rebind.test/a"),
            ("mixed", "https://mixed.test/a"),
            ("private", "https://priv.test/a"),
            ("literal-private", "https://127.0.0.1:443/a"),
            ("link-local", "https://meta.test/a"),
            ("6to4", "https://sixtofour.test/a"),
            ("redirect", "https://pub.test/redirect"),
            ("nxdomain", "https://missing.test/a"),
            ("servfail", "https://servfail.test/a"),
            ("dns-timeout", "https://slow.test/a"),
        ] {
            let r = rt.http(fetch(url), false).await.unwrap();
            o.insert(name, serde_json::from_slice::<Value>(&r.body).unwrap());
            // Read at once: concurrent tests share the log ring and can evict the line.
            if name == "private" {
                refused = fliks_server::system::logs::query(
                    "warn",
                    "outbound refused: priv.test resolves to private address",
                    None,
                );
            }
        }
        if !internal {
            assert_eq!(o["public"]["status"], 200);
            assert!(
                o["cert-mismatch"]["error"]
                    .as_str()
                    .unwrap()
                    .contains("Tls")
            );
            assert_eq!(o["rebind"]["status"], 200);
            for k in ["mixed", "private", "literal-private", "link-local", "6to4"] {
                assert_eq!(o[k]["error"], "Denied", "{k}");
            }
            assert_eq!(o["redirect"]["status"], 302);
            assert_eq!(o["nxdomain"]["error"], "Dns(\"NXDOMAIN\")");
            assert_eq!(o["servfail"]["error"], "Dns(\"SERVFAIL\")");
            assert_eq!(o["dns-timeout"]["error"], "Dns(\"timeout\")");
            assert_eq!(
                net.lookups
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|l| *l == "rebind.test")
                    .count(),
                1
            );
            let connects = net.connects.lock().unwrap().clone();
            assert!(connects.contains(&"93.184.216.35:443".parse().unwrap()));
            assert!(
                !connects
                    .iter()
                    .any(|a| a.ip().to_string().starts_with("10."))
            );
            assert_eq!(
                hits.lock()
                    .unwrap()
                    .iter()
                    .filter(|h| h.path == "/next")
                    .count(),
                0,
                "302 not followed"
            );
            assert!(
                !refused.is_empty() && refused.iter().all(|e| !e.message.contains("https://")),
                "no URL in the refusal"
            );
        } else {
            assert_eq!(o["private"]["status"], 200);
            assert_eq!(o["link-local"]["error"], "Denied");
            assert_eq!(o["6to4"]["error"], "Denied");
        }
        h.finish().await;
    }
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn catalog_archive_redirects() {
    let p = pki(&["localhost", "cdn.test", "priv.test"]);
    let zip = b"PK\x03\x04archive".to_vec();
    let z2 = zip.clone();
    let reply: Reply = Arc::new(move |path| match path {
        "/same" => (302, vec![("location".into(), "/final".into())], vec![]),
        "/github" => (
            302,
            vec![("location".into(), "https://cdn.test/asset".into())],
            vec![],
        ),
        "/private" => (
            302,
            vec![("location".into(), "https://priv.test/asset".into())],
            vec![],
        ),
        "/http" => (
            302,
            vec![("location".into(), "http://cdn.test/asset".into())],
            vec![],
        ),
        "/loop" => (302, vec![("location".into(), "/loop".into())], vec![]),
        "/big" => (200, vec![], vec![0u8; 2048]),
        _ => (200, vec![], z2.clone()),
    });
    let (port, hits) = stub(p.server.clone(), reply).await;
    let net = StubNet::new(
        port,
        p.roots.clone(),
        &[
            ("cdn.test", &[&["93.184.216.34"]]),
            ("priv.test", &[&["10.0.0.7"]]),
        ],
    );
    let f = Fetcher {
        net,
        roots: vec![reqwest::Certificate::from_pem(p.ca_pem.as_bytes()).unwrap()],
    };
    let base = format!("https://localhost:{port}");
    assert_eq!(
        f.archive(&format!("{base}/same"), 1 << 20).await.unwrap(),
        zip,
        "a hop on the zipUrl host is trusted"
    );
    assert_eq!(
        f.archive(&format!("{base}/github"), 1 << 20).await.unwrap(),
        zip,
        "a guarded hop to a public host"
    );
    assert!(
        hits.lock()
            .unwrap()
            .iter()
            .any(|h| h.sni.as_deref() == Some("cdn.test") && h.path == "/asset")
    );
    assert_eq!(
        f.archive(&format!("{base}/private"), 1 << 20).await,
        Err(ArchiveError::Failed("redirect target refused".into()))
    );
    assert!(matches!(
        f.archive(&format!("{base}/http"), 1 << 20).await,
        Err(ArchiveError::Failed(_))
    ));
    assert_eq!(
        f.archive(&format!("{base}/loop"), 1 << 20).await,
        Err(ArchiveError::Failed("too many redirects".into()))
    );
    assert_eq!(
        f.archive(&format!("{base}/big"), 1024).await,
        Err(ArchiveError::TooLarge)
    );
    assert!(matches!(
        f.archive("http://localhost/x", 1024).await,
        Err(ArchiveError::Failed(_))
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn webhooks_resolve_once_and_never_leak_urls() {
    let Some(s) = Scratch::create("hooks").await else {
        return;
    };
    let p = pki(&["hooks.test", "priv.test"]);
    let (port, hits) = stub(
        p.server.clone(),
        Arc::new(|path| {
            if path == "/fail" {
                (500, vec![], vec![])
            } else {
                (200, vec![], vec![])
            }
        }),
    )
    .await;
    let net = StubNet::new(
        port,
        p.roots.clone(),
        &[
            ("hooks.test", &[&["93.184.216.40"]]),
            ("priv.test", &[&["10.0.0.7"]]),
        ],
    );
    let ca = reqwest::Certificate::from_pem(p.ca_pem.as_bytes()).unwrap();
    let n2 = net.clone();
    let h = harness_with(&s, "hooks", Arc::new(|_| {}), move |o| {
        o.fetch = Fetcher {
            net: n2.clone(),
            roots: vec![ca.clone()],
        };
    })
    .await;
    let manifest = json!({"id":"acme.hooks","pluginApi":3,"name":"Hooks","version":"1.0.0","fliks":">=5.0.0 <6.0.0",
        "author":"a","description":"d","license":"MIT","logo":"logo.svg","kind":"data",
        "events":[{"event":"media.removed","webhook":"setting:url"},{"event":"media.imported","webhook":"setting:url"}],
        "ui":{"configPages":[{"id":"general","labelKey":"x.y","fields":[{"key":"url","type":"url","labelKey":"x.url"}]}]}});
    assert_eq!(
        h.install(&data_archive(&manifest)).await["status"],
        "active"
    );
    let (_, r) = h
        .call(
            "POST",
            "/api/plugins/acme.hooks/events/test",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        r,
        json!({"configured": false, "delivered": 0, "failures": []})
    );
    h.set(
        "plugin.acme.hooks.url",
        "https://hooks.test/ok?token=secret",
    )
    .await;
    let (_, r) = h
        .call(
            "POST",
            "/api/plugins/acme.hooks/events/test",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(r["delivered"], 2, "{r}");
    assert!(hits.lock().unwrap().iter().all(|h| {
        h.head
            .to_ascii_lowercase()
            .contains("user-agent: fliks-plugin-webhook/1.0")
    }));
    let body: Value = serde_json::from_str(&hits.lock().unwrap()[0].body).unwrap();
    assert_eq!(body["test"], true);
    assert_eq!(
        net.lookups.lock().unwrap().len(),
        2,
        "one lookup per delivery, then the vetted address"
    );
    h.set("plugin.acme.hooks.url", "https://priv.test/x?token=secret")
        .await;
    let (_, r) = h
        .call(
            "POST",
            "/api/plugins/acme.hooks/events/test",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        r["failures"],
        json!([
            "media.removed: target refused",
            "media.imported: target refused"
        ])
    );
    h.set(
        "plugin.acme.hooks.url",
        "https://hooks.test/fail?token=secret",
    )
    .await;
    let (_, r) = h
        .call(
            "POST",
            "/api/plugins/acme.hooks/events/test",
            Some(&h.admin),
            None,
        )
        .await;
    for f in r["failures"].as_array().unwrap() {
        assert!(
            !f.as_str().unwrap().contains("secret") && !f.as_str().unwrap().contains("hooks.test"),
            "no secret in {f}"
        );
    }
    let warned = fliks_server::system::logs::query("warn", "acme.hooks", None);
    assert!(
        warned.iter().all(|e| !e.message.contains("secret")),
        "no secret in the logs"
    );
    h.finish().await;
    s.finish().await;
}

/// A plain-HTTP stub: `/hold` answers after a second, and the peak of `/hold` requests in flight is kept.
async fn hold_stub() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    let (cur, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let p = peak.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = listener.accept().await else {
                return;
            };
            let (cur, peak) = (cur.clone(), p.clone());
            tokio::spawn(async move {
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let hold = String::from_utf8_lossy(&buf[..n]).contains("GET /hold");
                if hold {
                    peak.fetch_max(cur.fetch_add(1, SeqCst) + 1, SeqCst);
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    cur.fetch_sub(1, SeqCst);
                }
                let _ = s
                    .write_all(
                        b"HTTP/1.1 200 X\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
                    )
                    .await;
            });
        }
    });
    (port, peak)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn guest_outbound_in_flight_cap() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("cap").await else {
        return;
    };
    let (port, peak) = hold_stub().await;
    let net = StubNet::new(
        port,
        rustls::RootCertStore::empty(),
        &[("pub.test", &[&["93.184.216.34"]])],
    );
    let h = harness_with(
        &s,
        "cap",
        Arc::new(|c| {
            c.http_max = 40;
            c.http_queue = 64;
            c.deadlines.http = Duration::from_secs(30);
        }),
        move |o| o.fetch.net = net.clone(),
    )
    .await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let a = h.st.plugins.rt("fliks.fixture").unwrap();
    let total = outbound::MAX_IN_FLIGHT + 8;
    let held: Vec<_> = (0..total)
        .map(|_| {
            let a = a.clone();
            tokio::spawn(async move { a.http(fetch("http://pub.test/hold"), false).await })
        })
        .collect();
    for j in held {
        let r = j.await.unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&r.body).unwrap()["status"],
            200,
            "a queued request completes"
        );
    }
    assert_eq!(
        peak.load(std::sync::atomic::Ordering::SeqCst),
        outbound::MAX_IN_FLIGHT
    );
    h.finish().await;
    s.finish().await;
}

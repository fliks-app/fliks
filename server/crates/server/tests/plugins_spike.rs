//! S8 spike exit criteria (plugins.md "Spike exit criteria"), measured against real components.
//! Needs SPIKE_PG_URL (maintenance db URL) and SPIKE_WASM_DIR; skipped otherwise. Run serially:
//! plugin roles are cluster-global.

use fliks_server::plugins::archive;
use fliks_server::plugins::db::PgTarget;
use fliks_server::plugins::logs::Level;
use fliks_server::plugins::outbound::{Net, SystemNet};
use fliks_server::plugins::runtime::{CallError, HostConfig, State};
use fliks_server::plugins::{Host, HttpRequest, HttpResponse, Principal};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::rustls;

const PORT_HOOK: u16 = 4900;
const PORT_TLS: u16 = 4901;

struct Scratch {
    admin: PgPool,
    pool: PgPool,
    target: PgTarget,
    dir: PathBuf,
}

fn wasm(name: &str) -> Vec<u8> {
    let dir = std::env::var("SPIKE_WASM_DIR").expect("SPIKE_WASM_DIR");
    std::fs::read(PathBuf::from(dir).join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn template(example: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../plugin-sdk/examples")
        .join(example)
        .join("plugin.template.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

async fn scratch(name: &str) -> Option<Scratch> {
    let Ok(url) = std::env::var("SPIKE_PG_URL") else {
        eprintln!("SPIKE_PG_URL unset: skipping {name}");
        return None;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let db = format!("s8spike_{name}");
    sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
    sqlx::raw_sql(&format!("CREATE DATABASE {db}"))
        .execute(&admin)
        .await
        .unwrap();
    let opts: sqlx::postgres::PgConnectOptions = url.parse().unwrap();
    let pool = PgPool::connect_with(opts.clone().database(&db))
        .await
        .unwrap();
    fliks_server::db::migrate(&pool).await.unwrap();
    let target = PgTarget {
        host: opts.get_host().to_owned(),
        port: opts.get_port(),
        dbname: db.clone(),
    };
    let dir = PathBuf::from(format!("/tmp/fliks-parity/s8-spike/{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Some(Scratch {
        admin,
        pool,
        target,
        dir,
    })
}

impl Scratch {
    fn cfg(&self, net: Arc<dyn Net>) -> HostConfig {
        HostConfig::new("5.0.0", self.dir.clone(), self.target.clone(), net)
    }
    async fn finish(self, ids: &[&str]) {
        self.pool.close().await;
        // Tests run serially; a failed earlier test may have left its database behind.
        let dbs: Vec<String> = sqlx::query_scalar(
            "SELECT datname::text FROM pg_database WHERE datname LIKE 's8spike\\_%'",
        )
        .fetch_all(&self.admin)
        .await
        .unwrap();
        for db in dbs {
            sqlx::raw_sql(&format!("DROP DATABASE IF EXISTS {db} WITH (FORCE)"))
                .execute(&self.admin)
                .await
                .unwrap();
        }
        for id in ids {
            let role = fliks_server::plugins::db::ident(id);
            sqlx::raw_sql(&format!("DROP ROLE IF EXISTS \"{role}\""))
                .execute(&self.admin)
                .await
                .unwrap();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn req(method: &str, path: &str, query: &[(&str, &str)], body: &[u8]) -> HttpRequest {
    HttpRequest {
        method: method.into(),
        path: path.into(),
        query: query
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        body: body.to_vec(),
        principal: Principal::Delegated(1),
    }
}

fn body(r: &HttpResponse) -> Value {
    serde_json::from_slice(&r.body).unwrap_or(Value::Null)
}

fn pct(v: &mut [Duration], p: f64) -> Duration {
    v.sort();
    let i = ((p / 100.0) * v.len() as f64).ceil() as usize;
    v[i.saturating_sub(1).min(v.len() - 1)]
}

fn rss_kib(field: &str) -> u64 {
    let s = std::fs::read_to_string("/proc/self/status").unwrap();
    let line = s.lines().find(|l| l.starts_with(field)).unwrap();
    line.split_whitespace().nth(1).unwrap().parse().unwrap()
}

async fn until(what: &str, max: Duration, mut f: impl AsyncFnMut() -> bool) {
    let t = Instant::now();
    while !f().await {
        assert!(t.elapsed() < max, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// --- TLS stub, programmable resolver ---

struct Pki {
    roots: rustls::RootCertStore,
    server: Arc<rustls::ServerConfig>,
}

fn pki(names: &[&str]) -> Pki {
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
    }
}

#[derive(Clone, Debug)]
struct Hit {
    at: Instant,
    sni: Option<String>,
    path: String,
    body: String,
}

type Reply = Arc<dyn Fn(usize, &str) -> (u16, Vec<(String, String)>) + Send + Sync>;

async fn stub(port: u16, tls: Arc<rustls::ServerConfig>, reply: Reply) -> Arc<Mutex<Vec<Hit>>> {
    let hits: Arc<Mutex<Vec<Hit>>> = Arc::default();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap();
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
                let n = {
                    let mut h = h.lock().unwrap();
                    h.push(Hit {
                        at: Instant::now(),
                        sni,
                        path: path.clone(),
                        body: String::from_utf8_lossy(&buf[head_end..]).to_string(),
                    });
                    h.len()
                };
                let (code, headers) = reply(n, &path);
                let mut out =
                    format!("HTTP/1.1 {code} X\r\ncontent-length: 2\r\nconnection: close\r\n");
                for (k, v) in headers {
                    out.push_str(&format!("{k}: {v}\r\n"));
                }
                out.push_str("\r\nok");
                let _ = s.write_all(out.as_bytes()).await;
                let _ = s.shutdown().await;
            });
        }
    });
    hits
}

/// Answers each name from a queue (the last answer repeats); every connect goes to the stub.
struct StubNet {
    answers: Mutex<HashMap<String, VecDeque<Vec<IpAddr>>>>,
    lookups: Mutex<Vec<String>>,
    connects: Mutex<Vec<SocketAddr>>,
    port: u16,
    tls: Arc<rustls::ClientConfig>,
}

impl StubNet {
    fn new(port: u16, roots: rustls::RootCertStore, answers: &[(&str, &[&[&str]])]) -> Arc<Self> {
        let answers = answers
            .iter()
            .map(|(n, a)| {
                let q = a
                    .iter()
                    .map(|ips| ips.iter().map(|ip| ip.parse().unwrap()).collect())
                    .collect();
                ((*n).to_owned(), q)
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
}

fn notify_archive() -> Vec<u8> {
    archive::pack(
        &template("fk-plugin-notify"),
        "1.0.0",
        &wasm("fk_plugin_notify.wasm"),
    )
}

fn spike_archive(version: &str, internal: bool) -> Vec<u8> {
    let mut t = template("spike-guest");
    if internal {
        t["network"] = json!({ "internal": true });
    }
    archive::pack(&t, version, &wasm("spike_guest.wasm"))
}

// --- Criterion 1: install, event delivery with retry across a host restart, config, health ---

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn c1_notify_delivery_retry_restart() {
    let Some(s) = scratch("c1").await else { return };
    let pki = pki(&["hook.test"]);
    let reply: Reply = Arc::new(|n, _| (if n <= 5 { 500 } else { 204 }, vec![]));
    let hits = stub(PORT_HOOK, pki.server.clone(), reply).await;
    let net = StubNet::new(
        PORT_HOOK,
        pki.roots.clone(),
        &[("hook.test", &[&["93.184.216.34"]])],
    );
    let mut cfg = s.cfg(net.clone());
    cfg.health_every = Duration::from_millis(500);
    let host = Host::new(s.pool.clone(), cfg.clone()).unwrap();
    let t = Instant::now();
    let id = host.install(&notify_archive(), false).await.unwrap();
    println!("METRIC c1 install+boot notify {:?}", t.elapsed());
    assert_eq!(id, "fliks.notify");
    let rt = host.get(&id).unwrap();
    assert_eq!(rt.state(), State::Ready);
    let h = rt.health().await.unwrap();
    assert!(h.ok, "{h:?}");
    println!("METRIC c1 health detail {:?}", h.detail);

    // Config: no target yet, then set live (config-changed reaches the instances).
    let r = host
        .http(&id, req("POST", "/test-delivery", &[], b"{}"))
        .await
        .unwrap();
    assert_eq!(r.status, 202);
    host.set_config(&id, "target_url", Some("https://hook.test/hook"))
        .await
        .unwrap();
    let log = host
        .http(&id, req("GET", "/delivery-log", &[], b""))
        .await
        .unwrap();
    let entries = body(&log)["entries"].clone();
    assert_eq!(
        entries[0]["lastStatus"], "refused:no target configured",
        "{entries}"
    );
    assert!(
        host.env
            .logs
            .lines()
            .iter()
            .any(|l| l.text.contains("config changed: target_url"))
    );

    host.publish("media.imported", r#"{"type":"media.imported","mediaId":7}"#);
    until("two attempts", Duration::from_secs(30), async || {
        hits.lock().unwrap().len() >= 2
    })
    .await;
    host.shutdown().await;
    drop(host);
    println!(
        "METRIC c1 host stopped after attempt 2 at {:?}",
        t.elapsed()
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    let pending: i64 = sqlx::query_scalar("SELECT count(*) FROM plugin_scheduled_calls")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(pending, 1, "the retry survives the host");

    let host = Host::new(s.pool.clone(), cfg).unwrap();
    host.register(&id).await.unwrap();
    until("delivery", Duration::from_secs(150), async || {
        hits.lock().unwrap().len() >= 6
    })
    .await;
    until("logged", Duration::from_secs(5), async || {
        let log = host
            .http(&id, req("GET", "/delivery-log", &[], b""))
            .await
            .unwrap();
        body(&log)["stats"]["delivered"] == 1
    })
    .await;
    let hits = hits.lock().unwrap().clone();
    assert_eq!(hits.len(), 6);
    let bodies: Vec<Value> = hits
        .iter()
        .map(|h| serde_json::from_str(&h.body).unwrap())
        .collect();
    let attempts: Vec<u64> = bodies
        .iter()
        .map(|b| b["attempt"].as_u64().unwrap())
        .collect();
    assert_eq!(attempts, [1, 2, 3, 4, 5, 6]);
    assert!(
        bodies
            .iter()
            .all(|b| b["id"] == bodies[0]["id"] && b["event"] == "media.imported")
    );
    assert!(
        hits.iter()
            .all(|h| h.sni.as_deref() == Some("hook.test") && h.path == "/hook")
    );
    let gaps: Vec<f64> = hits
        .windows(2)
        .map(|w| (w[1].at - w[0].at).as_secs_f64())
        .collect();
    println!("METRIC c1 gaps between attempts (s) {gaps:.2?} (ladder 1,5,15,30,60)");
    for (g, want) in gaps.iter().zip([1.0, 5.0, 15.0, 30.0, 60.0]) {
        assert!(*g >= want - 0.1 && *g < want + 2.5, "gap {g} vs {want}");
    }
    let log = host
        .http(&id, req("GET", "/delivery-log", &[], b""))
        .await
        .unwrap();
    let b = body(&log);
    assert_eq!(b["entries"][0]["lastStatus"], "delivered:204", "{b}");
    assert_eq!(b["entries"][0]["attempt"], 6);
    assert_eq!(
        *net.connects.lock().unwrap().first().unwrap(),
        "93.184.216.34:443".parse().unwrap()
    );

    // Restart (admin path): stop + register with a fresh breaker.
    let t = Instant::now();
    let rt = host.restart(&id).await.unwrap();
    println!("METRIC c1 restart to ready {:?}", t.elapsed());
    assert_eq!(rt.state(), State::Ready);
    assert!(rt.health().await.unwrap().ok);
    host.shutdown().await;
    s.finish(&[&id]).await;
}

// --- Criterion 1 (breaker) and 4 (limits) ---

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn c1_c4_crashes_limits_breaker() {
    let Some(s) = scratch("c4").await else { return };
    let mut cfg = s.cfg(Arc::new(SystemNet::new()));
    cfg.deadlines.http = Duration::from_secs(2);
    let host = Host::new(s.pool.clone(), cfg).unwrap();
    let id = host
        .install(&spike_archive("0.1.0", false), false)
        .await
        .unwrap();
    let rt = host.get(&id).unwrap();

    // Infinite loop: trapped by the epoch deadline.
    let t = Instant::now();
    let r = host.http(&id, req("GET", "/loop", &[], b"")).await;
    let took = t.elapsed();
    println!("METRIC c4 infinite loop ended after {took:?} with {r:?} (deadline 2 s)");
    assert!(matches!(r, Err(CallError::Crashed(_) | CallError::Timeout)));
    assert!(took <= Duration::from_millis(2250), "{took:?}");
    let t = Instant::now();
    assert!(rt.health().await.unwrap().ok);
    println!(
        "METRIC c4 health right after the http trap {:?}",
        t.elapsed()
    );
    assert_eq!(rt.restarts.load(std::sync::atomic::Ordering::SeqCst), 1);

    // The http lane re-creates after its ladder delay (1 s).
    let t = Instant::now();
    let mut refused = 0;
    loop {
        match host.http(&id, req("GET", "/echo", &[], b"hi")).await {
            Ok(r) => {
                assert_eq!(r.body, b"hi");
                break;
            }
            Err(CallError::Unavailable(_)) => refused += 1,
            Err(e) => panic!("{e:?}"),
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    println!(
        "METRIC c4 http lane back after {:?} ({refused} refusals while in backoff)",
        t.elapsed()
    );

    // memory.grow past memoryMb (64) traps that instance only.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let r = host
        .http(&id, req("GET", "/grow", &[("mb", "100")], b""))
        .await;
    println!("METRIC c4 grow 100 MiB -> {r:?}");
    assert!(
        matches!(&r, Err(CallError::Crashed(m)) if m.contains("memory limit")),
        "{r:?}"
    );
    assert!(rt.health().await.unwrap().ok);

    // A call timeout (guest suspended in a host call) drops the instance and counts (C105).
    tokio::time::sleep(Duration::from_secs(4)).await;
    let before = rt.restarts.load(std::sync::atomic::Ordering::SeqCst);
    let r = host
        .http(&id, req("GET", "/db/sleep", &[("s", "5")], b""))
        .await;
    assert!(matches!(r, Err(CallError::Timeout)), "{r:?}");
    assert_eq!(
        rt.restarts.load(std::sync::atomic::Ordering::SeqCst),
        before + 1
    );

    // stdout, stderr and log reach the ring; 64 KiB per minute holds.
    tokio::time::sleep(Duration::from_secs(8)).await;
    let r = host
        .http(&id, req("GET", "/spam", &[("kb", "4")], b""))
        .await
        .unwrap();
    assert_eq!(r.status, 200);
    let lines = host.env.logs.lines();
    let mine: Vec<_> = lines
        .iter()
        .filter(|l| l.context == "plugin:spike.guest")
        .collect();
    assert!(
        mine.iter()
            .any(|l| l.level == Level::Info && l.text.starts_with("xxx"))
    );
    assert!(
        mine.iter()
            .any(|l| l.level == Level::Error && l.text.starts_with("xxx"))
    );
    assert!(mine.iter().any(|l| l.text == "spam done"));
    let r = host
        .http(&id, req("GET", "/spam", &[("kb", "200")], b""))
        .await
        .unwrap();
    assert_eq!(r.status, 200);
    let lines = host.env.logs.lines();
    let bytes: usize = lines
        .iter()
        .filter(|l| l.context == "plugin:spike.guest")
        .map(|l| l.text.len())
        .sum();
    let warns = lines
        .iter()
        .filter(|l| l.text.contains("over 64 KiB"))
        .count();
    println!("METRIC c4 ring holds {bytes} bytes of plugin output this minute, {warns} cap warn");
    assert!(bytes <= 64 * 1024 + 100);
    assert_eq!(warns, 1);
    assert!(!host.env.logs.tail("spike.guest").is_empty());

    // 6 crashes in 10 min trip the breaker; restart clears it. 3 crashes so far.
    let t = Instant::now();
    while rt.state() != State::Failed {
        let _ = host.http(&id, req("GET", "/trap", &[], b"")).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(t.elapsed() < Duration::from_secs(120));
    }
    println!(
        "METRIC c4 breaker tripped after {} crashes, {:?}; message: {}",
        rt.restarts.load(std::sync::atomic::Ordering::SeqCst),
        t.elapsed(),
        rt.message()
    );
    assert_eq!(rt.restarts.load(std::sync::atomic::Ordering::SeqCst), 6);
    assert!(matches!(
        host.http(&id, req("GET", "/echo", &[], b"")).await,
        Err(CallError::Unavailable(_))
    ));
    let rt = host.restart(&id).await.unwrap();
    assert_eq!(rt.state(), State::Ready);
    assert_eq!(
        host.http(&id, req("GET", "/echo", &[], b"x"))
            .await
            .unwrap()
            .body,
        b"x"
    );
    host.shutdown().await;
    s.finish(&[&id]).await;
}

// --- Criterion 2: lanes ---

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn c2_pool_lanes() {
    let Some(s) = scratch("c2").await else { return };
    let window: u64 = std::env::var("SPIKE_POOL_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(600);
    let host = Host::new(s.pool.clone(), s.cfg(Arc::new(SystemNet::new()))).unwrap();
    let id = host
        .install(&spike_archive("0.1.0", false), false)
        .await
        .unwrap();
    let rt = host.get(&id).unwrap();
    let busy = (window + 20).to_string();
    let j1 = tokio::spawn({
        let (rt, a) = (rt.clone(), busy.clone());
        async move { rt.job("spin", Some(a)).await }
    });
    let mut j2 = tokio::spawn({
        let (rt, a) = (rt.clone(), busy.clone());
        async move { rt.job("pgsleep", Some(a)).await }
    });
    for key in ["spin:a", "pgsleep:b"] {
        fliks_server::plugins::scheduled::schedule(&s.pool, &id, key, 0, &busy)
            .await
            .unwrap();
    }
    host.env.wake.notify_one();
    until(
        "both task instances busy",
        Duration::from_secs(10),
        async || rt.task.free() == 0,
    )
    .await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        matches!(rt.job("spin", Some("1".into())).await, Err(CallError::Busy)),
        "no-overlap guard"
    );

    let t0 = Instant::now();
    let n = 500usize;
    let gap = Duration::from_secs(window) / n as u32;
    let (mut health, mut echo, mut events) = (Vec::new(), Vec::new(), Vec::new());
    let mut max = Duration::ZERO;
    for i in 0..n {
        let t = Instant::now();
        assert!(rt.health().await.unwrap().ok);
        health.push(t.elapsed());
        let t = Instant::now();
        let r = host
            .http(&id, req("POST", "/echo", &[], b"ping"))
            .await
            .unwrap();
        assert_eq!(r.body, b"ping");
        echo.push(t.elapsed());
        if i % 5 == 0 {
            let name = format!("ev-{i}");
            let t = Instant::now();
            host.publish(&name, "{}");
            events.push((name, t));
        }
        max = max.max(*health.last().unwrap()).max(*echo.last().unwrap());
        let next = t0 + gap * (i as u32 + 1);
        tokio::time::sleep_until(next.into()).await;
    }
    let lines = host.env.logs.lines();
    let mut ev: Vec<Duration> = events
        .iter()
        .map(|(name, t)| {
            let want = format!("event {name}");
            lines
                .iter()
                .find(|l| l.text == want)
                .map(|l| l.at - *t)
                .unwrap_or(Duration::MAX)
        })
        .collect();
    let jobs_busy = !j1.is_finished() && !j2.is_finished() && rt.task.free() == 0;
    if j2.is_finished() {
        println!("METRIC c2 pgsleep job ended early: {:?}", (&mut j2).await);
    }
    println!(
        "METRIC c2 spin job done {}, pgsleep job done {}, free task slots {}",
        j1.is_finished(),
        j2.is_finished(),
        rt.task.free()
    );
    let (hp99, ep95, evmax) = (
        pct(&mut health, 99.0),
        pct(&mut echo, 95.0),
        pct(&mut ev, 100.0),
    );
    println!(
        "METRIC c2 window {:?}: health p50 {:?} p99 {hp99:?}; echo p50 {:?} p95 {ep95:?}; \
         event delivery p50 {:?} max {evmax:?}; worst health/echo {max:?}; jobs+tasks still busy {jobs_busy}",
        t0.elapsed(),
        pct(&mut health, 50.0),
        pct(&mut echo, 50.0),
        pct(&mut ev, 50.0)
    );
    assert!(jobs_busy);
    assert!(hp99 <= Duration::from_millis(100));
    assert!(ep95 <= Duration::from_millis(50));
    assert!(evmax <= Duration::from_millis(100));
    assert!(max <= Duration::from_secs(3));

    // 4 busy http instances + a queue of 32: the 37th answers 503 at once.
    let mut calls = Vec::new();
    for _ in 0..36 {
        let h = host.clone();
        calls.push(tokio::spawn(async move {
            h.http("spike.guest", req("GET", "/db/sleep", &[("s", "1")], b""))
                .await
        }));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let t = Instant::now();
    let r = host.http(&id, req("GET", "/echo", &[], b"")).await;
    let refused_in = t.elapsed();
    let lane_live = rt.http.live.load(std::sync::atomic::Ordering::SeqCst);
    let mut ok = 0;
    for c in calls {
        if c.await.unwrap().is_ok() {
            ok += 1;
        }
    }
    println!(
        "METRIC c2 37th request: {r:?} in {refused_in:?}; http instances {lane_live}; {ok}/36 completed"
    );
    assert!(matches!(r, Err(CallError::Unavailable(ref m)) if m == "queue full"));
    assert!(refused_in < Duration::from_millis(10));
    assert_eq!(lane_live, 4);
    assert_eq!(ok, 36);

    // A trapped http instance does not delay the core lane; the lane re-creates after its delay.
    let trap = tokio::spawn({
        let h = host.clone();
        async move { h.http("spike.guest", req("GET", "/trap", &[], b"")).await }
    });
    let t = Instant::now();
    assert!(rt.health().await.unwrap().ok);
    println!("METRIC c2 health during an http trap {:?}", t.elapsed());
    assert!(matches!(trap.await.unwrap(), Err(CallError::Crashed(_))));
    let t = Instant::now();
    while host.http(&id, req("GET", "/echo", &[], b"")).await.is_err() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    println!("METRIC c2 http lane re-created after {:?}", t.elapsed());

    host.shutdown().await;
    let _ = (j1.await, j2.await);
    s.finish(&[&id]).await;
}

// --- Criterion 3: cost ---

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn c3_cost() {
    let Some(s) = scratch("c3").await else { return };
    let cfg = s.cfg(Arc::new(SystemNet::new()));
    let rss0 = rss_kib("VmRSS:");
    let host = Host::new(s.pool.clone(), cfg.clone()).unwrap();
    let id = host.install(&notify_archive(), false).await.unwrap();
    let rt = host.get(&id).unwrap();
    let t = rt.timings.lock().unwrap().clone();
    println!(
        "METRIC c3 notify ({} KiB): compile {:?} (cache hit {}), first hello {:?}, start {:?}; compile+hello {:?}",
        wasm("fk_plugin_notify.wasm").len() >> 10,
        t.compile,
        t.cache_hit,
        t.first_hello,
        t.start,
        t.compile + t.first_hello
    );
    assert!(t.compile + t.first_hello < Duration::from_secs(3));

    let mut extra = Vec::new();
    let mut times = Vec::new();
    let rss1 = rss_kib("VmRSS:");
    for _ in 0..10 {
        let t = Instant::now();
        extra.push(rt.instantiate().await.unwrap());
        times.push(t.elapsed());
    }
    let rss2 = rss_kib("VmRSS:");
    let linear = rt.sh.mem_total.load(std::sync::atomic::Ordering::SeqCst)
        / (rt.live_instances() + extra.len());
    println!(
        "METRIC c3 notify extra instance: p50 {:?} max {:?}; RSS delta per idle instance {} KiB; linear memory {} KiB",
        pct(&mut times, 50.0),
        pct(&mut times, 100.0),
        (rss2.saturating_sub(rss1)) / 10,
        linear >> 10
    );
    assert!(pct(&mut times, 100.0) < Duration::from_millis(100));
    assert!((rss2.saturating_sub(rss1)) / 10 < 40 * 1024);
    drop(extra);

    // The 20 MiB stand-in.
    let big = std::fs::read(std::env::var("SPIKE_BIG_WASM").expect("SPIKE_BIG_WASM")).unwrap();
    let (rss_b, hwm_b) = (rss_kib("VmRSS:"), rss_kib("VmHWM:"));
    let id_big = host
        .install(&archive::pack(&template("big-guest"), "0.1.0", &big), false)
        .await
        .unwrap();
    let rb = host.get(&id_big).unwrap();
    let t = rb.timings.lock().unwrap().clone();
    let cwasm = std::fs::read_dir(s.dir.join("cwasm"))
        .unwrap()
        .filter_map(|e| e.ok()?.metadata().ok().map(|m| m.len()))
        .max()
        .unwrap();
    println!(
        "METRIC c3 big ({:.1} MiB, cwasm {:.1} MiB): compile {:?}, first hello {:?}; compile+hello {:?}",
        big.len() as f64 / 1048576.0,
        cwasm as f64 / 1048576.0,
        t.compile,
        t.first_hello,
        t.compile + t.first_hello
    );
    println!(
        "METRIC c3 big compile memory: RSS {} -> {} MiB, VmHWM {} -> {} MiB",
        rss_b >> 10,
        rss_kib("VmRSS:") >> 10,
        hwm_b >> 10,
        rss_kib("VmHWM:") >> 10
    );
    assert!(big.len() >= 20 << 20);
    assert!(t.compile + t.first_hello < Duration::from_secs(20));
    let r = host
        .http(&id_big, req("POST", "/", &[], b"abc"))
        .await
        .unwrap();
    assert_eq!(r.status, 200);

    // 4 plugins x 3 instances.
    let tiny = archive::pack(&template("tiny-guest"), "0.1.0", &wasm("tiny_guest.wasm"));
    let id_tiny = host.install(&tiny, false).await.unwrap();
    let id_spike = host
        .install(&spike_archive("0.1.0", false), false)
        .await
        .unwrap();
    let mut keep = Vec::new();
    for p in [&id, &id_big, &id_tiny, &id_spike] {
        let rt = host.get(p).unwrap();
        for _ in 0..2 {
            keep.push(rt.instantiate().await.unwrap());
        }
    }
    println!(
        "METRIC c3 4 plugins x 3 instances: RSS {} MiB (start {} MiB), peak VmHWM {} MiB",
        rss_kib("VmRSS:") >> 10,
        rss0 >> 10,
        rss_kib("VmHWM:") >> 10
    );
    drop(keep);
    host.shutdown().await;
    drop(host);

    // Reload from the authenticated cache after a host restart.
    let host = Host::new(s.pool.clone(), cfg).unwrap();
    for p in [&id, &id_big] {
        let rt = host.register(p).await.unwrap();
        let t = rt.timings.lock().unwrap().clone();
        println!(
            "METRIC c3 {p} reload: cache hit {} in {:?}",
            t.cache_hit, t.compile
        );
        assert!(t.cache_hit && t.compile < Duration::from_secs(1));
    }
    // A cache file whose sha256 differs from the row is recompiled, never deserialised.
    for e in std::fs::read_dir(s.dir.join("cwasm")).unwrap() {
        let p = e.unwrap().path();
        let mut b = std::fs::read(&p).unwrap();
        let last = b.len() - 1;
        b[last] ^= 1;
        std::fs::write(&p, b).unwrap();
    }
    let rt = host.register(&id).await.unwrap();
    assert!(!rt.timings.lock().unwrap().cache_hit);
    host.shutdown().await;
    s.finish(&[&id, &id_big, &id_tiny, &id_spike]).await;
}

// --- Criterion 5: db ---

fn q(sql: &str, params: Value) -> Vec<u8> {
    json!({ "sql": sql, "params": params })
        .to_string()
        .into_bytes()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn c5_db() {
    let Some(s) = scratch("c5").await else { return };
    let mut cfg = s.cfg(Arc::new(SystemNet::new()));
    cfg.deadlines.db_query = Duration::from_secs(2);
    let host = Host::new(s.pool.clone(), cfg).unwrap();
    let id = host
        .install(&spike_archive("0.1.0", false), false)
        .await
        .unwrap();
    let call = async |path: &str, query: &[(&str, &str)], b: &[u8]| {
        body(&host.http(&id, req("GET", path, query, b)).await.unwrap())
    };

    // A schema adopted from a Node install: ledger present, nothing re-runs.
    let names: Vec<String> = (1..=8)
        .map(|i| {
            [
                "0001_initial_schema",
                "0002_indexer_caps_probed_at",
                "0003_download_history_size",
                "0004_download_history_info_url",
                "0005_indexer_sources",
                "0006_indexer_interactive_search",
                "0007_indexer_caps_supported_params",
                "0008_download_history_coverage",
            ][i - 1]
                .to_owned()
        })
        .collect();
    call("/db/query", &[], &q(r#"CREATE TABLE "_migrations" ("name" varchar PRIMARY KEY, "appliedAt" timestamptz NOT NULL DEFAULT now())"#, json!([]))).await;
    call(
        "/db/query",
        &[],
        &q(
            r#"INSERT INTO "_migrations" ("name") SELECT unnest($1::text[])"#,
            json!([{"t":"text-list","v":names}]),
        ),
    )
    .await;
    let r = call("/db/migrate", &[], b"").await;
    assert_eq!(r["applied"], json!([]), "{r}");
    let r = call(
        "/db/query",
        &[],
        &q(
            "SELECT to_regclass('indexers') IS NULL AS absent",
            json!([]),
        ),
    )
    .await;
    assert_eq!(
        r["rows"][0][0], true,
        "adopted ledger must not create tables"
    );

    // Empty schema: two instances migrate at once, each migration applies once.
    call(
        "/db/query",
        &[],
        &q(r#"DROP TABLE "_migrations""#, json!([])),
    )
    .await;
    let (a, b) = tokio::join!(call("/db/migrate", &[], b""), call("/db/migrate", &[], b""));
    let mut all: Vec<String> = [a["applied"].clone(), b["applied"].clone()]
        .iter()
        .flat_map(|v| v.as_array().cloned().unwrap_or_default())
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    all.sort();
    println!(
        "METRIC c5 concurrent migrate: {} + {} applied",
        a["applied"], b["applied"]
    );
    assert_eq!(all, names);
    let r = call(
        "/db/query",
        &[],
        &q(r#"SELECT count(*) FROM "_migrations""#, json!([])),
    )
    .await;
    assert_eq!(r["rows"][0][0], 8);

    // db-driver vectors: param variants against inferred types, every decoded type.
    let cases: Vec<(&str, Value, Value)> = vec![
        (
            "SELECT $1::int4 AS v",
            json!([{"t":"int","v":42}]),
            json!(42),
        ),
        (
            "SELECT $1::int8 AS v",
            json!([{"t":"int","v":9007199254740991i64}]),
            json!(9007199254740991i64),
        ),
        (
            "SELECT $1::int2 AS v",
            json!([{"t":"int","v":-7}]),
            json!(-7),
        ),
        (
            "SELECT $1::text AS v",
            json!([{"t":"text","v":"héllo"}]),
            json!("héllo"),
        ),
        (
            "SELECT $1::numeric AS v",
            json!([{"t":"text","v":"12.3400"}]),
            json!("12.3400"),
        ),
        (
            "SELECT $1::numeric AS v",
            json!([{"t":"int","v":-5}]),
            json!("-5"),
        ),
        (
            "SELECT $1::numeric AS v",
            json!([{"t":"float","v":0.5}]),
            json!("0.5"),
        ),
        ("SELECT 0.0001::numeric AS v", json!([]), json!("0.0001")),
        (
            "SELECT 123456789.000012::numeric AS v",
            json!([]),
            json!("123456789.000012"),
        ),
        ("SELECT 'NaN'::numeric AS v", json!([]), json!("NaN")),
        (
            "SELECT $1::timestamptz AS v",
            json!([{"t":"text","v":"2026-10-16T12:34:56.789+02:00"}]),
            json!("2026-10-16T10:34:56.789Z"),
        ),
        (
            "SELECT $1::timestamp AS v",
            json!([{"t":"text","v":"2026-10-16 12:34:56.7"}]),
            json!("2026-10-16T12:34:56.700Z"),
        ),
        (
            "SELECT $1::date AS v",
            json!([{"t":"text","v":"1999-12-31"}]),
            json!("1999-12-31"),
        ),
        (
            "SELECT $1::jsonb AS v",
            json!([{"t":"json","v":{"a":[1,true]}}]),
            json!({"json":"{\"a\": [1, true]}"}),
        ),
        (
            "SELECT $1::json AS v",
            json!([{"t":"json","v":{"a":1}}]),
            json!({"json":"{\"a\":1}"}),
        ),
        (
            "SELECT $1::text[] AS v",
            json!([{"t":"text-list","v":["a","b\"c"]}]),
            Value::Null,
        ),
        (
            "SELECT array_length($1::text[], 1) AS v",
            json!([{"t":"text-list","v":["a","b\"c","d\\e"]}]),
            json!(3),
        ),
        (
            "SELECT ($1::text[])[2] AS v",
            json!([{"t":"text-list","v":["a","b\"c"]}]),
            json!("b\"c"),
        ),
        (
            "SELECT ($1::int8[])[3] AS v",
            json!([{"t":"int-list","v":[1,2,3]}]),
            json!(3),
        ),
        (
            "SELECT 3 = ANY($1::int4[]) AS v",
            json!([{"t":"int-list","v":[1,2,3]}]),
            json!(true),
        ),
        (
            "SELECT $1::bool AS v",
            json!([{"t":"bool","v":true}]),
            json!(true),
        ),
        (
            "SELECT $1::bool AS v",
            json!([{"t":"bool","v":false}]),
            json!(false),
        ),
        (
            "SELECT $1::bytea AS v",
            json!([{"t":"bytes","v":[0,255,16]}]),
            json!([0, 255, 16]),
        ),
        (
            "SELECT length($1::bytea) AS v",
            json!([{"t":"bytes","v":[1,2,3,4]}]),
            json!(4),
        ),
        (
            "SELECT $1::float8 AS v",
            json!([{"t":"float","v":1.5}]),
            json!(1.5),
        ),
        (
            "SELECT $1::float4 AS v",
            json!([{"t":"float","v":0.25}]),
            json!(0.25),
        ),
        (
            "SELECT $1::int4 IS NULL AS v",
            json!([{"t":"null"}]),
            json!(true),
        ),
        ("SELECT NULL::text AS v", json!([]), Value::Null),
        (
            "SELECT $1 AS v",
            json!([{"t":"text","v":"inferred text"}]),
            json!("inferred text"),
        ),
        (
            "SELECT $1::varchar AS v",
            json!([{"t":"text","v":"vc"}]),
            json!("vc"),
        ),
        (
            "SELECT $1::char(3) AS v",
            json!([{"t":"text","v":"ab"}]),
            json!("ab "),
        ),
        ("SELECT 'n'::name AS v", json!([]), json!("n")),
        (
            "SELECT '6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid AS v",
            json!([]),
            json!("6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
        ),
        (
            "SELECT $1::int4 + 1 AS v",
            json!([{"t":"text","v":"41"}]),
            json!(42),
        ),
        (
            "SELECT $1::int8 AS v",
            json!([{"t":"text","v":"-9000000000"}]),
            json!(-9000000000i64),
        ),
        (
            "SELECT $1::jsonb ->> 'k' AS v",
            json!([{"t":"json","v":{"k":"v"}}]),
            json!("v"),
        ),
        (
            "SELECT 'infinity'::timestamptz AS v",
            json!([]),
            json!("infinity"),
        ),
        (
            "SELECT '2000-01-01'::date - 1 AS v",
            json!([]),
            json!("1999-12-31"),
        ),
        ("SELECT now() - now() AS v", json!([]), json!("error")),
        (
            "SELECT $1::int4 AS v",
            json!([{"t":"text","v":"x"}]),
            json!("error"),
        ),
    ];
    assert_eq!(cases.len(), 40);
    let mut failed = Vec::new();
    for (sql, params, want) in &cases {
        let r = call("/db/query", &[], &q(sql, params.clone())).await;
        let got = if r.get("error").is_some() {
            json!("error")
        } else {
            r["rows"][0][0].clone()
        };
        let ok = if sql.contains("$1::text[] AS v") {
            r.get("error").is_some()
        } else {
            got == *want
        };
        if !ok {
            failed.push(format!("{sql}: got {got} want {want} ({r})"));
        }
    }
    println!("METRIC c5 db-driver vectors {}/40 pass", 40 - failed.len());
    assert!(failed.is_empty(), "{failed:#?}");

    // A query past its deadline is cancelled server-side.
    let t = Instant::now();
    let r = call("/db/sleep", &[("s", "30")], b"").await;
    let took = t.elapsed();
    // The server's statement_timeout and the host's cancel request share the deadline.
    assert!(r["error"] == "57014" || r["error"] == "ERR_TIMEOUT", "{r}");
    let mut active = -1i64;
    for _ in 0..20 {
        active = sqlx::query_scalar(
            "SELECT count(*) FROM pg_stat_activity WHERE usename = 'plugin_spike_guest' AND state = 'active' AND query LIKE '%pg_sleep%'",
        )
        .fetch_one(&s.admin)
        .await
        .unwrap();
        if active == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    println!(
        "METRIC c5 query cancel at deadline 2 s: answered after {took:?}, active pg_sleep after: {active}"
    );
    assert_eq!(active, 0);
    assert!(took < Duration::from_secs(3));

    // Session state dies with its call (DISCARD ALL on return).
    call("/db/set-timeout", &[], b"").await;
    let r = call("/db/show-timeout", &[], b"").await;
    println!(
        "METRIC c5 statement_timeout after a guest SET: {}",
        r["statement_timeout"]
    );
    assert_eq!(r["statement_timeout"], "2s");
    host.shutdown().await;
    s.finish(&[&id]).await;
}

// --- Criterion 6: outbound guard ---

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn c6_outbound() {
    let Some(s) = scratch("c6").await else { return };
    let pki = pki(&["pub.test", "rebind.test", "priv.test"]);
    let reply: Reply = Arc::new(|_, path| {
        if path == "/redirect" {
            (
                302,
                vec![("location".into(), "https://pub.test/next".into())],
            )
        } else {
            (200, vec![])
        }
    });
    let hits = stub(PORT_TLS, pki.server.clone(), reply).await;
    let answers: &[(&str, &[&[&str]])] = &[
        ("pub.test", &[&["93.184.216.34"]]),
        ("other.test", &[&["93.184.216.34"]]),
        ("rebind.test", &[&["93.184.216.35"], &["10.0.0.9"]]),
        ("mixed.test", &[&["93.184.216.36", "10.0.0.5"]]),
        ("priv.test", &[&["10.0.0.7"]]),
        ("meta.test", &[&["169.254.169.254"]]),
    ];
    let run = async |internal: bool, cases: &[(&'static str, &'static str)]| {
        let net = StubNet::new(PORT_TLS, pki.roots.clone(), answers);
        let host = Host::new(s.pool.clone(), s.cfg(net.clone())).unwrap();
        let id = host
            .install(&spike_archive("0.1.0", internal), internal)
            .await
            .unwrap();
        let mut out = HashMap::new();
        for (name, url) in cases {
            let r = host
                .http(&id, req("GET", "/fetch", &[("url", url)], b""))
                .await
                .unwrap();
            out.insert(*name, body(&r));
        }
        host.shutdown().await;
        (out, net)
    };
    let (o, net) = run(
        false,
        &[
            ("public", "https://pub.test/a"),
            ("cert-mismatch", "https://other.test/a"),
            ("rebind", "https://rebind.test/a"),
            ("mixed", "https://mixed.test/a"),
            ("private", "https://priv.test/a"),
            ("literal-private", "https://127.0.0.1:4901/a"),
            ("link-local", "https://meta.test/a"),
            ("redirect", "https://pub.test/redirect"),
        ],
    )
    .await;
    for (k, v) in &o {
        println!("METRIC c6 no grant {k}: {v}");
    }
    assert_eq!(o["public"]["status"], 200);
    assert!(
        o["cert-mismatch"]["error"]
            .as_str()
            .unwrap()
            .contains("Tls")
    );
    assert_eq!(o["rebind"]["status"], 200);
    assert_eq!(o["mixed"]["error"], "Denied");
    assert_eq!(o["private"]["error"], "Denied");
    assert_eq!(o["literal-private"]["error"], "Denied");
    assert_eq!(o["link-local"]["error"], "Denied");
    assert_eq!(o["redirect"]["status"], 302);
    assert_eq!(o["redirect"]["location"], "https://pub.test/next");
    let lookups = net.lookups.lock().unwrap().clone();
    assert_eq!(
        lookups.iter().filter(|l| *l == "rebind.test").count(),
        1,
        "one lookup"
    );
    let connects = net.connects.lock().unwrap().clone();
    assert!(
        connects.contains(&"93.184.216.35:443".parse().unwrap()),
        "rebind connects to the vetted address"
    );
    assert!(
        !connects
            .iter()
            .any(|a| a.ip().to_string().starts_with("10."))
    );
    let snis: Vec<_> = hits.lock().unwrap().iter().map(|h| h.sni.clone()).collect();
    assert!(snis.contains(&Some("pub.test".into())));
    assert_eq!(
        hits.lock()
            .unwrap()
            .iter()
            .filter(|h| h.path == "/next")
            .count(),
        0,
        "302 not followed"
    );

    let (o, _) = run(
        true,
        &[
            ("private", "https://priv.test/a"),
            ("link-local", "https://meta.test/a"),
        ],
    )
    .await;
    for (k, v) in &o {
        println!("METRIC c6 with network.internal {k}: {v}");
    }
    assert_eq!(o["private"]["status"], 200);
    assert_eq!(o["link-local"]["error"], "Denied");
    s.finish(&["spike.guest"]).await;
}

// --- Criterion 7: manifest-check and wasi:sockets ---

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn c7_manifest_and_sockets() {
    let Some(s) = scratch("c7").await else { return };
    let host = Host::new(s.pool.clone(), s.cfg(Arc::new(SystemNet::new()))).unwrap();
    let r = host.install(&spike_archive("0.2.0", false), false).await;
    println!("METRIC c7 embedded version 0.1.0 vs manifest 0.2.0: {r:?}");
    assert_eq!(r, Err("manifest-mismatch: version".into()));
    let (status, reason): (String, Option<String>) =
        sqlx::query_as(r#"SELECT status::text, "statusReason" FROM plugin_packages WHERE "pluginId" = 'spike.guest'"#)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(
        (status.as_str(), reason.as_deref()),
        ("failed", Some("manifest-mismatch: version"))
    );
    assert!(host.get("spike.guest").is_none(), "no retry");

    let id = host
        .install(&spike_archive("0.1.0", false), false)
        .await
        .unwrap();
    let r = body(&host.http(&id, req("GET", "/sock", &[], b"")).await.unwrap());
    println!("METRIC c7 wasi:sockets connect: {r}");
    assert_eq!(r["connected"], false);
    host.shutdown().await;
    s.finish(&[&id]).await;
}

#![cfg(not(target_arch = "wasm32"))]
//! The SDK harness and build tooling on this fixture, under the real host. Needs the release
//! component (`cargo xtask build examples/fixture-guest`) and `FLIKS_HARNESS_PG_URL`.

use fliks_plugin_sdk::build::{self, Crate};
use fliks_plugin_sdk::harness::fliks_server::plugins::HttpResponse;
use fliks_plugin_sdk::harness::fliks_server::plugins::runtime::{HostConfig, State};
use fliks_plugin_sdk::harness::{Harness, Setup, request, until};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::Duration;

const DIR: &str = env!("CARGO_MANIFEST_DIR");
const DEV_KEY: &str = "0707070707070707070707070707070707070707070707070707070707070707";

fn body(r: &HttpResponse) -> Value {
    serde_json::from_slice(&r.body).unwrap_or(Value::Null)
}

fn setup(tune: impl Fn(&mut HostConfig) + Send + Sync + 'static) -> Setup {
    let mut s = Setup::from_crate(DIR);
    s.tune = Some(Arc::new(tune));
    s
}

/// Answers `ok` to every request on `port`.
fn stub(port: u16) {
    let l = TcpListener::bind(("127.0.0.1", port)).unwrap();
    std::thread::spawn(move || {
        for mut c in l.incoming().flatten() {
            let mut buf = [0u8; 4096];
            let _ = c.read(&mut buf);
            let _ =
                c.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
        }
    });
}

async fn fetch(h: &Harness, url: &str) -> Value {
    body(
        &h.http(request("GET", "/test/fetch", &[("url", url)], b""))
            .await
            .unwrap(),
    )
}

fn logged(h: &Harness, text: &str) -> bool {
    h.logs().iter().any(|l| l.contains(text))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exports_and_scheduled_calls() {
    let Some(h) = Harness::start(setup(|c| c.ladder = vec![Duration::from_millis(20)])).await
    else {
        return;
    };
    assert!(h.health().await.unwrap().ok);
    h.job("FixtureJob", Some("0")).await.unwrap();
    h.scheduled("direct", "\"d\"", 3).await.unwrap();
    assert!(logged(&h, "scheduled direct attempt 3 payload \"d\""));
    h.event("ping", &json!({ "n": 1 }));
    h.set_config("token", Some("x")).await;
    until("the event", Duration::from_secs(10), async || {
        logged(&h, "event ping")
    })
    .await;
    h.health().await.unwrap();
    until("config-changed", Duration::from_secs(10), async || {
        logged(&h, "config changed: token")
    })
    .await;

    let schedule = async |key: &str, delay: &str, payload: &[u8]| {
        let r = request(
            "POST",
            "/test/schedule",
            &[("key", key), ("delay", delay)],
            payload,
        );
        body(&h.http(r).await.unwrap())
    };
    schedule("later", "60000", b"\"one\"").await;
    schedule("later", "60000", b"\"two\"").await;
    let calls = h.scheduled_calls().await;
    assert_eq!(
        calls.len(),
        1,
        "rule 55: the same key replaces the pending call"
    );
    assert_eq!(
        (calls[0].payload.as_str(), calls[0].attempt),
        ("\"two\"", 0)
    );
    assert!(calls[0].due_in_ms > 50_000);
    h.advance(Duration::from_secs(60)).await;
    until("the replacing call", Duration::from_secs(10), async || {
        h.scheduled_calls().await.is_empty()
    })
    .await;
    assert!(logged(&h, "scheduled later attempt 1 payload \"two\""));
    assert!(!logged(&h, "payload \"one\""));

    schedule("trap:x", "0", b"\"t\"").await;
    until("the trapping call", Duration::from_secs(10), async || {
        logged(&h, "scheduled trap:x attempt 1")
            && h.scheduled_calls()
                .await
                .first()
                .is_some_and(|c| c.attempt == 1)
    })
    .await;
    let lease = h.scheduled_calls().await[0].due_in_ms;
    assert!(
        lease > 300_000,
        "a trap leaves the row to its lease ({lease} ms)"
    );
    h.advance(Duration::from_secs(361)).await;
    until("the redelivery", Duration::from_secs(10), async || {
        h.scheduled_calls().await.is_empty()
    })
    .await;
    assert!(
        logged(&h, "scheduled trap:x attempt 2"),
        "at-least-once after a trap"
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn outbound_targets_guard_and_breaker() {
    stub(4936);
    let s = setup(|c| c.ladder = vec![Duration::from_millis(20)]);
    s.targets.answer("pub.test", &["93.184.216.34"]);
    s.targets.answer("priv.test", &["10.0.0.7"]);
    s.targets
        .route("93.184.216.34:80", "127.0.0.1:4936".parse().unwrap());
    let Some(h) = Harness::start(s).await else {
        return;
    };
    let r = fetch(&h, "http://pub.test/a").await;
    assert_eq!(
        (r["status"].as_u64(), r["body"].as_str()),
        (Some(200), Some("ok")),
        "{r}"
    );
    assert_eq!(fetch(&h, "http://priv.test/a").await["error"], "Denied");
    assert_eq!(fetch(&h, "http://10.0.0.7/a").await["error"], "Denied");
    assert!(
        fetch(&h, "http://missing.test/a").await["error"]
            .as_str()
            .is_some_and(|e| e.starts_with("Dns(")),
    );
    assert_eq!(
        h.targets.connects.lock().unwrap().as_slice(),
        ["93.184.216.34:80".parse().unwrap()],
        "refused targets are never dialled"
    );

    until("the breaker", Duration::from_secs(10), async || {
        let _ = h.http(request("GET", "/test/trap", &[], b"")).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        h.state() == Some(State::Failed)
    })
    .await;
    h.restart().await;
    assert_eq!(
        h.state(),
        Some(State::Ready),
        "a restart clears the breaker"
    );
    h.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn network_internal_reaches_private_targets() {
    stub(4937);
    let mut s = setup(|_| {});
    s.network_internal = true;
    s.targets.answer("qbit.lan", &["192.168.1.5"]);
    s.targets
        .route("192.168.1.5:8080", "127.0.0.1:4937".parse().unwrap());
    let Some(h) = Harness::start(s).await else {
        return;
    };
    assert_eq!(fetch(&h, "http://qbit.lan:8080/").await["status"], 200);
    assert_eq!(
        fetch(&h, "http://169.254.169.254/").await["error"],
        "Denied"
    );
    h.finish().await;
}

#[test]
fn package_is_deterministic_and_verifies() {
    let c = Crate::at(DIR.as_ref()).unwrap();
    if !c.wasm_path().exists() {
        panic!("{} missing: run cargo xtask build", c.wasm_path().display());
    }
    let key = build::dev_key(DEV_KEY).unwrap();
    let (name, a) = c.package(Some(&key)).unwrap();
    assert_eq!(name, "fliks.fixture-0.1.0.fkplugin");
    assert_eq!(a, c.package(Some(&key)).unwrap().1, "deterministic");
    let dev = vec![("dev".to_owned(), key.verifying_key().to_bytes())];
    let i = build::verify(&a, dev, build::MAX_WASM).unwrap();
    assert_eq!(
        (i.id.as_str(), i.version.as_str()),
        ("fliks.fixture", "0.1.0")
    );
    assert_eq!(i.signed_by.as_deref(), Some("dev"));
    assert_eq!(
        i.archive.order,
        ["plugin.json", "plugin.json.sig", "plugin.wasm", "logo.svg"]
    );
    let (_, unsigned) = c.package(None).unwrap();
    assert!(build::verify(&unsigned, vec![], build::MAX_WASM).is_ok());
    assert!(
        build::verify(&unsigned, vec![], 1024)
            .unwrap_err()
            .contains("over the 1024 byte budget")
    );
    let mut wasm = std::fs::read(c.wasm_path()).unwrap();
    wasm.truncate(8);
    assert!(build::check_world(&wasm).is_err());
}

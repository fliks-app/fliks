//! Acquisition providers (`plugins.md` section K) through the fixture plugin.
use super::harness::*;
use fliks_server::events::{Bus, DomainEvent, SseEvent};
use fliks_server::plugins::runtime::fliks::plugin::types::{DownloadProgress, DownloadState};
use serde_json::{Value, json};
use std::time::Duration;

async fn call(h: &H, route: &str, q: &[(&str, &str)]) -> Value {
    let rt = h.st.plugins.rt("fliks.fixture").unwrap();
    let r = rt
        .http(
            fliks_server::plugins::HttpRequest {
                method: "GET".into(),
                path: format!("/test/{route}"),
                query: q.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
                body: vec![],
                principal: fliks_server::plugins::Principal::Delegated(1),
            },
            false,
        )
        .await
        .unwrap();
    serde_json::from_slice(&r.body).unwrap()
}

fn logs(text: &str) -> usize {
    fliks_server::system::logs::query("", text, None).len()
}

async fn entry(h: &H) -> Value {
    let (_, ui) = h.call("GET", "/api/plugins/ui", Some(&h.admin), None).await;
    ui.as_array()
        .unwrap()
        .iter()
        .find(|e| e["pluginId"] == "fliks.fixture")
        .unwrap()
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_provider_publishes_sources_and_receives_arbitrated_requests() {
    let Some((mut m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("pickers").await else {
        return;
    };
    let h = harness(&s, "pickers", |_| {}).await;
    allow_unsigned(&h).await;
    m["routes"].as_array_mut().unwrap().extend([
        json!({"method": "GET", "path": "/search", "policy": "read:Settings"}),
        json!({"method": "POST", "path": "/grab", "policy": "read:Settings"}),
    ]);
    let pair = json!({"search": "/search", "grab": "/grab"});
    m["ui"]["releasePicker"] = json!({"movie": {"work": pair}});
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let mut rx = h.st.hub.subscribe();

    let e = entry(&h).await;
    assert_eq!(e["acquisition"]["order"], 0);
    assert_eq!(e["acquisition"]["sources"], json!([]));
    assert_eq!(e["acquisition"]["routes"], e["releasePicker"]);

    assert_eq!(
        call(&h, "sources", &[("ids", "a,b"), ("kinds", "movie")]).await["ok"],
        Value::Null
    );
    let e = entry(&h).await;
    assert_eq!(
        e["acquisition"]["sources"],
        json!([
            {"id": "a", "name": "a", "kinds": ["movie"]},
            {"id": "b", "name": "b", "kinds": ["movie"]}
        ])
    );
    assert_eq!(
        call(&h, "sources", &[("ids", "a,a")]).await["error"],
        "ERR_VALIDATION",
        "a duplicate id"
    );
    call(&h, "sources", &[("ids", "a,b"), ("kinds", "movie")]).await;

    let (movie, album) = (710_005, 710_006);
    for (id, kind) in [(movie, "movie"), (album, "album")] {
        sqlx::query("INSERT INTO media (id, title, type) VALUES ($1, 'm', $2)")
            .bind(id)
            .bind(kind)
            .execute(&h.st.db)
            .await
            .unwrap();
    }
    h.st.hub
        .emit_domain(DomainEvent::MediaAcquisitionRequested {
            media_ids: vec![movie.into(), album.into()],
            reason: "t".into(),
        });
    until(
        "the arbitrated request",
        Duration::from_secs(10),
        async || logs("\"provider\":\"fliks.fixture\"") == 1 && logs("\"mediaIds\":[710006]") >= 1,
    )
    .await;

    // `no-release` is the arbitration signal (no toast, no queue refresh); any other reason is a failure.
    call(&h, "failed", &[("media", "710005")]).await;
    call(&h, "failed", &[("media", "710005"), ("reason", "boom")]).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (mut sources, mut failed, mut queue) = (0, vec![], 0);
    while let Ok(bus) = rx.try_recv() {
        match &*bus {
            Bus::Raw(r) if r.r#type == "acquisition.sources" => sources += 1,
            Bus::Sse(SseEvent::ImportFailed { error, .. }) => failed.push(error.clone()),
            Bus::Sse(SseEvent::QueueUpdated {}) => queue += 1,
            _ => {}
        }
    }
    assert_eq!(sources, 1, "an unchanged list is not announced again");
    assert_eq!((failed, queue), (vec!["boom".to_owned()], 1));

    // `acquisition.inFlight` (rule 67): another plugin's set shows, the caller's own never does.
    let held = |ref_: &str| DownloadProgress {
        ref_: ref_.into(),
        unit: None,
        progress: 0.1,
        bytes_per_second: None,
        eta_seconds: None,
        state: DownloadState::Active,
    };
    let gates = fliks_server::plugins::events::progress_gates();
    gates
        .set(&h.st, "other", movie, &[held("o")])
        .await
        .unwrap();
    gates
        .set(&h.st, "fliks.fixture", album, &[held("f")])
        .await
        .unwrap();
    let m = movie.to_string();
    assert_eq!(
        call(&h, "inflight", &[("media", &m)]).await["ok"],
        json!(["other"])
    );
    assert_eq!(
        call(
            &h,
            "inflight",
            &[("media", &m), ("group", "1"), ("number", "2")]
        )
        .await["ok"],
        json!(["other"])
    );
    assert_eq!(
        call(&h, "inflight", &[("media", &album.to_string())]).await["ok"],
        json!([])
    );

    assert_eq!(h.st.plugins.pickers.sources_of("fliks.fixture").len(), 2);
    h.call(
        "POST",
        "/api/plugins/fliks.fixture/disable",
        Some(&h.admin),
        None,
    )
    .await;
    assert!(h.st.plugins.pickers.sources_of("fliks.fixture").is_empty());
    h.finish().await;
    s.finish().await;
}

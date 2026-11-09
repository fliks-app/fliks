//! The acquisition queue and history (`plugins.md` rules 69-75) through the fixture plugin.
use super::harness::*;
use fliks_server::events::Bus;
use serde_json::{Value, json};

async fn report(h: &H, refs: &str, state: &str, media: i32) {
    let rt = h.st.plugins.rt("fliks.fixture").unwrap();
    let r = rt
        .http(
            fliks_server::plugins::HttpRequest {
                method: "GET".into(),
                path: "/test/queueset".into(),
                query: [
                    ("refs", refs),
                    ("state", state),
                    ("media", &media.to_string()),
                ]
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .into(),
                body: vec![],
                principal: fliks_server::plugins::Principal::Delegated(1),
            },
            false,
        )
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&r.body).unwrap();
    assert!(v.get("error").is_none(), "{v}");
}

async fn rows(h: &H, which: &str) -> Vec<Value> {
    let (s, v) = h
        .call(
            "GET",
            &format!("/api/acquisition/{which}"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(s, 200, "{v}");
    v["data"].as_array().unwrap().clone()
}

async fn setting(h: &H, key: &str) -> Option<Value> {
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = $1")
        .bind(format!("plugin.fliks.fixture.{key}"))
        .fetch_optional(&h.st.db)
        .await
        .unwrap();
    v.map(|v| serde_json::from_str(&v).unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_provider_reports_its_queue_and_the_core_proxies_actions() {
    let Some((mut m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("queue").await else {
        return;
    };
    let h = harness(&s, "queue", |_| {}).await;
    allow_unsigned(&h).await;
    for name in ["pause", "remove"] {
        m["routes"].as_array_mut().unwrap().push(
            json!({"method": "POST", "path": format!("/qaction/{name}"), "policy": "read:Settings"}),
        );
    }
    m["acquisition"] =
        json!({"queueActions": {"pause": "/qaction/pause", "remove": "/qaction/remove"}});
    let installed = h.install(&pack(&m, "0.1.0", &w, None)).await;
    assert_eq!(installed["status"], "active", "{installed}");
    let media = 720_001;
    sqlx::query("INSERT INTO media (id, title, type) VALUES ($1, 'Placeholder', 'movie')")
        .bind(media)
        .execute(&h.st.db)
        .await
        .unwrap();
    let mut rx = h.st.hub.subscribe();

    // A snapshot upserts; the next one without `b` moves it to the history.
    report(&h, "a,b", "active", media).await;
    let q = rows(&h, "queue").await;
    assert_eq!(q.len(), 2);
    let a = q.iter().find(|r| r["ref"] == "a").unwrap();
    assert_eq!(
        (
            a["state"].clone(),
            a["progress"].clone(),
            a["source"].clone()
        ),
        (json!("active"), json!(25.0), json!("Source"))
    );
    assert_eq!(a["infoUrl"], "https://example.test/info");
    assert_eq!(a["title"], "Placeholder");
    report(&h, "a", "active", media).await;
    assert_eq!(rows(&h, "queue").await.len(), 1);
    let hist = rows(&h, "history").await;
    assert_eq!(
        (hist.len(), hist[0]["state"].clone()),
        (1, json!("removed"))
    );
    assert_eq!(hist[0]["ref"], "b");

    // The table feeds the in-flight read (a plugin never sees itself).
    let others =
        fliks_server::plugins::queue::in_flight(&h.st.db, "other", media, None, None).await;
    assert_eq!(others.unwrap(), vec!["fliks.fixture".to_owned()]);
    let own =
        fliks_server::plugins::queue::in_flight(&h.st.db, "fliks.fixture", media, None, None).await;
    assert!(own.unwrap().is_empty());

    // The core proxies an action to the owner with the ref; no route declared, no action.
    let id = rows(&h, "queue").await[0]["id"].as_i64().unwrap();
    let (st, _) = h
        .call(
            "POST",
            &format!("/api/acquisition/queue/{id}/pause"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 204);
    assert_eq!(setting(&h, "qaction.pause").await.unwrap()["ref"], "a");
    let (st, _) = h
        .call(
            "DELETE",
            &format!("/api/acquisition/queue/{id}?blocklist=true"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 204);
    assert_eq!(
        setting(&h, "qaction.remove").await.unwrap(),
        json!({"ref": "a", "blocklist": true})
    );
    let (st, _) = h
        .call(
            "POST",
            &format!("/api/acquisition/queue/{id}/resume"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 409, "resume needs a paused entry");
    let (st, _) = h
        .call(
            "POST",
            "/api/acquisition/queue/999999/pause",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 404);
    let (st, _) = h
        .call(
            "POST",
            &format!("/api/acquisition/queue/{id}/pause"),
            Some(&h.user),
            None,
        )
        .await;
    assert_eq!(st, 403);

    // A finished transfer closes once, however often it is reported.
    report(&h, "a", "imported", media).await;
    report(&h, "a", "imported", media).await;
    assert!(rows(&h, "queue").await.is_empty());
    let hist = rows(&h, "history").await;
    assert_eq!(hist.iter().filter(|r| r["state"] == "imported").count(), 1);
    let (_, imported) = h
        .call(
            "GET",
            "/api/acquisition/history?state=imported&q=release",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(imported["total"], 1);
    let mut seen = false;
    while let Ok(bus) = rx.try_recv() {
        seen |= matches!(&*bus, Bus::Raw(r) if r.r#type == "acquisition.queue");
    }
    assert!(seen, "a change announces itself");

    // A stopped provider leaves no open row.
    report(&h, "c", "queued", media).await;
    assert_eq!(rows(&h, "queue").await.len(), 1);
    h.call(
        "POST",
        "/api/plugins/fliks.fixture/disable",
        Some(&h.admin),
        None,
    )
    .await;
    assert!(rows(&h, "queue").await.is_empty());
    let (st, _) = h
        .call("DELETE", "/api/acquisition/history", Some(&h.admin), None)
        .await;
    assert_eq!(st, 204);
    assert!(rows(&h, "history").await.is_empty());
    h.finish().await;
    s.finish().await;
}

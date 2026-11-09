//! Core-driven acquisition (`plugins.md` rule 68) through two fixture providers.
use super::harness::*;
use fliks_server::events::DomainEvent;
use fliks_server::plugins::acquisition;
use fliks_server::plugins::runtime::fliks::plugin::types::{CandidatesQuery, Target};
use fliks_server::plugins::sweep::Outcome;
use serde_json::{Value, json};
use std::time::Duration;

const A: &str = "fliks.fixture";
/// The fixture's id with one byte changed: the component embeds its id, so the second copy is the same wasm patched in place.
const B: &str = "fliks.fixtur2";

fn patch(wasm: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    assert_eq!(from.len(), to.len());
    let mut out = wasm.to_vec();
    for i in 0..out.len().saturating_sub(from.len()) {
        if out[i..].starts_with(from) {
            out[i..i + to.len()].copy_from_slice(to);
        }
    }
    out
}

async fn call(h: &H, id: &str, route: &str, q: &[(&str, &str)]) {
    let rt = h.st.plugins.rt(id).unwrap();
    let query = q.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
    let req = fliks_server::plugins::HttpRequest {
        method: "GET".into(),
        path: format!("/test/{route}"),
        query,
        body: vec![],
        principal: fliks_server::plugins::Principal::Delegated(1),
    };
    rt.http(req, false).await.unwrap();
}

fn release(title: &str, rank: i64) -> Value {
    json!({"title": title, "downloadUrl": format!("http://x/{title}"), "rank": rank, "customFormatScore": 0,
           "allowed": true, "rejections": [], "sourceId": 1})
}

async fn offer(h: &H, id: &str, releases: Value) {
    h.set(&format!("plugin.{id}.releases"), &releases.to_string())
        .await;
}

async fn grabbed(h: &H, id: &str, media: i32) -> Option<Value> {
    let key = format!("plugin.{id}.grabbed.{media}");
    let v: Option<String> = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(&h.st.db)
        .await
        .unwrap();
    v.map(|v| serde_json::from_str(&v).unwrap())
}

async fn forget(h: &H) {
    sqlx::query("DELETE FROM app_settings WHERE key LIKE 'plugin.%.grabbed.%'")
        .execute(&h.st.db)
        .await
        .unwrap();
}

async fn target(h: &H, media: u32) -> Target {
    let today = chrono::Local::now().date_naive();
    let q = CandidatesQuery {
        kind: None,
        family: None,
        media_ids: Some(vec![media]),
        available_on: today.to_string(),
        limit: 10,
        cursor: None,
    };
    let mut page = acquisition::candidates(&h.st.db, q, today).await.unwrap();
    page.items.pop().expect("the media is a candidate")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_core_ranks_every_provider_and_grabs_at_the_best() {
    let Some((mut m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("sweep").await else {
        return;
    };
    let h = harness(&s, "sweep", |_| {}).await;
    allow_unsigned(&h).await;
    m["routes"].as_array_mut().unwrap().extend([
        json!({"method": "GET", "path": "/search/:id", "policy": "read:Settings"}),
        json!({"method": "POST", "path": "/grab/:id", "policy": "read:Settings"}),
    ]);
    let pair = json!({"search": "/search/:id", "grab": "/grab/:id"});
    m["ui"]["releasePicker"] = json!({"movie": {"work": pair}});
    let mut second: Value = serde_json::from_str(&m.to_string().replace(A, B)).unwrap();
    // The i18n namespace is the first plugin's.
    second["i18n"] = json!({});
    second["ui"]["contributions"] = json!([]);
    second["ui"]["configPages"] = json!([]);
    second["jobs"] = json!([]);
    let patched = patch(&w, A.as_bytes(), B.as_bytes());
    for (manifest, wasm) in [(&m, &w), (&second, &patched)] {
        let pack = pack(manifest, "0.1.0", wasm, None);
        let r = h.install(&pack).await;
        assert_eq!(r["status"], "active", "{r}");
    }
    for id in [A, B] {
        call(&h, id, "sources", &[("ids", "s"), ("kinds", "movie")]).await;
    }
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Movies', '["movie"]');
           INSERT INTO library_folders ("libraryId", path) VALUES (1, '/nonexistent/m');
           INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'P', 18, '[]');
           INSERT INTO media (id, title, type, "libraryId", "folderName", year, monitored, status)
             VALUES (1, 'Big Buck Bunny', 'movie', 1, 'bbb', 2008, true, 'released'),
                    (2, 'Sintel', 'movie', 1, 'sintel', 2010, true, 'released');
           INSERT INTO wants ("mediaId", family, "qualityProfileId") VALUES (1, 'video', 1), (2, 'video', 1);"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();

    // The best score wins whichever provider holds it.
    offer(&h, A, json!([release("a", 3)])).await;
    offer(&h, B, json!([release("b", 5)])).await;
    let t1 = target(&h, 1).await;
    assert_eq!(h.st.plugins.acquire(&t1).await, Outcome::Grabbed(B.into()));
    assert_eq!(grabbed(&h, B, 1).await.unwrap()["sourceTitle"], "b");
    assert!(grabbed(&h, A, 1).await.is_none());

    // A tie goes to the first provider in order (by id until the admin orders them).
    forget(&h).await;
    offer(&h, B, json!([release("b", 3)])).await;
    assert_eq!(h.st.plugins.acquire(&t1).await, Outcome::Grabbed(B.into()));
    h.set("acquisition.providerOrder", &json!([A, B]).to_string())
        .await;
    until("the provider order", Duration::from_secs(10), async || {
        h.st.plugins.providers()[0] == A
    })
    .await;
    forget(&h).await;
    assert_eq!(h.st.plugins.acquire(&t1).await, Outcome::Grabbed(A.into()));

    // A release a provider would not grab (rejected) never wins.
    forget(&h).await;
    let mut rejected = release("rejected", 9);
    rejected["rejections"] = json!([{"code": "x"}]);
    offer(&h, B, json!([rejected])).await;
    assert_eq!(h.st.plugins.acquire(&t1).await, Outcome::Grabbed(A.into()));
    offer(&h, A, json!([])).await;
    assert_eq!(h.st.plugins.acquire(&t1).await, Outcome::NoRelease);

    // A media with a download in flight at any plugin is skipped.
    forget(&h).await;
    offer(&h, A, json!([release("a", 3)])).await;
    queue_set(&h, "other", 1, &["o"]).await;
    assert_eq!(
        h.st.plugins.acquire(&t1).await,
        Outcome::Skipped("in flight")
    );
    assert!(grabbed(&h, A, 1).await.is_none());
    queue_set(&h, "other", 1, &[]).await;

    // A request sweeps that media only.
    h.st.hub
        .emit_domain(DomainEvent::MediaAcquisitionRequested {
            media_ids: vec![2],
            reason: "t".into(),
        });
    until("the request's grab", Duration::from_secs(10), async || {
        grabbed(&h, A, 2).await.is_some()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(grabbed(&h, A, 1).await.is_none() && grabbed(&h, B, 1).await.is_none());

    h.finish().await;
    s.finish().await;
}

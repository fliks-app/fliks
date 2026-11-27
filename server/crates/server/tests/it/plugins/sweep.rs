//! Core-driven acquisition (`plugins.md` rule 68) through two fixture providers.
use super::harness::*;
use fliks_server::acquisition;
use fliks_server::acquisition::sweep::{Outcome, Pick, Scope};
use fliks_server::events::DomainEvent;
use fliks_server::plugins::runtime::HostConfig;
use fliks_server::plugins::runtime::fliks::plugin::types::{
    CandidatesQuery, Family, Target, UnitRef,
};
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

/// The fixture's `/test/<route>` answer as JSON.
async fn call_ok(h: &H, id: &str, route: &str, q: &[(&str, &str)]) -> Value {
    let rt = h.st.plugins.rt(id).unwrap();
    let req = fliks_server::plugins::HttpRequest {
        method: "GET".into(),
        path: format!("/test/{route}"),
        query: q.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
        body: vec![],
        principal: fliks_server::plugins::Principal::Delegated(1),
    };
    serde_json::from_slice(&rt.http(req, false).await.unwrap().body).unwrap()
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

/// The fixture's `searched` setting: the items it was searched for, `-` for a work.
async fn searched(h: &H, id: &str) -> String {
    let key = format!("plugin.{id}.searched");
    sqlx::query_scalar("SELECT value FROM app_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(&h.st.db)
        .await
        .unwrap()
        .unwrap_or_default()
}

async fn attempt(h: &H, media: i32) -> (String, i32, i32, Value, Option<String>) {
    sqlx::query_as::<_, (String, i32, i32, sqlx::types::Json<Value>, Option<String>)>(
        r#"SELECT outcome, found, eligible, rejections, "nextAt"::text FROM acquisition_attempts WHERE "mediaId" = $1"#,
    )
    .bind(media)
    .fetch_one(&h.st.db)
    .await
    .map(|(o, f, e, r, n)| (o, f, e, r.0, n))
    .unwrap()
}

async fn forget(h: &H) {
    sqlx::query("DELETE FROM app_settings WHERE key LIKE 'plugin.%.grabbed.%'")
        .execute(&h.st.db)
        .await
        .unwrap();
    // A grab puts its media in flight until its plugin reports.
    for id in [A, B] {
        h.st.plugins.progress.retire(id);
    }
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
           INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'P', 18, '[]') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, family = EXCLUDED.family, cutoff = EXCLUDED.cutoff, items = EXCLUDED.items;
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
    assert_eq!(
        h.st.plugins.acquire(&t1, false).await,
        Outcome::Grabbed(B.into())
    );
    assert_eq!(grabbed(&h, B, 1).await.unwrap()["sourceTitle"], "b");
    assert!(grabbed(&h, A, 1).await.is_none());
    // The search is kept with what both providers answered; a grab leaves no next search.
    assert_eq!(
        attempt(&h, 1).await,
        ("grabbed".into(), 2, 2, json!([]), None)
    );

    // A tie goes to the first provider in order (by id until the admin orders them).
    forget(&h).await;
    offer(&h, B, json!([release("b", 3)])).await;
    assert_eq!(
        h.st.plugins.acquire(&t1, false).await,
        Outcome::Grabbed(B.into())
    );
    h.set("acquisition.providerOrder", &json!([A, B]).to_string())
        .await;
    until("the provider order", Duration::from_secs(10), async || {
        h.st.plugins.providers()[0] == A
    })
    .await;
    forget(&h).await;
    assert_eq!(
        h.st.plugins.acquire(&t1, false).await,
        Outcome::Grabbed(A.into())
    );

    // A release a provider would not grab (rejected) never wins.
    forget(&h).await;
    let mut rejected = release("rejected", 9);
    rejected["rejections"] = json!([{"code": "x"}]);
    offer(&h, B, json!([rejected])).await;
    assert_eq!(
        h.st.plugins.acquire(&t1, false).await,
        Outcome::Grabbed(A.into())
    );
    forget(&h).await;
    offer(&h, A, json!([])).await;
    assert_eq!(h.st.plugins.acquire(&t1, false).await, Outcome::NoRelease);

    // Nothing grabbed: the attempt counts every release and ranks the rejection codes.
    forget(&h).await;
    let mut big = release("big", 9);
    big["rejections"] = json!([{"code": "SIZE_TOO_HIGH"}, {"code": "MIN_SEEDERS"}]);
    let mut big2 = release("big2", 9);
    big2["rejections"] = json!([{"code": "SIZE_TOO_HIGH"}]);
    let mut blocked = release("blocked", 9);
    blocked["blocklisted"] = json!(true);
    offer(&h, A, json!([big, big2, blocked])).await;
    offer(&h, B, json!([])).await;
    assert_eq!(h.st.plugins.acquire(&t1, false).await, Outcome::NoRelease);
    let (outcome, found, eligible, rejections, next_at) = attempt(&h, 1).await;
    assert_eq!((outcome.as_str(), found, eligible), ("none", 3, 0));
    assert_eq!(
        rejections,
        json!([
            {"code": "SIZE_TOO_HIGH", "count": 2},
            {"code": "BLOCKLISTED", "count": 1},
            {"code": "MIN_SEEDERS", "count": 1},
        ])
    );
    assert!(next_at.is_some());

    // A media with a download in flight at any plugin is skipped.
    forget(&h).await;
    offer(&h, A, json!([release("a", 3)])).await;
    queue_set(&h, "other", 1, &["o"]).await;
    assert_eq!(
        h.st.plugins.acquire(&t1, false).await,
        Outcome::Skipped("in flight")
    );
    assert!(grabbed(&h, A, 1).await.is_none());
    queue_set(&h, "other", 1, &[]).await;

    // Two sweeps of one media grab it once: the claim spans the in-flight check and the grab.
    forget(&h).await;
    offer(&h, A, json!([release("a", 3)])).await;
    let (x, y) = tokio::join!(
        h.st.plugins.acquire(&t1, false),
        h.st.plugins.acquire(&t1, true)
    );
    let mut got = [format!("{x:?}"), format!("{y:?}")];
    got.sort();
    assert_eq!(
        got,
        ["Grabbed(\"fliks.fixture\")", "Skipped(\"in flight\")"]
    );
    // The grab says how it was asked for.
    let body = grabbed(&h, A, 1).await.unwrap();
    assert!(matches!(body["method"].as_str(), Some("auto" | "manual")));
    forget(&h).await;

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

    // A plugin's `acquisition.request` ends in one grab; the asks of a media coalesce.
    forget(&h).await;
    offer(&h, A, json!([release("a", 3)])).await;
    offer(&h, B, json!([])).await;
    let ask = |extra: &[(&'static str, &'static str)]| {
        let mut q = vec![("media", "1")];
        q.extend_from_slice(extra);
        q
    };
    h.set(&format!("plugin.{A}.searched"), "").await;
    let r = call_ok(&h, A, "request", &ask(&[("repeat", "3")])).await;
    assert_eq!(r["ok"], Value::Null, "{r}");
    until("the request's grab", Duration::from_secs(10), async || {
        grabbed(&h, A, 1).await.is_some()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(grabbed(&h, A, 1).await.unwrap()["sourceTitle"], "a");
    assert_eq!(searched(&h, A).await, "-;", "one search for the three asks");

    // An ask for a family or a unit the media's target is not asks for nothing.
    forget(&h).await;
    for extra in [
        &[("family", "image")][..],
        &[("group", "1"), ("number", "2")],
    ] {
        call_ok(&h, A, "request", &ask(extra)).await;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(grabbed(&h, A, 1).await.is_none());
    call_ok(&h, A, "request", &ask(&[("family", "video")])).await;
    until(
        "the video ask's grab",
        Duration::from_secs(10),
        async || grabbed(&h, A, 1).await.is_some(),
    )
    .await;

    // An ask made while a sweep holds the claim searches nothing until it drops; the asks that
    // came meanwhile coalesce into one more pass. Nothing is offered, so no grab hides a pass.
    forget(&h).await;
    offer(&h, A, json!([])).await;
    h.set(&format!("plugin.{A}.searched"), "").await;
    let claim = h.st.plugins.sweeps.claims.lock(1).await;
    call_ok(&h, A, "request", &ask(&[])).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    for _ in 0..3 {
        call_ok(&h, A, "request", &ask(&[])).await;
    }
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(searched(&h, A).await, "", "no search under a held claim");
    drop(claim);
    until(
        "the held asks' passes",
        Duration::from_secs(10),
        async || searched(&h, A).await.len() >= 4,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(
        searched(&h, A).await,
        "-;-;",
        "the asks during the claim make one pass"
    );

    // No asks, more than a page of them, or a fractional video unit (family named or not) are refused.
    for extra in [
        &[("repeat", "0")][..],
        &[("repeat", "201")],
        &[("family", "video"), ("group", "1"), ("number", "1.5")],
        &[("group", "1"), ("number", "1.5")],
    ] {
        let r = call_ok(&h, A, "request", &ask(extra)).await;
        assert_eq!(r["error"], "ERR_VALIDATION", "{r}");
    }

    h.finish().await;
    s.finish().await;
}

/// A series of three missing episodes behind one item-level provider.
async fn series(
    tag: &str,
    tune: impl Fn(&mut HostConfig) + Send + Sync + 'static,
) -> Option<(H, Scratch, Vec<i32>)> {
    let (mut m, w) = fixture()?;
    let s = Scratch::create(tag).await?;
    let h = harness(&s, tag, tune).await;
    allow_unsigned(&h).await;
    m["routes"].as_array_mut().unwrap().extend([
        json!({"method": "GET", "path": "/search/:id/items/:itemId", "policy": "read:Settings"}),
        json!({"method": "POST", "path": "/grab/:id/items/:itemId", "policy": "read:Settings"}),
    ]);
    let pair = json!({"search": "/search/:id/items/:itemId", "grab": "/grab/:id/items/:itemId"});
    m["ui"]["releasePicker"] = json!({"series": {"item": pair}});
    let r = h.install(&pack(&m, "0.1.0", &w, None)).await;
    assert_eq!(r["status"], "active", "{r}");
    call(&h, A, "sources", &[("ids", "s"), ("kinds", "series")]).await;
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Shows', '["series"]');
           INSERT INTO library_folders ("libraryId", path) VALUES (1, '/nonexistent/s');
           INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'P', 18, '[]') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, family = EXCLUDED.family, cutoff = EXCLUDED.cutoff, items = EXCLUDED.items;
           INSERT INTO media (id, title, type, "libraryId", "folderName", year, monitored, status)
             VALUES (3, 'Some Show', 'series', 1, 'show', 2008, true, 'released');
           INSERT INTO wants ("mediaId", family, "qualityProfileId") VALUES (3, 'video', 1);
           INSERT INTO editions ("mediaId", family) VALUES (3, 'video');
           INSERT INTO item_groups ("mediaId", "number", monitored) VALUES (3, 1, true);
           INSERT INTO items ("mediaId", "editionId", "groupId", "number", monitored, "airDate")
             SELECT 3, (SELECT id FROM editions WHERE "mediaId" = 3), (SELECT id FROM item_groups WHERE "mediaId" = 3), n, true, ('2020-01-0' || n)::date
             FROM generate_series(1, 3) n;"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let items = sqlx::query_scalar(r#"SELECT id FROM items WHERE "mediaId" = 3 ORDER BY "number""#)
        .fetch_all(&s.pool)
        .await
        .unwrap();
    Some((h, s, items))
}

async fn item_grabbed(h: &H, media: i32, item: i32) -> bool {
    grabbed(h, A, media).await.is_none() && {
        let key = format!("plugin.{A}.grabbed.{media}.{item}");
        sqlx::query_scalar::<_, String>("SELECT value FROM app_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(&h.st.db)
            .await
            .unwrap()
            .is_some()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_unit_ask_searches_and_grabs_only_that_episode() {
    let Some((h, s, items)) = series("sweep_unit", |_| {}).await else {
        return;
    };
    offer(&h, A, json!([release("a", 3)])).await;
    let r = call_ok(
        &h,
        A,
        "request",
        &[("media", "3"), ("group", "1"), ("number", "2")],
    )
    .await;
    assert_eq!(r["ok"], Value::Null, "{r}");
    until("the episode's grab", Duration::from_secs(10), async || {
        item_grabbed(&h, 3, items[1]).await
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(searched(&h, A).await, format!("{};", items[1]));
    assert!(!item_grabbed(&h, 3, items[0]).await && !item_grabbed(&h, 3, items[2]).await);
    h.finish().await;
    s.finish().await;
}

/// A provider cooling answers 503: the target is asked again at the instant, and only that target.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cooling_unit_ask_is_asked_again_for_its_own_target() {
    let Some((h, s, items)) = series("sweep_cooling", |_| {}).await else {
        return;
    };
    offer(&h, A, json!([release("a", 3)])).await;
    let at = chrono::Utc::now() + chrono::Duration::seconds(2);
    h.set(&format!("plugin.{A}.cooling"), &at.to_rfc3339())
        .await;
    call_ok(
        &h,
        A,
        "request",
        &[("media", "3"), ("group", "1"), ("number", "2")],
    )
    .await;
    until("the first search", Duration::from_secs(10), async || {
        !searched(&h, A).await.is_empty()
    })
    .await;
    h.set(&format!("plugin.{A}.cooling"), "").await;
    until("the episode's grab", Duration::from_secs(15), async || {
        item_grabbed(&h, 3, items[1]).await
    })
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    let two = format!("{0};{0};", items[1]);
    assert_eq!(searched(&h, A).await, two, "the wake keeps its scope");
    h.finish().await;
    s.finish().await;
}

/// A busy provider: the retry asks for the episode again, never the media's other targets.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_busy_unit_ask_is_retried_for_its_own_target() {
    // One instance and no queue: a search while another call runs finds the provider busy.
    let Some((h, s, items)) = series("sweep_busy", |c| {
        c.http_max = 1;
        c.http_queue = 0;
    })
    .await
    else {
        return;
    };
    offer(&h, A, json!([release("a", 3)])).await;
    let rt = h.st.plugins.rt(A).unwrap();
    let held = rt.clone();
    let spin = tokio::spawn(async move {
        let req = fliks_server::plugins::HttpRequest {
            method: "GET".into(),
            path: "/test/spin".into(),
            query: vec![("s".into(), "10".into())],
            body: vec![],
            principal: fliks_server::plugins::Principal::Delegated(1),
        };
        held.http(req, false).await
    });
    until("the spin running", Duration::from_secs(10), async || {
        rt.http.free() == 0
    })
    .await;
    let ep2 = UnitRef {
        group: Some(1),
        number: Some(2.0),
        end_number: None,
        label: None,
        absolute: None,
    };
    let pick = Pick::of(Family::Video, None, Some(&ep2)).unwrap();
    h.st.plugins
        .request_scoped(&h.st, vec![(3, Scope::Only(vec![pick]))]);
    spin.await.unwrap().unwrap();
    assert_eq!(
        searched(&h, A).await,
        "",
        "the busy search never reached the provider"
    );
    until("the retry's grab", Duration::from_secs(60), async || {
        item_grabbed(&h, 3, items[1]).await
    })
    .await;
    assert_eq!(searched(&h, A).await, format!("{};", items[1]));
    assert!(!item_grabbed(&h, 3, items[0]).await && !item_grabbed(&h, 3, items[2]).await);
    h.finish().await;
    s.finish().await;
}

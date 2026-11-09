//! The acquisition queue and history (`plugins.md` rules 69-75) through the fixture plugin.
use super::harness::*;
use fliks_server::events::Bus;
use fliks_server::plugins::queue;
use fliks_server::plugins::runtime::fliks::plugin::types::{
    GrabMethod, QueueEntry, QueueState, UnitRef,
};
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

/// A media in a library every user can open.
async fn add_media(h: &H, id: i32, kind: &str) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (720, 'L', '["movie","comic"]') ON CONFLICT DO NOTHING;
           INSERT INTO media (id, title, type, "libraryId") VALUES ({id}, 'Placeholder', '{kind}', 720)"#
    )))
    .execute(&h.st.db)
    .await
    .unwrap();
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
    add_media(&h, media, "movie").await;
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

fn entry(r: &str, media: u32, unit: Option<UnitRef>, title: &str) -> QueueEntry {
    QueueEntry {
        ref_: r.into(),
        media_id: media,
        unit,
        source_id: "s".into(),
        source_name: "S".into(),
        title: title.into(),
        quality: String::new(),
        method: GrabMethod::Auto,
        info_url: None,
        state: QueueState::Active,
        progress: 0.5,
        size_bytes: None,
        bytes_per_second: None,
        eta_seconds: None,
        error: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bad_entry_is_refused_alone_and_the_rest_of_the_snapshot_applies() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("queue_bad").await else {
        return;
    };
    let h = harness(&s, "queue_bad", |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    add_media(&h, 720_010, "movie").await;
    add_media(&h, 720_011, "comic").await;
    let issue = UnitRef {
        group: None,
        number: Some(3.5),
        end_number: None,
        label: None,
        absolute: None,
    };
    let set = |entries: Vec<QueueEntry>| {
        let st = h.st.clone();
        async move { queue::set(&st, "fliks.fixture", entries).await.unwrap() }
    };
    // A comic issue (no group, fractional) and an empty quality are fine; the empty title is refused alone.
    set(vec![
        entry("a", 720_010, None, "A"),
        entry("issue", 720_011, Some(issue), "Issue"),
        entry("bad", 720_010, None, ""),
    ])
    .await;
    let q = rows(&h, "queue").await;
    let mut refs: Vec<_> = q.iter().map(|r| r["ref"].as_str().unwrap()).collect();
    refs.sort_unstable();
    assert_eq!(refs, ["a", "issue"]);
    let unit: (Option<i32>, Option<i32>) =
        sqlx::query_as(r#"SELECT season, episode FROM acquisition_queue WHERE "ref" = 'issue'"#)
            .fetch_one(&h.st.db)
            .await
            .unwrap();
    assert_eq!(unit, (None, None));

    // A refused entry leaves its open row alone; only a name the snapshot omits closes.
    set(vec![
        entry("a", 720_010, None, ""),
        entry("issue", 720_011, None, "Issue"),
    ])
    .await;
    let q = rows(&h, "queue").await;
    assert_eq!(q.len(), 2, "the refused entry did not close its row");
    let a = q.iter().find(|r| r["ref"] == "a").unwrap();
    assert_eq!(a["sourceTitle"], "A");
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deleted_history_stays_deleted_and_a_returning_transfer_reuses_its_row() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("queue_hist").await else {
        return;
    };
    let h = harness(&s, "queue_hist", |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    add_media(&h, 720_020, "movie").await;
    let media = 720_020;

    // A transfer missing from one snapshot closes removed; its return reopens that row, then it imports: one row.
    report(&h, "x", "active", media).await;
    report(&h, "y", "active", media).await;
    report(&h, "y", "active", media).await;
    report(&h, "x", "active", media).await;
    assert_eq!(rows(&h, "queue").await.len(), 1);
    assert!(
        rows(&h, "history").await.iter().all(|r| r["ref"] != "x"),
        "reopened, not duplicated"
    );
    report(&h, "y", "active", media).await;
    report(&h, "x,y", "imported", media).await;
    let hist = rows(&h, "history").await;
    assert_eq!(hist.iter().filter(|r| r["ref"] == "x").count(), 1);
    assert!(hist.iter().all(|r| r["state"] == "imported"), "{hist:?}");

    // A provider that keeps reporting a finished transfer never brings deleted history back, whatever the order of the two.
    for _ in 0..8 {
        let (_, cleared) = tokio::join!(
            report(&h, "x,y", "imported", media),
            h.call("DELETE", "/api/acquisition/history", Some(&h.admin), None)
        );
        assert_eq!(cleared.0, 204);
    }
    let (st, _) = h
        .call("DELETE", "/api/acquisition/history", Some(&h.admin), None)
        .await;
    assert_eq!(st, 204);
    report(&h, "x,y", "imported", media).await;
    assert!(rows(&h, "history").await.is_empty());
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_queue_lists_only_open_libraries_and_its_actions_need_queue_manage() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("queue_perm").await else {
        return;
    };
    let h = harness(&s, "queue_perm", |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    add_media(&h, 720_030, "movie").await;
    report(&h, "a", "imported", 720_030).await;
    let hist_id = rows(&h, "history").await[0]["id"].as_i64().unwrap();

    let role = |perms: &str| {
        let q = format!(
            r#"WITH r AS (INSERT INTO roles (name, permissions) VALUES ('r' || nextval('roles_id_seq'), '{perms}') RETURNING id)
               UPDATE users SET "roleId" = (SELECT id FROM r) WHERE username = 'user'"#
        );
        sqlx::query(sqlx::AssertSqlSafe(q)).execute(&h.st.db)
    };
    let user = |m: &'static str, uri: String| {
        let (h, t) = (&h, h.user.clone());
        async move { h.call(m, &uri, Some(&t), None).await }
    };
    role(r#"["media.grab"]"#).await.unwrap();
    // No library of its own: the list is empty and the actions are refused.
    assert_eq!(
        user("GET", "/api/acquisition/history".into()).await.1["total"],
        0
    );
    assert_eq!(
        user("DELETE", format!("/api/acquisition/history/{hist_id}"))
            .await
            .0,
        403
    );
    assert_eq!(
        user("DELETE", "/api/acquisition/history".into()).await.0,
        403
    );

    // With the library it sees the row, and still cannot delete without `queue.manage`.
    sqlx::query(r#"INSERT INTO library_user_access ("libraryId", "userId") SELECT 720, id FROM users WHERE username = 'user'"#)
        .execute(&h.st.db)
        .await
        .unwrap();
    assert_eq!(
        user("GET", "/api/acquisition/history".into()).await.1["total"],
        1
    );
    assert_eq!(
        user("DELETE", format!("/api/acquisition/history/{hist_id}"))
            .await
            .0,
        403
    );
    role(r#"["media.grab","queue.manage"]"#).await.unwrap();
    assert_eq!(
        user("DELETE", format!("/api/acquisition/history/{hist_id}"))
            .await
            .0,
        204
    );
    assert_eq!(
        user("GET", "/api/acquisition/history".into()).await.1["total"],
        0
    );
    h.finish().await;
    s.finish().await;
}

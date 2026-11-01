//! `/api/plugins/*` end to end: the install pipeline, catalog sources, ownership rules.
use super::harness::*;
use super::net::{Reply, StubNet, pki, stub};
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use fliks_server::plugins::fetch::Fetcher;
use fliks_server::plugins::{archive, packages};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn sign(bytes: &[u8]) -> String {
    format!(
        "{}\n",
        base64::engine::general_purpose::STANDARD.encode(test_key().sign(bytes).to_bytes())
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn install_pipeline_refusals_and_signatures() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("pipeline").await else {
        return;
    };
    let h = harness(&s, "pipeline", |_| {}).await;
    let unsigned = pack(&m, "0.1.0", &w, None);
    let (_, r) = h.upload(&unsigned).await;
    assert_eq!(
        (r["installable"].clone(), r["refusalCode"].clone()),
        (json!(false), json!("PLUGIN_UNSIGNED"))
    );
    let (st, r) = h.upload(b"nope").await;
    assert_eq!(
        (st, r["refusalCode"].as_str()),
        (201, Some("PLUGIN_BAD_MAGIC"))
    );
    let mut reserved = m.clone();
    reserved["id"] = json!("metrics");
    let (_, r) = h
        .upload(&pack(&reserved, "0.1.0", &w, Some(&test_key())))
        .await;
    assert_eq!(r["refusalCode"], "PLUGIN_BAD_ID", "reserved id");
    let signed = pack(&m, "0.1.0", &w, Some(&test_key()));
    let (_, r) = h.upload(&signed).await;
    assert_eq!(
        (r["signature"].as_str(), r["signedByKeyId"].as_str()),
        (Some("official"), Some("test-key")),
        "{r}"
    );
    assert_eq!(
        r["capabilities"],
        json!([
            "ui:nav.acquisition",
            "ui:settings.page",
            "config:queue",
            "config:general",
            "scope:config:rw",
            "scope:media:read",
            "scope:events:emit",
            "scope:ingest:write",
            "scope:requests:progress",
            "scope:acquisition:candidates",
            "scope:releases:score",
            "job:FixtureJob",
            "job:FixtureHidden"
        ])
    );
    assert_eq!(r["compatible"], true);
    let (st, c) = h
        .call(
            "POST",
            "/api/plugins/import/confirm",
            Some(&h.admin),
            Some(json!({"stagingId": r["stagingId"], "sha256": "0".repeat(64)})),
        )
        .await;
    assert_eq!(
        (st, c["code"].as_str()),
        (409, Some("PLUGIN_STAGING_STALE"))
    );
    let (st, c) = h
        .call(
            "POST",
            "/api/plugins/import/confirm",
            Some(&h.admin),
            Some(json!({"stagingId": "x"})),
        )
        .await;
    assert_eq!(st, 400, "{c}");
    let (st, c) = h
        .call(
            "POST",
            "/api/plugins/import/confirm",
            Some(&h.admin),
            Some(json!({"stagingId": "a".repeat(32), "sha256": "a".repeat(64)})),
        )
        .await;
    assert_eq!(
        (st, c["code"].as_str()),
        (404, Some("PLUGIN_STAGING_NOT_FOUND"))
    );
    assert_eq!(
        h.call(
            "POST",
            "/api/plugins/import/confirm",
            Some(&h.user),
            Some(json!({}))
        )
        .await
        .0,
        403
    );
    let r = h.install(&signed).await;
    assert_eq!(r["status"], "active", "{r}");
    let pkg = packages::find(&s.pool, "fliks.fixture")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (pkg.signature.as_str(), pkg.verified_by_key_id.as_deref()),
        ("official", Some("test-key"))
    );
    let (st, headers, body) = h
        .raw(
            "GET",
            "/api/plugins/fliks.fixture/logo",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        (
            st,
            &headers["content-type"],
            &headers["content-security-policy"]
        ),
        (
            200,
            &"image/svg+xml".parse().unwrap(),
            &"sandbox".parse().unwrap()
        )
    );
    assert_eq!(body, LOGO);
    // A route a core route shadows is refused at registration.
    let mut shadow = m.clone();
    shadow["routes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"method": "GET", "path": "/Logo/", "policy": "read:Settings"}));
    let r = h
        .install(&pack(&shadow, "0.1.0", &w, Some(&test_key())))
        .await;
    assert_eq!(
        (r["status"].as_str(), r["reason"].as_str()),
        (Some("failed"), Some("invalid-route-path")),
        "{r}"
    );
    // Five staged uploads at most; discarding one frees its slot.
    let mut staged = None;
    for i in 0..6 {
        let mut d = json!({"id": format!("acme.d{i}"),"pluginApi":2,"name":"D","version":"1.0.0","fliks":">=5.0.0 <6.0.0",
            "author":"a","description":"d","license":"MIT","logo":"logo.svg","kind":"data"});
        d["name"] = json!(format!("D{i}"));
        let (st, r) = h.upload(&data_archive(&d)).await;
        if i < 5 {
            assert_eq!(st, 201, "{r}");
            staged = r["stagingId"].as_str().map(str::to_owned);
        } else {
            assert_eq!(
                (st, r["code"].as_str()),
                (429, Some("PLUGIN_STAGING_LIMIT")),
                "{r}"
            );
        }
    }
    let uri = format!("/api/plugins/import/{}", staged.unwrap());
    assert_eq!(h.call("DELETE", &uri, Some(&h.user), None).await.0, 403);
    assert_eq!(h.call("DELETE", &uri, Some(&h.admin), None).await.0, 204);
    let (st, r) = h.call("DELETE", &uri, Some(&h.admin), None).await;
    assert_eq!(
        (st, r["code"].as_str()),
        (404, Some("PLUGIN_STAGING_NOT_FOUND"))
    );
    let bad = "/api/plugins/import/..%2f..";
    assert_eq!(h.call("DELETE", bad, Some(&h.admin), None).await.0, 400);
    let d = json!({"id": "acme.d9","pluginApi":2,"name":"D9","version":"1.0.0","fliks":">=5.0.0 <6.0.0",
        "author":"a","description":"d","license":"MIT","logo":"logo.svg","kind":"data"});
    assert_eq!(h.upload(&data_archive(&d)).await.0, 201);
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn config_ownership_and_counts() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("owner").await else {
        return;
    };
    let h = harness(&s, "owner", |_| {}).await;
    allow_unsigned(&h).await;
    let sub = json!({"id":"fliks.fixture.sub","pluginApi":2,"name":"Sub","version":"1.0.0","fliks":">=5.0.0 <6.0.0",
        "author":"a","description":"d","license":"MIT","logo":"logo.svg","kind":"data"});
    assert_eq!(h.install(&data_archive(&sub)).await["status"], "active");
    h.set("plugin.fliks.fixture.sub.secret", "theirs").await;
    h.set("plugin.fliks.fixture.mine", "ours").await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let (_, cfg) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/config",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        cfg,
        json!({"mine": "ours"}),
        "a longer id's keys are not ours"
    );
    let rt = h.st.plugins.rt("fliks.fixture").unwrap();
    let get = async |path: &str, q: &[(&str, &str)]| {
        let r = rt
            .http(
                fliks_server::plugins::HttpRequest {
                    method: "GET".into(),
                    path: path.into(),
                    query: q.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
                    body: vec![],
                    principal: fliks_server::plugins::Principal::Delegated(1),
                },
                false,
            )
            .await
            .unwrap();
        serde_json::from_slice::<Value>(&r.body).unwrap()
    };
    assert_eq!(
        get("/test/config-set", &[("key", "sub.secret"), ("value", "x")]).await["error"],
        "ERR_DENIED"
    );
    assert_eq!(
        get("/test/config-set", &[("key", "written"), ("value", "x")]).await["ok"],
        Value::Null
    );
    let stored: Option<String> = sqlx::query_scalar(
        r#"SELECT value FROM app_settings WHERE key = 'plugin.fliks.fixture.written'"#,
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(stored.as_deref(), Some("x"));
    assert_eq!(
        get("/test/counts", &[("key", ""), ("v", "1")]).await["error"],
        "ERR_VALIDATION",
        "empty key"
    );
    assert_eq!(
        get("/test/counts", &[("key", "queueActive"), ("v", "3")]).await["ok"],
        Value::Null
    );
    assert_eq!(h.st.plugins.counts.get("queueActive"), Some(3));
    let (_, ex) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/export",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        ex["settings"],
        json!({"plugin.fliks.fixture.mine": "ours", "plugin.fliks.fixture.written": "x"})
    );
    assert_eq!(
        h.call("DELETE", "/api/plugins/fliks.fixture", Some(&h.admin), None)
            .await
            .0,
        204
    );
    let left: Vec<String> = sqlx::query_scalar(r#"SELECT key::text FROM app_settings WHERE key LIKE 'plugin.fliks.fixture.%' ORDER BY key"#)
        .fetch_all(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        left,
        ["plugin.fliks.fixture.sub.secret"],
        "uninstall keeps another owner's keys"
    );
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_lifecycle_of_one_id_is_serialised() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("lifecycle").await else {
        return;
    };
    let h = Arc::new(harness(&s, "lifecycle", |_| {}).await);
    allow_unsigned(&h).await;
    let archive = pack(&m, "0.1.0", &w, None);
    let (_, r) = h.upload(&archive).await;
    let body = json!({"stagingId": r["stagingId"], "sha256": r["sha256"]});
    let mut tasks = vec![];
    for i in 0..6 {
        let (h, body) = (h.clone(), body.clone());
        tasks.push(tokio::spawn(async move {
            match i % 3 {
                0 => {
                    h.call(
                        "POST",
                        "/api/plugins/import/confirm",
                        Some(&h.admin),
                        Some(body),
                    )
                    .await
                    .0
                }
                1 => {
                    h.call(
                        "POST",
                        "/api/plugins/fliks.fixture/disable",
                        Some(&h.admin),
                        None,
                    )
                    .await
                    .0
                }
                _ => {
                    h.call(
                        "POST",
                        "/api/plugins/fliks.fixture/enable",
                        Some(&h.admin),
                        None,
                    )
                    .await
                    .0
                }
            }
        }));
    }
    for t in tasks {
        assert_ne!(t.await.unwrap(), 500);
    }
    let n: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM plugin_packages WHERE "pluginId" = 'fliks.fixture'"#,
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(n, 1);
    let h = Arc::try_unwrap(h).ok().unwrap();
    h.finish().await;
    s.finish().await;
}

/// A signed catalog served by a TLS stub, its signature written with a trailing newline.
/// Archives the stub serves, by path.
type Archives = Arc<Mutex<Vec<(String, Vec<u8>)>>>;

struct Catalog {
    doc: Arc<Mutex<Vec<u8>>>,
    port: u16,
    ca: reqwest::Certificate,
    archives: Archives,
}

async fn catalog() -> Catalog {
    let p = pki(&["localhost"]);
    let doc: Arc<Mutex<Vec<u8>>> = Arc::default();
    let archives: Archives = Arc::default();
    let (d, a) = (doc.clone(), archives.clone());
    let reply: Reply = Arc::new(move |path| {
        let body = d.lock().unwrap().clone();
        match path {
            "/catalog.json" => (200, vec![], body),
            "/catalog.json.sig" => (200, vec![], sign(&body).into_bytes()),
            p => match a.lock().unwrap().iter().find(|(n, _)| n == p) {
                Some((_, b)) => (200, vec![], b.clone()),
                None => (404, vec![], vec![]),
            },
        }
    });
    let (port, _) = stub(p.server.clone(), reply).await;
    Catalog {
        doc,
        port,
        ca: reqwest::Certificate::from_pem(p.ca_pem.as_bytes()).unwrap(),
        archives,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sources_catalog_denylist_and_auto_update() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("sources").await else {
        return;
    };
    let cat = catalog().await;
    let ca = cat.ca.clone();
    let h = harness_with(&s, "sources", Arc::new(|_| {}), move |o| {
        o.fetch = Fetcher {
            net: StubNet::new(1, tokio_rustls::rustls::RootCertStore::empty(), &[]),
            roots: vec![ca.clone()],
        };
    })
    .await;
    let url = format!("https://localhost:{}/catalog.json", cat.port);
    let key =
        base64::engine::general_purpose::STANDARD.encode(test_key().verifying_key().to_bytes());
    let (st, r) = h
        .call(
            "POST",
            "/api/plugins/sources",
            Some(&h.admin),
            Some(json!({"url": "http://x/c.json"})),
        )
        .await;
    assert_eq!(
        (st, r["code"].as_str()),
        (400, Some("PLUGIN_SOURCE_INSECURE_URL"))
    );
    let (st, r) = h
        .call(
            "POST",
            "/api/plugins/sources",
            Some(&h.admin),
            Some(json!({"url": url, "publicKey": "AAAA"})),
        )
        .await;
    assert_eq!(
        (st, r["code"].as_str()),
        (400, Some("PLUGIN_SOURCE_BAD_KEY"))
    );
    let (st, src) = h
        .call(
            "POST",
            "/api/plugins/sources",
            Some(&h.admin),
            Some(json!({"url": url, "publicKey": key})),
        )
        .await;
    assert_eq!(
        (st, src["hasPinnedKey"].as_bool()),
        (201, Some(true)),
        "{src}"
    );
    let id = src["id"].as_i64().unwrap();
    let (st, _) = h
        .call(
            "POST",
            "/api/plugins/sources",
            Some(&h.admin),
            Some(json!({"url": url})),
        )
        .await;
    assert_eq!(st, 409);
    // An installed package the key vouched for, older than the catalog's version.
    let signed = pack(&m, "0.1.0", &w, Some(&test_key()));
    assert_eq!(h.install(&signed).await["status"], "active");
    sqlx::query(r#"UPDATE plugin_packages SET version = '0.0.9'"#)
        .execute(&s.pool)
        .await
        .unwrap();
    let sha = archive::sha256_hex(&signed);
    cat.archives
        .lock()
        .unwrap()
        .push(("/fixture-0.1.0.fkplugin".into(), signed.clone()));
    let entry = |v: &str, sha: &str| {
        json!({"version": v, "pluginApi": 2, "fliks": ">=5.0.0 <6.0.0",
        "zipUrl": format!("https://localhost:{}/fixture-{v}.fkplugin", cat.port), "sha256": sha})
    };
    let logo = |p: &str| format!("https://localhost:{}/{p}", cat.port);
    let png = [
        &[0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a][..],
        &[0; 8],
    ]
    .concat();
    cat.archives.lock().unwrap().extend([
        ("/ok.png".to_owned(), png.clone()),
        (
            "/evil.svg".to_owned(),
            b"<svg><script>1</script></svg>".to_vec(),
        ),
        ("/big.png".to_owned(), vec![0; 600 << 10]),
    ]);
    let other = |id: &str, l: &str| {
        json!({"id": id, "name": id, "description": "", "author": "a", "kind": "process",
        "logo": logo(l), "versions": [entry("0.1.0", &sha)]})
    };
    let doc = json!({"plugins": [{"id": "fliks.fixture", "name": "Fixture", "description": "", "author": "a", "kind": "process",
        "logo": logo("ok.png"), "versions": [entry("0.1.0", &sha)]},
        other("fliks.evil", "evil.svg"), other("fliks.big", "big.png"), other("fliks.gone", "gone.png")]});
    *cat.doc.lock().unwrap() = serde_json::to_vec(&doc).unwrap();
    let (st, r) = h
        .call(
            "POST",
            &format!("/api/plugins/sources/{id}/refresh"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        (st, r.clone()),
        (201, json!({"ok": true})),
        "a trailing newline in the signature verifies"
    );
    let (_, c) = h
        .call(
            "GET",
            &format!("/api/plugins/sources/{id}/catalog"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(c["cachedCatalog"]["signedByKeyId"], "source");
    let logo_uri = |p: &str| format!("/api/plugins/sources/{id}/catalog/{p}/logo");
    let (st, headers, body) = h
        .raw("GET", &logo_uri("fliks.fixture"), Some(&h.admin), None)
        .await;
    assert_eq!(
        (
            st,
            &headers["content-type"],
            &headers["content-security-policy"],
            body
        ),
        (
            200,
            &"image/png".parse().unwrap(),
            &"sandbox".parse().unwrap(),
            png
        ),
    );
    for (p, want) in [
        ("fliks.evil", 404),
        ("fliks.big", 502),
        ("fliks.gone", 502),
        ("fliks.nope", 404),
    ] {
        let (st, _, _) = h.raw("GET", &logo_uri(p), Some(&h.admin), None).await;
        assert_eq!(st, want, "{p}");
    }
    assert_eq!(
        h.raw("GET", &logo_uri("fliks.fixture"), None, None).await.0,
        401
    );
    let (st, r) = h
        .call(
            "POST",
            &format!("/api/plugins/sources/{id}/inspect"),
            Some(&h.admin),
            Some(json!({"pluginId": "fliks.fixture", "version": "9.9.9"})),
        )
        .await;
    assert_eq!(
        (st, r["code"].as_str()),
        (404, Some("PLUGIN_CATALOG_VERSION_NOT_FOUND"))
    );
    // The newest version newly requesting network.internal is skipped by auto-update.
    let mut netm = m.clone();
    netm["network"] = json!({"internal": true});
    let net_signed = pack(&netm, "0.1.0", &w, Some(&test_key()));
    cat.archives.lock().unwrap()[0].1 = net_signed.clone();
    let doc = json!({"plugins": [{"id": "fliks.fixture", "name": "Fixture", "description": "", "author": "a", "kind": "process",
        "versions": [entry("0.1.0", &archive::sha256_hex(&net_signed))]}]});
    *cat.doc.lock().unwrap() = serde_json::to_vec(&doc).unwrap();
    h.call(
        "POST",
        &format!("/api/plugins/sources/{id}/refresh"),
        Some(&h.admin),
        None,
    )
    .await;
    let out = h.st.plugins.auto_update().await;
    assert_eq!(out["updated"], json!([]), "{out}");
    assert!(
        out["skipped"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("network.internal"),
        "{out}"
    );
    // From a pluginApi 1 package by the same key the grant carries forward.
    sqlx::query(r#"UPDATE plugin_packages SET manifest = jsonb_set(manifest, '{pluginApi}', '1')"#)
        .execute(&s.pool)
        .await
        .unwrap();
    let out = h.st.plugins.auto_update().await;
    assert_eq!(out["updated"][0]["to"], "0.1.0", "{out}");
    let pkg = packages::find(&s.pool, "fliks.fixture")
        .await
        .unwrap()
        .unwrap();
    assert!(pkg.network_internal);
    // A deny entry from the verifying key fails the installed package at once.
    let doc =
        json!({"plugins": [], "denyList": [{"pluginId": "fliks.fixture", "reason": "pulled"}]});
    *cat.doc.lock().unwrap() = serde_json::to_vec(&doc).unwrap();
    sqlx::query(r#"UPDATE plugin_packages SET "verifiedByKeyId" = 'source'"#)
        .execute(&s.pool)
        .await
        .unwrap();
    h.call(
        "POST",
        &format!("/api/plugins/sources/{id}/refresh"),
        Some(&h.admin),
        None,
    )
    .await;
    let pkg = packages::find(&s.pool, "fliks.fixture")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pkg.status_reason.as_deref(), Some("revoked: pulled"));
    assert!(h.st.plugins.rt("fliks.fixture").is_none());
    // A new url clears the cache; no URL in the refresh error.
    let (st, r) = h
        .call(
            "PUT",
            &format!("/api/plugins/sources/{id}"),
            Some(&h.admin),
            Some(json!({"url": "https://localhost:1/c.json?token=secret"})),
        )
        .await;
    assert_eq!(
        (st, r["lastRefreshedAt"].clone(), r["pluginCount"].clone()),
        (200, Value::Null, json!(0)),
        "{r}"
    );
    let (_, r) = h
        .call(
            "POST",
            &format!("/api/plugins/sources/{id}/refresh"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        (r["reason"].as_str(), r["detail"].as_str()),
        (Some("network-error"), Some("network error"))
    );
    let (_, list) = h
        .call("GET", "/api/plugins/sources", Some(&h.admin), None)
        .await;
    assert_eq!(list[0]["lastRefreshError"], "network error");
    assert_eq!(
        h.call(
            "DELETE",
            &format!("/api/plugins/sources/{id}"),
            Some(&h.admin),
            None
        )
        .await
        .0,
        204
    );
    assert_eq!(
        h.call(
            "DELETE",
            &format!("/api/plugins/sources/{id}"),
            Some(&h.admin),
            None
        )
        .await
        .0,
        404
    );
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn network_internal_needs_the_grant() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("netgrant").await else {
        return;
    };
    let h = harness(&s, "netgrant", |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let mut netm = m.clone();
    netm["network"] = json!({"internal": true});
    let up = pack(&netm, "0.1.0", &w, None);
    let (_, r) = h.upload(&up).await;
    assert!(
        r["capabilities"]
            .as_array()
            .unwrap()
            .contains(&json!("network:internal")),
        "newly requested: listed"
    );
    sqlx::query(r#"UPDATE plugin_packages SET manifest = $1, archive = $2"#)
        .bind(&netm)
        .bind(&up)
        .execute(&s.pool)
        .await
        .unwrap();
    let (st, r) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/restart",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        (
            st,
            r["message"]
                .as_str()
                .map(|m| m.starts_with("network-not-granted"))
        ),
        (503, Some(true)),
        "{r}"
    );
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn export_import_order_and_checks() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("backup").await else {
        return;
    };
    let h = harness(&s, "backup", |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let rt = h.st.plugins.rt("fliks.fixture").unwrap();
    let mut req = fliks_server::plugins::HttpRequest {
        method: "POST".into(),
        path: "/test/db/script".into(),
        query: vec![("name".into(), "0001_t".into())],
        body: br#"CREATE TABLE indexers (id serial PRIMARY KEY, name text NOT NULL);
                  CREATE TABLE indexer_stats (id serial PRIMARY KEY, "indexerId" int NOT NULL REFERENCES indexers(id), hits int NOT NULL DEFAULT 0);
                  INSERT INTO indexers (name) VALUES ('a'), ('b');
                  INSERT INTO indexer_stats ("indexerId", hits) VALUES (2, 5);"#
            .to_vec(),
        principal: fliks_server::plugins::Principal::Delegated(1),
    };
    rt.http(req.clone(), false).await.unwrap();
    let (_, doc) = h
        .call(
            "GET",
            "/api/plugins/fliks.fixture/export",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(
        doc["tables"]["indexers"],
        json!([{"id": 1, "name": "a"}, {"id": 2, "name": "b"}])
    );
    let (st, r) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/import",
            Some(&h.admin),
            Some(doc.clone()),
        )
        .await;
    assert_eq!(
        (st, r["code"].as_str()),
        (409, Some("PLUGIN_SCHEMA_NOT_EMPTY"))
    );
    req.body = b"DELETE FROM indexer_stats; DELETE FROM indexers;".to_vec();
    req.query = vec![("name".into(), "0002_empty".into())];
    rt.http(req, false).await.unwrap();
    let mut bad = doc.clone();
    bad["settings"] = json!({"plugin.other.key": "x"});
    let (st, r) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/import",
            Some(&h.admin),
            Some(bad),
        )
        .await;
    assert_eq!(
        (st, r["code"].as_str()),
        (400, Some("PLUGIN_EXPORT_SETTING_OUT_OF_SCOPE"))
    );
    let mut bad = doc.clone();
    bad["tables"]["nope"] = json!([]);
    assert_eq!(
        h.call(
            "POST",
            "/api/plugins/fliks.fixture/import",
            Some(&h.admin),
            Some(bad)
        )
        .await
        .1["code"],
        "PLUGIN_EXPORT_MALFORMED"
    );
    let mut bad = doc.clone();
    bad["tables"]["indexers"][0]["ghost"] = json!(1);
    assert_eq!(
        h.call(
            "POST",
            "/api/plugins/fliks.fixture/import",
            Some(&h.admin),
            Some(bad)
        )
        .await
        .1["code"],
        "PLUGIN_EXPORT_MALFORMED"
    );
    let empty: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM "plugin_fliks_fixture".indexers"#)
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(empty, 0, "no table written by a refused import");
    let mut ordered = doc.clone();
    let tables = ordered["tables"].as_object_mut().unwrap();
    let stats = tables.remove("indexer_stats").unwrap();
    tables.insert("indexer_stats".into(), stats);
    let (st, r) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/import",
            Some(&h.admin),
            Some(doc),
        )
        .await;
    assert_eq!(
        (st, r["tablesRestored"].clone()),
        (201, json!({"indexer_stats": 1, "indexers": 2})),
        "{r}"
    );
    let next: i32 = sqlx::query_scalar(
        r#"INSERT INTO "plugin_fliks_fixture".indexers (name) VALUES ('c') RETURNING id"#,
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(next, 3, "sequences set past the restored maximum");
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restore_stops_and_reregisters_plugins() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("restore").await else {
        return;
    };
    let h = harness(&s, "restore", |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    h.st.plugins.stop_all().await;
    assert!(
        h.st.plugins.rt("fliks.fixture").is_none(),
        "stopped before the replay"
    );
    h.st.plugins.after_restore(&[]).await;
    super::harness::until("registered again", Duration::from_secs(15), async || {
        h.st.plugins.state_of("fliks.fixture") == Some(fliks_server::plugins::runtime::State::Ready)
    })
    .await;
    h.finish().await;
    s.finish().await;
}

/// `progress.set` (rule 33): one emission per media per second, the newest of a window wins.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn progress_is_coalesced_per_media() {
    use fliks_server::events::{Bus, SseEvent};
    use fliks_server::plugins::runtime::fliks::plugin::types::{DownloadProgress, DownloadState};
    let Some(s) = Scratch::create("progress").await else {
        return;
    };
    let h = harness(&s, "progress", |_| {}).await;
    let mut rx = h.st.hub.subscribe();
    let d = |p: f64| DownloadProgress {
        ref_: "a".into(),
        season_number: None,
        episode_number: None,
        progress: p,
        bytes_per_second: None,
        eta_seconds: None,
        state: DownloadState::Active,
    };
    let gates = fliks_server::plugins::events::progress_gates();
    let media = 424_242;
    sqlx::query("INSERT INTO media (id, title, type) VALUES ($1, 'm', 'movie')")
        .bind(media)
        .execute(&h.st.db)
        .await
        .unwrap();
    let t = std::time::Instant::now();
    let seen = Arc::new(Mutex::new(vec![]));
    let sink = seen.clone();
    let collect = tokio::spawn(async move {
        while let Ok(bus) = rx.recv().await {
            if let Bus::Sse(SseEvent::DownloadProgress {
                media_id,
                downloads,
                ..
            }) = &*bus
                && *media_id == i64::from(media)
            {
                let v = serde_json::to_value(downloads).unwrap();
                let first = v.as_array().unwrap().first().map(|d| d["progress"].clone());
                sink.lock()
                    .unwrap()
                    .push((t.elapsed().as_millis() / 500, first));
            }
        }
    });
    for p in [0.1, 0.2, 0.3] {
        gates.set(&h.st, media, &[d(p)]).await;
    }
    tokio::time::sleep(Duration::from_millis(2500)).await;
    gates.set(&h.st, media, &[d(0.4)]).await;
    gates.set(&h.st, media, &[]).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    collect.abort();
    let seen = seen.lock().unwrap().clone();
    // Emitted at once, then the newest of the window after 1 s; the same after an idle gap.
    let at: Vec<_> = seen.iter().map(|(_, p)| p.clone()).collect();
    assert_eq!(
        at,
        vec![Some(json!(0.1)), Some(json!(0.3)), Some(json!(0.4)), None],
        "{seen:?}"
    );
    assert_eq!(
        seen.iter().map(|(t, _)| *t).collect::<Vec<_>>(),
        vec![0, 2, 5, 7],
        "{seen:?}"
    );
    h.finish().await;
    s.finish().await;
}

/// `releases.match` and `releases.score` (rule 34) against a seeded library.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn releases_match_and_score() {
    use fliks_server::plugins::acquisition;
    use fliks_server::plugins::runtime::fliks::plugin::types::{
        CandidateRelease, MatchDecision, ReleaseTitle, SkipReason,
    };
    let Some(s) = Scratch::create("releases").await else {
        return;
    };
    let h = harness(&s, "releases", |_| {}).await;
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name, "mediaTypes", path) VALUES (1, 'Movies', '["movie"]', '/nonexistent/m');
           INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'P', 18, '[]');
           INSERT INTO media (id, title, type, "libraryId", "folderName", year, monitored)
             VALUES (1, 'Big Buck Bunny', 'movie', 1, 'bbb', 2008, true),
                    (2, 'Sintel', 'movie', 1, 'sintel', 2010, true);
           INSERT INTO wants ("mediaId", family, "qualityProfileId") VALUES (1, 'video', 1), (2, 'video', NULL);
           INSERT INTO media_external_ids ("mediaId", kind, provider, value)
             VALUES (1, 'movie', 'tmdb', '10378'), (2, 'movie', 'tmdb', '45745');"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let title = |id: &str, t: &str, at: &str| ReleaseTitle {
        id: id.into(),
        title: t.into(),
        publish_date: at.into(),
    };
    let old = "2020-01-01T00:00:00Z";
    let now = chrono::Utc::now().to_rfc3339();
    let m = acquisition::matches(
        &h.st,
        vec![
            title("a", "Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP", old),
            title("b", "Sintel.2010.1080p.WEB-DL", old),
            title("c", "Nothing.Like.It.1999.720p.HDTV", old),
            title("d", "Big.Buck.Bunny.2008.720p.WEB-DL", &now),
        ],
        Some(60),
    )
    .await
    .unwrap();
    let got: Vec<_> = m
        .iter()
        .map(|r| (r.id.as_str(), r.media_id, r.decision, r.skip_reason))
        .collect();
    assert_eq!(
        got,
        vec![
            ("a", Some(1), MatchDecision::Grab, None),
            (
                "b",
                Some(2),
                MatchDecision::Skip,
                Some(SkipReason::Unprofiled)
            ),
            ("c", None, MatchDecision::Skip, Some(SkipReason::Unmatched)),
            (
                "d",
                Some(1),
                MatchDecision::Skip,
                Some(SkipReason::TooFresh)
            ),
        ]
    );
    let release = |id: &str, t: &str| CandidateRelease {
        id: id.into(),
        title: t.into(),
        size: 4 << 30,
        seeders: 10,
        leechers: 0,
        publish_date: old.into(),
        flags: None,
        freeleech: None,
        download_volume_factor: None,
        source_ref: "src".into(),
        min_seeders: None,
        unknown_language_iso_code: None,
        blocked: id == "y",
    };
    let scored = acquisition::score(
        &h.st,
        1,
        None,
        None,
        vec![
            release("x", "Big.Buck.Bunny.2008.1080p.BluRay.x264-GRP"),
            release("y", "Big.Buck.Bunny.2008.720p.WEB-DL"),
        ],
    )
    .await
    .unwrap();
    assert_eq!(scored.len(), 2);
    let y = scored.iter().find(|r| r.id == "y").unwrap();
    assert!(
        y.blocklisted && !y.rejections.is_empty(),
        "a blocked release is rejected"
    );
    assert!(
        scored.iter().all(|r| !r.allowed),
        "an empty profile allows no quality"
    );
    assert!(
        acquisition::score(&h.st, 999, None, None, vec![release("z", "x")])
            .await
            .unwrap()
            .is_empty()
    );
    h.finish().await;
    s.finish().await;
}

fn keys(v: &Value) -> Vec<&str> {
    let mut k: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    k.sort_unstable();
    k
}

/// The key sets the web client reads (`client/src/app/core/services/api/plugins-api.service.ts`,
/// `core/plugin-ui/plugin-ui-response.ts`) for shapes that need an installed plugin.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn installed_shapes_carry_the_client_keys() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("shapes").await else {
        return;
    };
    let h = harness(&s, "shapes", |_| {}).await;
    allow_unsigned(&h).await;
    let r = h.install(&pack(&m, "0.1.0", &w, None)).await;
    assert_eq!(keys(&r), ["pluginId", "status", "version"], "{r}");
    let summary = [
        "enabled",
        "kind",
        "name",
        "origin",
        "pluginId",
        "processState",
        "signature",
        "status",
        "statusMessage",
        "statusReason",
        "verifiedByKeyId",
        "version",
    ];
    let (_, list) = h.call("GET", "/api/plugins", Some(&h.admin), None).await;
    assert_eq!(keys(&list[0]), summary);
    let (_, d) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/disable",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(keys(&d), summary);
    let (_, e) = h
        .call(
            "POST",
            "/api/plugins/fliks.fixture/enable",
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(keys(&e), summary);
    let (_, metrics) = h
        .call("GET", "/api/plugins/metrics", Some(&h.admin), None)
        .await;
    assert_eq!(keys(&metrics[0]), ["kind", "metrics", "pluginId"]);
    assert_eq!(
        keys(&metrics[0]["metrics"]),
        [
            "eventDropCount",
            "hostCallCount",
            "hostCallFailureCount",
            "hostCallP95Ms",
            "residentSetSizeBytes",
            "restartCount"
        ]
    );
    let (_, ui) = h.call("GET", "/api/plugins/ui", Some(&h.admin), None).await;
    let entry = ui
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["pluginId"] == "fliks.fixture")
        .unwrap();
    for k in keys(entry) {
        assert!(
            [
                "configPages",
                "contributions",
                "i18n",
                "name",
                "pluginId",
                "releasePicker"
            ]
            .contains(&k),
            "{k}"
        );
    }
    assert!(entry["contributions"].is_array() && entry["configPages"].is_array());
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabled_plugins_never_refresh_the_catalog() {
    let Some(s) = Scratch::create("disabled_sources").await else {
        return;
    };
    let h = harness_with(&s, "disabled_sources", Arc::new(|_| {}), |o| {
        o.disabled = true
    })
    .await;
    // An http URL would record a refresh error if any refresh ran.
    sqlx::query("INSERT INTO plugin_sources (url) VALUES ('http://x/c.json')")
        .execute(&s.pool)
        .await
        .unwrap();
    fliks_server::plugins::sources::refresh_all(&h.st, false).await;
    fliks_server::plugins::sources::refresh_and_update(&h.st)
        .await
        .unwrap();
    let (at, err): (Option<chrono::DateTime<chrono::Utc>>, Option<String>) =
        sqlx::query_as(r#"SELECT "lastRefreshedAt", "lastRefreshError" FROM plugin_sources"#)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!((at, err), (None, None));
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn signature_and_signer_gates() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("signer").await else {
        return;
    };
    let h = harness(&s, "signer", |_| {}).await;
    let stranger = SigningKey::from_bytes(&[9u8; 32]);
    let (_, r) = h.upload(&pack(&m, "0.1.0", &w, Some(&stranger))).await;
    assert_eq!(
        r["refusalCode"], "PLUGIN_UNSIGNED",
        "a signature no trusted key verifies: {r}"
    );
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, Some(&test_key()))).await["status"],
        "active"
    );
    allow_unsigned(&h).await;
    let (_, r) = h.upload(&pack(&m, "0.1.0", &w, None)).await;
    let (st, c) = h
        .call(
            "POST",
            "/api/plugins/import/confirm",
            Some(&h.admin),
            Some(json!({"stagingId": r["stagingId"], "sha256": r["sha256"]})),
        )
        .await;
    assert_eq!(
        (st, c["code"].as_str()),
        (409, Some("PLUGIN_SIGNER_CHANGED")),
        "{c}"
    );
    let r = h.install(&pack(&m, "0.1.0", &w, Some(&test_key()))).await;
    assert_eq!(r["status"], "active", "{r}");
    s.finish().await;
}

/// B3 and B4: an unattended upgrade that fails to activate is rolled back and held, one that asks for
/// new scopes is held, and an admin's confirm of it grants them.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn auto_update_rolls_back_and_holds_new_scopes() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("autoupd").await else {
        return;
    };
    let cat = catalog().await;
    let ca = cat.ca.clone();
    let h = harness_with(&s, "autoupd", Arc::new(|_| {}), move |o| {
        o.fetch = Fetcher {
            net: StubNet::new(1, tokio_rustls::rustls::RootCertStore::empty(), &[]),
            roots: vec![ca.clone()],
        };
    })
    .await;
    let url = format!("https://localhost:{}/catalog.json", cat.port);
    let key =
        base64::engine::general_purpose::STANDARD.encode(test_key().verifying_key().to_bytes());
    let (_, src) = h
        .call(
            "POST",
            "/api/plugins/sources",
            Some(&h.admin),
            Some(json!({"url": url, "publicKey": key})),
        )
        .await;
    let id = src["id"].as_i64().unwrap();
    let mut small = m.clone();
    small["scopes"] = json!(["config:rw"]);
    assert_eq!(
        h.install(&pack(&small, "0.1.0", &w, Some(&test_key())))
            .await["status"],
        "active"
    );
    let offer = async |mf: &Value, version: &str, wasm: &[u8]| {
        let bytes = pack(mf, version, wasm, Some(&test_key()));
        let path = format!("/fixture-{version}.fkplugin");
        {
            let mut a = cat.archives.lock().unwrap();
            a.retain(|(p, _)| *p != path);
            a.push((path.clone(), bytes.clone()));
        }
        let doc = json!({"plugins": [{"id": "fliks.fixture", "name": "Fixture", "description": "", "author": "a",
            "kind": "process", "versions": [{"version": version, "pluginApi": 2, "fliks": ">=5.0.0 <6.0.0",
            "zipUrl": format!("https://localhost:{}{path}", cat.port), "sha256": archive::sha256_hex(&bytes)}]}]});
        *cat.doc.lock().unwrap() = serde_json::to_vec(&doc).unwrap();
        h.call(
            "POST",
            &format!("/api/plugins/sources/{id}/refresh"),
            Some(&h.admin),
            None,
        )
        .await;
        bytes
    };
    let installed = async || {
        packages::find(&s.pool, "fliks.fixture")
            .await
            .unwrap()
            .unwrap()
    };
    // The fixture guest only activates as 0.1.0, so the installed row is aged to look older.
    let age = async |keep_hold: bool| {
        let q = if keep_hold {
            r#"UPDATE plugin_packages SET version = '0.0.9'"#
        } else {
            r#"UPDATE plugin_packages SET version = '0.0.9', "heldUpdate" = NULL"#
        };
        sqlx::query(q).execute(&s.pool).await.unwrap();
    };
    age(true).await;
    let mut broken = small.clone();
    broken["routes"][0]["method"] = json!("NOPE");
    offer(&broken, "0.1.0", &w).await;
    let out = h.st.plugins.auto_update().await;
    assert_eq!(out["updated"], json!([]), "{out}");
    let p = installed().await;
    assert_eq!(p.status, "active", "{out}");
    let held = p.held_update.clone().unwrap_or_else(|| panic!("{out}"));
    assert_eq!(held["reason"], "failed");
    assert!(
        h.st.plugins.rt("fliks.fixture").is_some(),
        "the old archive runs again"
    );
    age(true).await;
    let again = h.st.plugins.auto_update().await;
    assert!(
        again["skipped"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("failed to activate"),
        "{again}"
    );
    // A newer version would carry another number than the held one.
    age(false).await;
    let full = offer(&m, "0.1.0", &w).await;
    sqlx::query("ALTER TABLE plugin_registrations RENAME TO plugin_registrations_away")
        .execute(&s.pool)
        .await
        .unwrap();
    let out = h.st.plugins.auto_update().await;
    sqlx::query("ALTER TABLE plugin_registrations_away RENAME TO plugin_registrations")
        .execute(&s.pool)
        .await
        .unwrap();
    assert_eq!(
        out["updated"],
        json!([]),
        "an unreadable grant never installs: {out}"
    );
    assert_eq!(
        out["skipped"][0]["reason"], "the granted scopes could not be read",
        "{out}"
    );
    assert_eq!(installed().await.version, "0.0.9");
    let out = h.st.plugins.auto_update().await;
    assert!(
        out["skipped"][0]["reason"]
            .as_str()
            .unwrap()
            .contains("media:read"),
        "{out}"
    );
    let p = installed().await;
    assert_eq!(p.version, "0.0.9");
    assert_eq!(p.held_update.unwrap()["reason"], "new-scopes");
    let r = h.install(&full).await;
    assert_eq!(r["status"], "active", "{r}");
    let p = installed().await;
    assert!(p.held_update.is_none());
    let scopes = packages::granted_scopes(&s.pool, "fliks.fixture")
        .await
        .unwrap()
        .unwrap();
    assert!(scopes.iter().any(|x| x == "media:read"));
    h.finish().await;
    s.finish().await;
}

/// Rule 29: a plugin that fails registration at boot is auto-updated at once, not at 03:00.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_registration_at_boot_updates_at_once() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("bootupd").await else {
        return;
    };
    let cat = catalog().await;
    let ca = cat.ca.clone();
    let h = harness_with(&s, "bootupd", Arc::new(|_| {}), move |o| {
        o.fetch = Fetcher {
            net: StubNet::new(1, tokio_rustls::rustls::RootCertStore::empty(), &[]),
            roots: vec![ca.clone()],
        };
    })
    .await;
    let key =
        base64::engine::general_purpose::STANDARD.encode(test_key().verifying_key().to_bytes());
    let bytes = pack(&m, "0.1.0", &w, Some(&test_key()));
    cat.archives
        .lock()
        .unwrap()
        .push(("/fixture.fkplugin".into(), bytes.clone()));
    let doc = json!({"plugins": [{"id": "fliks.fixture", "name": "Fixture", "description": "", "author": "a",
        "kind": "process", "versions": [{"version": "0.1.0", "pluginApi": 2, "fliks": ">=5.0.0 <6.0.0",
        "zipUrl": format!("https://localhost:{}/fixture.fkplugin", cat.port), "sha256": archive::sha256_hex(&bytes)}]}]});
    *cat.doc.lock().unwrap() = serde_json::to_vec(&doc).unwrap();
    let url = format!("https://localhost:{}/catalog.json", cat.port);
    h.call(
        "POST",
        "/api/plugins/sources",
        Some(&h.admin),
        Some(json!({"url": url, "publicKey": key})),
    )
    .await;
    assert_eq!(h.install(&bytes).await["status"], "active");
    sqlx::query(
        r#"UPDATE plugin_packages SET version = '0.0.9',
           manifest = jsonb_set(manifest, '{fliks}', '">=99.0.0"')"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    h.st.plugins.stop_all().await;
    h.st.plugins.boot().await;
    super::harness::until("updated after boot", Duration::from_secs(30), async || {
        let p = packages::find(&s.pool, "fliks.fixture")
            .await
            .unwrap()
            .unwrap();
        p.version == "0.1.0" && p.status == "active" && h.st.plugins.rt("fliks.fixture").is_some()
    })
    .await;
    h.finish().await;
    s.finish().await;
}

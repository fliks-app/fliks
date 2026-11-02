//! Registration of the `provider` block (`provider-plugins.md` rules 1, 2, 20).
use super::harness::*;
use serde_json::{Value, json};

fn provider() -> Option<(Value, Vec<u8>)> {
    Some((template("fixture-provider"), wasm("fixture_provider")?))
}

async fn outcome(tag: &str, signed: bool, m: &Value, w: &[u8]) -> Option<(Option<String>, Value)> {
    let s = Scratch::create(tag).await?;
    let h = harness(&s, tag, |_| {}).await;
    allow_unsigned(&h).await;
    let key = test_key();
    let r = h
        .install(&pack(m, "0.1.0", w, signed.then_some(&key)))
        .await;
    let reason = r["reason"].as_str().map(str::to_owned);
    h.finish().await;
    s.finish().await;
    Some((reason, r))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn namespaces_are_checked_at_registration() {
    let Some((m, w)) = provider() else { return };
    let with = |name: &str| {
        let mut m = m.clone();
        m["provider"]["namespaces"] = json!([{"name": name}]);
        m
    };
    let cases = [
        ("tmdb", false, Some("core-namespace-not-official")),
        ("foo", true, Some("unknown-provider-namespace")),
        ("org.example.other:aid", false, Some("namespace-not-owned")),
        ("tmdb", true, None),
    ];
    for (i, (name, signed, want)) in cases.into_iter().enumerate() {
        let mut m = with(name);
        if name.contains(':') {
            m["provider"]["namespaces"][0]["label"] = json!("X");
            m["provider"]["namespaces"][0]["idPattern"] = json!("^.+$");
        }
        let Some((reason, r)) = outcome(&format!("ns{i}"), signed, &m, &w).await else {
            return;
        };
        assert_eq!(reason.as_deref(), want, "{name}: {r}");
        assert_eq!(
            r["status"],
            if want.is_some() { "failed" } else { "active" }
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_block_and_the_export_come_together() {
    let Some((m, w)) = provider() else { return };
    let Some((g, gw)) = fixture() else { return };
    // The export without the block.
    let mut bare = m.clone();
    bare.as_object_mut().unwrap().remove("provider");
    bare["scopes"] = json!(["config:rw"]);
    // The block without the export.
    let mut blocked = g.clone();
    blocked["provider"] = m["provider"].clone();
    blocked["database"] = m["database"].clone();
    blocked["provider"]["namespaces"][0]["name"] = json!("fliks.fixture:aid");
    for (tag, m, w) in [("noblock", &bare, &w), ("noexport", &blocked, &gw)] {
        let Some((reason, r)) = outcome(tag, false, m, w).await else {
            return;
        };
        assert_eq!(reason.as_deref(), Some("invalid-component"), "{tag}: {r}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn config_get_needs_no_scope_for_a_provider() {
    let Some((m, w)) = provider() else { return };
    let Some(s) = Scratch::create("provcfg").await else {
        return;
    };
    let h = harness(&s, "provcfg", |_| {}).await;
    allow_unsigned(&h).await;
    h.set("plugin.org.example.anime.mine", "ours").await;
    h.set("plugin.fliks.other.theirs", "no").await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let rt = h.st.plugins.rt("org.example.anime").unwrap();
    let r = rt
        .http(
            fliks_server::plugins::HttpRequest {
                method: "GET".into(),
                path: "/config".into(),
                query: vec![],
                body: vec![],
                principal: fliks_server::plugins::Principal::Delegated(1),
            },
            false,
        )
        .await
        .unwrap();
    let got: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(got, json!({"mine": "ours"}), "{got}");
    h.finish().await;
    s.finish().await;
}

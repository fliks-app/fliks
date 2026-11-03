//! The provider plugin as a `MetadataProvider` (`provider-plugins.md` rules 14, 15, 41-43, 48).
use super::harness::*;
use fliks_domain::{
    external_id::Namespace as Ns,
    media::kind::MediaKind,
    metadata::{language::Resolved, limiter::Priority},
};
use fliks_server::metadata::{Search, Upstream};
use fliks_server::plugins::runtime::{HostConfig, State};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;

const ID: &str = "org.example.anime";
const GO: Priority = Priority::Interactive;

/// The fixture installed signed under the core namespace `tmdb`, `edit` applied to its manifest.
async fn up(
    tag: &str,
    tune: impl Fn(&mut HostConfig) + Send + Sync + 'static,
    edit: impl FnOnce(&mut Value),
) -> Option<(Scratch, H, Resolved)> {
    let mut m = template("fixture-provider");
    let w = wasm("fixture_provider")?;
    m["provider"]["namespaces"] = json!([{"name": "tmdb"}]);
    m["provider"]["kinds"] = json!({"series": ["search", "work", "children", "findBy"]});
    edit(&mut m);
    let s = Scratch::create(tag).await?;
    let h = harness(&s, tag, tune).await;
    allow_unsigned(&h).await;
    let r = h.install(&pack(&m, "0.1.0", &w, Some(&test_key()))).await;
    assert_eq!(r["status"], "active", "{r}");
    let lang = h.st.metadata.lang.resolve(None).await.unwrap();
    Some((s, h, lang))
}

async fn until(mut ok: impl FnMut() -> bool) {
    for _ in 0..250 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out");
}

async fn work(h: &H, kind: MediaKind, id: &str, lang: &Resolved) -> Result<Value, Upstream> {
    let p = h.st.metadata.of(Ns::TMDB);
    p.fetch_work(kind, id, lang, GO).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_provider_plugin_answers_through_the_trait() {
    let Some((s, h, lang)) = up("pvtrait", |_| {}, |_| {}).await else {
        return;
    };
    let md = &h.st.metadata;
    let p = md.of(Ns::TMDB);
    assert!(md.available(Ns::TMDB), "the plugin registers its namespace");
    assert!(p.supports(MediaKind::Series) && !p.supports(MediaKind::Movie));
    assert!(!p.has_persons());
    assert_eq!(p.limits().burst, 2);
    assert_eq!(p.snapshot_ttl("work"), Some(Duration::ZERO));
    let q = Search::text(MediaKind::Series, "q", None);
    let found = p.search(&q, &lang, GO).await.unwrap();
    assert_eq!(found[0]["title"], "q");
    let w = work(&h, MediaKind::Series, "1", &lang).await.unwrap();
    assert_eq!(w["language"], lang.tmdb_locale.as_str());
    for (kind, id) in [(MediaKind::Series, "2"), (MediaKind::Movie, "1")] {
        let e = work(&h, kind, id, &lang).await.unwrap_err();
        assert_eq!(e.status, Some(404), "{id}");
    }
    let kids = p
        .fetch_children(MediaKind::Series, "1", &lang, GO)
        .await
        .unwrap();
    assert_eq!(kids.len(), 1);
    let by = |source, id| p.find_by(source, id, &lang, GO);
    assert_eq!(
        by(Ns::IMDB, "tt1").await.unwrap(),
        Some(("1".into(), MediaKind::Series))
    );
    assert_eq!(by(Ns::IMDB, "tt2").await.unwrap(), None);
    assert_eq!(
        by(Ns::ISBN, "tt1").await.unwrap(),
        None,
        "not a declared input"
    );
    assert_eq!(
        by(Ns::IMDB, "tt3").await.unwrap(),
        None,
        "an id of another namespace than the key"
    );
    let bad = Search::text(MediaKind::Series, "scalars", None);
    let e = p.search(&bad, &lang, GO).await.unwrap_err();
    assert_eq!(e.status, Some(502), "a list of non-objects");
    let e = p.fetch_person("1", &lang, GO).await.unwrap_err();
    assert_eq!(e.status, Some(404), "undeclared call");
    assert_eq!(md.resolve(None, MediaKind::Series), Some(Ns::TMDB));
    assert_eq!(md.resolve(Some("tvdb"), MediaKind::Series), Some(Ns::TMDB));
    assert_eq!(md.resolve(None, MediaKind::Movie), None);
    assert_eq!(md.fallback(Ns::TMDB, MediaKind::Series), None);
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn answers_are_validated_and_errors_mapped() {
    let edit = |m: &mut Value| m["memoryMb"] = json!(128);
    let Some((s, h, lang)) = up("pverr", |_| {}, edit).await else {
        return;
    };
    for (id, status) in [
        ("not-json", Some(502)),
        ("array", Some(502)),
        ("huge", Some(502)),
        ("unsupported", Some(404)),
        ("limited", Some(429)),
        ("upstream", Some(503)),
        ("trap", None),
    ] {
        let e = work(&h, MediaKind::Series, id, &lang).await.unwrap_err();
        assert_eq!(e.status, status, "{id}: {}", e.reason());
    }
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unauthorized_withdraws_the_provider_until_its_settings_change() {
    let Some((s, h, lang)) = up("pvauth", |_| {}, |_| {}).await else {
        return;
    };
    let e = work(&h, MediaKind::Series, "unauthorized", &lang)
        .await
        .unwrap_err();
    assert_eq!(e.status, Some(401));
    assert!(!h.st.metadata.available(Ns::TMDB));
    h.set(&format!("plugin.{ID}.token"), "new").await;
    until(|| h.st.metadata.available(Ns::TMDB)).await;
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_provider_is_available_once_its_required_keys_resolve() {
    let edit = |m: &mut Value| m["provider"]["requires"] = json!(["apiKey"]);
    let Some((s, h, _)) = up("pvreq", |_| {}, edit).await else {
        return;
    };
    let md = &h.st.metadata;
    let key = format!("plugin.{ID}.apiKey");
    assert!(!md.available(Ns::TMDB));
    h.set(&key, "k").await;
    until(|| md.available(Ns::TMDB)).await;
    h.set(&key, "").await;
    until(|| !md.available(Ns::TMDB)).await;
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_order_setting_picks_the_providers_of_a_kind() {
    let Some((s, h, _)) = up("pvord", |_| {}, |_| {}).await else {
        return;
    };
    let md = &h.st.metadata;
    let series = MediaKind::Series;
    assert_eq!(md.order(series), [Ns::TMDB, Ns::TVDB]);
    h.set(
        "metadata.provider_order.series",
        r#"["tvdb","nope","tmdb","tvdb"]"#,
    )
    .await;
    assert_eq!(md.order(series), [Ns::TVDB, Ns::TMDB]);
    assert_eq!(md.resolve(None, series), Some(Ns::TMDB), "tvdb has no key");
    h.set("metadata.provider_order.series", r#"["tvdb"]"#).await;
    assert_eq!(
        md.resolve(None, series),
        None,
        "absent from the order is skipped"
    );
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bundled_provider_registers_again_after_the_breaker() {
    let tune = |c: &mut HostConfig| {
        c.breaker_crashes = 2;
        c.provider_retry = (Duration::from_millis(100), Duration::from_millis(100));
    };
    let Some((s, h, _)) = up("pvbrk", tune, |_| {}).await else {
        return;
    };
    sqlx::query(r#"UPDATE plugin_packages SET origin = 'bundled' WHERE "pluginId" = $1"#)
        .bind(ID)
        .execute(&s.pool)
        .await
        .unwrap();
    let pkg = fliks_server::plugins::packages::find(&s.pool, ID)
        .await
        .unwrap()
        .unwrap();
    h.st.plugins.register_and_settle(&pkg).await.unwrap();
    let rt = h.st.plugins.rt(ID).unwrap();
    for _ in 0..2 {
        rt.crash(&rt.core, "test");
    }
    assert_eq!(rt.state(), State::Failed);
    assert!(!h.st.metadata.available(Ns::TMDB));
    until(|| {
        h.st.plugins
            .rt(ID)
            .is_some_and(|r| !Arc::ptr_eq(&r, &rt) && r.state() == State::Ready)
            && h.st.metadata.available(Ns::TMDB)
    })
    .await;
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_unauthorized_does_not_withdraw_the_provider_after_new_settings() {
    let Some((s, h, lang)) = up("pvstale", |_| {}, |_| {}).await else {
        return;
    };
    let md = &h.st.metadata;
    let p = md.of(Ns::TMDB);
    let call = {
        let lang = lang.clone();
        tokio::spawn(async move {
            p.fetch_work(MediaKind::Series, "slow-unauthorized", &lang, GO)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(300)).await;
    h.set(&format!("plugin.{ID}.token"), "new").await;
    let e = call.await.unwrap().unwrap_err();
    assert_eq!(e.status, Some(401));
    assert!(md.available(Ns::TMDB), "the 401 answered the old key");
    let e = work(&h, MediaKind::Series, "unauthorized", &lang)
        .await
        .unwrap_err();
    assert_eq!(e.status, Some(401));
    assert!(!md.available(Ns::TMDB), "a 401 under the new key counts");
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn id_reads_stay_in_the_named_namespace() {
    let Some((s, h, lang)) = up("pvnamed", |_| {}, |_| {}).await else {
        return;
    };
    let md = &h.st.metadata;
    assert_eq!(md.require(None).unwrap(), Ns::TMDB);
    assert_eq!(md.named(Some("tvdb")), None, "tvdb has no key");
    let e = work(&h, MediaKind::Series, "unauthorized", &lang)
        .await
        .unwrap_err();
    assert_eq!(e.status, Some(401));
    let e = md.require(None).unwrap_err();
    assert_eq!(
        e.status().as_u16(),
        503,
        "an unavailable TMDB is not swapped for another namespace"
    );
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_undeclared_find_by_answers_none() {
    let edit = |m: &mut Value| m["provider"]["kinds"] = json!({"series": ["search", "work"]});
    let Some((s, h, lang)) = up("pvnofind", |_| {}, edit).await else {
        return;
    };
    let p = h.st.metadata.of(Ns::TMDB);
    assert_eq!(p.find_by(Ns::IMDB, "tt1", &lang, GO).await.unwrap(), None);
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_calls_leave_an_instance_to_an_interactive_one() {
    let Some((s, h, lang)) = up("pvbg", |_| {}, |_| {}).await else {
        return;
    };
    let p = h.st.metadata.of(Ns::TMDB);
    let bg: Vec<_> = (0..8)
        .map(|_| {
            let (p, lang) = (p.clone(), lang.clone());
            tokio::spawn(async move {
                p.fetch_work(MediaKind::Series, "slow", &lang, Priority::Background)
                    .await
            })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let t = std::time::Instant::now();
    p.fetch_work(MediaKind::Series, "1", &lang, GO)
        .await
        .unwrap();
    assert!(
        t.elapsed() < Duration::from_millis(600),
        "{:?}",
        t.elapsed()
    );
    for b in bg {
        b.await.unwrap().unwrap();
    }
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lists_go_through_the_plugin_and_are_validated() {
    let edit = |m: &mut Value| m["provider"]["kinds"]["series"] = json!(["lists"]);
    let Some((s, h, lang)) = up("pvlist", |_| {}, edit).await else {
        return;
    };
    let md = &h.st.metadata;
    let tv = MediaKind::Series;
    let list = |kind, name: &'static str, params: &[(&str, &str)]| {
        let params: Vec<_> = params
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let lang = lang.clone();
        async move {
            let id = md
                .lister(kind)
                .ok_or_else(|| (Ns::TMDB, Upstream::new(Some(404), "no lister")))?;
            md.list(id, kind, name, &params, &lang, GO).await
        }
    };
    assert_eq!(md.lister(tv), Some(Ns::TMDB));
    let got = list(tv, "trending", &[("window", "day")]).await.unwrap();
    assert_eq!(got[0]["title"], format!("series:day:{}", lang.tmdb_locale));
    let got = list(tv, "discover", &[("genres", "28,12"), ("yearGte", "1999")])
        .await
        .unwrap();
    assert_eq!(
        got[0]["title"],
        r#"[("genres", "28,12"), ("yearGte", "1999")]"#
    );
    assert_eq!(list(tv, "genres", &[]).await.unwrap()[0]["name"], "Action");
    for name in ["popular", "upcoming"] {
        let (id, e) = list(tv, name, &[]).await.unwrap_err();
        assert_eq!(
            (id, e.status),
            (Ns::TMDB, Some(502)),
            "{name}: a malformed list"
        );
    }
    let (_, e) = list(MediaKind::Movie, "trending", &[]).await.unwrap_err();
    assert_eq!(e.status, Some(404), "undeclared for the kind");

    let (st, body) = h
        .call(
            "GET",
            "/api/metadata/trending/tv?window=day",
            Some(&h.user),
            None,
        )
        .await;
    assert_eq!(st, 200, "{body}");
    assert_eq!(body[0]["title"], format!("series:day:{}", lang.tmdb_locale));
    assert_eq!(body[0]["existingMediaId"], Value::Null);
    let (st, _) = h
        .call("GET", "/api/metadata/popular/tv", Some(&h.user), None)
        .await;
    assert_eq!(st, 503);
    h.finish().await;
    s.finish().await;
}

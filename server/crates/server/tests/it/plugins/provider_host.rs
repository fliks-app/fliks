//! The provider plugin as a `MetadataProvider` (`provider-plugins.md` rules 14, 15, 41-43, 48).
use super::harness::*;
use fliks_domain::{
    external_id::ExternalProvider as Ns,
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
    let p = h.st.metadata.of(Ns::Tmdb);
    p.fetch_work(kind, id, lang, GO).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_provider_plugin_answers_through_the_trait() {
    let Some((s, h, lang)) = up("pvtrait", |_| {}, |_| {}).await else {
        return;
    };
    let md = &h.st.metadata;
    let p = md.of(Ns::Tmdb);
    assert!(
        md.available(Ns::Tmdb),
        "the plugin shadows the keyless built-in"
    );
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
        by(Ns::Imdb, "tt1").await.unwrap(),
        Some(("1".into(), MediaKind::Series))
    );
    assert_eq!(by(Ns::Imdb, "tt2").await.unwrap(), None);
    assert_eq!(
        by(Ns::Isbn, "tt1").await.unwrap(),
        None,
        "not a declared input"
    );
    let e = p.fetch_person("1", &lang, GO).await.unwrap_err();
    assert_eq!(e.status, Some(404), "undeclared call");
    assert_eq!(md.resolve(None, MediaKind::Series), Some(Ns::Tmdb));
    assert_eq!(md.resolve(Some("tvdb"), MediaKind::Series), Some(Ns::Tmdb));
    assert_eq!(md.resolve(None, MediaKind::Movie), None);
    assert_eq!(md.fallback(Ns::Tmdb, MediaKind::Series), None);
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
    assert!(!h.st.metadata.available(Ns::Tmdb));
    h.set(&format!("plugin.{ID}.token"), "new").await;
    until(|| h.st.metadata.available(Ns::Tmdb)).await;
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
    assert!(!md.available(Ns::Tmdb));
    h.set(&key, "k").await;
    until(|| md.available(Ns::Tmdb)).await;
    h.set(&key, "").await;
    until(|| !md.available(Ns::Tmdb)).await;
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
    assert_eq!(md.order(series), [Ns::Tmdb, Ns::Tvdb]);
    h.set(
        "metadata.provider_order.series",
        r#"["tvdb","nope","tmdb","tvdb"]"#,
    )
    .await;
    assert_eq!(md.order(series), [Ns::Tvdb, Ns::Tmdb]);
    assert_eq!(md.resolve(None, series), Some(Ns::Tmdb), "tvdb has no key");
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
    sqlx::query("ALTER TYPE plugin_packages_origin_enum ADD VALUE IF NOT EXISTS 'bundled'")
        .execute(&s.pool)
        .await
        .unwrap();
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
    assert!(!h.st.metadata.available(Ns::Tmdb));
    until(|| {
        h.st.plugins
            .rt(ID)
            .is_some_and(|r| !Arc::ptr_eq(&r, &rt) && r.state() == State::Ready)
            && h.st.metadata.available(Ns::Tmdb)
    })
    .await;
    h.finish().await;
    s.finish().await;
}

//! Bundled archives: installed at boot, never downgraded, never uninstalled.
use super::harness::*;
use fliks_server::plugins::{bundled::Archive, packages};
use serde_json::Value;
use std::sync::Arc;

fn leak(b: Vec<u8>) -> &'static [u8] {
    Box::leak(b.into_boxed_slice())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bundled_archives_install_upgrade_and_resist_delete() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("bundled").await else {
        return;
    };
    let h = harness(&s, "bundled", |_| {}).await;
    let id: &'static str = Box::leak(m["id"].as_str().unwrap().to_owned().into_boxed_str());
    let key = test_key();
    let archive = |v: &'static str| -> Archive { (id, v, leak(pack(&m, v, &w, Some(&key)))) };
    let version = || async {
        packages::find(&s.pool, id)
            .await
            .unwrap()
            .map(|p| (p.version, p.origin))
    };
    h.st.plugins.install_archives(&[archive("1.0.0")]).await;
    assert_eq!(version().await, Some(("1.0.0".into(), "bundled".into())));
    h.st.plugins.install_archives(&[archive("0.9.0")]).await;
    assert_eq!(version().await.unwrap().0, "1.0.0", "no downgrade");
    h.st.plugins.install_archives(&[archive("1.1.0")]).await;
    assert_eq!(version().await.unwrap().0, "1.1.0");
    let (st, r) = h
        .call(
            "DELETE",
            &format!("/api/plugins/{id}"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!((st, r["code"].as_str()), (409, Some("PLUGIN_BUNDLED")));
    assert!(version().await.is_some());
    h.finish().await;
    s.finish().await;
}

async fn setup(tag: &str, disabled: bool) -> Option<(Scratch, H, Value, Vec<u8>)> {
    let (m, w) = fixture()?;
    let s = Scratch::create(tag).await?;
    let h = harness_with(&s, tag, Arc::new(|_| {}), |o| o.disabled = disabled).await;
    Some((s, h, m, w))
}

async fn row(s: &Scratch, id: &str) -> (String, String, String) {
    let p = packages::find(&s.pool, id).await.unwrap().unwrap();
    (p.version, p.origin, p.status)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_version_twice_is_a_no_op() {
    let Some((s, h, m, w)) = setup("bundled_twice", false).await else {
        return;
    };
    let id: &'static str = Box::leak(m["id"].as_str().unwrap().to_owned().into_boxed_str());
    let a: Archive = (id, "1.0.0", leak(pack(&m, "1.0.0", &w, Some(&test_key()))));
    h.st.plugins.install_archives(&[a]).await;
    let at = |s: &Scratch| {
        let db = s.pool.clone();
        async move {
            sqlx::query_scalar::<_, chrono::DateTime<chrono::Utc>>(
                r#"SELECT "updatedAt" FROM plugin_packages WHERE "pluginId" = $1"#,
            )
            .bind(id)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    let first = at(&s).await;
    h.st.plugins.install_archives(&[a]).await;
    assert_eq!(first, at(&s).await);
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabled_env_still_loads_bundled() {
    let Some((s, h, m, w)) = setup("bundled_disabled", true).await else {
        return;
    };
    let id: &'static str = Box::leak(m["id"].as_str().unwrap().to_owned().into_boxed_str());
    h.st.plugins
        .install_archives(&[(id, "1.0.0", leak(pack(&m, "1.0.0", &w, Some(&test_key()))))])
        .await;
    h.st.plugins.boot().await;
    assert_eq!(row(&s, id).await.2, "active");
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn catalog_update_keeps_the_bundled_origin() {
    let Some((s, h, m, w)) = setup("bundled_update", false).await else {
        return;
    };
    let id: &'static str = Box::leak(m["id"].as_str().unwrap().to_owned().into_boxed_str());
    let key = test_key();
    h.st.plugins
        .install_archives(&[(id, "1.0.0", leak(pack(&m, "1.0.0", &w, Some(&key))))])
        .await;
    h.install(&pack(&m, "1.2.0", &w, Some(&key))).await;
    assert_eq!(row(&s, id).await.0, "1.2.0");
    assert_eq!(row(&s, id).await.1, "bundled");
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_newer_installed_row_becomes_bundled() {
    let Some((s, h, m, w)) = setup("bundled_adopt", false).await else {
        return;
    };
    let id: &'static str = Box::leak(m["id"].as_str().unwrap().to_owned().into_boxed_str());
    let key = test_key();
    h.install(&pack(&m, "2.0.0", &w, Some(&key))).await;
    assert_ne!(row(&s, id).await.1, "bundled");
    h.st.plugins
        .install_archives(&[(id, "1.0.0", leak(pack(&m, "1.0.0", &w, Some(&key))))])
        .await;
    assert_eq!(row(&s, id).await.1, "bundled");
    let (st, r) = h
        .call(
            "DELETE",
            &format!("/api/plugins/{id}"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!((st, r["code"].as_str()), (409, Some("PLUGIN_BUNDLED")));
    h.finish().await;
    s.finish().await;
}

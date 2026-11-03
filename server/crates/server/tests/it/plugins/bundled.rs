//! Bundled archives: installed at boot, never downgraded, never uninstalled.
use super::harness::*;
use fliks_server::plugins::{bundled::Archive, packages};

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

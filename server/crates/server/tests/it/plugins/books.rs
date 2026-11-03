//! The audio and text families on the host calls (`plugins.md` rules 31-33): the grants they need
//! and a book acquired end to end through the fixture.
use super::harness::*;
use serde_json::{Value, json};

/// One call of the fixture's `/test/<route>`, answered as JSON.
async fn call(h: &H, route: &str, q: &[(&str, &str)]) -> Value {
    let rt = h.st.plugins.rt("fliks.fixture").unwrap();
    let r = rt
        .http(
            fliks_server::plugins::HttpRequest {
                method: "GET".into(),
                path: format!("/test/{route}"),
                query: q.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
                body: vec![],
                principal: fliks_server::plugins::Principal::Delegated(1),
            },
            false,
        )
        .await
        .unwrap();
    serde_json::from_slice(&r.body).unwrap()
}

/// The fixture installed with `scopes`.
async fn install(tag: &str, scopes: Value) -> Option<(H, Scratch)> {
    let (mut m, w) = fixture()?;
    let s = Scratch::create(tag).await?;
    let h = harness(&s, tag, |_| {}).await;
    allow_unsigned(&h).await;
    m["scopes"] = scopes;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    Some((h, s))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_book_call_needs_the_grant_of_its_method() {
    let Some((h, s)) = install("books_denied", json!(["config:rw"])).await else {
        return;
    };
    for (route, scope) in [
        ("context", "media:read"),
        ("score", "releases:score"),
        ("ingest", "ingest:write"),
        ("grabbed", "events:emit"),
    ] {
        let r = call(&h, route, &[("family", "text")]).await;
        assert_eq!(r["error"], "ERR_DENIED", "{route}: {r}");
        assert!(r["message"].as_str().unwrap().contains(scope), "{r}");
    }
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_with_acquisition_grants_only_acquires_a_book() {
    let grants = json!([
        "config:rw",
        "media:read",
        "acquisition:candidates",
        "releases:score",
        "ingest:write",
        "events:emit"
    ]);
    let Some((h, s)) = install("books_acquire", grants).await else {
        return;
    };
    let dir = std::env::temp_dir().join(format!(
        "fliks-books-{}",
        fliks_server::config::random_hex(4)
    ));
    let (library, dl) = (dir.join("books"), dir.join("dl"));
    for d in [&library, &dl] {
        std::fs::create_dir_all(d).unwrap();
    }
    std::fs::write(dl.join("Mirelune.epub"), b"book").unwrap();
    sqlx::query(
        r#"WITH l AS (INSERT INTO libraries (name, "mediaTypes") VALUES ('B', '["book"]') RETURNING id),
                f AS (INSERT INTO library_folders ("libraryId", path) SELECT id, $1 FROM l)
           INSERT INTO media (id, title, type, "libraryId", "folderName", monitored)
             SELECT 1, 'Mirelune', 'book', id, 'Mirelune', true FROM l"#,
    )
    .bind(library.to_string_lossy().as_ref())
    .execute(&s.pool)
    .await
    .unwrap();
    let mut c = s.pool.acquire().await.unwrap();
    fliks_server::media::items::create_shell(
        &mut c,
        1,
        fliks_domain::media::kind::MediaKind::Book,
        Default::default(),
    )
    .await
    .unwrap();
    drop(c);
    sqlx::query(
        r#"UPDATE plugin_registrations SET "ingestRoots" = $1 WHERE "pluginId" = 'fliks.fixture'"#,
    )
    .bind(vec![dl.to_string_lossy().into_owned()])
    .execute(&s.pool)
    .await
    .unwrap();

    let r = call(&h, "context", &[("family", "text")]).await;
    assert_eq!(r["ok"], json!(["book", null, [202, 203, 204, 205]]), "{r}");
    let r = call(&h, "context", &[("family", "video")]).await;
    assert_eq!(r["error"], "ERR_VALIDATION", "{r}");
    let title = ("title", "Mirelune.EPUB-GRP");
    let r = call(&h, "score", &[("family", "text"), title]).await;
    assert_eq!(r["ok"], json!([[205, true]]), "{r}");
    let r = call(&h, "score", &[("family", "audio"), title]).await;
    assert_eq!(r["ok"], json!([[101, false]]), "{r}");
    let r = call(&h, "grabbed", &[("family", "text")]).await;
    assert_eq!(r["ok"], Value::Null, "{r}");
    let r = call(&h, "grabbed", &[("family", "video")]).await;
    assert_eq!(r["error"], "ERR_VALIDATION", "{r}");
    let path = dl.join("Mirelune.epub");
    let path = path.to_string_lossy();
    let r = call(
        &h,
        "ingest",
        &[("family", "text"), ("language", "fr"), ("path", &path)],
    )
    .await;
    assert_eq!(r["ok"], 1, "{r}");
    let language: Option<String> = sqlx::query_scalar(
        "SELECT language FROM editions WHERE \"mediaId\" = 1 AND family = 'text'",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(language.as_deref(), Some("fr"));
    let r = call(&h, "create", &[("kind", "book")]).await;
    assert_eq!(
        r["error"], "ERR_DENIED",
        "a book is never created by a plugin: {r}"
    );
    let _ = std::fs::remove_dir_all(dir);
    h.finish().await;
    s.finish().await;
}

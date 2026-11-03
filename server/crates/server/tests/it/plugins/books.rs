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

/// The fixture installed with every acquisition grant, a monitored book (1) in a book library and
/// a download folder (`dl`) holding `Mirelune.epub`.
async fn shelf(tag: &str) -> Option<(H, Scratch, std::path::PathBuf, std::path::PathBuf)> {
    let grants = json!([
        "config:rw",
        "media:read",
        "acquisition:candidates",
        "releases:score",
        "ingest:write",
        "events:emit"
    ]);
    let (h, s) = install(tag, grants).await?;
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
    Some((h, s, dl, dir))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_with_acquisition_grants_only_acquires_a_book() {
    let Some((h, s, dl, dir)) = shelf("books_acquire").await else {
        return;
    };
    let r = call(&h, "context", &[("family", "text")]).await;
    assert_eq!(
        r["ok"],
        json!(["book", null, [202, 203, 204, 205, 206, 207]]),
        "{r}"
    );
    let r = call(&h, "context", &[("family", "video")]).await;
    assert_eq!(r["error"], "ERR_VALIDATION", "{r}");
    let title = ("title", "Mirelune.EPUB-GRP");
    let r = call(&h, "score", &[("family", "text"), title]).await;
    assert_eq!(r["ok"], json!([[205, true, true]]), "{r}");
    let r = call(&h, "score", &[("family", "audio"), title]).await;
    assert_eq!(r["ok"], json!([[101, false, true]]), "{r}");
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

/// text/NULL satisfied by an English edition, text/fr requested: the host calls serve the French want
/// and the French file lands in a new edition.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_language_is_acquired_through_the_host_calls() {
    let Some((h, s, dl, dir)) = shelf("books_language").await else {
        return;
    };
    let path = dl.join("Mirelune.epub");
    let path = path.to_string_lossy();
    let text = ("family", "text");
    let r = call(&h, "ingest", &[text, ("language", "en"), ("path", &path)]).await;
    assert_eq!(r["ok"], 1, "{r}");
    sqlx::query(r#"INSERT INTO wants ("mediaId", family, language) VALUES (1, 'text', 'fr')"#)
        .execute(&s.pool)
        .await
        .unwrap();
    let r = call(&h, "candidates", &[text]).await;
    assert_eq!(r["ok"], json!([[1, "fr"]]), "{r}");
    let r = call(&h, "context", &[text, ("language", "fr")]).await;
    assert_eq!(
        r["ok"],
        json!(["book", "fr", [202, 203, 204, 205, 206, 207]]),
        "{r}"
    );
    let r = call(&h, "context", &[text, ("language", "de")]).await;
    assert_eq!(r["ok"], Value::Null, "{r}");
    let r = call(&h, "context", &[("family", "video"), ("language", "fr")]).await;
    assert_eq!(r["error"], "ERR_VALIDATION", "{r}");
    let fr = [text, ("language", "fr")];
    let r = call(&h, "score", &[fr[0], fr[1], ("title", "Mirelune.EPUB")]).await;
    assert_eq!(r["ok"], json!([[205, true, false]]), "{r}");
    let r = call(&h, "score", &[fr[0], fr[1], ("title", "Mirelune.FR.EPUB")]).await;
    assert_eq!(r["ok"], json!([[205, true, true]]), "{r}");
    let r = call(&h, "ingest", &[text, ("language", "fr"), ("path", &path)]).await;
    assert_eq!(r["ok"], 1, "{r}");
    let editions: Vec<(Option<String>, i64)> = sqlx::query_as(
        r#"SELECT e.language, count(p."mediaFileId") FROM editions e
           LEFT JOIN items i ON i."editionId" = e.id LEFT JOIN item_parts p ON p."itemId" = i.id
           WHERE e."mediaId" = 1 AND e.family = 'text' GROUP BY e.id ORDER BY e.id"#,
    )
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(
        editions,
        [(Some("en".to_owned()), 1), (Some("fr".to_owned()), 1)],
        "the English edition keeps its file"
    );
    let r = call(&h, "candidates", &[text]).await;
    assert_eq!(r["ok"], json!([]), "both languages are satisfied: {r}");
    let _ = std::fs::remove_dir_all(dir);
    h.finish().await;
    s.finish().await;
}

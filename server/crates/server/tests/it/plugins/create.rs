//! `media.resolveOrCreate` (`plugins.md` rule 57): scope gate, refusals and the title lock.
use super::harness::*;
use crate::fakes::Scripted;
use fliks_domain::external_id::Namespace;
use fliks_server::{
    config::Config,
    events::{Bus, DomainEvent},
    images::ImageStore,
    plugins::acquisition::resolve_or_create,
    plugins::runtime::fliks::plugin::types::ExternalId,
    state::AppState,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

const LIBRARY: &str = r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Movies', '["movie"]');
INSERT INTO library_folders ("libraryId", path) VALUES (1, '/nonexistent/m')"#;

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

async fn media_count(pool: &sqlx::PgPool) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM media")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// A plugin holding `scopes` calls `create` for a title that exists and one that does not.
async fn denied(tag: &str, scopes: Value, missing: &str) {
    let Some((mut m, w)) = fixture() else { return };
    let Some(s) = Scratch::create(tag).await else {
        return;
    };
    let h = harness(&s, tag, |_| {}).await;
    allow_unsigned(&h).await;
    m["scopes"] = scopes;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Movies', '["movie"]');
INSERT INTO library_folders ("libraryId", path) VALUES (1, '/nonexistent/m');
           INSERT INTO media (id, title, type) VALUES (7, 'Held', 'movie');
           INSERT INTO media_external_ids ("mediaId", kind, provider, value)
             VALUES (7, 'movie', 'tmdb', '603');"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    for tmdb in ["603", "604"] {
        let r = call(&h, "create", &[("tmdb", tmdb)]).await;
        assert_eq!(r["error"], "ERR_DENIED", "{r}");
        assert!(r["message"].as_str().unwrap().contains(missing), "{r}");
        assert!(r.get("ok").is_none(), "no id leaks: {r}");
    }
    assert_eq!(media_count(&s.pool).await, 1);
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_without_media_create_creates_nothing() {
    denied(
        "create_denied",
        json!(["config:rw", "media:read"]),
        "media:create",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_without_media_read_learns_no_id() {
    denied(
        "create_noread",
        json!(["config:rw", "media:create"]),
        "media:read",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resolve_or_create_refuses_what_it_does_not_serve_and_finds_what_exists() {
    let Some((m, w)) = fixture() else { return };
    let Some(s) = Scratch::create("create_refuse").await else {
        return;
    };
    let h = harness(&s, "create_refuse", |_| {}).await;
    allow_unsigned(&h).await;
    assert_eq!(
        h.install(&pack(&m, "0.1.0", &w, None)).await["status"],
        "active"
    );
    let tmdb = Scripted::new(Namespace::TMDB);
    tmdb.on.store(false, Ordering::SeqCst);
    h.st.metadata.add_plugin(tmdb);
    sqlx::raw_sql(
        r#"INSERT INTO media (id, title, type) VALUES (7, 'Held', 'movie');
           INSERT INTO media_external_ids ("mediaId", kind, provider, value)
             VALUES (7, 'movie', 'tmdb', '603');"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    for kind in ["comic", "album", "artist", "", "Movie"] {
        let r = call(&h, "create", &[("kind", kind), ("tmdb", "603")]).await;
        assert_eq!(r["error"], "unsupported-kind", "{kind}: {r}");
    }
    let r = call(&h, "create", &[]).await;
    assert_eq!(r["error"], "unsupported-provider", "no tmdb id: {r}");
    let r = call(&h, "create", &[("kind", "book"), ("tmdb", "603")]).await;
    assert_eq!(r["error"], "unsupported-provider", "no book provider: {r}");
    let r = call(&h, "create", &[("tmdb", "012")]).await;
    assert_eq!(r["error"], "ERR_VALIDATION", "{r}");
    assert_eq!(
        call(&h, "create", &[("tmdb", "603")]).await["ok"],
        7,
        "an existing media is found without a TMDB key"
    );
    let r = call(&h, "create", &[("tmdb", "604")]).await;
    assert_eq!(r["error"], "unsupported-provider", "no TMDB key: {r}");
    assert_eq!(
        call(&h, "create", &[("kind", "series"), ("tmdb", "603")]).await["error"],
        "unsupported-provider",
        "the same id names another work in another kind"
    );
    assert_eq!(media_count(&s.pool).await, 1);
    h.finish().await;
    s.finish().await;
}

/// An `AppState` whose TMDB is a fake answering any id.
/// The second value counts the detail reads, one per title imported.
async fn state_with_tmdb(s: &Scratch) -> (AppState, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let fake = Scripted::new(Namespace::TMDB);
    let h = hits.clone();
    fake.otherwise(move |k| {
        let mut p = k.split('/');
        let (kind, id) = (p.next()?, p.next_back()?.parse::<i32>().ok()?);
        match kind {
            "work" => {
                h.fetch_add(1, Ordering::SeqCst);
                Some(Ok(json!({
                    "tmdbId": id, "overview": "o", "genres": [], "status": "released",
                    "runtime": 100, "year": 2020, "title": format!("Movie {id}"),
                })))
            }
            "children" => Some(Ok(json!([]))),
            _ => None,
        }
    });
    let st = AppState::new(s.pool.clone(), Config::from_lookup(|_| None), SECRET);
    st.metadata.add_plugin(fake);
    let mut st = st;
    let data = std::env::temp_dir().join(format!(
        "fliks-create-{}",
        fliks_server::config::random_hex(6)
    ));
    st.images = Arc::new(ImageStore::with_root(data));
    (st, hits)
}

fn tmdb(id: &str) -> Vec<ExternalId> {
    vec![ExternalId {
        provider: "tmdb".into(),
        value: id.into(),
    }]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_creates_of_one_title_make_one_media() {
    let Some(s) = Scratch::create("create_race").await else {
        return;
    };
    sqlx::raw_sql(LIBRARY).execute(&s.pool).await.unwrap();
    let (st, hits) = state_with_tmdb(&s).await;
    let mut rx = st.hub.subscribe();
    let calls = (0..5).map(|_| {
        let st = st.clone();
        tokio::spawn(async move {
            resolve_or_create(&st, "org.fake", "movie", &tmdb("603"), None, None).await
        })
    });
    let ids: Vec<u32> = futures_util::future::join_all(calls)
        .await
        .into_iter()
        .map(|r| r.unwrap().unwrap())
        .collect();
    assert!(ids.iter().all(|i| *i == ids[0]), "{ids:?}");
    assert_eq!(media_count(&s.pool).await, 1);
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "one import, one provider read"
    );
    let row: (Option<i32>, i64, i64) = sqlx::query_as(
        r#"SELECT "addedById", (SELECT count(*) FROM items), (SELECT count(*) FROM wants) FROM media"#,
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(row, (None, 1, 1), "the shell: one item, one video want");
    let mut imported = vec![];
    while let Ok(b) = rx.try_recv() {
        if let Bus::Domain(DomainEvent::MediaImported {
            external_ids,
            added_by_user_id,
            ..
        }) = &*b
        {
            imported.push((external_ids.clone(), *added_by_user_id));
        }
    }
    assert_eq!(imported.len(), 1, "{imported:?}");
    assert_eq!(imported[0].1, None);
    assert_eq!(
        serde_json::to_value(&imported[0].0).unwrap(),
        json!([{"provider": "tmdb", "value": "603"}])
    );
    let again = resolve_or_create(&st, "org.fake", "movie", &tmdb("603"), None, None).await;
    assert_eq!(again.unwrap(), ids[0], "a later call finds it");
    assert_eq!(media_count(&s.pool).await, 1);
    let e = resolve_or_create(&st, "org.fake", "movie", &tmdb("604"), Some(99), None).await;
    assert_eq!(e.unwrap_err().code, "ERR_NOT_FOUND", "unknown library");
    let e = resolve_or_create(&st, "org.fake", "movie", &tmdb("604"), Some(1), Some(999)).await;
    assert_eq!(
        e.unwrap_err().code,
        "ERR_VALIDATION",
        "a folder of no library"
    );
    assert_eq!(media_count(&s.pool).await, 1);
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_user_request_and_a_plugin_create_make_one_media() {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;
    let Some(s) = Scratch::create("create_request").await else {
        return;
    };
    let (st, _) = state_with_tmdb(&s).await;
    let mut rx = st.hub.subscribe();
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Movies', '["movie"]');
INSERT INTO library_folders ("libraryId", path) VALUES (1, '/nonexistent/m');
           INSERT INTO auto_approval_rules (name, enabled, criteria)
             VALUES ('all', true, '{"mediaType":"movie"}');
           INSERT INTO roles (id, name, permissions)
             VALUES (50, 'req', '["media.read","requests.create"]');
           INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (50, 'req', false, 50);
           INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 50);"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let token = st.jwt.sign_access(50, "req").unwrap().token;
    let app = fliks_server::app::router(st.clone(), None, "/nonexistent".into(), None);
    let request = async {
        let req = Request::post("/api/requests")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::from(
                json!({"mediaType": "movie", "tmdbId": 603, "title": "Movie 603"}).to_string(),
            ))
            .unwrap();
        app.oneshot(req).await.unwrap().status().as_u16()
    };
    let ids = tmdb("603");
    let plugin = resolve_or_create(&st, "org.fake", "movie", &ids, None, None);
    let (status, created) = tokio::join!(request, plugin);
    assert_eq!(status, 201);
    let id = created.unwrap();
    assert_eq!(media_count(&s.pool).await, 1);
    let mut imports = 0;
    while let Ok(b) = rx.try_recv() {
        imports += usize::from(matches!(
            &*b,
            Bus::Domain(DomainEvent::MediaImported { .. })
        ));
    }
    assert_eq!(imports, 1, "one import");
    let linked: (String, Option<i32>) =
        sqlx::query_as(r#"SELECT status::text, "mediaId" FROM requests"#)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(linked, ("approved".into(), Some(id as i32)));
    s.finish().await;
}

/// Claims a plugin namespace as its plugin's registration does: the row, then the registry.
async fn declare(st: &AppState, name: &str, label: &str, pattern: &str) -> Namespace {
    use fliks_server::plugins::namespaces::{Declared, claim};
    let d = Declared {
        name,
        label,
        id_pattern: pattern,
        case: "preserve",
    };
    let plugin = name.split_once(':').unwrap().0;
    claim(&st.db, &st.plugins.namespaces, plugin, None, &[d])
        .await
        .unwrap()
        .unwrap();
    Namespace::parse(name).unwrap()
}

/// A third-party provider of a declared namespace, counting its work reads; `extra` is merged into its record.
struct Fake(Arc<AtomicUsize>, &'static str, Value);

impl fliks_server::metadata::MetadataProvider for Fake {
    fn id(&self) -> fliks_domain::external_id::Namespace {
        fliks_domain::external_id::Namespace::parse(self.1).unwrap()
    }
    fn supports(&self, kind: fliks_domain::media::kind::MediaKind) -> bool {
        matches!(
            kind,
            fliks_domain::media::kind::MediaKind::Movie
                | fliks_domain::media::kind::MediaKind::Book
        )
    }
    fn has_persons(&self) -> bool {
        false
    }
    fn available(&self) -> bool {
        self.2.get("down").is_none()
    }
    fn limits(&self) -> fliks_domain::metadata::limiter::Limits {
        fliks_domain::metadata::limiter::Limits::new(100.0, 100)
    }
    fn search<'a>(
        &'a self,
        _: &'a fliks_server::metadata::Search<'a>,
        _: &'a fliks_domain::metadata::language::Resolved,
        _: fliks_domain::metadata::limiter::Priority,
    ) -> fliks_server::metadata::Call<'a, Vec<Value>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn fetch_work<'a>(
        &'a self,
        _: fliks_domain::media::kind::MediaKind,
        id: &'a str,
        _: &'a fliks_domain::metadata::language::Resolved,
        _: fliks_domain::metadata::limiter::Priority,
    ) -> fliks_server::metadata::Call<'a, Value> {
        self.0.fetch_add(1, Ordering::SeqCst);
        let mut rec = json!({"title": format!("Fake {id}"), "status": "Released", "year": 2020});
        rec.as_object_mut()
            .unwrap()
            .extend(self.2.as_object().unwrap().clone());
        Box::pin(async move { Ok(rec) })
    }
    fn fetch_children<'a>(
        &'a self,
        _: fliks_domain::media::kind::MediaKind,
        _: &'a str,
        _: Option<u32>,
        _: &'a fliks_domain::metadata::language::Resolved,
        _: fliks_domain::metadata::limiter::Priority,
    ) -> fliks_server::metadata::Call<'a, Vec<Value>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn child_stubs<'a>(
        &'a self,
        _: fliks_domain::media::kind::MediaKind,
        _: &'a str,
        _: &'a fliks_domain::metadata::language::Resolved,
        _: fliks_domain::metadata::limiter::Priority,
    ) -> fliks_server::metadata::Call<'a, Vec<Value>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn find_by<'a>(
        &'a self,
        _: fliks_domain::external_id::Namespace,
        _: &'a str,
        _: &'a fliks_domain::metadata::language::Resolved,
        _: fliks_domain::metadata::limiter::Priority,
    ) -> fliks_server::metadata::Call<'a, Option<(String, fliks_domain::media::kind::MediaKind)>>
    {
        Box::pin(async { Ok(None) })
    }
    fn fetch_person<'a>(
        &'a self,
        _: &'a str,
        _: &'a fliks_domain::metadata::language::Resolved,
        _: fliks_domain::metadata::limiter::Priority,
    ) -> fliks_server::metadata::Call<'a, fliks_server::metadata::PersonDetails> {
        Box::pin(async { Err(fliks_server::metadata::Upstream::new(Some(404), "none")) })
    }
    fn person_credits<'a>(
        &'a self,
        _: &'a str,
        _: &'a fliks_domain::metadata::language::Resolved,
        _: fliks_domain::metadata::limiter::Priority,
    ) -> fliks_server::metadata::Call<'a, fliks_server::metadata::Credits> {
        Box::pin(async { Err(fliks_server::metadata::Upstream::new(Some(404), "none")) })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_namespace_resolves_to_one_media_that_refreshes() {
    use fliks_domain::metadata::limiter::Priority;
    let Some(s) = Scratch::create("create_plugin_ns").await else {
        return;
    };
    sqlx::raw_sql(LIBRARY).execute(&s.pool).await.unwrap();
    let (st, _) = state_with_tmdb(&s).await;
    let ns = declare(&st, "org.fake:aid", "Fake id", "^[1-9][0-9]*$").await;
    let reads = Arc::new(AtomicUsize::new(0));
    st.metadata
        .add_plugin(Arc::new(Fake(reads.clone(), "org.fake:aid", json!({}))));
    let ids = vec![ExternalId {
        provider: "org.fake:aid".into(),
        value: "7".into(),
    }];
    let first = resolve_or_create(&st, "org.fake", "movie", &ids, None, None)
        .await
        .unwrap();
    let second = resolve_or_create(&st, "org.fake", "movie", &ids, None, None)
        .await
        .unwrap();
    assert_eq!(first, second, "the second call finds the media");
    assert_eq!(media_count(&s.pool).await, 1);
    assert_eq!(reads.load(Ordering::SeqCst), 1, "one import");
    let row: (String, Option<String>) = sqlx::query_as(
        r#"SELECT e.value, m."preferredProvider" FROM media m
           JOIN media_external_ids e ON e."mediaId" = m.id AND e.provider = 'org.fake:aid'"#,
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(row, ("7".into(), Some("org.fake:aid".into())));
    let found =
        fliks_server::metadata::service::for_media(&st, first as i32, Priority::Interactive)
            .await
            .unwrap();
    assert_eq!(
        found.provider,
        (ns, "7".into()),
        "a refresh reads the plugin"
    );
    assert_eq!(found.details.title, "Fake 7");
    s.finish().await;
}

/// A book named by a plugin namespace is made once, from the plugin's record, with no anchor id.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_namespace_creates_one_book_with_both_wants() {
    let Some(s) = Scratch::create("create_plugin_book").await else {
        return;
    };
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Books', '["book"]');
           INSERT INTO library_folders ("libraryId", path) VALUES (1, '/nonexistent/b')"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let (st, _) = state_with_tmdb(&s).await;
    declare(&st, "org.fake:bid", "Fake id", "^[1-9][0-9]*$").await;
    let reads = Arc::new(AtomicUsize::new(0));
    st.metadata.add_plugin(Arc::new(Fake(
        reads.clone(),
        "org.fake:bid",
        json!({"authors": [{"name": "Ada Quill"}], "overview": "o"}),
    )));
    let ids = vec![ExternalId {
        provider: "org.fake:bid".into(),
        value: "7".into(),
    }];
    let first = resolve_or_create(&st, "org.fake", "book", &ids, None, None)
        .await
        .unwrap();
    let second = resolve_or_create(&st, "org.fake", "book", &ids, None, None)
        .await
        .unwrap();
    assert_eq!(first, second, "the second call finds the book");
    assert_eq!(media_count(&s.pool).await, 1);
    assert_eq!(reads.load(Ordering::SeqCst), 1, "one work read");
    let row: (String, String, Option<String>) = sqlx::query_as(
        r#"SELECT m.title, m.type, m."preferredProvider" FROM media m WHERE m.id = $1"#,
    )
    .bind(first as i32)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(
        row,
        ("Fake 7".into(), "book".into(), Some("org.fake:bid".into()))
    );
    let ids: Vec<(String, String)> =
        sqlx::query_as(r#"SELECT provider, value FROM media_external_ids ORDER BY provider"#)
            .fetch_all(&s.pool)
            .await
            .unwrap();
    assert_eq!(ids, [("org.fake:bid".into(), "7".into())], "no core id");
    let wants: Vec<String> =
        sqlx::query_scalar(r#"SELECT family FROM wants WHERE "mediaId" = $1 ORDER BY family"#)
            .bind(first as i32)
            .fetch_all(&s.pool)
            .await
            .unwrap();
    assert_eq!(wants, ["audio", "text"]);
    let author: String = sqlx::query_scalar(
        r#"SELECT p.name FROM media_credits c JOIN persons p ON p.id = c."personId" WHERE c."mediaId" = $1 AND c.role = 'author'"#,
    )
    .bind(first as i32)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(author, "Ada Quill");
    let editions: i64 = sqlx::query_scalar("SELECT count(*) FROM editions")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(editions, 0, "ingest makes the editions");
    s.finish().await;
}

async fn books_state(tag: &str) -> Option<(AppState, Scratch)> {
    let s = Scratch::create(tag).await?;
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Books', '["book"]');
           INSERT INTO library_folders ("libraryId", path) VALUES (1, '/nonexistent/b')"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let (st, _) = state_with_tmdb(&s).await;
    Some((st, s))
}

fn id(provider: &str, value: &str) -> ExternalId {
    ExternalId {
        provider: provider.into(),
        value: value.into(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_book_of_the_anchor_links_the_callers_own_ids() {
    let Some((st, s)) = books_state("create_book_anchor").await else {
        return;
    };
    declare(&st, "org.fake:bid", "Fake id", "^[1-9][0-9]*$").await;
    let reads = Arc::new(AtomicUsize::new(0));
    st.metadata
        .add_plugin(Arc::new(Fake(reads.clone(), "openlibrary", json!({}))));
    st.metadata
        .add_plugin(Arc::new(Fake(reads, "org.fake:bid", json!({}))));
    let ids = vec![id("org.fake:bid", "7"), id("openlibrary", "OL1W")];
    let first = resolve_or_create(&st, "org.fake", "book", &ids, None, None)
        .await
        .unwrap();
    let held: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT provider, value FROM media_external_ids WHERE "mediaId" = $1 ORDER BY provider"#,
    )
    .bind(first as i32)
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(
        held,
        [
            ("openlibrary".into(), "OL1W".into()),
            ("org.fake:bid".into(), "7".into())
        ]
    );
    let again = resolve_or_create(&st, "org.fake", "book", &ids[..1], None, None)
        .await
        .unwrap();
    assert_eq!(again, first, "the plugin's own id finds the work");
    assert_eq!(media_count(&s.pool).await, 1);
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_book_needs_an_id_the_caller_owns_and_the_anchor_when_named() {
    let Some((st, s)) = books_state("create_book_owned").await else {
        return;
    };
    declare(&st, "org.fake:bid", "Fake id", "^[1-9][0-9]*$").await;
    st.metadata.add_plugin(Arc::new(Fake(
        Arc::new(AtomicUsize::new(0)),
        "org.fake:bid",
        json!({}),
    )));
    st.metadata.add_plugin(Arc::new(Fake(
        Arc::new(AtomicUsize::new(0)),
        "openlibrary",
        json!({"down": true}),
    )));
    let ids = vec![id("org.fake:bid", "7")];
    let e = resolve_or_create(&st, "org.other", "book", &ids, None, None).await;
    assert_eq!(e.unwrap_err().code, "namespace-not-owned");
    let named = vec![id("openlibrary", "OL1W"), id("org.fake:bid", "7")];
    let e = resolve_or_create(&st, "org.fake", "book", &named, None, None).await;
    assert_eq!(
        e.unwrap_err().code,
        "unavailable",
        "an unavailable anchor is retryable, not a duplicate under the plugin namespace"
    );
    assert_eq!(media_count(&s.pool).await, 0);
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_creates_of_one_book_make_one_media() {
    let Some((st, s)) = books_state("create_book_race").await else {
        return;
    };
    declare(&st, "org.fake:bid", "Fake id", "^[1-9][0-9]*$").await;
    let reads = Arc::new(AtomicUsize::new(0));
    st.metadata
        .add_plugin(Arc::new(Fake(reads.clone(), "org.fake:bid", json!({}))));
    let ids = vec![id("org.fake:bid", "7")];
    let call = || resolve_or_create(&st, "org.fake", "book", &ids, None, None);
    let (a, b, c) = tokio::join!(call(), call(), call());
    let (a, b, c) = (a.unwrap(), b.unwrap(), c.unwrap());
    assert!(a == b && b == c);
    assert_eq!(media_count(&s.pool).await, 1);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    s.finish().await;
}

/// TMDB is registered but unconfigured: the plugin entry creates the media (`plugins.md` rule 57).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_entry_creates_when_the_first_provider_is_unavailable() {
    let Some(s) = Scratch::create("create_second_entry").await else {
        return;
    };
    sqlx::raw_sql(LIBRARY).execute(&s.pool).await.unwrap();
    let mut st = AppState::new(s.pool.clone(), Config::from_lookup(|_| None), SECRET);
    let data = std::env::temp_dir().join(format!(
        "fliks-create-{}",
        fliks_server::config::random_hex(6)
    ));
    st.images = Arc::new(ImageStore::with_root(data));
    declare(&st, "org.fake:aid", "Fake id", "^[1-9][0-9]*$").await;
    st.metadata
        .add_plugin(Arc::new(Fake(Arc::default(), "org.fake:aid", json!({}))));
    let both = vec![
        ExternalId {
            provider: "tmdb".into(),
            value: "603".into(),
        },
        ExternalId {
            provider: "org.fake:aid".into(),
            value: "7".into(),
        },
    ];
    let id = resolve_or_create(&st, "org.fake", "movie", &both, None, None)
        .await
        .unwrap();
    let provider: String =
        sqlx::query_scalar(r#"SELECT provider FROM media_external_ids WHERE "mediaId" = $1"#)
            .bind(id as i32)
            .fetch_one(&s.pool)
            .await
            .unwrap();
    assert_eq!(provider, "org.fake:aid");
    s.finish().await;
}

/// A plugin record with a `tvdbId` is not looked up on TMDB: no `tmdb` link, no 409 on a held one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_plugin_record_never_links_or_collides_on_a_tmdb_id() {
    let Some(s) = Scratch::create("create_plugin_tvdb").await else {
        return;
    };
    sqlx::raw_sql(LIBRARY).execute(&s.pool).await.unwrap();
    let (st, _) = state_with_tmdb(&s).await;
    declare(&st, "org.fake:aid", "Fake id", "^[1-9][0-9]*$").await;
    st.metadata.add_plugin(Arc::new(Fake(
        Arc::default(),
        "org.fake:aid",
        json!({"tvdbId": 81189, "imdbId": "tt0000002", "ids": {"tvdb": "81189", "imdb": "tt0000002"}}),
    )));
    sqlx::raw_sql(
        r#"INSERT INTO media (id, title, type) VALUES (900, 'Held', 'movie');
           INSERT INTO media_external_ids ("mediaId", kind, provider, value)
             VALUES (900, 'movie', 'tmdb', '1396');"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let ids = vec![ExternalId {
        provider: "org.fake:aid".into(),
        value: "7".into(),
    }];
    let id = resolve_or_create(&st, "org.fake", "movie", &ids, None, None)
        .await
        .unwrap();
    let held: Vec<(String,)> = sqlx::query_as(
        r#"SELECT provider FROM media_external_ids WHERE "mediaId" = $1 ORDER BY provider"#,
    )
    .bind(id as i32)
    .fetch_all(&s.pool)
    .await
    .unwrap();
    assert_eq!(
        held,
        [("org.fake:aid".to_owned(),)],
        "a plugin record writes no core id"
    );
    // A library preferring TMDB does not look the plugin's imdbId or tvdbId up there either.
    sqlx::query(r#"UPDATE libraries SET "preferredProvider" = 'tmdb' WHERE id = 1"#)
        .execute(&s.pool)
        .await
        .unwrap();
    st.metadata.add_plugin(Arc::new(Fake(
        Arc::default(),
        "org.fake:aid",
        json!({"tvdbId": 81189, "imdbId": "tt0000001"}),
    )));
    let ids = vec![ExternalId {
        provider: "org.fake:aid".into(),
        value: "8".into(),
    }];
    let id = resolve_or_create(&st, "org.fake", "movie", &ids, None, None)
        .await
        .unwrap();
    let tmdb_links: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM media_external_ids WHERE "mediaId" = $1 AND provider = 'tmdb'"#,
    )
    .bind(id as i32)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(tmdb_links, 0);
    // The found path changes nothing, and a plugin creates only through its own namespaces.
    let mixed = vec![
        ExternalId {
            provider: "org.fake:aid".into(),
            value: "8".into(),
        },
        ExternalId {
            provider: "tvdb".into(),
            value: "999999".into(),
        },
    ];
    assert_eq!(
        resolve_or_create(&st, "org.fake", "movie", &mixed, None, None)
            .await
            .unwrap(),
        id
    );
    let held: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM media_external_ids WHERE "mediaId" = $1 AND value = '999999'"#,
    )
    .bind(id as i32)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(held, 0, "the found path links nothing");
    let other = vec![ExternalId {
        provider: "org.fake:aid".into(),
        value: "9".into(),
    }];
    let e = resolve_or_create(&st, "org.other", "movie", &other, None, None)
        .await
        .unwrap_err();
    assert_eq!(e.code, "namespace-not-owned");
    // `org.fake.x` is not `org.fake`, and one id per namespace counts.
    declare(&st, "org.fake.x:aid", "X", "^[1-9][0-9]*$").await;
    st.metadata
        .add_plugin(Arc::new(Fake(Arc::default(), "org.fake.x:aid", json!({}))));
    let x = vec![ExternalId {
        provider: "org.fake.x:aid".into(),
        value: "5".into(),
    }];
    let e = resolve_or_create(&st, "org.fake", "movie", &x, None, None)
        .await
        .unwrap_err();
    assert_eq!(e.code, "namespace-not-owned");
    let twice = vec![
        ExternalId {
            provider: "org.fake:aid".into(),
            value: "11".into(),
        },
        ExternalId {
            provider: "org.fake:aid".into(),
            value: "12".into(),
        },
    ];
    let id = resolve_or_create(&st, "org.fake", "movie", &twice, None, None)
        .await
        .unwrap();
    let aid: String = sqlx::query_scalar(
        r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = 'org.fake:aid'"#,
    )
    .bind(id as i32)
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(aid, "11");
    s.finish().await;
}

/// An `idPattern` with letters imports and refreshes, and every served non-unique entry is linked.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lettered_namespace_refreshes_and_all_entries_are_linked() {
    use fliks_domain::metadata::limiter::Priority;
    let Some(s) = Scratch::create("create_lettered").await else {
        return;
    };
    sqlx::raw_sql(LIBRARY).execute(&s.pool).await.unwrap();
    let (st, _) = state_with_tmdb(&s).await;
    declare(&st, "org.fake:aid", "Fake id", "^[1-9][0-9]*$").await;
    let slug = declare(&st, "org.fake:slug", "Slug", "^[a-z0-9-]+$").await;
    let reads = Arc::new(AtomicUsize::new(0));
    st.metadata
        .add_plugin(Arc::new(Fake(reads.clone(), "org.fake:slug", json!({}))));
    st.metadata
        .add_plugin(Arc::new(Fake(Arc::default(), "org.fake:aid", json!({}))));
    let entry = |p: &str, v: &str| ExternalId {
        provider: p.into(),
        value: v.into(),
    };
    let both = vec![
        entry("org.fake:slug", "cowboy-bebop"),
        entry("org.fake:aid", "7"),
    ];
    let first = resolve_or_create(&st, "org.fake", "movie", &both, None, None)
        .await
        .unwrap();
    for one in &both {
        let again = resolve_or_create(
            &st,
            "org.fake",
            "movie",
            std::slice::from_ref(one),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(again, first, "{}", one.provider);
    }
    assert_eq!(media_count(&s.pool).await, 1);
    let found =
        fliks_server::metadata::service::for_media(&st, first as i32, Priority::Interactive)
            .await
            .unwrap();
    assert_eq!(found.provider, (slug, "cowboy-bebop".into()));
    s.finish().await;
}

/// A pin to a plugin that is gone falls through to the next provider (rule 27).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_pin_to_a_gone_plugin_falls_through() {
    use fliks_domain::{external_id::Namespace, metadata::limiter::Priority};
    let Some(s) = Scratch::create("create_pin_gone").await else {
        return;
    };
    sqlx::raw_sql(LIBRARY).execute(&s.pool).await.unwrap();
    let (st, _) = state_with_tmdb(&s).await;
    declare(&st, "org.fake:aid", "Fake id", "^[1-9][0-9]*$").await;
    sqlx::raw_sql(
        r#"INSERT INTO media (id, title, type, "libraryId", "preferredProvider")
             VALUES (900, 'Pinned', 'movie', 1, 'org.fake:aid');
           INSERT INTO media_external_ids ("mediaId", kind, provider, value)
             VALUES (900, 'movie', 'org.fake:aid', '7'), (900, 'movie', 'tmdb', '603');"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    let found = fliks_server::metadata::service::for_media(&st, 900, Priority::Interactive)
        .await
        .unwrap();
    assert_eq!(found.provider.0, Namespace::TMDB, "no plugin registered");
    s.finish().await;
}

//! Comic providers against a fake provider (`docs/spec/comics.md` rules 38-44).
use crate::{
    config::Config,
    media,
    metadata::{
        Credits, MetadataProvider, PersonDetails, Search, Upstream, comics, provider::Call,
    },
    state::AppState,
};
use axum::{Router, body::Body, http::Request};
use fliks_domain::{
    external_id::Namespace,
    media::kind::MediaKind,
    metadata::{
        language::Resolved,
        limiter::{Limits, Priority},
    },
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

const NS: &str = "org.test.comic:vol";

fn ns() -> Namespace {
    Namespace::declare(NS, "Test Comics", "^[0-9]{1,9}$", "preserve").unwrap()
}

#[derive(Default)]
struct Fake {
    works: HashMap<String, Value>,
    children: HashMap<String, Vec<Value>>,
    found: Vec<Value>,
    work_calls: Mutex<u32>,
}

fn down<T: Send + 'static>() -> Call<'static, T> {
    Box::pin(async { Err(Upstream::new(Some(500), "down")) })
}

impl MetadataProvider for Arc<Fake> {
    fn id(&self) -> Namespace {
        ns()
    }
    fn supports(&self, kind: MediaKind) -> bool {
        kind == MediaKind::Comic
    }
    fn has_persons(&self) -> bool {
        false
    }
    fn limits(&self) -> Limits {
        Limits::new(100.0, 100)
    }
    fn search<'a>(
        &'a self,
        _: &'a Search<'a>,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        let r = self.found.clone();
        Box::pin(async move { Ok(r) })
    }
    fn fetch_work<'a>(
        &'a self,
        _: MediaKind,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Value> {
        *self.work_calls.lock().unwrap() += 1;
        let r = self.works.get(id).cloned();
        Box::pin(async move { r.ok_or_else(|| Upstream::new(Some(404), "no work")) })
    }
    fn fetch_children<'a>(
        &'a self,
        _: MediaKind,
        id: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        let r = self.children.get(id).cloned().unwrap_or_default();
        Box::pin(async move { Ok(r) })
    }
    fn child_stubs<'a>(
        &'a self,
        _: MediaKind,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Vec<Value>> {
        down()
    }
    fn find_by<'a>(
        &'a self,
        _: Namespace,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, Option<(String, MediaKind)>> {
        down()
    }
    fn fetch_person<'a>(
        &'a self,
        _: &'a str,
        _: &'a Resolved,
        _: Priority,
    ) -> Call<'a, PersonDetails> {
        down()
    }
    fn person_credits<'a>(&'a self, _: &'a str, _: &'a Resolved, _: Priority) -> Call<'a, Credits> {
        down()
    }
}

fn work() -> Value {
    json!({"ids": {NS: "42"}, "externalId": "42", "mediaType": "comic", "title": "Alpha Run",
           "overview": "A run.", "year": 2016, "publisher": "Pub House", "volume": 2,
           "issueCount": 3, "posterUrl": "https://img.test/a.jpg", "sourceUrl": "https://cv.test/42"})
}

fn issue(n: &str, sort: Value, kind: &str, title: Option<&str>, date: Option<&str>) -> Value {
    json!({"number": n, "sortNumber": sort, "kind": kind, "title": title, "releaseDate": date})
}

fn children() -> Vec<Value> {
    vec![
        issue("1", json!(1), "issue", Some("Start"), Some("2016-06-01")),
        issue("1.10", json!(1.1), "issue", None, None),
        issue("1.1", json!(1.1), "issue", Some("Repeat"), None),
        issue("2", json!(2), "issue", Some("Next"), Some("2016-07-06")),
        issue("1", json!(1), "annual", None, None),
        issue("3", json!(1e9), "issue", None, None),
        issue("4", json!(4), "weird", None, None),
        issue("5", json!(5), "issue", None, Some("2016-13-01")),
    ]
}

fn fake() -> Arc<Fake> {
    let mut f = Fake::default();
    f.works.insert("42".into(), work());
    f.works.insert(
        "43".into(),
        json!({"externalId": "43", "title": "Alpha Run", "mediaType": "comic"}),
    );
    f.children.insert("42".into(), children());
    f.found = vec![work(), json!({"title": "no id"})];
    Arc::new(f)
}

struct Ctx {
    app: Router,
    admin: String,
    reader: String,
    pool: PgPool,
    fake: Arc<Fake>,
    st: AppState,
}

async fn ctx(pool: PgPool, provider: Option<Arc<Fake>>) -> Ctx {
    ctx_with(pool, provider, true).await
}

async fn ctx_with(pool: PgPool, provider: Option<Arc<Fake>>, registered: bool) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let st = AppState::new(
        pool.clone(),
        Config::from_lookup(|_| None),
        "0123456789abcdef0123456789abcdef",
    );
    let fake = provider.unwrap_or_else(fake);
    if registered {
        st.metadata.add_plugin(Arc::new(fake.clone()));
    }
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'reader', false, 1);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Comics', '["comic"]'), (2, 'Other', '["comic"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/c/one'), (2, '/c/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2);
        INSERT INTO provider_namespaces (name, "pluginId", "idPattern", "case", label)
          VALUES ('org.test.comic:vol', 'org.test.comic', '^[0-9]+$', 'preserve', 'Test Comics');
        INSERT INTO plugin_packages ("pluginId", version, archive, origin, signature, manifest)
          VALUES ('org.test.comic', '1.0.0', '\x00', 'manual', 'sig',
                  '{"id": "org.test.comic", "homepage": "https://cv.test"}');
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        admin: st.jwt.sign_access(1, "admin").unwrap().token,
        reader: st.jwt.sign_access(2, "reader").unwrap().token,
        app: crate::metadata::router()
            .merge(media::router())
            .with_state(st.clone()),
        pool,
        fake,
        st,
    }
}

impl Ctx {
    async fn call(
        &self,
        token: &str,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let body = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let res = self
            .app
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn get(&self, uri: &str) -> (u16, Value) {
        self.call(&self.admin, "GET", uri, None).await
    }

    async fn import(&self, extra: Value) -> (u16, Value) {
        let mut b = json!({"type": "comic", "provider": NS, "externalId": "42", "libraryId": 1});
        b.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        self.call(&self.admin, "POST", "/api/media/import", Some(b))
            .await
    }

    /// A volume ingest made, with the issues `001`, `02` and `1.5`.
    async fn local_volume(&self) -> i32 {
        let m: i32 = sqlx::query_scalar(
            r#"INSERT INTO media (title, type, "libraryId", year) VALUES ('alpha run', 'comic', 1, 2015) RETURNING id"#,
        )
        .fetch_one(&self.pool)
        .await
        .unwrap();
        sqlx::query(r#"INSERT INTO comic_details ("mediaId", publisher) VALUES ($1, 'Local Pub')"#)
            .bind(m)
            .execute(&self.pool)
            .await
            .unwrap();
        let e: i32 = sqlx::query_scalar(
            r#"INSERT INTO editions ("mediaId", family) VALUES ($1, 'image') RETURNING id"#,
        )
        .bind(m)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        for (n, sort, title, locked) in [
            ("001", "1", Some("My title"), vec!["title", "releaseDate"]),
            ("02", "2", None, vec!["label"]),
            ("1.5", "1.5", None, vec![]),
        ] {
            let i: i32 = sqlx::query_scalar(
                r#"INSERT INTO items ("mediaId", "editionId", monitored, title) VALUES ($1, $2, true, $3) RETURNING id"#,
            )
            .bind(m)
            .bind(e)
            .bind(title)
            .fetch_one(&self.pool)
            .await
            .unwrap();
            sqlx::query(
                r#"INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label, "lockedFields")
                   VALUES ($1, $2, 'issue', $3::text::numeric, $4, $5)"#,
            )
            .bind(i)
            .bind(m)
            .bind(sort)
            .bind(n)
            .bind(locked)
            .execute(&self.pool)
            .await
            .unwrap();
        }
        m
    }

    async fn issues(
        &self,
        media: i32,
    ) -> Vec<(String, String, String, Option<String>, Option<String>, bool)> {
        sqlx::query_as(
            r#"SELECT ci.kind, ci."sortNumber"::float8::text, ci.label, i.title, i."airDate"::text, i.monitored
               FROM comic_issues ci JOIN items i ON i.id = ci."itemId"
               WHERE ci."mediaId" = $1 ORDER BY ci.kind, ci."sortNumber""#,
        )
        .bind(media)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }
}

fn row(
    k: &str,
    s: &str,
    l: &str,
    t: Option<&str>,
    d: Option<&str>,
) -> (String, String, String, Option<String>, Option<String>, bool) {
    (
        k.into(),
        s.into(),
        l.into(),
        t.map(Into::into),
        d.map(Into::into),
        false,
    )
}

#[sqlx::test(migrations = false)]
async fn import_creates_the_volume_and_its_fileless_issues(pool: PgPool) {
    let c = ctx(pool, None).await;
    let (s, v) = c.import(json!({})).await;
    assert_eq!(s, 201, "{v}");
    assert_eq!(
        (
            v["type"].as_str(),
            v["title"].as_str(),
            v["year"].as_i64(),
            v["folderName"].as_str()
        ),
        (
            Some("comic"),
            Some("Alpha Run"),
            Some(2016),
            Some("Alpha Run")
        )
    );
    assert_eq!(v["preferredProvider"], NS);
    // the poster host is not one the image store may fetch: no remote URL is kept
    assert_eq!(v["posterUrl"], Value::Null);
    let comic = &v["comic"];
    assert_eq!(
        (
            comic["publisher"].as_str(),
            comic["startYear"].as_i64(),
            comic["volume"].as_i64()
        ),
        (Some("Pub House"), Some(2016), Some(2))
    );
    // the repeat of 1.1, the out-of-range sort, the unknown kind and the bad date are dropped
    let issues = comic["issues"].as_array().unwrap();
    let got: Vec<_> = issues
        .iter()
        .map(|i| {
            (
                i["number"].as_str().unwrap(),
                i["kind"].as_str().unwrap(),
                i["mediaFileId"].is_null(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("1", "issue", true),
            ("1.10", "issue", true),
            ("2", "issue", true),
            ("1", "annual", true)
        ]
    );
    assert_eq!(issues[0]["title"], "Start");
    assert_eq!(issues[0]["releaseDate"], "2016-06-01");
    let id = v["id"].as_i64().unwrap() as i32;
    assert!(
        c.issues(id).await.iter().all(|r| r.5),
        "a monitored volume wants every issue"
    );
    let ext: String = sqlx::query_scalar(
        r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = $2"#,
    )
    .bind(id)
    .bind(NS)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(ext, "42");
    let wants: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM wants WHERE "mediaId" = $1 AND family = 'image'"#,
    )
    .bind(id)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(wants, 1);
    let (s, v) = c.import(json!({})).await;
    assert_eq!(
        (s, v["message"].as_str()),
        (409, Some("This title is already in the library"))
    );
}

#[sqlx::test(migrations = false)]
async fn import_validates_before_it_writes(pool: PgPool) {
    let c = ctx(pool, None).await;
    assert_eq!(c.import(json!({"provider": "tmdb"})).await.0, 400);
    assert_eq!(c.import(json!({"externalId": "x1"})).await.0, 400);
    assert_eq!(c.import(json!({"externalId": "99"})).await.0, 404);
    assert_eq!(c.import(json!({"wants": []})).await.0, 400);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test(migrations = false)]
async fn a_work_that_breaks_the_record_rules_imports_nothing(pool: PgPool) {
    let mut f = Fake::default();
    f.works.insert(
        "42".into(),
        json!({"externalId": "42", "mediaType": "comic"}),
    );
    let c = ctx(pool, Some(Arc::new(f))).await;
    assert_eq!(c.import(json!({})).await.0, 503);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

async fn lock(c: &Ctx, media: i32, field: &str) {
    sqlx::query(r#"INSERT INTO media_field_sources ("mediaId", field, provider, locked) VALUES ($1, $2, NULL, true)"#)
        .bind(media)
        .bind(field)
        .execute(&c.pool)
        .await
        .unwrap();
}

async fn link(c: &Ctx, media: i32) {
    sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'comic', $2, '42')"#)
        .bind(media)
        .bind(NS)
        .execute(&c.pool)
        .await
        .unwrap();
}

#[sqlx::test(migrations = false)]
async fn a_refresh_merges_onto_the_local_issues_and_honours_the_locks(pool: PgPool) {
    let c = ctx(pool, None).await;
    let m = c.local_volume().await;
    lock(&c, m, "title").await;
    lock(&c, m, "publisher").await;
    link(&c, m).await;
    sqlx::query(r#"UPDATE media SET monitored = false WHERE id = $1"#)
        .bind(m)
        .execute(&c.pool)
        .await
        .unwrap();
    assert!(
        comics::refresh(&c.st, m, Priority::Interactive)
            .await
            .unwrap()
    );
    let (title, year, over): (String, i32, Option<String>) =
        sqlx::query_as(r#"SELECT title, year, overview FROM media WHERE id = $1"#)
            .bind(m)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(
        (title.as_str(), year, over.as_deref()),
        ("alpha run", 2016, Some("A run."))
    );
    let (publisher, start, volume): (String, Option<i32>, Option<i32>) = sqlx::query_as(
        r#"SELECT publisher, "startYear", volume FROM comic_details WHERE "mediaId" = $1"#,
    )
    .bind(m)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        (publisher.as_str(), start, volume),
        ("Local Pub", Some(2016), Some(2))
    );
    let mut got = c.issues(m).await;
    // the new issues follow the volume (not monitored here), the three that were there keep true
    assert_eq!(got.iter().filter(|r| r.5).count(), 3);
    got.iter_mut().for_each(|r| r.5 = false);
    assert_eq!(
        got,
        [
            row("annual", "1", "1", None, None),
            row("issue", "1", "1", Some("My title"), None),
            row("issue", "1.1", "1.10", None, None),
            row("issue", "1.5", "1.5", None, None),
            row("issue", "2", "02", Some("Next"), Some("2016-07-06")),
        ]
    );
    // a second refresh converges
    comics::refresh(&c.st, m, Priority::Interactive)
        .await
        .unwrap();
    assert_eq!(c.issues(m).await.len(), 5);
    let held: Vec<(Option<String>,)> = sqlx::query_as(
        r#"SELECT provider FROM media_field_sources WHERE "mediaId" = $1 AND NOT locked ORDER BY field"#,
    )
    .bind(m)
    .fetch_all(&c.pool)
    .await
    .unwrap();
    assert!(held.iter().all(|h| h.0.as_deref() == Some(NS)) && !held.is_empty());
}

#[sqlx::test(migrations = false)]
async fn a_media_with_no_provider_id_has_nothing_to_refresh(pool: PgPool) {
    let c = ctx(pool, None).await;
    let m = c.local_volume().await;
    assert!(
        !comics::refresh(&c.st, m, Priority::Interactive)
            .await
            .unwrap()
    );
    let (s, _) = c
        .call(
            &c.admin,
            "POST",
            &format!("/api/media/{m}/identify"),
            Some(json!({"provider": "nope:x", "externalId": "1"})),
        )
        .await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn the_detail_names_the_providers_that_contributed(pool: PgPool) {
    let c = ctx(pool, None).await;
    let (_, v) = c.import(json!({})).await;
    let id = v["id"].as_i64().unwrap();
    let (s, v) = c.get(&format!("/api/media/{id}")).await;
    assert_eq!(s, 200);
    assert_eq!(
        v["comic"]["providers"],
        json!([{"provider": NS, "name": "Test Comics", "url": "https://cv.test"}])
    );
    // a volume nobody enriched carries none
    let local = c.local_volume().await;
    let (_, v) = c.get(&format!("/api/media/{local}")).await;
    assert_eq!(v["comic"]["providers"], json!([]));
    // the package leaves: the name stays, the link does not
    sqlx::query("DELETE FROM plugin_packages")
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, v) = c.get(&format!("/api/media/{id}")).await;
    assert_eq!(v["comic"]["providers"][0]["url"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn search_and_preview_answer_cards_and_the_issue_list(pool: PgPool) {
    let c = ctx(pool, None).await;
    let (s, v) = c.get("/api/metadata/search/comic?q=alpha").await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        v,
        json!([{"provider": NS, "externalId": "42", "kind": "comic", "title": "Alpha Run", "year": 2016,
                "publisher": "Pub House", "volume": 2, "issueCount": 3, "overview": "A run.",
                "coverUrl": "https://img.test/a.jpg", "sourceUrl": "https://cv.test/42", "mediaId": null}])
    );
    assert_eq!(c.get("/api/metadata/search/comic").await.1, json!([]));
    assert_eq!(
        c.get("/api/metadata/search/comic?q=a&provider=nope")
            .await
            .0,
        400
    );
    assert_eq!(c.get("/api/metadata/search/comic?q=a&page=0").await.0, 400);
    let (s, v) = c.get(&format!("/api/metadata/{NS}/comic/42")).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["description"], "A run.");
    assert_eq!(v["issues"].as_array().unwrap().len(), 4);
    assert_eq!(
        v["issues"][1],
        json!({"number": "1.10", "sort": 1.1, "kind": "issue", "title": null, "releaseDate": null})
    );
    assert_eq!(
        v["attribution"],
        json!({"provider": NS, "name": "Test Comics", "url": "https://cv.test"})
    );
    assert_eq!(c.get(&format!("/api/metadata/{NS}/comic/x")).await.0, 400);
    assert_eq!(c.get(&format!("/api/metadata/{NS}/comic/7")).await.0, 404);
    assert_eq!(c.get("/api/metadata/tmdb/comic/7").await.0, 400);
    // the cards say where the volume already is, for the libraries the caller reads
    let (s, _) = c.import(json!({"libraryId": 2})).await;
    assert_eq!(s, 201);
    let (_, v) = c.get("/api/metadata/search/comic?q=alpha").await;
    assert!(v[0]["mediaId"].is_i64());
    let (_, v) = c
        .call(&c.reader, "GET", "/api/metadata/search/comic?q=alpha", None)
        .await;
    assert_eq!(v[0]["mediaId"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn the_providers_route_lists_the_comic_providers(pool: PgPool) {
    let c = ctx(pool, None).await;
    let (_, v) = c.get("/api/metadata/providers").await;
    assert_eq!(
        v["serving"]["comic"],
        json!([{"provider": NS, "label": "Test Comics", "url": "https://cv.test"}])
    );
}

#[sqlx::test(migrations = false)]
async fn without_a_provider_the_library_works_on_local_metadata(pool: PgPool) {
    let c = ctx_with(pool, None, false).await;
    assert_eq!(
        c.get("/api/metadata/search/comic?q=alpha").await.1,
        json!([])
    );
    let (_, v) = c.get("/api/metadata/providers").await;
    assert_eq!(v["serving"]["comic"], json!([]));
    let m = c.local_volume().await;
    let (s, v) = c.get(&format!("/api/media/{m}")).await;
    assert_eq!(
        (s, v["comic"]["issues"].as_array().map(Vec::len)),
        (200, Some(3))
    );
    assert_eq!(c.import(json!({})).await.0, 400);
}

#[sqlx::test(migrations = false)]
async fn a_second_work_call_inside_the_ttl_is_a_snapshot_not_a_call(pool: PgPool) {
    let c = ctx(pool, None).await;
    // the fake keeps the default zero TTL: every read calls the provider
    c.get(&format!("/api/metadata/{NS}/comic/42")).await;
    c.get(&format!("/api/metadata/{NS}/comic/42")).await;
    assert_eq!(*c.fake.work_calls.lock().unwrap(), 2);
}

async fn add_issue(
    c: &Ctx,
    media: i32,
    kind: &str,
    sort: &str,
    label: &str,
    title: Option<&str>,
) -> i32 {
    let e: i32 = sqlx::query_scalar(r#"SELECT id FROM editions WHERE "mediaId" = $1 LIMIT 1"#)
        .bind(media)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    let i: i32 = sqlx::query_scalar(
        r#"INSERT INTO items ("mediaId", "editionId", monitored, title) VALUES ($1, $2, true, $3) RETURNING id"#,
    )
    .bind(media)
    .bind(e)
    .bind(title)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label) VALUES ($1, $2, $3, $4::text::numeric, $5)"#,
    )
    .bind(i)
    .bind(media)
    .bind(kind)
    .bind(sort)
    .bind(label)
    .execute(&c.pool)
    .await
    .unwrap();
    i
}

#[sqlx::test(migrations = false)]
async fn specials_match_by_label_and_never_take_another_specials_rank(pool: PgPool) {
    let mut f = Fake::default();
    f.works.insert("42".into(), work());
    f.children.insert(
        "42".into(),
        vec![
            issue("Prologue", json!(2), "special", Some("Pro"), None),
            issue("Interlude", json!(1), "special", None, None),
        ],
    );
    let c = ctx(pool, Some(Arc::new(f))).await;
    let m = c.local_volume().await;
    add_issue(&c, m, "special", "1", "Special 1", Some("Mine")).await;
    add_issue(&c, m, "special", "100000", "Prologue", Some("Local")).await;
    link(&c, m).await;
    comics::refresh(&c.st, m, Priority::Interactive)
        .await
        .unwrap();
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        r#"SELECT ci."sortNumber"::float8::text, ci.label, i.title FROM comic_issues ci
           JOIN items i ON i.id = ci."itemId" WHERE ci."mediaId" = $1 AND ci.kind = 'special'
           ORDER BY ci."sortNumber""#,
    )
    .bind(m)
    .fetch_all(&c.pool)
    .await
    .unwrap();
    let s = |a: &str, b: &str, t: Option<&str>| (a.to_owned(), b.to_owned(), t.map(Into::into));
    assert_eq!(
        rows,
        [
            s("1", "Special 1", Some("Mine")),
            s("2", "Interlude", None),
            s("100000", "Prologue", Some("Pro")),
        ]
    );
}

#[sqlx::test(migrations = false)]
async fn edits_survive_a_refresh_until_they_are_unlocked(pool: PgPool) {
    let c = ctx(pool, None).await;
    let m = c.local_volume().await;
    link(&c, m).await;
    let item: i32 = sqlx::query_scalar(
        r#"SELECT "itemId" FROM comic_issues WHERE "mediaId" = $1 AND "sortNumber" = 2"#,
    )
    .bind(m)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let title = |c: &Ctx| {
        let pool = c.pool.clone();
        async move {
            sqlx::query_scalar::<_, Option<String>>("SELECT title FROM items WHERE id = $1")
                .bind(item)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    let (s, _) = c
        .call(
            &c.admin,
            "PATCH",
            &format!("/api/comics/issues/{item}"),
            Some(json!({"title": "Mine"})),
        )
        .await;
    assert_eq!(s, 200);
    let (s, _) = c
        .call(
            &c.admin,
            "PATCH",
            &format!("/api/media/{m}/comic"),
            Some(json!({"publisher": "Mine Pub"})),
        )
        .await;
    assert_eq!(s, 200);
    comics::refresh(&c.st, m, Priority::Interactive)
        .await
        .unwrap();
    assert_eq!(title(&c).await.as_deref(), Some("Mine"));
    let publisher = || async {
        sqlx::query_scalar::<_, String>(
            r#"SELECT publisher FROM comic_details WHERE "mediaId" = $1"#,
        )
        .bind(m)
        .fetch_one(&c.pool)
        .await
        .unwrap()
    };
    assert_eq!(publisher().await, "Mine Pub");
    c.call(
        &c.admin,
        "PATCH",
        &format!("/api/comics/issues/{item}"),
        Some(json!({"unlock": ["title"]})),
    )
    .await;
    c.call(
        &c.admin,
        "PATCH",
        &format!("/api/media/{m}/comic"),
        Some(json!({"unlock": ["publisher"]})),
    )
    .await;
    comics::refresh(&c.st, m, Priority::Interactive)
        .await
        .unwrap();
    assert_eq!(title(&c).await.as_deref(), Some("Next"));
    assert_eq!(publisher().await, "Pub House");
}

#[sqlx::test(migrations = false)]
async fn identify_links_the_volume_and_refreshes_it(pool: PgPool) {
    let c = ctx(pool, None).await;
    let m = c.local_volume().await;
    let (s, _) = c
        .call(
            &c.admin,
            "POST",
            &format!("/api/media/{m}/identify"),
            Some(json!({"tmdbId": 5})),
        )
        .await;
    assert_eq!(s, 400);
    let (s, _) = c
        .call(&c.admin, "POST", &format!("/api/media/{m}/refresh"), None)
        .await;
    assert_eq!(s, 400);
    let (s, v) = c
        .call(
            &c.admin,
            "POST",
            &format!("/api/media/{m}/identify"),
            Some(json!({"provider": NS, "externalId": "42"})),
        )
        .await;
    assert_eq!(s, 201, "{v}");
    for _ in 0..100 {
        let done: bool = sqlx::query_scalar(
            r#"SELECT "metadataRefreshedAt" IS NOT NULL FROM media WHERE id = $1"#,
        )
        .bind(m)
        .fetch_one(&c.pool)
        .await
        .unwrap();
        if done {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let (pin, ext): (Option<String>, String) = sqlx::query_as(
        r#"SELECT m."preferredProvider", e.value FROM media m JOIN media_external_ids e ON e."mediaId" = m.id WHERE m.id = $1"#,
    )
    .bind(m)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!((pin.as_deref(), ext.as_str()), (Some(NS), "42"));
    assert_eq!(c.issues(m).await.len(), 5);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
}

#[sqlx::test(migrations = false)]
async fn a_volume_already_in_the_library_is_a_conflict_whoever_made_it(pool: PgPool) {
    let c = ctx(pool, None).await;
    sqlx::query(r#"UPDATE media SET "folderName" = 'Alpha Run' WHERE id = $1"#)
        .bind(c.local_volume().await)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, v) = c.import(json!({})).await;
    assert_eq!(s, 409, "{v}");
    assert!(v["message"].as_str().unwrap().contains("identify"));
    // a second volume of the same title from another id of the same provider
    sqlx::query(r#"DELETE FROM media"#)
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(c.import(json!({})).await.0, 201);
    let (s, _) = c.import(json!({"externalId": "43"})).await;
    assert_eq!(s, 409);
}

#[sqlx::test(migrations = false)]
async fn a_second_provider_keeps_the_sources_of_what_it_did_not_write(pool: PgPool) {
    let c = ctx(pool, None).await;
    let m = c.local_volume().await;
    link(&c, m).await;
    sqlx::query(
        r#"INSERT INTO media_field_sources ("mediaId", field, provider) VALUES ($1, 'authors', 'org.other:x')"#,
    )
    .bind(m)
    .execute(&c.pool)
    .await
    .unwrap();
    comics::refresh(&c.st, m, Priority::Interactive)
        .await
        .unwrap();
    let kept: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM media_field_sources WHERE "mediaId" = $1 AND provider = 'org.other:x'"#,
    )
    .bind(m)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(kept, 1);
}

#[sqlx::test(migrations = false)]
async fn a_homepage_that_is_not_https_is_not_a_link(pool: PgPool) {
    let c = ctx(pool, None).await;
    sqlx::query(r#"UPDATE plugin_packages SET manifest = '{"homepage": "javascript:alert(1)"}'"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, v) = c.import(json!({})).await;
    assert_eq!(v["comic"]["providers"][0]["url"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn a_long_run_imports_in_one_go(pool: PgPool) {
    let mut f = Fake::default();
    f.works.insert("42".into(), work());
    f.children.insert(
        "42".into(),
        (1..=4000)
            .map(|n| issue(&n.to_string(), json!(n.min(9999)), "issue", None, None))
            .collect(),
    );
    let c = ctx(pool, Some(Arc::new(f))).await;
    let (s, v) = c.import(json!({})).await;
    assert_eq!(s, 201);
    assert_eq!(v["comic"]["issues"].as_array().unwrap().len(), 4000);
}

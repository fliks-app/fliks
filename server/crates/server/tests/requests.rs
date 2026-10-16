//! `/api/requests/*` and the request lifecycle (`docs/spec/requests.md`) through the real router, with a fake for
//! the S5 services the flows call (TMDB, import, removal, notifications).
use axum::{Router, body::Body, http::Request};
use fliks_server::{
    app,
    config::Config,
    events::{Bus, DomainEvent},
    requests::{Art, Fut, ImportSpec, Lifecycle, MediaRef, PortError, Ports, Removed, TitleFacts},
    state::AppState,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::broadcast::Receiver;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

#[derive(Default)]
struct Fake {
    facts: Mutex<Option<TitleFacts>>,
    facts_calls: AtomicUsize,
    import_err: Mutex<Option<PortError>>,
    imports: Mutex<Vec<(ImportSpec, Option<i32>)>>,
    remove_err: Mutex<Option<PortError>>,
    art: Mutex<Option<Art>>,
    notified: Mutex<Vec<(String, Value)>>,
}

impl Fake {
    fn notified(&self, event: &str) -> Vec<Value> {
        let all = self.notified.lock().unwrap();
        all.iter()
            .filter(|(e, _)| e == event)
            .map(|(_, p)| p.clone())
            .collect()
    }
}

fn err(status: u16, message: &str) -> PortError {
    PortError {
        status,
        message: message.into(),
    }
}

impl Ports for Fake {
    fn title_facts<'a>(
        &'a self,
        _: &'a AppState,
        _: &'a str,
        _: i32,
    ) -> Fut<'a, Result<TitleFacts, String>> {
        self.facts_calls.fetch_add(1, Ordering::SeqCst);
        let f = self.facts.lock().unwrap().clone();
        Box::pin(async move { f.ok_or_else(|| "TMDB down".to_owned()) })
    }
    fn request_art<'a>(
        &'a self,
        _: &'a AppState,
        _: &'a str,
        _: i32,
    ) -> Fut<'a, Result<Art, String>> {
        let a = self.art.lock().unwrap().clone();
        Box::pin(async move { a.ok_or_else(|| "no art".to_owned()) })
    }
    fn assert_import_target<'a>(
        &'a self,
        _: &'a AppState,
        _: &'a str,
        _: Option<i32>,
    ) -> Fut<'a, Result<(), PortError>> {
        Box::pin(async { Ok(()) })
    }
    /// `importFromTmdb`: 409 for a known title, else a media row and the lifecycle hook.
    fn import_from_tmdb<'a>(
        &'a self,
        st: &'a AppState,
        spec: ImportSpec,
        added_by: Option<i32>,
    ) -> Fut<'a, Result<i32, PortError>> {
        self.imports.lock().unwrap().push((spec.clone(), added_by));
        let forced = self.import_err.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(e) = forced {
                return Err(e);
            }
            let pool = &st.db;
            let known: Option<i32> = sqlx::query_scalar(
                r#"SELECT id FROM media WHERE "tmdbId" = $1 AND type::text = $2"#,
            )
            .bind(spec.tmdb_id)
            .bind(&spec.media_type)
            .fetch_optional(pool)
            .await
            .unwrap();
            if known.is_some() {
                return Err(err(409, "This title is already in the library"));
            }
            let id: i32 = sqlx::query_scalar(
                r#"INSERT INTO media (title, type, "tmdbId", "libraryId", "qualityProfileId", "languageProfileId", monitored)
                VALUES ('Imported', $1::text::media_type_enum, $2, $3, $4, $5, false) RETURNING id"#,
            )
            .bind(&spec.media_type)
            .bind(spec.tmdb_id)
            .bind(spec.library_id)
            .bind(spec.quality_profile_id)
            .bind(spec.language_profile_id)
            .fetch_one(pool)
            .await
            .unwrap();
            if spec.media_type == "series" {
                for n in 1..=3 {
                    sqlx::query(r#"INSERT INTO seasons ("seasonNumber", "mediaId", monitored) VALUES ($1, $2, false)"#)
                        .bind(n)
                        .bind(id)
                        .execute(pool)
                        .await
                        .unwrap();
                }
            }
            let media = MediaRef {
                id,
                media_type: spec.media_type,
                tmdb_id: Some(spec.tmdb_id),
                monitored: false,
            };
            Lifecycle::of(st).on_media_imported(media, added_by).await;
            Ok(id)
        })
    }
    /// `MediaService.remove`: the hook runs in the delete's transaction.
    fn remove_media<'a>(
        &'a self,
        st: &'a AppState,
        media_id: i32,
    ) -> Fut<'a, Result<Removed, PortError>> {
        let forced = self.remove_err.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(e) = forced {
                return Err(e);
            }
            let pool = &st.db;
            let (media_type, tmdb_id): (String, Option<i32>) =
                sqlx::query_as(r#"SELECT type::text, "tmdbId" FROM media WHERE id = $1"#)
                    .bind(media_id)
                    .fetch_one(pool)
                    .await
                    .unwrap();
            let mut tx = pool.begin().await.unwrap();
            let media = MediaRef {
                id: media_id,
                media_type,
                tmdb_id,
                monitored: true,
            };
            Lifecycle::of(st)
                .on_media_removed(&mut tx, &media)
                .await
                .unwrap();
            sqlx::query("DELETE FROM media WHERE id = $1")
                .bind(media_id)
                .execute(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
            Ok(Removed {
                title: "Imported".into(),
                disk_path: None,
            })
        })
    }
    fn delete_media_folder<'a>(
        &'a self,
        _: &'a AppState,
        _: &'a str,
    ) -> Fut<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn notify(&self, _: &AppState, event: &'static str, payload: Map<String, Value>) {
        self.notified
            .lock()
            .unwrap()
            .push((event.into(), Value::Object(payload)));
    }
}

struct Ctx {
    app: Router,
    st: AppState,
    fake: Arc<Fake>,
    rx: Receiver<Arc<Bus>>,
    admin: String,
    user: String,
    other: String,
    validator: String,
}

type SeasonRow = (String, Option<String>, Option<Value>, Option<i32>);

const MOVIES: i32 = 1;
const SERIES: i32 = 2;

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let fake = Arc::new(Fake::default());
    let mut st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    st.requests = fake.clone();
    for (id, name, types) in [
        (MOVIES, "Movies", r#"["movie"]"#),
        (SERIES, "Series", r#"["series"]"#),
    ] {
        sqlx::query(r#"INSERT INTO libraries (id, name, "mediaTypes", path) VALUES ($1, $2, $3::jsonb, $4)"#)
            .bind(id)
            .bind(name)
            .bind(types)
            .bind(format!("/tmp/fliks-requests-test/{name}"))
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut toks = vec![];
    for (name, admin, perms, libs) in [
        ("admin", true, "[]", vec![]),
        (
            "user",
            false,
            r#"["media.read","requests.create"]"#,
            vec![MOVIES, SERIES],
        ),
        (
            "other",
            false,
            r#"["media.read","requests.create"]"#,
            vec![MOVIES, SERIES],
        ),
        (
            "validator",
            false,
            r#"["requests.create","requests.manage"]"#,
            vec![MOVIES],
        ),
    ] {
        let role: i32 = sqlx::query_scalar(
            "INSERT INTO roles (name, permissions) VALUES ($1, $2) RETURNING id",
        )
        .bind(name)
        .bind(perms)
        .fetch_one(&pool)
        .await
        .unwrap();
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin", "roleId") VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();
        for l in libs {
            sqlx::query(
                r#"INSERT INTO library_user_access ("libraryId", "userId") VALUES ($1, $2)"#,
            )
            .bind(l)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        }
        toks.push(st.jwt.sign_access(id, name).unwrap().token);
    }
    let nest = fliks_engine::gateway::Upstream::parse("http://127.0.0.1:1").unwrap();
    let app = app::router(st.clone(), nest, None, "/nonexistent".into(), None);
    Ctx {
        app,
        rx: st.hub.subscribe(),
        st,
        fake,
        validator: toks.pop().unwrap(),
        other: toks.pop().unwrap(),
        user: toks.pop().unwrap(),
        admin: toks.pop().unwrap(),
    }
}

async fn call(c: &Ctx, method: &str, uri: &str, tok: &str, body: Value) -> (u16, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {tok}"));
    if method == "GET" || method == "DELETE" {
        req = req.header("accept", "application/json");
    }
    let res = c
        .app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let b = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

fn domain(c: &mut Ctx) -> Vec<DomainEvent> {
    let mut out = vec![];
    while let Ok(b) = c.rx.try_recv() {
        if let Bus::Domain(d) = &*b {
            out.push(d.clone());
        }
    }
    out
}

async fn q(pool: &PgPool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

async fn rule(c: &Ctx, criteria: Value) {
    let (s, _) = call(
        c,
        "POST",
        "/api/auto-approval-rules",
        &c.admin,
        json!({"name": "r", "criteria": criteria}),
    )
    .await;
    assert_eq!(s, 201);
}

fn rid(v: &Value) -> i64 {
    v["id"].as_i64().unwrap_or_else(|| panic!("{v}"))
}

fn movie(tmdb: i32) -> Value {
    json!({"mediaType": "movie", "tmdbId": tmdb, "title": format!("Movie {tmdb}")})
}

fn series(tmdb: i32, seasons: Value) -> Value {
    json!({"mediaType": "series", "tmdbId": tmdb, "title": format!("Series {tmdb}"), "seasons": seasons})
}

async fn status_of(c: &Ctx, id: i64) -> (String, Option<i64>) {
    let (s, r) = call(
        c,
        "GET",
        &format!("/api/requests/{id}"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(s, 200, "{r}");
    (r["status"].as_str().unwrap().into(), r["mediaId"].as_i64())
}

#[sqlx::test(migrations = false)]
async fn create_with_sole_library_and_no_rule_stays_pending(pool: PgPool) {
    let mut c = ctx(pool).await;
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(10)).await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(
        (r["status"].clone(), r["library"].clone()),
        (json!("pending"), json!({"id": MOVIES}))
    );
    assert_eq!(r["libraryId"], MOVIES);
    assert!(r["approvedBy"].is_null() && r["media"].is_null());
    assert_eq!(
        c.fake.imports.lock().unwrap().len(),
        0,
        "pending requests import nothing"
    );
    assert!(
        matches!(&domain(&mut c)[..], [DomainEvent::RequestCreated { kind, .. }] if kind == "add")
    );
    assert_eq!(
        c.fake.notified("request.created")[0],
        json!({"title": "Movie 10", "mediaType": "movie"})
    );
}

#[sqlx::test(migrations = false)]
async fn auto_approval_by_user_role_and_library_imports_before_inserting(pool: PgPool) {
    let mut c = ctx(pool).await;
    rule(&c, json!({"userIds": [999]})).await;
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(11)).await;
    assert_eq!(s, 201);
    assert_eq!(c.fake.imports.lock().unwrap().len(), 0, "no rule matches");
    rule(&c, json!({"mediaType": "movie", "libraryIds": [MOVIES]})).await;
    let _ = domain(&mut c);
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(12)).await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(r["status"], "approved");
    assert_eq!(r["approvedBy"]["username"], "user");
    assert_eq!(r["media"]["tmdbId"], 12);
    let imports = c.fake.imports.lock().unwrap().clone();
    assert_eq!(imports.len(), 1);
    assert_eq!(
        (imports[0].0.library_id, imports[0].1),
        (Some(MOVIES), r["userId"].as_i64().map(|u| u as i32)),
        "the persisted destination and the requester as importer"
    );
    let ev = domain(&mut c);
    assert!(matches!(
        &ev[..],
        [
            DomainEvent::RequestCreated { .. },
            DomainEvent::RequestApproved {
                media_id: Some(_),
                ..
            }
        ]
    ));
    assert_eq!(c.fake.notified("request.approved").len(), 1);
}

#[sqlx::test(migrations = false)]
async fn metadata_is_fetched_only_when_a_rule_reads_it_and_fails_closed(pool: PgPool) {
    let c = ctx(pool).await;
    rule(&c, json!({"mediaType": "series"})).await;
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, series(20, json!([1]))).await;
    assert_eq!(s, 201);
    assert_eq!(c.fake.facts_calls.load(Ordering::SeqCst), 0);
    rule(&c, json!({"genreIds": [16]})).await;
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(21)).await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(c.fake.facts_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        r["status"], "pending",
        "a failed lookup cannot match a genre criterion"
    );
    *c.fake.facts.lock().unwrap() = Some(TitleFacts {
        genre_ids: vec![16, 18],
        year: Some(2010),
        season_count: Some(2),
    });
    let (_, r) = call(&c, "POST", "/api/requests", &c.user, movie(22)).await;
    assert_eq!(r["status"], "approved");
}

#[sqlx::test(migrations = false)]
async fn max_seasons_counts_the_requested_scope_else_the_show(pool: PgPool) {
    let c = ctx(pool).await;
    rule(&c, json!({"mediaType": "series", "maxSeasons": 2})).await;
    *c.fake.facts.lock().unwrap() = Some(TitleFacts {
        genre_ids: vec![],
        year: None,
        season_count: Some(5),
    });
    let (_, r) = call(
        &c,
        "POST",
        "/api/requests",
        &c.user,
        series(30, json!([1, 2])),
    )
    .await;
    assert_eq!(
        r["status"], "approved",
        "two requested seasons fit the cap, whatever the show has"
    );
    let (_, r) = call(
        &c,
        "POST",
        "/api/requests",
        &c.user,
        series(31, json!([1, 2, 3])),
    )
    .await;
    assert_eq!(r["status"], "pending");
    let (_, r) = call(&c, "POST", "/api/requests", &c.user, series(32, json!([]))).await;
    assert_eq!(
        r["status"], "pending",
        "an empty scope is the whole show of 5 seasons (C-REQ-2)"
    );
    let (_, r) = call(&c, "POST", "/api/requests", &c.user, movie(33)).await;
    assert_eq!(r["status"], "pending", "the rule is for series");
}

#[sqlx::test(migrations = false)]
async fn a_failed_import_aborts_the_create(pool: PgPool) {
    let c = ctx(pool).await;
    rule(&c, json!({})).await;
    *c.fake.import_err.lock().unwrap() = Some(err(400, "TMDB API key is not configured"));
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(40)).await;
    assert_eq!(s, 400);
    let (_, list) = call(&c, "GET", "/api/requests", &c.admin, json!(null)).await;
    assert_eq!(list["total"], 0, "nothing inserted");
}

#[sqlx::test(migrations = false)]
async fn quota_counts_only_pending_and_approved_adds_and_blocks_at_the_limit(pool: PgPool) {
    let c = ctx(pool).await;
    q(
        &c.pool(),
        r#"UPDATE users SET "movieQuotaLimit" = 2 WHERE username = 'user'"#,
    )
    .await;
    for t in [50, 51] {
        let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(t)).await;
        assert_eq!(s, 201);
    }
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(52)).await;
    assert_eq!(
        (s, r["message"].clone()),
        (
            403,
            json!("Quota exceeded: 2/2 movie requests in last 7 days")
        )
    );
    // a request that moved on or was declined stops counting; a series is another quota
    q(
        &c.pool(),
        r#"UPDATE requests SET status = 'processing' WHERE "tmdbId" = 50"#,
    )
    .await;
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(52)).await;
    assert_eq!(s, 201);
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, series(53, json!([1]))).await;
    assert_eq!(s, 201);
}

#[sqlx::test(migrations = false)]
async fn duplicates_series_seasons_and_profile_lock(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), "INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'HD', 1, '[]'), (2, 'SD', 1, '[]')").await;
    let mut first = series(60, json!([1, 2]));
    first["qualityProfileId"] = json!(1);
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, first).await;
    assert_eq!(s, 201);
    let (s, r) = call(
        &c,
        "POST",
        "/api/requests",
        &c.other,
        series(60, json!([2, 3, 1, 2])),
    )
    .await;
    assert_eq!(
        (s, r["message"].clone()),
        (409, json!("Season(s) 2, 1, 2 have already been requested"))
    );
    let mut third = series(60, json!([3]));
    third["qualityProfileId"] = json!(2);
    let (s, r) = call(&c, "POST", "/api/requests", &c.other, third).await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(
        r["qualityProfileId"], 1,
        "the series keeps the profile of its first request"
    );
    let (s, r) = call(
        &c,
        "POST",
        "/api/requests",
        &c.other,
        json!({"mediaType": "series", "tmdbId": 60, "title": "t"}),
    )
    .await;
    assert_eq!(
        (s, r["message"].clone()),
        (409, json!("This title has already been requested"))
    );
    q(
        &c.pool(),
        "UPDATE requests SET seasons = NULL WHERE seasons = '[1,2]'",
    )
    .await;
    let (s, r) = call(
        &c,
        "POST",
        "/api/requests",
        &c.other,
        series(60, json!([4])),
    )
    .await;
    assert_eq!(
        (s, r["message"].clone()),
        (409, json!("The whole series has already been requested"))
    );
}

#[sqlx::test(migrations = false)]
async fn title_state_and_the_add_path_ignore_delete_rows(pool: PgPool) {
    let c = ctx(pool).await;
    q(
        &c.pool(),
        r#"INSERT INTO media (title, type, "tmdbId", "libraryId") VALUES ('M', 'movie', 70, 1)"#,
    )
    .await;
    let (s, r) = call(
        &c,
        "POST",
        "/api/requests",
        &c.user,
        json!({"mediaType": "movie", "kind": "delete", "tmdbId": 70, "title": "M"}),
    )
    .await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(
        (
            r["kind"].clone(),
            r["library"].clone(),
            r["media"]["path"].clone()
        ),
        (json!("delete"), json!({"id": 1}), Value::Null)
    );
    let (_, st) = call(
        &c,
        "GET",
        "/api/requests/title-state?tmdbId=70&mediaType=movie",
        &c.user,
        json!(null),
    )
    .await;
    assert_eq!(st["requested"], false);
    let (s, _) = call(&c, "POST", "/api/requests", &c.other, movie(70)).await;
    assert_eq!(s, 201, "an add request is not blocked by a delete row");
    let (s, r) = call(
        &c,
        "POST",
        "/api/requests",
        &c.other,
        json!({"mediaType": "movie", "kind": "delete", "tmdbId": 70, "title": "M"}),
    )
    .await;
    assert_eq!(
        (s, r["message"].clone()),
        (
            409,
            json!("A deletion request for this title is already pending")
        )
    );
}

#[sqlx::test(migrations = false)]
async fn delete_request_approve_removes_the_media_and_resolves_every_duplicate(pool: PgPool) {
    let mut c = ctx(pool).await;
    q(&c.pool(), r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId") VALUES (7, 'M', 'movie', 71, 1)"#).await;
    let del = json!({"mediaType": "movie", "kind": "delete", "tmdbId": 71, "title": "M"});
    let (_, a) = call(&c, "POST", "/api/requests", &c.user, del.clone()).await;
    // a concurrent duplicate the dedup could not prevent
    q(
        &c.pool(),
        r#"INSERT INTO requests ("userId", kind, "mediaType", "tmdbId", title, status, "mediaId")
        SELECT "userId", 'delete', 'movie', 71, 'M', 'pending', 7 FROM requests LIMIT 1"#,
    )
    .await;
    let id = rid(&a);
    let (s, r) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/approve"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(
        (s, r["status"].clone(), r["mediaId"].clone()),
        (201, json!("approved"), Value::Null),
        "{r}"
    );
    let gone: i64 = sqlx::query_scalar("SELECT count(*) FROM media WHERE id = 7")
        .fetch_one(&c.pool())
        .await
        .unwrap();
    assert_eq!(gone, 0);
    let open: i64 = sqlx::query_scalar("SELECT count(*) FROM requests WHERE status = 'pending'")
        .fetch_one(&c.pool())
        .await
        .unwrap();
    assert_eq!(open, 0, "the duplicate is done with it");
    assert_eq!(c.fake.notified("request.delete.approved").len(), 1);
    assert!(
        domain(&mut c)
            .iter()
            .all(|e| !matches!(e, DomainEvent::RequestApproved { .. })),
        "no request.approved for a delete"
    );
}

#[sqlx::test(migrations = false)]
async fn delete_request_rolls_back_when_the_removal_fails(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId") VALUES (8, 'M', 'movie', 72, 1)"#).await;
    let del = json!({"mediaType": "movie", "kind": "delete", "tmdbId": 72, "title": "M"});
    let (_, a) = call(&c, "POST", "/api/requests", &c.user, del).await;
    let id = rid(&a);
    *c.fake.remove_err.lock().unwrap() = Some(err(500, "boom"));
    let (s, _) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/approve"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(s, 500);
    assert_eq!(status_of(&c, id).await.0, "pending");
    let (_, d) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/decline"),
        &c.admin,
        json!({"reason": "keep"}),
    )
    .await;
    assert_eq!(d["status"], "declined");
    assert_eq!(
        c.fake.notified("request.delete.declined")[0],
        json!({"title": "M", "reason": "keep"})
    );
}

#[sqlx::test(migrations = false)]
async fn approve_imports_for_the_requester_links_and_announces_once(pool: PgPool) {
    let mut c = ctx(pool).await;
    let (_, a) = call(&c, "POST", "/api/requests", &c.user, movie(80)).await;
    let id = rid(&a);
    let _ = domain(&mut c);
    let (s, r) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/approve"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(
        (r["status"].clone(), r["approvedBy"]["username"].clone()),
        (json!("approved"), json!("admin"))
    );
    assert_eq!(r["media"]["tmdbId"], 80);
    let imports = c.fake.imports.lock().unwrap().clone();
    assert_eq!(
        imports[0].1,
        a["userId"].as_i64().map(|u| u as i32),
        "the requester is the importer"
    );
    let reasons: Vec<String> = domain(&mut c)
        .into_iter()
        .filter_map(|e| match e {
            DomainEvent::MediaAcquisitionRequested { reason, .. } => Some(reason),
            _ => None,
        })
        .collect();
    assert_eq!(reasons, ["media-imported", "request-approved"]);
    assert_eq!(
        c.fake.notified("request.approved").last().unwrap(),
        &json!({"title": "Movie 80"})
    );
    let (s, _) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/approve"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(s, 409);
}

#[sqlx::test(migrations = false)]
async fn approve_rolls_back_on_an_import_error(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = call(&c, "POST", "/api/requests", &c.user, movie(81)).await;
    let id = rid(&a);
    *c.fake.import_err.lock().unwrap() = Some(err(503, "down"));
    let (s, _) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/approve"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(s, 503);
    let (_, r) = call(
        &c,
        "GET",
        &format!("/api/requests/{id}"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(
        (r["status"].clone(), r["approvedById"].clone()),
        (json!("pending"), Value::Null)
    );
}

#[sqlx::test(migrations = false)]
async fn existing_media_is_reused_only_when_its_profiles_cover_the_request(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), "INSERT INTO language_profiles (id, name, \"audioLanguages\") VALUES (101, 'EN', '[{\"isoCode\":\"en\",\"name\":\"English\"}]'), (102, 'FR', '[{\"isoCode\":\"fr\",\"name\":\"French\"}]')").await;
    q(&c.pool(), r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId", "languageProfileId", monitored) VALUES (9, 'M', 'movie', 82, 1, 101, false)"#).await;
    let mut body = movie(82);
    body["languageProfileId"] = json!(102);
    let (_, a) = call(&c, "POST", "/api/requests", &c.user, body).await;
    let id = rid(&a);
    let (s, r) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/approve"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(s, 409, "{r}");
    assert!(
        r["message"]
            .as_str()
            .unwrap()
            .starts_with("This title is already in the library with a different profile")
    );
    assert_eq!(status_of(&c, id).await.0, "pending");
    q(&c.pool(), "UPDATE requests SET \"languageProfileId\" = 101").await;
    let (s, r) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/approve"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!((s, r["mediaId"].clone()), (201, json!(9)), "{r}");
    let monitored: bool = sqlx::query_scalar("SELECT monitored FROM media WHERE id = 9")
        .fetch_one(&c.pool())
        .await
        .unwrap();
    assert!(monitored, "the request scope is monitored");
}

#[sqlx::test(migrations = false)]
async fn series_import_monitors_the_requested_seasons_only(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = call(&c, "POST", "/api/requests", &c.user, series(83, json!([2]))).await;
    let id = rid(&a);
    let (s, _) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/approve"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(s, 201);
    let m: Vec<(i32, bool)> =
        sqlx::query_as(r#"SELECT "seasonNumber", monitored FROM seasons ORDER BY 1"#)
            .fetch_all(&c.pool())
            .await
            .unwrap();
    assert_eq!(m, [(1, false), (2, true), (3, false)]);
}

#[sqlx::test(migrations = false)]
async fn on_media_imported_adopts_only_covered_requests(pool: PgPool) {
    let mut c = ctx(pool).await;
    q(&c.pool(), "INSERT INTO language_profiles (id, name, \"audioLanguages\") VALUES (101, 'EN', '[{\"isoCode\":\"en\",\"name\":\"English\"}]'), (102, 'FR', '[{\"isoCode\":\"fr\",\"name\":\"French\"}]')").await;
    let mut fr = movie(90);
    fr["languageProfileId"] = json!(102);
    let (_, fr) = call(&c, "POST", "/api/requests", &c.user, fr).await;
    // a second row for the title: the duplicate guard stops it through the API
    q(
        &c.pool(),
        r#"INSERT INTO requests ("userId", kind, "mediaType", "tmdbId", title, status, "libraryId")
        VALUES (1, 'add', 'movie', 90, 'M', 'pending', 1)"#,
    )
    .await;
    let any = json!({"id": 2});
    let _ = domain(&mut c);
    q(&c.pool(), r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId", "languageProfileId", monitored) VALUES (11, 'M', 'movie', 90, 1, 101, false)"#).await;
    let lc = Lifecycle::of(&c.st);
    lc.on_media_imported(
        MediaRef {
            id: 11,
            media_type: "movie".into(),
            tmdb_id: Some(90),
            monitored: false,
        },
        Some(1),
    )
    .await;
    let (st, linked) = status_of(&c, rid(&any)).await;
    assert_eq!((st.as_str(), linked), ("approved", Some(11)));
    let (st, linked) = status_of(&c, rid(&fr)).await;
    assert_eq!(
        (st.as_str(), linked),
        ("pending", None),
        "an EN library row never satisfies a FR request"
    );
    let ev = domain(&mut c);
    assert!(
        matches!(&ev[..], [DomainEvent::MediaAcquisitionRequested { reason, .. }] if reason == "media-imported")
    );
    // nothing adopted, nothing announced
    lc.on_media_imported(
        MediaRef {
            id: 11,
            media_type: "movie".into(),
            tmdb_id: Some(1234),
            monitored: false,
        },
        None,
    )
    .await;
    assert!(domain(&mut c).is_empty());
}

#[sqlx::test(migrations = false)]
async fn removal_declines_add_rows_resolves_delete_rows_and_keeps_available(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId") VALUES (12, 'M', 'movie', 91, 1)"#).await;
    for (kind, status) in [
        ("add", "pending"),
        ("add", "processing"),
        ("add", "available"),
        ("delete", "pending"),
    ] {
        q(&c.pool(), &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", "tmdbId", title, status, "mediaId")
            VALUES (1, '{kind}', 'movie', 91, 'M', '{status}', 12)"#)).await;
    }
    let mut conn = c.pool().acquire().await.unwrap();
    Lifecycle::of(&c.st)
        .on_media_removed(
            &mut conn,
            &MediaRef {
                id: 12,
                media_type: "movie".into(),
                tmdb_id: Some(91),
                monitored: true,
            },
        )
        .await
        .unwrap();
    let rows: Vec<(String, String, Option<String>, Option<i32>)> = sqlx::query_as(
        r#"SELECT kind::text, status::text, "declinedReason", "mediaId" FROM requests ORDER BY id"#,
    )
    .fetch_all(&c.pool())
    .await
    .unwrap();
    let declined = Some("Media removed from library".to_owned());
    assert_eq!(
        rows,
        [
            ("add".into(), "declined".into(), declined.clone(), None),
            ("add".into(), "declined".into(), declined, None),
            ("add".into(), "available".into(), None, Some(12)),
            ("delete".into(), "approved".into(), None, None),
        ]
    );
}

#[sqlx::test(migrations = false)]
async fn unmonitoring_declines_linked_adds_and_trims_season_scopes(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId") VALUES (13, 'S', 'series', 92, 2)"#).await;
    for seasons in ["NULL", "'[1]'", "'[1,2]'"] {
        q(&c.pool(), &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", "tmdbId", title, status, "mediaId", seasons)
            VALUES (1, 'add', 'series', 92, 'S', 'approved', 13, {seasons})"#)).await;
    }
    let lc = Lifecycle::of(&c.st);
    let media = MediaRef {
        id: 13,
        media_type: "series".into(),
        tmdb_id: Some(92),
        monitored: true,
    };
    lc.on_season_monitor_change(media.clone(), 1, true, false)
        .await;
    lc.on_season_monitor_change(media.clone(), 2, false, false)
        .await;
    let rows: Vec<SeasonRow> = sqlx::query_as(
        r#"SELECT status::text, "declinedReason", seasons, "mediaId" FROM requests ORDER BY id"#,
    )
    .fetch_all(&c.pool())
    .await
    .unwrap();
    assert_eq!(
        rows,
        [
            ("approved".into(), None, None, Some(13)),
            (
                "declined".into(),
                Some("Season 1 was unmonitored".into()),
                Some(json!([1])),
                None
            ),
            ("approved".into(), None, Some(json!([2])), Some(13)),
        ]
    );
    lc.on_media_monitor_change(
        MediaRef {
            monitored: true,
            ..media.clone()
        },
        true,
    )
    .await;
    let open: i64 = sqlx::query_scalar("SELECT count(*) FROM requests WHERE status = 'approved'")
        .fetch_one(&c.pool())
        .await
        .unwrap();
    assert_eq!(open, 2, "still monitored");
    lc.on_media_monitor_change(
        MediaRef {
            monitored: false,
            ..media
        },
        true,
    )
    .await;
    let reason: Option<String> =
        sqlx::query_scalar(r#"SELECT "declinedReason" FROM requests WHERE id = 1"#)
            .fetch_one(&c.pool())
            .await
            .unwrap();
    assert_eq!(reason.as_deref(), Some("Media was unmonitored"));
}

#[sqlx::test(migrations = false)]
async fn grabs_move_approved_requests_to_processing_by_season(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId") VALUES (14, 'S', 'series', 93, 2)"#).await;
    for seasons in ["NULL", "'[1]'", "'[2]'"] {
        q(&c.pool(), &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", "tmdbId", title, status, "mediaId", seasons)
            VALUES (1, 'add', 'series', 93, 'S', 'approved', 14, {seasons})"#)).await;
    }
    Lifecycle::of(&c.st)
        .mark_in_progress(14, Some(2))
        .await
        .unwrap();
    let st: Vec<String> = sqlx::query_scalar("SELECT status::text FROM requests ORDER BY id")
        .fetch_all(&c.pool())
        .await
        .unwrap();
    assert_eq!(st, ["processing", "approved", "processing"]);
    assert_eq!(c.fake.notified("request.processing").len(), 2);
}

async fn episode(
    pool: &PgPool,
    season: i32,
    number: i32,
    end: Option<i32>,
    has_file: bool,
    monitored: bool,
) {
    sqlx::query(
        r#"INSERT INTO episodes ("episodeNumber", "endEpisodeNumber", title, "hasFile", monitored, "seasonId")
        VALUES ($1, $2, 'e', $3, $4, (SELECT id FROM seasons WHERE "mediaId" = 15 AND "seasonNumber" = $5))"#,
    ).bind(number).bind(end).bind(has_file).bind(monitored).bind(season).execute(pool).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn import_complete_makes_requests_available_when_the_scope_is_on_disk(pool: PgPool) {
    let c = ctx(pool).await;
    let p = c.pool();
    q(&p, r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId") VALUES (15, 'S', 'series', 94, 2)"#).await;
    q(&p, r#"INSERT INTO seasons ("seasonNumber", "mediaId", monitored) VALUES (1, 15, true), (2, 15, true), (3, 15, false)"#).await;
    // season 1: a two-episode file covers E2; season 2: E2 is missing
    episode(&p, 1, 1, None, true, true).await;
    episode(&p, 1, 2, None, false, true).await;
    episode(&p, 2, 1, None, true, true).await;
    episode(&p, 2, 2, None, false, true).await;
    q(&p, r#"UPDATE episodes SET "endEpisodeNumber" = 2 WHERE "episodeNumber" = 1 AND "seasonId" = (SELECT id FROM seasons WHERE "seasonNumber" = 1)"#).await;
    for seasons in ["'[1]'", "'[2]'", "'[3]'", "NULL"] {
        q(&p, &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", "tmdbId", title, status, "mediaId", seasons)
            VALUES (1, 'add', 'series', 94, 'S', 'processing', 15, {seasons})"#)).await;
    }
    Lifecycle::of(&c.st).on_import_complete(15).await.unwrap();
    let st: Vec<String> = sqlx::query_scalar("SELECT status::text FROM requests ORDER BY id")
        .fetch_all(&p)
        .await
        .unwrap();
    assert_eq!(
        st,
        ["available", "processing", "processing", "processing"],
        "season 2 lacks E2, season 3 is unmonitored (nothing to check is not delivered), the whole show lacks season 2"
    );
    assert_eq!(c.fake.notified("request.available").len(), 1);
}

#[sqlx::test(migrations = false)]
async fn import_complete_needs_a_file_for_a_movie(pool: PgPool) {
    let c = ctx(pool).await;
    let p = c.pool();
    q(&p, r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId") VALUES (16, 'M', 'movie', 95, 1)"#).await;
    q(&p, r#"INSERT INTO requests ("userId", kind, "mediaType", "tmdbId", title, status, "mediaId") VALUES (1, 'add', 'movie', 95, 'M', 'approved', 16)"#).await;
    let lc = Lifecycle::of(&c.st);
    lc.on_import_complete(16).await.unwrap();
    assert_eq!(status_of(&c, 1).await.0, "approved");
    q(&p, r#"INSERT INTO media_files ("relativePath", size, quality, language, "streamInfo", "mediaId") VALUES ('m.mkv', 1, 'WEBDL-1080p', 'en', '{}', 16)"#).await;
    lc.on_import_complete(16).await.unwrap();
    assert_eq!(status_of(&c, 1).await.0, "available");
}

#[sqlx::test(migrations = false)]
async fn the_event_subscriptions_drive_the_lifecycle(pool: PgPool) {
    let c = ctx(pool).await;
    let p = c.pool();
    fliks_server::requests::spawn(&c.st);
    q(&p, r#"INSERT INTO media (id, title, type, "tmdbId", "libraryId") VALUES (17, 'M', 'movie', 96, 1)"#).await;
    q(&p, r#"INSERT INTO media_files ("relativePath", size, quality, language, "streamInfo", "mediaId") VALUES ('m.mkv', 1, 'WEBDL-1080p', 'en', '{}', 17)"#).await;
    q(&p, r#"INSERT INTO requests ("userId", kind, "mediaType", "tmdbId", title, status, "mediaId") VALUES (1, 'add', 'movie', 96, 'M', 'approved', 17)"#).await;
    c.st.hub.emit_domain(DomainEvent::AcquisitionGrabbed {
        media_id: 17,
        season_number: None,
        episode_number: None,
    });
    wait_status(&c, 1, "processing").await;
    c.st.hub
        .emit(fliks_server::events::SseEvent::ImportComplete {
            media_id: 17,
            title: "M".into(),
            season_number: None,
            episode_number: None,
        });
    wait_status(&c, 1, "available").await;
}

async fn wait_status(c: &Ctx, id: i64, want: &str) {
    for _ in 0..100 {
        if status_of(c, id).await.0 == want {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    panic!("request {id} never became {want}");
}

#[sqlx::test(migrations = false)]
async fn art_lands_in_the_response_and_a_failure_is_swallowed(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(100)).await;
    assert_eq!(
        (s, r["posterUrl"].clone()),
        (201, Value::Null),
        "a failed prefetch leaves the art empty"
    );
    *c.fake.art.lock().unwrap() = Some(Art {
        poster: Some("/api/images/request/movie-101/poster?v=1".into()),
        fanart: None,
    });
    let (_, r) = call(&c, "POST", "/api/requests", &c.user, movie(101)).await;
    assert_eq!(
        (r["posterUrl"].clone(), r["fanartUrl"].clone()),
        (
            json!("/api/images/request/movie-101/poster?v=1"),
            Value::Null
        )
    );
    let (_, l) = call(&c, "GET", "/api/requests?tmdbId=101", &c.admin, json!(null)).await;
    assert_eq!(
        l["data"][0]["posterUrl"], "/api/images/request/movie-101/poster?v=1",
        "stored too"
    );
}

#[sqlx::test(migrations = false)]
async fn visibility_follows_ownership_manager_and_library_access(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, mine) = call(&c, "POST", "/api/requests", &c.user, movie(110)).await;
    let (_, tv) = call(
        &c,
        "POST",
        "/api/requests",
        &c.user,
        series(111, json!([1])),
    )
    .await;
    let (id, tv_id) = (rid(&mine), rid(&tv));
    let get = |tok: &str, id: i64| {
        let uri = format!("/api/requests/{id}");
        let tok = tok.to_owned();
        let c = &c;
        async move { call(c, "GET", &uri, &tok, json!(null)).await }
    };
    assert_eq!(get(&c.other, id).await.0, 403);
    assert_eq!(
        get(&c.validator, id).await.0,
        200,
        "managers read any request of a library they reach"
    );
    let (s, r) = get(&c.validator, tv_id).await;
    assert_eq!(
        (s, r["message"].clone()),
        (
            403,
            json!("You do not have access to this request's target library")
        )
    );
    assert_eq!(get(&c.user, tv_id).await.0, 200, "the owner keeps access");
    let (_, l) = call(&c, "GET", "/api/requests", &c.validator, json!(null)).await;
    assert_eq!(l["total"], 1);
    let (_, l) = call(&c, "GET", "/api/requests?userId=1", &c.user, json!(null)).await;
    assert_eq!(l["total"], 2, "a non-manager's userId filter is ignored");
    let (s, _) = call(
        &c,
        "POST",
        &format!("/api/requests/{tv_id}/approve"),
        &c.validator,
        json!(null),
    )
    .await;
    assert_eq!(s, 403);
}

#[sqlx::test(migrations = false)]
async fn two_approvals_cannot_both_import(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = call(&c, "POST", "/api/requests", &c.user, movie(120)).await;
    let id = rid(&a);
    let uri = format!("/api/requests/{id}/approve");
    let (x, y) = tokio::join!(
        call(&c, "POST", &uri, &c.admin, json!(null)),
        call(&c, "POST", &uri, &c.admin, json!(null)),
    );
    let mut codes = [x.0, y.0];
    codes.sort_unstable();
    assert_eq!(codes, [201, 409]);
    assert_eq!(c.fake.imports.lock().unwrap().len(), 1);
}

impl Ctx {
    fn pool(&self) -> PgPool {
        self.st.db.clone()
    }
}

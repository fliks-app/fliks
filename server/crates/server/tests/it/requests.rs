//! `/api/requests/*` and the request lifecycle (`docs/spec/requests.md`) through the real router, with a loopback
//! stub for TMDB and the image host and a local listener for the webhook notifications.
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use fliks_domain::media::kind::MediaKind;
use fliks_server::{
    app,
    config::Config,
    events::{Bus, DomainEvent},
    images::ImageStore,
    requests::{Lifecycle, MediaRef, TitleFacts},
    state::AppState,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::broadcast::Receiver;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

/// TMDB for any id: the details follow `facts` (a plain title without), `down` ids answer 503.
#[derive(Default)]
struct Tmdb {
    facts: Mutex<Option<TitleFacts>>,
    down: Mutex<HashSet<i32>>,
}

impl Tmdb {
    fn seasons(&self) -> i32 {
        let f = self.facts.lock().unwrap();
        f.as_ref().and_then(|f| f.season_count).unwrap_or(3)
    }
}

fn unavailable() -> Response {
    StatusCode::SERVICE_UNAVAILABLE.into_response()
}

async fn details(State(t): State<Arc<Tmdb>>, Path((kind, id)): Path<(String, i32)>) -> Response {
    if t.down.lock().unwrap().contains(&id) {
        return unavailable();
    }
    let facts = t.facts.lock().unwrap().clone().unwrap_or_default();
    let genres: Vec<Value> = facts
        .genre_ids
        .iter()
        .map(|g| json!({"id": g, "name": format!("g{g}")}))
        .collect();
    let date = facts
        .year
        .map_or("2020-01-01".into(), |y| format!("{y}-01-01"));
    let mut body = json!({
        "id": id, "overview": "o", "genres": genres, "poster_path": "/p.jpg", "status": "Released",
        "runtime": 100, "credits": {"cast": [], "crew": []},
    });
    if kind == "movie" {
        body["title"] = json!(format!("Movie {id}"));
        body["release_date"] = json!(date);
    } else {
        body["name"] = json!(format!("Series {id}"));
        body["first_air_date"] = json!(date);
        body["number_of_seasons"] = json!(t.seasons());
        body["seasons"] = (1..=t.seasons())
            .map(|n| json!({"season_number": n, "episode_count": 1}))
            .collect();
    }
    Json(body).into_response()
}

async fn season(State(t): State<Arc<Tmdb>>, Path((id, n)): Path<(i32, i32)>) -> Response {
    if t.down.lock().unwrap().contains(&id) {
        return unavailable();
    }
    Json(json!({
        "season_number": n,
        "episodes": [{"episode_number": 1, "name": "E1", "air_date": "2020-01-01", "runtime": 40}],
    }))
    .into_response()
}

async fn poster() -> impl IntoResponse {
    let img = image::RgbImage::from_fn(60, 90, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 3])
    });
    let mut out = vec![];
    image::DynamicImage::ImageRgb8(img)
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    ([("content-type", "image/jpeg")], out)
}

/// The webhook the notification connection posts to.
#[derive(Default)]
struct Hook(Mutex<Vec<Value>>);

async fn capture(State(h): State<Arc<Hook>>, Json(b): Json<Value>) -> StatusCode {
    h.0.lock().unwrap().push(b);
    StatusCode::OK
}

async fn serve(router: Router) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async { axum::serve(l, router).await.unwrap() });
    base
}

struct Ctx {
    app: Router,
    st: AppState,
    tmdb: Arc<Tmdb>,
    hook: Arc<Hook>,
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
    ctx_with_key(pool, true).await
}

async fn ctx_with_key(pool: PgPool, tmdb_key: bool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let tmdb = Arc::new(Tmdb::default());
    let base = serve(
        Router::new()
            .route("/tmdb/3/{kind}/{id}", get(details))
            .route("/tmdb/3/tv/{id}/season/{n}", get(season))
            .route("/img/t/p/{*file}", get(poster))
            .with_state(tmdb.clone()),
    )
    .await;
    let hook = Arc::new(Hook::default());
    let hook_base = serve(
        Router::new()
            .route("/hook", post(capture))
            .with_state(hook.clone()),
    )
    .await;
    let cfg = Config::from_lookup(|k| match k {
        "TMDB_API_KEY" if tmdb_key => Some("tmdb-test-key".into()),
        "FLIKS_TMDB_API_URL" => Some(format!("{base}/tmdb/3")),
        "FLIKS_TMDB_IMAGE_URL" => Some(format!("{base}/img/t/p")),
        _ => None,
    });
    let mut st = AppState::new(pool.clone(), cfg, SECRET);
    let data = std::env::temp_dir().join(format!(
        "fliks-requests-{}",
        fliks_server::config::random_hex(6)
    ));
    st.images = Arc::new(ImageStore::with_root(data, &format!("{base}/img/t/p")));
    sqlx::query(
        r#"INSERT INTO notification_connections (name, type, settings, events, enabled)
           VALUES ('hook', 'webhook', $1, $2, true)"#,
    )
    .bind(json!({"url": format!("{hook_base}/hook")}))
    .bind(json!([
        "request.created",
        "request.approved",
        "request.declined",
        "request.processing",
        "request.available",
        "request.delete.created",
        "request.delete.approved",
        "request.delete.declined"
    ]))
    .execute(&pool)
    .await
    .unwrap();
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
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    Ctx {
        app,
        rx: st.hub.subscribe(),
        st,
        tmdb,
        hook,
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
    sqlx::query(sqlx::AssertSqlSafe(sql))
        .execute(pool)
        .await
        .unwrap();
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
    assert!(
        c.imports().await.is_empty(),
        "pending requests import nothing"
    );
    assert!(
        matches!(&domain(&mut c)[..], [DomainEvent::RequestCreated { kind, .. }] if kind == "add")
    );
    assert_eq!(
        c.notified("request.created").await[0],
        json!({"title": "Movie 10", "mediaType": "movie"})
    );
}

#[sqlx::test(migrations = false)]
async fn auto_approval_by_user_role_and_library_imports_before_inserting(pool: PgPool) {
    let mut c = ctx(pool).await;
    rule(&c, json!({"userIds": [999]})).await;
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(11)).await;
    assert_eq!(s, 201);
    assert!(c.imports().await.is_empty(), "no rule matches");
    rule(&c, json!({"mediaType": "movie", "libraryIds": [MOVIES]})).await;
    let _ = domain(&mut c);
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(12)).await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(r["status"], "approved");
    assert_eq!(r["approvedBy"]["username"], "user");
    assert_eq!(r["media"]["tmdbId"], 12);
    let imports = c.imports().await;
    assert_eq!(imports.len(), 1);
    assert_eq!(
        imports[0],
        (Some(MOVIES), r["userId"].as_i64().map(|u| u as i32)),
        "the persisted destination and the requester as importer"
    );
    let ev: Vec<DomainEvent> = domain(&mut c)
        .into_iter()
        .filter(|e| {
            matches!(
                e,
                DomainEvent::RequestCreated { .. } | DomainEvent::RequestApproved { .. }
            )
        })
        .collect();
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
    assert_eq!(c.notified("request.approved").await.len(), 1);
}

#[sqlx::test(migrations = false)]
async fn a_metadata_rule_fails_closed_when_tmdb_is_unavailable(pool: PgPool) {
    let c = ctx(pool).await;
    rule(&c, json!({"genreIds": [16]})).await;
    c.tmdb.down.lock().unwrap().insert(21);
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(21)).await;
    assert_eq!(s, 201, "{r}");
    assert_eq!(
        r["status"], "pending",
        "a failed lookup cannot match a genre criterion"
    );
    *c.tmdb.facts.lock().unwrap() = Some(TitleFacts {
        genre_ids: vec![16, 18],
        year: Some(2010),
        season_count: Some(2),
    });
    let (_, r) = call(&c, "POST", "/api/requests", &c.user, movie(22)).await;
    assert_eq!(r["status"], "approved");
}

#[sqlx::test(migrations = false)]
async fn without_a_tmdb_key_an_approval_is_refused_and_a_metadata_rule_fails_closed(pool: PgPool) {
    let c = ctx_with_key(pool, false).await;
    rule(&c, json!({"genreIds": [16]})).await;
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(23)).await;
    assert_eq!((s, r["status"].clone()), (201, json!("pending")));
    rule(&c, json!({})).await;
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(24)).await;
    assert_eq!(
        (s, r["message"].clone()),
        (400, json!("TMDB API key is not configured"))
    );
    let (_, list) = call(&c, "GET", "/api/requests?tmdbId=24", &c.admin, json!(null)).await;
    assert_eq!(list["total"], 0, "the failed import aborted the create");
}

#[sqlx::test(migrations = false)]
async fn max_seasons_counts_the_requested_scope_else_the_show(pool: PgPool) {
    let c = ctx(pool).await;
    rule(&c, json!({"mediaType": "series", "maxSeasons": 2})).await;
    *c.tmdb.facts.lock().unwrap() = Some(TitleFacts {
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
        "an empty scope is the whole show of 5 seasons"
    );
    let (_, r) = call(&c, "POST", "/api/requests", &c.user, movie(33)).await;
    assert_eq!(r["status"], "pending", "the rule is for series");
}

#[sqlx::test(migrations = false)]
async fn a_failed_import_aborts_the_create(pool: PgPool) {
    let c = ctx(pool).await;
    rule(&c, json!({})).await;
    c.tmdb.down.lock().unwrap().insert(40);
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(40)).await;
    assert_eq!(s, 500, "TMDB answering 503 is a generic 500");
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
        r#"UPDATE requests SET status = 'processing' WHERE "externalId" = '50'"#,
    )
    .await;
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(52)).await;
    assert_eq!(s, 201);
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, series(53, json!([1]))).await;
    assert_eq!(s, 201);
}

#[sqlx::test(migrations = false)]
async fn the_quota_window_is_the_period_in_24_hour_days(pool: PgPool) {
    let c = ctx(pool).await;
    q(
        &c.pool(),
        r#"UPDATE users SET "movieQuotaLimit" = 1, "quotaPeriodDays" = 3 WHERE username = 'user'"#,
    )
    .await;
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(55)).await;
    assert_eq!(s, 201);
    for (age, want) in [("71 hours", 403), ("73 hours", 201)] {
        q(
            &c.pool(),
            &format!(
                r#"UPDATE requests SET "createdAt" = now() - interval '{age}' WHERE "externalId" = '55'"#
            ),
        )
        .await;
        let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(56)).await;
        assert_eq!(s, want, "{age}");
        q(
            &c.pool(),
            r#"DELETE FROM requests WHERE "externalId" = '56'"#,
        )
        .await;
    }
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
async fn concurrent_creates_of_one_title_leave_a_single_active_request(pool: PgPool) {
    let c = ctx(pool).await;
    let (a, b, d, e) = tokio::join!(
        call(&c, "POST", "/api/requests", &c.user, movie(90)),
        call(&c, "POST", "/api/requests", &c.other, movie(90)),
        call(&c, "POST", "/api/requests", &c.admin, movie(90)),
        call(&c, "POST", "/api/requests", &c.user, movie(90)),
    );
    let codes = [a.0, b.0, d.0, e.0];
    assert_eq!(codes.iter().filter(|s| **s == 201).count(), 1, "{codes:?}");
    assert!(codes.iter().all(|s| matches!(s, 201 | 409)), "{codes:?}");
    let rows: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM requests WHERE "externalId" = '90'"#)
            .fetch_one(&c.pool())
            .await
            .unwrap();
    assert_eq!(rows, 1);
}

#[sqlx::test(migrations = false)]
async fn title_state_and_the_add_path_ignore_delete_rows(pool: PgPool) {
    let c = ctx(pool).await;
    q(
        &c.pool(),
        r#"WITH m AS (INSERT INTO media (title, type, "libraryId") VALUES ('M', 'movie', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (70)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#,
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
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (7, 'M', 'movie', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (71)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    let del = json!({"mediaType": "movie", "kind": "delete", "tmdbId": 71, "title": "M"});
    let (_, a) = call(&c, "POST", "/api/requests", &c.user, del.clone()).await;
    // a concurrent duplicate the dedup could not prevent
    q(
        &c.pool(),
        r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId")
        SELECT "userId", 'delete', 'movie', 'tmdb', '71', 'M', 'pending', 7 FROM requests LIMIT 1"#,
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
    assert_eq!(c.notified("request.delete.approved").await.len(), 1);
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
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (8, 'M', 'movie', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (72)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    let del = json!({"mediaType": "movie", "kind": "delete", "tmdbId": 72, "title": "M"});
    let (_, a) = call(&c, "POST", "/api/requests", &c.user, del).await;
    let id = rid(&a);
    q(
        &c.pool(),
        "CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$",
    )
    .await;
    q(
        &c.pool(),
        "CREATE TRIGGER refuse BEFORE DELETE ON media FOR EACH ROW EXECUTE FUNCTION refuse_delete()",
    )
    .await;
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
        c.notified("request.delete.declined").await[0],
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
    let imports = c.imports().await;
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
        c.notified("request.approved").await.last().unwrap(),
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
    c.tmdb.down.lock().unwrap().insert(81);
    let (s, _) = call(
        &c,
        "POST",
        &format!("/api/requests/{id}/approve"),
        &c.admin,
        json!(null),
    )
    .await;
    assert_eq!(s, 500);
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
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId", "languageProfileId", monitored) VALUES (9, 'M', 'movie', 1, 101, false) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (82)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
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
        r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "libraryId")
        VALUES (1, 'add', 'movie', 'tmdb', '90', 'M', 'pending', 1)"#,
    )
    .await;
    let any = json!({"id": 2});
    let _ = domain(&mut c);
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId", "languageProfileId", monitored) VALUES (11, 'M', 'movie', 1, 101, false) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (90)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    let lc = Lifecycle::of(&c.st);
    lc.on_media_imported(
        MediaRef {
            id: 11,
            media_type: MediaKind::Movie,
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
    // a media holding another title adopts nothing and announces nothing
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, monitored) VALUES (99, 'Other', 'movie', false) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT id, type, 'tmdb', '1234' FROM m"#).await;
    lc.on_media_imported(
        MediaRef {
            id: 99,
            media_type: MediaKind::Movie,
            monitored: false,
        },
        None,
    )
    .await;
    assert!(domain(&mut c).is_empty());
}

#[sqlx::test(migrations = false)]
async fn a_media_without_external_ids_adopts_no_request(pool: PgPool) {
    let mut c = ctx(pool).await;
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, movie(120)).await;
    assert_eq!(s, 201);
    q(&c.pool(), r#"INSERT INTO media (id, title, type, "libraryId", monitored) VALUES (98, 'Unidentified', 'movie', 1, false)"#).await;
    let _ = domain(&mut c);
    Lifecycle::of(&c.st)
        .on_media_imported(
            MediaRef {
                id: 98,
                media_type: MediaKind::Movie,
                monitored: false,
            },
            Some(1),
        )
        .await;
    assert_eq!(status_of(&c, 1).await, ("pending".to_owned(), None));
    assert!(domain(&mut c).is_empty());
}

#[sqlx::test(migrations = false)]
async fn removal_declines_add_rows_resolves_delete_rows_and_retires_available(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (12, 'M', 'movie', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (91)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    for (kind, status) in [
        ("add", "pending"),
        ("add", "processing"),
        ("add", "available"),
        ("delete", "pending"),
    ] {
        q(&c.pool(), &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId")
            VALUES (1, '{kind}', 'movie', 'tmdb', '91', 'M', '{status}', 12)"#)).await;
    }
    let mut conn = c.pool().acquire().await.unwrap();
    Lifecycle::of(&c.st)
        .on_media_removed(
            &mut conn,
            &MediaRef {
                id: 12,
                media_type: MediaKind::Movie,
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
            ("add".into(), "removed".into(), None, None),
            ("delete".into(), "approved".into(), None, None),
        ]
    );
}

#[sqlx::test(migrations = false)]
async fn unmonitoring_declines_linked_adds_and_trims_season_scopes(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (13, 'S', 'series', 2) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (92)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    for seasons in ["NULL", "'[1]'", "'[1,2]'"] {
        q(&c.pool(), &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId", seasons)
            VALUES (1, 'add', 'series', 'tmdb', '92', 'S', 'approved', 13, {seasons})"#)).await;
    }
    let lc = Lifecycle::of(&c.st);
    let media = MediaRef {
        id: 13,
        media_type: MediaKind::Series,
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
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (14, 'S', 'series', 2) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (93)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    for seasons in ["NULL", "'[1]'", "'[2]'"] {
        q(&c.pool(), &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId", seasons)
            VALUES (1, 'add', 'series', 'tmdb', '93', 'S', 'approved', 14, {seasons})"#)).await;
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
    assert_eq!(c.notified("request.processing").await.len(), 2);
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
    q(&p, r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (15, 'S', 'series', 2) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (94)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    q(&p, r#"INSERT INTO seasons ("seasonNumber", "mediaId", monitored) VALUES (1, 15, true), (2, 15, true), (3, 15, false)"#).await;
    // season 1: a two-episode file covers E2; season 2: E2 is missing
    episode(&p, 1, 1, None, true, true).await;
    episode(&p, 1, 2, None, false, true).await;
    episode(&p, 2, 1, None, true, true).await;
    episode(&p, 2, 2, None, false, true).await;
    q(&p, r#"UPDATE episodes SET "endEpisodeNumber" = 2 WHERE "episodeNumber" = 1 AND "seasonId" = (SELECT id FROM seasons WHERE "seasonNumber" = 1)"#).await;
    for seasons in ["'[1]'", "'[2]'", "'[3]'", "NULL"] {
        q(&p, &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId", seasons)
            VALUES (1, 'add', 'series', 'tmdb', '94', 'S', 'processing', 15, {seasons})"#)).await;
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
    assert_eq!(c.notified("request.available").await.len(), 1);
}

#[sqlx::test(migrations = false)]
async fn import_complete_needs_a_file_for_a_movie(pool: PgPool) {
    let c = ctx(pool).await;
    let p = c.pool();
    q(&p, r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (16, 'M', 'movie', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (95)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    q(&p, r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId") VALUES (1, 'add', 'movie', 'tmdb', '95', 'M', 'approved', 16)"#).await;
    let lc = Lifecycle::of(&c.st);
    lc.on_import_complete(16).await.unwrap();
    assert_eq!(status_of(&c, 1).await.0, "approved");
    q(&p, r#"INSERT INTO media_files ("relativePath", size, quality, language, "streamInfo", "mediaId") VALUES ('m.mkv', 1, 'WEBDL-1080p', 'en', '{}', 16)"#).await;
    lc.on_import_complete(16).await.unwrap();
    assert_eq!(status_of(&c, 1).await.0, "available");
}

#[sqlx::test(migrations = false)]
async fn reconcile_makes_open_requests_available_when_their_scope_is_on_disk(pool: PgPool) {
    let c = ctx(pool).await;
    let p = c.pool();
    for (id, tmdb, file) in [(18, 97, true), (19, 98, false)] {
        q(&p, &format!(r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES ({id}, 'M', 'movie', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', ({tmdb})::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#)).await;
        if file {
            q(&p, &format!(r#"INSERT INTO media_files ("relativePath", size, quality, language, "streamInfo", "mediaId") VALUES ('m.mkv', 1, 'WEBDL-1080p', 'en', '{{}}', {id})"#)).await;
        }
    }
    // approved and processing with a file, approved without, pending with a file (never touched)
    for (tmdb, media, status) in [
        (97, 18, "approved"),
        (97, 18, "processing"),
        (98, 19, "approved"),
        (97, 18, "pending"),
    ] {
        q(&p, &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId") VALUES (1, 'add', 'movie', 'tmdb', '{tmdb}', 'M', '{status}', {media})"#)).await;
    }
    let lc = Lifecycle::of(&c.st);
    lc.reconcile().await;
    lc.reconcile().await;
    let st: Vec<String> = sqlx::query_scalar("SELECT status::text FROM requests ORDER BY id")
        .fetch_all(&p)
        .await
        .unwrap();
    assert_eq!(st, ["available", "available", "approved", "pending"]);
    assert_eq!(c.notified("request.available").await.len(), 2);
}

#[sqlx::test(migrations = false)]
async fn the_event_subscriptions_drive_the_lifecycle(pool: PgPool) {
    let c = ctx(pool).await;
    let p = c.pool();
    fliks_server::requests::spawn(&c.st);
    q(&p, r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (17, 'M', 'movie', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (96)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    q(&p, r#"INSERT INTO media_files ("relativePath", size, quality, language, "streamInfo", "mediaId") VALUES ('m.mkv', 1, 'WEBDL-1080p', 'en', '{}', 17)"#).await;
    q(&p, r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId") VALUES (1, 'add', 'movie', 'tmdb', '96', 'M', 'approved', 17)"#).await;
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
    c.tmdb.down.lock().unwrap().insert(100);
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, movie(100)).await;
    assert_eq!(
        (s, r["posterUrl"].clone()),
        (201, Value::Null),
        "a failed prefetch leaves the art empty"
    );
    c.tmdb.down.lock().unwrap().remove(&100);
    let (_, r) = call(&c, "POST", "/api/requests", &c.user, movie(101)).await;
    let poster = r["posterUrl"].as_str().unwrap().to_owned();
    assert!(
        poster.starts_with("/api/images/request/movie-tmdb-101/poster?v="),
        "{poster}"
    );
    assert_eq!(r["fanartUrl"], Value::Null, "the stub has no backdrop");
    let (_, l) = call(&c, "GET", "/api/requests?tmdbId=101", &c.admin, json!(null)).await;
    assert_eq!(l["data"][0]["posterUrl"], poster.as_str(), "stored too");
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
    assert_eq!(c.imports().await.len(), 1);
}

impl Ctx {
    fn pool(&self) -> PgPool {
        self.st.db.clone()
    }

    /// The payloads the webhook received for `event`, once the first one arrived.
    async fn notified(&self, event: &str) -> Vec<Value> {
        let mine = || -> Vec<Value> {
            self.hook
                .0
                .lock()
                .unwrap()
                .iter()
                .filter(|b| b["event"] == event)
                .map(|b| {
                    let mut p = b.clone();
                    p.as_object_mut().unwrap().remove("event");
                    p
                })
                .collect()
        };
        for _ in 0..40 {
            if !mine().is_empty() {
                tokio::time::sleep(Duration::from_millis(150)).await;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        mine()
    }

    /// `(libraryId, addedById)` of every media a request imported.
    async fn imports(&self) -> Vec<(Option<i32>, Option<i32>)> {
        sqlx::query_as(r#"SELECT "libraryId", "addedById" FROM media ORDER BY id"#)
            .fetch_all(&self.st.db)
            .await
            .unwrap()
    }
}

/// An `available` movie request on media 14 (tmdb 93), then the same title requested again by `c.user`.
async fn available_then(c: &Ctx, media_call: (&str, &str, Value)) {
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (14, 'M', 'movie', 1) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (93)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    q(
        &c.pool(),
        r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId")
        VALUES (1, 'add', 'movie', 'tmdb', '93', 'Movie 93', 'available', 14)"#,
    )
    .await;
    let (s, _) = call(c, "POST", "/api/requests", &c.user, movie(93)).await;
    assert_eq!(s, 409, "an available request blocks a re-request");
    let (m, uri, body) = media_call;
    let (s, r) = call(c, m, uri, &c.admin, body).await;
    assert_eq!(s, 200, "{r}");
    assert_eq!(status_of(c, 1).await, ("removed".into(), None));
    let (_, st) = call(
        c,
        "GET",
        "/api/requests/title-state?tmdbId=93&mediaType=movie",
        &c.user,
        json!(null),
    )
    .await;
    assert_eq!(st["requested"], false);
    let (s, r) = call(c, "POST", "/api/requests", &c.user, movie(93)).await;
    assert_eq!(s, 201, "{r}");
}

#[sqlx::test(migrations = false)]
async fn a_deleted_media_retires_its_available_request_and_the_title_can_be_requested_again(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    available_then(&c, ("DELETE", "/api/media/14", json!(null))).await;
}

#[sqlx::test(migrations = false)]
async fn an_unmonitored_media_retires_its_available_request_and_the_title_can_be_requested_again(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    available_then(&c, ("PUT", "/api/media/14", json!({"monitored": false}))).await;
}

#[sqlx::test(migrations = false)]
async fn a_bulk_unmonitor_retires_available_requests_and_the_title_can_be_requested_again(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let body = json!({"ids": [14], "monitored": false});
    available_then(&c, ("PATCH", "/api/media/bulk", body)).await;
}

#[sqlx::test(migrations = false)]
async fn unmonitoring_a_season_trims_or_retires_available_scopes(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (15, 'S', 'series', 2) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (94)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    for seasons in ["'[1]'", "'[1,2]'"] {
        q(&c.pool(), &format!(r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId", seasons)
            VALUES (1, 'add', 'series', 'tmdb', '94', 'S', 'available', 15, {seasons})"#)).await;
    }
    let media = MediaRef {
        id: 15,
        media_type: MediaKind::Series,
        monitored: true,
    };
    Lifecycle::of(&c.st)
        .on_season_monitor_change(media, 1, true, false)
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
            ("removed".into(), None, Some(json!([1])), None),
            ("available".into(), None, Some(json!([2])), Some(15)),
        ]
    );
}

#[sqlx::test(migrations = false)]
async fn unmonitoring_a_season_keeps_a_whole_series_request_on_the_other_seasons(pool: PgPool) {
    let c = ctx(pool).await;
    q(&c.pool(), r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES (15, 'S', 'series', 2) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', (94)::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#).await;
    q(&c.pool(), r#"INSERT INTO seasons ("seasonNumber", "mediaId", monitored) VALUES (1, 15, true), (2, 15, true), (3, 15, true)"#).await;
    q(
        &c.pool(),
        r#"INSERT INTO requests ("userId", kind, "mediaType", provider, "externalId", title, status, "mediaId")
        VALUES (1, 'add', 'series', 'tmdb', '94', 'S', 'available', 15)"#,
    )
    .await;
    let (s, _) = call(&c, "POST", "/api/requests", &c.user, series(94, json!([2]))).await;
    assert_eq!(s, 409, "the whole series is available");
    let season: i32 = sqlx::query_scalar(r#"SELECT id FROM seasons WHERE "seasonNumber" = 2"#)
        .fetch_one(&c.pool())
        .await
        .unwrap();
    let uri = format!("/api/media/seasons/{season}");
    let (s, r) = call(&c, "PATCH", &uri, &c.admin, json!({"monitored": false})).await;
    assert_eq!(s, 200, "{r}");
    let row: (String, Option<Value>) =
        sqlx::query_as("SELECT status::text, seasons FROM requests WHERE id = 1")
            .fetch_one(&c.pool())
            .await
            .unwrap();
    assert_eq!(row, ("available".into(), Some(json!([1, 3]))));
    let (s, r) = call(&c, "POST", "/api/requests", &c.user, series(94, json!([2]))).await;
    assert_eq!(s, 201, "{r}");
}

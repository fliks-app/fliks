//! `/api/metadata/*` and `/api/persons/*` (`docs/spec/metadata.md`, `persons.md`) through the real router, a loopback
//! stub for TMDB, TVDB and the image host, and a fresh database.
use crate::fakes::{Images, Scripted};
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_domain::{
    external_id::{ExternalProvider, Namespace},
    media::kind::MediaKind,
};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{path::PathBuf, sync::Arc};
use tower::ServiceExt;

mod snapshots;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    /// The TMDB provider.
    stub: Arc<Scripted>,
    tvdb: Arc<Scripted>,
    img: Arc<Images>,
    data: PathBuf,
    admin: String,
    reader: String,
}

async fn ctx_with(pool: PgPool, tvdb_on: bool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let (stub, tvdb) = (
        Scripted::new(Namespace::TMDB),
        Scripted::new(Namespace::TVDB),
    );
    tvdb.on.store(tvdb_on, std::sync::atomic::Ordering::SeqCst);
    st.metadata.add_plugin(stub.clone());
    st.metadata.add_plugin(tvdb.clone());
    let img = Images::start(false).await;
    let mut st = st;
    let data = std::env::temp_dir().join(format!(
        "fliks-meta-{}",
        fliks_server::config::random_hex(6)
    ));
    st.images = Arc::new(img.store(data.clone()));
    sqlx::query(r#"INSERT INTO roles (name, permissions) VALUES ('reader', '["media.read"]')"#)
        .execute(&pool)
        .await
        .unwrap();
    let mut tokens = vec![];
    for (name, admin) in [("admin", true), ("reader", false)] {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin", "roleId") VALUES ($1, $2, (SELECT id FROM roles WHERE NOT $2 LIMIT 1)) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .fetch_one(&pool)
        .await
        .unwrap();
        tokens.push((id, session::token(&st, id, name).await));
    }
    // library 1 is readable by `reader`, library 2 is not
    sqlx::raw_sql(
        r#"INSERT INTO libraries (id, name) VALUES (1, 'A'), (2, 'B');
INSERT INTO library_folders ("libraryId", path) VALUES (1, '/tmp/a'), (2, '/tmp/b')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, $1)"#)
        .bind(tokens[1].0)
        .execute(&pool)
        .await
        .unwrap();
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    Ctx {
        app,
        st,
        stub,
        tvdb,
        img,
        data,
        reader: tokens.pop().unwrap().1,
        admin: tokens.pop().unwrap().1,
    }
}

async fn ctx(pool: PgPool) -> Ctx {
    ctx_with(pool, true).await
}

async fn call(c: &Ctx, uri: &str, tok: Option<&str>) -> (u16, Value) {
    let mut req = Request::builder().uri(uri);
    if let Some(t) = tok {
        req = req.header("authorization", format!("Bearer {t}"));
    }
    let res = c
        .app
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let b = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

fn movie(id: i64) -> Value {
    json!({"provider": "tmdb", "tmdbId": id, "title": format!("Movie {id}"), "year": 2020, "posterUrl": "https://image.tmdb.org/t/p/w500/p.jpg"})
}

async fn media(pool: &PgPool, id: i32, kind: &str, tmdb: Option<i32>, tvdb: Option<i32>, lib: i32) {
    sqlx::query(r#"WITH m AS (INSERT INTO media (id, title, type, "libraryId") VALUES ($1, $2, $3, $6) RETURNING id, type) INSERT INTO media_external_ids ("mediaId", kind, provider, value) SELECT m.id, m.type, p.provider, p.value FROM m, (VALUES ('tmdb', $4::int4::text), ('tvdb', $5::int4::text)) AS p(provider, value) WHERE p.value IS NOT NULL"#)
        .bind(id)
        .bind(format!("m{id}"))
        .bind(kind)
        .bind(tmdb)
        .bind(tvdb)
        .bind(lib)
        .execute(pool)
        .await
        .unwrap();
}

#[sqlx::test(migrations = false)]
async fn search_marks_media_the_caller_can_read(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    media(&pool, 1, "movie", Some(11), None, 1).await;
    media(&pool, 2, "movie", Some(22), None, 2).await;
    media(&pool, 3, "series", Some(33), None, 1).await;
    c.stub.ok(
        "search/movie",
        json!([movie(11), movie(22), movie(33), movie(44)]),
    );
    let ids = |v: &Value| -> Vec<Value> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| r["existingMediaId"].clone())
            .collect()
    };
    let (s, admin) = call(&c, "/api/metadata/search/movie?q=sample", Some(&c.admin)).await;
    assert_eq!(s, 200);
    assert_eq!(ids(&admin), [json!(1), json!(2), Value::Null, Value::Null]);
    assert_eq!(admin[0]["existingMediaType"], "movie");
    assert_eq!(admin[0]["year"], 2020);
    assert_eq!(admin[0]["externalId"], "11");
    assert!(admin[0].get("tvdbId").is_none() && admin[0]["provider"] == "tmdb");
    let (_, reader) = call(&c, "/api/metadata/search/movie?q=sample", Some(&c.reader)).await;
    assert_eq!(
        ids(&reader),
        [json!(1), Value::Null, Value::Null, Value::Null],
        "only the first hit is linked"
    );
    assert_eq!(reader[1]["existingMediaType"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn search_input_rules(pool: PgPool) {
    let c = ctx(pool).await;
    c.stub.ok("search/movie", json!([movie(11)]));
    for q in ["", "?q=", "?q=%20%20"] {
        assert_eq!(
            call(
                &c,
                &format!("/api/metadata/search/movie{q}"),
                Some(&c.reader)
            )
            .await,
            (200, json!([])),
            "{q:?}"
        );
    }
    assert!(c.stub.seen("search").is_empty());
    let (s, body) = call(&c, "/api/metadata/search/movie?q=a&q=b", Some(&c.reader)).await;
    assert_eq!(
        (s, body["error"].as_str()),
        (400, Some("Bad Request")),
        "a repeated q is a 400"
    );
    assert_eq!(
        call(&c, "/api/metadata/search/movie?q=a", None).await.0,
        401
    );
    call(
        &c,
        "/api/metadata/search/movie?q=x&year=1999",
        Some(&c.reader),
    )
    .await;
    call(
        &c,
        "/api/metadata/search/movie?q=x&year=abc",
        Some(&c.reader),
    )
    .await;
    call(&c, "/api/metadata/search/movie?q=x&year=0", Some(&c.reader)).await;
    let log = c.stub.seen("search/movie");
    assert!(
        log[0].contains("year=1999")
            && log[0].contains("query=x")
            && log[0].contains("language=en-US")
    );
    assert!(log[1..].iter().all(|l| !l.contains("year=")));
}

#[sqlx::test(migrations = false)]
async fn provider_choice_and_fallback(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    sqlx::query(r#"UPDATE libraries SET "preferredProvider" = 'tvdb' WHERE id = 1"#)
        .execute(&pool)
        .await
        .unwrap();
    media(&pool, 5, "series", Some(500), Some(81189), 1).await;
    c.stub.ok(
        "search/series",
        json!([{"provider": "tmdb", "tmdbId": 500, "title": "T", "year": 2008}]),
    );
    c.tvdb.ok(
        "search/series",
        json!([{"provider": "tvdb", "tvdbId": 81189, "title": "V", "year": 2008}]),
    );
    let first = |v: &Value| (v[0]["provider"].clone(), v[0]["existingMediaId"].clone());
    let (_, v) = call(&c, "/api/metadata/search/tv?q=x&mediaId=5", Some(&c.admin)).await;
    assert_eq!(
        first(&v),
        (json!("tvdb"), json!(5)),
        "library preference, matched on tvdbId"
    );
    let (_, v) = call(
        &c,
        "/api/metadata/search/tv?q=x&mediaId=5&provider=tmdb",
        Some(&c.admin),
    )
    .await;
    assert_eq!(first(&v).0, "tmdb");
    for q in ["&mediaId=zz", "&mediaId=0", "&mediaId=99999999999"] {
        let (_, v) = call(
            &c,
            &format!("/api/metadata/search/tv?q=x{q}"),
            Some(&c.admin),
        )
        .await;
        assert_eq!(first(&v).0, "tmdb", "{q}");
    }
    let (_, v) = call(
        &c,
        "/api/metadata/search/tv?q=x&mediaId=5&provider=",
        Some(&c.admin),
    )
    .await;
    assert_eq!(first(&v).0, "tvdb", "an empty provider names none");
    let (s, _) = call(
        &c,
        "/api/metadata/search/tv?q=x&provider=foo",
        Some(&c.admin),
    )
    .await;
    assert_eq!(s, 400, "an unknown provider is refused");
    // an empty TMDB answer asks TVDB, whose results keep their own provider
    c.stub.ok("search/series", json!([]));
    let (_, v) = call(&c, "/api/metadata/search/tv?q=x", Some(&c.admin)).await;
    assert_eq!(first(&v).0, "tvdb");
    c.tvdb.ok("search/series", json!([]));
    assert_eq!(
        call(&c, "/api/metadata/search/tv?q=x", Some(&c.admin))
            .await
            .1,
        json!([])
    );
}

#[sqlx::test(migrations = false)]
async fn a_failing_provider_is_skipped_for_the_next_one(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    media(&pool, 7, "movie", Some(9), Some(90), 1).await;
    c.stub.fail("search/movie", 500);
    c.tvdb.ok(
        "search/movie",
        json!([{"provider": "tvdb", "tvdbId": 90, "title": "V", "year": 2001}]),
    );
    let (s, v) = call(&c, "/api/metadata/search/movie?q=x", Some(&c.admin)).await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        (
            v[0]["provider"].clone(),
            v[0]["externalId"].clone(),
            v[0]["existingMediaId"].clone()
        ),
        (json!("tvdb"), json!("90"), json!(7))
    );
    assert_eq!(v[0]["mediaType"], "movie");
    c.tvdb.fail("search/movie", 500);
    let (s, b) = call(&c, "/api/metadata/search/movie?q=x", Some(&c.admin)).await;
    assert_eq!(s, 503, "{b}");
    assert_eq!(
        call(&c, "/api/metadata/search/nope?q=x", Some(&c.admin))
            .await
            .0,
        400
    );
}

#[sqlx::test(migrations = false)]
async fn upstream_failures_are_503_without_the_url(pool: PgPool) {
    let c = ctx(pool).await;
    c.stub.fail("search/movie", 500);
    let (s, b) = call(&c, "/api/metadata/search/movie?q=x", Some(&c.reader)).await;
    assert_eq!((s, b["error"].as_str()), (503, Some("Service Unavailable")));
    let msg = b["message"].as_str().unwrap();
    assert_eq!(msg, "Metadata search failed on tmdb: HTTP 500");
    // the same failure on a list with no stale copy is a 503 too
    c.stub.fail("list/series/genres", 500);
    let (s, b) = call(&c, "/api/metadata/genres/tv", Some(&c.reader)).await;
    assert_eq!(s, 503);
    assert!(
        b["message"]
            .as_str()
            .unwrap()
            .starts_with("Metadata request failed on tmdb: HTTP 500")
    );
}

#[sqlx::test(migrations = false)]
async fn lists_serve_the_last_good_copy(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    media(&pool, 1, "movie", Some(11), None, 1).await;
    c.stub.ok("list/movie/popular", json!([movie(11)]));
    let (_, live) = call(&c, "/api/metadata/popular/movie", Some(&c.admin)).await;
    c.stub.fail("list/movie/popular", 500);
    let (s, stale) = call(&c, "/api/metadata/popular/movie", Some(&c.admin)).await;
    assert_eq!((s, &stale), (200, &live));
    assert_eq!(stale[0]["existingMediaId"], 1);
    // the stale copy is before the existing-media lookup: it stays current
    sqlx::query("DELETE FROM media")
        .execute(&pool)
        .await
        .unwrap();
    let (_, again) = call(&c, "/api/metadata/popular/movie", Some(&c.admin)).await;
    assert_eq!(again[0]["existingMediaId"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn detail_routes_map_input_and_upstream_errors(pool: PgPool) {
    let c = ctx(pool).await;
    let get = |p: &'static str| call(&c, p, Some(&c.reader));
    assert_eq!(get("/api/metadata/foo/movie/1").await.0, 400);
    assert_eq!(get("/api/metadata/foo/tv/1/seasons").await.0, 400);
    assert_eq!(get("/api/metadata/tmdb/movie/abc").await.0, 400);
    assert_eq!(get("/api/metadata/tmdb/movie/007").await.0, 400);
    assert_eq!(get("/api/metadata/tv/tv/seasons").await.0, 400);
    assert_eq!(get("/api/metadata/movie/search").await.0, 400);
    assert_eq!(get("/api/metadata/tmdb/movie/9").await.0, 404);
    assert_eq!(get("/api/metadata/tmdb/tv/9/seasons").await.0, 404);
    c.stub.fail("work/movie/9", 500);
    assert_eq!(get("/api/metadata/movie/9").await.0, 503);
    assert!(c.stub.seen("work/movie/abc").is_empty());
    assert_eq!(call(&c, "/api/metadata/tmdb/movie/9", None).await.0, 401);
}

#[sqlx::test(migrations = false)]
async fn details_seasons_and_stubs_pass_the_provider_records_through(pool: PgPool) {
    let c = ctx(pool).await;
    let film = json!({"tmdbId": 603, "title": "Sample Film", "year": 1999, "status": "released", "tmdbCollectionName": "C"});
    c.stub.ok("work/movie/603", film.clone());
    let (s, d) = call(&c, "/api/metadata/movie/603", Some(&c.reader)).await;
    assert_eq!((s, d), (200, film));
    c.stub.ok(
        "stubs/7",
        json!([{"seasonNumber": 0, "episodeCount": 1}, {"seasonNumber": 1, "episodeCount": 2}]),
    );
    c.stub.ok(
        "children/7",
        json!([{"seasonNumber": 0, "episodes": [{"episodeNumber": 1}]}, {"seasonNumber": 1, "overview": "o", "episodes": []}]),
    );
    let (_, stubs) = call(&c, "/api/metadata/tmdb/tv/7/season-stubs", Some(&c.reader)).await;
    assert_eq!(
        stubs,
        json!([{"seasonNumber": 0, "episodeCount": 1}, {"seasonNumber": 1, "episodeCount": 2}])
    );
    let (_, seasons) = call(&c, "/api/metadata/tmdb/tv/7/seasons", Some(&c.reader)).await;
    assert_eq!(seasons[1]["overview"], "o");
    assert_eq!(seasons.as_array().unwrap().len(), 2);
}

#[sqlx::test(migrations = false)]
async fn a_season_override_asks_its_provider_for_that_season_only(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    media(&pool, 5, "series", Some(500), Some(81189), 1).await;
    sqlx::query(r#"INSERT INTO item_groups ("number", "mediaId", "preferredProvider") VALUES (2, 5, 'tvdb')"#)
        .execute(&pool)
        .await
        .unwrap();
    c.stub
        .ok("children/500", json!([{"seasonNumber": 1, "episodes": []}]));
    c.tvdb.ok(
        "children/81189",
        json!([{"seasonNumber": 1, "episodes": []}, {"seasonNumber": 2, "overview": "v", "episodes": []}]),
    );
    let seasons = fliks_server::metadata::service::seasons_for_media(
        &c.st,
        5,
        fliks_domain::metadata::limiter::Priority::Interactive,
    )
    .await
    .unwrap();
    assert_eq!(seasons.len(), 2);
    assert_eq!(c.stub.seen("children/"), ["children/500"]);
    assert_eq!(c.tvdb.seen("children/"), ["children/81189?season=2"]);
}

#[sqlx::test(migrations = false)]
async fn discover_params_and_language_reach_the_provider(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    c.stub.ok("list/movie/discover", json!([]));
    call(
        &c,
        "/api/metadata/discover/movie?genres=28,12&voteGte=7.5&yearGte=1999&yearLte=2003&sort=popularity.desc&x=1",
        Some(&c.reader),
    )
    .await;
    assert_eq!(
        c.stub.seen("list/movie/discover"),
        [
            "list/movie/discover?genres=28,12&sort=popularity.desc&voteGte=7.5&yearGte=1999&yearLte=2003"
        ]
    );
    sqlx::query(r#"INSERT INTO app_settings ("key", "value") VALUES ('metadata_language', 'fr')"#)
        .execute(&pool)
        .await
        .unwrap();
    c.st.metadata
        .lang
        .settings_changed(&["metadata_language".into()]);
    c.stub.ok("search/movie", json!([]));
    call(&c, "/api/metadata/search/movie?q=x", Some(&c.reader)).await;
    assert!(c.stub.seen("search/movie")[0].contains("language=fr-FR"));
}

// ---- persons

async fn person(pool: &PgPool, id: i32, provider: &str, tmdb: i32, name: &str, refreshed: &str) {
    sqlx::query(
        r#"WITH p AS (
             INSERT INTO persons (id, name, biography, birthday, "metadataRefreshedAt")
             VALUES ($1, $4, 'stored', '1970-01-01', CASE WHEN $5 = 'never' THEN NULL ELSE now() - ($5)::interval END)
             RETURNING id)
           INSERT INTO person_external_ids ("personId", provider, value) SELECT id, $2, ($3)::text FROM p"#,
    )
    .bind(id)
    .bind(provider)
    .bind(tmdb)
    .bind(name)
    .bind(refreshed)
    .execute(pool)
    .await
    .unwrap();
}

fn names(v: &Value) -> Vec<&str> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect()
}

#[sqlx::test(migrations = false)]
async fn person_search(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    for (i, n) in [
        "Claire Danes",
        "Claude Rains",
        "Conan O'Brien",
        "Jean-Luc Godard",
        "Amélie Poulain",
    ]
    .iter()
    .enumerate()
    {
        person(&pool, i as i32 + 1, "tmdb", 100 + i as i32, n, "1 day").await;
    }
    let cr = &c;
    let search = |q: &'static str| async move {
        call(cr, &format!("/api/persons/search{q}"), Some(&cr.reader)).await
    };
    assert_eq!(
        names(&search("?q=cla").await.1),
        ["Claire Danes", "Claude Rains"]
    );
    assert_eq!(
        names(&search("?q=claude%20rains").await.1),
        ["Claude Rains"]
    );
    assert_eq!(names(&search("?q=o%27brien").await.1), ["Conan O'Brien"]);
    assert_eq!(names(&search("?q=Jean-Luc").await.1), ["Jean-Luc Godard"]);
    assert_eq!(names(&search("?q=jean%20luc").await.1), ["Jean-Luc Godard"]);
    assert_eq!(names(&search("?q=am%C3%A9lie").await.1), ["Amélie Poulain"]);
    assert_eq!(names(&search("").await.1).len(), 5);
    sqlx::raw_sql(
        r#"INSERT INTO persons (id, name) SELECT 10000 + g, 'Zz ' || g FROM generate_series(1, 1000) g;
           INSERT INTO person_external_ids SELECT 10000 + g, 'tmdb', (10000 + g)::text FROM generate_series(1, 1000) g"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        names(&search("").await.1).len(),
        1000,
        "no cap on the result count"
    );
    sqlx::query("DELETE FROM persons WHERE name LIKE 'Zz %'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(names(&search("?q=%20%20").await.1)[0], "Amélie Poulain");
    for q in [
        "%28", "a%26", "x%21", "a%3Ab", "%27", "a%7Cb", "-", "a%5Cb", "%3A",
    ] {
        let (s, _) = search(Box::leak(format!("?q={q}").into_boxed_str())).await;
        assert_eq!(s, 200, "search {q}");
    }
    assert!(!search("?q=a%26").await.1.as_array().unwrap().is_empty());
    assert_eq!(search("?q=%28").await.1, json!([]));
    assert_eq!(search("?q=a&q=b").await.0, 400);
    assert_eq!(
        call(&c, "/api/persons/search", None).await.0,
        401,
        "auth required"
    );
    // the trigger keeps the index in step with the name
    sqlx::query("UPDATE persons SET name = 'Zed Renamed' WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(names(&search("?q=zed").await.1), ["Zed Renamed"]);
    assert_eq!(names(&search("?q=claire").await.1), Vec::<&str>::new());
}

fn tmdb_person(name: &str, avatar: Option<&str>) -> Value {
    json!({"name": name, "biography": "fresh bio", "birthday": null, "deathday": null, "placeOfBirth": "Paris",
           "avatarUrl": avatar.map(|a| format!("http://image.tmdb.org/t/p/w500{a}")), "knownForDepartment": "Acting"})
}

async fn seed_credits(pool: &PgPool) {
    media(pool, 1, "movie", Some(11), None, 1).await;
    media(pool, 2, "movie", Some(22), None, 2).await;
    sqlx::raw_sql(
        r#"INSERT INTO media_credits (role, character, position, "mediaId", "personId")
             VALUES ('cast', 'A', 1, 1, 1), ('cast', 'B', 0, 2, 1);
           INSERT INTO media_credits (role, job, department, "mediaId", "personId")
             VALUES ('crew', 'Director', 'Directing', 2, 1)"#,
    )
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = false)]
async fn person_detail_applies_the_library_acl(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    person(&pool, 1, "tmdb", 5, "Fresh", "1 day").await;
    seed_credits(&pool).await;
    let (s, d) = call(&c, "/api/persons/1", Some(&c.admin)).await;
    assert_eq!(s, 200);
    assert_eq!(d["person"]["name"], "Fresh");
    let cast: Vec<_> = d["cast"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["character"].clone())
        .collect();
    assert_eq!(cast, [json!("B"), json!("A")], "cast by order");
    assert_eq!(d["cast"][0]["media"]["library"]["path"], "/tmp/b");
    assert_eq!(d["cast"][0]["person"]["id"], 1);
    assert_eq!(d["cast"][0]["media"]["metadata"], Value::Null);
    assert!(d["cast"][0]["media"].get("files").is_none());
    assert_eq!(d["crew"].as_array().unwrap().len(), 1);
    assert!(
        c.stub.seen("person").is_empty(),
        "a fresh person is not refreshed"
    );
    let (_, r) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(r["cast"].as_array().unwrap().len(), 1, "one cast entry");
    assert_eq!(r["cast"][0]["character"], "A");
    assert!(
        r["cast"][0]["media"].get("path").is_none()
            && r["cast"][0]["media"]["library"].get("path").is_none(),
        "no path leaks"
    );
    assert_eq!(r["crew"], json!([]));
}

#[sqlx::test(migrations = false)]
async fn person_detail_input_errors(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, b) = call(&c, "/api/persons/999", Some(&c.reader)).await;
    assert_eq!(
        (s, b["message"].as_str()),
        (404, Some("Person #999 not found"))
    );
    for p in ["abc", "007", "1e1"] {
        assert_eq!(
            call(&c, &format!("/api/persons/{p}"), Some(&c.reader))
                .await
                .0,
            400,
            "{p}"
        );
        assert_eq!(
            call(
                &c,
                &format!("/api/persons/{p}/provider-credits"),
                Some(&c.reader)
            )
            .await
            .0,
            400,
            "{p}"
        );
    }
    assert_eq!(call(&c, "/api/persons/1", None).await.0, 401);
    assert_eq!(
        call(&c, "/api/persons/1/provider-credits", None).await.0,
        401
    );
    assert_eq!(
        call(&c, "/api/persons/999/provider-credits", Some(&c.reader))
            .await
            .0,
        404
    );
}

#[sqlx::test(migrations = false)]
async fn a_stale_person_is_refreshed_with_its_avatar(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    person(&pool, 1, "tmdb", 5, "Old Name", "8 days").await;
    c.stub
        .ok("person/5", tmdb_person("New Name", Some("/face.jpg")));
    let src = crate::fakes::jpeg();
    c.img.put("/t/p/original/face.jpg", src.clone());
    let (s, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(s, 200);
    let p = &d["person"];
    assert_eq!(
        (
            p["name"].as_str(),
            p["biography"].as_str(),
            p["placeOfBirth"].as_str()
        ),
        (Some("New Name"), Some("fresh bio"), Some("Paris"))
    );
    assert!(
        p["avatarUrl"]
            .as_str()
            .unwrap()
            .starts_with("/api/images/person/1?v=")
    );
    assert_eq!(
        p["birthday"], "1970-01-01",
        "a provider null never clears a stored value"
    );
    assert_eq!(p["deathday"], Value::Null);
    assert!(p["metadataRefreshedAt"].is_string() && p["knownForDepartment"] == "Acting");
    assert_eq!(std::fs::read(c.data.join("persons/1.jpg")).unwrap(), src);
    assert!(
        c.data.join("persons/1-thumb.jpg").exists() && c.data.join("persons/1-medium.jpg").exists()
    );
    // the second call is inside the 7 days
    call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(c.stub.seen("person/5").len(), 1);
    // the original avatar was asked at `original`
    assert_eq!(c.img.seen("/t/p/").len(), 1);
}

#[sqlx::test(migrations = false)]
async fn a_failing_refresh_serves_the_stored_row(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    person(&pool, 1, "tmdb", 5, "Stored", "never").await;
    c.stub.fail("person/5", 500);
    let (s, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(
        (
            s,
            d["person"]["name"].as_str(),
            d["person"]["metadataRefreshedAt"].clone()
        ),
        (200, Some("Stored"), Value::Null)
    );
    // an unreachable avatar leaves the stored avatar alone but still refreshes the rest
    c.stub
        .ok("person/5", tmdb_person("Stored", Some("/missing.jpg")));
    let (_, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(d["person"]["avatarUrl"], Value::Null);
    assert_eq!(d["person"]["biography"], "fresh bio");
}

const MBID: &str = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";

async fn artist(pool: &PgPool, id: i32) {
    artist_with_id(pool, id, MBID).await;
}

async fn artist_with_id(pool: &PgPool, id: i32, mbid: &str) {
    sqlx::query(
        r#"WITH p AS (INSERT INTO persons (id, name) VALUES ($1, 'Stored') RETURNING id)
           INSERT INTO person_external_ids ("personId", provider, value) SELECT id, 'musicbrainz', $2 FROM p"#,
    )
    .bind(id)
    .bind(mbid)
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = false)]
async fn a_musicbrainz_artist_is_read_from_its_provider_and_filled_from_the_next(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let mb = Scripted::new(Namespace::MUSICBRAINZ);
    let fanart = Scripted::new(Namespace::Core(ExternalProvider::FanartTv));
    fanart.serve_persons_of(Namespace::MUSICBRAINZ);
    c.st.metadata.add_plugin(fanart.clone());
    c.st.metadata.add_plugin(mb.clone());
    artist(&pool, 1).await;
    mb.ok(
        &format!("person/{MBID}"),
        json!({"name": "Ana", "birthday": "1943-02-01", "placeOfBirth": "Lyon"}),
    );
    fanart.ok(
        &format!("person/{MBID}"),
        json!({"biography": "from fanart", "avatarUrl": "http://image.tmdb.org/t/p/w500/f.jpg"}),
    );
    c.img.put("/t/p/original/f.jpg", crate::fakes::jpeg());
    let (s, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    let p = &d["person"];
    assert_eq!(
        (
            s,
            p["name"].as_str(),
            p["biography"].as_str(),
            p["placeOfBirth"].as_str()
        ),
        (200, Some("Ana"), Some("from fanart"), Some("Lyon"))
    );
    assert!(
        p["avatarUrl"]
            .as_str()
            .unwrap()
            .starts_with("/api/images/person/1?v=")
    );
    assert_eq!(
        (mb.seen("person").len(), fanart.seen("person").len()),
        (1, 1)
    );
    // a record that holds an image and a biography asks nobody else
    mb.ok(
        &format!("person/{MBID}"),
        json!({"name": "Ana", "biography": "own", "avatarUrl": "http://image.tmdb.org/t/p/w500/f.jpg"}),
    );
    sqlx::query(r#"UPDATE persons SET "metadataRefreshedAt" = NULL WHERE id = 1"#)
        .execute(&pool)
        .await
        .unwrap();
    call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(
        (mb.seen("person").len(), fanart.seen("person").len()),
        (2, 1)
    );
    // a failing filler never fails the artist
    fanart.fail(&format!("person/{MBID}"), 500);
    mb.ok(&format!("person/{MBID}"), json!({"name": "Ana"}));
    sqlx::query(
        r#"UPDATE persons SET "metadataRefreshedAt" = NULL, biography = NULL WHERE id = 1"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let (_, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert!(d["person"]["metadataRefreshedAt"].is_string());
    assert_eq!(fanart.seen("person").len(), 2);
}

#[sqlx::test(migrations = false)]
async fn a_404_asks_the_other_provider_and_pins_the_row(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    person(&pool, 1, "tmdb", 5, "Stored", "8 days").await;
    c.tvdb.ok(
        "person/5",
        json!({"name": "From Tvdb", "biography": "english", "knownForDepartment": "Directing"}),
    );
    let (_, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(
        (
            d["person"]["name"].as_str(),
            d["person"]["provider"].as_str()
        ),
        (Some("From Tvdb"), Some("tvdb"))
    );
    assert_eq!(d["person"]["knownForDepartment"], "Directing");
    let stored: String =
        sqlx::query_scalar(r#"SELECT provider FROM person_external_ids WHERE "personId" = 1"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored, "tvdb");
}

#[sqlx::test(migrations = false)]
async fn a_pin_that_breaks_the_unique_pair_keeps_the_provider(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    person(&pool, 1, "tmdb", 5, "Stored", "8 days").await;
    person(&pool, 2, "tvdb", 5, "Holder", "1 day").await;
    c.tvdb.ok("person/5", json!({"name": "From Tvdb"}));
    c.tvdb.ok("credits/5", json!({"cast": [], "crew": []}));
    let (s, d) = call(&c, "/api/persons/1/provider-credits", Some(&c.reader)).await;
    assert_eq!(
        (s, d["provider"].as_str()),
        (200, Some("tmdb")),
        "provider credits"
    );
    let (_, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(d["person"]["provider"], "tmdb");
    assert_eq!(d["person"]["name"], "From Tvdb");
}

#[sqlx::test(migrations = false)]
async fn with_tvdb_unavailable_a_tvdb_person_is_asked_of_tmdb(pool: PgPool) {
    let c = ctx_with(pool.clone(), false).await;
    person(&pool, 1, "tvdb", 5, "Stored", "8 days").await;
    c.stub.ok("person/5", tmdb_person("Via Tmdb", None));
    let (_, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(d["person"]["name"], "Via Tmdb");
    assert!(c.tvdb.seen("person").is_empty());
}

#[sqlx::test(migrations = false)]
async fn provider_credits_link_on_type_and_id_for_readable_media(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    person(&pool, 1, "tmdb", 5, "P", "1 day").await;
    media(&pool, 1, "movie", Some(11), None, 1).await;
    media(&pool, 2, "series", Some(11), None, 1).await;
    media(&pool, 3, "movie", Some(33), None, 2).await;
    c.stub.ok(
        "credits/5",
        json!({"cast": [
            {"externalId": 11, "mediaType": "movie", "title": "M", "character": "X", "posterUrl": "https://image.tmdb.org/t/p/w500/a.jpg"},
            {"externalId": 11, "mediaType": "series", "title": "S", "character": "Y"},
            {"externalId": 33, "mediaType": "movie", "title": "Hidden", "character": "Z"},
            {"externalId": 99, "mediaType": "movie", "title": "Unowned", "character": "W"}],
        "crew": [{"externalId": 11, "mediaType": "movie", "title": "M", "job": "Director", "department": "Directing"}]}),
    );
    let (s, d) = call(&c, "/api/persons/1/provider-credits", Some(&c.reader)).await;
    assert_eq!((s, d["provider"].as_str()), (200, Some("tmdb")));
    let link = |list: &str| -> Vec<Value> {
        d[list]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["mediaId"].clone())
            .collect()
    };
    assert_eq!(
        link("cast"),
        [json!(1), json!(2), Value::Null, Value::Null],
        "linked by (type, id)"
    );
    assert_eq!(link("crew"), [json!(1)]);
    assert_eq!(d["cast"][0]["title"], "M");
    assert_eq!(d["cast"][1]["mediaType"], "series");
    assert_eq!(d["cast"][1]["title"], "S");
    assert!(d["cast"][0].get("job").is_none() && d["crew"][0].get("character").is_none());
    let (_, a) = call(&c, "/api/persons/1/provider-credits", Some(&c.admin)).await;
    assert_eq!(a["cast"][2]["mediaId"], 3);
    // the credits route does not refresh the row
    let refreshed: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar(r#"SELECT "metadataRefreshedAt" FROM persons WHERE id = 1"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(refreshed.is_some());
    c.stub.fail("credits/5", 500);
    let (s, b) = call(&c, "/api/persons/1/provider-credits", Some(&c.reader)).await;
    assert_eq!(s, 503);
    assert!(
        b["message"]
            .as_str()
            .unwrap()
            .starts_with("Metadata request failed on tmdb")
    );
}

#[sqlx::test(migrations = false)]
async fn persisting_credits_does_not_fetch_person_details(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    media(&pool, 1, "movie", Some(603), None, 1).await;
    let d = fliks_server::metadata::service::Details::from_value(&json!({
        "provider": "tmdb", "title": "T",
        "cast": [{"externalId": 5, "name": "A", "character": "X", "order": 0}],
        "crew": [{"externalId": 6, "name": "B", "job": "Director", "department": "Directing"}],
    }));
    fliks_server::metadata::service::persist_credits(
        &c.st,
        1,
        MediaKind::Movie,
        Namespace::TMDB,
        &d,
        &[],
    )
    .await
    .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM persons")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 2);
    assert!(c.stub.seen("person").is_empty());
}

#[sqlx::test(migrations = false)]
async fn persisting_details_writes_the_table_of_the_kind(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    media(&pool, 1, "movie", Some(603), None, 1).await;
    media(&pool, 2, "series", Some(604), None, 2).await;
    let d = |v: Value| fliks_server::metadata::service::Details::from_value(&v);
    let first = d(
        json!({"provider": "tmdb", "title": "T", "budget": 7, "tagline": "x",
        "voteCount": 3, "keywords": ["a"]}),
    );
    for (id, kind) in [(1, MediaKind::Movie), (2, MediaKind::Series)] {
        fliks_server::metadata::service::persist_credits(
            &c.st,
            id,
            kind,
            Namespace::TMDB,
            &first,
            &[],
        )
        .await
        .unwrap();
    }
    let again = d(json!({"provider": "tmdb", "title": "T", "voteCount": 4}));
    fliks_server::metadata::service::persist_credits(
        &c.st,
        2,
        MediaKind::Series,
        Namespace::TMDB,
        &again,
        &[],
    )
    .await
    .unwrap();
    let movie: (Option<i64>, Option<String>) =
        sqlx::query_as(r#"SELECT budget, tagline FROM movie_details WHERE "mediaId" = 1"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(movie, (Some(7), Some("x".into())));
    let series: (Option<i32>, Option<String>, Value) = sqlx::query_as(
        r#"SELECT "voteCount", tagline, keywords FROM series_details WHERE "mediaId" = 2"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        series,
        (Some(4), Some("x".into()), json!(["a"])),
        "an absent field keeps the stored value"
    );
    let n: i64 = sqlx::query_scalar(
        r#"SELECT (SELECT COUNT(*) FROM movie_details WHERE "mediaId" = 2)
                + (SELECT COUNT(*) FROM series_details WHERE "mediaId" = 1)"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test(migrations = false)]
async fn concurrent_credit_persists_make_one_person_per_id(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    for id in 1..=2 {
        media(&pool, id, "movie", Some(600 + id), None, id).await;
    }
    let cast = |extra: i64| {
        let mut rows: Vec<Value> = (1..=40)
            .map(
                |i| json!({"externalId": i, "name": format!("P{i}"), "character": "X", "order": i}),
            )
            .collect();
        rows.push(json!({"externalId": 100 + extra, "name": "Own", "character": "Y", "order": 41}));
        fliks_server::metadata::service::Details::from_value(
            &json!({"provider": "tmdb", "title": "T", "cast": rows}),
        )
    };
    let (a, b) = (cast(1), cast(2));
    let (ra, rb) = tokio::join!(
        fliks_server::metadata::service::persist_credits(
            &c.st,
            1,
            MediaKind::Movie,
            Namespace::TMDB,
            &a,
            &[]
        ),
        fliks_server::metadata::service::persist_credits(
            &c.st,
            2,
            MediaKind::Movie,
            Namespace::TMDB,
            &b,
            &[]
        )
    );
    ra.unwrap();
    rb.unwrap();
    let (persons, ids): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM persons), (SELECT COUNT(DISTINCT value) FROM person_external_ids)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((persons, ids), (42, 42));
}

#[sqlx::test(migrations = false)]
async fn a_person_without_an_id_is_served_and_never_refreshed(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    sqlx::query("INSERT INTO persons (id, name, \"metadataRefreshedAt\") VALUES (1, 'Solo', NULL)")
        .execute(&pool)
        .await
        .unwrap();
    let (s, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(s, 200);
    assert_eq!(
        (
            &d["person"]["provider"],
            &d["person"]["tmdbId"],
            &d["person"]["metadataRefreshedAt"]
        ),
        (&Value::Null, &Value::Null, &Value::Null)
    );
    let (s, d) = call(&c, "/api/persons/1/provider-credits", Some(&c.reader)).await;
    assert_eq!(s, 200);
    assert_eq!(d, json!({"provider": null, "cast": [], "crew": []}));
}

#[sqlx::test(migrations = false)]
async fn persisting_credits_skips_person_ids_the_table_refuses(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    media(&pool, 1, "movie", Some(603), None, 1).await;
    let d = fliks_server::metadata::service::Details::from_value(&json!({
        "provider": "tmdb", "title": "T",
        "cast": [
            {"externalId": 5, "name": "A", "character": "X", "order": 0},
            {"externalId": 0, "name": "Z", "character": "X", "order": 1},
            {"externalId": 1_000_000_000, "name": "Big", "character": "X", "order": 2},
            {"externalId": -3, "name": "Neg", "character": "X", "order": 3}
        ],
    }));
    fliks_server::metadata::service::persist_credits(
        &c.st,
        1,
        MediaKind::Movie,
        Namespace::TMDB,
        &d,
        &[],
    )
    .await
    .unwrap();
    let (persons, credits): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM persons), (SELECT COUNT(*) FROM media_credits)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((persons, credits), (1, 1));
}

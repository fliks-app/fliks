//! `/api/metadata/*` and `/api/persons/*` (`docs/spec/metadata.md`, `persons.md`) through the real router, a loopback
//! stub for TMDB, TVDB and the image host, and a fresh database.
use axum::{Router, body::Body, extract::State, http::Request, http::Uri, response::IntoResponse};
use fliks_server::{app, config::Config, images::ImageStore, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

#[derive(Default)]
struct Stub {
    routes: Mutex<HashMap<String, (u16, Vec<u8>)>>,
    log: Mutex<Vec<String>>,
}

impl Stub {
    fn json(&self, path: &str, status: u16, body: Value) {
        self.routes
            .lock()
            .unwrap()
            .insert(path.into(), (status, body.to_string().into_bytes()));
    }

    fn bytes(&self, path: &str, body: Vec<u8>) {
        self.routes.lock().unwrap().insert(path.into(), (200, body));
    }

    fn drop_route(&self, path: &str) {
        self.routes.lock().unwrap().remove(path);
    }

    /// Requests whose path and query start with `prefix`.
    fn seen(&self, prefix: &str) -> Vec<String> {
        self.log
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.starts_with(prefix))
            .cloned()
            .collect()
    }
}

async fn answer(State(s): State<Arc<Stub>>, uri: Uri) -> impl IntoResponse {
    s.log.lock().unwrap().push(uri.to_string());
    match s.routes.lock().unwrap().get(uri.path()) {
        Some((status, body)) => (
            axum::http::StatusCode::from_u16(*status).unwrap(),
            [("content-type", "application/json")],
            body.clone(),
        )
            .into_response(),
        None => (
            axum::http::StatusCode::NOT_FOUND,
            json!({"status_message": "not found"}).to_string(),
        )
            .into_response(),
    }
}

struct Ctx {
    app: Router,
    st: AppState,
    stub: Arc<Stub>,
    data: PathBuf,
    admin: String,
    reader: String,
}

fn jpeg() -> Vec<u8> {
    let img = image::RgbImage::from_fn(300, 450, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 7])
    });
    let mut out = vec![];
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)
        .encode_image(&img)
        .unwrap();
    out
}

async fn ctx_with(pool: PgPool, tvdb_key: &str) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let stub = Arc::new(Stub::default());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let router = Router::new()
        .fallback(axum::routing::any(answer))
        .with_state(stub.clone());
    tokio::spawn(async { axum::serve(l, router).await.unwrap() });
    let cfg = Config::from_lookup(|k| match k {
        "TMDB_API_KEY" => Some("tmdb-secret-key".into()),
        "TVDB_API_KEY" => Some(tvdb_key.into()),
        "FLIKS_TMDB_API_URL" => Some(format!("{base}/tmdb/3")),
        "FLIKS_TVDB_API_URL" => Some(format!("{base}/tvdb/v4")),
        "FLIKS_TMDB_IMAGE_URL" => Some(format!("{base}/img/t/p")),
        _ => None,
    });
    let mut st = AppState::new(pool.clone(), cfg, SECRET);
    let data = std::env::temp_dir().join(format!(
        "fliks-meta-{}",
        fliks_server::config::random_hex(6)
    ));
    st.images = Arc::new(ImageStore::with_root(
        data.clone(),
        &format!("{base}/img/t/p"),
    ));
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
        tokens.push((id, st.jwt.sign_access(id, name).unwrap().token));
    }
    // library 1 is readable by `reader`, library 2 is not
    sqlx::query(
        r#"INSERT INTO libraries (id, name, path) VALUES (1, 'A', '/tmp/a'), (2, 'B', '/tmp/b')"#,
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
        data,
        reader: tokens.pop().unwrap().1,
        admin: tokens.pop().unwrap().1,
    }
}

async fn ctx(pool: PgPool) -> Ctx {
    ctx_with(pool, "tvdb-key").await
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

fn page(results: Value) -> Value {
    json!({"page": 1, "results": results})
}

fn movie(id: i64) -> Value {
    json!({"id": id, "title": format!("Movie {id}"), "release_date": "2020-05-01", "poster_path": "/p.jpg", "genre_ids": [1]})
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
    c.stub.json(
        "/tmdb/3/search/movie",
        200,
        page(json!([movie(11), movie(22), movie(33), movie(44)])),
    );
    let ids = |v: &Value| -> Vec<Value> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| r["existingMediaId"].clone())
            .collect()
    };
    let (s, admin) = call(&c, "/api/metadata/search/movie?q=matrix", Some(&c.admin)).await;
    assert_eq!(s, 200);
    assert_eq!(ids(&admin), [json!(1), json!(2), Value::Null, Value::Null]);
    assert_eq!(admin[0]["existingMediaType"], "movie");
    assert_eq!(admin[0]["year"], 2020);
    assert!(admin[0].get("tvdbId").is_none() && admin[0]["provider"] == "tmdb");
    let (_, reader) = call(&c, "/api/metadata/search/movie?q=matrix", Some(&c.reader)).await;
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
    c.stub
        .json("/tmdb/3/search/movie", 200, page(json!([movie(11)])));
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
    assert!(c.stub.seen("/tmdb/3/search").is_empty());
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
    let log = c.stub.seen("/tmdb/3/search/movie");
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
    c.stub.json(
        "/tmdb/3/search/tv",
        200,
        page(json!([{"id": 500, "name": "T", "first_air_date": "2008-01-01"}])),
    );
    c.stub.json(
        "/tvdb/v4/search",
        200,
        json!({"data": [{"tvdb_id": "81189", "name": "V", "year": "2008", "remote_ids": []}]}),
    );
    c.stub
        .json("/tvdb/v4/login", 200, json!({"data": {"token": "tok"}}));
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
    for q in [
        "&mediaId=5&provider=",
        "&mediaId=zz",
        "&mediaId=0",
        "&mediaId=99999999999",
        "&provider=foo",
    ] {
        let (_, v) = call(
            &c,
            &format!("/api/metadata/search/tv?q=x{q}"),
            Some(&c.admin),
        )
        .await;
        assert_eq!(first(&v).0, "tmdb", "{q}");
    }
    // an empty TMDB answer asks TVDB, whose results keep their own provider
    c.stub.json("/tmdb/3/search/tv", 200, page(json!([])));
    let (_, v) = call(&c, "/api/metadata/search/tv?q=x", Some(&c.admin)).await;
    assert_eq!(first(&v).0, "tvdb");
    c.stub.json("/tvdb/v4/search", 200, json!({"data": []}));
    assert_eq!(
        call(&c, "/api/metadata/search/tv?q=x", Some(&c.admin))
            .await
            .1,
        json!([])
    );
}

#[sqlx::test(migrations = false)]
async fn upstream_failures_are_503_without_the_url(pool: PgPool) {
    let c = ctx(pool).await;
    c.stub.json(
        "/tmdb/3/search/movie",
        500,
        json!({"status_message": "boom"}),
    );
    let (s, b) = call(&c, "/api/metadata/search/movie?q=x", Some(&c.reader)).await;
    assert_eq!((s, b["error"].as_str()), (503, Some("Service Unavailable")));
    let msg = b["message"].as_str().unwrap();
    assert_eq!(msg, "Metadata search failed on tmdb: HTTP 500 — boom");
    assert!(!msg.contains("tmdb-secret-key") && !msg.contains("127.0.0.1"));
    // the same failure on a list with no stale copy is a 503 too
    c.stub.json("/tmdb/3/genre/tv/list", 500, json!({}));
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
    c.stub
        .json("/tmdb/3/movie/popular", 200, page(json!([movie(11)])));
    let (_, live) = call(&c, "/api/metadata/popular/movie", Some(&c.admin)).await;
    c.stub.json("/tmdb/3/movie/popular", 500, json!({}));
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
async fn the_breaker_stops_sending_after_three_failures(pool: PgPool) {
    let c = ctx(pool).await;
    c.stub.json("/tmdb/3/search/movie", 500, json!({}));
    for _ in 0..5 {
        assert_eq!(
            call(&c, "/api/metadata/search/movie?q=x", Some(&c.reader))
                .await
                .0,
            503
        );
    }
    assert_eq!(c.stub.seen("/tmdb/3/search/movie").len(), 3);
    let (_, b) = call(&c, "/api/metadata/search/movie?q=x", Some(&c.reader)).await;
    assert!(b["message"].as_str().unwrap().contains("circuit open"));
}

#[sqlx::test(migrations = false)]
async fn client_errors_do_not_trip_the_breaker(pool: PgPool) {
    let c = ctx(pool).await;
    for _ in 0..5 {
        assert_eq!(
            call(&c, "/api/metadata/tmdb/movie/9", Some(&c.reader))
                .await
                .0,
            404
        );
    }
    assert_eq!(c.stub.seen("/tmdb/3/movie/9").len(), 5);
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
    c.stub.json("/tmdb/3/movie/9", 500, json!({}));
    assert_eq!(get("/api/metadata/movie/9").await.0, 503);
    assert!(c.stub.seen("/tmdb/3/movie/abc").is_empty());
    assert_eq!(call(&c, "/api/metadata/tmdb/movie/9", None).await.0, 401);
}

#[sqlx::test(migrations = false)]
async fn details_seasons_and_stubs(pool: PgPool) {
    let c = ctx(pool).await;
    c.stub.json(
        "/tmdb/3/movie/603",
        200,
        json!({"id": 603, "title": "The Matrix", "release_date": "1999-03-30", "budget": 0, "status": "Released",
               "genres": [{"id": 28, "name": "Action"}], "poster_path": "/p.jpg", "belongs_to_collection": {"id": 2, "name": "C"}}),
    );
    let (s, d) = call(&c, "/api/metadata/movie/603", Some(&c.reader)).await;
    assert_eq!(s, 200);
    assert_eq!(
        (d["title"].clone(), d["year"].clone(), d["budget"].clone()),
        (json!("The Matrix"), json!(1999), Value::Null)
    );
    assert_eq!(d["tmdbCollectionName"], "C");
    assert_eq!(d["status"], "released");
    assert!(
        d["posterUrl"]
            .as_str()
            .unwrap()
            .ends_with("/img/t/p/w500/p.jpg")
    );
    c.stub.json(
        "/tmdb/3/tv/7",
        200,
        json!({"seasons": [{"season_number": 0, "episode_count": 1}, {"season_number": 1, "episode_count": 2}, {"season_number": 2}]}),
    );
    c.stub.json(
        "/tmdb/3/tv/7/season/0",
        200,
        json!({"season_number": 0, "episodes": [{"episode_number": 1, "name": "S"}]}),
    );
    c.stub.json(
        "/tmdb/3/tv/7/season/1",
        200,
        json!({"season_number": 1, "overview": "o", "episodes": []}),
    );
    let (_, stubs) = call(&c, "/api/metadata/tmdb/tv/7/season-stubs", Some(&c.reader)).await;
    assert_eq!(
        stubs,
        json!([{"seasonNumber": 0, "episodeCount": 1}, {"seasonNumber": 1, "episodeCount": 2}, {"seasonNumber": 2, "episodeCount": 0}])
    );
    let (_, seasons) = call(&c, "/api/metadata/tmdb/tv/7/seasons", Some(&c.reader)).await;
    let numbers: Vec<_> = seasons
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["seasonNumber"].clone())
        .collect();
    assert_eq!(
        numbers,
        [json!(0), json!(1)],
        "season 2 failed and is dropped, specials kept"
    );
    assert_eq!(seasons[1]["overview"], "o");
}

#[sqlx::test(migrations = false)]
async fn discover_and_language(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    c.stub.json("/tmdb/3/discover/movie", 200, page(json!([])));
    c.stub.json("/tmdb/3/discover/tv", 200, page(json!([])));
    call(
        &c,
        "/api/metadata/discover/movie?genres=28,abc,12&voteGte=7.5&yearGte=1999&yearLte=2003",
        Some(&c.reader),
    )
    .await;
    let q = &c.stub.seen("/tmdb/3/discover/movie")[0];
    for want in [
        "with_genres=28%2C12",
        "vote_average.gte=7.5",
        "primary_release_date.gte=1999-01-01",
        "primary_release_date.lte=2003-12-31",
        "sort_by=popularity.desc",
        "include_adult=false",
    ] {
        assert!(q.contains(want), "{want} in {q}");
    }
    call(
        &c,
        "/api/metadata/discover/tv?sort=primary_release_date.desc",
        Some(&c.reader),
    )
    .await;
    assert!(c.stub.seen("/tmdb/3/discover/tv")[0].contains("sort_by=first_air_date.desc"));
    sqlx::query(r#"INSERT INTO app_settings ("key", "value") VALUES ('metadata_language', 'fr')"#)
        .execute(&pool)
        .await
        .unwrap();
    c.st.metadata
        .lang
        .settings_changed(&["metadata_language".into()]);
    c.stub.json("/tmdb/3/search/movie", 200, page(json!([])));
    call(&c, "/api/metadata/search/movie?q=x", Some(&c.reader)).await;
    assert!(c.stub.seen("/tmdb/3/search/movie")[0].contains("language=fr-FR"));
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

fn tmdb_person(name: &str, profile: Option<&str>) -> Value {
    json!({"id": 1, "name": name, "biography": "fresh bio", "birthday": null, "deathday": null, "place_of_birth": "Paris",
           "profile_path": profile, "known_for_department": "Acting"})
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
        c.stub.seen("/tmdb").is_empty(),
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
    c.stub.json(
        "/tmdb/3/person/5",
        200,
        tmdb_person("New Name", Some("/face.jpg")),
    );
    let src = jpeg();
    c.stub.bytes("/img/t/p/original/face.jpg", src.clone());
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
    assert_eq!(c.stub.seen("/tmdb/3/person/5").len(), 1);
    // the original avatar was asked at `original`
    assert_eq!(c.stub.seen("/img/").len(), 1);
}

#[sqlx::test(migrations = false)]
async fn a_failing_refresh_serves_the_stored_row(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    person(&pool, 1, "tmdb", 5, "Stored", "never").await;
    c.stub.json("/tmdb/3/person/5", 500, json!({}));
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
    c.stub.json(
        "/tmdb/3/person/5",
        200,
        tmdb_person("Stored", Some("/missing.jpg")),
    );
    let (_, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(d["person"]["avatarUrl"], Value::Null);
    assert_eq!(d["person"]["biography"], "fresh bio");
}

#[sqlx::test(migrations = false)]
async fn a_404_asks_the_other_provider_and_pins_the_row(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    person(&pool, 1, "tmdb", 5, "Stored", "8 days").await;
    c.stub
        .json("/tvdb/v4/login", 200, json!({"data": {"token": "t"}}));
    c.stub.json(
        "/tvdb/v4/people/5/extended",
        200,
        json!({"data": {"name": "From Tvdb", "biographies": [{"language": "eng", "biography": "english"}], "characters": [{"peopleType": "Director", "name": "", "movieId": 11, "movie": {"name": "M", "year": "2001"}}]}}),
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
    c.stub
        .json("/tvdb/v4/login", 200, json!({"data": {"token": "t"}}));
    c.stub.json(
        "/tvdb/v4/people/5/extended",
        200,
        json!({"data": {"name": "From Tvdb", "biographies": [], "characters": []}}),
    );
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
async fn without_a_tvdb_key_a_tvdb_person_is_asked_of_tmdb(pool: PgPool) {
    let c = ctx_with(pool.clone(), "").await;
    person(&pool, 1, "tvdb", 5, "Stored", "8 days").await;
    c.stub
        .json("/tmdb/3/person/5", 200, tmdb_person("Via Tmdb", None));
    let (_, d) = call(&c, "/api/persons/1", Some(&c.reader)).await;
    assert_eq!(d["person"]["name"], "Via Tmdb");
    assert!(c.stub.seen("/tvdb").is_empty());
}

#[sqlx::test(migrations = false)]
async fn provider_credits_link_on_type_and_id_for_readable_media(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    person(&pool, 1, "tmdb", 5, "P", "1 day").await;
    media(&pool, 1, "movie", Some(11), None, 1).await;
    media(&pool, 2, "series", Some(11), None, 1).await;
    media(&pool, 3, "movie", Some(33), None, 2).await;
    c.stub.json(
        "/tmdb/3/person/5/combined_credits",
        200,
        json!({"cast": [
            {"id": 11, "media_type": "movie", "title": "M", "character": "X", "poster_path": "/a.jpg", "release_date": "2020-01-01", "vote_average": 5},
            {"id": 11, "media_type": "tv", "name": "S", "character": "Y", "first_air_date": "2019-01-01"},
            {"id": 33, "media_type": "movie", "title": "Hidden", "character": "Z"},
            {"id": 99, "media_type": "movie", "title": "Unowned", "character": "W"}],
        "crew": [{"id": 11, "media_type": "movie", "title": "M", "job": "Director", "department": "Directing"}]}),
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
    assert!(
        d["cast"][0]["posterUrl"]
            .as_str()
            .unwrap()
            .ends_with("/w500/a.jpg")
    );
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
    c.stub
        .json("/tmdb/3/person/5/combined_credits", 500, json!({}));
    let (s, b) = call(&c, "/api/persons/1/provider-credits", Some(&c.reader)).await;
    assert_eq!(s, 503);
    assert!(
        b["message"]
            .as_str()
            .unwrap()
            .starts_with("Metadata request failed on tmdb")
    );
    c.stub.drop_route("/tmdb/3/person/5/combined_credits");
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
    fliks_server::metadata::service::persist_credits(&c.st, 1, &d)
        .await
        .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM persons")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 2);
    assert!(c.stub.seen("/tmdb/3/person/").is_empty());
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
        fliks_server::metadata::service::persist_credits(&c.st, 1, &a),
        fliks_server::metadata::service::persist_credits(&c.st, 2, &b)
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
    fliks_server::metadata::service::persist_credits(&c.st, 1, &d)
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

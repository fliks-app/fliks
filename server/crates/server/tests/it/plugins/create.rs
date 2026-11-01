//! `media.resolveOrCreate` (`plugins.md` rule 57): scope gate, refusals and the title lock.
use super::harness::*;
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::get,
};
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

const LIBRARY: &str = r#"INSERT INTO libraries (id, name, "mediaTypes", path)
    VALUES (1, 'Movies', '["movie"]', '/nonexistent/m')"#;

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
        r#"INSERT INTO libraries (id, name, "mediaTypes", path)
             VALUES (1, 'Movies', '["movie"]', '/nonexistent/m');
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
    sqlx::raw_sql(
        r#"INSERT INTO media (id, title, type) VALUES (7, 'Held', 'movie');
           INSERT INTO media_external_ids ("mediaId", kind, provider, value)
             VALUES (7, 'movie', 'tmdb', '603');"#,
    )
    .execute(&s.pool)
    .await
    .unwrap();
    for kind in ["book", "comic", "album", "artist", "", "Movie"] {
        let r = call(&h, "create", &[("kind", kind), ("tmdb", "603")]).await;
        assert_eq!(r["error"], "unsupported-kind", "{kind}: {r}");
    }
    let r = call(&h, "create", &[]).await;
    assert_eq!(r["error"], "unsupported-provider", "no tmdb id: {r}");
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

async fn details(
    State(hits): State<Arc<AtomicUsize>>,
    Path((kind, id)): Path<(String, i32)>,
) -> Json<Value> {
    hits.fetch_add(1, Ordering::SeqCst);
    let mut b = json!({
        "id": id, "overview": "o", "genres": [], "poster_path": null, "status": "Released",
        "runtime": 100, "credits": {"cast": [], "crew": []},
    });
    if kind == "movie" {
        b["title"] = json!(format!("Movie {id}"));
        b["release_date"] = json!("2020-01-01");
    } else {
        b["name"] = json!(format!("Series {id}"));
        b["first_air_date"] = json!("2020-01-01");
        b["number_of_seasons"] = json!(0);
        b["seasons"] = json!([]);
    }
    Json(b)
}

/// An `AppState` whose TMDB is a loopback stub answering any id.
/// The second value counts the detail reads, one per title imported.
async fn state_with_tmdb(s: &Scratch) -> (AppState, Arc<AtomicUsize>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let hits = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route("/tmdb/3/{kind}/{id}", get(details))
        .with_state(hits.clone());
    tokio::spawn(async { axum::serve(l, app).await.unwrap() });
    let cfg = Config::from_lookup(|k| match k {
        "TMDB_API_KEY" => Some("tmdb-test-key".into()),
        "FLIKS_TMDB_API_URL" => Some(format!("{base}/tmdb/3")),
        _ => None,
    });
    let mut st = AppState::new(s.pool.clone(), cfg, SECRET);
    let data = std::env::temp_dir().join(format!(
        "fliks-create-{}",
        fliks_server::config::random_hex(6)
    ));
    st.images = Arc::new(ImageStore::with_root(data, &format!("{base}/img")));
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
    sqlx::query(LIBRARY).execute(&s.pool).await.unwrap();
    let (st, hits) = state_with_tmdb(&s).await;
    let mut rx = st.hub.subscribe();
    let calls = (0..5).map(|_| {
        let st = st.clone();
        tokio::spawn(async move { resolve_or_create(&st, "movie", &tmdb("603"), None).await })
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
    let again = resolve_or_create(&st, "movie", &tmdb("603"), None).await;
    assert_eq!(again.unwrap(), ids[0], "a later call finds it");
    assert_eq!(media_count(&s.pool).await, 1);
    let e = resolve_or_create(&st, "movie", &tmdb("604"), Some(99)).await;
    assert_eq!(e.unwrap_err().code, "ERR_NOT_FOUND", "unknown library");
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
        r#"INSERT INTO libraries (id, name, "mediaTypes", path)
             VALUES (1, 'Movies', '["movie"]', '/nonexistent/m');
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
    let plugin = resolve_or_create(&st, "movie", &ids, None);
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

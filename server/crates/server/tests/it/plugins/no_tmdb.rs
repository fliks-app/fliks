//! A Fliks without TMDB (`provider-plugins.md` section 5.3): lists, search and requests with no TMDB provider,
//! then with a third-party provider. The third-party cases need the fixture wasm, skipped without it.
use super::harness::*;
use serde_json::{Value, json};

const NS: &str = "org.example.anime:aid";

async fn series_library(h: &H) {
    sqlx::query(r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Series', '["series"]'::jsonb)"#)
        .execute(&h.st.db)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO library_folders ("libraryId", path) VALUES (1, '/tmp/fliks-no-tmdb/Series')"#)
        .execute(&h.st.db)
        .await
        .unwrap();
}

async fn get(h: &H, uri: &str) -> (u16, Value) {
    h.call("GET", uri, Some(&h.admin), None).await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_no_provider_lists_and_search_answer_empty_and_a_request_waits() {
    let Some(s) = Scratch::create("notmdb").await else {
        return;
    };
    let h = harness(&s, "notmdb", |_| {}).await;
    series_library(&h).await;
    for uri in [
        "search/movie?q=x",
        "search/tv?q=x",
        "trending/movie",
        "popular/tv",
        "upcoming/movie",
        "discover/tv",
        "genres/movie",
        "genres/tv",
    ] {
        let (st, body) = get(&h, &format!("/api/metadata/{uri}")).await;
        assert_eq!((st, &body), (200, &json!([])), "{uri}");
    }
    let (st, body) = get(&h, "/api/metadata/movie/603").await;
    assert_eq!(st, 400, "{body}");
    assert_eq!(body["message"], "Unknown provider: tmdb");

    let ask = json!({"mediaType": "series", "tmdbId": 1396, "title": "T"});
    let (st, r) = h
        .call("POST", "/api/requests", Some(&h.admin), Some(ask))
        .await;
    assert_eq!((st, &r["status"]), (201, &json!("pending")), "{r}");
    let id = r["id"].as_i64().unwrap();
    let (st, r) = h
        .call(
            "POST",
            &format!("/api/requests/{id}/approve"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 503, "a missing provider is not a client error: {r}");
    assert_eq!(r["message"], "The tmdb provider is not available");
    h.finish().await;
    s.finish().await;
}

async fn held(h: &H, id: i32, ids: &[(&str, &str)]) {
    sqlx::query(
        r#"INSERT INTO media (id, title, type, "libraryId") VALUES ($1, 'm', 'series', 1)"#,
    )
    .bind(id)
    .execute(&h.st.db)
    .await
    .unwrap();
    for (p, v) in ids {
        sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'series', $2, $3)"#)
            .bind(id)
            .bind(p)
            .bind(v)
            .execute(&h.st.db)
            .await
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_library_title_is_one_request_whichever_key_asks_and_a_double_hold_is_no_error() {
    let Some(s) = Scratch::create("notmdbkeys").await else {
        return;
    };
    let h = harness(&s, "notmdbkeys", |_| {}).await;
    series_library(&h).await;
    held(&h, 100, &[("tmdb", "1396"), ("tvdb", "81189")]).await;
    held(&h, 101, &[("tmdb", "2"), ("tvdb", "20")]).await;
    held(&h, 102, &[("tmdb", "3"), ("tvdb", "555")]).await;
    held(&h, 103, &[("tmdb", "4"), ("tvdb", "555")]).await;
    let ask = |body: Value| h.call("POST", "/api/requests", Some(&h.admin), Some(body));
    let tmdb = |id: i64| json!({"mediaType": "series", "tmdbId": id, "title": "T"});
    let tvdb = |id: &str| json!({"mediaType": "series", "provider": "tvdb", "externalId": id, "title": "T"});
    assert_eq!(ask(tmdb(1396)).await.0, 201);
    assert_eq!(ask(tvdb("81189")).await.0, 409, "tmdb first, then tvdb");
    assert_eq!(ask(tvdb("20")).await.0, 201);
    assert_eq!(ask(tmdb(2)).await.0, 409, "tvdb first, then tmdb");
    let (st, state) = get(
        &h,
        "/api/requests/title-state?mediaType=series&provider=tvdb&externalId=555",
    )
    .await;
    assert_eq!(
        st, 200,
        "a tvdb id held twice names no library row: {state}"
    );
    h.finish().await;
    s.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_third_party_provider_serves_search_and_requests_without_tmdb() {
    let Some(w) = wasm("fixture_provider") else {
        return;
    };
    let Some(s) = Scratch::create("notmdb3p").await else {
        return;
    };
    let h = harness(&s, "notmdb3p", |_| {}).await;
    allow_unsigned(&h).await;
    series_library(&h).await;
    let m = template("fixture-provider");
    let r = h.install(&pack(&m, "0.1.0", &w, None)).await;
    assert_eq!(r["status"], "active", "{r}");

    let (st, found) = get(&h, "/api/metadata/search/tv?q=x").await;
    assert_eq!(st, 200, "{found}");
    assert_eq!(found[0]["provider"], NS);
    assert_eq!(found[0]["externalId"], "1");
    assert_eq!(found[0]["mediaType"], "series");
    assert_eq!(found[0]["existingMediaId"], Value::Null);
    let (_, found) = get(&h, "/api/metadata/search/movie?q=x").await;
    assert_eq!(found, json!([]), "the fixture serves no movie");
    let (st, d) = get(&h, &format!("/api/metadata/{NS}/tv/1")).await;
    assert_eq!((st, &d["title"]), (200, &json!("Sample")), "{d}");

    let ask = json!({"mediaType": "series", "provider": NS, "externalId": "1", "title": "Sample"});
    let (st, r) = h
        .call("POST", "/api/requests", Some(&h.admin), Some(ask.clone()))
        .await;
    assert_eq!(st, 201, "{r}");
    assert_eq!(
        (&r["provider"], &r["externalId"], &r["tmdbId"]),
        (&json!(NS), &json!("1"), &Value::Null)
    );
    let id = r["id"].as_i64().unwrap();
    let (_, dup) = h
        .call("POST", "/api/requests", Some(&h.admin), Some(ask))
        .await;
    assert_eq!(
        dup["statusCode"], 409,
        "the same title is one request: {dup}"
    );

    let q = format!("provider={NS}&externalId=1&mediaType=series");
    let (st, state) = get(&h, &format!("/api/requests/title-state?{q}")).await;
    assert_eq!((st, &state["requested"]), (200, &json!(true)), "{state}");
    let (_, list) = get(&h, &format!("/api/requests?{q}")).await;
    assert_eq!(list["total"], 1, "{list}");
    let (_, none) = get(&h, &format!("/api/requests?provider={NS}&externalId=2")).await;
    assert_eq!(none["total"], 0);

    let (st, r) = h
        .call(
            "POST",
            &format!("/api/requests/{id}/approve"),
            Some(&h.admin),
            None,
        )
        .await;
    assert_eq!(st, 201, "{r}");
    let held: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM media_external_ids WHERE provider = $1 AND value = '1'",
    )
    .bind(NS)
    .fetch_one(&h.st.db)
    .await
    .unwrap();
    assert_eq!(
        held, 1,
        "the approval imported the title under its own namespace"
    );
    let (_, found) = get(&h, "/api/metadata/search/tv?q=x").await;
    assert!(found[0]["existingMediaId"].is_i64(), "{found}");

    let (st, r) = h
        .call(
            "POST",
            "/api/media/import",
            Some(&h.admin),
            Some(json!({"type": "series", "provider": NS, "externalId": "1"})),
        )
        .await;
    assert_eq!(st, 409, "the plugin title is already held: {r}");
    let media: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
        .fetch_one(&h.st.db)
        .await
        .unwrap();
    assert_eq!(media, 1, "one media row for the title");

    sqlx::query(r#"INSERT INTO libraries (id, name, "mediaTypes") VALUES (2, 'Other', '["series"]'::jsonb)"#)
        .execute(&h.st.db)
        .await
        .unwrap();
    sqlx::query(r#"UPDATE media SET "libraryId" = 2"#)
        .execute(&h.st.db)
        .await
        .unwrap();
    sqlx::query("UPDATE requests SET status = 'declined'")
        .execute(&h.st.db)
        .await
        .unwrap();
    let role: i32 = sqlx::query_scalar(
        r#"INSERT INTO roles (name, permissions) VALUES ('limited', '["media.read","requests.create"]') RETURNING id"#,
    )
    .fetch_one(&h.st.db)
    .await
    .unwrap();
    let uid: i32 = sqlx::query_scalar(
        r#"INSERT INTO users (username, "isAdmin", "roleId") VALUES ('limited', false, $1) RETURNING id"#,
    )
    .bind(role)
    .fetch_one(&h.st.db)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, $1)"#)
        .bind(uid)
        .execute(&h.st.db)
        .await
        .unwrap();
    let limited = h.st.jwt.sign_access(uid, "limited").unwrap().token;
    let (st, _) = h
        .call(
            "POST",
            "/api/auto-approval-rules",
            Some(&h.admin),
            Some(json!({"name": "r", "criteria": {}})),
        )
        .await;
    assert_eq!(st, 201);
    let (st, r) = h
        .call(
            "POST",
            "/api/requests",
            Some(&limited),
            Some(json!({"mediaType": "series", "provider": NS, "externalId": "1", "title": "T", "libraryId": 1})),
        )
        .await;
    assert_eq!(
        st, 403,
        "a library the user cannot reach is not adopted: {r}"
    );
    let (st, r) = h
        .call(
            "POST",
            "/api/requests",
            Some(&h.admin),
            Some(json!({"mediaType": "series", "provider": "org.example.gone:aid", "externalId": "1", "title": "T"})),
        )
        .await;
    assert_eq!(st, 400, "an unknown provider is refused: {r}");
    h.finish().await;
    s.finish().await;
}

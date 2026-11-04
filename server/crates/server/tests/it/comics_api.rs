//! The comic read shapes (`comics.md`): the detail object, the list info, the counts, the model's CHECKs.
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, media, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

async fn ctx(pool: &PgPool) -> (Router, String, String) {
    fliks_server::db::migrate(pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'plain', false, 1);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'L1', '["comic"]'), (2, 'L2', '["comic"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/c/one'), (2, '/c/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2);
        INSERT INTO media (id, title, year, type, "libraryId", "folderName") VALUES
          (10, 'Alpha Run', 2016, 'comic', 1, 'a'), (11, 'Empty Run', 2020, 'comic', 1, 'e'),
          (12, 'Movie', 2000, 'movie', 1, 'm'), (13, 'Done Run', 2018, 'comic', 1, 'd');
        INSERT INTO comic_details ("mediaId", publisher, "startYear", volume) VALUES (10, 'Pub', 2016, 2);
        INSERT INTO editions (id, "mediaId", family, format, "libraryId") VALUES
          (1, 10, 'image', 'cbz', NULL), (2, 10, 'image', 'cbz', 2), (3, 13, 'image', 'cbz', NULL);
        INSERT INTO items (id, "mediaId", "editionId", title, "airDate") VALUES
          (1, 10, 1, 'Start', '2016-03-02'), (2, 10, 1, NULL, NULL), (3, 10, 1, NULL, NULL), (4, 10, 1, NULL, NULL),
          (5, 10, 1, NULL, NULL), (6, 10, 2, NULL, NULL), (7, 13, 3, NULL, NULL);
        INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label, "pageCount") VALUES
          (1, 10, 'issue', 1, '1', 24), (2, 10, 'issue', 1.5, '1.5', NULL), (3, 10, 'issue', 0, '0', 12),
          (4, 10, 'annual', 1, '1', 40), (5, 10, 'special', 1, '1', NULL), (6, 10, 'issue', 7, '7', NULL),
          (7, 13, 'issue', 1, '1', 20);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, '001.cbz', 1, 'CBZ', '{}'), (2, 10, 1, '000.PDF', 1, 'PDF', '{}'), (3, 13, 1, '013.cbz', 1, 'CBZ', '{}'),
          (4, 10, 1, '001-v2.cbr', 1, 'CBR', '{}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (1, 4, 10, 1, 0), (3, 2, 10, 0, 0), (7, 3, 13, 0, 0);
        INSERT INTO playback_states ("userId", "itemId", "mediaFileId", "positionSeconds", "durationSeconds", completed, progression) VALUES
          (1, 1, 1, 0, 0, true, 1), (1, 2, NULL, 0, 0, false, 0.25), (1, 7, NULL, 0, 0, true, 1), (2, 1, NULL, 10, 100, false, NULL);
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
    let admin = st.jwt.sign_access(1, "admin").unwrap().token;
    let plain = st.jwt.sign_access(2, "plain").unwrap().token;
    (
        media::router()
            .merge(fliks_server::social::router())
            .with_state(st),
        admin,
        plain,
    )
}

async fn get(app: &Router, token: &str, uri: &str) -> Value {
    let req = Request::builder()
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status().as_u16(), 200, "{uri}");
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[sqlx::test(migrations = false)]
async fn detail_lists_main_issues_then_annuals_by_decimal_sort(pool: PgPool) {
    let (app, t, _) = ctx(&pool).await;
    let v = get(&app, &t, "/api/media/10").await;
    assert_eq!(v["type"], "comic");
    let c = &v["comic"];
    assert_eq!(
        (&c["publisher"], &c["startYear"], &c["volume"]),
        (&json!("Pub"), &json!(2016), &json!(2))
    );
    let rows: Vec<(i64, &str, &str, bool)> = c["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["itemId"].as_i64().unwrap(),
                i["number"].as_str().unwrap(),
                i["kind"].as_str().unwrap(),
                i["annual"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            (3, "0", "issue", false),
            (1, "1", "issue", false),
            (2, "1.5", "issue", false),
            (6, "7", "issue", false),
            (4, "1", "annual", true),
            (5, "1", "special", true)
        ]
    );
    // the file the caller's state names wins over the highest version (file 4)
    assert_eq!(
        c["issues"][1],
        json!({"itemId": 1, "mediaFileId": 1, "format": "cbz", "number": "1", "sort": 1, "annual": false,
               "kind": "issue", "title": "Start", "overview": null, "releaseDate": "2016-03-02", "pageCount": 24,
               "progression": 1, "finished": true})
    );
    assert_eq!(c["issues"][2]["progression"], 0.25);
    assert_eq!(c["issues"][2]["mediaFileId"], Value::Null);
    assert_eq!(c["issues"][2]["format"], Value::Null);
    assert_eq!(c["issues"][0]["progression"], Value::Null);
    assert_eq!(c["issues"][0]["format"], "pdf");
    let other = get(&app, &t, "/api/media/12").await;
    assert!(other.get("comic").is_none());
}

#[sqlx::test(migrations = false)]
async fn progress_is_the_callers_and_hidden_editions_are_left_out(pool: PgPool) {
    let (app, _, plain) = ctx(&pool).await;
    let v = get(&app, &plain, "/api/media/10").await;
    let issues = v["comic"]["issues"].as_array().unwrap();
    assert!(
        issues.iter().all(|i| i["itemId"] != 6),
        "edition of library 2"
    );
    let first = issues.iter().find(|i| i["itemId"] == 1).unwrap();
    assert_eq!(
        (&first["progression"], &first["finished"]),
        (&json!(0.1), &json!(false))
    );
    assert_eq!(
        (&first["mediaFileId"], &first["format"]),
        (&json!(4), &json!("cbr"))
    );
    let l = get(&app, &plain, "/api/media?type=comic&limit=0&sortBy=title").await;
    let alpha = l["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == 10)
        .unwrap();
    assert_eq!(alpha["comic"]["issueCount"], 5);
    assert_eq!(alpha["comic"]["readCount"], 0);
}

#[sqlx::test(migrations = false)]
async fn list_items_carry_the_comic_info_and_counts_the_kind(pool: PgPool) {
    let (app, t, _) = ctx(&pool).await;
    let v = get(&app, &t, "/api/media?type=comic&limit=0&sortBy=title").await;
    let data = v["data"].as_array().unwrap();
    assert_eq!(data.len(), 3);
    assert_eq!(
        data[0]["comic"],
        json!({"publisher": "Pub", "startYear": 2016, "issueCount": 6, "readCount": 1})
    );
    let empty = data.iter().find(|m| m["id"] == 11).unwrap();
    assert_eq!(
        empty["comic"],
        json!({"publisher": null, "startYear": null, "issueCount": 0, "readCount": 0})
    );
    let counts = get(&app, &t, "/api/media/counts").await;
    assert_eq!(counts["comics"], 3);
}

#[sqlx::test(migrations = false)]
async fn a_volume_is_finished_when_every_issue_with_a_file_is_completed(pool: PgPool) {
    let (app, t, _) = ctx(&pool).await;
    let v = get(&app, &t, "/api/media?type=comic&limit=0").await;
    let watched = |id: i64| {
        v["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == id)
            .unwrap()["watched"]
            .clone()
    };
    assert_eq!(
        (watched(10), watched(11), watched(13)),
        (json!(false), json!(false), json!(true))
    );
    let stats = get(&app, &t, "/api/social/users/1/stats").await;
    assert_eq!(stats["playback"]["comicsFinished"], 1);
}

#[sqlx::test(migrations = false)]
async fn the_model_refuses_what_a_comic_cannot_hold(pool: PgPool) {
    let _ = ctx(&pool).await;
    for bad in [
        r#"INSERT INTO comic_issues ("itemId", "mediaId", "sortNumber", label) VALUES (1, 10, 9, '')"#,
        r#"INSERT INTO comic_issues ("itemId", "mediaId", "sortNumber", label, "pageCount") VALUES (1, 10, 9, '9', 0)"#,
        r#"INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label) VALUES (1, 10, 'variant', 9, '9')"#,
        r#"INSERT INTO comic_issues ("itemId", "mediaId", "sortNumber", label) VALUES (1, 11, 9, '9')"#,
        r#"INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label) VALUES (1, 10, 'annual', 'NaN', '9')"#,
        r#"INSERT INTO comic_issues ("itemId", "mediaId", "sortNumber", label) VALUES (1, 10, 1, '1')"#,
        r#"INSERT INTO comic_details ("mediaId", "startYear") VALUES (11, 0)"#,
        r#"INSERT INTO comic_details ("mediaId") VALUES (12)"#,
    ] {
        assert!(sqlx::raw_sql(bad).execute(&pool).await.is_err(), "{bad}");
    }
}

async fn patch(app: &Router, token: &str, uri: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method("PATCH")
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test(migrations = false)]
async fn an_admin_edits_a_volume_and_locks_what_changed(pool: PgPool) {
    let (app, admin, plain) = ctx(&pool).await;
    let (s, _) = patch(
        &app,
        &plain,
        "/api/media/10/comic",
        json!({"publisher": "X"}),
    )
    .await;
    assert_eq!(s, 403);
    let (s, v) = patch(
        &app,
        &admin,
        "/api/media/10/comic",
        json!({"title": " New Run ", "publisher": "Other", "startYear": 2015, "volume": 3, "overview": "About"}),
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(
        (&v["publisher"], &v["startYear"], &v["volume"]),
        (&json!("Other"), &json!(2015), &json!(3))
    );
    let m = get(&app, &admin, "/api/media/10").await;
    assert_eq!(
        (&m["title"], &m["year"], &m["overview"]),
        (&json!("New Run"), &json!(2015), &json!("About"))
    );
    let mut locked: Vec<String> = sqlx::query_scalar(
        r#"SELECT field FROM media_field_sources WHERE "mediaId" = 10 AND locked AND provider IS NULL"#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    locked.sort();
    assert_eq!(
        locked,
        ["details", "overview", "publisher", "title", "year"]
    );
    let (s, _) = patch(&app, &admin, "/api/media/10/comic", json!({"title": ""})).await;
    assert_eq!(s, 400);
    let (s, _) = patch(&app, &admin, "/api/media/10/comic", json!({"startYear": 0})).await;
    assert_eq!(s, 400);
    let (s, _) = patch(
        &app,
        &admin,
        "/api/media/12/comic",
        json!({"publisher": "X"}),
    )
    .await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn an_admin_edits_an_issue_and_the_key_stays_unique(pool: PgPool) {
    let (app, admin, plain) = ctx(&pool).await;
    let (s, _) = patch(&app, &plain, "/api/comics/issues/2", json!({"title": "X"})).await;
    assert_eq!(s, 403);
    let (s, v) = patch(
        &app,
        &admin,
        "/api/comics/issues/2",
        json!({"number": "2", "sort": 2, "kind": "special", "title": "Two", "releaseDate": "2016-04-05", "overview": "O"}),
    )
    .await;
    assert_eq!(s, 200);
    let i = v["issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["itemId"] == 2)
        .unwrap();
    assert_eq!(
        (
            &i["number"],
            &json!(i["sort"].as_f64()),
            &i["kind"],
            &i["title"],
            &i["releaseDate"]
        ),
        (
            &json!("2"),
            &json!(Some(2.0)),
            &json!("special"),
            &json!("Two"),
            &json!("2016-04-05")
        )
    );
    let locked: Vec<String> = sqlx::query_scalar(
        r#"SELECT unnest("lockedFields") FROM comic_issues WHERE "itemId" = 2 ORDER BY 1"#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        locked,
        ["kind", "label", "overview", "releaseDate", "sort", "title"]
    );
    let (s, _) = patch(&app, &admin, "/api/comics/issues/3", json!({"sort": 5})).await;
    assert_eq!(s, 200);
    let (s, _) = patch(
        &app,
        &admin,
        "/api/comics/issues/3",
        json!({"sort": 1, "kind": "annual"}),
    )
    .await;
    assert_eq!(s, 409);
    let (s, _) = patch(
        &app,
        &admin,
        "/api/comics/issues/3",
        json!({"releaseDate": "x"}),
    )
    .await;
    assert_eq!(s, 400);
    let (s, v) = patch(&app, &admin, "/api/comics/issues/3", json!({"title": null})).await;
    assert_eq!(s, 200);
    assert!(
        v["issues"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["itemId"] == 3 && i["title"].is_null())
    );
    let (s, _) = patch(
        &app,
        &admin,
        "/api/comics/issues/999",
        json!({"title": "x"}),
    )
    .await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn unlock_caps_and_null_kind_are_refused_or_honoured(pool: PgPool) {
    let (app, admin, _) = ctx(&pool).await;
    let long = "x".repeat(501);
    let (s, _) = patch(&app, &admin, "/api/media/10/comic", json!({"title": long})).await;
    assert_eq!(s, 400);
    let (s, _) = patch(&app, &admin, "/api/media/10/comic", json!({"title": "T"})).await;
    assert_eq!(s, 200);
    let (s, _) = patch(
        &app,
        &admin,
        "/api/media/10/comic",
        json!({"title": "U", "unlock": ["title"]}),
    )
    .await;
    assert_eq!(s, 400);
    let (s, _) = patch(
        &app,
        &admin,
        "/api/media/10/comic",
        json!({"unlock": ["bogus"]}),
    )
    .await;
    assert_eq!(s, 400);
    let (s, _) = patch(
        &app,
        &admin,
        "/api/media/10/comic",
        json!({"unlock": ["title"]}),
    )
    .await;
    assert_eq!(s, 200);
    let n: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM media_field_sources WHERE "mediaId" = 10"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(n, 0);
    let (s, _) = patch(&app, &admin, "/api/comics/issues/2", json!({"kind": null})).await;
    assert_eq!(s, 400);
    let (s, v) = patch(
        &app,
        &admin,
        "/api/comics/issues/2",
        json!({"overview": "O", "title": "T"}),
    )
    .await;
    assert_eq!(s, 200);
    let i = v["issues"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["itemId"] == 2)
        .unwrap();
    assert_eq!(i["overview"], "O");
    let (s, v) = patch(
        &app,
        &admin,
        "/api/comics/issues/2",
        json!({"unlock": ["title", "overview"]}),
    )
    .await;
    assert_eq!(s, 200);
    assert!(v["issues"].is_array());
    let locked: Vec<String> =
        sqlx::query_scalar(r#"SELECT unnest("lockedFields") FROM comic_issues WHERE "itemId" = 2"#)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(locked.is_empty());
}

#[sqlx::test(migrations = false)]
async fn an_edit_waits_for_the_versions_lock_of_the_volume(pool: PgPool) {
    let (app, admin, _) = ctx(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(1230393939, 10)")
        .execute(&mut *tx)
        .await
        .unwrap();
    let waiting = tokio::time::timeout(
        std::time::Duration::from_millis(400),
        patch(
            &app,
            &admin,
            "/api/media/10/comic",
            json!({"publisher": "P"}),
        ),
    )
    .await;
    assert!(waiting.is_err(), "the edit must wait for the lock");
    tx.commit().await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn deleting_the_last_file_of_an_issue_unmonitors_it(pool: PgPool) {
    let (app, admin, _) = ctx(&pool).await;
    let delete = |media: i32, file: i32| {
        let req = Request::builder()
            .method("DELETE")
            .uri(format!("/api/media/{media}/files/{file}"))
            .header("authorization", format!("Bearer {admin}"))
            .body(Body::empty())
            .unwrap();
        let app = app.clone();
        async move { app.oneshot(req).await.unwrap().status().as_u16() }
    };
    let monitored = |item: i32| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, bool>("SELECT monitored FROM items WHERE id = $1")
                .bind(item)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert_eq!(delete(10, 4).await, 200);
    assert!(monitored(1).await, "another version of the issue remains");
    assert_eq!(delete(10, 1).await, 200);
    assert!(!monitored(1).await, "the last file is gone");
    assert!(
        monitored(2).await,
        "an issue that never had a file is untouched"
    );
}

//! The comic read shapes (`comics.md`): the detail object, the list info, the counts, the model's CHECKs.
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, media, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

async fn ctx(pool: &PgPool) -> (Router, String) {
    fliks_server::db::migrate(pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO users (id, username, "isAdmin") VALUES (1, 'admin', true);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'L1', '["comic"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/c/one');
        INSERT INTO media (id, title, year, type, "libraryId", "folderName") VALUES
          (10, 'Alpha Run', 2016, 'comic', 1, 'a'), (11, 'Empty Run', 2020, 'comic', 1, 'e'),
          (12, 'Movie', 2000, 'movie', 1, 'm');
        INSERT INTO comic_details ("mediaId", publisher, "startYear", volume) VALUES (10, 'Pub', 2016, 2);
        INSERT INTO editions (id, "mediaId", family, format) VALUES (1, 10, 'image', 'cbz');
        INSERT INTO items (id, "mediaId", "editionId", title, "airDate") VALUES
          (1, 10, 1, 'Start', '2016-03-02'), (2, 10, 1, NULL, NULL), (3, 10, 1, NULL, NULL), (4, 10, 1, NULL, NULL);
        INSERT INTO comic_issues ("itemId", "sortNumber", label, annual, "pageCount") VALUES
          (1, 1, '1', false, 24), (2, 1.5, '1.5', false, NULL), (3, 0, '0', false, 12), (4, 1, '1', true, 40);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, '001.cbz', 1, 'CBZ', '{}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES (1, 1, 10, 0, 0);
        INSERT INTO playback_states ("userId", "itemId", "positionSeconds", "durationSeconds", completed, progression) VALUES
          (1, 1, 0, 0, true, 1), (1, 2, 0, 0, false, 0.25);
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
    let token = st.jwt.sign_access(1, "admin").unwrap().token;
    (media::router().with_state(st), token)
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
    let (app, t) = ctx(&pool).await;
    let v = get(&app, &t, "/api/media/10").await;
    assert_eq!(v["type"], "comic");
    let c = &v["comic"];
    assert_eq!(
        (&c["publisher"], &c["startYear"], &c["volume"]),
        (&json!("Pub"), &json!(2016), &json!(2))
    );
    let labels: Vec<(&str, bool)> = c["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            (
                i["number"].as_str().unwrap(),
                i["annual"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        labels,
        [("0", false), ("1", false), ("1.5", false), ("1", true)]
    );
    assert_eq!(
        c["issues"][1],
        json!({"itemId": 1, "mediaFileId": 1, "number": "1", "sort": 1.0, "annual": false, "title": "Start",
               "releaseDate": "2016-03-02", "pageCount": 24, "progression": 1.0, "finished": true})
    );
    assert_eq!(c["issues"][2]["progression"], 0.25);
    assert_eq!(c["issues"][2]["mediaFileId"], Value::Null);
    assert_eq!(c["issues"][0]["progression"], Value::Null);
    let other = get(&app, &t, "/api/media/12").await;
    assert!(other.get("comic").is_none());
}

#[sqlx::test(migrations = false)]
async fn list_items_carry_the_comic_info_and_counts_the_kind(pool: PgPool) {
    let (app, t) = ctx(&pool).await;
    let v = get(&app, &t, "/api/media?type=comic&limit=0&sortBy=title").await;
    let data = v["data"].as_array().unwrap();
    assert_eq!(data.len(), 2);
    assert_eq!(
        data[0]["comic"],
        json!({"publisher": "Pub", "startYear": 2016, "issueCount": 4, "readCount": 1})
    );
    assert_eq!(
        data[1]["comic"],
        json!({"publisher": null, "startYear": null, "issueCount": 0, "readCount": 0})
    );
    let counts = get(&app, &t, "/api/media/counts").await;
    assert_eq!(counts["comics"], 2);
}

#[sqlx::test(migrations = false)]
async fn the_model_refuses_what_a_comic_cannot_hold(pool: PgPool) {
    let _ = ctx(&pool).await;
    for bad in [
        r#"INSERT INTO comic_issues ("itemId", "sortNumber", label) VALUES (1, 2, '')"#,
        r#"INSERT INTO comic_issues ("itemId", "sortNumber", label, "pageCount") VALUES (1, 2, '2', 0)"#,
        r#"INSERT INTO comic_details ("mediaId", "startYear") VALUES (11, 0)"#,
        r#"INSERT INTO comic_details ("mediaId") VALUES (12)"#,
    ] {
        assert!(sqlx::raw_sql(bad).execute(&pool).await.is_err(), "{bad}");
    }
}

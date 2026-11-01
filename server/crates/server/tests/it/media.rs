//! `/api/media` read routes and the library ACL on a small fixture (the rest is parity).
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, media, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    admin: String,
    plain: String,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'plain', false, 1);
        INSERT INTO libraries (id, name, path) VALUES (1, 'L1', '/m/one'), (2, 'L2', '/m/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2);
        INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'P', 18, '[]');
        INSERT INTO media (id, title, "originalTitle", overview, year, type, "libraryId", "qualityProfileId", "folderName") VALUES
          (1, 'Alpha Alpha', NULL, NULL, 2000, 'movie', 1, 1, 'a'),
          (2, 'Beta', 'Alpha', NULL, 2000, 'movie', 1, 1, 'b'),
          (3, 'Aaa Gamma', NULL, 'alpha story', 2000, 'movie', 1, 1, 'c'),
          (4, 'Delta', NULL, NULL, 2000, 'movie', 2, 1, 'd');
        INSERT INTO media_files ("mediaId", "relativePath", size, quality) VALUES
          (1, 'f', 1, 'WEBDL-720p'), (2, 'f', 1, 'Bluray-1080p'), (3, 'f', 1, 'HDTV-720p'), (4, 'f', 1, 'CAM');
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        admin: st.jwt.sign_access(1, "admin").unwrap().token,
        plain: st.jwt.sign_access(2, "plain").unwrap().token,
        app: media::router().with_state(st),
    }
}

impl Ctx {
    async fn get(&self, token: &str, uri: &str) -> (u16, Value) {
        self.send("GET", token, uri, None).await
    }

    async fn send(
        &self,
        method: &str,
        token: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

fn ids(v: &Value) -> Vec<i64> {
    v["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_i64().unwrap())
        .collect()
}

#[sqlx::test(migrations = false)]
async fn cutoff_unmet_is_filtered_before_pagination(pool: PgPool) {
    let c = ctx(pool).await;
    // 2 meets Bluray-1080p; 1, 3 and 4 do not (title order: Alpha Alpha, Delta, Gamma)
    let (_, all) = c
        .get(&c.admin, "/api/media?cutoffUnmet=true&sortBy=title")
        .await;
    assert_eq!((ids(&all), all["total"].as_i64()), (vec![3, 1, 4], Some(3)));
    let (_, p2) = c
        .get(
            &c.admin,
            "/api/media?cutoffUnmet=true&sortBy=title&limit=1&page=2",
        )
        .await;
    assert_eq!(
        (p2["data"].as_array().unwrap().len(), p2["total"].as_i64()),
        (1, Some(3))
    );
}

#[sqlx::test(migrations = false)]
async fn search_without_sort_ranks_by_relevance_then_title(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, r) = c.get(&c.admin, "/api/media?q=alpha").await;
    assert_eq!(ids(&r), vec![1, 2, 3]);
    let (_, by_title) = c.get(&c.admin, "/api/media?q=alpha&sortBy=title").await;
    assert_eq!(ids(&by_title), vec![3, 1, 2]);
    let (_, desc) = c
        .get(&c.admin, "/api/media?q=alpha&sortBy=title&sortOrder=DESC")
        .await;
    assert_eq!(ids(&desc), vec![2, 1, 3]);
}

#[sqlx::test(migrations = false)]
async fn equal_sort_keys_page_by_id(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, p1) = c.get(&c.admin, "/api/media?sortBy=year&limit=2").await;
    let (_, p2) = c
        .get(&c.admin, "/api/media?sortBy=year&limit=2&page=2")
        .await;
    assert_eq!((ids(&p1), ids(&p2)), (vec![1, 2], vec![3, 4]));
}

#[sqlx::test(migrations = false)]
async fn paths_and_libraries_follow_the_caller(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, admin) = c.get(&c.admin, "/api/media/1").await;
    assert_eq!(admin["path"], "/m/one/a");
    assert_eq!(admin["library"]["path"], "/m/one");
    let (_, plain) = c.get(&c.plain, "/api/media/1").await;
    assert!(plain.get("path").is_none() && plain["library"].get("path").is_none());
    let (s, body) = c.get(&c.plain, "/api/media/4").await;
    assert_eq!(
        (s, body["message"].as_str()),
        (404, Some("Media #4 not found"))
    );
    let (_, list) = c.get(&c.plain, "/api/media").await;
    assert_eq!(
        (ids(&list), list["total"].as_i64()),
        (vec![3, 1, 2], Some(3))
    );
    let (s, _) = c.get(&c.plain, "/api/media?page=0").await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn stream_info_tracks_carry_their_markers(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    sqlx::query(r#"UPDATE media_files SET "streamInfo" = $1 WHERE "mediaId" = 1"#)
        .bind(
            serde_json::json!({"video": [{}], "audio": [{"title": "Commentary"}, {}],
            "subtitles": [{"forced": true, "hearingImpaired": false}]}),
        )
        .execute(&pool)
        .await
        .unwrap();
    let (_, m) = c.get(&c.admin, "/api/media/1").await;
    let info = &m["files"][0]["streamInfo"];
    assert_eq!(
        info["audio"][0]["trackMarkers"],
        serde_json::json!(["commentary"])
    );
    assert_eq!(info["audio"][1]["trackMarkers"], serde_json::json!([]));
    assert_eq!(
        info["subtitles"][0]["trackMarkers"],
        serde_json::json!(["forced"])
    );
    let (_, other) = c.get(&c.admin, "/api/media/2").await;
    assert!(other["files"][0]["streamInfo"].is_null());
}

/// A move cannot carry files, so a media that has some answers 409 and stays put.
#[sqlx::test(migrations = false)]
async fn moving_a_media_with_files_is_a_409(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    sqlx::query(r#"INSERT INTO media (id, title, year, type, "libraryId", "folderName") VALUES (5, 'Empty', 2000, 'movie', 1, 'e')"#)
        .execute(&pool)
        .await
        .unwrap();
    let to = |id: i32, lib: i32| {
        (
            format!("/api/media/{id}/library"),
            json!({"libraryId": lib}),
        )
    };
    let (u, b) = to(1, 2);
    let (s, r) = c.send("PATCH", &c.admin, &u, Some(b)).await;
    assert_eq!((s, r["code"].as_str()), (409, Some("media_has_files")));
    assert!(
        r["message"]
            .as_str()
            .is_some_and(|m| m.starts_with("This media has files"))
    );
    let (_, m) = c.get(&c.admin, "/api/media/1").await;
    assert_eq!(m["libraryId"], 1);
    let (u, b) = to(1, 1);
    assert_eq!(
        c.send("PATCH", &c.admin, &u, Some(b)).await.0,
        200,
        "same library moves nothing"
    );
    let (u, b) = to(5, 2);
    let (s, r) = c.send("PATCH", &c.admin, &u, Some(b)).await;
    assert_eq!((s, r["libraryId"].clone()), (200, json!(2)));
}

#[sqlx::test(migrations = false)]
async fn grid_view_keeps_the_first_file_and_counts_the_rest(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    sqlx::query(r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality) VALUES (1, 'g', 1, 'CAM')"#)
        .execute(&pool)
        .await
        .unwrap();
    let (_, grid) = c.get(&c.admin, "/api/media?view=grid&limit=0").await;
    let first = grid["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == 1)
        .unwrap();
    assert_eq!(
        (
            first["files"].as_array().unwrap().len(),
            first["fileCount"].as_i64()
        ),
        (1, Some(2))
    );
    assert_eq!(
        (grid["total"].as_i64(), first["sizeOnDisk"].as_i64()),
        (Some(4), Some(2))
    );
    let (_, full) = c.get(&c.admin, "/api/media/1").await;
    assert!(full.get("fileCount").is_none() && full["files"].as_array().unwrap().len() == 2);
    let (s, _) = c.get(&c.admin, "/api/media?view=nope").await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn put_sets_clears_and_scopes_the_external_ids(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let put = async |id: i32, body: Value| {
        c.send("PUT", &c.admin, &format!("/api/media/{id}"), Some(body))
            .await
    };
    let (s, m) = put(1, json!({"tmdbId": 603, "imdbId": "tt0133093"})).await;
    assert_eq!(
        (s, &m["tmdbId"], &m["imdbId"], &m["tvdbId"]),
        (200, &json!(603), &json!("tt0133093"), &Value::Null)
    );
    // The same number names a title of another kind, never a second one of the same kind.
    assert_eq!(put(2, json!({"tmdbId": 603})).await.0, 409);
    assert_eq!(
        put(2, json!({"tmdbId": 604, "type": "series"})).await.0,
        200
    );
    assert_eq!(
        put(3, json!({"tmdbId": 603, "type": "series"})).await.0,
        200
    );
    // An IMDb id is not unique.
    assert_eq!(put(2, json!({"imdbId": "tt0133093"})).await.0, 200);
    // A type change moves the ids with the media: it clashes with media 3's 603.
    assert_eq!(put(1, json!({"type": "series"})).await.0, 409);
    let (s, m) = put(1, json!({"tmdbId": null, "imdbId": null})).await;
    assert_eq!(
        (s, &m["tmdbId"], &m["imdbId"]),
        (200, &Value::Null, &Value::Null)
    );
    let left: i64 =
        sqlx::query_scalar(r#"SELECT count(*) FROM media_external_ids WHERE "mediaId" = 1"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 0);
    // An empty IMDb id clears the id.
    assert_eq!(put(1, json!({"imdbId": "tt9"})).await.1["imdbId"], "tt9");
    let (s, m) = put(1, json!({"imdbId": ""})).await;
    assert_eq!((s, &m["imdbId"]), (200, &Value::Null));
    assert_eq!(put(1, json!({"type": "series"})).await.0, 200);
}

#[sqlx::test(migrations = false)]
async fn removing_a_media_removes_its_external_ids(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    c.send("PUT", &c.admin, "/api/media/4", Some(json!({"tmdbId": 9})))
        .await;
    let (s, _) = c.send("DELETE", &c.admin, "/api/media/4", None).await;
    assert_eq!(s, 200);
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM media_external_ids")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

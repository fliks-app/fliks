//! `/api/media` read routes: C10-C12, F22 and the library ACL on a small fixture (the rest is parity).
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, media, state::AppState};
use serde_json::Value;
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
        let req = Request::builder()
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
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

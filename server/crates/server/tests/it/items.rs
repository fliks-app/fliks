//! Every route that creates a media gives it its `video` edition and, for a movie, its item.
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, media, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

/// Every media of `only` (all when empty) has a `video` edition, and exactly the movies have an ungrouped item.
pub async fn assert_media_have_shells(pool: &PgPool, only: &[i32]) {
    let bad: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT m.id, m.type FROM media m
           WHERE (cardinality($1::int[]) = 0 OR m.id = ANY($1))
             AND (NOT EXISTS (SELECT 1 FROM editions e WHERE e."mediaId" = m.id AND e.family = 'video')
               OR (m.type = 'movie') <> EXISTS (SELECT 1 FROM items i WHERE i."mediaId" = m.id AND i."groupId" IS NULL))
           ORDER BY m.id"#,
    )
    .bind(only)
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(bad.is_empty(), "media without their shell: {bad:?}");
}

async fn call(app: &Router, token: &str, method: &str, uri: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method(method)
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
async fn create_and_type_change_keep_the_shell(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(
        pool.clone(),
        Config::from_lookup(|_| None),
        "0123456789abcdef0123456789abcdef",
    );
    sqlx::raw_sql(
        r#"INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL);
           INSERT INTO libraries (id, name, path) VALUES (1, 'L', '/m')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let token = st.jwt.sign_access(1, "admin").unwrap().token;
    let app = media::router().with_state(st);

    let mut made = vec![];
    for kind in ["movie", "series"] {
        let (s, b) = call(
            &app,
            &token,
            "POST",
            "/api/media",
            json!({"title": kind, "type": kind}),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        made.push(b["id"].as_i64().unwrap() as i32);
    }
    assert_media_have_shells(&pool, &[]).await;
    sqlx::raw_sql(r#"UPDATE media SET "libraryId" = 1"#)
        .execute(&pool)
        .await
        .unwrap();

    sqlx::query(r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality) VALUES ($1, 'a.mkv', 1, 'q')"#)
        .bind(made[1])
        .execute(&pool)
        .await
        .unwrap();
    for (id, kind) in [(made[0], "series"), (made[1], "movie")] {
        let (s, b) = call(
            &app,
            &token,
            "PUT",
            &format!("/api/media/{id}"),
            json!({"type": kind}),
        )
        .await;
        assert_eq!(s, 200, "{b}");
    }
    assert_media_have_shells(&pool, &[]).await;
    let parts: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM item_parts p JOIN items i ON i.id = p."itemId"
           WHERE p."mediaId" = $1 AND i."groupId" IS NULL"#,
    )
    .bind(made[1])
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        parts, 1,
        "a series that becomes a movie plays its files through its new item"
    );

    // A series that becomes a movie again keeps a single item.
    let (s, _) = call(
        &app,
        &token,
        "PUT",
        &format!("/api/media/{}", made[0]),
        json!({"type": "movie"}),
    )
    .await;
    assert_eq!(s, 200);
    let items: i64 = sqlx::query_scalar(r#"SELECT count(*) FROM items WHERE "mediaId" = $1"#)
        .bind(made[0])
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(items, 1);
}

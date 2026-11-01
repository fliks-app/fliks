//! Every route that creates a media gives it its `video` edition and, for a movie, its item.
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, media, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

/// Every media but a book of `only` (all when empty) has a `video` edition and want, and exactly the movies have an ungrouped item.
pub async fn assert_media_have_shells(pool: &PgPool, only: &[i32]) {
    let bad: Vec<(i32, String)> = sqlx::query_as(
        r#"SELECT m.id, m.type FROM media m
           WHERE (cardinality($1::int[]) = 0 OR m.id = ANY($1)) AND m.type <> 'book'
             AND (NOT EXISTS (SELECT 1 FROM editions e WHERE e."mediaId" = m.id AND e.family = 'video')
               OR NOT EXISTS (SELECT 1 FROM wants w WHERE w."mediaId" = m.id AND w.family = 'video')
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

/// A movie with its shell and `n` files not yet attached.
async fn movie_with_files(pool: &PgPool, n: i32) -> (i32, i32, Vec<i32>) {
    let media: i32 =
        sqlx::query_scalar(r#"INSERT INTO media (title, type) VALUES ('m', 'movie') RETURNING id"#)
            .fetch_one(pool)
            .await
            .unwrap();
    let mut c = pool.acquire().await.unwrap();
    media::items::create_shell(
        &mut c,
        media,
        fliks_domain::media::kind::MediaKind::Movie,
        Default::default(),
    )
    .await
    .unwrap();
    let item = media::items::sole_item(&mut *c, media)
        .await
        .unwrap()
        .unwrap();
    let mut files = vec![];
    for i in 0..n {
        files.push(
            sqlx::query_scalar(
                r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality)
                   VALUES ($1, $2, 1, 'q') RETURNING id"#,
            )
            .bind(media)
            .bind(format!("f{i}.mkv"))
            .fetch_one(pool)
            .await
            .unwrap(),
        );
    }
    (media, item, files)
}

async fn versions(pool: &PgPool, item: i32) -> Vec<(i32, i32, i32)> {
    sqlx::query_as(
        r#"SELECT "mediaFileId", "version", position FROM item_parts WHERE "itemId" = $1 ORDER BY 1"#,
    )
    .bind(item)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn link(file: i32) -> media::items::Link {
    media::items::Link {
        file,
        owner: None,
        last: None,
    }
}

#[sqlx::test(migrations = false)]
async fn a_new_file_is_a_new_version_and_a_reattached_one_keeps_its_own(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let (media, item, f) = movie_with_files(&pool, 3).await;
    media::items::attach(&pool, media, &[link(f[0]), link(f[1])])
        .await
        .unwrap();
    media::items::attach(&pool, media, &[link(f[2])])
        .await
        .unwrap();
    let all = vec![(f[0], 0, 0), (f[1], 1, 0), (f[2], 2, 0)];
    assert_eq!(versions(&pool, item).await, all);

    media::items::attach(&pool, media, &[link(f[0])])
        .await
        .unwrap();
    assert_eq!(
        versions(&pool, item).await,
        all,
        "a re-attach keeps its version"
    );

    sqlx::query("DELETE FROM media_files WHERE id = $1")
        .bind(f[1])
        .execute(&pool)
        .await
        .unwrap();
    let (media2, item2, g) = movie_with_files(&pool, 1).await;
    media::items::attach(&pool, media2, &[link(g[0])])
        .await
        .unwrap();
    assert_eq!(versions(&pool, item2).await, vec![(g[0], 0, 0)]);
    let again = sqlx::query_scalar::<_, i32>(
        r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality)
           VALUES ($1, 'late.mkv', 1, 'q') RETURNING id"#,
    )
    .bind(media)
    .fetch_one(&pool)
    .await
    .unwrap();
    media::items::attach(&pool, media, &[link(again)])
        .await
        .unwrap();
    assert_eq!(
        versions(&pool, item).await.last(),
        Some(&(again, 3, 0)),
        "the next version follows the highest, never fills a gap"
    );
}

#[sqlx::test(migrations = false)]
async fn concurrent_attaches_pick_distinct_versions(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let (media, item, f) = movie_with_files(&pool, 8).await;
    let mut tasks = vec![];
    for file in f {
        let pool = pool.clone();
        tasks.push(tokio::spawn(async move {
            media::items::attach(&pool, media, &[link(file)]).await
        }));
    }
    for t in tasks {
        t.await.unwrap().unwrap();
    }
    let mut got: Vec<i32> = versions(&pool, item)
        .await
        .into_iter()
        .map(|v| v.1)
        .collect();
    got.sort_unstable();
    assert_eq!(got, (0..8).collect::<Vec<_>>());
}

#[sqlx::test(migrations = false)]
async fn item_of_names_the_ungrouped_item_only_when_it_is_the_only_one(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let (media, item, _) = movie_with_files(&pool, 0).await;
    let of = async |episode: Option<i32>| -> Option<i32> {
        sqlx::query_scalar("SELECT item_of($1, $2)")
            .bind(media)
            .bind(episode)
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    assert_eq!(of(None).await, Some(item));
    sqlx::query(
        r#"INSERT INTO editions ("mediaId", family, label) VALUES ($1, 'video', 'second')"#,
    )
    .bind(media)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO items ("mediaId", "editionId") SELECT $1, max(id) FROM editions WHERE "mediaId" = $1"#,
    )
    .bind(media)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(of(None).await, None, "two ungrouped items name none");
    assert_eq!(
        of(Some(item)).await,
        Some(item),
        "an item id still names it"
    );
}

#[sqlx::test(migrations = false)]
async fn writers_refuse_to_pick_among_several_ungrouped_items(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let (media, item, f) = movie_with_files(&pool, 2).await;
    sqlx::query(
        r#"INSERT INTO editions ("mediaId", family, label) VALUES ($1, 'video', 'second')"#,
    )
    .bind(media)
    .execute(&pool)
    .await
    .unwrap();
    let second: i32 = sqlx::query_scalar(
        r#"INSERT INTO items ("mediaId", "editionId")
           SELECT $1, max(id) FROM editions WHERE "mediaId" = $1 RETURNING id"#,
    )
    .bind(media)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(media::items::sole_item(&pool, media).await.unwrap(), None);
    assert!(
        media::items::attach(&pool, media, &[link(f[0])])
            .await
            .is_err()
    );
    let owned = media::items::Link {
        file: f[1],
        owner: Some(second),
        last: None,
    };
    media::items::attach(&pool, media, &[owned]).await.unwrap();
    assert_eq!(versions(&pool, item).await, vec![]);
    assert_eq!(versions(&pool, second).await, vec![(f[1], 0, 0)]);

    let mut c = pool.acquire().await.unwrap();
    let kind = fliks_domain::media::kind::MediaKind::Movie;
    assert!(
        media::items::follow_kind(&mut c, media, kind)
            .await
            .is_err()
    );
}

#[sqlx::test(migrations = false)]
async fn a_book_is_created_without_edition_or_item_and_keeps_its_kind(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(
        pool.clone(),
        Config::from_lookup(|_| None),
        "0123456789abcdef0123456789abcdef",
    );
    sqlx::raw_sql(
        r#"INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let token = st.jwt.sign_access(1, "admin").unwrap().token;
    let app = media::router().with_state(st);

    let mut made = vec![];
    for kind in ["book", "movie"] {
        let (s, b) = call(
            &app,
            &token,
            "POST",
            "/api/media",
            json!({"title": kind, "type": kind}),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        made.push(b["id"].as_i64().unwrap());
    }
    let wants: Vec<String> =
        sqlx::query_scalar(r#"SELECT family FROM wants WHERE "mediaId" = $1 ORDER BY family"#)
            .bind(made[0] as i32)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(wants, ["audio", "text"]);
    let owned: i64 = sqlx::query_scalar(
        r#"SELECT (SELECT count(*) FROM editions WHERE "mediaId" = $1) + (SELECT count(*) FROM items WHERE "mediaId" = $1)"#,
    )
    .bind(made[0] as i32)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(owned, 0);
    assert_media_have_shells(&pool, &[]).await;

    sqlx::raw_sql(r#"INSERT INTO libraries (id, name, path) VALUES (1, 'L', '/m'); UPDATE media SET "libraryId" = 1"#)
        .execute(&pool)
        .await
        .unwrap();
    for (id, kind) in [(made[0], "movie"), (made[1], "book")] {
        let (s, b) = call(
            &app,
            &token,
            "PUT",
            &format!("/api/media/{id}"),
            json!({"type": kind}),
        )
        .await;
        assert_eq!(s, 400, "{b}");
    }
}

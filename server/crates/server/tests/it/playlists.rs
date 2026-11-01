//! `/api/playlists/*` authorisation matrix, reorder, add targets and auto-remove (`docs/spec/playlists.md`).
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, playlists, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    pool: PgPool,
    tokens: Vec<String>,
}

/// Users 1 `a` (admin), 2 `b`, 3 `c`, 4 `d`; a movie (1) and a series (2) with 2 episodes in library 1.
async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let mut tokens = vec![];
    for (name, admin) in [("a", true), ("b", false), ("c", false), ("d", false)] {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin") VALUES ($1, $2) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .fetch_one(&pool)
        .await
        .unwrap();
        tokens.push(st.jwt.sign_access(id, name).unwrap().token);
    }
    for q in [
        r#"INSERT INTO libraries (name) VALUES ('l')"#,
        r#"INSERT INTO media (title, type, "libraryId") VALUES ('movie', 'movie', 1), ('series', 'series', 1)"#,
        r#"INSERT INTO item_groups ("number", "mediaId") VALUES (1, 2), (2, 2)"#,
        r#"INSERT INTO editions ("mediaId", family) VALUES (1, 'video'), (2, 'video')"#,
        r#"INSERT INTO items ("number", title, "groupId", "mediaId", "editionId") VALUES (1, 'e1', 1, 2, 2), (2, 'e2', 1, 2, 2), (1, 'e3', 2, 2, 2)"#,
        r#"INSERT INTO library_user_access ("userId", "libraryId") SELECT id, 1 FROM users"#,
    ] {
        sqlx::query(q).execute(&pool).await.unwrap();
    }
    Ctx {
        app: app::router(st, None, "/nonexistent".into(), None),
        pool,
        tokens,
    }
}

impl Ctx {
    async fn call(&self, who: usize, method: &str, uri: &str, body: Value) -> (u16, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {}", self.tokens[who]))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
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

    async fn sql(&self, q: &str) {
        sqlx::raw_sql(sqlx::AssertSqlSafe(q))
            .execute(&self.pool)
            .await
            .unwrap();
    }

    async fn positions(&self) -> Vec<(i32, i32)> {
        sqlx::query_as("SELECT id, position FROM playlist_items ORDER BY position, id")
            .fetch_all(&self.pool)
            .await
            .unwrap()
    }
}

/// Rule 6: (visibility, share role of `c`, `c` follows the owner) -> statuses of
/// GET :id, PATCH :id, POST items, DELETE :id and the role GET reports.
#[sqlx::test(migrations = false)]
async fn role_matrix(pool: PgPool) {
    let c = ctx(pool).await;
    #[allow(clippy::type_complexity)]
    let cases: [(&str, Option<&str>, bool, [u16; 4], &str); 9] = [
        (
            "private",
            Some("administrator"),
            false,
            [200, 200, 201, 403],
            "administrator",
        ),
        (
            "private",
            Some("editor"),
            false,
            [200, 403, 201, 403],
            "editor",
        ),
        (
            "private",
            Some("viewer"),
            false,
            [200, 403, 403, 403],
            "viewer",
        ),
        (
            "public",
            Some("editor"),
            false,
            [200, 403, 201, 403],
            "editor",
        ),
        ("public", None, false, [200, 404, 404, 403], "viewer"),
        ("followers", None, true, [200, 404, 404, 403], "viewer"),
        ("followers", None, false, [404, 404, 404, 404], ""),
        ("private", None, true, [404, 404, 404, 404], ""),
        (
            "public",
            Some("viewer"),
            true,
            [200, 403, 403, 403],
            "viewer",
        ),
    ];
    for (i, (visibility, share, follows, want, role)) in cases.into_iter().enumerate() {
        c.sql("DELETE FROM playlists; DELETE FROM user_follows")
            .await;
        c.sql(&format!(
            r#"INSERT INTO playlists (id, name, "ownerId", visibility) VALUES (1, 'p', 2, '{visibility}')"#
        ))
        .await;
        if let Some(r) = share {
            c.sql(&format!(
                r#"INSERT INTO playlist_shares ("playlistId", "userId", role) VALUES (1, 3, '{r}')"#
            ))
            .await;
        }
        if follows {
            c.sql(r#"INSERT INTO user_follows ("followerId","followingId") VALUES (3, 2)"#)
                .await;
        }
        let (get, body) = c.call(2, "GET", "/api/playlists/1", json!({})).await;
        let patch = c
            .call(2, "PATCH", "/api/playlists/1", json!({"name": "n"}))
            .await
            .0;
        let add = c
            .call(2, "POST", "/api/playlists/1/items", json!({"mediaId": 1}))
            .await
            .0;
        let del = c.call(2, "DELETE", "/api/playlists/1", json!({})).await.0;
        assert_eq!(
            [get, patch, add, del],
            want,
            "case {i}: {visibility} {share:?}"
        );
        if get == 200 {
            assert_eq!(body["role"], role, "case {i}");
        }
    }
    c.sql("DELETE FROM playlists").await;
    c.sql(r#"INSERT INTO playlists (id, name, "ownerId") VALUES (1, 'p', 2)"#)
        .await;
    assert_eq!(
        c.call(1, "DELETE", "/api/playlists/1", json!({})).await.0,
        200
    );
}

#[sqlx::test(migrations = false)]
async fn reorder_closes_gaps_and_rejects_bad_lists(pool: PgPool) {
    let c = ctx(pool).await;
    c.sql(r#"INSERT INTO playlists (id, name, "ownerId") VALUES (1, 'p', 2)"#)
        .await;
    c.sql(
        r#"INSERT INTO playlist_items ("playlistId", "mediaId", position) VALUES (1, 1, 5), (1, 2, 9)"#,
    )
    .await;
    let order = "/api/playlists/1/items/order";
    for bad in [json!([1]), json!([1, 1]), json!([1, 2, 3]), json!([])] {
        let (s, _) = c.call(1, "PUT", order, json!({"itemIds": bad})).await;
        assert_eq!(s, 400, "{bad}");
        assert_eq!(c.positions().await, vec![(1, 5), (2, 9)], "nothing written");
    }
    assert_eq!(
        c.call(1, "PUT", order, json!({"itemIds": [2, 1]})).await.0,
        200
    );
    assert_eq!(c.positions().await, vec![(2, 0), (1, 1)]);
}

#[sqlx::test(migrations = false)]
async fn add_expands_series_and_seasons_and_skips_present(pool: PgPool) {
    let c = ctx(pool).await;
    c.sql(r#"INSERT INTO playlists (id, name, "ownerId") VALUES (1, 'p', 2)"#)
        .await;
    let add = |body: Value| c.call(1, "POST", "/api/playlists/1/items", body);
    let (s, b) = add(json!({"seasonId": 1})).await;
    assert_eq!((s, b), (201, json!({"added": 2})));
    let (s, b) = add(json!({"mediaId": 2})).await;
    assert_eq!(
        (s, b),
        (201, json!({"added": 1})),
        "only the missing episode"
    );
    assert_eq!(add(json!({"mediaId": 2})).await.1, json!({"added": 0}));
    assert_eq!(add(json!({"seasonId": 99})).await.1, json!({"added": 0}));
    assert_eq!(
        add(json!({"episodeId": 1})).await.1["message"],
        "errors.media_already_in_playlist"
    );
    assert_eq!(add(json!({"mediaId": 1})).await.0, 201);
    assert_eq!(add(json!({"mediaId": 1})).await.0, 400);
    assert_eq!(
        add(json!({})).await.1["message"],
        "errors.playlist_add_target_required"
    );
    let eps: Vec<(i32, Option<i32>)> =
        sqlx::query_as(r#"SELECT position, "episodeId" FROM playlist_items ORDER BY position"#)
            .fetch_all(&c.pool)
            .await
            .unwrap();
    assert_eq!(
        eps,
        vec![(0, Some(1)), (1, Some(2)), (2, Some(3)), (3, None)]
    );
}

#[sqlx::test(migrations = false)]
async fn auto_remove_touches_only_the_watchers_own_playlists(pool: PgPool) {
    let c = ctx(pool).await;
    for q in [
        r#"INSERT INTO playlists (id, name, "ownerId", "autoRemoveWatched") VALUES (1, 'mine', 2, true), (2, 'theirs', 3, true), (3, 'manual', 2, false)"#,
        r#"INSERT INTO playlist_items ("playlistId", "mediaId", "episodeId", position) VALUES
           (1, 1, NULL, 0), (2, 1, NULL, 0), (3, 1, NULL, 0), (1, 2, 1, 1), (1, 2, 2, 2), (1, 2, 3, 3)"#,
    ] {
        c.sql(q).await;
    }
    let left = || async {
        sqlx::query_as::<_, (i32, i32, Option<i32>)>(
            r#"SELECT "playlistId", "mediaId", "episodeId" FROM playlist_items ORDER BY id"#,
        )
        .fetch_all(&c.pool)
        .await
        .unwrap()
    };
    playlists::remove_watched_from_auto_playlists(&c.pool, 2, 2, Some(&[])).await;
    assert_eq!(
        left().await.len(),
        6,
        "an empty episode list removes nothing"
    );
    playlists::remove_watched_from_auto_playlists(&c.pool, 2, 2, Some(&[1, 3])).await;
    assert_eq!(left().await.len(), 4);
    playlists::remove_watched_from_auto_playlists(&c.pool, 2, 1, None).await;
    assert_eq!(
        left().await,
        vec![(2, 1, None), (3, 1, None), (1, 2, Some(2))]
    );
}

#[sqlx::test(migrations = false)]
async fn playlist_deleted_while_waiting_for_the_lock_is_404(pool: PgPool) {
    let c = ctx(pool).await;
    c.sql(r#"INSERT INTO playlists (id, name, "ownerId") VALUES (1, 'p', 2)"#)
        .await;
    for (method, uri, body) in [
        ("POST", "/api/playlists/1/items", json!({"mediaId": 1})),
        (
            "PUT",
            "/api/playlists/1/items/order",
            json!({"itemIds": []}),
        ),
    ] {
        let mut tx = c.pool.begin().await.unwrap();
        sqlx::query("SELECT id FROM playlists WHERE id = 1 FOR UPDATE")
            .execute(&mut *tx)
            .await
            .unwrap();
        let racer = async {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            sqlx::query("DELETE FROM playlists WHERE id = 1")
                .execute(&mut *tx)
                .await
                .unwrap();
            tx.commit().await.unwrap();
        };
        let (call, ()) = tokio::join!(c.call(1, method, uri, body), racer);
        assert_eq!(call.0, 404, "{method} {uri}");
        c.sql(r#"INSERT INTO playlists (id, name, "ownerId") VALUES (1, 'p', 2)"#)
            .await;
    }
}

//! `/api/social/*` and `/api/likes/*` rules that parity cannot show: the visibility matrix, the
//! four SSE events and the atomic leave-social teardown (`docs/spec/social.md`).
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, events::Bus, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
    tokens: Vec<String>,
}

/// Users `a`(0, admin) `b`(1) `c`(2) `d`(3) and one movie in one library everyone can read.
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
    sqlx::query(r#"INSERT INTO libraries (name) VALUES ('l')"#)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', 1)"#)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO library_user_access ("userId", "libraryId") SELECT id, 1 FROM users"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        app: app::router(st.clone(), None, "/nonexistent".into(), None),
        st,
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
        sqlx::raw_sql(q).execute(&self.pool).await.unwrap();
    }
}

#[sqlx::test(migrations = false)]
async fn events_go_to_one_user_and_only_for_new_edges(pool: PgPool) {
    let c = ctx(pool).await;
    let mut rx = c.st.hub.subscribe();
    c.sql(r#"UPDATE users SET "profileVisibility" = 'public' WHERE username = 'c'"#)
        .await;
    assert_eq!(
        c.call(1, "POST", "/api/social/follow/3", json!({})).await.1["status"],
        "accepted"
    );
    assert_eq!(
        c.call(1, "POST", "/api/social/follow/3", json!({})).await.1["status"],
        "accepted"
    );
    assert_eq!(
        c.call(1, "POST", "/api/social/follow/4", json!({})).await.1["status"],
        "pending"
    );
    assert_eq!(
        c.call(3, "POST", "/api/social/requests/2/reject", json!({}))
            .await
            .0,
        201
    );
    assert_eq!(
        c.call(3, "POST", "/api/social/requests/2/accept", json!({}))
            .await
            .0,
        404
    );
    assert_eq!(
        c.call(1, "POST", "/api/social/follow/4", json!({})).await.0,
        201
    );
    assert_eq!(
        c.call(3, "POST", "/api/social/requests/2/accept", json!({}))
            .await
            .0,
        201
    );
    let rec = json!({"recipientId": 3, "mediaId": 1});
    assert_eq!(c.call(1, "POST", "/api/social/recommend", rec).await.0, 201);
    assert_eq!(
        c.call(1, "DELETE", "/api/social/follow/3", json!({}))
            .await
            .0,
        200
    );

    let mut seen = vec![];
    while let Ok(b) = rx.try_recv() {
        if let Bus::Sse(e) = &*b {
            seen.push(serde_json::to_value(e).unwrap());
        }
    }
    let kinds: Vec<&str> = seen.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        [
            "social.followed",
            "social.follow_request",
            "social.follow_request",
            "social.follow_accepted",
            "social.content_recommended"
        ]
    );
    assert_eq!(seen[0]["userId"], 2);
    assert_eq!(seen[3]["userId"], 4);
    assert_eq!(seen[4]["mediaTitle"], "m");
}

/// Rows of spec section D for the stats gate: viewer `b` looking at target `c`.
#[sqlx::test(migrations = false)]
async fn stats_visibility_matrix(pool: PgPool) {
    let c = ctx(pool).await;
    c.sql(r#"UPDATE users SET "shareStats" = true WHERE username = 'c'"#)
        .await;
    let public = r#"UPDATE users SET "profileVisibility" = 'public' WHERE id = 3"#;
    let setups: [(&str, Vec<&str>, u16, u16); 8] = [
        ("private, no edge", vec![], 404, 200),
        (
            "private, pending",
            vec![
                r#"INSERT INTO user_follows ("followerId","followingId",status) VALUES (2,3,'pending')"#,
            ],
            404,
            200,
        ),
        (
            "private, accepted",
            vec![
                r#"INSERT INTO user_follows ("followerId","followingId",status) VALUES (2,3,'accepted')"#,
            ],
            200,
            200,
        ),
        ("public", vec![public], 200, 200),
        (
            "public, stats off",
            vec![
                public,
                r#"UPDATE users SET "shareStats" = false WHERE id = 3"#,
            ],
            404,
            200,
        ),
        (
            "public, target opted out",
            vec![
                public,
                r#"UPDATE users SET "shareDisabled" = true WHERE id = 3"#,
            ],
            404,
            404,
        ),
        (
            "public, viewer opted out",
            vec![
                public,
                r#"UPDATE users SET "shareDisabled" = true WHERE id = 2"#,
            ],
            404,
            404,
        ),
        (
            "public, target disabled",
            vec![public, r#"UPDATE users SET enabled = false WHERE id = 3"#],
            404,
            404,
        ),
    ];
    for (name, sql, stats, profile) in setups {
        for q in sql {
            c.sql(q).await;
        }
        let (s, _) = c
            .call(1, "GET", "/api/social/users/3/stats", json!({}))
            .await;
        assert_eq!(s, stats, "{name} stats");
        let (s, _) = c
            .call(1, "GET", "/api/social/users/3/profile", json!({}))
            .await;
        assert_eq!(s, profile, "{name} profile");
        c.sql(r#"DELETE FROM user_follows"#).await;
        c.sql(r#"UPDATE users SET "profileVisibility" = 'private', "shareStats" = true, "shareDisabled" = false, enabled = true"#).await;
    }
    let (s, _) = c
        .call(2, "GET", "/api/social/users/3/stats", json!({}))
        .await;
    assert_eq!(s, 200, "self");
}

#[sqlx::test(migrations = false)]
async fn followers_apply_the_profile_gate(pool: PgPool) {
    let c = ctx(pool).await;
    c.sql(r#"INSERT INTO user_follows ("followerId","followingId") VALUES (2,3), (4,3)"#)
        .await;
    c.sql(r#"UPDATE users SET enabled = false WHERE id = 4"#)
        .await;
    c.sql(r#"UPDATE users SET "profileVisibility" = 'public' WHERE id = 3"#)
        .await;
    let (s, b) = c
        .call(1, "GET", "/api/social/users/3/followers", json!({}))
        .await;
    let names: Vec<&str> = b
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["username"].as_str().unwrap())
        .collect();
    assert_eq!((s, names), (200, vec!["b"]));
    c.sql(r#"UPDATE users SET "shareDisabled" = true WHERE id = 3"#)
        .await;
    assert_eq!(
        c.call(1, "GET", "/api/social/users/3/followers", json!({}))
            .await
            .0,
        404
    );
    assert_eq!(
        c.call(1, "GET", "/api/social/users/3/following", json!({}))
            .await
            .0,
        404
    );
    assert_eq!(
        c.call(2, "GET", "/api/social/users/3/followers", json!({}))
            .await
            .0,
        200
    );
}

#[sqlx::test(migrations = false)]
async fn leaving_social_is_one_transaction_with_the_user_update(pool: PgPool) {
    let c = ctx(pool).await;
    c.sql(r#"INSERT INTO user_follows ("followerId","followingId") VALUES (2,3)"#)
        .await;
    c.sql(r#"INSERT INTO playlists (name, "ownerId", visibility) VALUES ('p', 2, 'public')"#)
        .await;
    let before: String = sqlx::query_scalar(r#"SELECT "updatedAt"::text FROM playlists"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    c.sql(
        r#"CREATE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql;
           CREATE TRIGGER boom BEFORE UPDATE ON playlists FOR EACH ROW EXECUTE FUNCTION boom()"#,
    )
    .await;
    let (s, _) = c
        .call(0, "PUT", "/api/users/2", json!({"shareDisabled": true}))
        .await;
    assert_eq!(s, 500);
    let (disabled, follows): (bool, i64) = sqlx::query_as(
        r#"SELECT (SELECT "shareDisabled" FROM users WHERE id = 2), (SELECT count(*) FROM user_follows)"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(
        (disabled, follows),
        (false, 1),
        "the failed teardown rolled the update back"
    );

    c.sql("DROP TRIGGER boom ON playlists").await;
    let (s, _) = c
        .call(0, "PUT", "/api/users/2", json!({"shareDisabled": true}))
        .await;
    assert_eq!(s, 200);
    let (vis, after, follows): (String, String, i64) = sqlx::query_as(
        r#"SELECT visibility::text, "updatedAt"::text, (SELECT count(*) FROM user_follows) FROM playlists"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!((vis.as_str(), follows), ("private", 0));
    assert_ne!(before, after, "C8: the made-private playlist moves up");
}

#[sqlx::test(migrations = false)]
async fn opted_out_and_disabled_members_leave_every_social_list(pool: PgPool) {
    let c = ctx(pool).await;
    c.sql(r#"UPDATE users SET "profileVisibility" = 'public' WHERE id = 1"#)
        .await;
    c.sql(r#"INSERT INTO user_follows ("followerId","followingId",status) VALUES (2,1,'pending'), (3,1,'pending'), (4,1,'accepted')"#).await;
    c.sql(r#"INSERT INTO user_follows ("followerId","followingId") VALUES (1,2), (1,3), (1,4)"#)
        .await;
    c.sql(r#"INSERT INTO content_recommendations ("senderId","recipientId","mediaId") VALUES (3,1,1), (4,1,1), (2,1,1)"#).await;
    c.sql(r#"UPDATE users SET enabled = false WHERE id = 2"#)
        .await;
    c.sql(r#"UPDATE users SET "shareDisabled" = true WHERE id = 3"#)
        .await;
    async fn names(c: &Ctx, uri: &str) -> Vec<String> {
        let (s, b) = c.call(0, "GET", uri, json!({})).await;
        assert_eq!(s, 200, "{uri}");
        let key = |u: &Value| u["username"].as_str().map(String::from);
        let key_sender = |u: &Value| u["sender"]["username"].as_str().map(String::from);
        b.as_array()
            .unwrap()
            .iter()
            .filter_map(|u| key(u).or_else(|| key_sender(u)))
            .collect()
    }
    assert_eq!(
        names(&c, "/api/social/requests").await,
        Vec::<String>::new()
    );
    assert_eq!(names(&c, "/api/social/users/1/followers").await, ["d"]);
    assert_eq!(names(&c, "/api/social/users/1/following").await, ["d"]);
    assert_eq!(
        names(&c, "/api/social/recommendations/received").await,
        ["d"]
    );
    c.sql(r#"UPDATE user_follows SET status = 'accepted'"#)
        .await;
    assert_eq!(names(&c, "/api/social/users/1/followers").await, ["d"]);
    let (s, p) = c
        .call(0, "GET", "/api/social/users/1/profile", json!({}))
        .await;
    assert_eq!(s, 200);
    assert_eq!(
        (&p["followerCount"], &p["followingCount"]),
        (&json!(1), &json!(1))
    );
}

#[sqlx::test(migrations = false)]
async fn stats_hide_last_login_from_other_viewers(pool: PgPool) {
    let c = ctx(pool).await;
    c.sql(r#"UPDATE users SET "shareStats" = true, "profileVisibility" = 'public', "lastLogin" = now() WHERE id = 3"#).await;
    let (s, other) = c
        .call(1, "GET", "/api/social/users/3/stats", json!({}))
        .await;
    assert_eq!(s, 200);
    assert!(other["activity"].get("lastActiveAt").is_none());
    assert!(other["activity"]["memberSince"].is_string());
    assert_eq!(other["requests"]["pending"], 0);
    let (_, own) = c
        .call(2, "GET", "/api/social/users/3/stats", json!({}))
        .await;
    assert!(own["activity"]["lastActiveAt"].is_string());
}

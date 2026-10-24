//! `/api/parties` and `/api/time` (`docs/spec/watch-party.md`): access, invitations, stale intents, schedule.
use axum::{Router, body::Body, http::Request};
use fliks_server::{
    config::Config,
    events::{Connection, Identity},
    party,
    state::AppState,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO libraries (name) VALUES ('l');
           INSERT INTO media (title, type, "libraryId") VALUES ('Film', 'movie', 1);"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    Ctx {
        app: party::router().with_state(st.clone()),
        st,
        pool,
    }
}

impl Ctx {
    /// A user with a token; `access` grants the only library.
    async fn user(&self, name: &str, access: bool) -> (i32, String) {
        let id: i32 =
            sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ($1) RETURNING id"#)
                .bind(name)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        if access {
            sqlx::query(
                r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ($1, 1)"#,
            )
            .bind(id)
            .execute(&self.pool)
            .await
            .unwrap();
        }
        (id, self.st.jwt.sign_access(id, name).unwrap().token)
    }

    async fn follow(&self, from: i32, to: i32) {
        sqlx::query(r#"INSERT INTO user_follows ("followerId", "followingId") VALUES ($1, $2)"#)
            .bind(from)
            .bind(to)
            .execute(&self.pool)
            .await
            .unwrap();
    }

    fn connect(&self, user: i32, device: &str) -> Connection {
        self.st.hub.connect(
            user,
            Identity {
                target_id: Some(format!("{device}#tab")),
                ..Identity::default()
            },
        )
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let body = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let res = self
            .app
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
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

fn msg(v: &Value) -> Option<&str> {
    v["message"].as_str()
}

#[sqlx::test(migrations = false)]
async fn create_checks_follows_and_join_checks_access_and_connection(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    let (carol, k) = c.user("carol", false).await;
    c.follow(alice, bob).await;

    let (s, e) = c.call("GET", "/api/time", &a, None).await;
    assert_eq!(s, 200);
    assert!(e["t1"].as_i64().unwrap() <= e["t2"].as_i64().unwrap());

    let body = |ids: Vec<i32>| json!({"name": "Movie night", "mediaId": 1, "inviteeIds": ids});
    let (s, e) = c
        .call("POST", "/api/parties", &a, Some(body(vec![carol])))
        .await;
    assert_eq!(
        (s, msg(&e)),
        (400, Some("party.error_invitee_not_followed"))
    );
    let (s, p) = c
        .call("POST", "/api/parties", &a, Some(body(vec![bob])))
        .await;
    assert_eq!(s, 201);
    assert_eq!(p["status"], "live");
    assert_eq!(p["host"]["username"], "alice");
    assert_eq!(p["inviteToken"].as_str().unwrap().len(), 22);
    assert_eq!(p["live"]["state"], "idle");
    let (id, token) = (
        p["id"].as_i64().unwrap(),
        p["inviteToken"].as_str().unwrap().to_owned(),
    );

    let (s, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!((s, list.as_array().unwrap().len()), (200, 1));
    let (s, e) = c.call("GET", &format!("/api/parties/{id}"), &k, None).await;
    assert_eq!((s, msg(&e)), (404, Some("party.error_not_found")));
    let (s, p) = c
        .call("GET", &format!("/api/parties/by-token/{token}"), &k, None)
        .await;
    assert_eq!((s, p["inviteToken"].clone()), (200, Value::Null));

    let join = |token: Option<&str>| json!({"deviceId": "d1", "token": token});
    let (s, e) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/join"),
            &b,
            Some(join(None)),
        )
        .await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_no_connection")));
    let _cb = c.connect(bob, "d1");
    let (s, p) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/join"),
            &b,
            Some(join(None)),
        )
        .await;
    assert_eq!(s, 200);
    assert_eq!(p["live"]["members"][0]["username"], "bob");
    let _ck = c.connect(carol, "d1");
    let (s, e) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/join"),
            &k,
            Some(join(Some(&token))),
        )
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_no_access")));
    let (s, e) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/join"),
            &k,
            Some(join(None)),
        )
        .await;
    assert_eq!((s, msg(&e)), (404, Some("party.error_not_found")));
}

#[sqlx::test(migrations = false)]
async fn stale_seek_gets_the_snapshot_and_host_only_blocks_members(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "mediaId": 1, "inviteeIds": [bob]})),
        )
        .await;
    let id = p["id"].as_i64().unwrap();
    let (_ca, _cb) = (c.connect(alice, "da"), c.connect(bob, "db"));
    for (t, d) in [(&a, "da"), (&b, "db")] {
        let (s, _) = c
            .call(
                "POST",
                &format!("/api/parties/{id}/join"),
                t,
                Some(json!({"deviceId": d})),
            )
            .await;
        assert_eq!(s, 200);
    }
    let intent = |d: &str, action: &str, rev: u64| json!({"deviceId": d, "action": action, "position": 30.0, "baseRev": rev});
    let url = format!("/api/parties/{id}/intent");
    let (s, r) = c
        .call("POST", &url, &b, Some(intent("db", "play", 0)))
        .await;
    assert_eq!(s, 202);
    assert!(r["rev"].as_u64().unwrap() > 1);
    let (s, e) = c
        .call("POST", &url, &a, Some(intent("da", "seek", 1)))
        .await;
    assert_eq!((s, e["live"]["state"].clone()), (409, json!("waiting")));
    let (s, _) = c
        .call(
            "POST",
            &url,
            &a,
            Some(intent("da", "seek", r["rev"].as_u64().unwrap())),
        )
        .await;
    assert_eq!(s, 202);

    let (s, _) = c
        .call(
            "PATCH",
            &format!("/api/parties/{id}"),
            &a,
            Some(json!({"policy": "host_only"})),
        )
        .await;
    assert_eq!(s, 200);
    let (s, e) = c
        .call("POST", &url, &b, Some(intent("db", "pause", 0)))
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_host_only")));
    let (s, e) = c
        .call(
            "PATCH",
            &format!("/api/parties/{id}"),
            &b,
            Some(json!({"name": "x"})),
        )
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_not_host")));

    let (s, m) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/messages"),
            &b,
            Some(json!({"deviceId": "db", "text": "hello"})),
        )
        .await;
    assert_eq!((s, m["text"].clone()), (201, json!("hello")));
    let (s, _) = c
        .call("DELETE", &format!("/api/parties/{id}"), &a, None)
        .await;
    assert_eq!(s, 204);
    let (s, list) = c.call("GET", "/api/parties", &a, None).await;
    assert_eq!((s, list.as_array().unwrap().len()), (200, 0));
}

#[sqlx::test(migrations = false)]
async fn a_scheduled_party_opens_its_lobby_late_and_expires(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user("alice", true).await;
    let at = |mins: i64| (chrono::Utc::now() + chrono::Duration::minutes(mins)).to_rfc3339();
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "later", "mediaId": 1, "scheduledAt": at(60)})),
        )
        .await;
    assert_eq!(
        (s, p["status"].clone(), p["live"].clone()),
        (201, json!("scheduled"), Value::Null)
    );
    let id = p["id"].as_i64().unwrap();
    let (s, e) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/join"),
            &a,
            Some(json!({"deviceId": "d"})),
        )
        .await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_not_open")));

    sqlx::query(
        r#"UPDATE watch_parties SET "scheduledAt" = now() - interval '121 minutes' WHERE id = $1"#,
    )
    .bind(id as i32)
    .execute(&c.pool)
    .await
    .unwrap();
    party::sweep(&c.st, chrono::Utc::now()).await.unwrap();
    let (s, p) = c.call("GET", &format!("/api/parties/{id}"), &a, None).await;
    assert_eq!((s, p["status"].clone()), (200, json!("ended")));
}

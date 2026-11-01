//! `/api/parties` and `/api/time` (`docs/spec/watch-party.md`): access, invitations, stale intents, schedule.
use axum::{Router, body::Body, http::Request};
use fliks_server::{
    config::Config,
    events::{self, Connection, Identity},
    party,
    state::AppState,
    users,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::Duration;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    events: Router,
    st: AppState,
    pool: PgPool,
}

/// A movie's edition and item sit at `1000 + media`, clear of the hand-numbered episodes.
async fn movie_items(pool: &PgPool) {
    sqlx::raw_sql(
        r#"INSERT INTO editions (id, "mediaId", family)
             SELECT 1000 + id, id, 'video' FROM media m
             WHERE type = 'movie' AND NOT EXISTS (SELECT 1 FROM items WHERE "mediaId" = m.id);
           INSERT INTO items (id, "mediaId", "editionId")
             SELECT 1000 + id, id, 1000 + id FROM media m
             WHERE type = 'movie' AND NOT EXISTS (SELECT 1 FROM items WHERE "mediaId" = m.id);
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
             SELECT t.item, f.id, f."mediaId",
                    (COALESCE((SELECT max(q."version") + 1 FROM item_parts q WHERE q."itemId" = t.item), 0)
                     + row_number() OVER (PARTITION BY t.item ORDER BY f.id) - 1)::int
             FROM media_files f JOIN media m ON m.id = f."mediaId"
             CROSS JOIN LATERAL (SELECT min(i.id) AS item FROM items i
                                 WHERE i."mediaId" = f."mediaId" AND i."groupId" IS NULL) t
             WHERE m.type = 'movie' AND NOT EXISTS (SELECT 1 FROM item_parts p WHERE p."mediaFileId" = f.id)"#,
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"INSERT INTO libraries (name) VALUES ('l');
           INSERT INTO library_folders ("libraryId", path) VALUES (1, '/l');
           INSERT INTO media (title, type, "libraryId") VALUES ('Film', 'movie', 1);
           INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES (1, 'film', 1, 'q', (SELECT min(id) FROM library_folders));"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    movie_items(&pool).await;
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    Ctx {
        app: party::router().with_state(st.clone()),
        events: events::router().with_state(st.clone()),
        st,
        pool,
    }
}

impl Ctx {
    /// A user with a token; `access` grants the only library.
    async fn user(&self, name: &str, access: bool) -> (i32, String) {
        self.user_with(name, access, &["parties.create"]).await
    }

    /// Like `user`, with a role granting exactly `perms`.
    async fn user_with(&self, name: &str, access: bool, perms: &[&str]) -> (i32, String) {
        let id: i32 = sqlx::query_scalar(
            r#"WITH r AS (INSERT INTO roles (name, permissions, "isDefault") VALUES ($1, $2, false) RETURNING id)
               INSERT INTO users (username, "roleId") SELECT $1, id FROM r RETURNING id"#,
        )
        .bind(name)
        .bind(serde_json::to_string(perms).unwrap())
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

    /// An SSE stream for `device` (a full target id); its party events are read with `signals`.
    async fn stream(&self, token: &str, device: &str) -> axum::body::BodyDataStream {
        let req = Request::builder()
            .uri(format!(
                "/api/system/events?device={}",
                device.replace('#', "%23")
            ))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let res = self.events.clone().oneshot(req).await.unwrap();
        res.into_body().into_data_stream()
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

async fn more_media(c: &Ctx, n: usize) {
    for i in 0..n {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO media (title, type, "libraryId") VALUES ($1, 'movie', 1) RETURNING id"#,
        )
        .bind(format!("m{i}"))
        .fetch_one(&c.pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES ($1, $2, 1, 'q', (SELECT min(id) FROM library_folders))"#,
        )
        .bind(id)
        .bind(format!("m{i}"))
        .execute(&c.pool)
        .await
        .unwrap();
    }
    movie_items(&c.pool).await;
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
    assert_eq!(p["status"], "scheduled");
    assert_eq!(p["host"]["username"], "alice");
    assert_eq!(p["inviteToken"].as_str().unwrap().len(), 22);
    assert_eq!(p["live"]["playback"], Value::Null);
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
    let (s, _) = c
        .call("POST", &format!("/api/parties/{id}/start"), &a, None)
        .await;
    assert_eq!(s, 200);
    let (_ca, _cb) = (c.connect(alice, "da"), c.connect(bob, "db"));
    // bob joins with a web tab's full target id, alice with the bare device id
    for (t, d) in [(&a, "da"), (&b, "db#tab")] {
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
        .call("POST", &url, &b, Some(intent("db#tab", "play", 0)))
        .await;
    assert_eq!(s, 202);
    assert!(r["rev"].as_u64().unwrap() > 1);
    let (s, e) = c
        .call("POST", &url, &a, Some(intent("da", "seek", 1)))
        .await;
    assert_eq!(
        (s, e["live"]["playback"]["state"].clone()),
        (409, json!("waiting"))
    );
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
        .call("POST", &url, &b, Some(intent("db#tab", "pause", 0)))
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
            Some(json!({"deviceId": "db#tab", "text": "hello"})),
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
async fn a_party_created_now_or_rescheduled_to_the_past_opens_its_lobby_at_once(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 1).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let mut sb = c.stream(&b, "db").await;
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "now", "mediaId": 1, "inviteeIds": [bob]})),
        )
        .await;
    assert_eq!((s, p["status"].clone()), (201, json!("scheduled")));
    assert_eq!(p["live"]["playback"], Value::Null);
    assert!(p["scheduledAt"].is_string());
    assert_eq!(events_of(&mut sb, "party.starting").await.len(), 1);

    let at = |mins: i64| (chrono::Utc::now() + chrono::Duration::minutes(mins)).to_rfc3339();
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(
                json!({"name": "later", "mediaId": 1, "inviteeIds": [bob], "scheduledAt": at(60)}),
            ),
        )
        .await;
    let id = p["id"].as_i64().unwrap();
    assert_eq!(p["live"]["playback"], Value::Null);
    assert!(events_of(&mut sb, "party.starting").await.is_empty());
    let (s, p) = c
        .call(
            "PATCH",
            &format!("/api/parties/{id}"),
            &a,
            Some(json!({"scheduledAt": at(-5)})),
        )
        .await;
    assert_eq!((s, p["live"]["playback"].clone()), (200, Value::Null));
    assert_eq!(events_of(&mut sb, "party.starting").await.len(), 1);
    let (s, p) = c
        .call("POST", &format!("/api/parties/{id}/start"), &a, None)
        .await;
    assert_eq!((s, p["status"].clone()), (200, json!("live")));
    events_of(&mut sb, "party.starting").await;

    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "solo", "mediaId": 2})),
        )
        .await;
    let solo = p["id"].as_i64().unwrap();
    let (s, _) = c
        .call(
            "POST",
            &format!("/api/parties/{solo}/invitees"),
            &a,
            Some(json!({"userIds": [bob]})),
        )
        .await;
    assert_eq!(s, 200);
    assert_eq!(events_of(&mut sb, "party.starting").await.len(), 1);
}

#[sqlx::test(migrations = false)]
async fn host_switches_gate_reactions_and_chat_and_seed_the_next_party(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 2).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let mut sb = c.stream(&b, "db").await;
    let _ca = c.connect(alice, "da");
    for (t, d) in [(&a, "da"), (&b, "db")] {
        let uri = format!("/api/parties/{id}/join");
        c.call("POST", &uri, t, Some(json!({"deviceId": d}))).await;
    }
    let url = format!("/api/parties/{id}");
    let (s, e) = c
        .call("PATCH", &url, &b, Some(json!({"chatEnabled": false})))
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_not_host")));
    let (s, p) = c
        .call(
            "PATCH",
            &url,
            &a,
            Some(json!({"chatEnabled": false, "reactionsEnabled": false})),
        )
        .await;
    assert_eq!(
        (s, p["chatEnabled"].clone(), p["reactionsEnabled"].clone()),
        (200, json!(false), json!(false))
    );
    let settings = events_of(&mut sb, "party.settings").await;
    assert_eq!(settings.last().unwrap()["chatEnabled"], json!(false));
    assert_eq!(settings.last().unwrap()["reactionsEnabled"], json!(false));

    let (s, e) = c
        .call(
            "POST",
            &format!("{url}/messages"),
            &b,
            Some(json!({"deviceId": "db", "text": "hi"})),
        )
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_chat_off")));
    let (s, e) = c
        .call(
            "POST",
            &format!("{url}/reactions"),
            &b,
            Some(json!({"deviceId": "db", "emoji": "👍"})),
        )
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_reactions_off")));

    let (_, next) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "next", "mediaId": 2})),
        )
        .await;
    assert_eq!(
        (
            next["chatEnabled"].clone(),
            next["reactionsEnabled"].clone()
        ),
        (json!(false), json!(false))
    );
    let (_, own) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "own", "mediaId": 3, "chatEnabled": true})),
        )
        .await;
    assert_eq!(
        (own["chatEnabled"].clone(), own["reactionsEnabled"].clone()),
        (json!(true), json!(false))
    );
}

#[sqlx::test(migrations = false)]
async fn a_party_without_link_sharing_hides_the_token_from_members(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 1).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let mut sb = c.stream(&b, "db").await;
    let _ca = c.connect(alice, "da");
    for (t, d) in [(&a, "da"), (&b, "db")] {
        let uri = format!("/api/parties/{id}/join");
        c.call("POST", &uri, t, Some(json!({"deviceId": d}))).await;
    }
    let url = format!("/api/parties/{id}");
    let (_, p) = c.call("GET", &url, &b, None).await;
    let token = p["inviteToken"].as_str().unwrap().to_owned();
    let (s, e) = c
        .call("PATCH", &url, &b, Some(json!({"linkSharing": false})))
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_not_host")));
    let (s, p) = c
        .call("PATCH", &url, &a, Some(json!({"linkSharing": false})))
        .await;
    assert_eq!((s, p["inviteToken"].as_str()), (200, Some(token.as_str())));
    let settings = events_of(&mut sb, "party.settings").await;
    assert_eq!(settings.last().unwrap()["linkSharing"], json!(false));
    let (_, p) = c.call("GET", &url, &b, None).await;
    assert_eq!(
        (p["linkSharing"].clone(), p["inviteToken"].clone()),
        (json!(false), Value::Null)
    );
    let join = json!({"deviceId": "db", "token": token});
    let (s, _) = c.call("POST", &format!("{url}/join"), &b, Some(join)).await;
    assert_eq!(s, 200);
    let (_, next) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "next", "mediaId": 2})),
        )
        .await;
    assert_eq!(next["linkSharing"], json!(false));
    c.call("PATCH", &url, &a, Some(json!({"linkSharing": true})))
        .await;
    let (_, p) = c.call("GET", &url, &b, None).await;
    assert_eq!(p["inviteToken"].as_str(), Some(token.as_str()));
}

#[sqlx::test(migrations = false)]
async fn a_scheduled_party_expires_only_once_its_room_is_empty(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let _ca = c.connect(alice, "d");
    let at = |mins: i64| (chrono::Utc::now() + chrono::Duration::minutes(mins)).to_rfc3339();
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "later", "mediaId": 1, "scheduledAt": at(3 * 24 * 60)})),
        )
        .await;
    assert_eq!(
        (s, p["status"].clone(), p["live"]["playback"].clone()),
        (201, json!("scheduled"), Value::Null)
    );
    let id = p["id"].as_i64().unwrap();
    let (s, p) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/join"),
            &a,
            Some(json!({"deviceId": "d"})),
        )
        .await;
    assert_eq!((s, p["status"].clone()), (200, json!("scheduled")));

    sqlx::query(
        r#"UPDATE watch_parties SET "scheduledAt" = now() - interval '121 minutes' WHERE id = $1"#,
    )
    .bind(id as i32)
    .execute(&c.pool)
    .await
    .unwrap();
    let status = |now| {
        let c = &c;
        let a = &a;
        async move {
            party::sweep(&c.st, now).await.unwrap();
            let (_, p) = c.call("GET", &format!("/api/parties/{id}"), a, None).await;
            p["status"].clone()
        }
    };
    assert_eq!(status(chrono::Utc::now()).await, json!("scheduled"));
    let (s, _) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/leave"),
            &a,
            Some(json!({"deviceId": "d"})),
        )
        .await;
    assert_eq!(s, 204);
    party::tick(&c.st).await;
    assert_eq!(status(chrono::Utc::now()).await, json!("scheduled"));
    let later = chrono::Utc::now() + chrono::Duration::minutes(121);
    assert_eq!(status(later).await, json!("ended"));
}

fn texts(p: &Value) -> Vec<&str> {
    let all = p["live"]["messages"].as_array().unwrap();
    all.iter()
        .filter(|m| m["system"].is_null())
        .map(|m| m["text"].as_str().unwrap())
        .collect()
}

fn ids(p: &Value) -> Vec<u64> {
    let all = p["live"]["messages"].as_array().unwrap();
    all.iter().map(|m| m["id"].as_u64().unwrap()).collect()
}

#[sqlx::test(migrations = false)]
async fn the_chat_of_a_party_scheduled_days_ahead_survives_a_freed_room_and_a_restart(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let _ca = c.connect(alice, "da");
    let when = (chrono::Utc::now() + chrono::Duration::days(3)).to_rfc3339();
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "later", "mediaId": 1, "scheduledAt": when})),
        )
        .await;
    let id = p["id"].as_i64().unwrap();
    let url = format!("/api/parties/{id}");
    let join = Some(json!({"deviceId": "da"}));
    let (s, _) = c
        .call("POST", &format!("{url}/join"), &a, join.clone())
        .await;
    assert_eq!(s, 200);
    for t in ["one", "two"] {
        let (s, _) = c
            .call(
                "POST",
                &format!("{url}/messages"),
                &a,
                Some(json!({"deviceId": "da", "text": t})),
            )
            .await;
        assert_eq!(s, 201);
    }
    let (_, before) = c.call("GET", &url, &a, None).await;
    assert_eq!(texts(&before), ["one", "two"]);

    // the empty room is freed from memory; the chat comes back with the next read
    c.st.parties.remove(id as i32);
    assert!(c.st.parties.view(id as i32).is_none());
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(ids(&p), ids(&before));
    assert_eq!(texts(&p), ["one", "two"]);

    let (s, _) = c
        .call("POST", &format!("{url}/join"), &a, join.clone())
        .await;
    assert_eq!(s, 200);
    let (_, m) = c
        .call(
            "POST",
            &format!("{url}/messages"),
            &a,
            Some(json!({"deviceId": "da", "text": "three"})),
        )
        .await;
    assert!(m["id"].as_u64().unwrap() > *ids(&before).iter().max().unwrap());

    // a restart: a fresh registry over the same database
    let mut st = c.st.clone();
    st.parties = party::Parties::default();
    let c2 = Ctx {
        app: party::router().with_state(st.clone()),
        events: events::router().with_state(st.clone()),
        st,
        pool: c.pool.clone(),
    };
    let (_, p) = c2.call("GET", &url, &a, None).await;
    assert_eq!(texts(&p), ["one", "two", "three"]);
    assert!(ids(&p).windows(2).all(|w| w[0] < w[1]));
}

#[sqlx::test(migrations = false)]
async fn the_chat_of_a_live_party_is_reloaded_at_boot(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let _ca = c.connect(alice, "da");
    let id = party_with(&c, &a, vec![]).await;
    let url = format!("/api/parties/{id}");
    c.call(
        "POST",
        &format!("{url}/join"),
        &a,
        Some(json!({"deviceId": "da"})),
    )
    .await;
    c.call(
        "POST",
        &format!("{url}/messages"),
        &a,
        Some(json!({"deviceId": "da", "text": "hi"})),
    )
    .await;
    let mut st = c.st.clone();
    st.parties = party::Parties::default();
    party::boot(&st).await.unwrap();
    let view = st.parties.view(id as i32).unwrap();
    assert!(view.messages.iter().any(|m| m.text == "hi"));
}

#[sqlx::test(migrations = false)]
async fn party_starting_is_sent_once_when_the_start_comes_within_fifteen_minutes(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let mut sb = c.stream(&b, "db").await;
    let when = (chrono::Utc::now() + chrono::Duration::minutes(40)).to_rfc3339();
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "mediaId": 1, "inviteeIds": [bob], "scheduledAt": when})),
        )
        .await;
    let id = p["id"].as_i64().unwrap() as i32;
    party::sweep(&c.st, chrono::Utc::now()).await.unwrap();
    assert!(events_of(&mut sb, "party.starting").await.is_empty());
    sqlx::query(
        r#"UPDATE watch_parties SET "scheduledAt" = now() + interval '10 minutes' WHERE id = $1"#,
    )
    .bind(id)
    .execute(&c.pool)
    .await
    .unwrap();
    for _ in 0..2 {
        party::sweep(&c.st, chrono::Utc::now()).await.unwrap();
    }
    assert_eq!(events_of(&mut sb, "party.starting").await.len(), 1);
}

/// Every `kind` event queued on the stream, read until it stays quiet.
async fn events_of(s: &mut axum::body::BodyDataStream, kind: &str) -> Vec<Value> {
    use futures_util::StreamExt;
    let mut out = vec![];
    while let Ok(Some(Ok(chunk))) = tokio::time::timeout(Duration::from_millis(200), s.next()).await
    {
        for line in String::from_utf8_lossy(&chunk).lines() {
            if let Some(v) = line
                .strip_prefix("data: ")
                .and_then(|d| serde_json::from_str::<Value>(d).ok())
                .filter(|v| v["type"] == kind)
            {
                out.push(v);
            }
        }
    }
    out
}

async fn signals(s: &mut axum::body::BodyDataStream) -> Vec<Value> {
    events_of(s, "party.signal").await
}

/// A party the host has taken live; the lobby comes first.
async fn party_with(c: &Ctx, tok: &str, invitees: Vec<i32>) -> i64 {
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            tok,
            Some(json!({"name": "n", "mediaId": 1, "inviteeIds": invitees})),
        )
        .await;
    assert_eq!(s, 201);
    let id = p["id"].as_i64().unwrap();
    let (s, _) = c
        .call("POST", &format!("/api/parties/{id}/start"), tok, None)
        .await;
    assert_eq!(s, 200);
    id
}

#[sqlx::test(migrations = false)]
async fn a_guest_outside_the_room_is_told_of_every_playback_move(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let _ca = c.connect(alice, "da");
    let (s, _) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/join"),
            &a,
            Some(json!({"deviceId": "da"})),
        )
        .await;
    assert_eq!(s, 200);
    let mut sb = c.stream(&b, "db").await;
    let (s, _) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/intent"),
            &a,
            Some(json!({"deviceId": "da", "action": "play", "position": 12.0, "baseRev": 0})),
        )
        .await;
    assert_eq!(s, 202);
    assert_eq!(events_of(&mut sb, "party.updated").await.len(), 1);
}

#[sqlx::test(migrations = false)]
async fn ending_names_who_ended_it_to_the_members(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let mut sb = c.stream(&b, "db").await;
    let (s, _) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/join"),
            &b,
            Some(json!({"deviceId": "db"})),
        )
        .await;
    assert_eq!(s, 200);
    let (s, _) = c
        .call("DELETE", &format!("/api/parties/{id}"), &a, None)
        .await;
    assert_eq!(s, 204);
    let closed = events_of(&mut sb, "party.closed").await;
    assert_eq!(closed.len(), 1);
    assert_eq!(
        (closed[0]["reason"].clone(), closed[0]["by"].clone()),
        (json!("host_ended"), json!("alice"))
    );
}

#[sqlx::test(migrations = false)]
async fn a_signal_reaches_only_its_target_and_both_sides_need_voice(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    let (carol, k) = c.user("carol", true).await;
    c.follow(alice, bob).await;
    c.follow(alice, carol).await;
    let id = party_with(&c, &a, vec![bob, carol]).await;
    let mut sa = c.stream(&a, "da").await;
    let mut sb = c.stream(&b, "db").await;
    let mut sk = c.stream(&k, "dc").await;
    for (t, d) in [(&a, "da"), (&b, "db"), (&k, "dc")] {
        let uri = format!("/api/parties/{id}/join");
        let (s, _) = c.call("POST", &uri, t, Some(json!({"deviceId": d}))).await;
        assert_eq!(s, 200);
    }
    let sig = json!({"deviceId": "da", "to": "db", "toUserId": bob, "kind": "offer", "data": {"sdp": "x"}});
    let url = format!("/api/parties/{id}/signal");
    let (s, e) = c.call("POST", &url, &a, Some(sig.clone())).await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_voice_not_joined")));

    let voice = |d: &str| json!({"deviceId": d, "joined": true, "muted": false});
    let vurl = format!("/api/parties/{id}/voice");
    let (s, _) = c.call("POST", &vurl, &a, Some(voice("da"))).await;
    assert_eq!(s, 204);
    let (s, e) = c.call("POST", &url, &a, Some(sig.clone())).await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_voice_not_joined")));
    let (s, _) = c.call("POST", &vurl, &b, Some(voice("db"))).await;
    assert_eq!(s, 204);
    let (_, p) = c.call("GET", &format!("/api/parties/{id}"), &a, None).await;
    let voices: Vec<_> = p["live"]["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["voice"].clone())
        .collect();
    assert_eq!(
        voices,
        [
            json!({"muted": false}),
            json!({"muted": false}),
            Value::Null
        ]
    );

    let wrong =
        json!({"deviceId": "da", "to": "db", "toUserId": carol, "kind": "offer", "data": {}});
    let (s, e) = c.call("POST", &url, &a, Some(wrong)).await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_voice_not_joined")));
    let (s, _) = c.call("POST", &url, &a, Some(sig)).await;
    assert_eq!(s, 204);
    let got = signals(&mut sb).await;
    assert_eq!(got.len(), 1);
    assert_eq!(got[0]["partyId"], id);
    assert_eq!(got[0]["from"], json!({"userId": alice, "deviceId": "da"}));
    assert_eq!(
        (got[0]["kind"].clone(), got[0]["data"].clone()),
        (json!("offer"), json!({"sdp": "x"}))
    );
    assert!(signals(&mut sa).await.is_empty());
    assert!(signals(&mut sk).await.is_empty());

    let big = json!({"deviceId": "da", "to": "db", "toUserId": bob, "kind": "ice", "data": {"x": "y".repeat(17_000)}});
    let (s, _) = c.call("POST", &url, &a, Some(big)).await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn the_ninth_voice_member_gets_409_voice_full(pool: PgPool) {
    let c = ctx(pool).await;
    let (host, h) = c.user("host", true).await;
    let mut users = vec![];
    for i in 0..8 {
        let (u, t) = c.user(&format!("u{i}"), true).await;
        c.follow(host, u).await;
        users.push((u, t));
    }
    let id = party_with(&c, &h, users.iter().map(|u| u.0).collect()).await;
    let mut all = vec![(host, h)];
    all.extend(users);
    let _conns: Vec<_> = all.iter().map(|(u, _)| c.connect(*u, "d")).collect();
    let vurl = format!("/api/parties/{id}/voice");
    let body = json!({"deviceId": "d", "joined": true, "muted": false});
    for (n, (_, t)) in all.iter().enumerate() {
        let (s, _) = c
            .call(
                "POST",
                &format!("/api/parties/{id}/join"),
                t,
                Some(json!({"deviceId": "d"})),
            )
            .await;
        assert_eq!(s, 200);
        let (s, e) = c.call("POST", &vurl, t, Some(body.clone())).await;
        if n < 8 {
            assert_eq!(s, 204);
        } else {
            assert_eq!((s, msg(&e)), (409, Some("party.error_voice_full")));
        }
    }
}

#[sqlx::test(migrations = false)]
async fn ice_defaults_to_stun_and_follows_the_setting(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user("alice", false).await;
    let default = json!({"iceServers": [{"urls": "stun:stun.l.google.com:19302"}]});
    let (s, e) = c.call("GET", "/api/parties/ice", &a, None).await;
    assert_eq!((s, e), (200, default.clone()));
    let set = |v: &str| {
        let q = sqlx::query(
            r#"INSERT INTO app_settings ("key", "value") VALUES ('party_voice_ice_servers', $1)
               ON CONFLICT ("key") DO UPDATE SET "value" = $1"#,
        )
        .bind(v.to_owned());
        q.execute(&c.pool)
    };
    set("not json").await.unwrap();
    assert_eq!(c.call("GET", "/api/parties/ice", &a, None).await.1, default);
    let servers = json!([{"urls": ["turn:t.example:3478"], "username": "u", "credential": "p"}]);
    set(&servers.to_string()).await.unwrap();
    let (s, e) = c.call("GET", "/api/parties/ice", &a, None).await;
    assert_eq!((s, e), (200, json!({"iceServers": servers})));
}

#[sqlx::test(migrations = false)]
async fn the_catalog_route_lists_served_assets_and_reactions_must_be_standard_emoji(pool: PgPool) {
    let c = ctx(pool).await;
    let (host, h) = c.user("host", true).await;
    let (s, cat) = c.call("GET", "/api/parties/reactions", &h, None).await;
    assert_eq!(s, 200);
    let animations = cat["animations"].as_object().unwrap();
    assert_eq!(
        animations.len(),
        fliks_domain::party::ANIMATED_REACTIONS.len()
    );
    assert_eq!(cat["defaults"].as_array().unwrap().len(), 8);
    let public = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public");
    for url in animations.values() {
        let url = url.as_str().unwrap();
        assert!(
            public.join(url.strip_prefix("/api/").unwrap()).is_file(),
            "{url}"
        );
    }
    // Served by the whole app under `/api`, past its `/api/{*rest}` catch-all.
    let app = fliks_server::app::router(c.st.clone(), None, public, None);
    let url = animations["🔥"].as_str().unwrap();
    let res = app
        .oneshot(Request::get(url).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{url}");
    let id = party_with(&c, &h, vec![]).await;
    let _conn = c.connect(host, "d");
    let join = format!("/api/parties/{id}/join");
    let (s, _) = c
        .call("POST", &join, &h, Some(json!({"deviceId": "d"})))
        .await;
    assert_eq!(s, 200);
    let url = format!("/api/parties/{id}/reactions");
    let (s, _) = c
        .call(
            "POST",
            &url,
            &h,
            Some(json!({"deviceId": "d", "emoji": "💀"})),
        )
        .await;
    assert_eq!(s, 204);
    for emoji in ["🖕", "👍🏽"] {
        let (s, _) = c
            .call(
                "POST",
                &url,
                &h,
                Some(json!({"deviceId": "d", "emoji": emoji})),
            )
            .await;
        assert_eq!(s, 204, "{emoji}");
    }
    let (s, e) = c
        .call(
            "POST",
            &url,
            &h,
            Some(json!({"deviceId": "d", "emoji": "x"})),
        )
        .await;
    assert_eq!((s, msg(&e)), (400, Some("party.error_invalid")));
}

#[sqlx::test(migrations = false)]
async fn a_link_joiner_is_remembered_upgraded_by_an_invite_and_forgotten_on_kick(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![]).await;
    let url = format!("/api/parties/{id}");
    let (_, p) = c.call("GET", &url, &a, None).await;
    let token = p["inviteToken"].as_str().unwrap().to_owned();
    let _ca = c.connect(alice, "da");
    let _cb = c.connect(bob, "db");
    let join = json!({"deviceId": "db", "token": token});

    let (_, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
    let (s, p) = c.call("POST", &format!("{url}/join"), &b, Some(join)).await;
    assert_eq!(s, 200);
    assert_eq!(
        p["guests"],
        json!([{"userId": bob, "username": "bob", "source": "link"}])
    );
    let (_, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);

    let mut sb = c.stream(&b, "db").await;
    let (s, p) = c
        .call(
            "POST",
            &format!("{url}/invitees"),
            &a,
            Some(json!({"userIds": [bob]})),
        )
        .await;
    assert_eq!(s, 200);
    assert_eq!(p["guests"][0]["source"], "invite");
    assert_eq!(events_of(&mut sb, "party.invited").await.len(), 1);

    let (s, _) = c
        .call("POST", &format!("{url}/members/{bob}/kick"), &a, None)
        .await;
    assert_eq!(s, 204);
    let (_, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
    let (s, e) = c
        .call(
            "POST",
            &format!("{url}/join"),
            &b,
            Some(json!({"deviceId": "db", "token": token})),
        )
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_kicked")));
}

/// Library 2 (nobody is granted it) with media 2, a series (media 3) with two episodes, only the
/// first one with a file, and the playlist 1 owned by `owner`: Film, Gap, S01E01, S01E02.
async fn playlist_setup(c: &Ctx, owner: i32) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO libraries (name) VALUES ('l2');
           INSERT INTO media (title, type, "libraryId") VALUES ('Gap', 'movie', 2), ('Show', 'series', 1);
           INSERT INTO item_groups ("number", "mediaId") VALUES (1, 3);
           INSERT INTO editions ("mediaId", family) VALUES (3, 'video');
           INSERT INTO items ("number", title, "groupId", "mediaId", "editionId") VALUES (1, 'e1', 1, 3, 1), (2, 'e2', 1, 3, 1);
           INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES
             (1, 'f', 1, 'q', (SELECT min(id) FROM library_folders)), (2, 'g', 1, 'q', (SELECT min(id) FROM library_folders)), (3, 'e1', 1, 'q', (SELECT min(id) FROM library_folders));
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
             SELECT v.item, f.id, f."mediaId", 0 FROM media_files f
             JOIN (VALUES ('e1', 1)) AS v(path, item) ON v.path = f."relativePath";
           INSERT INTO playlists (id, name, "ownerId") VALUES (1, 'Night', {owner});"#
    )))
    .execute(&c.pool)
    .await
    .unwrap();
    movie_items(&c.pool).await;
    sqlx::raw_sql(
        r#"INSERT INTO playlist_items ("playlistId", "itemId", position)
           SELECT 1, item_of(v.m, v.e), v.p
           FROM (VALUES (1, NULL::int, 0), (2, NULL, 1), (3, 1, 2), (3, 2, 3)) AS v(m, e, p)"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
}

fn systems(p: &Value) -> Vec<(String, Value)> {
    p["live"]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["system"].as_object())
        .map(|s| (s["kind"].as_str().unwrap().to_owned(), s["args"].clone()))
        .collect()
}

#[sqlx::test(migrations = false)]
async fn creating_a_playlist_party_needs_a_readable_playlist_and_opens_on_its_first_item(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (_, b) = c.user("bob", true).await;
    playlist_setup(&c, alice).await;
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "playlistId": 1})),
        )
        .await;
    assert_eq!(s, 201);
    assert_eq!(p["item"]["mediaId"], 1);
    assert_eq!(p["playlist"], json!({"id": 1, "name": "Night"}));
    let (s, p2) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "playlistId": 1, "mediaId": 3, "episodeId": 1})),
        )
        .await;
    assert_eq!(
        (s, p2["item"]["title"].clone()),
        (201, json!("Show S01E01"))
    );
    let (_, q) = c
        .call("GET", &format!("/api/parties/{}/queue", p2["id"]), &a, None)
        .await;
    assert_eq!(eps(&q), vec![json!(1), json!(2)]);
    // an item outside the playlist, an unreadable playlist, and a missing media
    for (t, body, code, key) in [
        (
            &a,
            json!({"name": "n", "playlistId": 1, "mediaId": 3, "episodeId": 2}),
            400,
            "party.error_invalid_item",
        ),
        (
            &a,
            json!({"name": "n", "playlistId": 1, "mediaId": 9}),
            400,
            "party.error_invalid_item",
        ),
        (
            &b,
            json!({"name": "n", "playlistId": 1}),
            404,
            "Playlist #1 not found",
        ),
        (
            &a,
            json!({"name": "n", "episodeId": 1}),
            400,
            "party.error_invalid_item",
        ),
    ] {
        let (s, e) = c.call("POST", "/api/parties", t, Some(body)).await;
        assert_eq!((s, msg(&e)), (code, Some(key)));
    }
    let id = p["id"].as_i64().unwrap();
    let (s, q) = c
        .call("GET", &format!("/api/parties/{id}/queue"), &a, None)
        .await;
    let titles: Vec<_> = q
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["title"].clone())
        .collect();
    assert_eq!(
        (s, titles),
        (
            200,
            vec![
                json!("Film"),
                json!(""),
                json!("Show S01E01"),
                json!("Show S01E02")
            ]
        )
    );
    // the rows were copied: the playlist changing does not change the party
    sqlx::query("DELETE FROM playlist_items WHERE \"itemId\" = item_of(1, NULL)")
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, q) = c
        .call("GET", &format!("/api/parties/{id}/queue"), &a, None)
        .await;
    assert_eq!(q.as_array().unwrap().len(), 4);
    sqlx::query("DELETE FROM playlists WHERE id = 1")
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, p) = c.call("GET", &format!("/api/parties/{id}"), &a, None).await;
    assert_eq!(p["playlist"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn next_skips_what_a_member_cannot_open_and_the_end_idles_the_party(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    playlist_setup(&c, alice).await;
    // alice is a regular user: library 2 is hers to grant or not
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ($1, 2)"#)
        .bind(alice)
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "playlistId": 1, "inviteeIds": [bob]})),
        )
        .await;
    let id = p["id"].as_i64().unwrap();
    c.call("POST", &format!("/api/parties/{id}/start"), &a, None)
        .await;
    let (_ca, _cb) = (c.connect(alice, "da"), c.connect(bob, "db"));
    for (t, d) in [(&a, "da"), (&b, "db")] {
        c.call(
            "POST",
            &format!("/api/parties/{id}/join"),
            t,
            Some(json!({"deviceId": d})),
        )
        .await;
    }
    let url = format!("/api/parties/{id}/intent");
    let show = |p: &Value| p["live"]["playback"]["state"].clone();
    let rev = |p: &Value| p["live"]["rev"].as_u64().unwrap();
    let path = format!("/api/parties/{id}");
    let get = || c.call("GET", &path, &a, None);

    // Gap is skipped for bob and left unnamed; the episode plays and is named
    let (_, now) = get().await;
    let (s, _) = c
        .call(
            "POST",
            &url,
            &a,
            Some(json!({"deviceId": "da", "action": "next", "baseRev": rev(&now)})),
        )
        .await;
    assert_eq!(s, 202);
    let (_, now) = get().await;
    assert_eq!(
        (
            now["item"]["mediaId"].clone(),
            now["item"]["episodeId"].clone()
        ),
        (json!(3), json!(1))
    );
    let sys = systems(&now);
    assert_eq!(
        sys[sys.len() - 2..],
        [
            (
                "item_skipped".to_owned(),
                json!({"mediaId": 2, "episodeId": null, "title": "Gap"})
            ),
            (
                "item_changed".to_owned(),
                json!({"mediaId": 3, "episodeId": 1, "title": "Show S01E01"})
            ),
        ]
    );
    let (_, theirs) = c.call("GET", &path, &b, None).await;
    assert_eq!(systems(&theirs)[sys.len() - 2].1["title"], "");
    assert_eq!(show(&now), json!("waiting"));

    // a stale next is refused without a skip message
    let before = systems(&now).len();
    let (s, _) = c
        .call(
            "POST",
            &url,
            &a,
            Some(json!({"deviceId": "da", "action": "next", "baseRev": 0})),
        )
        .await;
    assert_eq!(s, 409);
    let (_, now) = get().await;
    assert_eq!(systems(&now).len(), before);

    // S01E02 has no file: nothing is left, the party idles and says so
    let (s, _) = c
        .call(
            "POST",
            &url,
            &a,
            Some(json!({"deviceId": "da", "action": "next", "baseRev": rev(&now)})),
        )
        .await;
    assert_eq!(s, 202);
    let (_, now) = get().await;
    let kinds: Vec<_> = systems(&now).into_iter().map(|s| s.0).collect();
    assert_eq!(kinds[kinds.len() - 2..], ["item_skipped", "queue_ended"]);
    assert_eq!(
        (show(&now), now["item"]["episodeId"].clone()),
        (json!("idle"), json!(1))
    );

    // previous goes back over the rows bob can open: Film (Gap skipped again)
    let (s, _) = c
        .call(
            "POST",
            &url,
            &a,
            Some(json!({"deviceId": "da", "action": "previous", "baseRev": rev(&now)})),
        )
        .await;
    assert_eq!(s, 202);
    let (_, now) = get().await;
    assert_eq!(now["item"]["mediaId"], 1);

    // an explicit pick keeps its 409 for a member without access
    let (s, e) = c
        .call("POST", &url, &a, Some(json!({"deviceId": "da", "action": "setItem", "item": {"mediaId": 2}, "baseRev": rev(&now)})))
        .await;
    assert_eq!(
        (s, msg(&e), e["usernames"].clone()),
        (409, Some("party.error_member_no_access"), json!(["bob"]))
    );
}

#[sqlx::test(migrations = false)]
async fn the_hosts_ended_moves_a_playlist_party_on_and_next_on_an_idle_single_film_does_nothing(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    playlist_setup(&c, alice).await;
    let _ca = c.connect(alice, "da");
    let id = {
        let (_, p) = c
            .call(
                "POST",
                "/api/parties",
                &a,
                Some(json!({"name": "n", "playlistId": 1})),
            )
            .await;
        let id = p["id"].as_i64().unwrap();
        c.call("POST", &format!("/api/parties/{id}/start"), &a, None)
            .await;
        c.call(
            "POST",
            &format!("/api/parties/{id}/join"),
            &a,
            Some(json!({"deviceId": "da"})),
        )
        .await;
        id
    };
    let url = format!("/api/parties/{id}/intent");
    let (_, now) = c.call("GET", &format!("/api/parties/{id}"), &a, None).await;
    let r = now["live"]["rev"].as_u64().unwrap();
    // `ended` while idle does nothing
    c.call(
        "POST",
        &url,
        &a,
        Some(json!({"deviceId": "da", "action": "ended", "baseRev": r})),
    )
    .await;
    let (_, now) = c.call("GET", &format!("/api/parties/{id}"), &a, None).await;
    assert_eq!(now["item"]["mediaId"], 1);
    // playing, then ended: Film -> Gap (alice is not granted library 2, so skipped) -> S01E01
    c.call(
        "POST",
        &url,
        &a,
        Some(json!({"deviceId": "da", "action": "play", "baseRev": r})),
    )
    .await;
    let (s, _) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/status"),
            &a,
            Some(json!({"deviceId": "da", "status": "ready", "position": 0.0})),
        )
        .await;
    assert_eq!(s, 204);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let (_, now) = c.call("GET", &format!("/api/parties/{id}"), &a, None).await;
    assert_eq!(now["live"]["playback"]["state"], "playing");
    let (s, _) = c
        .call(
            "POST",
            &url,
            &a,
            Some(json!({"deviceId": "da", "action": "ended", "baseRev": 0})),
        )
        .await;
    assert_eq!(s, 202);
    let (_, now) = c.call("GET", &format!("/api/parties/{id}"), &a, None).await;
    assert_eq!(now["item"]["episodeId"], 1);
    assert_eq!(now["live"]["playback"]["state"], "waiting");

    // a film alone is a programme of one: a next on the idle party changes nothing
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "mediaId": 1})),
        )
        .await;
    let plain = p["id"].as_i64().unwrap();
    c.call("POST", &format!("/api/parties/{plain}/start"), &a, None)
        .await;
    c.call(
        "POST",
        &format!("/api/parties/{plain}/join"),
        &a,
        Some(json!({"deviceId": "da"})),
    )
    .await;
    let path = format!("/api/parties/{plain}");
    let (s, now) = step(&c, &a, &path, "next").await;
    assert_eq!(s, 202);
    assert_eq!(now["live"]["playback"]["state"], "idle");
    assert_ne!(systems(&now).last().unwrap().0, "queue_ended");
}

async fn step(c: &Ctx, a: &str, path: &str, action: &str) -> (u16, Value) {
    let (_, now) = c.call("GET", path, a, None).await;
    let rev = now["live"]["rev"].clone();
    let body = json!({"deviceId": "da", "action": action, "baseRev": rev});
    let (s, _) = c
        .call("POST", &format!("{path}/intent"), a, Some(body))
        .await;
    let (_, now) = c.call("GET", path, a, None).await;
    (s, now)
}

/// Library 1, a series (media 2): seasons 0 (special), 1, 2; episodes 1 S00E01, 2 S01E02, 3 S01E01,
/// 4 S01E03 (no file), 5 S02E01.
async fn series_setup(c: &Ctx) {
    sqlx::raw_sql(
        r#"INSERT INTO media (title, type, "libraryId") VALUES ('Show', 'series', 1);
           INSERT INTO item_groups ("number", "mediaId") VALUES (0, 2), (1, 2), (2, 2);
           INSERT INTO editions ("mediaId", family) VALUES (2, 'video');
           INSERT INTO items ("number", title, "groupId", "mediaId", "editionId") VALUES
             (1, 'sp', 1, 2, 1), (2, 'e2', 2, 2, 1), (1, 'e1', 2, 2, 1), (3, 'e3', 2, 2, 1), (1, 'f1', 3, 2, 1);
           INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES
             (2, 's', 1, 'q', (SELECT min(id) FROM library_folders)), (2, 'b', 1, 'q', (SELECT min(id) FROM library_folders)), (2, 'a', 1, 'q', (SELECT min(id) FROM library_folders)), (2, 'd', 1, 'q', (SELECT min(id) FROM library_folders));
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version")
             SELECT v.item, f.id, f."mediaId", 0 FROM media_files f
             JOIN (VALUES ('s', 1), ('b', 2), ('a', 3), ('d', 5)) AS v(path, item) ON v.path = f."relativePath";"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
}

fn eps(q: &Value) -> Vec<Value> {
    q.as_array()
        .unwrap()
        .iter()
        .map(|i| i["episodeId"].clone())
        .collect()
}

fn programme_of(episodes: &[i32]) -> Value {
    json!({"items": episodes.iter().map(|e| json!({"mediaId": 2, "episodeId": e})).collect::<Vec<_>>()})
}

#[sqlx::test(migrations = false)]
async fn next_and_previous_walk_the_programme_and_skip_an_episode_without_a_file(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let _ca = c.connect(alice, "da");
    series_setup(&c).await;
    // a single episode is a programme of one: the series does not follow
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "mediaId": 2, "episodeId": 3})),
        )
        .await;
    let id = p["id"].as_i64().unwrap();
    let path = format!("/api/parties/{id}");
    let (_, q) = c.call("GET", &format!("{path}/queue"), &a, None).await;
    assert_eq!(eps(&q), vec![json!(3)]);
    sqlx::query(r#"WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES (2, 'c', 1, 'q', (SELECT min(id) FROM library_folders)) RETURNING id)
             INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT 4, id, 2, 0 FROM f"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, p) = c
        .call(
            "PUT",
            &format!("{path}/programme"),
            &a,
            Some(programme_of(&[3, 2, 4, 5])),
        )
        .await;
    assert_eq!((s, p["item"]["episodeId"].clone()), (200, json!(3)));
    // the file of episode 4 goes away after the pick
    sqlx::query(r#"DELETE FROM media_files WHERE "relativePath" = 'c'"#)
        .execute(&c.pool)
        .await
        .unwrap();
    c.call("POST", &format!("{path}/start"), &a, None).await;
    c.call(
        "POST",
        &format!("{path}/join"),
        &a,
        Some(json!({"deviceId": "da"})),
    )
    .await;
    let (_, q) = c.call("GET", &format!("{path}/queue"), &a, None).await;
    assert_eq!(eps(&q), vec![json!(3), json!(2), json!(4), json!(5)]);

    // previous at the first episode has nowhere to go: accepted, nothing changes
    let (_, before) = c.call("GET", &path, &a, None).await;
    let (s, now) = step(&c, &a, &path, "previous").await;
    assert_eq!(s, 202);
    assert_eq!(systems(&now).len(), systems(&before).len());
    assert_eq!(now["live"]["rev"], before["live"]["rev"]);
    let (s, now) = step(&c, &a, &path, "next").await;
    assert_eq!((s, now["item"]["episodeId"].clone()), (202, json!(2)));
    // the file-less episode is skipped, and named
    let (_, now) = step(&c, &a, &path, "next").await;
    assert_eq!(now["item"]["episodeId"], 5);
    let sys = systems(&now);
    assert_eq!(sys[sys.len() - 2].0, "item_skipped");
    assert_eq!(
        sys[sys.len() - 2].1,
        json!({"mediaId": 2, "episodeId": 4, "title": "Show S01E03"})
    );
    // the end of the programme: idle on the last item
    let (_, now) = step(&c, &a, &path, "next").await;
    let sys = systems(&now);
    assert_eq!(sys.last().unwrap().0, "queue_ended");
    assert_eq!(
        (
            now["live"]["playback"]["state"].clone(),
            now["item"]["episodeId"].clone()
        ),
        (json!("idle"), json!(5))
    );
    // a second next at the end changes nothing, so `queue_ended` is said once
    let (s, again) = step(&c, &a, &path, "next").await;
    assert_eq!(s, 202);
    assert_eq!(systems(&again).len(), sys.len());
    // previous goes back over the skipped episode
    let (_, now) = step(&c, &a, &path, "previous").await;
    assert_eq!(now["item"]["episodeId"], 2);
}

#[sqlx::test(migrations = false)]
async fn the_programme_is_edited_during_playback_by_the_host_only(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let (_ca, _cb) = (c.connect(alice, "da"), c.connect(bob, "db"));
    series_setup(&c).await;
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "mediaId": 2, "episodeId": 3, "inviteeIds": [bob]})),
        )
        .await;
    let id = p["id"].as_i64().unwrap();
    let path = format!("/api/parties/{id}");
    c.call(
        "PUT",
        &format!("{path}/programme"),
        &a,
        Some(programme_of(&[3, 2])),
    )
    .await;
    c.call("POST", &format!("{path}/start"), &a, None).await;
    let mut sb = c.stream(&b, "db").await;
    for (t, d) in [(&a, "da"), (&b, "db")] {
        c.call(
            "POST",
            &format!("{path}/join"),
            t,
            Some(json!({"deviceId": d})),
        )
        .await;
    }
    let (s, e) = c
        .call(
            "PUT",
            &format!("{path}/programme"),
            &b,
            Some(programme_of(&[3])),
        )
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_not_host")));

    // reorder, add and remove while the first episode plays: it stays, the queue changes
    let (s, p) = c
        .call(
            "PUT",
            &format!("{path}/programme"),
            &a,
            Some(programme_of(&[3, 5, 2])),
        )
        .await;
    assert_eq!((s, p["item"]["episodeId"].clone()), (200, json!(3)));
    let edits = events_of(&mut sb, "party.programme").await;
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0]["item"], Value::Null);
    let (_, q) = c.call("GET", &format!("{path}/queue"), &b, None).await;
    assert_eq!(eps(&q), vec![json!(3), json!(5), json!(2)]);
    let (_, now) = step(&c, &a, &path, "next").await;
    assert_eq!(now["item"]["episodeId"], 5);
    // removing what is left after the current item ends the programme there
    c.call(
        "PUT",
        &format!("{path}/programme"),
        &a,
        Some(programme_of(&[3, 5])),
    )
    .await;
    let (_, now) = step(&c, &a, &path, "next").await;
    assert_eq!(systems(&now).last().unwrap().0, "queue_ended");

    // invalid lists: a duplicate, an episode of no season of the media
    for body in [programme_of(&[3, 3]), programme_of(&[99])] {
        let (s, e) = c
            .call("PUT", &format!("{path}/programme"), &a, Some(body))
            .await;
        assert_eq!((s, msg(&e)), (400, Some("party.error_invalid_item")));
    }
    // an item a member cannot open is refused, one already there is not
    sqlx::raw_sql(
        r#"INSERT INTO libraries (name) VALUES ('l2');
           INSERT INTO media (title, type, "libraryId") VALUES ('Gap', 'movie', 2);
           INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES (3, 'gap', 1, 'q', (SELECT min(id) FROM library_folders));"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    movie_items(&c.pool).await;
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ($1, 2)"#)
        .bind(alice)
        .execute(&c.pool)
        .await
        .unwrap();
    let gap = json!({"items": [{"mediaId": 3}]});
    let (s, e) = c
        .call("PUT", &format!("{path}/programme"), &a, Some(gap))
        .await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_member_no_access")));
}

#[sqlx::test(migrations = false)]
async fn a_kick_survives_a_restart_and_only_a_new_token_or_an_invite_lifts_it(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let url = format!("/api/parties/{id}");
    let (_, p) = c.call("GET", &url, &a, None).await;
    let token = p["inviteToken"].as_str().unwrap().to_owned();
    let _ca = c.connect(alice, "da");
    let _cb = c.connect(bob, "db");
    let join = json!({"deviceId": "db", "token": token});
    c.call(
        "POST",
        &format!("{url}/join"),
        &a,
        Some(json!({"deviceId": "da"})),
    )
    .await;
    c.call("POST", &format!("{url}/join"), &b, Some(join.clone()))
        .await;
    let (s, _) = c
        .call("POST", &format!("{url}/members/{bob}/kick"), &a, None)
        .await;
    assert_eq!(s, 204);

    // not a guest anywhere, and the machine is gone: the block is in the database
    c.st.parties.remove(id as i32);
    let _ca = c.connect(alice, "da");
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["guests"], json!([]));
    let (_, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
    let (s, e) = c
        .call("POST", &format!("{url}/join"), &b, Some(join.clone()))
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_kicked")));
    let (s, e) = c
        .call("GET", &format!("/api/parties/by-token/{token}"), &b, None)
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_kicked")));

    let (s, p) = c
        .call("PATCH", &url, &a, Some(json!({"regenerateToken": true})))
        .await;
    assert_eq!(s, 200);
    let fresh = p["inviteToken"].as_str().unwrap().to_owned();
    let (s, _) = c
        .call(
            "POST",
            &format!("{url}/join"),
            &b,
            Some(json!({"deviceId": "db", "token": fresh})),
        )
        .await;
    assert_eq!(s, 200);
}

#[sqlx::test(migrations = false)]
async fn a_token_holder_who_has_not_joined_gets_the_summary_only(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (_, b) = c.user("bob", true).await;
    let id = party_with(&c, &a, vec![]).await;
    let (_, p) = c.call("GET", &format!("/api/parties/{id}"), &a, None).await;
    let token = p["inviteToken"].as_str().unwrap().to_owned();
    let _ca = c.connect(alice, "da");
    c.call(
        "POST",
        &format!("/api/parties/{id}/join"),
        &a,
        Some(json!({"deviceId": "da"})),
    )
    .await;
    let path = format!("/api/parties/by-token/{token}");
    let (s, p) = c.call("GET", &path, &b, None).await;
    assert_eq!(s, 200);
    assert_eq!(
        (p["live"].clone(), p["guests"].clone()),
        (Value::Null, json!([]))
    );
    assert_eq!(
        (p["name"].clone(), p["memberCount"].clone()),
        (json!("n"), json!(1))
    );
    let (_, p) = c.call("GET", &path, &a, None).await;
    assert_eq!(p["live"]["members"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = false)]
async fn a_recreated_machine_keeps_its_revision_above_the_old_one(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let id = party_with(&c, &a, vec![]).await;
    let _ca = c.connect(alice, "da");
    let url = format!("/api/parties/{id}");
    let join = Some(json!({"deviceId": "da"}));
    let (_, p) = c
        .call("POST", &format!("{url}/join"), &a, join.clone())
        .await;
    let old = p["live"]["rev"].as_u64().unwrap();
    c.st.parties.remove(id as i32);
    let _ca = c.connect(alice, "da");
    tokio::time::sleep(Duration::from_millis(5)).await;
    let (_, p) = c.call("POST", &format!("{url}/join"), &a, join).await;
    assert!(p["live"]["rev"].as_u64().unwrap() > old);

    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "mediaId": 1, "scheduledAt": "2999-01-01T01:00:00.000Z"})),
        )
        .await;
    assert!(p.get("lobbyOpensAt").is_none());
}

#[sqlx::test(migrations = false)]
async fn an_ended_for_another_item_is_ignored_and_one_for_the_current_item_counts_once(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let id = party_with(&c, &a, vec![]).await;
    let _ca = c.connect(alice, "da");
    let url = format!("/api/parties/{id}");
    c.call(
        "POST",
        &format!("{url}/join"),
        &a,
        Some(json!({"deviceId": "da"})),
    )
    .await;
    let send = |action: &'static str, item: Value| {
        let (c, a, url) = (&c, &a, &url);
        async move {
            c.call(
                "POST",
                &format!("{url}/intent"),
                a,
                Some(json!({"deviceId": "da", "action": action, "item": item, "baseRev": 0})),
            )
            .await
            .0
        }
    };
    send("play", Value::Null).await;
    c.call(
        "POST",
        &format!("{url}/status"),
        &a,
        Some(json!({"deviceId": "da", "status": "ready", "position": 0.0})),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(
        c.call("GET", &url, &a, None).await.1["live"]["playback"]["state"],
        "playing"
    );
    assert_eq!(send("ended", json!({"mediaId": 99})).await, 202);
    assert_eq!(
        c.call("GET", &url, &a, None).await.1["live"]["playback"]["state"],
        "playing"
    );
    assert_eq!(send("ended", json!({"mediaId": 1})).await, 202);
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["live"]["playback"]["state"], "idle");
    let rev = p["live"]["rev"].clone();
    assert_eq!(send("ended", json!({"mediaId": 1})).await, 202);
    assert_eq!(c.call("GET", &url, &a, None).await.1["live"]["rev"], rev);
}

#[sqlx::test(migrations = false)]
async fn regenerating_the_token_revokes_link_guests_online_or_not(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    let (carol, k) = c.user("carol", true).await;
    let id = party_with(&c, &a, vec![]).await;
    let url = format!("/api/parties/{id}");
    let (_, p) = c.call("GET", &url, &a, None).await;
    let token = p["inviteToken"].as_str().unwrap().to_owned();
    let _conns = [
        c.connect(alice, "da"),
        c.connect(bob, "db"),
        c.connect(carol, "dc"),
    ];
    c.call(
        "POST",
        &format!("{url}/join"),
        &a,
        Some(json!({"deviceId": "da"})),
    )
    .await;
    for (t, d) in [(&b, "db"), (&k, "dc")] {
        let (s, _) = c
            .call(
                "POST",
                &format!("{url}/join"),
                t,
                Some(json!({"deviceId": d, "token": token})),
            )
            .await;
        assert_eq!(s, 200);
    }
    // bob goes offline, carol stays connected
    let (s, _) = c
        .call(
            "POST",
            &format!("{url}/leave"),
            &b,
            Some(json!({"deviceId": "db"})),
        )
        .await;
    assert_eq!(s, 204);
    let (s, _) = c
        .call("PATCH", &url, &a, Some(json!({"regenerateToken": true})))
        .await;
    assert_eq!(s, 200);
    for t in [&b, &k] {
        let (s, _) = c.call("GET", &url, t, None).await;
        assert_eq!(s, 404);
    }
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["guests"], json!([]));
    assert_eq!(p["live"]["members"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = false)]
async fn a_host_can_kick_an_invitee_who_is_not_connected(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    let (carol, _) = c.user("carol", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let url = format!("/api/parties/{id}");
    let _ca = c.connect(alice, "da");
    let (s, _) = c.call("GET", &url, &b, None).await;
    assert_eq!(s, 200);
    let (s, _) = c
        .call("POST", &format!("{url}/members/{carol}/kick"), &a, None)
        .await;
    assert_eq!(s, 404, "a stranger is not a guest");
    let (s, _) = c
        .call("POST", &format!("{url}/members/{bob}/kick"), &a, None)
        .await;
    assert_eq!(s, 204);
    let (s, _) = c.call("GET", &url, &b, None).await;
    assert_eq!(s, 404);
    let (_, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[sqlx::test(migrations = false)]
async fn an_item_a_user_cannot_open_is_not_named_to_them(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    playlist_setup(&c, alice).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let (_, before) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(before[0]["item"]["title"], "Film");
    sqlx::query(r#"UPDATE watch_parties SET "itemId" = item_of(2, NULL) WHERE id = $1"#)
        .bind(id as i32)
        .execute(&c.pool)
        .await
        .unwrap();
    c.st.parties.remove(id as i32);
    let _ca = c.connect(alice, "da");
    let (_, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(list[0]["item"]["title"], "");
    let (_, p) = c.call("GET", &format!("/api/parties/{id}"), &b, None).await;
    assert_eq!(p["item"]["title"], "");
}

#[sqlx::test(migrations = false)]
async fn creating_a_party_twice_returns_the_open_one(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 1).await;
    let (_, a) = c.user("alice", true).await;
    let (_, b) = c.user("bob", true).await;
    let make = |tok: &str, media: i32, at: Option<&str>| {
        let body = json!({"name": "n", "mediaId": media, "scheduledAt": at});
        let tok = tok.to_owned();
        let c = &c;
        async move {
            let (s, p) = c.call("POST", "/api/parties", &tok, Some(body)).await;
            assert_eq!(s, 201);
            p["id"].as_i64().unwrap()
        }
    };

    let first = make(&a, 1, None).await;
    assert_eq!(make(&a, 1, None).await, first);
    assert_ne!(make(&a, 2, None).await, first);
    assert_ne!(make(&b, 1, None).await, first);

    sqlx::query("UPDATE watch_parties SET status = 'ended' WHERE id = $1")
        .bind(first as i32)
        .execute(&c.pool)
        .await
        .unwrap();
    let next = make(&a, 1, None).await;
    assert_ne!(next, first);

    let (t1, t2) = ("2099-01-01T10:00:00Z", "2099-01-01T12:00:00Z");
    let s1 = make(&a, 1, Some(t1)).await;
    let s2 = make(&a, 1, Some(t2)).await;
    assert_ne!(s1, s2);
    assert_ne!(s1, next);
    assert_eq!(make(&a, 1, Some(t1)).await, s1);
    assert_eq!(make(&a, 1, Some(t2)).await, s2);
}

#[sqlx::test(migrations = false)]
async fn simultaneous_creates_yield_one_party(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user("alice", true).await;
    let body = json!({"name": "n", "mediaId": 1});
    let calls = (0..6).map(|_| c.call("POST", "/api/parties", &a, Some(body.clone())));
    let ids: Vec<i64> = futures_util::future::join_all(calls)
        .await
        .into_iter()
        .map(|(s, p)| {
            assert_eq!(s, 201);
            p["id"].as_i64().unwrap()
        })
        .collect();
    assert!(ids.iter().all(|i| *i == ids[0]));
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM watch_parties")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test(migrations = false)]
async fn a_guest_quits_and_the_party_leaves_their_list(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    let (dave, d) = c.user("dave", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let url = format!("/api/parties/{id}");
    let (_, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    let (s, _) = c.call("POST", &format!("{url}/quit"), &a, None).await;
    assert_eq!(s, 400, "the host cannot quit");
    let (s, e) = c.call("POST", &format!("{url}/quit"), &d, None).await;
    assert_eq!((s, msg(&e)), (404, Some("party.error_not_found")));
    let (s, _) = c.call("POST", &format!("{url}/quit"), &b, None).await;
    assert_eq!(s, 204);
    let (_, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
    let (s, _) = c.call("GET", &url, &b, None).await;
    assert_eq!(s, 404);
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["guests"].as_array().unwrap().len(), 0);
    let (s, _) = c.call("POST", &format!("{url}/quit"), &b, None).await;
    assert_eq!(s, 404, "a second quit finds no guest row");

    let token = p["inviteToken"].as_str().unwrap().to_owned();
    let _cd = c.connect(dave, "dd");
    let join = json!({"deviceId": "dd", "token": token});
    let (s, _) = c.call("POST", &format!("{url}/join"), &d, Some(join)).await;
    assert_eq!(s, 200);
    let (s, _) = c.call("POST", &format!("{url}/quit"), &d, None).await;
    assert_eq!(s, 204, "a link joiner quits too");
    let (_, list) = c.call("GET", "/api/parties", &d, None).await;
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[sqlx::test(migrations = false)]
async fn a_party_without_a_film_takes_the_hosts_selection_and_starts_on_it(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 1).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "later", "inviteeIds": [bob]})),
        )
        .await;
    assert_eq!(s, 201);
    let id = p["id"].as_i64().unwrap();
    let url = format!("/api/parties/{id}");
    assert_eq!(
        (p["item"].clone(), p["live"]["playback"].clone()),
        (Value::Null, Value::Null)
    );
    let (_, list) = c.call("GET", "/api/parties", &b, None).await;
    assert_eq!(list[0]["item"], Value::Null);

    let (s, e) = c.call("POST", &format!("{url}/start"), &a, None).await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_no_item")));
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["status"], "scheduled");

    let mut sa = c.stream(&a, "da").await;
    let mut sb = c.stream(&b, "db").await;
    for (t, d) in [(&a, "da"), (&b, "db")] {
        let (s, p) = c
            .call(
                "POST",
                &format!("{url}/join"),
                t,
                Some(json!({"deviceId": d})),
            )
            .await;
        assert_eq!((s, p["item"].clone()), (200, Value::Null));
    }
    let (s, e) = c
        .call(
            "POST",
            &format!("{url}/select"),
            &b,
            Some(json!({"mediaId": 2})),
        )
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_not_host")));
    let (s, e) = c
        .call(
            "POST",
            &format!("{url}/select"),
            &a,
            Some(json!({"mediaId": 2, "episodeId": 99})),
        )
        .await;
    assert_eq!((s, msg(&e)), (400, Some("party.error_invalid_item")));

    let (s, p) = c
        .call(
            "POST",
            &format!("{url}/select"),
            &a,
            Some(json!({"mediaId": 2})),
        )
        .await;
    assert_eq!((s, p["item"]["mediaId"].clone()), (200, json!(2)));
    let picked = events_of(&mut sb, "party.programme").await;
    assert_eq!(picked.len(), 1);
    assert_eq!(picked[0]["item"]["mediaId"], 2);
    let (_, p) = c.call("GET", &url, &b, None).await;
    assert_eq!(
        (p["item"]["mediaId"].clone(), p["live"]["playback"].clone()),
        (json!(2), Value::Null)
    );

    let (s, p) = c.call("POST", &format!("{url}/start"), &a, None).await;
    assert_eq!((s, p["status"].clone()), (200, json!("live")));
    assert_eq!(p["item"]["mediaId"], 2);
    assert_eq!(p["live"]["playback"]["state"], "waiting");
    let states = events_of(&mut sa, "party.state").await;
    assert_eq!(states.last().unwrap()["item"]["mediaId"], 2);
    let (s, e) = c
        .call(
            "POST",
            &format!("{url}/select"),
            &a,
            Some(json!({"mediaId": 1})),
        )
        .await;
    assert_eq!((s, msg(&e)), (200, None));
    // the playing film stays, the programme behind it is replaced
    assert_eq!(e["item"]["mediaId"], 2);
    let (_, q) = c.call("GET", &format!("{url}/queue"), &a, None).await;
    assert_eq!(q[0]["mediaId"], 1);
    assert_eq!(q.as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = false)]
async fn a_selection_every_member_cannot_open_is_refused_and_a_member_without_access_may_join_a_room_with_no_film(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", false).await;
    c.follow(alice, bob).await;
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "room", "inviteeIds": [bob]})),
        )
        .await;
    let url = format!("/api/parties/{}", p["id"]);
    let _ca = c.connect(alice, "da");
    let _cb = c.connect(bob, "db");
    for (t, d) in [(&a, "da"), (&b, "db")] {
        let (s, _) = c
            .call(
                "POST",
                &format!("{url}/join"),
                t,
                Some(json!({"deviceId": d})),
            )
            .await;
        assert_eq!(s, 200);
    }
    let (s, e) = c
        .call(
            "POST",
            &format!("{url}/select"),
            &a,
            Some(json!({"mediaId": 1})),
        )
        .await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_member_no_access")));
    assert_eq!(e["usernames"], json!(["bob"]));
}

#[sqlx::test(migrations = false)]
async fn the_programme_is_the_source_of_truth_when_the_start_follows_a_head_the_machine_missed(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    more_media(&c, 1).await;
    let (_, a) = c.user("alice", true).await;
    let (_, p) = c
        .call("POST", "/api/parties", &a, Some(json!({"name": "room"})))
        .await;
    let id = p["id"].as_i64().unwrap();
    let url = format!("/api/parties/{id}");
    sqlx::query(
        r#"INSERT INTO watch_party_items ("partyId", position, "itemId") VALUES ($1, 0, item_of(2, NULL))"#,
    )
    .bind(id as i32)
    .execute(&c.pool)
    .await
    .unwrap();
    let (s, p) = c.call("POST", &format!("{url}/start"), &a, None).await;
    assert_eq!((s, p["item"]["mediaId"].clone()), (200, json!(2)));
    assert_ne!(p["live"]["playback"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn a_selection_survives_the_lobby_being_freed_and_select_tells_the_rail(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 1).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "room", "inviteeIds": [bob]})),
        )
        .await;
    let id = p["id"].as_i64().unwrap();
    let url = format!("/api/parties/{id}");
    let mut sb = c.stream(&b, "db").await;
    let (s, _) = c
        .call(
            "POST",
            &format!("{url}/select"),
            &a,
            Some(json!({"mediaId": 2})),
        )
        .await;
    assert_eq!(s, 200);
    assert_eq!(events_of(&mut sb, "party.updated").await.len(), 1);

    c.st.parties.remove(id as i32);
    let _ca = c.connect(alice, "da");
    let (s, p) = c
        .call(
            "POST",
            &format!("{url}/join"),
            &a,
            Some(json!({"deviceId": "da"})),
        )
        .await;
    assert_eq!((s, p["item"]["mediaId"].clone()), (200, json!(2)));
    let (_, p) = c.call("POST", &format!("{url}/start"), &a, None).await;
    assert_eq!(p["live"]["playback"]["state"], "waiting");
}

#[sqlx::test(migrations = false)]
async fn select_replaces_the_copied_playlist_programme_by_one_item(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    playlist_setup(&c, alice).await;
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "playlistId": 1})),
        )
        .await;
    let id = p["id"].clone();
    sqlx::query(r#"WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES (3, 'e2', 1, 'q', (SELECT min(id) FROM library_folders)) RETURNING id)
             INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT 2, id, 3, 0 FROM f"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, p) = c
        .call(
            "POST",
            &format!("/api/parties/{id}/select"),
            &a,
            Some(json!({"mediaId": 3, "episodeId": 2})),
        )
        .await;
    assert_eq!((s, p["item"]["episodeId"].clone()), (200, json!(2)));
    let (_, q) = c
        .call("GET", &format!("/api/parties/{id}/queue"), &a, None)
        .await;
    assert_eq!(q.as_array().unwrap().len(), 1);
}

/// A film-less party of `host` with the invitees, who must be followed first.
async fn bare_party(c: &Ctx, host: &str, invitees: &[i32]) -> String {
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            host,
            Some(json!({"name": "pick", "inviteeIds": invitees})),
        )
        .await;
    assert_eq!(s, 201);
    format!("/api/parties/{}", p["id"])
}

async fn propose(c: &Ctx, url: &str, tok: &str, media: i32) -> (u16, Value) {
    c.call(
        "POST",
        &format!("{url}/proposals"),
        tok,
        Some(json!({"mediaId": media})),
    )
    .await
}

fn proposal_of(list: &Value, media: i32) -> Value {
    list.as_array()
        .unwrap()
        .iter()
        .find(|p| p["item"]["mediaId"] == media)
        .cloned()
        .unwrap_or(Value::Null)
}

#[sqlx::test(migrations = false)]
async fn members_propose_and_vote_for_several_titles_and_a_duplicate_is_a_vote(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 4).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    let (_, stranger) = c.user("zed", true).await;
    c.follow(alice, bob).await;
    let url = bare_party(&c, &a, &[bob]).await;

    let (s, l) = propose(&c, &url, &a, 2).await;
    assert_eq!(
        (s, proposal_of(&l, 2)["upvoterIds"].clone()),
        (201, json!([alice]))
    );
    let (s, _) = propose(&c, &url, &a, 3).await;
    assert_eq!(s, 201);
    let (s, l) = propose(&c, &url, &b, 2).await;
    assert_eq!(s, 200, "a duplicate only adds a vote");
    assert_eq!(l.as_array().unwrap().len(), 2);
    assert_eq!(proposal_of(&l, 2)["upvoterIds"], json!([alice, bob]));
    assert_eq!(proposal_of(&l, 2)["proposedBy"], alice);

    let p3 = proposal_of(&l, 3)["id"].as_i64().unwrap();
    let vote = format!("{url}/proposals/{p3}/vote");
    for _ in 0..2 {
        let (s, _) = c.call("PUT", &vote, &b, Some(json!({"value": 1}))).await;
        assert_eq!(s, 204, "a vote is idempotent");
    }
    let (_, p) = c.call("GET", &url, &b, None).await;
    assert_eq!(
        proposal_of(&p["proposals"], 3)["upvoterIds"],
        json!([alice, bob])
    );
    let (s, _) = c.call("PUT", &vote, &b, Some(json!({"value": -1}))).await;
    assert_eq!(s, 204, "the other way switches the vote");
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(
        proposal_of(&p["proposals"], 3)["upvoterIds"],
        json!([alice])
    );
    assert_eq!(
        proposal_of(&p["proposals"], 3)["downvoterIds"],
        json!([bob])
    );
    let (s, _) = c.call("PUT", &vote, &b, Some(json!({"value": 2}))).await;
    assert_eq!(s, 400);
    let (s, _) = c.call("DELETE", &vote, &b, None).await;
    assert_eq!(s, 204);
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(
        proposal_of(&p["proposals"], 3)["upvoterIds"],
        json!([alice])
    );
    assert_eq!(proposal_of(&p["proposals"], 3)["downvoterIds"], json!([]));
    assert_eq!(
        proposal_of(&p["proposals"], 2)["upvoterIds"],
        json!([alice, bob])
    );

    let (s, _) = propose(&c, &url, &stranger, 4).await;
    assert_eq!(s, 404, "a non-member does not see the party");
    let (s, _) = c
        .call(
            "PUT",
            &format!("{url}/proposals/999/vote"),
            &b,
            Some(json!({"value": 1})),
        )
        .await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn only_the_author_or_the_host_deletes_a_proposal(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 3).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    let (carol, cc) = c.user("carol", true).await;
    c.follow(alice, bob).await;
    c.follow(alice, carol).await;
    let url = bare_party(&c, &a, &[bob, carol]).await;
    let (_, l) = propose(&c, &url, &b, 2).await;
    let by_bob = proposal_of(&l, 2)["id"].as_i64().unwrap();
    let (_, l) = propose(&c, &url, &b, 3).await;
    let other = proposal_of(&l, 3)["id"].as_i64().unwrap();

    let (s, e) = c
        .call("DELETE", &format!("{url}/proposals/{by_bob}"), &cc, None)
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_not_author")));
    let (s, _) = c
        .call("DELETE", &format!("{url}/proposals/{by_bob}"), &b, None)
        .await;
    assert_eq!(s, 204);
    let (s, _) = c
        .call("DELETE", &format!("{url}/proposals/{other}"), &a, None)
        .await;
    assert_eq!(s, 204, "the host deletes anyone's");
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["proposals"], json!([]));
    let (s, _) = c
        .call("DELETE", &format!("{url}/proposals/{other}"), &a, None)
        .await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn a_party_holds_thirty_proposals_and_a_user_is_rate_limited(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 32).await;
    let (_, a) = c.user("alice", true).await;
    let url = bare_party(&c, &a, &[]).await;
    let id: i32 = url.rsplit('/').next().unwrap().parse().unwrap();
    sqlx::query(
        r#"INSERT INTO watch_party_proposals ("partyId", "itemId", "proposedBy")
           SELECT $1, item_of(m.id, NULL), 1 FROM media m WHERE m.id BETWEEN 2 AND 31"#,
    )
    .bind(id)
    .execute(&c.pool)
    .await
    .unwrap();
    let (s, e) = propose(&c, &url, &a, 32).await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_proposals_full")));
    let (s, _) = propose(&c, &url, &a, 2).await;
    assert_eq!(s, 200, "a vote for a listed title is not a new proposal");

    let mut last = 0;
    for _ in 0..10 {
        last = propose(&c, &url, &a, 3).await.0;
    }
    assert_eq!(last, 429);
}

#[sqlx::test(migrations = false)]
async fn a_batch_proposes_in_order_as_one_request_and_is_all_or_nothing(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 31).await;
    let (alice, a) = c.user("alice", true).await;
    let url = bare_party(&c, &a, &[]).await;
    let batch = |ids: Vec<i32>| {
        let items: Vec<Value> = ids.into_iter().map(|m| json!({"mediaId": m})).collect();
        json!({ "items": items })
    };
    let at = format!("{url}/proposals/batch");

    let (s, l) = c
        .call("POST", &at, &a, Some(batch((2..=13).collect())))
        .await;
    assert_eq!(s, 201, "twelve titles cost one rate-limit slot");
    let order: Vec<Value> = l
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["item"]["mediaId"].clone())
        .collect();
    assert_eq!(order, (2..=13).map(|m| json!(m)).collect::<Vec<_>>());
    assert_eq!(proposal_of(&l, 2)["upvoterIds"], json!([alice]));

    let (s, _) = c
        .call("POST", &at, &a, Some(batch((14..=32).collect())))
        .await;
    assert_eq!(s, 409, "past thirty the whole batch is refused");
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["proposals"].as_array().unwrap().len(), 12);

    let (s, _) = c.call("POST", &at, &a, Some(batch(vec![]))).await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn a_party_opens_on_several_items_in_order(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 3).await;
    let (_, a) = c.user("alice", true).await;
    let create = |items: Value| json!({"name": "trio", "items": items});
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(create(
                json!([{"mediaId": 3}, {"mediaId": 2}, {"mediaId": 4}]),
            )),
        )
        .await;
    assert_eq!(s, 201);
    assert_eq!(p["item"]["mediaId"], json!(3));
    let (_, q) = c
        .call("GET", &format!("/api/parties/{}/queue", p["id"]), &a, None)
        .await;
    let order: Vec<Value> = q
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["mediaId"].clone())
        .collect();
    assert_eq!(order, vec![json!(3), json!(2), json!(4)]);

    let (s, _) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(create(json!([{"mediaId": 2}, {"mediaId": 2}]))),
        )
        .await;
    assert_eq!(s, 400, "a duplicate is refused");
    let (s, _) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "x", "mediaId": 2, "items": [{"mediaId": 3}]})),
        )
        .await;
    assert_eq!(s, 400, "items exclude mediaId");
}

#[sqlx::test(migrations = false)]
async fn a_title_a_member_cannot_open_reaches_them_masked_and_the_author_needs_access(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    more_media(&c, 1).await;
    let (alice, a) = c.user("alice", true).await;
    let (carol, cc) = c.user("carol", false).await;
    c.follow(alice, carol).await;
    let url = bare_party(&c, &a, &[carol]).await;
    let mut sc = c.stream(&cc, "dc").await;
    let mut sa = c.stream(&a, "da").await;

    let (s, _) = propose(&c, &url, &cc, 2).await;
    assert_eq!(s, 404, "the author must open the title");
    let (s, _) = propose(&c, &url, &a, 2).await;
    assert_eq!(s, 201);

    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["proposals"][0]["item"]["title"], "m0");
    let (_, p) = c.call("GET", &url, &cc, None).await;
    assert_eq!(p["proposals"][0]["item"]["title"], "");
    assert_eq!(p["proposals"][0]["item"]["mediaId"], 2);
    let masked = events_of(&mut sc, "party.proposals").await;
    assert_eq!(masked.len(), 1);
    assert_eq!(masked[0]["proposals"][0]["item"]["title"], "");
    let shown = events_of(&mut sa, "party.proposals").await;
    assert_eq!(shown[0]["proposals"][0]["item"]["title"], "m0");
}

#[sqlx::test(migrations = false)]
async fn the_start_takes_the_top_vote_refuses_a_tie_and_the_hosts_choice_wins(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 4).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;

    let tie = bare_party(&c, &a, &[bob]).await;
    propose(&c, &tie, &b, 3).await;
    propose(&c, &tie, &a, 2).await;
    let (s, e) = c.call("POST", &format!("{tie}/start"), &a, None).await;
    assert_eq!(
        (s, msg(&e)),
        (409, Some("party.error_vote_tie")),
        "a tie starts nothing"
    );

    let voted = bare_party(&c, &a, &[bob]).await;
    propose(&c, &voted, &b, 3).await;
    let (_, l) = propose(&c, &voted, &a, 2).await;
    let id = proposal_of(&l, 2)["id"].as_i64().unwrap();
    let (s, _) = c
        .call(
            "PUT",
            &format!("{voted}/proposals/{id}/vote"),
            &b,
            Some(json!({"value": 1})),
        )
        .await;
    assert_eq!(s, 204);
    let (s, p) = c.call("POST", &format!("{voted}/start"), &a, None).await;
    assert_eq!((s, p["item"]["mediaId"].clone()), (200, json!(2)));
    let (s, e) = propose(&c, &voted, &b, 4).await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_not_scheduled")));

    let downed = bare_party(&c, &a, &[bob]).await;
    let (_, l) = propose(&c, &downed, &b, 3).await;
    propose(&c, &downed, &a, 2).await;
    let id = proposal_of(&l, 3)["id"].as_i64().unwrap();
    c.call(
        "PUT",
        &format!("{downed}/proposals/{id}/vote"),
        &b,
        Some(json!({"value": -1})),
    )
    .await;
    let (s, p) = c.call("POST", &format!("{downed}/start"), &a, None).await;
    assert_eq!(
        (s, p["item"]["mediaId"].clone()),
        (200, json!(2)),
        "a downvote sinks the oldest"
    );

    let chosen = bare_party(&c, &a, &[bob]).await;
    let (_, l) = propose(&c, &chosen, &b, 3).await;
    propose(&c, &chosen, &a, 2).await;
    let pid = proposal_of(&l, 3)["id"].as_i64().unwrap();
    let (s, e) = c
        .call(
            "POST",
            &format!("{chosen}/proposals/{pid}/choose"),
            &b,
            None,
        )
        .await;
    assert_eq!((s, msg(&e)), (403, Some("party.error_not_host")));
    let (s, p) = c
        .call(
            "POST",
            &format!("{chosen}/select"),
            &a,
            Some(json!({"mediaId": 4})),
        )
        .await;
    assert_eq!((s, p["item"]["mediaId"].clone()), (200, json!(4)));
    let (s, p) = c.call("POST", &format!("{chosen}/start"), &a, None).await;
    assert_eq!(
        (s, p["item"]["mediaId"].clone()),
        (200, json!(4)),
        "the host's select beats votes"
    );

    let pick = bare_party(&c, &a, &[bob]).await;
    let (_, l) = propose(&c, &pick, &b, 3).await;
    let pid = proposal_of(&l, 3)["id"].as_i64().unwrap();
    let (s, p) = c
        .call("POST", &format!("{pick}/proposals/{pid}/choose"), &a, None)
        .await;
    assert_eq!((s, p["item"]["mediaId"].clone()), (200, json!(3)));

    let (s, _) = c.call("DELETE", &pick, &a, None).await;
    assert_eq!(s, 204);
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM watch_party_proposals WHERE \"partyId\" = $1")
            .bind(pick.rsplit('/').next().unwrap().parse::<i32>().unwrap())
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(left, 0, "ending the party clears its proposals");
}

/// A second library with a film in it, which alice opens and nobody else does.
async fn hidden_film(c: &Ctx, alice: i32) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO libraries (name) VALUES ('l2');
           INSERT INTO media (title, type, "libraryId") VALUES ('Hidden', 'movie', 2);
           INSERT INTO library_user_access ("userId", "libraryId") VALUES ({alice}, 2);
           INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES (2, 'hidden', 1, 'q', (SELECT min(id) FROM library_folders));"#
    )))
    .execute(&c.pool)
    .await
    .unwrap();
    movie_items(&c.pool).await;
}

async fn put_programme(c: &Ctx, url: &str, tok: &str, media: &[i32]) -> (u16, Value) {
    let items: Vec<_> = media.iter().map(|m| json!({"mediaId": m})).collect();
    c.call(
        "PUT",
        &format!("{url}/programme"),
        tok,
        Some(json!({ "items": items })),
    )
    .await
}

async fn join(c: &Ctx, url: &str, tok: &str, device: &str) -> (u16, Value) {
    c.call(
        "POST",
        &format!("{url}/join"),
        tok,
        Some(json!({"deviceId": device})),
    )
    .await
}

#[sqlx::test(migrations = false)]
async fn a_guest_in_the_lobby_before_the_owner_never_takes_the_host_role(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let url = bare_party(&c, &a, &[bob]).await;
    let (_sb, _sa) = (c.stream(&b, "db").await, c.stream(&a, "da").await);
    assert_eq!(join(&c, &url, &b, "db").await.0, 200);
    party::tick(&c.st).await;
    party::tick(&c.st).await;
    let (_, p) = c.call("GET", &url, &b, None).await;
    assert_eq!(p["host"]["userId"], alice);
    let host_of = |p: &Value, user: i32| {
        p["live"]["members"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["userId"] == user)
            .map(|m| m["role"].clone())
    };
    assert_eq!(host_of(&p, bob), Some(json!("member")));
    for (path, method, body) in [
        ("/start", "POST", None),
        ("", "PATCH", Some(json!({"regenerateToken": true}))),
        ("", "DELETE", None),
    ] {
        let (s, e) = c.call(method, &format!("{url}{path}"), &b, body).await;
        assert_eq!((s, msg(&e)), (403, Some("party.error_not_host")), "{path}");
    }
    let (s, e) = c
        .call("POST", &format!("{url}/members/{bob}/host"), &a, None)
        .await;
    assert_eq!((s, msg(&e)), (400, Some("party.error_invalid")));

    assert_eq!(join(&c, &url, &a, "da").await.0, 200);
    party::tick(&c.st).await;
    let (_, p) = c.call("GET", &url, &b, None).await;
    assert_eq!(p["host"]["userId"], alice);
    assert_eq!(host_of(&p, alice), Some(json!("host")));
    assert_eq!(host_of(&p, bob), Some(json!("member")));
    let (s, _) = c
        .call("PATCH", &url, &a, Some(json!({"name": "mine"})))
        .await;
    assert_eq!(s, 200);
}

#[sqlx::test(migrations = false)]
async fn a_reorder_or_a_start_never_puts_a_title_a_member_cannot_open_in_front_of_them(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    hidden_film(&c, alice).await;
    let url = bare_party(&c, &a, &[bob]).await;
    assert_eq!(put_programme(&c, &url, &a, &[1, 2]).await.0, 200);
    let mut sb = c.stream(&b, "db").await;
    assert_eq!(join(&c, &url, &b, "db").await.0, 200);
    events_of(&mut sb, "party.programme").await;

    // the reorder brings an item nobody told bob about to the head
    let (s, e) = put_programme(&c, &url, &a, &[2, 1]).await;
    assert_eq!(
        (s, msg(&e), e["usernames"].clone()),
        (409, Some("party.error_member_no_access"), json!(["bob"]))
    );
    assert!(
        events_of(&mut sb, "party.programme")
            .await
            .iter()
            .all(|e| e["item"]["mediaId"] != 2)
    );
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["item"]["mediaId"], 1);
    let (_, q) = c.call("GET", &format!("{url}/queue"), &b, None).await;
    assert_eq!(
        (
            q[1]["hidden"].clone(),
            q[1]["title"].clone(),
            q[1]["mediaId"].clone()
        ),
        (json!(true), json!(""), json!(2))
    );
    assert_eq!(q[0]["hidden"], false);
    // a reorder that keeps the head is fine
    assert_eq!(put_programme(&c, &url, &a, &[1]).await.0, 200);

    // bob lost his library after joining: the start refuses a head he cannot open
    sqlx::query(r#"DELETE FROM library_user_access WHERE "userId" = $1"#)
        .bind(bob)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, e) = c.call("POST", &format!("{url}/start"), &a, None).await;
    assert_eq!(
        (s, msg(&e), e["usernames"].clone()),
        (409, Some("party.error_member_no_access"), json!(["bob"]))
    );
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["status"], "scheduled");
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ($1, 1)"#)
        .bind(bob)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, p) = c.call("POST", &format!("{url}/start"), &a, None).await;
    assert_eq!((s, p["status"].clone()), (200, json!("live")));
}

#[sqlx::test(migrations = false)]
async fn nothing_without_a_file_is_picked_or_started_and_a_series_needs_its_episode(pool: PgPool) {
    let c = ctx(pool).await;
    let (_alice, a) = c.user("alice", true).await;
    sqlx::raw_sql(
        r#"INSERT INTO media (title, type, "libraryId") VALUES ('Empty', 'movie', 1), ('Show', 'series', 1);
           INSERT INTO item_groups ("number", "mediaId") VALUES (1, 3);
           INSERT INTO editions ("mediaId", family) VALUES (3, 'video');
           INSERT INTO items ("number", title, "groupId", "mediaId", "editionId") VALUES (1, 'e1', 1, 3, 1), (2, 'e2', 1, 3, 1);
           WITH f AS (INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES (3, 'e1', 1, 'q', (SELECT min(id) FROM library_folders)) RETURNING id)
             INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") SELECT 1, id, 3, 0 FROM f"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    movie_items(&c.pool).await;
    let invalid = |(s, e): (u16, Value)| (s, msg(&e).map(str::to_owned));
    let bad = (400, Some("party.error_invalid_item".to_owned()));
    let create = |body: Value| c.call("POST", "/api/parties", &a, Some(body));
    assert_eq!(
        invalid(create(json!({"name": "n", "mediaId": 2})).await),
        bad
    );
    assert_eq!(
        invalid(create(json!({"name": "n", "mediaId": 3})).await),
        bad
    );
    assert_eq!(
        invalid(create(json!({"name": "n", "mediaId": 3, "episodeId": 2})).await),
        bad
    );
    let (s, p) = create(json!({"name": "n", "mediaId": 1})).await;
    assert_eq!(s, 201);
    let url = format!("/api/parties/{}", p["id"]);
    assert_eq!(invalid(put_programme(&c, &url, &a, &[1, 2]).await), bad);
    assert_eq!(invalid(propose(&c, &url, &a, 2).await), bad);
    assert_eq!(invalid(propose(&c, &url, &a, 3).await), bad);

    // the file went away after the pick: the start refuses
    sqlx::query(r#"DELETE FROM media_files WHERE "mediaId" = 1"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, e) = c.call("POST", &format!("{url}/start"), &a, None).await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_no_item")));
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["status"], "scheduled");
}

#[sqlx::test(migrations = false)]
async fn a_start_is_taken_once_and_loses_to_an_end(pool: PgPool) {
    let c = ctx(pool).await;
    let (_alice, a) = c.user("alice", true).await;
    let mut sa = c.stream(&a, "da").await;
    more_media(&c, 1).await;
    let (cr, ar) = (&c, &a);
    let lobby = |media: i32| async move {
        let (_, p) = cr
            .call(
                "POST",
                "/api/parties",
                ar,
                Some(json!({"name": "n", "mediaId": media})),
            )
            .await;
        let url = format!("/api/parties/{}", p["id"]);
        assert_eq!(join(cr, &url, ar, "da").await.0, 200);
        url
    };
    let url = lobby(1).await;
    events_of(&mut sa, "party.state").await;
    let start = format!("{url}/start");
    let ((s1, _), (s2, _)) = tokio::join!(
        c.call("POST", &start, &a, None),
        c.call("POST", &start, &a, None)
    );
    assert_eq!((s1, s2), (200, 200));
    assert_eq!(events_of(&mut sa, "party.state").await.len(), 1);
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["status"], "live");

    let url = lobby(2).await;
    let start = format!("{url}/start");
    let ((s, _), (end, _)) = tokio::join!(
        c.call("POST", &start, &a, None),
        c.call("DELETE", &url, &a, None)
    );
    assert_eq!(end, 204);
    assert!([200, 409].contains(&s), "{s}");
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["status"], "ended");
}

#[sqlx::test(migrations = false)]
async fn a_programme_holds_five_hundred_items_whoever_adds_them(pool: PgPool) {
    let c = ctx(pool).await;
    let (_alice, a) = c.user("alice", true).await;
    sqlx::query(
        r#"INSERT INTO media (title, type, "libraryId")
           SELECT 'm' || g, 'movie', 1 FROM generate_series(1, 500) g"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    movie_items(&c.pool).await;
    sqlx::query(
        r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId")
           SELECT id, 'f' || id, 1, 'q', (SELECT min(id) FROM library_folders) FROM media WHERE id > 1"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    movie_items(&c.pool).await;
    let url = bare_party(&c, &a, &[]).await;
    let rest: Vec<i32> = (2..=501).collect();
    assert_eq!(put_programme(&c, &url, &a, &rest).await.0, 200);
    let all: Vec<i32> = (1..=501).collect();
    let (s, e) = put_programme(&c, &url, &a, &all).await;
    assert_eq!((s, msg(&e)), (400, Some("party.error_invalid_item")));
    let (_, l) = propose(&c, &url, &a, 1).await;
    let pid = proposal_of(&l, 1)["id"].as_i64().unwrap();
    let (s, e) = c
        .call("POST", &format!("{url}/proposals/{pid}/choose"), &a, None)
        .await;
    assert_eq!((s, msg(&e)), (400, Some("party.error_invalid_item")));
    let (_, q) = c.call("GET", &format!("{url}/queue"), &a, None).await;
    assert_eq!(q.as_array().unwrap().len(), 500);
}

#[sqlx::test(migrations = false)]
async fn a_kicked_or_quitting_user_no_longer_votes_or_proposes(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 2).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    let (carol, t) = c.user("carol", true).await;
    c.follow(alice, bob).await;
    c.follow(alice, carol).await;
    let url = bare_party(&c, &a, &[bob, carol]).await;
    propose(&c, &url, &b, 2).await;
    let (_, l) = propose(&c, &url, &t, 3).await;
    let pid = proposal_of(&l, 3)["id"].as_i64().unwrap();
    c.call(
        "PUT",
        &format!("{url}/proposals/{pid}/vote"),
        &b,
        Some(json!({"value": 1})),
    )
    .await;
    let (s, _) = c
        .call("POST", &format!("{url}/members/{bob}/kick"), &a, None)
        .await;
    assert_eq!(s, 204);
    let (_, p) = c.call("GET", &url, &a, None).await;
    let proposals = p["proposals"].as_array().unwrap();
    assert_eq!(proposals.len(), 1);
    assert_eq!(proposals[0]["upvoterIds"], json!([carol]));

    let (_sc, _sa) = (c.stream(&t, "dc").await, c.stream(&a, "da").await);
    assert_eq!(join(&c, &url, &t, "dc").await.0, 200);
    let (s, _) = c.call("POST", &format!("{url}/quit"), &t, None).await;
    assert_eq!(s, 204);
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(p["proposals"], json!([]));
    assert_eq!(p["live"]["members"], json!([]));
    let (s, e) = c.call("POST", &format!("{url}/start"), &a, None).await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_no_item")));
}

#[sqlx::test(migrations = false)]
async fn the_chat_goes_with_an_ended_party_and_item_messages_name_only_what_a_viewer_opens(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    hidden_film(&c, alice).await;
    let url = bare_party(&c, &a, &[bob]).await;
    assert_eq!(put_programme(&c, &url, &a, &[1, 2]).await.0, 200);
    let (_sa, mut sb) = (c.stream(&a, "da").await, c.stream(&b, "db").await);
    for (t, d) in [(&a, "da"), (&b, "db")] {
        assert_eq!(join(&c, &url, t, d).await.0, 200);
    }
    c.call("POST", &format!("{url}/start"), &a, None).await;
    events_of(&mut sb, "party.message").await;
    let (_, now) = c.call("GET", &url, &a, None).await;
    let rev = now["live"]["rev"].as_u64().unwrap();
    let (s, _) = c
        .call(
            "POST",
            &format!("{url}/intent"),
            &a,
            Some(json!({"deviceId": "da", "action": "next", "baseRev": rev})),
        )
        .await;
    assert_eq!(s, 202);
    // nothing left after the film bob cannot open: the party idles, the skipped row is named to alice only
    let skipped = |p: &Value| {
        systems(p)
            .into_iter()
            .find(|s| s.0 == "item_skipped")
            .map(|s| s.1)
            .unwrap()
    };
    let (_, pa) = c.call("GET", &url, &a, None).await;
    let (_, pb) = c.call("GET", &url, &b, None).await;
    assert_eq!(
        skipped(&pa),
        json!({"mediaId": 2, "episodeId": null, "title": "Hidden"})
    );
    assert_eq!(
        skipped(&pb),
        json!({"mediaId": 2, "episodeId": null, "title": ""})
    );
    let live = events_of(&mut sb, "party.message").await;
    let sent = live
        .iter()
        .find(|e| e["message"]["system"]["kind"] == "item_skipped")
        .expect("bob is told too");
    assert_eq!(sent["message"]["system"]["args"]["title"], "");
    let stored: Value = sqlx::query_scalar(
        r#"SELECT "system"->'args' FROM watch_party_messages WHERE "system"->>'kind' = 'item_skipped'"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(stored, json!({"mediaId": 2, "episodeId": null}));

    c.call("DELETE", &url, &a, None).await;
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM watch_party_messages")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[sqlx::test(migrations = false)]
async fn creating_a_party_needs_parties_create(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user_with("alice", true, &["media.read"]).await;
    let (s, e) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "n", "mediaId": 1})),
        )
        .await;
    assert_eq!((s, msg(&e)), (403, Some("Forbidden resource")));
}

#[sqlx::test(migrations = false)]
async fn a_public_party_is_listed_and_joinable_only_with_read_public(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, h) = c.user("host", true).await;
    let (_, viewer) = c.user_with("viewer", true, &["parties.read_public"]).await;
    let (_, outsider) = c.user_with("outsider", true, &[]).await;
    let (_, private) = c.user("private", true).await;
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            &h,
            Some(json!({"name": "n", "mediaId": 1, "public": true})),
        )
        .await;
    assert_eq!((s, p["public"].clone()), (201, json!(true)));
    let id = p["id"].as_i64().unwrap();
    let (_, q) = c
        .call(
            "POST",
            "/api/parties",
            &private,
            Some(json!({"name": "q", "mediaId": 1})),
        )
        .await;
    assert_eq!(q["public"], json!(false));

    let (s, list) = c.call("GET", "/api/parties", &viewer, None).await;
    let ids: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_i64().unwrap())
        .collect();
    assert_eq!((s, ids), (200, vec![id]));
    let (_, list) = c.call("GET", "/api/parties", &outsider, None).await;
    assert!(list.as_array().unwrap().is_empty());

    let path = format!("/api/parties/{id}");
    let (s, v) = c.call("GET", &path, &viewer, None).await;
    assert_eq!((s, v["inviteToken"].clone()), (200, Value::Null));
    let (s, _) = c.call("GET", &path, &outsider, None).await;
    assert_eq!(s, 404);

    let _conn = c.connect(2, "d1");
    let (s, _) = c
        .call(
            "POST",
            &format!("{path}/join"),
            &viewer,
            Some(json!({"deviceId": "d1"})),
        )
        .await;
    assert_eq!(s, 200);
    let source: String = sqlx::query_scalar(
        r#"SELECT source FROM watch_party_invitees WHERE "partyId" = $1 AND "userId" = 2"#,
    )
    .bind(id as i32)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    assert_eq!(source, "public");
    let (s, _) = c
        .call(
            "POST",
            &format!("{path}/join"),
            &outsider,
            Some(json!({"deviceId": "d1"})),
        )
        .await;
    assert_eq!(s, 404);

    let (s, _) = c
        .call("PATCH", &path, &viewer, Some(json!({"public": false})))
        .await;
    assert_eq!(s, 403);
    let (s, p) = c
        .call("PATCH", &path, &h, Some(json!({"public": false})))
        .await;
    assert_eq!((s, p["public"].clone()), (200, json!(false)));
    let (_, list) = c.call("GET", "/api/parties", &viewer, None).await;
    assert!(
        list.as_array().unwrap().is_empty(),
        "a public guest leaves with the party's openness"
    );
    let (s, _) = c.call("GET", &path, &viewer, None).await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn parties_manage_lists_edits_and_ends_any_party(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, h) = c.user("host", true).await;
    let (_, m) = c.user_with("mod", true, &["parties.manage"]).await;
    let (_, p) = c
        .call(
            "POST",
            "/api/parties",
            &h,
            Some(json!({"name": "n", "mediaId": 1})),
        )
        .await;
    let path = format!("/api/parties/{}", p["id"]);
    let (s, list) = c.call("GET", "/api/parties", &m, None).await;
    assert_eq!((s, list.as_array().unwrap().len()), (200, 1));
    let (s, _) = c.call("GET", &path, &m, None).await;
    assert_eq!(s, 200);
    let (s, p) = c
        .call("PATCH", &path, &m, Some(json!({"name": "renamed"})))
        .await;
    assert_eq!((s, p["name"].clone()), (200, json!("renamed")));
    let (s, _) = c.call("DELETE", &path, &m, None).await;
    assert_eq!(s, 204);
    let (_, list) = c.call("GET", "/api/parties", &h, None).await;
    assert!(list.as_array().unwrap().is_empty());
}

#[sqlx::test(migrations = false)]
async fn a_vote_a_switch_and_a_quit_post_their_chat_event(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 2).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let url = bare_party(&c, &a, &[bob]).await;
    let (_, l) = propose(&c, &url, &a, 2).await;
    let pid = proposal_of(&l, 2)["id"].as_i64().unwrap();
    let title = proposal_of(&l, 2)["item"]["title"].clone();
    let (s, _) = c
        .call(
            "PUT",
            &format!("{url}/proposals/{pid}/vote"),
            &b,
            Some(json!({"value": -1})),
        )
        .await;
    assert_eq!(s, 204);
    c.call("DELETE", &format!("{url}/proposals/{pid}/vote"), &b, None)
        .await;
    for body in [json!({"chatEnabled": false}), json!({"chatEnabled": false})] {
        let (s, _) = c.call("PATCH", &url, &a, Some(body)).await;
        assert_eq!(s, 200);
    }
    let (s, _) = c.call("POST", &format!("{url}/quit"), &b, None).await;
    assert_eq!(s, 204);

    let (_, p) = c.call("GET", &url, &a, None).await;
    let by_kind = |k: &str| -> Vec<Value> {
        systems(&p)
            .into_iter()
            .filter(|s| s.0 == k)
            .map(|s| s.1)
            .collect()
    };
    assert_eq!(
        by_kind("proposed"),
        [json!({"mediaId": 2, "episodeId": null, "count": 1, "title": title})]
    );
    assert_eq!(
        by_kind("voted"),
        [json!({"mediaId": 2, "episodeId": null, "value": -1, "title": title})],
        "clearing the vote posts nothing"
    );
    assert_eq!(
        by_kind("setting_changed"),
        [json!({"setting": "chatEnabled", "value": false})],
        "the second, identical patch changes nothing"
    );
    assert_eq!(by_kind("quit"), [json!({})]);
}

fn picture(format: image::ImageFormat) -> Vec<u8> {
    let mut out = std::io::Cursor::new(vec![]);
    image::RgbImage::from_pixel(4, 4, image::Rgb([9, 99, 199]))
        .write_to(&mut out, format)
        .unwrap();
    out.into_inner()
}

fn with_exif(jpeg: &[u8]) -> Vec<u8> {
    let exif = b"Exif\0\0GPS-secret";
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&[0xff, 0xe1]);
    out.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(exif);
    out.extend_from_slice(&jpeg[2..]);
    out
}

async fn put_cover(c: &Ctx, tok: &str, id: i64, mime: &str, data: &[u8]) -> (u16, Value) {
    let mut body = format!("--B\r\nContent-Disposition: form-data; name=\"file\"; filename=\"f.jpg\"\r\nContent-Type: {mime}\r\n\r\n").into_bytes();
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n--B--\r\n");
    let req = Request::post(format!("/api/parties/{id}/cover"))
        .header("authorization", format!("Bearer {tok}"))
        .header("content-type", "multipart/form-data; boundary=B")
        .body(Body::from(body))
        .unwrap();
    let res = c.app.clone().oneshot(req).await.unwrap();
    let s = res.status().as_u16();
    let b = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

#[sqlx::test(migrations = false)]
async fn a_cover_is_an_item_or_a_mosaic_of_programme_items_and_follows_the_programme(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 5).await;
    let (_, a) = c.user("alice", true).await;
    let (_, b) = c.user("bob", true).await;
    let items =
        json!([{"mediaId": 1}, {"mediaId": 2}, {"mediaId": 3}, {"mediaId": 4}, {"mediaId": 5}]);
    let (s, e) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "x", "items": items, "cover": {"kind": "item", "mediaId": 9}})),
        )
        .await;
    assert_eq!((s, msg(&e)), (400, Some("party.error_invalid_cover")));
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            &a,
            Some(json!({"name": "x", "items": items, "cover": {"kind": "item", "mediaId": 4}})),
        )
        .await;
    assert_eq!(s, 201);
    assert_eq!(p["cover"]["kind"], "item");
    assert_eq!(p["cover"]["item"]["mediaId"], 4);
    let url = format!("/api/parties/{}", p["id"]);

    let patch = |cover: Value| c.call("PATCH", &url, &a, Some(json!({ "cover": cover })));
    let m = |ids: &[i32]| json!({"kind": "mosaic", "items": ids.iter().map(|i| json!({"mediaId": i})).collect::<Vec<_>>()});
    for bad in [
        json!({"kind": "item", "mediaId": 9}),
        m(&[1]),
        m(&[1, 1]),
        m(&[1, 2, 3, 4, 5]),
        m(&[1, 9]),
        json!({"kind": "upload", "v": 1}),
    ] {
        let (s, e) = patch(bad.clone()).await;
        assert_eq!(
            (s, msg(&e)),
            (400, Some("party.error_invalid_cover")),
            "{bad}"
        );
    }
    let (s, p) = patch(m(&[1, 2, 3])).await;
    assert_eq!(s, 200);
    assert_eq!(p["cover"]["items"].as_array().unwrap().len(), 3);
    assert_eq!(
        systems(&p)
            .iter()
            .filter(|(k, _)| k == "cover_changed")
            .count(),
        1
    );
    let (s, _) = patch(m(&[1, 2, 3])).await;
    assert_eq!(s, 200);
    let (_, p) = c.call("GET", &url, &a, None).await;
    assert_eq!(
        systems(&p)
            .iter()
            .filter(|(k, _)| k == "cover_changed")
            .count(),
        1,
        "an unchanged cover posts nothing"
    );
    let (s, _) = c
        .call("PATCH", &url, &b, Some(json!({"cover": null})))
        .await;
    assert_eq!(s, 404, "a stranger cannot touch it");

    let programme = |ids: &[i32]| json!({"items": ids.iter().map(|i| json!({"mediaId": i})).collect::<Vec<_>>()});
    let (_, p) = c
        .call(
            "PUT",
            &format!("{url}/programme"),
            &a,
            Some(programme(&[1, 2, 4])),
        )
        .await;
    assert_eq!(p["cover"]["kind"], "mosaic");
    assert_eq!(p["cover"]["items"].as_array().unwrap().len(), 2);
    let (_, p) = c
        .call(
            "PUT",
            &format!("{url}/programme"),
            &a,
            Some(programme(&[2, 4])),
        )
        .await;
    assert_eq!(
        (&p["cover"]["kind"], &p["cover"]["item"]["mediaId"]),
        (&json!("item"), &json!(2))
    );
    let (_, p) = c
        .call(
            "PUT",
            &format!("{url}/programme"),
            &a,
            Some(programme(&[4])),
        )
        .await;
    assert_eq!(p["cover"], Value::Null);
    let (_, p) = patch(json!({"kind": "item", "mediaId": 4})).await;
    assert_eq!(p["cover"]["item"]["mediaId"], 4);
    let (_, p) = patch(Value::Null).await;
    assert_eq!(p["cover"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn an_uploaded_cover_is_deleted_on_reset_replacement_end_and_account_removal(pool: PgPool) {
    let dir = fliks_server::paths::data_dir().join("parties");
    let c = ctx(pool).await;
    let (_, a) = c.user("alice", true).await;
    let (owner, o) = c.user("owner", true).await;
    let create = |tok: String| {
        let c = &c;
        async move {
            let (_, p) = c
                .call(
                    "POST",
                    "/api/parties",
                    &tok,
                    Some(json!({"name": "x", "mediaId": 1})),
                )
                .await;
            p["id"].as_i64().unwrap()
        }
    };
    let (first, second, third) = (
        create(a.clone()).await,
        create(a.clone()).await,
        create(o.clone()).await,
    );
    let file = |p: &Value| {
        let url = p["cover"]["url"].as_str().unwrap();
        let key = url.rsplit('/').next().unwrap().split('?').next().unwrap();
        dir.join(format!("{key}.jpg"))
    };

    let jpeg = picture(image::ImageFormat::Jpeg);
    for junk in [&b"x"[..], b"<svg xmlns='http://www.w3.org/2000/svg'/>"] {
        assert_eq!(put_cover(&c, &a, first, "image/jpeg", junk).await.0, 400);
    }
    let (s, p) = put_cover(
        &c,
        &a,
        first,
        "image/png",
        &picture(image::ImageFormat::Png),
    )
    .await;
    assert_eq!(s, 200, "a PNG is accepted");
    let png_file = file(&p);
    let stored = std::fs::read(&png_file).unwrap();
    assert!(stored.starts_with(&[0xff, 0xd8]), "and stored as a JPEG");
    let (s, p2) = put_cover(
        &c,
        &a,
        first,
        "image/webp",
        &picture(image::ImageFormat::WebP),
    )
    .await;
    assert_eq!(s, 200, "a WebP too");
    assert!(
        !png_file.exists(),
        "a replacement removes the previous file"
    );
    let webp_file = file(&p2);
    assert!(webp_file.exists());
    let tagged = with_exif(&jpeg);
    assert!(tagged.windows(4).any(|w| w == b"Exif"));
    let (s, p) = put_cover(&c, &a, first, "image/jpeg", &tagged).await;
    assert_eq!(s, 200);
    let url = p["cover"]["url"].as_str().unwrap();
    let key = url.strip_prefix("/api/images/party/").unwrap();
    let key = key.split('?').next().unwrap();
    assert_eq!(key.len(), 22, "{url}");
    assert!(!url.contains(&format!("party/{first}?")), "{url}");
    let stored = std::fs::read(file(&p)).unwrap();
    assert!(stored.starts_with(&[0xff, 0xd8]));
    assert!(
        !stored.windows(4).any(|w| w == b"Exif"),
        "a JPEG is re-encoded, its metadata dropped"
    );
    let upload_file = file(&p);
    let (s, p) = c
        .call("DELETE", &format!("/api/parties/{first}/cover"), &a, None)
        .await;
    assert_eq!((s, &p["cover"]), (200, &Value::Null));
    assert!(!upload_file.exists());

    let (_, p) = put_cover(&c, &a, second, "image/jpeg", &jpeg).await;
    let second_file = file(&p);
    let (s, p) = c
        .call(
            "PATCH",
            &format!("/api/parties/{second}"),
            &a,
            Some(json!({"cover": {"kind": "item", "mediaId": 1}})),
        )
        .await;
    assert_eq!((s, &p["cover"]["kind"]), (200, &json!("item")));
    assert!(!second_file.exists(), "an item cover replaces the upload");

    let (_, p) = put_cover(&c, &a, second, "image/jpeg", &jpeg).await;
    let second_file = file(&p);
    let (s, _) = c
        .call("DELETE", &format!("/api/parties/{second}"), &a, None)
        .await;
    assert_eq!(s, 204);
    assert!(!second_file.exists(), "an ended party keeps no upload");
    let (_, p) = c
        .call("GET", &format!("/api/parties/{second}"), &a, None)
        .await;
    assert_eq!(p["cover"], Value::Null);

    let (_, p) = put_cover(&c, &o, third, "image/jpeg", &jpeg).await;
    let third_file = file(&p);
    assert!(third_file.exists());
    let users = users::router().with_state(c.st.clone());
    let (_, admin) = c.user_with("admin", false, &["users.manage"]).await;
    let res = users
        .oneshot(
            Request::delete(format!("/api/users/{owner}"))
                .header("authorization", format!("Bearer {admin}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert!(
        !third_file.exists(),
        "the owner's account takes the file along"
    );
}

#[sqlx::test(migrations = false)]
async fn choosing_an_episode_proposal_fills_an_empty_programme_and_starts_on_it(pool: PgPool) {
    let c = ctx(pool).await;
    series_setup(&c).await;
    let (_, a) = c.user("alice", true).await;
    let url = bare_party(&c, &a, &[]).await;
    let (s, l) = c
        .call(
            "POST",
            &format!("{url}/proposals"),
            &a,
            Some(json!({"mediaId": 2, "episodeId": 3})),
        )
        .await;
    assert_eq!(s, 201, "{l}");
    let pid = l[0]["id"].as_i64().unwrap();
    let (s, p) = c
        .call("POST", &format!("{url}/proposals/{pid}/choose"), &a, None)
        .await;
    assert_eq!(s, 200, "{p}");
    assert_eq!(
        (&p["item"]["mediaId"], &p["item"]["episodeId"]),
        (&json!(2), &json!(3))
    );
    let (s, p) = c.call("POST", &format!("{url}/start"), &a, None).await;
    assert_eq!(s, 200, "{p}");
    assert_eq!(p["item"]["episodeId"], 3);
}

#[sqlx::test(migrations = false)]
async fn a_repeated_vote_posts_once_and_votes_are_rate_limited(pool: PgPool) {
    let c = ctx(pool).await;
    more_media(&c, 2).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let url = bare_party(&c, &a, &[bob]).await;
    let (_, l) = propose(&c, &url, &a, 2).await;
    let pid = proposal_of(&l, 2)["id"].as_i64().unwrap();
    let vote = format!("{url}/proposals/{pid}/vote");
    for _ in 0..3 {
        let (s, _) = c.call("PUT", &vote, &b, Some(json!({"value": 1}))).await;
        assert_eq!(s, 204);
    }
    let (_, p) = c.call("GET", &url, &a, None).await;
    let voted = systems(&p).into_iter().filter(|s| s.0 == "voted").count();
    assert_eq!(voted, 1, "a vote that changes nothing posts nothing");
    let mut last = 204;
    for _ in 0..12 {
        last = c.call("DELETE", &vote, &b, None).await.0;
    }
    assert_eq!(last, 429);
}

#[sqlx::test(migrations = false)]
async fn a_patch_with_a_bad_field_writes_nothing_and_a_new_token_revokes_public_guests(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let (_, h) = c.user("host", true).await;
    let (viewer_id, viewer) = c.user_with("viewer", true, &["parties.read_public"]).await;
    let (s, p) = c
        .call(
            "POST",
            "/api/parties",
            &h,
            Some(json!({"name": "n", "mediaId": 1, "public": true})),
        )
        .await;
    assert_eq!(s, 201);
    let id = p["id"].as_i64().unwrap();
    let path = format!("/api/parties/{id}");
    let cover = json!({"kind": "item", "mediaId": 1});
    let (s, _) = c
        .call(
            "PATCH",
            &path,
            &h,
            Some(json!({"name": "", "cover": cover.clone()})),
        )
        .await;
    assert_eq!(s, 400);
    let (s, _) = c.call("POST", &format!("{path}/start"), &h, None).await;
    assert_eq!(s, 200);
    let (s, _) = c
        .call(
            "PATCH",
            &path,
            &h,
            Some(json!({"scheduledAt": "2999-01-01T00:00:00Z", "cover": cover})),
        )
        .await;
    assert_eq!(s, 409, "a start date on a party that has started");
    let (_, p) = c.call("GET", &path, &h, None).await;
    assert_eq!(
        (p["name"].clone(), p["cover"].clone()),
        (json!("n"), Value::Null)
    );

    let _conn = c.connect(viewer_id, "d1");
    let (s, _) = c
        .call(
            "POST",
            &format!("{path}/join"),
            &viewer,
            Some(json!({"deviceId": "d1"})),
        )
        .await;
    assert_eq!(s, 200);
    let (s, _) = c
        .call("PATCH", &path, &h, Some(json!({"regenerateToken": true})))
        .await;
    assert_eq!(s, 200);
    let (_, p) = c.call("GET", &path, &h, None).await;
    assert_eq!(p["guests"], json!([]));
    assert_eq!(p["live"]["members"].as_array().unwrap().len(), 0);
}

#[sqlx::test(migrations = false)]
async fn a_transferred_host_role_survives_a_restart(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let url = format!("/api/parties/{id}");
    let _ca = c.connect(alice, "da");
    let _cb = c.connect(bob, "db");
    for (t, d) in [(&a, "da"), (&b, "db")] {
        let body = Some(json!({"deviceId": d}));
        c.call("POST", &format!("{url}/join"), t, body).await;
    }
    let (s, _) = c
        .call("POST", &format!("{url}/members/{bob}/host"), &a, None)
        .await;
    assert_eq!(s, 204);
    let mut st = c.st.clone();
    st.parties = party::Parties::default();
    party::boot(&st).await.unwrap();
    assert_eq!(st.parties.view(id as i32).unwrap().host_id, bob);
}

#[sqlx::test(migrations = false)]
async fn an_ended_party_gets_no_machine_back_from_a_quit(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let (bob, b) = c.user("bob", true).await;
    c.follow(alice, bob).await;
    let id = party_with(&c, &a, vec![bob]).await;
    let url = format!("/api/parties/{id}");
    let (s, _) = c.call("DELETE", &url, &a, None).await;
    assert_eq!(s, 204);
    let (s, e) = c.call("POST", &format!("{url}/quit"), &b, None).await;
    assert_eq!((s, msg(&e)), (409, Some("party.error_ended")));
    assert!(c.st.parties.view(id as i32).is_none());
}

#[sqlx::test(migrations = false)]
async fn removing_the_playing_media_ends_the_party_for_its_members(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c.user("alice", true).await;
    let _ca = c.connect(alice, "da");
    let mut sa = c.stream(&a, "da#tab").await;
    let id = party_with(&c, &a, vec![]).await;
    let url = format!("/api/parties/{id}");
    let body = Some(json!({"deviceId": "da"}));
    c.call("POST", &format!("{url}/join"), &a, body).await;
    let guard = c.st.ingest.media.lock(1).await;
    fliks_server::media::write::remove_media(&c.st, &guard, 1)
        .await
        .unwrap();
    drop(guard);
    let closed = events_of(&mut sa, "party.closed").await;
    assert_eq!(closed.len(), 1);
    assert!(c.st.parties.view(id as i32).is_none());
}

#[sqlx::test(migrations = false)]
async fn a_type_change_that_drops_the_playing_item_ends_the_party_for_its_members(pool: PgPool) {
    let c = ctx(pool).await;
    let (alice, a) = c
        .user_with("alice", true, &["parties.create", "media.edit"])
        .await;
    let _ca = c.connect(alice, "da");
    let mut sa = c.stream(&a, "da#tab").await;
    let id = party_with(&c, &a, vec![]).await;
    c.call(
        "POST",
        &format!("/api/parties/{id}/join"),
        &a,
        Some(json!({"deviceId": "da"})),
    )
    .await;
    let full = fliks_server::app::router(c.st.clone(), None, "/nonexistent".into(), None);
    let req = Request::builder()
        .method("PUT")
        .uri("/api/media/1")
        .header("authorization", format!("Bearer {a}"))
        .header("content-type", "application/json")
        .body(Body::from(json!({"type": "series"}).to_string()))
        .unwrap();
    assert_eq!(full.oneshot(req).await.unwrap().status().as_u16(), 200);
    assert_eq!(events_of(&mut sa, "party.closed").await.len(), 1);
    assert!(c.st.parties.view(id as i32).is_none());
}

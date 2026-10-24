//! `/api/parties` and `/api/time` (`docs/spec/watch-party.md`): access, invitations, stale intents, schedule.
use axum::{Router, body::Body, http::Request};
use fliks_server::{
    config::Config,
    events::{self, Connection, Identity},
    party,
    state::AppState,
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
        events: events::router().with_state(st.clone()),
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
    assert_eq!(p["live"]["state"], "idle");
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
    assert_eq!(p["live"], Value::Null);
    let (s, p) = c
        .call(
            "PATCH",
            &format!("/api/parties/{id}"),
            &a,
            Some(json!({"scheduledAt": at(-5)})),
        )
        .await;
    assert_eq!((s, p["live"]["state"].clone()), (200, json!("idle")));
    assert_eq!(events_of(&mut sb, "party.starting").await.len(), 1);
    let (s, p) = c
        .call("POST", &format!("/api/parties/{id}/start"), &a, None)
        .await;
    assert_eq!((s, p["status"].clone()), (200, json!("live")));
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
    let sig = json!({"deviceId": "da", "to": "db", "kind": "offer", "data": {"sdp": "x"}});
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

    let big =
        json!({"deviceId": "da", "to": "db", "kind": "ice", "data": {"x": "y".repeat(17_000)}});
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

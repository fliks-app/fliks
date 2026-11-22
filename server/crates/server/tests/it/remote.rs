//! `/api/remote/*`: grants lifecycle and `canControl` outcomes on a fresh database.
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::sync::MutexExt;
use fliks_server::{config::Config, events::SseEvent, remote, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    Ctx {
        app: remote::router().with_state(st.clone()),
        st,
        pool,
    }
}

impl Ctx {
    async fn user(&self, name: &str, admin: bool) -> (i32, String) {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin") VALUES ($1, $2) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        (id, session::token(&self.st, id, name).await)
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

    async fn register(&self, token: &str, device: &str) {
        let (s, _) = self
            .call(
                "POST",
                "/api/remote/register",
                token,
                Some(json!({"deviceId": device})),
            )
            .await;
        assert_eq!(s, 201);
    }
}

#[sqlx::test(migrations = false)]
async fn grant_lifecycle_and_control(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user("a", false).await;
    let (_, b) = c.user("b", false).await;
    let (_, admin) = c.user("root", true).await;
    c.register(&a, "d1").await;
    let play = || Some(json!({"action": "play"}));
    let url = "/api/remote/d1%23native/command";

    let (s, body) = c.call("POST", url, &b, play()).await;
    assert_eq!(
        (s, body["message"].as_str()),
        (404, Some("remote.error_device_offline"))
    );

    let (s, code) = c
        .call(
            "POST",
            "/api/remote/grants/code",
            &a,
            Some(json!({"deviceId": "d1", "deviceName": "TV"})),
        )
        .await;
    assert_eq!((s, code["expiresIn"].as_i64()), (201, Some(600)));
    let code = code["code"].as_str().unwrap().to_lowercase();
    assert_eq!(code.len(), 6);

    let claim = Some(json!({"code": format!(" {code} ")}));
    let (s, g) = c
        .call("POST", "/api/remote/grants/claim", &b, claim.clone())
        .await;
    assert_eq!(
        (
            s,
            g["ownerUsername"].as_str(),
            g["granteeUsername"].as_str()
        ),
        (201, Some("a"), Some("b"))
    );
    let (s, _) = c.call("POST", "/api/remote/grants/claim", &b, claim).await;
    assert_eq!(s, 404);

    let (_, t) = c.call("GET", "/api/remote/targets", &b, None).await;
    assert_eq!(t[0]["targetId"], "d1#native");
    assert_eq!(t[0]["ownerUsername"], "a");
    let (s, _) = c.call("POST", url, &b, play()).await;
    assert_eq!(s, 202);
    let (s, _) = c.call("POST", url, &admin, play()).await;
    assert_eq!(s, 202);
    let (s, q) = c
        .call("GET", "/api/remote/commands?targetId=d1%23native", &a, None)
        .await;
    assert_eq!((s, q.as_array().map(Vec::len)), (200, Some(2)));

    let (_, list) = c.call("GET", "/api/remote/grants", &b, None).await;
    let id = list["held"][0]["id"].as_i64().unwrap();
    let (s, _) = c
        .call("DELETE", &format!("/api/remote/grants/{id}"), &b, None)
        .await;
    assert_eq!(s, 204);
    let (s, body) = c.call("POST", url, &b, play()).await;
    assert_eq!(
        (s, body["message"].as_str()),
        (404, Some("remote.error_device_offline"))
    );
}

#[sqlx::test(migrations = false)]
async fn denied_without_grant_or_when_owner_disabled(pool: PgPool) {
    let c = ctx(pool).await;
    let (a_id, a) = c.user("a", false).await;
    let (_, b) = c.user("b", false).await;
    c.register(&a, "d1").await;
    let (_, code) = c
        .call(
            "POST",
            "/api/remote/grants/code",
            &a,
            Some(json!({"deviceId": "d1", "deviceName": "TV"})),
        )
        .await;
    c.call(
        "POST",
        "/api/remote/grants/claim",
        &b,
        Some(json!({"code": code["code"]})),
    )
    .await;
    sqlx::query("UPDATE users SET enabled = false WHERE id = $1")
        .bind(a_id)
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, t) = c.call("GET", "/api/remote/targets", &b, None).await;
    assert_eq!(t, json!([]));
    let (s, body) = c
        .call(
            "POST",
            "/api/remote/d1%23native/command",
            &b,
            Some(json!({"action": "play"})),
        )
        .await;
    assert_eq!(
        (s, body["message"].as_str()),
        (403, Some("remote.error_target_disabled"))
    );
}

#[sqlx::test(migrations = false)]
async fn polled_targets_are_per_user_and_missing_target_id_is_400(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user("a", false).await;
    let (_, b) = c.user("b", false).await;
    c.register(&a, "d1").await;
    c.register(&b, "d1").await;
    let url = "/api/remote/d1%23native/command";
    let (s, _) = c
        .call("POST", url, &a, Some(json!({"action": "play"})))
        .await;
    assert_eq!(s, 202);
    let (_, q) = c
        .call("GET", "/api/remote/commands?targetId=d1%23native", &b, None)
        .await;
    assert_eq!(q, json!([]));
    let (_, q) = c
        .call("GET", "/api/remote/commands?targetId=d1%23native", &a, None)
        .await;
    assert_eq!(q[0]["type"], "remote.command");
    let (s, _) = c.call("GET", "/api/remote/commands", &a, None).await;
    assert_eq!(s, 400);
    let (s, _) = c
        .call(
            "POST",
            url,
            &a,
            Some(json!({"action": "volume", "level": 5})),
        )
        .await;
    assert_eq!(s, 400);
    let (s, body) = c
        .call(
            "POST",
            url,
            &a,
            Some(json!({"action": "play", "byTargetId": "d1#native"})),
        )
        .await;
    assert_eq!(
        (s, body["message"].as_str()),
        (400, Some("remote.error_self_target"))
    );
}

#[sqlx::test(migrations = false)]
async fn load_command_relays_paused(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user("a", false).await;
    c.register(&a, "d1").await;
    let load = json!({"action": "load", "mediaFileId": 1, "paused": true});
    let (s, _) = c
        .call("POST", "/api/remote/d1%23native/command", &a, Some(load))
        .await;
    assert_eq!(s, 202);
    let (_, cmds) = c
        .call("GET", "/api/remote/commands?targetId=d1%23native", &a, None)
        .await;
    assert_eq!(cmds[0]["paused"], true);
}

#[sqlx::test(migrations = false)]
async fn karaoke_is_refused_by_a_target_that_did_not_declare_it(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user("a", false).await;
    let register = |device: &'static str, actions: Value| {
        let body = json!({"deviceId": device, "actions": actions});
        c.call("POST", "/api/remote/register", &a, Some(body))
    };
    assert_eq!(register("d1", json!(["play", "seek"])).await.0, 201);
    assert_eq!(register("d2", json!(["play", "karaoke"])).await.0, 201);
    let karaoke = json!({"action": "karaoke", "stemMode": "guide", "level": 0.5, "pitch": 2});
    let (s, body) = c
        .call(
            "POST",
            "/api/remote/d1%23native/command",
            &a,
            Some(karaoke.clone()),
        )
        .await;
    assert_eq!(s, 409, "{body}");
    assert_eq!(body["message"], "remote.error_unsupported_action");
    let url = "/api/remote/d2%23native/command";
    assert_eq!(c.call("POST", url, &a, Some(karaoke)).await.0, 202);
    let (s, _) = c
        .call("POST", url, &a, Some(json!({"action": "karaoke"})))
        .await;
    assert_eq!(s, 400);
    let (s, _) = c
        .call(
            "POST",
            url,
            &a,
            Some(json!({"action": "karaoke", "pitch": 13})),
        )
        .await;
    assert_eq!(s, 400);
    let (_, cmds) = c
        .call("GET", "/api/remote/commands?targetId=d2%23native", &a, None)
        .await;
    assert_eq!(
        (
            cmds[0]["stemMode"].clone(),
            cmds[0]["level"].clone(),
            cmds[0]["pitch"].clone()
        ),
        (json!("guide"), json!(0.5), json!(2))
    );
}

#[sqlx::test(migrations = false)]
async fn load_without_kind_gets_the_media_kind(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user("a", false).await;
    c.register(&a, "d1").await;
    sqlx::raw_sql(
        r#"INSERT INTO libraries (name) VALUES ('fixture');
           INSERT INTO library_folders ("libraryId", path) SELECT id, '/fixture' FROM libraries"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    let media: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, type, "libraryId") VALUES ('a', 'album', (SELECT min(id) FROM libraries)) RETURNING id"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let file: i32 = sqlx::query_scalar(
        r#"INSERT INTO media_files ("relativePath", size, quality, "mediaId", "folderId") VALUES ('x', 1, 'q', $1, (SELECT min(id) FROM library_folders)) RETURNING id"#,
    )
    .bind(media)
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let url = "/api/remote/d1%23native/command";
    let sent = |body| c.call("POST", url, &a, Some(body));
    let (s, _) = sent(json!({"action": "load", "mediaFileId": file, "mediaId": media})).await;
    assert_eq!(s, 202);
    let (s, _) = sent(json!({"action": "load", "mediaFileId": file, "kind": "movie"})).await;
    assert_eq!(s, 202);
    let (_, cmds) = c
        .call("GET", "/api/remote/commands?targetId=d1%23native", &a, None)
        .await;
    assert_eq!(cmds[0]["kind"], "album");
    assert_eq!(cmds[1]["kind"], "movie");
}

impl Ctx {
    async fn mint(&self, token: &str, device: &str) -> String {
        let (s, code) = self
            .call(
                "POST",
                "/api/remote/grants/code",
                token,
                Some(json!({"deviceId": device, "deviceName": "TV"})),
            )
            .await;
        assert_eq!(s, 201);
        code["code"].as_str().unwrap().to_owned()
    }

    async fn claim(&self, token: &str, code: &str) -> u16 {
        let body = Some(json!({"code": code}));
        self.call("POST", "/api/remote/grants/claim", token, body)
            .await
            .0
    }
}

#[sqlx::test(migrations = false)]
async fn failed_claims_lock_the_claimer_out_even_for_the_right_code(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, owner) = c.user("owner", false).await;
    let (_, thief) = c.user("thief", false).await;
    let (_, guest) = c.user("guest", false).await;
    let code = c.mint(&owner, "d1").await;
    for _ in 0..5 {
        assert_eq!(c.claim(&thief, "ZZZZZZ").await, 404);
    }
    assert_eq!(c.claim(&thief, &code).await, 429);
    assert_eq!(c.claim(&guest, &code).await, 201);
}

#[sqlx::test(migrations = false)]
async fn a_claim_that_finds_its_code_is_not_counted_as_a_failure(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, owner) = c.user("owner", false).await;
    let (_, guest) = c.user("guest", false).await;
    for _ in 0..4 {
        assert_eq!(c.claim(&guest, "ZZZZZZ").await, 404);
    }
    for device in ["d1", "d2", "d3"] {
        let code = c.mint(&owner, device).await;
        assert_eq!(c.claim(&guest, &code).await, 201);
    }
}

fn state(target_id: &str) -> SseEvent {
    serde_json::from_value(
        json!({"type":"remote.state","targetId":target_id,"sessionId":"s",
        "mediaId":null,"mediaFileId":1,"episodeId":null,"mediaTitle":null,"episodeLabel":null,
        "posterUrl":null,"fanartUrl":null,"positionSeconds":1,"durationSeconds":2,
        "state":"playing","volume":null,"muted":null,"supportsVolume":true,"subtitleId":null,
        "quality":null,"qualities":null,"autoplayBlocked":false,"hasNext":false,
        "audioTrackIndex":null,"subtitleTrackIndex":null,"lastCmdId":null}),
    )
    .unwrap()
}

async fn reached(seen: &Mutex<Vec<i32>>, user: i32) {
    for _ in 0..200 {
        if seen.lock_clean().contains(&user) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("user {user} never received the frame");
}

#[sqlx::test(migrations = false)]
async fn a_revoked_grantee_gets_no_state_frame_after_the_revoke(pool: PgPool) {
    let c = ctx(pool).await;
    remote::init(&c.st);
    let seen: Arc<Mutex<Vec<i32>>> = Arc::default();
    let sink = seen.clone();
    c.st.hub.register_users_hook(move |ev, users| {
        if matches!(ev, SseEvent::RemoteState { .. }) {
            sink.lock_clean().extend(users);
        }
    });
    let (owner, owner_token) = c.user("owner", false).await;
    let (gone, gone_token) = c.user("gone", false).await;
    let (kept, kept_token) = c.user("kept", false).await;
    for token in [&gone_token, &kept_token] {
        let code = c.mint(&owner_token, "d1").await;
        assert_eq!(c.claim(token, &code).await, 201);
    }
    c.st.hub.emit_to_user(owner, state("d1#tab"));
    reached(&seen, gone).await;
    reached(&seen, kept).await;

    let (_, list) = c.call("GET", "/api/remote/grants", &gone_token, None).await;
    let id = list["held"][0]["id"].as_i64().unwrap();
    let uri = format!("/api/remote/grants/{id}");
    assert_eq!(c.call("DELETE", &uri, &owner_token, None).await.0, 204);
    seen.lock_clean().clear();
    c.st.hub.emit_to_user(owner, state("d1#tab"));
    reached(&seen, kept).await;
    assert!(!seen.lock_clean().contains(&gone));
}

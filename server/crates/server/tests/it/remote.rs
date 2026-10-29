//! `/api/remote/*`: grants lifecycle and `canControl` outcomes on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, remote, state::AppState};
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
        (id, self.st.jwt.sign_access(id, name).unwrap().token)
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

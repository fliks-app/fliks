//! `/api/device-tokens`: lifecycle, ownership and the hash at rest on a fresh database.
use axum::{Router, body::Body, http::Request};
use fliks_engine_core::api::ResolveCredentialSource::Basic;
use fliks_server::{config::Config, device_tokens, state::AppState};
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
        app: device_tokens::router().with_state(st.clone()),
        st,
        pool,
    }
}

impl Ctx {
    async fn user(&self, name: &str) -> (i32, String) {
        let id: i32 =
            sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ($1) RETURNING id"#)
                .bind(name)
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

    async fn owner_of(&self, token: &str) -> Option<i32> {
        device_tokens::lookup(&self.pool, token, Basic)
            .await
            .unwrap()
    }
}

#[sqlx::test(migrations = false)]
async fn a_token_is_shown_once_and_stored_as_a_hash(pool: PgPool) {
    let c = ctx(pool).await;
    let (uid, jwt) = c.user("a").await;
    let (s, made) = c
        .call(
            "POST",
            "/api/device-tokens",
            &jwt,
            Some(json!({"name": " Kobo ", "kind": "opds"})),
        )
        .await;
    assert_eq!(s, 201);
    let token = made["token"].as_str().unwrap().to_owned();
    assert!(device_tokens::well_formed(&token));
    assert_eq!(
        (made["name"].as_str(), made["kind"].as_str()),
        (Some("Kobo"), Some("opds"))
    );
    let stored: String = sqlx::query_scalar(r#"SELECT hash FROM device_tokens"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(stored, device_tokens::hash(&token));
    assert!(!stored.contains(&token));
    let (s, list) = c.call("GET", "/api/device-tokens", &jwt, None).await;
    assert_eq!(s, 200);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert!(list[0].get("token").is_none() && list[0].get("hash").is_none());
    assert_eq!(list[0]["lastUsedAt"], Value::Null);
    assert_eq!(c.owner_of(&token).await, Some(uid));
    let (_, list) = c.call("GET", "/api/device-tokens", &jwt, None).await;
    assert!(list[0]["lastUsedAt"].is_string(), "a hit stamps lastUsedAt");
}

#[sqlx::test(migrations = false)]
async fn a_kosync_token_hashes_its_md5_and_never_opens_the_data_plane(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, jwt) = c.user("a").await;
    let (_, made) = c
        .call(
            "POST",
            "/api/device-tokens",
            &jwt,
            Some(json!({"name": "KOReader", "kind": "kosync"})),
        )
        .await;
    let token = made["token"].as_str().unwrap();
    let stored: String = sqlx::query_scalar(r#"SELECT hash FROM device_tokens"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_ne!(stored, device_tokens::hash(token));
    assert_eq!(c.owner_of(token).await, None);
}

#[sqlx::test(migrations = false)]
async fn validation_and_the_per_user_cap(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, jwt) = c.user("a").await;
    for (body, msg) in [
        (
            json!({"name": "  ", "kind": "opds"}),
            "name should not be empty",
        ),
        (
            json!({"name": "x".repeat(81), "kind": "opds"}),
            "name must be shorter than or equal to 80 characters",
        ),
        (
            json!({"name": "x", "kind": "nope"}),
            "kind must be one of the following values: opds, kosync, kobo",
        ),
    ] {
        let (s, b) = c.call("POST", "/api/device-tokens", &jwt, Some(body)).await;
        assert_eq!((s, b["message"][0].as_str()), (400, Some(msg)));
    }
    let (s, _) = c
        .call(
            "POST",
            "/api/device-tokens",
            &jwt,
            Some(json!({"name": "x", "kind": "opds", "hash": "h"})),
        )
        .await;
    assert_eq!(s, 400, "unknown keys");
    for i in 0..20 {
        let (s, _) = c
            .call(
                "POST",
                "/api/device-tokens",
                &jwt,
                Some(json!({"name": format!("d{i}"), "kind": "opds"})),
            )
            .await;
        assert_eq!(s, 201);
    }
    let (s, b) = c
        .call(
            "POST",
            "/api/device-tokens",
            &jwt,
            Some(json!({"name": "one more", "kind": "opds"})),
        )
        .await;
    assert_eq!(
        (s, b["message"].as_str()),
        (400, Some("device_tokens.error_too_many"))
    );
    let (_, other) = c.user("b").await;
    let (s, _) = c
        .call(
            "POST",
            "/api/device-tokens",
            &other,
            Some(json!({"name": "mine", "kind": "opds"})),
        )
        .await;
    assert_eq!(s, 201, "the cap is per user");
}

#[sqlx::test(migrations = false)]
async fn renew_replaces_the_token_and_revoke_ends_it(pool: PgPool) {
    let c = ctx(pool).await;
    let (uid, jwt) = c.user("a").await;
    let (_, made) = c
        .call(
            "POST",
            "/api/device-tokens",
            &jwt,
            Some(json!({"name": "Kobo", "kind": "opds"})),
        )
        .await;
    let (id, old) = (
        made["id"].as_i64().unwrap(),
        made["token"].as_str().unwrap().to_owned(),
    );
    assert_eq!(c.owner_of(&old).await, Some(uid));
    let (s, renewed) = c
        .call(
            "POST",
            &format!("/api/device-tokens/{id}/renew"),
            &jwt,
            None,
        )
        .await;
    assert_eq!(s, 201);
    let new = renewed["token"].as_str().unwrap().to_owned();
    assert_ne!(new, old);
    assert_eq!(
        (renewed["id"].as_i64(), renewed["name"].as_str()),
        (Some(id), Some("Kobo"))
    );
    assert_eq!(renewed["lastUsedAt"], Value::Null);
    assert_eq!(c.owner_of(&old).await, None, "the old token stops at once");
    assert_eq!(c.owner_of(&new).await, Some(uid));
    let (s, _) = c
        .call("DELETE", &format!("/api/device-tokens/{id}"), &jwt, None)
        .await;
    assert_eq!(s, 204);
    assert_eq!(
        c.owner_of(&new).await,
        None,
        "a revoked token stops at once"
    );
    let (s, _) = c
        .call("DELETE", &format!("/api/device-tokens/{id}"), &jwt, None)
        .await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn a_token_is_its_owners_alone_and_manages_nothing(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, a) = c.user("a").await;
    let (_, b) = c.user("b").await;
    let (_, made) = c
        .call(
            "POST",
            "/api/device-tokens",
            &a,
            Some(json!({"name": "Kobo", "kind": "opds"})),
        )
        .await;
    let id = made["id"].as_i64().unwrap();
    for (m, uri) in [
        ("POST", format!("/api/device-tokens/{id}/renew")),
        ("DELETE", format!("/api/device-tokens/{id}")),
    ] {
        let (s, b_) = c.call(m, &uri, &b, None).await;
        assert_eq!(
            (s, b_["message"].as_str()),
            (404, Some("device_tokens.error_unknown")),
            "{m}"
        );
    }
    let (_, list) = c.call("GET", "/api/device-tokens", &b, None).await;
    assert_eq!(list, json!([]));
    let stream = c.st.jwt.sign_stream(1, "a").unwrap().token;
    let (s, _) = c.call("GET", "/api/device-tokens", &stream, None).await;
    assert_eq!(s, 403, "a scoped token");
    let (s, _) = c.call("GET", "/api/device-tokens", "", None).await;
    assert_eq!(s, 401);
}

#[sqlx::test(migrations = false)]
async fn deleting_the_user_deletes_the_tokens(pool: PgPool) {
    let c = ctx(pool).await;
    let (uid, jwt) = c.user("a").await;
    c.call(
        "POST",
        "/api/device-tokens",
        &jwt,
        Some(json!({"name": "Kobo", "kind": "opds"})),
    )
    .await;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(uid)
        .execute(&c.pool)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM device_tokens")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

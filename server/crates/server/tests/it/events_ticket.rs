//! `POST /api/system/events/ticket`: a single-use URL credential for `GET /api/system/events`.
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, events, state::AppState};
use serde_json::Value;
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
        app: events::router().with_state(st.clone()),
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

    async fn call(&self, method: &str, uri: &str, bearer: Option<&str>) -> (u16, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        if let Some(t) = bearer {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        let res = self
            .app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        if status != 201 {
            return (status, Value::Null);
        }
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn ticket(&self, token: &str) -> String {
        let (s, b) = self
            .call("POST", "/api/system/events/ticket", Some(token))
            .await;
        assert_eq!((s, b["expiresIn"].as_u64()), (201, Some(30)));
        b["ticket"].as_str().unwrap().to_owned()
    }
}

#[sqlx::test(migrations = false)]
async fn a_ticket_opens_the_stream_once(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, token) = c.user("ana").await;
    let uri = format!(
        "/api/system/events?device=d&ticket={}",
        c.ticket(&token).await
    );
    assert_eq!(c.call("GET", &uri, None).await.0, 200);
    assert_eq!(c.call("GET", &uri, None).await.0, 401, "second use");
}

#[sqlx::test(migrations = false)]
async fn a_ticket_that_is_unknown_or_of_a_disabled_user_is_refused(pool: PgPool) {
    let c = ctx(pool).await;
    let (id, token) = c.user("ana").await;
    let ticket = c.ticket(&token).await;
    sqlx::query("UPDATE users SET enabled = false WHERE id = $1")
        .bind(id)
        .execute(&c.pool)
        .await
        .unwrap();
    let uri = |t: &str| format!("/api/system/events?ticket={t}");
    assert_eq!(c.call("GET", &uri(&ticket), None).await.0, 401);
    assert_eq!(c.call("GET", &uri("nope"), Some(&token)).await.0, 401);
}

#[sqlx::test(migrations = false)]
async fn minting_needs_a_session_token(pool: PgPool) {
    let c = ctx(pool).await;
    let (id, _) = c.user("ana").await;
    let stream = c.st.jwt.sign_stream(id, "ana").unwrap().token;
    let uri = "/api/system/events/ticket";
    assert_eq!(c.call("POST", uri, Some(&stream)).await.0, 403);
    assert_eq!(c.call("POST", uri, None).await.0, 401);
}

#[sqlx::test(migrations = false)]
async fn the_session_token_still_opens_the_stream_for_released_clients(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, token) = c.user("ana").await;
    assert_eq!(
        c.call("GET", "/api/system/events", Some(&token)).await.0,
        200
    );
    let query = format!("/api/system/events?token={token}");
    assert_eq!(c.call("GET", &query, None).await.0, 200);
    assert_eq!(c.call("GET", "/api/system/events", None).await.0, 401);
}

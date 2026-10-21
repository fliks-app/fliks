//! `POST /api/cleanup/candidates/bulk` authorisation and per-item results (`docs/spec/cleanup.md` rule 29).
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

/// Token 0 is an admin, token 1 a plain user; one movie in library 1, both users see the library.
async fn ctx(pool: &PgPool) -> (Router, Vec<String>) {
    fliks_server::db::migrate(pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let mut tokens = vec![];
    for (name, admin) in [("a", true), ("b", false)] {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin") VALUES ($1, $2) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .fetch_one(pool)
        .await
        .unwrap();
        tokens.push(st.jwt.sign_access(id, name).unwrap().token);
    }
    for q in [
        r#"INSERT INTO libraries (name) VALUES ('l')"#,
        r#"INSERT INTO media (title, type, "libraryId") VALUES ('movie', 'movie', 1)"#,
        r#"INSERT INTO library_user_access ("userId", "libraryId") SELECT id, 1 FROM users"#,
    ] {
        sqlx::query(q).execute(pool).await.unwrap();
    }
    (app::router(st, None, "/nonexistent".into(), None), tokens)
}

async fn bulk(app: &Router, token: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method("POST")
        .uri("/api/cleanup/candidates/bulk")
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

#[sqlx::test]
async fn bulk_checks_permissions_and_reports_each_item(pool: PgPool) {
    let (app, t) = ctx(&pool).await;
    let items = json!([{"mediaId": 1}]);
    for action in ["delete-now", "keep"] {
        let (s, _) = bulk(&app, &t[1], json!({"action": action, "items": items})).await;
        assert_eq!(s, 403, "{action} without the permission");
    }
    let (s, b) = bulk(
        &app,
        &t[0],
        json!({"action": "delete-now", "items": [{"mediaId": 1}, {"mediaId": 99}]}),
    )
    .await;
    assert_eq!(s, 200);
    let r = &b["results"];
    assert_eq!(
        (r[0]["ok"].clone(), r[1]["ok"].clone()),
        (json!(false), json!(false))
    );
    assert!(
        r[0]["error"]
            .as_str()
            .unwrap()
            .contains("not a cleanup candidate")
    );
    assert_eq!(r[1]["mediaId"], 99);
    let (s, _) = bulk(&app, &t[0], json!({"action": "keep", "items": []})).await;
    assert_eq!(s, 400);
    let (s, b) = bulk(
        &app,
        &t[0],
        json!({"action": "keep", "items": [{"mediaId": 1}]}),
    )
    .await;
    assert_eq!((s, b["results"][0]["ok"].clone()), (200, json!(true)));
}

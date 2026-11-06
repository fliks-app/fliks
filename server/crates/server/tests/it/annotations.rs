//! Reader annotations (`docs/spec/annotations.md`).
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{annotations, config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

/// Users 1 admin, 2 and 3 plain readers of library 1. Items: 1 a text item of library 1, 2 a text item of
/// library 2 (unreadable by 2 and 3), 3 an audio item of library 1.
async fn ctx(pool: PgPool) -> (Router, Vec<String>) {
    fliks_server::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false), (2, 'None', '[]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'a', false, 1), (3, 'b', false, 1), (4, 'none', false, 2);
        INSERT INTO libraries (id, name) VALUES (1, 'L1'), (2, 'L2');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2), (1, 3), (1, 4);
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (10, 'Alpha', 'book', 1, 'a'), (11, 'Beta', 'book', 2, 'b');
        INSERT INTO editions (id, "mediaId", family, format, "libraryId") VALUES (1, 10, 'text', 'epub', NULL), (2, 11, 'text', 'epub', NULL), (3, 10, 'audio', 'm4b', NULL);
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 10, 1), (2, 11, 2), (3, 10, 3);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let st = AppState::new(pool, Config::from_lookup(|_| None), SECRET);
    let mut tokens = vec![];
    for (id, name) in [(1, "admin"), (2, "a"), (3, "b"), (4, "none")] {
        tokens.push(session::token(&st, id, name).await);
    }
    (annotations::router().with_state(st), tokens)
}

async fn call(
    app: &Router,
    token: &str,
    method: &str,
    uri: &str,
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
    let res = app.clone().oneshot(req.body(body).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn highlight(note: &str) -> Value {
    json!({"kind": "highlight", "colour": "yellow", "note": note, "excerpt": "a line", "locator": {"href": "ch1.xhtml", "locations": {"progression": 0.2}}})
}

#[sqlx::test(migrations = false)]
async fn create_list_update_delete_round_trip(pool: PgPool) {
    let (app, t) = ctx(pool).await;
    let (s, h) = call(
        &app,
        &t[1],
        "POST",
        "/api/items/1/annotations",
        Some(highlight("n")),
    )
    .await;
    assert_eq!(s, 201, "{h}");
    assert_eq!(
        (h["kind"].as_str(), h["colour"].as_str(), h["note"].as_str()),
        (Some("highlight"), Some("yellow"), Some("n"))
    );
    let (s, b) = call(
        &app,
        &t[1],
        "POST",
        "/api/items/1/annotations",
        Some(json!({"kind": "bookmark", "locator": {"href": "ch2.xhtml"}})),
    )
    .await;
    assert_eq!(s, 201, "{b}");
    assert!(b["colour"].is_null());

    let (s, list) = call(&app, &t[1], "GET", "/api/items/1/annotations", None).await;
    assert_eq!((s, list.as_array().unwrap().len()), (200, 2));
    assert_eq!(list[0]["id"], h["id"]);

    let uri = format!("/api/annotations/{}", h["id"]);
    let (s, u) = call(
        &app,
        &t[1],
        "PATCH",
        &uri,
        Some(json!({"colour": "pink", "note": "later"})),
    )
    .await;
    assert_eq!(
        (s, u["colour"].as_str(), u["note"].as_str()),
        (200, Some("pink"), Some("later"))
    );
    assert_eq!(call(&app, &t[1], "DELETE", &uri, None).await.0, 204);
    assert_eq!(call(&app, &t[1], "DELETE", &uri, None).await.0, 404);
}

#[sqlx::test(migrations = false)]
async fn annotations_are_private_and_follow_the_library_acl(pool: PgPool) {
    let (app, t) = ctx(pool).await;
    let (_, h) = call(
        &app,
        &t[1],
        "POST",
        "/api/items/1/annotations",
        Some(highlight("")),
    )
    .await;
    let uri = format!("/api/annotations/{}", h["id"]);
    // another user sees none and cannot touch the row
    let (s, list) = call(&app, &t[2], "GET", "/api/items/1/annotations", None).await;
    assert_eq!((s, list.as_array().unwrap().len()), (200, 0));
    assert_eq!(
        call(&app, &t[2], "PATCH", &uri, Some(json!({"note": "x"})))
            .await
            .0,
        404
    );
    assert_eq!(call(&app, &t[2], "DELETE", &uri, None).await.0, 404);
    // an item of an unreadable library, an audio item and a missing one read as missing
    for item in [2, 3, 99] {
        assert_eq!(
            call(
                &app,
                &t[1],
                "GET",
                &format!("/api/items/{item}/annotations"),
                None
            )
            .await
            .0,
            404,
            "item {item}"
        );
        assert_eq!(
            call(
                &app,
                &t[1],
                "POST",
                &format!("/api/items/{item}/annotations"),
                Some(highlight(""))
            )
            .await
            .0,
            404
        );
    }
    // no media.read
    assert_eq!(
        call(&app, &t[3], "GET", "/api/items/1/annotations", None)
            .await
            .0,
        403
    );
}

#[sqlx::test(migrations = false)]
async fn bodies_are_validated(pool: PgPool) {
    let (app, t) = ctx(pool).await;
    let post = |b: Value| {
        let (app, t) = (app.clone(), t[1].clone());
        async move {
            call(&app, &t, "POST", "/api/items/1/annotations", Some(b))
                .await
                .0
        }
    };
    let loc = json!({"href": "a"});
    assert_eq!(
        post(json!({"kind": "highlight", "locator": loc})).await,
        400,
        "colour needed"
    );
    assert_eq!(
        post(json!({"kind": "highlight", "colour": "red", "locator": loc})).await,
        400
    );
    assert_eq!(
        post(json!({"kind": "bookmark", "colour": "blue", "locator": loc})).await,
        400
    );
    assert_eq!(
        post(json!({"kind": "bookmark", "note": "n", "locator": loc})).await,
        400
    );
    assert_eq!(post(json!({"kind": "other", "locator": loc})).await, 400);
    assert_eq!(post(json!({"kind": "bookmark", "locator": "x"})).await, 400);
    assert_eq!(
        post(json!({"kind": "bookmark", "locator": loc, "extra": 1})).await,
        400
    );
    assert_eq!(
        post(json!({"kind": "bookmark", "locator": {"t": "x".repeat(9000)}})).await,
        400
    );
    assert_eq!(post(highlight(&"n".repeat(4001))).await, 400);
    let (_, h) = call(
        &app,
        &t[1],
        "POST",
        "/api/items/1/annotations",
        Some(highlight("")),
    )
    .await;
    let uri = format!("/api/annotations/{}", h["id"]);
    assert_eq!(
        call(&app, &t[1], "PATCH", &uri, Some(json!({}))).await.0,
        400
    );
    assert_eq!(
        call(&app, &t[1], "PATCH", &uri, Some(json!({"colour": "red"})))
            .await
            .0,
        400
    );
    assert_eq!(
        call(&app, &t[1], "PATCH", &uri, Some(json!({"locator": {}})))
            .await
            .0,
        400
    );
    let (_, b) = call(
        &app,
        &t[1],
        "POST",
        "/api/items/1/annotations",
        Some(json!({"kind": "bookmark", "locator": loc})),
    )
    .await;
    let uri = format!("/api/annotations/{}", b["id"]);
    assert_eq!(
        call(&app, &t[1], "PATCH", &uri, Some(json!({"note": "n"})))
            .await
            .0,
        400
    );
}

#[sqlx::test(migrations = false)]
async fn the_count_is_capped_per_item(pool: PgPool) {
    let (app, t) = ctx(pool.clone()).await;
    sqlx::query(r#"INSERT INTO annotations ("userId", "itemId", kind, locator) SELECT 2, 1, 'bookmark', '{}' FROM generate_series(1, 2000)"#)
        .execute(&pool)
        .await
        .unwrap();
    let (s, _) = call(
        &app,
        &t[1],
        "POST",
        "/api/items/1/annotations",
        Some(highlight("")),
    )
    .await;
    assert_eq!(s, 409);
    // another user is not counted
    let (s, _) = call(
        &app,
        &t[2],
        "POST",
        "/api/items/1/annotations",
        Some(highlight("")),
    )
    .await;
    assert_eq!(s, 201);
}

#[sqlx::test(migrations = false)]
async fn concurrent_posts_cannot_pass_the_cap(pool: PgPool) {
    let (app, t) = ctx(pool.clone()).await;
    sqlx::query(r#"INSERT INTO annotations ("userId", "itemId", kind, locator) SELECT 2, 1, 'bookmark', '{}' FROM generate_series(1, 1999)"#)
        .execute(&pool)
        .await
        .unwrap();
    let post = || {
        call(
            &app,
            &t[1],
            "POST",
            "/api/items/1/annotations",
            Some(highlight("")),
        )
    };
    let (a, b, c, d) = tokio::join!(post(), post(), post(), post());
    let mut statuses = [a.0, b.0, c.0, d.0];
    statuses.sort();
    assert_eq!(statuses, [201, 409, 409, 409]);
}

#[sqlx::test(migrations = false)]
async fn an_edition_in_an_unreadable_library_hides_the_item(pool: PgPool) {
    let (app, t) = ctx(pool.clone()).await;
    sqlx::query(r#"UPDATE editions SET "libraryId" = 2 WHERE id = 1"#)
        .execute(&pool)
        .await
        .unwrap();
    let (s, _) = call(&app, &t[1], "GET", "/api/items/1/annotations", None).await;
    assert_eq!(s, 404);
    let (s, _) = call(
        &app,
        &t[1],
        "POST",
        "/api/items/1/annotations",
        Some(highlight("")),
    )
    .await;
    assert_eq!(s, 404);
    sqlx::query(r#"INSERT INTO annotations (id, "userId", "itemId", kind, colour, locator) VALUES (900, 2, 1, 'highlight', 'pink', '{}')"#)
        .execute(&pool)
        .await
        .unwrap();
    let (s, _) = call(
        &app,
        &t[1],
        "PATCH",
        "/api/annotations/900",
        Some(json!({"note": "x"})),
    )
    .await;
    assert_eq!(s, 404);
    let (s, _) = call(&app, &t[1], "DELETE", "/api/annotations/900", None).await;
    assert_eq!(s, 404);
}

#[sqlx::test(migrations = false)]
async fn deleting_the_item_or_the_user_removes_the_rows(pool: PgPool) {
    let (app, t) = ctx(pool.clone()).await;
    call(
        &app,
        &t[1],
        "POST",
        "/api/items/1/annotations",
        Some(highlight("")),
    )
    .await;
    call(
        &app,
        &t[2],
        "POST",
        "/api/items/1/annotations",
        Some(highlight("")),
    )
    .await;
    let count = || async {
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM annotations")
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    assert_eq!(count().await, 2);
    sqlx::query("DELETE FROM users WHERE id = 3")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(count().await, 1);
    sqlx::query("DELETE FROM items WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(count().await, 0);
}

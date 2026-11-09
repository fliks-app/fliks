//! Smart playlists and M3U (`playlists.md` rules 50-56).
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

async fn ctx(pool: &PgPool) -> (Router, String) {
    fliks_server::db::migrate(pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'L1', '["album"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
        INSERT INTO media (id, title, year, type, "libraryId", "folderName", genres)
          VALUES (10, 'Alpha', 1973, 'album', 1, 'a', '["Jazz"]');
        INSERT INTO album_details ("mediaId", "primaryType") VALUES (10, 'album');
        INSERT INTO persons (id, name) VALUES (1, 'Ana');
        INSERT INTO media_credits ("mediaId", "personId", role, position) VALUES (10, 1, 'artist', 0);
        INSERT INTO editions (id, "mediaId", family) VALUES (1, 10, 'audio');
        INSERT INTO items (id, "mediaId", "editionId", title) VALUES (1, 10, 1, 'One'), (2, 10, 1, 'Two'), (3, 10, 1, 'Three');
        INSERT INTO track_details ("itemId", "mediaId", "discNumber", position, "durationMs") VALUES
          (1, 10, 1, 1, 200000), (2, 10, 1, 2, 100000), (3, 10, 1, 3, 50000);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, 'a/01 One.flac', 1, 'FLAC', '{"audio":[{"codec":"flac"}]}'),
          (2, 10, 1, 'a/02 Two.mp3', 1, 'MP3', '{"audio":[{"codec":"mp3"}]}'),
          (3, 10, 1, 'a/03 Three.mp3', 1, 'MP3', '{"audio":[{"codec":"mp3"}]}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (2, 2, 10, 0, 0), (3, 3, 10, 0, 0);
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
    let t = session::token(&st, 1, "admin").await;
    (
        fliks_server::playlists::router()
            .merge(fliks_server::media::router())
            .with_state(st),
        t,
    )
}

async fn call(
    app: &Router,
    t: &str,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (u16, Value, String) {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-fliks-kinds", "movie,series,book,comic,album")
        .header("authorization", format!("Bearer {t}"));
    let body = match body {
        Some(v) => {
            b = b.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let res = app.clone().oneshot(b.body(body).unwrap()).await.unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&bytes).into_owned();
    (
        status,
        serde_json::from_str(&text).unwrap_or(Value::Null),
        text,
    )
}

fn rules(criteria: Value, sort: &str, limit: Value) -> Value {
    json!({"match": "all", "criteria": criteria, "sort": {"by": sort, "descending": false}, "limit": limit})
}

fn ids(items: &Value) -> Vec<i64> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["itemId"].as_i64().unwrap())
        .collect()
}

#[sqlx::test(migrations = false)]
async fn smart_playlist_evaluates_and_refuses_writes(pool: PgPool) {
    let (app, t) = ctx(&pool).await;
    let body = json!({"name": "Mp3", "rules": rules(json!([{"type": "codec", "codecs": ["MP3"]}]), "duration", Value::Null)});
    let (s, view, _) = call(&app, &t, "POST", "/api/playlists", Some(body)).await;
    assert_eq!((s, view["itemCount"].clone()), (201, json!(2)));
    let id = view["id"].as_i64().unwrap();
    let (_, items, _) = call(&app, &t, "GET", &format!("/api/playlists/{id}/items"), None).await;
    assert_eq!(ids(&items), vec![3, 2], "shortest first");
    assert_eq!(items[0]["track"]["title"], "Three");

    let (_, n, _) = call(
        &app,
        &t,
        "POST",
        "/api/playlists/preview",
        Some(json!({"rules": rules(json!([
        {"type": "codec", "codecs": ["mp3"]}, {"type": "genre", "name": "jazz"}]), "title", Value::Null)})),
    )
    .await;
    assert_eq!(n["count"], 2);
    for (criteria, sort) in [
        (json!([{"type": "rating", "min": 4}]), "title"),
        (json!([{"type": "genre", "name": "jazz"}]), "rating"),
    ] {
        let (s, _, _) = call(
            &app,
            &t,
            "POST",
            "/api/playlists/preview",
            Some(json!({"rules": rules(criteria, sort, Value::Null)})),
        )
        .await;
        assert_eq!(s, 400);
    }
    let (_, n, _) = call(
        &app,
        &t,
        "POST",
        "/api/playlists/preview",
        Some(json!({"rules": rules(json!([
        {"type": "lossless", "value": true}]), "title", json!(5))})),
    )
    .await;
    assert_eq!(n["count"], 1);

    for (m, u, b) in [
        (
            "POST",
            format!("/api/playlists/{id}/items"),
            Some(json!({"itemId": 1})),
        ),
        ("DELETE", format!("/api/playlists/{id}/items/1"), None),
        (
            "PUT",
            format!("/api/playlists/{id}/items/order"),
            Some(json!({"itemIds": []})),
        ),
    ] {
        let (s, v, _) = call(&app, &t, m, &u, b).await;
        assert_eq!(
            (s, v["message"].clone()),
            (400, json!("errors.playlist_smart_readonly"))
        );
    }
    let (s, v, _) = call(
        &app,
        &t,
        "PATCH",
        &format!("/api/playlists/{id}"),
        Some(json!({"autoRemoveWatched": true})),
    )
    .await;
    assert_eq!(
        (s, v["message"].clone()),
        (400, json!("errors.playlist_smart_auto_remove"))
    );
    let (_, st, _) = call(
        &app,
        &t,
        "POST",
        "/api/playlists",
        Some(json!({"name": "S"})),
    )
    .await;
    let (s, v, _) = call(&app, &t, "PATCH", &format!("/api/playlists/{}", st["id"]), Some(json!({"rules": rules(json!([{"type": "favourite", "value": true}]), "title", Value::Null)}))).await;
    assert_eq!(
        (s, v["message"].clone()),
        (400, json!("errors.playlist_not_smart"))
    );
    let (s, ..) = call(
        &app,
        &t,
        "POST",
        "/api/playlists",
        Some(json!({"name": "x", "rules": rules(json!([]), "title", Value::Null)})),
    )
    .await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn m3u_imports_by_path_and_title_and_exports(pool: PgPool) {
    let (app, t) = ctx(&pool).await;
    let content = "#EXTM3U\n/old/music/a/01 One.flac\n#EXTINF:100,Ana - Two\nnowhere.mp3\n/old/music/a/01 One.flac\nmissing.flac\n";
    let (s, r, _) = call(
        &app,
        &t,
        "POST",
        "/api/playlists/import-m3u",
        Some(json!({"name": "Imp", "content": content})),
    )
    .await;
    assert_eq!(
        (s, r["matched"].clone(), r["unmatched"].clone()),
        (201, json!(2), json!([{"line": 6, "text": "missing.flac"}]))
    );
    let id = r["playlist"]["id"].as_i64().unwrap();
    let (_, items, _) = call(&app, &t, "GET", &format!("/api/playlists/{id}/items"), None).await;
    assert_eq!(entry_ids(&items), vec![1, 2]);
    let (s, _, text) = call(
        &app,
        &t,
        "GET",
        &format!("/api/playlists/{id}/export.m3u"),
        None,
    )
    .await;
    assert_eq!(s, 200);
    assert_eq!(
        text,
        "#EXTM3U\n#EXTINF:200,Ana - One\na/01 One.flac\n#EXTINF:100,Ana - Two\na/02 Two.mp3\n"
    );
}

fn entry_ids(items: &Value) -> Vec<i64> {
    items
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["track"]["itemId"].as_i64().unwrap())
        .collect()
}

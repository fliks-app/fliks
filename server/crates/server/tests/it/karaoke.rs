//! Karaoke core (`karaoke.md`): stems served with ranges and ACL, state, invalidation, eviction.
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{
    config::Config,
    karaoke::store::{self, New},
    state::AppState,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

async fn ctx(pool: &PgPool) -> (Router, AppState, String) {
    fliks_server::db::migrate(pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'L1', '["album"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m');
        INSERT INTO media (id, title, year, type, "libraryId", "folderName") VALUES (10, 'Alpha', 1973, 'album', 1, 'a');
        INSERT INTO album_details ("mediaId", "primaryType") VALUES (10, 'album');
        INSERT INTO editions (id, "mediaId", family, "trackCount", "discCount") VALUES (1, 10, 'audio', 1, 1);
        INSERT INTO items (id, "mediaId", "editionId", title) VALUES (1, 10, 1, 'One');
        INSERT INTO track_details ("itemId", "mediaId", "discNumber", position, "durationMs") VALUES (1, 10, 1, 1, 200000);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, '1.flac', 1, 'FLAC', '{}'), (2, 10, 1, '2.flac', 1, 'FLAC', '{}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES (1, 1, 10, 0, 0);
        "#,
    )
    .execute(pool)
    .await
    .unwrap();
    let t = session::token(&st, 1, "admin").await;
    let app = fliks_server::karaoke::router()
        .merge(fliks_server::lyrics::router())
        .with_state(st.clone());
    (app, st, t)
}

async fn call(
    app: &Router,
    t: &str,
    method: &str,
    uri: &str,
    range: Option<&str>,
) -> (u16, Vec<u8>) {
    let mut b = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {t}"));
    if let Some(r) = range {
        b = b.header("range", r);
    }
    let res = app
        .clone()
        .oneshot(b.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = res.status().as_u16();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, bytes.to_vec())
}

struct Dir(std::path::PathBuf);

impl Dir {
    fn new() -> Self {
        let d = std::env::temp_dir().join(format!(
            "fliks-karaoke-{}",
            fliks_server::config::random_hex(4)
        ));
        std::fs::create_dir_all(&d).unwrap();
        Self(d)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn json_of(b: &[u8]) -> Value {
    serde_json::from_slice(b).unwrap_or(Value::Null)
}

async fn stem(st: &AppState, dir: &std::path::Path, file: i32, kind: &str, model: &str) {
    let path = dir.join(format!("{file}-{kind}.opus"));
    std::fs::write(&path, b"0123456789").unwrap();
    store::put(
        &st.db,
        &New {
            file,
            kind,
            model,
            model_version: "1",
            provider: "cpu",
            path: path.to_str().unwrap(),
            size: 10,
            duration_ms: 200_000,
        },
    )
    .await
    .unwrap();
}

#[sqlx::test(migrations = false)]
async fn a_stem_is_served_with_ranges_to_a_session_or_its_own_file_token(pool: PgPool) {
    let (app, st, t) = ctx(&pool).await;
    let dir = Dir::new();
    stem(&st, dir.path(), 1, "vocals", "m").await;
    let uri = "/api/media-files/1/stems/vocals";
    let (s, body) = call(&app, &t, "GET", uri, None).await;
    assert_eq!((s, body.as_slice()), (200, &b"0123456789"[..]));
    let (s, body) = call(&app, &t, "GET", uri, Some("bytes=2-4")).await;
    assert_eq!((s, body.as_slice()), (206, &b"234"[..]));
    assert_eq!(
        call(&app, &t, "GET", "/api/media-files/1/stems/guide", None)
            .await
            .0,
        404
    );
    assert_eq!(
        call(&app, &t, "GET", "/api/media-files/1/stems/other", None)
            .await
            .0,
        404
    );
    let own = session::stream_for(&st, 1, "admin", 1).await;
    assert_eq!(call(&app, &own, "GET", uri, None).await.0, 200);
    let other = session::stream_for(&st, 1, "admin", 2).await;
    assert_eq!(call(&app, &other, "GET", uri, None).await.0, 401);
    let unbound = session::stream(&st, 1, "admin").await;
    assert_eq!(call(&app, &unbound, "GET", uri, None).await.0, 401);
}

#[sqlx::test(migrations = false)]
async fn the_state_lists_the_stems_and_a_delete_removes_them_and_the_generated_lyrics(
    pool: PgPool,
) {
    let (app, st, t) = ctx(&pool).await;
    let dir = Dir::new();
    let (_, body) = call(&app, &t, "GET", "/api/items/1/karaoke", None).await;
    let none = json_of(&body);
    assert_eq!(
        (&none["state"], &none["fileId"]),
        (&json!("none"), &json!(1))
    );
    for k in store::KINDS {
        stem(&st, dir.path(), 1, k, "m").await;
    }
    sqlx::query(
        r#"INSERT INTO lyrics ("itemId", kind, lang, sync, source, doc)
           VALUES (1, 'main', 'und', 'word', 'generated', '{"agents":[],"lines":[]}')"#,
    )
    .execute(&st.db)
    .await
    .unwrap();
    let (_, body) = call(&app, &t, "GET", "/api/items/1/karaoke", None).await;
    let ready = json_of(&body);
    assert_eq!(
        (&ready["state"], &ready["lyrics"]),
        (&json!("ready"), &json!(true))
    );
    assert_eq!(ready["stems"]["guide"]["size"], 10);
    assert_eq!(
        call(&app, &t, "DELETE", "/api/items/1/karaoke", None)
            .await
            .0,
        204
    );
    let (_, body) = call(&app, &t, "GET", "/api/items/1/karaoke", None).await;
    let gone = json_of(&body);
    assert_eq!(
        (&gone["state"], &gone["lyrics"]),
        (&json!("none"), &json!(false))
    );
    assert!(!dir.path().join("1-vocals.opus").exists());
}

#[sqlx::test(migrations = false)]
async fn preparing_needs_the_setting_then_the_engine(pool: PgPool) {
    let (app, st, t) = ctx(&pool).await;
    assert_eq!(
        call(&app, &t, "POST", "/api/items/1/karaoke", None).await.0,
        409
    );
    sqlx::query("INSERT INTO app_settings (key, value) VALUES ('karaoke.enabled', 'true')")
        .execute(&st.db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, &t, "POST", "/api/items/1/karaoke", None).await.0,
        503
    );
    assert_eq!(
        call(&app, &t, "GET", "/api/items/99/karaoke", None).await.0,
        404
    );
}

#[sqlx::test(migrations = false)]
async fn stems_are_invalidated_by_a_replaced_file_a_model_and_the_budget(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let dir = Dir::new();
    for (file, model) in [(1, "old"), (2, "new")] {
        for k in store::KINDS {
            stem(&st, dir.path(), file, k, model).await;
        }
    }
    assert!(store::valid(&st.db, 2, "new", "1").await.unwrap());
    assert!(!store::valid(&st.db, 1, "new", "1").await.unwrap());
    // Within 2 s the file is the same recording; beyond it the stems go.
    assert_eq!(
        store::invalidate_if_replaced(&st.db, 2, 201_500)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        store::invalidate_if_replaced(&st.db, 2, 230_000)
            .await
            .unwrap(),
        3
    );
    assert!(!dir.path().join("2-vocals.opus").exists());
    assert_eq!(
        store::invalidate_stale_models(&st.db, "new", "1")
            .await
            .unwrap(),
        3
    );
    assert_eq!(store::total(&st.db).await.unwrap(), 0);
    for k in store::KINDS {
        stem(&st, dir.path(), 1, k, "m").await;
    }
    assert_eq!(store::invalidate_model(&st.db, "m").await.unwrap(), 3);
    for k in store::KINDS {
        stem(&st, dir.path(), 1, k, "m").await;
    }
    // Rows younger than the grace are never evicted, even over the budget.
    assert_eq!(store::evict(&st.db, 0).await.unwrap(), 0);
    sqlx::query(r#"UPDATE derived_audio SET "lastUsedAt" = now() - interval '1 hour' WHERE kind <> 'guide'"#)
        .execute(&st.db)
        .await
        .unwrap();
    assert_eq!(store::evict(&st.db, 10).await.unwrap(), 2);
    assert_eq!(store::total(&st.db).await.unwrap(), 10);
}

#[sqlx::test(migrations = false)]
async fn a_generated_row_does_not_stop_a_provider_fetch(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    sqlx::query(
        r#"INSERT INTO lyrics ("itemId", kind, lang, sync, source, doc)
           VALUES (1, 'main', 'und', 'word', 'generated', '{"agents":[],"lines":[]}')"#,
    )
    .execute(&st.db)
    .await
    .unwrap();
    assert!(
        !fliks_server::lyrics::store::has_synced_main(&st.db, 1)
            .await
            .unwrap()
    );
}

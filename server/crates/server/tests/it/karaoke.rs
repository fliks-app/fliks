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
    std::fs::create_dir_all(dir).unwrap();
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
async fn a_forced_run_needs_the_right_to_edit_the_track(pool: PgPool) {
    let (app, st, admin) = ctx(&pool).await;
    sqlx::raw_sql(
        r#"INSERT INTO roles (id, name, permissions) VALUES (60, 'Viewer', '["media.read"]');
           INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (2, 'reader', false, 60);
           INSERT INTO library_user_access ("userId", "libraryId") VALUES (2, 1);"#,
    )
    .execute(&st.db)
    .await
    .unwrap();
    let reader = session::token(&st, 2, "reader").await;
    let force = |t: &str| {
        Request::builder()
            .method("POST")
            .uri("/api/items/1/karaoke")
            .header("authorization", format!("Bearer {t}"))
            .header("content-type", "application/json")
            .body(Body::from(r#"{"align":false,"melody":true,"force":true}"#))
            .unwrap()
    };
    assert_eq!(
        app.clone().oneshot(force(&reader)).await.unwrap().status(),
        403
    );
    assert_eq!(app.oneshot(force(&admin)).await.unwrap().status(), 409);
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
    assert_eq!(ready["stems"]["vocals"]["size"], 10);
    assert!(ready["stems"]["guide"].is_null());
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
    assert!(!dir.path().exists());
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
async fn stems_are_invalidated_by_a_replaced_file_and_evicted_by_the_budget(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let dir = Dir::new();
    for (file, model) in [(1, "old"), (2, "new")] {
        for k in store::KINDS {
            stem(&st, dir.path(), file, k, model).await;
        }
    }
    assert!(store::valid(&st.db, 2, "new", "1").await.unwrap());
    // Another model's stems stay served until the file is separated again.
    assert!(!store::valid(&st.db, 1, "new", "1").await.unwrap());
    assert_eq!(
        store::missing(&st.db, 1, Some(("new", "1"))).await.unwrap(),
        store::KINDS
    );
    assert_eq!(store::rows(&st.db, 1).await.unwrap().len(), 2);
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
        2
    );
    assert!(!dir.path().join("2-vocals.opus").exists());
    // Rows younger than the grace are never evicted, even over the budget.
    assert_eq!(store::evict(&st.db, 0).await.unwrap(), 0);
    // A file goes whole, and a young row protects its siblings.
    sqlx::query(r#"UPDATE derived_audio SET "lastUsedAt" = now() - interval '1 hour' WHERE kind <> 'vocals'"#)
        .execute(&st.db)
        .await
        .unwrap();
    assert_eq!(store::evict(&st.db, 10).await.unwrap(), 0);
    sqlx::query(r#"UPDATE derived_audio SET "lastUsedAt" = now() - interval '1 hour'"#)
        .execute(&st.db)
        .await
        .unwrap();
    assert_eq!(store::evict(&st.db, 10).await.unwrap(), 2);
    assert_eq!(store::total(&st.db).await.unwrap(), 0);
}

#[sqlx::test(migrations = false)]
async fn a_karaoke_request_touches_every_stem_of_the_file_and_serving_does_not(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let dir = Dir::new();
    for k in store::KINDS {
        stem(&st, dir.path(), 1, k, "m").await;
    }
    sqlx::query(r#"UPDATE derived_audio SET "lastUsedAt" = now() - interval '1 hour'"#)
        .execute(&st.db)
        .await
        .unwrap();
    let fresh = || async {
        sqlx::query_scalar::<_, i64>(
            r#"SELECT count(*) FROM derived_audio WHERE "lastUsedAt" > now() - interval '1 minute'"#,
        )
        .fetch_one(&st.db)
        .await
        .unwrap()
    };
    assert!(store::serve(&st.db, 1, "vocals").await.unwrap().is_some());
    assert!(store::serve(&st.db, 1, "other").await.unwrap().is_none());
    assert_eq!(fresh().await, 0);
    store::touch(&st.db, 1).await.unwrap();
    assert_eq!(fresh().await, 2);
}

#[sqlx::test(migrations = false)]
async fn a_melody_never_overwrites_a_lyrics_edit_made_while_it_ran(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let doc = |text: &str| {
        json!({"agents": [], "lines": [{"text": text, "cues": [
            {"start": 0, "end": 5, "byteStart": 0, "byteEnd": text.len()}]}]})
    };
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO lyrics ("itemId", kind, lang, sync, source, doc)
           VALUES (1, 'main', 'und', 'word', 'generated', $1) RETURNING id"#,
    )
    .bind(sqlx::types::Json(doc("la la")))
    .fetch_one(&st.db)
    .await
    .unwrap();
    let snapshot = |text: &str| serde_json::from_value(doc(text)).unwrap();
    let notes = vec![vec![(0, 5, 60.0)]];
    sqlx::query("UPDATE lyrics SET doc = $2 WHERE id = $1")
        .bind(id)
        .bind(sqlx::types::Json(doc("edited")))
        .execute(&st.db)
        .await
        .unwrap();
    assert!(
        !fliks_server::karaoke::run::write_pitch(&st.db, id, &snapshot("la la"), &notes)
            .await
            .unwrap()
    );
    let kept: Value = sqlx::query_scalar("SELECT doc FROM lyrics WHERE id = $1")
        .bind(id)
        .fetch_one(&st.db)
        .await
        .unwrap();
    assert_eq!(kept, doc("edited"));
    assert!(
        fliks_server::karaoke::run::write_pitch(&st.db, id, &snapshot("edited"), &notes)
            .await
            .unwrap()
    );
    let pitched: Value = sqlx::query_scalar("SELECT doc FROM lyrics WHERE id = $1")
        .bind(id)
        .fetch_one(&st.db)
        .await
        .unwrap();
    assert_eq!(pitched["lines"][0]["cues"][0]["pitch"], 60.0);
}

#[sqlx::test(migrations = false)]
async fn a_reader_without_access_to_the_library_gets_404_on_the_stems(pool: PgPool) {
    let (app, st, _t) = ctx(&pool).await;
    let dir = Dir::new();
    stem(&st, dir.path(), 1, "vocals", "m").await;
    sqlx::raw_sql(
        r#"INSERT INTO roles (id, name, permissions) VALUES (60, 'Viewer', '["media.read"]');
           INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (2, 'reader', false, 60);"#,
    )
    .execute(&st.db)
    .await
    .unwrap();
    let t = session::token(&st, 2, "reader").await;
    let uri = "/api/media-files/1/stems/vocals";
    assert_eq!(call(&app, &t, "GET", uri, None).await.0, 404);
    assert_eq!(
        call(&app, &t, "GET", "/api/items/1/karaoke", None).await.0,
        404
    );
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES (2, 1)"#)
        .execute(&st.db)
        .await
        .unwrap();
    assert_eq!(call(&app, &t, "GET", uri, None).await.0, 200);
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

#[sqlx::test(migrations = false)]
async fn ultrastar_stems_are_imported_kept_and_dropped_with_their_header(pool: PgPool) {
    let (app, st, t) = ctx(&pool).await;
    let dir = Dir::new();
    let song = |head: &str| format!("#TITLE:T\n#BPM:120\n{head}\n: 0 4 0 la\nE\n");
    std::fs::write(dir.path().join("1.flac"), b"x").unwrap();
    std::fs::write(dir.path().join("v.mp3"), b"vocals").unwrap();
    std::fs::write(dir.path().join("i.mp3"), b"instr").unwrap();
    let run = |text: String| {
        std::fs::write(dir.path().join("1.txt"), text).unwrap();
        let st = st.clone();
        let audio = dir.path().join("1.flac");
        async move {
            let listing = fliks_server::lyrics::discover::listing(audio.parent().unwrap()).await;
            fliks_server::lyrics::discover::file(
                &st,
                1,
                1,
                &audio,
                Some(200_000),
                Some(&Default::default()),
                &listing,
            )
            .await
            .unwrap();
        }
    };
    run(song(
        "#VOCALS:v.mp3\n#INSTRUMENTAL:i.mp3\n#INSTRUMENTAL2:../x",
    ))
    .await;
    let (_, body) = call(&app, &t, "GET", "/api/items/1/karaoke", None).await;
    let state = json_of(&body);
    assert_eq!(state["state"], "ready");
    assert!(state["stems"]["vocals"].is_object() && state["stems"]["instrumental"].is_object());
    assert!(state["stems"]["guide"].is_null());
    assert_eq!(
        call(&app, &t, "GET", "/api/media-files/1/stems/vocals", None)
            .await
            .1,
        b"vocals"
    );
    assert!(store::valid(&st.db, 1, "m", "1").await.unwrap());
    sqlx::query(r#"UPDATE derived_audio SET "lastUsedAt" = now() - interval '1 hour'"#)
        .execute(&st.db)
        .await
        .unwrap();
    assert_eq!(store::evict(&st.db, 0).await.unwrap(), 0);
    // A header naming a path or a missing file imports nothing; one kind dropped removes its row.
    run(song("#VOCALS:v.mp3\n#INSTRUMENTAL:../i.mp3")).await;
    assert_eq!(store::rows(&st.db, 1).await.unwrap().len(), 1);
    run(song("")).await;
    assert!(store::rows(&st.db, 1).await.unwrap().is_empty());
    store::invalidate_files(&st.db, &[1]).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn without_a_cdg_the_state_says_so_and_the_route_is_404_or_401(pool: PgPool) {
    let (app, st, t) = ctx(&pool).await;
    let (_, body) = call(&app, &t, "GET", "/api/items/1/karaoke", None).await;
    assert_eq!(json_of(&body)["cdg"], false);
    assert_eq!(
        call(&app, &t, "GET", "/api/media-files/1/cdg", None)
            .await
            .0,
        404
    );
    let own = session::stream_for(&st, 1, "admin", 2).await;
    assert_eq!(
        call(&app, &own, "GET", "/api/media-files/1/cdg", None)
            .await
            .0,
        401
    );
}

async fn import_row(st: &AppState, file: i32, kind: &str, provider: &str) {
    store::put(
        &st.db,
        &New {
            file,
            kind,
            model: "ultrastar",
            model_version: "1",
            provider,
            path: "/nowhere",
            size: 10,
            duration_ms: 200_000,
        },
    )
    .await
    .unwrap();
}

const M: (&str, &str) = ("m", "1");

async fn second_track(st: &AppState) {
    sqlx::raw_sql(
        r#"INSERT INTO items (id, "mediaId", "editionId", title) VALUES (2, 10, 1, 'Two');
           INSERT INTO track_details ("itemId", "mediaId", "discNumber", position, "durationMs") VALUES (2, 10, 1, 2, 200000);
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES (2, 2, 10, 0, 0);"#,
    )
    .execute(&st.db)
    .await
    .unwrap();
}

#[sqlx::test(migrations = false)]
async fn the_background_pass_skips_a_track_with_both_imported_stems(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    second_track(&st).await;
    assert_eq!(
        store::unprepared(&st.db, &[], 20, M, false).await.unwrap(),
        [2, 1]
    );
    import_row(&st, 1, "vocals", "import").await;
    assert_eq!(
        store::unprepared(&st.db, &[], 20, M, false).await.unwrap(),
        [2, 1],
        "one import is not enough"
    );
    import_row(&st, 1, "instrumental", "import").await;
    assert_eq!(
        store::unprepared(&st.db, &[], 20, M, false).await.unwrap(),
        [2]
    );
    assert_eq!(
        store::unprepared(&st.db, &[2], 20, M, false).await.unwrap(),
        Vec::<i32>::new()
    );
    for kind in store::KINDS {
        import_row(&st, 2, kind, "cpu").await;
    }
    // Stems of another model come after tracks with none; those of the current model are done.
    assert_eq!(
        store::unprepared(&st.db, &[], 20, M, false).await.unwrap(),
        [2]
    );
    assert!(
        store::unprepared(&st.db, &[], 20, ("ultrastar", "1"), false)
            .await
            .unwrap()
            .is_empty()
    );
}

#[sqlx::test(migrations = false)]
async fn imports_stay_out_of_the_disk_budget_they_cannot_be_evicted_for(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    for kind in ["vocals", "instrumental"] {
        import_row(&st, 1, kind, "import").await;
    }
    assert_eq!(store::total(&st.db).await.unwrap(), 0);
    for kind in store::KINDS {
        import_row(&st, 2, kind, "cpu").await;
    }
    sqlx::query(r#"UPDATE derived_audio SET "lastUsedAt" = now() - interval '1 hour'"#)
        .execute(&st.db)
        .await
        .unwrap();
    assert_eq!(store::total(&st.db).await.unwrap(), 20);
    assert_eq!(
        store::evict(&st.db, 20).await.unwrap(),
        0,
        "the generated stems fit alone"
    );
    assert_eq!(store::evict(&st.db, 0).await.unwrap(), 2);
    assert_eq!(store::rows(&st.db, 1).await.unwrap().len(), 2);
}

#[sqlx::test(migrations = false)]
async fn a_failed_copy_keeps_the_imported_stem_the_header_still_names(pool: PgPool) {
    use std::os::unix::fs::PermissionsExt;
    let (_app, st, _t) = ctx(&pool).await;
    let dir = Dir::new();
    std::fs::write(dir.path().join("1.flac"), b"x").unwrap();
    std::fs::write(dir.path().join("v.mp3"), b"vocals").unwrap();
    std::fs::write(dir.path().join("i.mp3"), b"instr").unwrap();
    std::fs::write(
        dir.path().join("1.txt"),
        "#TITLE:T\n#BPM:120\n#VOCALS:v.mp3\n#INSTRUMENTAL:i.mp3\n: 0 4 0 la\nE\n",
    )
    .unwrap();
    let audio = dir.path().join("1.flac");
    let run = || async {
        let listing = fliks_server::lyrics::discover::listing(dir.path()).await;
        fliks_server::lyrics::discover::file(
            &st,
            1,
            1,
            &audio,
            Some(200_000),
            Some(&Default::default()),
            &listing,
        )
        .await
        .unwrap();
    };
    run().await;
    let held = store::rows(&st.db, 1).await.unwrap();
    assert_eq!(held.len(), 2);
    // A longer vocals file that cannot be read: the copy fails, the held one stays.
    std::fs::write(dir.path().join("v.mp3"), b"vocals, longer").unwrap();
    std::fs::set_permissions(
        dir.path().join("v.mp3"),
        std::fs::Permissions::from_mode(0o000),
    )
    .unwrap();
    run().await;
    let after = store::rows(&st.db, 1).await.unwrap();
    assert_eq!(after.len(), 2);
    assert!(store::valid(&st.db, 1, "m", "1").await.unwrap());
    store::invalidate_files(&st.db, &[1]).await.unwrap();
}

use fliks_engine_core::api::{JobResultRequest, SeparateOutput, StemUpload};
use fliks_server::karaoke::remote::{result, result_for, upload_path};

/// A random job id: parallel tests share the uploads folder.
async fn separate_lease(st: &AppState) -> i64 {
    sqlx::query_scalar(
        r#"INSERT INTO jobs (id, kind, "mediaFileId", payload, "profileHash", priority, state, attempt,
             "workerId", "leaseUntil")
           VALUES (1000 + (random() * 1e9)::bigint, 'separate', 1, '{}', 'h', -1, 'leased', 1, 'k',
             now() + interval '1 minute')
           RETURNING id"#,
    )
    .fetch_one(&st.db)
    .await
    .unwrap()
}

fn sha_of(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

/// Writes the three uploads of attempt 1 and the worker's result for them.
fn uploaded(job: i64, sha_vocals: Option<&str>) -> JobResultRequest {
    let dir = upload_path(job, 1, "vocals")
        .parent()
        .unwrap()
        .to_path_buf();
    std::fs::create_dir_all(dir).unwrap();
    let mut stems = vec![];
    for name in ["vocals", "instrumental", "guide"] {
        let body = format!("stem-{name}");
        std::fs::write(upload_path(job, 1, name), &body).unwrap();
        let sha = match (name, sha_vocals) {
            ("vocals", Some(s)) => s.to_owned(),
            _ => sha_of(body.as_bytes()),
        };
        stems.push(StemUpload {
            name: name.into(),
            size: body.len() as f64,
            sha256: sha,
        });
    }
    JobResultRequest {
        worker_id: "w".into(),
        attempt: 1,
        ok: true,
        out_size: 0.0,
        out_sha256: None,
        out_info: None,
        error: None,
        level: None,
        copy_reason: None,
        cpu_fallback: None,
        sampled_savings_pct: None,
        savings_pct: None,
        ssim: None,
        nothing_to_do: false,
        separate: Some(SeparateOutput {
            model: "m".into(),
            model_version: "1".into(),
            provider: "cuda".into(),
            duration_seconds: 12.3456,
            stems,
        }),
    }
}

#[sqlx::test(migrations = false)]
async fn a_worker_result_stores_its_stems_without_the_guide_and_leaves_no_job(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let job = separate_lease(&st).await;
    let _ = result(&st, "k", job, uploaded(job, None)).await.unwrap();
    let rows = store::rows(&st.db, 1).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert!(!upload_path(job, 1, "guide").exists());
    assert!(
        rows.iter()
            .all(|r| r.provider == "cuda" && r.duration_ms == 12346)
    );
    assert!(rows.iter().all(|r| std::path::Path::new(&r.path).is_file()));
    assert!(!upload_path(job, 1, "vocals").exists());
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE id = $1")
        .bind(job)
        .fetch_one(&st.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
    store::invalidate_files(&st.db, &[1]).await.unwrap();
}

#[sqlx::test(migrations = false)]
async fn a_mismatched_stem_hash_stores_nothing_and_requeues_as_network(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let job = separate_lease(&st).await;
    let _ = result(&st, "k", job, uploaded(job, Some("00")))
        .await
        .unwrap();
    assert!(store::rows(&st.db, 1).await.unwrap().is_empty());
    let (state, failures, class): (String, i32, String) =
        sqlx::query_as("SELECT state, failures, error->>'class' FROM jobs WHERE id = $1")
            .bind(job)
            .fetch_one(&st.db)
            .await
            .unwrap();
    assert_eq!(
        (state.as_str(), failures, class.as_str()),
        ("queued", 1, "network")
    );
    for name in ["vocals", "instrumental", "guide"] {
        let _ = std::fs::remove_file(upload_path(job, 1, name));
    }
}

#[sqlx::test(migrations = false)]
async fn a_track_already_valid_discards_the_uploads(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let dir = Dir::new();
    for kind in store::KINDS {
        stem(&st, dir.path(), 1, kind, "m").await;
    }
    let job = separate_lease(&st).await;
    let _ = result(&st, "k", job, uploaded(job, None)).await.unwrap();
    let rows = store::rows(&st.db, 1).await.unwrap();
    assert!(
        rows.iter().all(|r| r.provider == "cpu"),
        "the earlier stems stay"
    );
    assert!(!upload_path(job, 1, "guide").exists());
}

#[sqlx::test(migrations = false)]
async fn a_track_with_a_queued_or_leased_separation_is_not_unprepared(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    assert_eq!(
        store::unprepared(&st.db, &[], 10, M, false).await.unwrap(),
        [1]
    );
    let job = separate_lease(&st).await;
    assert!(
        store::unprepared(&st.db, &[], 10, M, false)
            .await
            .unwrap()
            .is_empty()
    );
    sqlx::query("UPDATE jobs SET state = 'failed' WHERE id = $1")
        .bind(job)
        .execute(&st.db)
        .await
        .unwrap();
    assert_eq!(
        store::unprepared(&st.db, &[], 10, M, false).await.unwrap(),
        [1]
    );
}

#[sqlx::test(migrations = false)]
async fn a_commit_of_another_model_version_stores_nothing_and_deletes_the_job(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let job = separate_lease(&st).await;
    let current = ("m".to_owned(), "2".to_owned());
    let _ = result_for(&st, "k", job, uploaded(job, None), Some(&current))
        .await
        .unwrap();
    assert!(store::rows(&st.db, 1).await.unwrap().is_empty());
    assert!(!upload_path(job, 1, "vocals").exists());
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE id = $1")
        .bind(job)
        .fetch_one(&st.db)
        .await
        .unwrap();
    assert_eq!(left, 0);
    assert!(!st.queue.karaoke_blocked("k"));
}

fn model_failure(job: i64) -> JobResultRequest {
    let mut r = uploaded(job, None);
    r.ok = false;
    r.separate = None;
    r.error = Some(fliks_engine_core::api::JobError {
        class: fliks_engine_core::api::JobErrorClass::Model,
        message: "x".into(),
        stderr_tail: None,
    });
    r
}

#[sqlx::test(migrations = false)]
async fn a_model_failure_on_a_stale_job_deletes_it_without_blocking_the_worker(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let job = separate_lease(&st).await;
    let current = ("m".to_owned(), "2".to_owned());
    let _ = result_for(&st, "k", job, model_failure(job), Some(&current))
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM jobs WHERE id = $1")
        .bind(job)
        .fetch_one(&st.db)
        .await
        .unwrap();
    assert_eq!((left, st.queue.karaoke_blocked("k")), (0, false));
    // A job of the current version fails as usual and blocks the worker.
    let job = separate_lease(&st).await;
    sqlx::query(r#"UPDATE jobs SET "profileHash" = 'karaoke:m:2' WHERE id = $1"#)
        .bind(job)
        .execute(&st.db)
        .await
        .unwrap();
    let _ = result_for(&st, "k", job, model_failure(job), Some(&current))
        .await
        .unwrap();
    assert!(st.queue.karaoke_blocked("k"));
    for name in ["vocals", "instrumental", "guide"] {
        let _ = std::fs::remove_file(upload_path(job, 1, name));
    }
}

#[sqlx::test(migrations = false)]
async fn a_cancelled_separation_sticks_and_a_stale_queued_one_is_dropped(pool: PgPool) {
    let (_app, st, _t) = ctx(&pool).await;
    let job = separate_lease(&st).await;
    sqlx::query(
        r#"UPDATE jobs SET state = 'cancelled', "profileHash" = 'karaoke:m:2' WHERE id = $1"#,
    )
    .bind(job)
    .execute(&st.db)
    .await
    .unwrap();
    assert!(
        store::unprepared(&st.db, &[], 10, ("m", "2"), false)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store::unprepared(&st.db, &[], 10, ("m", "3"), false)
            .await
            .unwrap(),
        [1]
    );
    sqlx::query("UPDATE jobs SET state = 'queued' WHERE id = $1")
        .bind(job)
        .execute(&st.db)
        .await
        .unwrap();
    let n = fliks_server::karaoke::drop_stale_separations(&st.db, "karaoke:m:3")
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test(migrations = false)]
async fn a_track_with_two_versions_is_prepared_and_reported_on_its_newest_file(pool: PgPool) {
    let (app, st, t) = ctx(&pool).await;
    sqlx::query(
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES (1, 2, 10, 1, 0)"#,
    )
    .execute(&st.db)
    .await
    .unwrap();
    assert_eq!(store::track_file(&st.db, 1).await.unwrap(), Some(2));
    assert_eq!(store::track_of(&st.db, 2).await.unwrap(), Some(1));
    assert_eq!(store::track_of(&st.db, 1).await.unwrap(), None);
    let dir = Dir::new();
    // Stems of the older version neither make the track ready nor take it out of the pass.
    for k in store::KINDS {
        stem(&st, dir.path(), 1, k, "m").await;
    }
    let (_, body) = call(&app, &t, "GET", "/api/items/1/karaoke", None).await;
    let state = json_of(&body);
    assert_eq!(
        (&state["state"], &state["fileId"]),
        (&json!("none"), &json!(2))
    );
    assert_eq!(
        store::unprepared(&st.db, &[], 10, M, false).await.unwrap(),
        [1]
    );
    assert!(store::ready_tracks(&st.db, &[1]).await.unwrap().is_empty());
    for k in store::KINDS {
        stem(&st, dir.path(), 2, k, "m").await;
    }
    let (_, body) = call(&app, &t, "GET", "/api/items/1/karaoke", None).await;
    assert_eq!(json_of(&body)["state"], "ready");
    assert!(
        store::unprepared(&st.db, &[], 10, M, false)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(store::ready_tracks(&st.db, &[1]).await.unwrap(), [1]);
}

#[sqlx::test(migrations = false)]
async fn a_lasting_failure_is_kept_reported_and_left_out_of_the_pass_until_a_delete(pool: PgPool) {
    use fliks_server::karaoke::run::{Failure, Outcome};
    let (app, st, t) = ctx(&pool).await;
    sqlx::raw_sql(
        r#"INSERT INTO roles (id, name, permissions) VALUES (60, 'Viewer', '["media.read"]');
           INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (2, 'reader', false, 60);
           INSERT INTO library_user_access ("userId", "libraryId") VALUES (2, 1);"#,
    )
    .execute(&st.db)
    .await
    .unwrap();
    let failed: Result<Outcome, Failure> = Err("unreadable audio".into());
    store::record(&st.db, 1, &failed).await.unwrap();
    let (_, body) = call(&app, &t, "GET", "/api/items/1/karaoke", None).await;
    let state = json_of(&body);
    assert_eq!(state["state"], "failed");
    assert_eq!(
        state["error"],
        json!({"code": "failed", "message": "unreadable audio"})
    );
    let reader = session::token(&st, 2, "reader").await;
    let (_, body) = call(&app, &reader, "GET", "/api/items/1/karaoke", None).await;
    assert_eq!(json_of(&body)["error"], json!({"code": "failed"}));
    assert!(
        store::unprepared(&st.db, &[], 10, M, false)
            .await
            .unwrap()
            .is_empty()
    );
    // A passing failure does not keep the track out.
    let down: Result<Outcome, Failure> = Err(Failure::EngineUnavailable {
        message: "down".into(),
    });
    store::record(&st.db, 1, &down).await.unwrap();
    assert_eq!(
        store::unprepared(&st.db, &[], 10, M, false).await.unwrap(),
        [1]
    );
    // A rejection survives a run that did no lyrics step, and a success clears the error.
    let rejected = Outcome {
        lyrics_error: Some(Failure::NoWordTimed),
        lyrics_ran: true,
        rejected: Some(("a".into(), "t".into())),
        ..Default::default()
    };
    store::record(&st.db, 1, &Ok(rejected)).await.unwrap();
    store::record(&st.db, 1, &Ok(Outcome::default()))
        .await
        .unwrap();
    let kept = store::failure(&st.db, 1).await.unwrap().unwrap();
    assert_eq!(
        (kept.rejected(), kept.error),
        (Some(("a".into(), "t".into())), None)
    );
    let (_, body) = call(&app, &t, "GET", "/api/items/1/karaoke", None).await;
    let state = json_of(&body);
    assert_eq!(
        (&state["state"], &state["lyricsError"]),
        (&json!("none"), &json!({"code": "no_word_timed"}))
    );
    assert_eq!(
        call(&app, &t, "DELETE", "/api/items/1/karaoke", None)
            .await
            .0,
        204
    );
    assert!(store::failure(&st.db, 1).await.unwrap().is_none());
}

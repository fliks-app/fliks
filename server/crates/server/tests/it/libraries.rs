//! `/api/libraries/*` and the ACL helpers (`docs/spec/libraries.md`) through the real router on a fresh database.
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, libraries, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    st: AppState,
    admin: String,
    user: String,
    tmp: std::path::PathBuf,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::query(r#"INSERT INTO roles (name, permissions) VALUES ('lib', '["settings.access","media.read"]')"#)
        .execute(&pool)
        .await
        .unwrap();
    let mut toks = vec![];
    for (name, admin, role) in [("admin", true, false), ("user", false, true)] {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin", "roleId") VALUES ($1, $2, (SELECT id FROM roles WHERE $3 LIMIT 1)) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();
        toks.push(session::token(&st, id, name).await);
    }
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    let tmp = std::env::temp_dir().join(format!("fliks-lib-{}", uuid_like()));
    Ctx {
        app,
        st,
        user: toks.pop().unwrap(),
        admin: toks.pop().unwrap(),
        tmp,
    }
}

fn uuid_like() -> String {
    format!("{:?}-{}", std::thread::current().id(), std::process::id()).replace(['(', ')'], "")
}

async fn call(c: &Ctx, method: &str, uri: &str, tok: &str, body: Value) -> (u16, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {tok}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let res = c.app.clone().oneshot(req).await.unwrap();
    let status = res.status().as_u16();
    let b = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

#[sqlx::test(migrations = false)]
async fn path_state_machine_creates_last(pool: PgPool) {
    let c = ctx(pool).await;
    let p = |s: &str| c.tmp.join(s).to_string_lossy().into_owned();
    let (s, lib) = call(
        &c,
        "POST",
        "/api/libraries",
        &c.admin,
        json!({"name": "A", "path": p("a/b")}),
    )
    .await;
    assert_eq!(s, 201);
    assert!(c.tmp.join("a/b").is_dir());
    assert_eq!(lib["disk"]["accessible"], true);
    let id = lib["id"].as_i64().unwrap();
    // relative path and a taken path create nothing
    let (s, _) = call(
        &c,
        "POST",
        "/api/libraries",
        &c.admin,
        json!({"name": "R", "path": "rel/x"}),
    )
    .await;
    assert_eq!(s, 400);
    assert!(!std::path::Path::new("rel/x").exists());
    let (s, b) = call(
        &c,
        "POST",
        "/api/libraries",
        &c.admin,
        json!({"name": "D", "path": p("a/b")}),
    )
    .await;
    assert_eq!(
        (
            s,
            b["message"].as_str().unwrap().contains("already attached")
        ),
        (400, true)
    );
    // library with media: changing the path is refused before mkdir, clearing too
    sqlx::query(r#"INSERT INTO media (title, type, "libraryId") VALUES ('m', 'movie', $1)"#)
        .bind(id as i32)
        .execute(&c.st.db)
        .await
        .unwrap();
    let (s, _) = call(
        &c,
        "PATCH",
        &format!("/api/libraries/{id}"),
        &c.admin,
        json!({"path": p("moved")}),
    )
    .await;
    assert_eq!(s, 400);
    assert!(!c.tmp.join("moved").exists());
    let (s, _) = call(
        &c,
        "PATCH",
        &format!("/api/libraries/{id}"),
        &c.admin,
        json!({"path": ""}),
    )
    .await;
    assert_eq!(s, 400);
    // same path is a no-op, a missing directory is not recreated
    std::fs::remove_dir_all(c.tmp.join("a")).unwrap();
    let (s, _) = call(
        &c,
        "PATCH",
        &format!("/api/libraries/{id}"),
        &c.admin,
        json!({"path": p("a/b")}),
    )
    .await;
    assert_eq!(s, 200);
    assert!(!c.tmp.join("a").exists());
    let _ = std::fs::remove_dir_all(&c.tmp);
}

#[sqlx::test(migrations = false)]
async fn validation_conflicts_and_acl(pool: PgPool) {
    let c = ctx(pool).await;
    for (body, want) in [
        (json!({"name": "A"}), 201),
        (json!({"name": "A"}), 409),
        (json!({"name": "B", "defaultQualityProfileId": 999}), 400),
        (json!({"name": "B", "userIds": [999]}), 400),
        (json!({"name": "B", "userIds": [1, 1]}), 400),
        (json!({"name": "B", "icon": "x".repeat(49)}), 400),
        (json!({"name": "B", "mediaTypes": ["music"]}), 400),
        (json!({"name": "B", "mediaTypes": ["album", "book"]}), 400),
        (json!({"name": "M", "mediaTypes": ["album"]}), 201),
    ] {
        assert_eq!(
            call(&c, "POST", "/api/libraries", &c.admin, body.clone())
                .await
                .0,
            want,
            "{body}"
        );
    }
    let (s, _) = call(
        &c,
        "PATCH",
        "/api/libraries/1",
        &c.admin,
        json!({"name": null}),
    )
    .await;
    assert_eq!(s, 400);
    let (s, _) = call(&c, "GET", "/api/libraries/007", &c.admin, json!(null)).await;
    assert_eq!(s, 400);
    // non-admin with settings.access: the ACL hides libraries outside its rows
    let (s, b) = call(&c, "GET", "/api/libraries/1", &c.user, json!(null)).await;
    assert_eq!(
        (s, b["message"].clone()),
        (404, json!("Library #1 not found"))
    );
    let (s, _) = call(
        &c,
        "PUT",
        "/api/libraries/1/access",
        &c.admin,
        json!({"userIds": [2, 1]}),
    )
    .await;
    assert_eq!(s, 200);
    let (_, ids) = call(&c, "GET", "/api/libraries/1/access", &c.admin, json!(null)).await;
    assert_eq!(ids, json!([2, 1]));
    assert_eq!(
        call(&c, "GET", "/api/libraries/1/access", &c.user, json!(null))
            .await
            .0,
        200
    );
    assert_eq!(
        call(
            &c,
            "PUT",
            "/api/libraries/99/access",
            &c.admin,
            json!({"userIds": []})
        )
        .await
        .0,
        404
    );
    // an update that changes nothing does not bump updatedAt
    let before = call(&c, "GET", "/api/libraries/1", &c.admin, json!(null))
        .await
        .1;
    let after = call(&c, "PATCH", "/api/libraries/1", &c.admin, json!({}))
        .await
        .1;
    assert_eq!(before["updatedAt"], after["updatedAt"]);
    assert_eq!(
        call(&c, "GET", "/api/libraries/mine", &c.user, json!(null))
            .await
            .1
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrations = false)]
async fn acl_helpers(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    for n in ["A", "B"] {
        sqlx::query("INSERT INTO libraries (name) VALUES ($1)")
            .bind(n)
            .execute(&pool)
            .await
            .unwrap();
    }
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES (2, 1)"#)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO media (title, type, "libraryId") VALUES ('in', 'movie', 1), ('out', 'movie', 2), ('none', 'movie', NULL)"#)
        .execute(&pool)
        .await
        .unwrap();
    let authed = |id: i32| {
        let st = c.st.clone();
        async move {
            let u = fliks_server::http::auth::load_enabled(&st.db, id)
                .await
                .unwrap()
                .unwrap();
            fliks_server::http::auth::Authed {
                perms: fliks_domain::acl::Permissions::from(
                    u.1.as_ref()
                        .map(|r| r.permissions.as_slice())
                        .unwrap_or(&[]),
                    u.0.is_admin,
                ),
                user: u.0,
                role: u.1,
                scope: None,
                session: None,
            }
        }
    };
    sqlx::query(r#"INSERT INTO roles (name, permissions) VALUES ('all', '["manage:all"]')"#)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO users (username, "roleId") VALUES ('root', (SELECT id FROM roles WHERE name = 'all')), ('none', (SELECT id FROM roles WHERE name = 'lib'))"#)
        .execute(&pool)
        .await
        .unwrap();
    let (admin, user) = (authed(1).await, authed(2).await);
    let mut root = libraries::accessible_library_ids(&pool, &authed(3).await)
        .await
        .unwrap();
    root.sort();
    assert_eq!(root, vec![1, 2]);
    assert!(
        libraries::accessible_library_ids(&pool, &authed(4).await)
            .await
            .unwrap()
            .is_empty()
    );
    let mut all = libraries::accessible_library_ids(&pool, &admin)
        .await
        .unwrap();
    all.sort();
    assert_eq!(all, vec![1, 2]);
    let mine = libraries::accessible_library_ids(&pool, &user)
        .await
        .unwrap();
    assert_eq!(mine, vec![1]);
    assert!(
        libraries::assert_media_accessible(&pool, 1, &mine)
            .await
            .is_ok()
    );
    for id in [2, 3, 99] {
        let e = libraries::assert_media_accessible(&pool, id, &mine)
            .await
            .unwrap_err();
        let body = axum::response::IntoResponse::into_response(e);
        assert_eq!(body.status(), 404);
    }
    assert!(
        libraries::assert_media_accessible(&pool, 3, &all)
            .await
            .is_err()
    );
}

fn dir(c: &Ctx, name: &str) -> String {
    let p = c.tmp.join(name);
    std::fs::create_dir_all(&p).unwrap();
    p.to_string_lossy().into_owned()
}

#[sqlx::test(migrations = false)]
async fn folder_routes_enforce_overlap_reserved_and_order(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    for n in ["A", "B"] {
        let b = json!({ "name": n });
        assert_eq!(call(&c, "POST", "/api/libraries", &c.admin, b).await.0, 201);
    }
    let add = |lib: i32, path: String| {
        let c = &c;
        async move {
            call(
                c,
                "POST",
                &format!("/api/libraries/{lib}/folders"),
                &c.admin,
                json!({"path": path}),
            )
            .await
        }
    };
    let (s, f1) = add(1, dir(&c, "m/films")).await;
    assert_eq!(
        (s, f1["position"].clone(), f1["mediaCount"].clone()),
        (201, json!(0), json!(0))
    );
    assert_eq!(f1["disk"]["accessible"], json!(true));
    let (s, f2) = add(1, dir(&c, "m/anime")).await;
    assert_eq!((s, f2["position"].clone()), (201, json!(1)));
    // the same directory, one inside the other, either way, in this library or another
    for (lib, p) in [
        (1, c.tmp.join("m/films")),
        (2, c.tmp.join("m/films")),
        (1, c.tmp.join("m/films/sub")),
        (2, c.tmp.join("m")),
    ] {
        let (s, b) = add(lib, p.to_string_lossy().into_owned()).await;
        assert_eq!(
            (s, b["message"].clone()),
            (409, json!("errors.folder_overlap")),
            "{p:?}"
        );
    }
    let (s, b) = add(1, "/".into()).await;
    assert_eq!(
        (s, b["message"].clone()),
        (400, json!("errors.folder_reserved"))
    );
    let data = fliks_server::paths::data_dir()
        .to_string_lossy()
        .into_owned();
    assert_eq!(add(1, data).await.0, 400);
    assert_eq!(add(1, "relative/dir".into()).await.0, 400);
    assert_eq!(add(1, "  ".into()).await.0, 400);
    assert_eq!(add(99, dir(&c, "x")).await.0, 404);
    assert!(!c.tmp.join("m/films/sub").exists());

    // `path` of the library is the first folder; with several folders it is refused
    let (_, lib) = call(&c, "GET", "/api/libraries/1", &c.admin, json!(null)).await;
    assert_eq!(lib["path"], f1["path"]);
    assert_eq!(lib["folders"].as_array().unwrap().len(), 2);
    let body = json!({"path": dir(&c, "z")});
    assert_eq!(
        call(&c, "PATCH", "/api/libraries/1", &c.admin, body)
            .await
            .0,
        400
    );

    // /mine lists the choices without a path
    let (_, mine) = call(&c, "GET", "/api/libraries/mine", &c.admin, json!(null)).await;
    assert_eq!(
        mine[0]["folders"],
        json!([{"id": f1["id"], "name": "films"}, {"id": f2["id"], "name": "anime"}])
    );

    // position is the target index and renumbers
    let url = |f: &Value| format!("/api/libraries/1/folders/{}", f["id"]);
    let (s, moved) = call(&c, "PATCH", &url(&f2), &c.admin, json!({"position": 0})).await;
    assert_eq!((s, moved["position"].clone()), (200, json!(0)));
    let (_, lib) = call(&c, "GET", "/api/libraries/1", &c.admin, json!(null)).await;
    assert_eq!(lib["path"], f2["path"]);
    assert_eq!(lib["folders"][1]["position"], json!(1));
    assert_eq!(
        call(&c, "PATCH", &url(&f2), &c.admin, json!({"position": -1}))
            .await
            .0,
        400
    );
    assert_eq!(
        call(
            &c,
            "PATCH",
            "/api/libraries/1/folders/999",
            &c.admin,
            json!({})
        )
        .await
        .0,
        404
    );
    assert_eq!(
        call(
            &c,
            "PATCH",
            "/api/libraries/2/folders/1",
            &c.admin,
            json!({})
        )
        .await
        .0,
        404
    );

    // a folder holding a file cannot be relocated to a tree without it, nor deleted
    sqlx::query(r#"INSERT INTO media (title, type, "libraryId", "folderName") VALUES ('T', 'movie', 1, 'T (2020)')"#)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES (1, 'T (2020)/t.mkv', 1, 'x', $1)"#)
        .bind(f1["id"].as_i64().unwrap() as i32)
        .execute(&pool)
        .await
        .unwrap();
    let elsewhere = c.tmp.join("moved").to_string_lossy().into_owned();
    let body = json!({"path": elsewhere});
    let (s, b) = call(&c, "PATCH", &url(&f1), &c.admin, body.clone()).await;
    assert_eq!(
        (s, b["message"].clone()),
        (409, json!("errors.folder_relocation_mismatch"))
    );
    std::fs::create_dir_all(c.tmp.join("moved/T (2020)")).unwrap();
    let (s, b) = call(&c, "PATCH", &url(&f1), &c.admin, body).await;
    assert_eq!(
        (s, b["path"].clone(), b["mediaCount"].clone()),
        (200, json!(elsewhere), json!(1))
    );
    let (s, b) = call(&c, "DELETE", &url(&f1), &c.admin, json!(null)).await;
    assert_eq!(
        (s, b["message"].clone()),
        (409, json!("errors.folder_in_use"))
    );
    let forced = format!("{}?removeMedia=true", url(&f1));
    assert_eq!(
        call(&c, "DELETE", &forced, &c.admin, json!(null)).await.0,
        200
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    let (_, lib) = call(&c, "GET", "/api/libraries/1", &c.admin, json!(null)).await;
    assert_eq!(lib["folders"].as_array().unwrap().len(), 1);
    assert_eq!(lib["folders"][0]["position"], json!(0));
    assert_eq!(
        call(&c, "DELETE", &url(&f2), &c.admin, json!(null)).await.0,
        200
    );
}

#[sqlx::test(migrations = false)]
async fn concurrent_adds_of_one_path_make_one_folder(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    for n in ["A", "B"] {
        call(&c, "POST", "/api/libraries", &c.admin, json!({ "name": n })).await;
    }
    let path = c.tmp.join("race").to_string_lossy().into_owned();
    let (a, b) = tokio::join!(
        call(
            &c,
            "POST",
            "/api/libraries/1/folders",
            &c.admin,
            json!({"path": path})
        ),
        call(
            &c,
            "POST",
            "/api/libraries/2/folders",
            &c.admin,
            json!({"path": path})
        ),
    );
    let mut got = [a.0, b.0];
    got.sort_unstable();
    assert_eq!(got, [201, 409]);
}

#[sqlx::test(migrations = false)]
async fn folder_of_another_library_is_refused_on_a_request(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    for n in ["A", "B"] {
        call(&c, "POST", "/api/libraries", &c.admin, json!({ "name": n })).await;
    }
    let body = json!({"path": dir(&c, "b")});
    let (_, f) = call(&c, "POST", "/api/libraries/2/folders", &c.admin, body).await;
    sqlx::query("INSERT INTO quality_profiles (id, name, cutoff, items) VALUES (1, 'P', 1, '[]')")
        .execute(&pool)
        .await
        .unwrap();
    let req = |library: i32| json!({"mediaType": "movie", "tmdbId": 603, "title": "T", "libraryId": library, "folderId": f["id"], "qualityProfileId": 1});
    let (s, b) = call(&c, "POST", "/api/requests", &c.admin, req(1)).await;
    assert_eq!(
        (s, b["message"].clone()),
        (400, json!("errors.folder_not_in_library"))
    );
    let (s, _) = call(&c, "POST", "/api/requests", &c.admin, req(2)).await;
    assert_eq!(s, 201);
    let stored: Option<i32> = sqlx::query_scalar(r#"SELECT "folderId" FROM requests"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, f["id"].as_i64().map(|i| i as i32));
}

async fn folder_pair(c: &Ctx) -> (i32, i32) {
    call(c, "POST", "/api/libraries", &c.admin, json!({"name": "A"})).await;
    let mut ids = vec![];
    for n in ["f1", "f2"] {
        let body = json!({"path": dir(c, n)});
        let (_, f) = call(c, "POST", "/api/libraries/1/folders", &c.admin, body).await;
        ids.push(f["id"].as_i64().unwrap() as i32);
    }
    (ids[0], ids[1])
}

async fn media_with_files(pool: &PgPool, title: &str, folders: &[i32]) -> i32 {
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, type, "libraryId", "folderName") VALUES ($1, 'movie', 1, $1) RETURNING id"#,
    )
    .bind(title)
    .fetch_one(pool)
    .await
    .unwrap();
    let mut c = pool.acquire().await.unwrap();
    let kind = fliks_domain::media::kind::MediaKind::Movie;
    fliks_server::media::items::create_shell(&mut c, id, kind, Default::default())
        .await
        .unwrap();
    for (i, f) in folders.iter().enumerate() {
        sqlx::query(r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES ($1, $2, 1, 'x', $3)"#)
            .bind(id)
            .bind(format!("{title}/{i}.mkv"))
            .bind(f)
            .execute(&mut *c)
            .await
            .unwrap();
    }
    id
}

fn spawn_call(
    c: &Ctx,
    method: &'static str,
    uri: String,
    body: Value,
) -> tokio::task::JoinHandle<(u16, Value)> {
    let (app, tok) = (c.app.clone(), c.admin.clone());
    tokio::spawn(async move {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {tok}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let b = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
    })
}

#[sqlx::test(migrations = false)]
async fn folder_delete_removes_only_the_media_that_live_in_it(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    media_with_files(&pool, "Only", &[f1]).await;
    let both = media_with_files(&pool, "Both", &[f1, f2]).await;
    let url = format!("/api/libraries/1/folders/{f1}?removeMedia=true");
    let (s, b) = call(&c, "DELETE", &url, &c.admin, json!(null)).await;
    assert_eq!(
        (s, b),
        (200, json!({"removedMedia": 1, "unlinkedMedia": 1}))
    );
    let left: Vec<(i32, i32)> = sqlx::query_as(r#"SELECT "mediaId", "folderId" FROM media_files"#)
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(left, vec![(both, f2)]);
    let media: Vec<i32> = sqlx::query_scalar("SELECT id FROM media ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(media, vec![both]);
}

#[sqlx::test(migrations = false)]
async fn folder_delete_waits_for_media_locks_without_a_connection_and_takes_late_media(
    pool: PgPool,
) {
    let c = ctx(pool.clone()).await;
    let (f1, _) = folder_pair(&c).await;
    let first = media_with_files(&pool, "First", &[f1]).await;
    let held = c.st.ingest.media.lock(first).await;
    let url = format!("/api/libraries/1/folders/{f1}?removeMedia=true");
    let del = spawn_call(&c, "DELETE", url, json!(null));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!del.is_finished());
    assert_eq!(
        pool.size() as usize - pool.num_idle(),
        0,
        "a connection is held while waiting"
    );
    // an ingest landing in the folder meanwhile is taken too, never a 409 after the first is gone
    let late = media_with_files(&pool, "Late", &[f1]).await;
    drop(held);
    let (s, body) = del.await.unwrap();
    assert_eq!(
        (s, body),
        (200, json!({"removedMedia": 2, "unlinkedMedia": 0}))
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media WHERE id = ANY($1)")
        .bind(vec![first, late])
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test(migrations = false)]
async fn folder_relocation_and_ingest_exclude_each_other(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, _) = folder_pair(&c).await;
    let reading = c.st.folder_moves.read().await;
    let url = format!("/api/libraries/1/folders/{f1}");
    let patch = spawn_call(&c, "PATCH", url, json!({"path": dir(&c, "elsewhere")}));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!patch.is_finished(), "a path change ran under an ingest");
    drop(reading);
    assert_eq!(patch.await.unwrap().0, 200);

    let writing = c.st.folder_moves.write().await;
    let guard = c.st.ingest.media.lock(999).await;
    let st = c.st.clone();
    let ingest = tokio::spawn(async move {
        let req = fliks_server::ingest::library::Request {
            media_id: 999,
            files: vec![],
            transfer: fliks_server::ingest::transfer::Method::Copy,
            fallback_quality: None,
            release_name: None,
            force: false,
            uniquify_on_collision: false,
            replace_existing: false,
            language: None,
        };
        fliks_server::ingest::library::ingest(&st, &guard, req)
            .await
            .is_err()
    });
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!ingest.is_finished(), "an ingest ran under a relocation");
    drop(writing);
    assert!(ingest.await.unwrap());
}

#[sqlx::test(migrations = false)]
async fn a_media_keeps_the_folder_its_wants_were_created_with(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Kept", &[]).await;
    let want = || async {
        sqlx::query_scalar::<_, Option<i32>>(r#"SELECT "folderId" FROM wants WHERE "mediaId" = $1"#)
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    assert_eq!(want().await, Some(f1));
    // a new default folder moves no existing media
    let url = format!("/api/libraries/1/folders/{f2}");
    call(&c, "PATCH", &url, &c.admin, json!({"position": 0})).await;
    assert_eq!(want().await, Some(f1));
    // another library: its default folder
    call(&c, "POST", "/api/libraries", &c.admin, json!({"name": "B"})).await;
    let body = json!({"path": dir(&c, "g")});
    let (_, g) = call(&c, "POST", "/api/libraries/2/folders", &c.admin, body).await;
    let url = format!("/api/media/{id}/library");
    let (s, _) = call(&c, "PATCH", &url, &c.admin, json!({"libraryId": 2})).await;
    assert_eq!(s, 200);
    assert_eq!(want().await.map(i64::from), g["id"].as_i64());
}

#[sqlx::test(migrations = false)]
async fn removing_a_media_clears_its_directory_in_every_folder(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Multi", &[f1, f2]).await;
    for f in ["f1", "f2"] {
        std::fs::create_dir_all(c.tmp.join(f).join("Multi")).unwrap();
    }
    let guard = c.st.ingest.media.lock(id).await;
    let (_, dirs) = fliks_server::media::write::remove_media_with_dir(&c.st, &guard, id)
        .await
        .unwrap();
    let mut dirs: Vec<_> = dirs.into_iter().map(|d| d.dir).collect();
    dirs.sort();
    assert_eq!(dirs, vec![c.tmp.join("f1/Multi"), c.tmp.join("f2/Multi")]);
}

#[sqlx::test(migrations = false)]
async fn a_media_dir_reached_through_a_symlink_in_another_folder_is_kept(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Shared", &[f1]).await;
    media_with_files(&pool, "Link", &[f2]).await;
    std::fs::create_dir_all(c.tmp.join("f1/Shared")).unwrap();
    std::os::unix::fs::symlink(c.tmp.join("f1/Shared"), c.tmp.join("f2/Link")).unwrap();
    let guard = c.st.ingest.media.lock(id).await;
    let (_, dirs) = fliks_server::media::write::remove_media_with_dir(&c.st, &guard, id)
        .await
        .unwrap();
    assert!(dirs.is_empty(), "{dirs:?}");
}

#[sqlx::test(migrations = false)]
async fn a_legacy_path_change_waits_for_the_folder_lock(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    call(&c, "POST", "/api/libraries", &c.admin, json!({"name": "A"})).await;
    let reading = c.st.folder_moves.read().await;
    let uri = "/api/libraries/1".to_string();
    let patch = spawn_call(&c, "PATCH", uri, json!({"path": dir(&c, "p")}));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        !patch.is_finished(),
        "a legacy path change ran under an ingest"
    );
    drop(reading);
    assert_eq!(patch.await.unwrap().0, 200);
}

#[sqlx::test(migrations = false)]
async fn folder_delete_points_the_remaining_wants_at_the_new_default(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let idle = media_with_files(&pool, "Idle", &[]).await;
    let url = format!("/api/libraries/1/folders/{f1}");
    let (s, _) = call(&c, "DELETE", &url, &c.admin, json!(null)).await;
    assert_eq!(s, 200);
    let want: Option<i32> =
        sqlx::query_scalar(r#"SELECT "folderId" FROM wants WHERE "mediaId" = $1 LIMIT 1"#)
            .bind(idle)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(want, Some(f2));
}

fn put(c: &Ctx, rel: &str, bytes: &[u8]) {
    let p = c.tmp.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, bytes).unwrap();
}

async fn folder_of_file(pool: &PgPool, media: i32) -> i32 {
    sqlx::query_scalar(
        r#"SELECT "folderId" FROM media_files WHERE "mediaId" = $1 ORDER BY id LIMIT 1"#,
    )
    .bind(media)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// The detached move settles when its activity entry is gone.
async fn settled(c: &Ctx) {
    for _ in 0..100 {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        if c.st.hub.activity().list(1, 10).total == 0 {
            return;
        }
    }
    panic!("the move did not settle");
}

#[sqlx::test(migrations = false)]
async fn a_move_keeps_the_rows_and_carries_files_and_sidecars(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1, f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    put(&c, "f1/Mv/1.mkv", b"one");
    put(&c, "f1/Mv/0.en.srt", b"sub");
    let file: i32 = sqlx::query_scalar(
        r#"SELECT id FROM media_files WHERE "mediaId" = $1 ORDER BY id LIMIT 1"#,
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO subtitle_files (language, "providerType", "filePath", "mediaId", "mediaFileId") VALUES ('en', 'disk', $1, $2, $3)"#)
        .bind(c.tmp.join("f1/Mv/0.en.srt").to_string_lossy().into_owned())
        .bind(id)
        .bind(file)
        .execute(&pool)
        .await
        .unwrap();
    let (s, _) = call(
        &c,
        "POST",
        &format!("/api/media/{id}/move"),
        &c.admin,
        json!({"folderId": f2}),
    )
    .await;
    assert_eq!(s, 202);
    settled(&c).await;
    for n in ["0.mkv", "1.mkv", "0.en.srt"] {
        assert!(c.tmp.join("f2/Mv").join(n).is_file(), "{n}");
        assert!(!c.tmp.join("f1/Mv").join(n).exists(), "{n} left behind");
    }
    assert!(
        !c.tmp.join("f1/Mv").exists(),
        "the emptied directory is pruned"
    );
    let rows: Vec<(i32, i32)> = sqlx::query_as(
        r#"SELECT id, "folderId" FROM media_files WHERE "mediaId" = $1 ORDER BY id"#,
    )
    .bind(id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(
        rows.iter().all(|r| r.1 == f2) && rows[0].0 == file,
        "{rows:?}"
    );
    let sub: String =
        sqlx::query_scalar(r#"SELECT "filePath" FROM subtitle_files WHERE "mediaId" = $1"#)
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(sub, "Mv/0.en.srt");
    let want: Option<i32> =
        sqlx::query_scalar(r#"SELECT "folderId" FROM wants WHERE "mediaId" = $1 LIMIT 1"#)
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(want, Some(f2));
}

#[sqlx::test(migrations = false)]
async fn a_move_never_overwrites_and_changes_nothing_when_refused(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1, f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    put(&c, "f1/Mv/1.mkv", b"one");
    put(&c, "f2/Mv/1.mkv", b"foreign");
    let uri = format!("/api/media/{id}/move");
    let (s, _) = call(&c, "POST", &uri, &c.admin, json!({"folderId": f2})).await;
    assert_eq!(s, 202);
    settled(&c).await;
    assert_eq!(
        std::fs::read(c.tmp.join("f2/Mv/1.mkv")).unwrap(),
        b"foreign"
    );
    assert!(
        !c.tmp.join("f2/Mv/0.mkv").exists(),
        "nothing is placed before the checks pass"
    );
    assert!(c.tmp.join("f1/Mv/0.mkv").is_file() && c.tmp.join("f1/Mv/1.mkv").is_file());
    assert_eq!(folder_of_file(&pool, id).await, f1);
}

#[sqlx::test(migrations = false)]
async fn a_rerun_recognises_its_own_copy_and_resumes(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    std::fs::create_dir_all(c.tmp.join("f2/Mv")).unwrap();
    std::fs::hard_link(c.tmp.join("f1/Mv/0.mkv"), c.tmp.join("f2/Mv/0.mkv")).unwrap();
    let uri = format!("/api/media/{id}/move");
    assert_eq!(
        call(&c, "POST", &uri, &c.admin, json!({"folderId": f2}))
            .await
            .0,
        202
    );
    settled(&c).await;
    assert_eq!(folder_of_file(&pool, id).await, f2);
    assert!(!c.tmp.join("f1/Mv/0.mkv").exists());
    assert_eq!(std::fs::read(c.tmp.join("f2/Mv/0.mkv")).unwrap(), b"zero");
}

#[sqlx::test(migrations = false)]
async fn changing_library_moves_the_files_and_the_move_waits_for_ingest(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, _) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    call(
        &c,
        "POST",
        "/api/libraries",
        &c.admin,
        json!({"name": "B", "path": dir(&c, "lib-b")}),
    )
    .await;
    let reading = c.st.folder_moves.read().await;
    let uri = format!("/api/media/{id}/library");
    assert_eq!(
        call(&c, "PATCH", &uri, &c.admin, json!({"libraryId": 2}))
            .await
            .0,
        202
    );
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(
        c.tmp.join("f1/Mv/0.mkv").is_file(),
        "a move ran under an ingest"
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("/api/media/{id}/move"),
            &c.admin,
            json!({"folderId": f1})
        )
        .await
        .0,
        409,
        "one move at a time"
    );
    drop(reading);
    settled(&c).await;
    assert!(c.tmp.join("lib-b/Mv/0.mkv").is_file());
    let lib: Option<i32> = sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(lib, Some(2));
}

async fn move_to(c: &Ctx, id: i32, folder: i32) -> u16 {
    let uri = format!("/api/media/{id}/move");
    call(c, "POST", &uri, &c.admin, json!({"folderId": folder}))
        .await
        .0
}

#[sqlx::test(migrations = false)]
async fn a_copy_that_is_not_the_same_file_is_not_taken_for_ours(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    put(&c, "f2/Mv/0.mkv", b"zero");
    assert_eq!(move_to(&c, id, f2).await, 202);
    settled(&c).await;
    assert_eq!(
        folder_of_file(&pool, id).await,
        f1,
        "an unrelated copy was adopted"
    );
    assert!(c.tmp.join("f1/Mv/0.mkv").is_file());
}

#[sqlx::test(migrations = false)]
async fn a_move_carries_same_stem_companions(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1]).await;
    for n in ["0.mkv", "0.idx", "0.sub", "0.edl", "0.nfo", "other.nfo"] {
        put(&c, &format!("f1/Mv/{n}"), n.as_bytes());
    }
    let file: i32 = sqlx::query_scalar(r#"SELECT id FROM media_files WHERE "mediaId" = $1"#)
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO subtitle_files (language, "providerType", "filePath", "mediaId", "mediaFileId") VALUES ('en', 'disk', 'Mv/0.sub', $1, $2)"#)
        .bind(id)
        .bind(file)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(move_to(&c, id, f2).await, 202);
    settled(&c).await;
    for n in ["0.mkv", "0.idx", "0.sub", "0.edl", "0.nfo"] {
        assert!(c.tmp.join("f2/Mv").join(n).is_file(), "{n} not carried");
        assert!(!c.tmp.join("f1/Mv").join(n).exists(), "{n} left behind");
    }
    assert!(c.tmp.join("f1/Mv/other.nfo").is_file());
    assert!(!c.tmp.join("f2/Mv/other.nfo").exists());
}

#[sqlx::test(migrations = false)]
async fn a_sidecar_another_media_lists_stays_in_the_source(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let a = media_with_files(&pool, "Mv", &[f1]).await;
    let b = media_with_files(&pool, "Other", &[f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    put(&c, "f1/Mv/0.en.srt", b"sub");
    for (m, rel) in [(a, "Mv/0.mkv"), (b, "Other/0.mkv")] {
        let file: i32 = sqlx::query_scalar(
            r#"SELECT id FROM media_files WHERE "mediaId" = $1 AND "relativePath" = $2"#,
        )
        .bind(m)
        .bind(rel)
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query(r#"INSERT INTO subtitle_files (language, "providerType", "filePath", "mediaId", "mediaFileId") VALUES ('en', 'disk', 'Mv/0.en.srt', $1, $2)"#)
            .bind(m)
            .bind(file)
            .execute(&pool)
            .await
            .unwrap();
    }
    assert_eq!(move_to(&c, a, f2).await, 202);
    settled(&c).await;
    assert!(c.tmp.join("f2/Mv/0.en.srt").is_file());
    assert!(
        c.tmp.join("f1/Mv/0.en.srt").is_file(),
        "the other media's sidecar was unlinked"
    );
    assert!(!c.tmp.join("f1/Mv/0.mkv").exists());
}

#[sqlx::test(migrations = false)]
async fn the_destination_is_read_again_under_the_lock(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    let reading = c.st.folder_moves.read().await;
    assert_eq!(move_to(&c, id, f2).await, 202);
    let moved = dir(&c, "f2-moved");
    sqlx::query("UPDATE library_folders SET path = $2 WHERE id = $1")
        .bind(f2)
        .bind(&moved)
        .execute(&pool)
        .await
        .unwrap();
    drop(reading);
    settled(&c).await;
    assert!(c.tmp.join("f2-moved/Mv/0.mkv").is_file());
    assert!(!c.tmp.join("f2/Mv").exists());
}

#[sqlx::test(migrations = false)]
async fn a_library_delete_keeps_a_media_that_moved_out(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[]).await;
    for n in ["B", "C"] {
        call(&c, "POST", "/api/libraries", &c.admin, json!({"name": n})).await;
    }
    sqlx::query(r#"UPDATE media SET "libraryId" = 2 WHERE id = $1"#)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    let guard = c.st.ingest.media.lock(id).await;
    let del = spawn_call(&c, "DELETE", "/api/libraries/2".into(), json!(null));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    sqlx::query(r#"UPDATE media SET "libraryId" = 3 WHERE id = $1"#)
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    drop(guard);
    assert_eq!(del.await.unwrap().0, 200);
    let lib: Option<i32> = sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
        .bind(id)
        .fetch_optional(&pool)
        .await
        .unwrap()
        .flatten();
    assert_eq!(lib, Some(3), "the moved media was removed with the library");
}

#[cfg(unix)]
#[sqlx::test(migrations = false)]
async fn a_source_left_after_the_commit_is_unlinked_by_the_next_run(pool: PgPool) {
    use std::os::unix::fs::PermissionsExt;
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    let src_dir = c.tmp.join("f1/Mv");
    std::fs::set_permissions(&src_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    if std::fs::File::create(src_dir.join("probe")).is_ok() {
        return; // permissions are not enforced (root)
    }
    assert_eq!(move_to(&c, id, f2).await, 202);
    settled(&c).await;
    let journal = || async {
        sqlx::query_as::<_, (String, bool)>(
            r#"SELECT plan::text, committed FROM media_moves WHERE "mediaId" = $1"#,
        )
        .bind(id)
        .fetch_optional(&pool)
        .await
        .unwrap()
    };
    let (plan, committed) = journal().await.expect("the pending unlink is journaled");
    assert!(committed && plan.contains("0.mkv"), "{plan}");
    assert!(src_dir.join("0.mkv").exists());
    std::fs::set_permissions(&src_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(move_to(&c, id, f2).await, 202);
    settled(&c).await;
    assert!(!src_dir.join("0.mkv").exists(), "the rerun left the source");
    assert!(journal().await.is_none());
    assert!(c.tmp.join("f2/Mv/0.mkv").is_file());
}

async fn journal_for(c: &Ctx, pool: &PgPool, id: i32, committed: bool, created: bool) {
    let (f1, f2) = (dir(c, "f1"), dir(c, "f2"));
    let plan = json!([{"folder": f1, "rel": "Mv/0.mkv", "from": format!("{f1}/Mv/0.mkv"),
        "to": format!("{f2}/Mv/0.mkv"), "keep": false, "dest_folder": f2, "created": created}]);
    sqlx::query(r#"INSERT INTO media_moves ("mediaId", plan, committed) VALUES ($1, $2, $3)"#)
        .bind(id)
        .bind(plan)
        .bind(committed)
        .execute(pool)
        .await
        .unwrap();
}

#[sqlx::test(migrations = false)]
async fn the_boot_sweep_unlinks_the_sources_of_a_committed_move(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (_, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f2]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    put(&c, "f2/Mv/.keep", b"");
    std::fs::hard_link(c.tmp.join("f1/Mv/0.mkv"), c.tmp.join("f2/Mv/0.mkv")).unwrap();
    journal_for(&c, &pool, id, true, true).await;
    fliks_server::media::write::recover(&c.st).await;
    assert!(!c.tmp.join("f1/Mv/0.mkv").exists());
    assert!(c.tmp.join("f2/Mv/0.mkv").is_file());
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM media_moves")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[sqlx::test(migrations = false)]
async fn the_boot_sweep_removes_the_copies_of_an_uncommitted_move(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (f1, _) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    put(&c, "f2/Mv/.keep", b"");
    std::fs::hard_link(c.tmp.join("f1/Mv/0.mkv"), c.tmp.join("f2/Mv/0.mkv")).unwrap();
    journal_for(&c, &pool, id, false, true).await;
    fliks_server::media::write::recover(&c.st).await;
    assert!(c.tmp.join("f1/Mv/0.mkv").is_file());
    assert!(!c.tmp.join("f2/Mv/0.mkv").exists());
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM media_moves")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[sqlx::test(migrations = false)]
async fn the_boot_sweep_keeps_a_source_with_no_identical_copy(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let (_, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f2]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    journal_for(&c, &pool, id, true, true).await;
    fliks_server::media::write::recover(&c.st).await;
    assert!(c.tmp.join("f1/Mv/0.mkv").is_file());
}

#[cfg(unix)]
#[sqlx::test(migrations = false)]
async fn a_stuck_source_survives_a_move_that_runs_before_it_is_freed(pool: PgPool) {
    use std::os::unix::fs::PermissionsExt;
    let c = ctx(pool.clone()).await;
    let (f1, f2) = folder_pair(&c).await;
    let id = media_with_files(&pool, "Mv", &[f1]).await;
    put(&c, "f1/Mv/0.mkv", b"zero");
    let src_dir = c.tmp.join("f1/Mv");
    std::fs::set_permissions(&src_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    if std::fs::File::create(src_dir.join("probe")).is_ok() {
        return; // permissions are not enforced (root)
    }
    assert_eq!(move_to(&c, id, f2).await, 202);
    settled(&c).await;
    assert_eq!(move_to(&c, id, f2).await, 202);
    settled(&c).await;
    let plan: String =
        sqlx::query_scalar(r#"SELECT plan::text FROM media_moves WHERE "mediaId" = $1"#)
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(plan.contains("0.mkv"), "{plan}");
    std::fs::set_permissions(&src_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(move_to(&c, id, f2).await, 202);
    settled(&c).await;
    assert!(!src_dir.join("0.mkv").exists());
}

#[sqlx::test(migrations = false)]
async fn orphan_relink_takes_a_body_past_the_json_cap(pool: PgPool) {
    let c = ctx(pool).await;
    for uri in [
        "/api/imports/library/orphans/relink-batch",
        "/api/imports/library/orphans/relink",
    ] {
        let big = json!({ "items": "x".repeat(200 * 1024) });
        assert_eq!(call(&c, "POST", uri, &c.admin, big).await.0, 400);
        let huge = json!({ "items": "x".repeat(17 << 20) });
        assert_eq!(call(&c, "POST", uri, &c.admin, huge).await.0, 413);
    }
    let big = json!({ "name": "x".repeat(200 * 1024) });
    assert_eq!(
        call(&c, "POST", "/api/libraries", &c.admin, big).await.0,
        413
    );
}

#[sqlx::test(migrations = false)]
async fn a_series_relinked_by_folder_takes_its_season_folders_and_loose_episodes(pool: PgPool) {
    let c = ctx(pool).await;
    let show = c.tmp.join("lib/Show A");
    for f in [
        "Season 01/Show A - S01E01.mkv",
        "Show A - S01E02.mkv",
        "Season 02/sub/Show A - S02E01.mkv",
        "Extras/Show A - S01E01 Behind.mkv",
        "notes.mkv",
    ] {
        let p = show.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"x").unwrap();
    }
    let lib = c.tmp.join("lib").to_string_lossy().into_owned();
    let (s, l) = call(
        &c,
        "POST",
        "/api/libraries",
        &c.admin,
        json!({"name": "S", "path": lib, "mediaTypes": ["series"]}),
    )
    .await;
    assert_eq!(s, 201);
    let relink =
        |folder: &str| json!({"libraryId": l["id"], "type": "series", "folderName": folder});
    let uri = "/api/imports/library/orphans/relink";
    let (s, b) = call(&c, "POST", uri, &c.admin, relink("Show A")).await;
    assert_eq!(
        (s, &b["linked"], &b["errors"]),
        (201, &json!(3), &json!([])),
        "{b}"
    );
    let eps: Vec<(i32, i32)> = sqlx::query_as(
        r#"SELECT s."number", e."number" FROM media_files f
           JOIN media_file_items fi ON fi."mediaFileId" = f.id JOIN items e ON e.id = fi."episodeId"
           JOIN item_groups s ON s.id = e."groupId" WHERE f."mediaId" = $1 ORDER BY 1, 2"#,
    )
    .bind(b["mediaId"].as_i64().unwrap() as i32)
    .fetch_all(&c.st.db)
    .await
    .unwrap();
    assert_eq!(eps, [(1, 1), (1, 2), (2, 1)]);
    assert_eq!(
        call(&c, "POST", uri, &c.admin, relink("../lib")).await.0,
        400
    );
    assert_eq!(
        call(&c, "POST", uri, &c.admin, relink("Missing")).await.0,
        400
    );
    let movie = json!({"libraryId": l["id"], "type": "movie", "folderName": "Show A"});
    assert_eq!(call(&c, "POST", uri, &c.admin, movie).await.0, 400);
    let _ = std::fs::remove_dir_all(&c.tmp);
}

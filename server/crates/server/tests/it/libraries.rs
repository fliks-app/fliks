//! `/api/libraries/*` and the ACL helpers (`docs/spec/libraries.md`) through the real router on a fresh database.
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
        toks.push(st.jwt.sign_access(id, name).unwrap().token);
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
    let req = |library: i32| json!({"mediaType": "movie", "tmdbId": 603, "title": "T", "libraryId": library, "folderId": f["id"]});
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
    let (_, mut dirs) = fliks_server::media::write::remove_media_with_dir(&c.st, &guard, id)
        .await
        .unwrap();
    dirs.sort();
    assert_eq!(dirs, vec![c.tmp.join("f1/Multi"), c.tmp.join("f2/Multi")]);
}

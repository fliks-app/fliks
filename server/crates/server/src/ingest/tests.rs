//! Write-path safety (`ingest.md` V1-V19, `media-write.md` V1-V3): generated trees under
//! `/tmp/fliks-parity/s5-ingest/tests`, a fake engine for the probes, a throwaway DB.
use super::fsx;
use crate::{
    app,
    config::Config,
    engine::testkit::{Fake, RUNTIME, hello_body, ok},
    state::AppState,
};
use axum::{body::Body, extract::Request};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    fs,
    os::unix::fs::symlink,
    path::{Path, PathBuf},
};
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

fn tmp() -> PathBuf {
    let d = PathBuf::from("/tmp/fliks-parity/s5-ingest/tests").join(crate::config::random_hex(6));
    fs::create_dir_all(&d).unwrap();
    d
}

fn touch(p: &Path, bytes: &[u8]) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, bytes).unwrap();
}

/// Every path and file content under `dir`, for "nothing else changed" assertions.
fn tree(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = vec![];
    fn walk(base: &Path, d: &Path, out: &mut Vec<(String, Vec<u8>)>) {
        let mut es: Vec<_> = fs::read_dir(d).unwrap().flatten().collect();
        es.sort_by_key(|e| e.file_name());
        for e in es {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
            let m = fs::symlink_metadata(&p).unwrap();
            if m.is_dir() {
                out.push((rel + "/", vec![]));
                walk(base, &p, out);
            } else if m.is_symlink() {
                out.push((
                    rel,
                    fs::read_link(&p)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                        .into_bytes(),
                ));
            } else {
                out.push((rel, fs::read(&p).unwrap()));
            }
        }
    }
    walk(dir, dir, &mut out);
    out
}

#[test]
fn no_replace_primitives() {
    let d = tmp();
    let (a, b) = (d.join("a"), d.join("b"));
    touch(&a, b"new");
    touch(&b, b"old");
    assert_eq!(
        fsx::rename_noreplace(&a, &b).unwrap_err().kind(),
        std::io::ErrorKind::AlreadyExists
    );
    assert!(!fsx::copy_noreplace(&a, &b).unwrap());
    assert_eq!(fs::read(&b).unwrap(), b"old");
    assert!(
        fs::read_dir(&d)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().starts_with(".fliks-tmp-"))
    );
    assert!(fsx::copy_noreplace(&a, &d.join("c")).unwrap());
    assert_eq!(fs::read(d.join("c")).unwrap(), b"new");
    assert!(fsx::move_file(&a, &d.join("m"), false).unwrap());
    assert!(!a.exists());
    fs::remove_dir_all(d).unwrap();
}

#[test]
fn stale_temps_are_reaped_regular_files_only() {
    let d = tmp();
    let old = d.join(".fliks-tmp-old");
    touch(&old, b"x");
    fs::create_dir(d.join(".fliks-tmp-dir")).unwrap();
    symlink("/etc/hosts", d.join(".fliks-tmp-link")).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    fsx::reap(&d, std::time::Duration::from_millis(1));
    assert!(!old.exists());
    assert!(
        d.join(".fliks-tmp-dir").exists()
            && fs::symlink_metadata(d.join(".fliks-tmp-link")).is_ok()
    );
    fs::remove_dir_all(d).unwrap();
}

#[test]
fn contained_unlinks() {
    let d = tmp();
    let (lib, outside) = (d.join("lib"), d.join("outside"));
    touch(&outside.join("secret.mkv"), b"s");
    touch(&lib.join("M/a.mkv"), b"a");
    symlink(outside.join("secret.mkv"), lib.join("M/link.mkv")).unwrap();
    symlink(&outside, lib.join("M/escape")).unwrap();
    let root = fsx::Root::open(lib.to_str().unwrap()).unwrap();
    // A symlink as the final file: the link goes, its target stays.
    assert_eq!(
        fsx::unlink_contained(&root, &lib.join("M/link.mkv")).unwrap(),
        fsx::Unlinked::Removed
    );
    assert!(outside.join("secret.mkv").exists());
    // A symlinked parent leading outside is refused.
    assert!(fsx::unlink_contained(&root, &lib.join("M/escape/secret.mkv")).is_err());
    assert!(outside.join("secret.mkv").exists());
    assert!(fsx::unlink_contained(&root, &lib.join("M")).is_err());
    assert_eq!(
        fsx::unlink_contained(&root, &lib.join("M/gone.mkv")).unwrap(),
        fsx::Unlinked::Missing
    );
    fs::remove_dir_all(d).unwrap();
}

#[test]
fn media_folder_removal_rules() {
    let d = tmp();
    let lib = d.join("lib");
    touch(&lib.join("A/a.mkv"), b"a");
    touch(&lib.join("4k/x.mkv"), b"x");
    touch(&d.join("outside/o.mkv"), b"o");
    symlink(d.join("outside"), lib.join("L")).unwrap();
    let root = fsx::Root::open(lib.to_str().unwrap()).unwrap();
    for bad in ["..", ".", "a/b", "a\\b", "/abs", "a\0"] {
        assert!(
            fsx::removable_media_dir(&root, bad, &[], &[]).is_err(),
            "{bad:?}"
        );
    }
    assert_eq!(fsx::removable_media_dir(&root, "", &[], &[]).unwrap(), None);
    assert_eq!(
        fsx::removable_media_dir(&root, "missing", &[], &[]).unwrap(),
        None
    );
    // A nested library root and a folder another media uses are kept.
    assert!(fsx::removable_media_dir(&root, "4k", &[lib.clone(), lib.join("4k")], &[]).is_err());
    assert!(
        fsx::removable_media_dir(&root, "A", std::slice::from_ref(&lib), &[lib.join("A")]).is_err()
    );
    assert!(
        fsx::removable_media_dir(&root, "A", std::slice::from_ref(&lib), &[lib.join("A/sub")])
            .is_err()
    );
    // A symlinked media folder: the link itself is what goes.
    let l = fsx::removable_media_dir(&root, "L", std::slice::from_ref(&lib), &[])
        .unwrap()
        .unwrap();
    fsx::remove_media_dir(&l).unwrap();
    assert!(d.join("outside/o.mkv").exists() && fs::symlink_metadata(lib.join("L")).is_err());
    let a = fsx::removable_media_dir(&root, "A", std::slice::from_ref(&lib), &[])
        .unwrap()
        .unwrap();
    fsx::remove_media_dir(&a).unwrap();
    assert!(!lib.join("A").exists() && lib.exists());
    fs::remove_dir_all(d).unwrap();
}

struct Ctx {
    app: axum::Router,
    st: AppState,
    fake: Fake,
    dir: PathBuf,
    admin: String,
    editor: String,
}

impl Drop for Ctx {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn probe_ok() -> Value {
    json!({"ok": true, "info": {"video": [{"streamIndex": 0, "codec": "h264", "width": 1920, "height": 1080}],
        "audio": [], "subtitles": [], "durationSeconds": 2.0}})
}

async fn ctx(pool: PgPool) -> Ctx {
    ctx_with(pool, None).await
}

async fn ctx_with(
    pool: PgPool,
    provider: Option<std::sync::Arc<dyn crate::metadata::MetadataProvider>>,
) -> Ctx {
    ctx_hello(pool, provider, hello_body(&RUNTIME, "x")).await
}

async fn ctx_hello(
    pool: PgPool,
    provider: Option<std::sync::Arc<dyn crate::metadata::MetadataProvider>>,
    hello: Value,
) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let fake = Fake::start().await;
    fake.hello(Some(hello));
    fake.script("POST", "/v1/probe", vec![ok(probe_ok())]);
    let env = [
        ("FLIKS_ENGINE_URL", fake.url.clone()),
        ("FLIKS_ENGINE_TOKEN", "tok".into()),
    ];
    let cfg = Config::from_lookup(|k| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()));
    let dir = tmp();
    let images =
        crate::images::ImageStore::with_root(dir.join("data"), &cfg.metadata.tmdb_image_url);
    let mut st = AppState::new(pool.clone(), cfg, SECRET);
    st.images = std::sync::Arc::new(images);
    if let Some(p) = provider {
        std::sync::Arc::get_mut(&mut st.metadata)
            .unwrap()
            .register(p);
    }
    st.engine.start_with(Some(pool.clone()), 4849).await;
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    sqlx::query(r#"INSERT INTO roles (id, name, permissions) VALUES (50, 'Editor', '["media.read","media.create","media.edit","media.delete"]')"#)
        .execute(&pool)
        .await
        .unwrap();
    let mut toks = vec![];
    for (name, admin, role) in [("admin", true, None), ("editor", false, Some(50))] {
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO users (username, "isAdmin", "roleId") VALUES ($1, $2, $3) RETURNING id"#,
        )
        .bind(name)
        .bind(admin)
        .bind(role)
        .fetch_one(&pool)
        .await
        .unwrap();
        toks.push(st.jwt.sign_access(id, name).unwrap().token);
    }
    Ctx {
        app,
        st,
        fake,
        dir,
        editor: toks.pop().unwrap(),
        admin: toks.pop().unwrap(),
    }
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
    let s = res.status().as_u16();
    let b = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

async fn library(c: &Ctx, name: &str, path: &Path, types: &str) -> i32 {
    fs::create_dir_all(path).unwrap();
    sqlx::query_scalar(r#"WITH l AS (INSERT INTO libraries (name, "mediaTypes") VALUES ($1, $3::jsonb) RETURNING id), f AS (INSERT INTO library_folders ("libraryId", path) SELECT id, $2 FROM l) SELECT id FROM l"#)
        .bind(name)
        .bind(path.to_string_lossy().as_ref())
        .bind(types)
        .fetch_one(&c.st.db)
        .await
        .unwrap()
}

async fn media(c: &Ctx, lib: i32, folder: &str, t: &str) -> i32 {
    let mut tx = c.st.db.begin().await.unwrap();
    let id = sqlx::query_scalar(r#"INSERT INTO media (title, type, "libraryId", "folderName") VALUES ($1, $2, $3, $1) RETURNING id"#)
        .bind(folder)
        .bind(t)
        .bind(lib)
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    crate::media::items::create_shell(
        &mut tx,
        id,
        fliks_domain::media::kind::MediaKind::parse(t).unwrap(),
        Default::default(),
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}

async fn file_row(c: &Ctx, m: i32, rel: &str) -> i32 {
    sqlx::query_scalar(r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId")
           SELECT m.id, CASE WHEN COALESCE(m."folderName", '') = '' THEN $2 ELSE m."folderName" || '/' || $2 END,
                  1, 'x', df."folderId"
           FROM media m JOIN library_default_folders df ON df."libraryId" = m."libraryId" WHERE m.id = $1
           RETURNING id"#)
        .bind(m)
        .bind(rel)
        .fetch_one(&c.st.db)
        .await
        .unwrap()
}

async fn count(c: &Ctx, sql: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(sql))
        .fetch_one(&c.st.db)
        .await
        .unwrap()
}

async fn eventually(f: impl Fn() -> bool) -> bool {
    for _ in 0..50 {
        if f() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    false
}

#[sqlx::test(migrations = false)]
async fn media_delete_removes_only_its_folder(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    touch(&lib.join("A (2020)/A (2020).mkv"), b"a");
    touch(&lib.join("A (2020)/user-notes.txt"), b"n");
    touch(&lib.join("B (2020)/B (2020).mkv"), b"b");
    touch(&c.dir.join("sentinel"), b"s");
    let a = media(&c, l, "A (2020)", "movie").await;
    media(&c, l, "B (2020)", "movie").await;
    file_row(&c, a, "A (2020).mkv").await;
    let (s, b) = call(
        &c,
        "DELETE",
        &format!("/api/media/{a}"),
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!((s, b), (200, json!({"ok": true})));
    assert!(eventually(|| !lib.join("A (2020)").exists()).await);
    assert!(lib.join("B (2020)/B (2020).mkv").exists() && c.dir.join("sentinel").exists());
    assert_eq!(count(&c, "SELECT count(*) FROM media").await, 1);
}

#[sqlx::test(migrations = false)]
async fn media_delete_keeps_shared_and_nested_folders(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    library(&c, "4K", &lib.join("4k"), r#"["movie"]"#).await;
    touch(&lib.join("S/S.mkv"), b"s");
    touch(&lib.join("4k/X/X.mkv"), b"x");
    let s1 = media(&c, l, "S", "movie").await;
    media(&c, l, "S", "movie").await;
    let n = media(&c, l, "4k", "movie").await;
    let before = tree(&lib);
    for id in [s1, n] {
        let (s, _) = call(
            &c,
            "DELETE",
            &format!("/api/media/{id}"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 200);
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(tree(&lib), before);
    assert_eq!(count(&c, "SELECT count(*) FROM media").await, 1);
}

#[sqlx::test(migrations = false)]
async fn file_delete_refuses_escaping_paths(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    touch(&c.dir.join("victim.mkv"), b"v");
    touch(&lib.join("A/A.mkv"), b"a");
    touch(&lib.join("A/A.edl"), b"1 2 0");
    let a = media(&c, l, "A", "movie").await;
    for rel in ["../../victim.mkv", "/etc/hosts", "a/../../b"] {
        let refused = sqlx::query(
            r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId")
               VALUES ($1, $2, 1, 'x', (SELECT min(id) FROM library_folders))"#,
        )
        .bind(a)
        .bind(rel)
        .execute(&c.st.db)
        .await;
        assert!(refused.is_err(), "{rel}");
    }
    assert!(c.dir.join("victim.mkv").exists());
    let f = file_row(&c, a, "A.mkv").await;
    let (s, _) = call(
        &c,
        "DELETE",
        &format!("/api/media/{a}/files/{f}"),
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!(s, 200);
    assert!(lib.join("A/A.mkv").exists());
    let f = file_row(&c, a, "A.mkv").await;
    let (s, _) = call(
        &c,
        "DELETE",
        &format!("/api/media/{a}/files/{f}?deleteOnDisk=true"),
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!(s, 200);
    assert!(!lib.join("A/A.mkv").exists() && !lib.join("A/A.edl").exists());
}

#[sqlx::test(migrations = false)]
async fn library_delete_keeps_the_tree(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    touch(&lib.join("A/A.mkv"), b"a");
    let a = media(&c, l, "A", "movie").await;
    file_row(&c, a, "A.mkv").await;
    let before = tree(&c.dir);
    let (s, _) = call(
        &c,
        "DELETE",
        &format!("/api/libraries/{l}"),
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!(s, 200);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert_eq!(tree(&c.dir), before);
    assert_eq!(count(&c, "SELECT count(*) FROM libraries").await, 0);
}

/// The `Scan` jobs submitted so far, once `want` of them arrived or 5 s passed (they are detached).
async fn scans(c: &Ctx, want: usize) -> usize {
    let n = || {
        let jobs = c.fake.seen("POST", "/v1/jobs");
        jobs.iter()
            .filter(|j| j.body["kind"]["type"] == "Scan")
            .count()
    };
    for _ in 0..50 {
        if n() >= want {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    n()
}

async fn rescan(c: &Ctx, id: i32) -> Result<super::rescan::Counts, crate::http::AppError> {
    let g = c.st.ingest.media.lock(id).await;
    super::rescan::rescan_files(&c.st, &g, id).await
}

#[sqlx::test(migrations = false)]
async fn rescan_refuses_a_missing_folder_and_reconciles(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("series");
    let l = library(&c, "S", &lib, r#"["series"]"#).await;
    let s = media(&c, l, "Show", "series").await;
    file_row(&c, s, "Season 01/Show - S01E01.mkv").await;
    let e = rescan(&c, s).await.unwrap_err();
    assert_eq!(e.status(), 400);
    assert!(!lib.join("Show").exists());
    assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 1);
    touch(&lib.join("Show/Season 01/Show - S01E02.mkv"), b"2");
    touch(&lib.join("Show/Extras/Show - S01E09.mkv"), b"bonus");
    touch(&lib.join("Show/Show - S01E03-sample.mkv"), b"s");
    touch(&lib.join("Show/a/b/c/d/Show - S01E07.mkv"), b"deep");
    touch(&lib.join("Show/notes.mkv"), b"alien");
    let c1 = rescan(&c, s).await.unwrap();
    assert_eq!((c1.added, c1.removed), (1, 1));
    let rows: Vec<String> =
        sqlx::query_scalar(r#"SELECT "relativePath" FROM media_files ORDER BY id"#)
            .fetch_all(&c.st.db)
            .await
            .unwrap();
    assert_eq!(rows, ["Show/Season 01/Show - S01E02.mkv"]);
    assert_eq!(
        count(&c, r#"SELECT count(DISTINCT "itemId") FROM item_parts"#).await,
        1
    );
    // A media with no rows and no folder: nothing to remove.
    let fresh = media(&c, l, "Fresh", "series").await;
    let z = rescan(&c, fresh).await.unwrap();
    assert_eq!((z.added, z.removed, z.updated), (0, 0, 0));
}

#[sqlx::test(migrations = false)]
async fn rescan_batches_slots_links_and_removals(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("series");
    let l = library(&c, "S", &lib, r#"["series"]"#).await;
    let s = media(&c, l, "Show", "series").await;
    let gone = file_row(&c, s, "Show - S02E09.mkv").await;
    let unlinked = file_row(&c, s, "Show - S01E01.mkv").await;
    for n in [
        "Show - S01E01.mkv",
        "Show - S01E02-E03.mkv",
        "Show - S03E01.mkv",
    ] {
        touch(&lib.join("Show").join(n), b"x");
    }
    let sp: i32 = sqlx::query_scalar(r#"INSERT INTO item_groups ("mediaId", "number", monitored) VALUES ($1, 0, false) RETURNING id"#)
        .bind(s).fetch_one(&c.st.db).await.unwrap();
    let special: i32 = sqlx::query_scalar(r#"INSERT INTO items ("groupId", "mediaId", "editionId", "number", title, monitored) VALUES ($1, $2, (SELECT id FROM editions WHERE "mediaId" = $2), 1, 'Making Of', true) RETURNING id"#)
        .bind(sp).bind(s).fetch_one(&c.st.db).await.unwrap();
    touch(&lib.join("Show/Making Of.mkv"), b"m");
    let r = rescan(&c, s).await.unwrap();
    assert_eq!((r.added, r.removed), (3, 1));
    let has: Vec<(i32, i32, Option<i32>, bool)> = sqlx::query_as(
        r#"SELECT s."number", e."number", e."endNumber",
                  EXISTS (SELECT 1 FROM item_parts p WHERE p."itemId" = e.id)
           FROM items e JOIN item_groups s ON s.id = e."groupId" WHERE s."mediaId" = $1
           ORDER BY 1, 2"#,
    )
    .bind(s)
    .fetch_all(&c.st.db)
    .await
    .unwrap();
    assert_eq!(
        has,
        [
            (0, 1, None, true),
            (1, 1, None, true),
            (1, 2, Some(3), true),
            (3, 1, None, true)
        ]
    );
    assert_eq!(
        count(
            &c,
            &format!("SELECT count(*) FROM media_files WHERE id = {gone}")
        )
        .await,
        0
    );
    assert_eq!(
        count(
            &c,
            &format!(r#"SELECT count(*) FROM item_parts WHERE "mediaFileId" = {unlinked}"#)
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &c,
            &format!(r#"SELECT count(*) FROM item_parts WHERE "itemId" = {special}"#)
        )
        .await,
        1
    );
}

#[sqlx::test(migrations = false)]
async fn rescan_links_a_range_and_a_version_to_the_items_they_play(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("series");
    let l = library(&c, "S", &lib, r#"["series"]"#).await;
    let s = media(&c, l, "Show", "series").await;
    let g: i32 = sqlx::query_scalar(r#"INSERT INTO item_groups ("mediaId", "number", monitored) VALUES ($1, 1, true) RETURNING id"#)
        .bind(s).fetch_one(&c.st.db).await.unwrap();
    for n in 1..=3 {
        sqlx::query(r#"INSERT INTO items ("groupId", "mediaId", "editionId", "number", monitored) VALUES ($1, $2, (SELECT id FROM editions WHERE "mediaId" = $2), $3, true)"#)
            .bind(g).bind(s).bind(n).execute(&c.st.db).await.unwrap();
    }
    for n in ["Show - S01E01-E03.mkv", "Show - S01E03.mkv"] {
        touch(&lib.join("Show").join(n), b"x");
    }
    rescan(&c, s).await.unwrap();
    let parts: Vec<(i32, String, i32)> = sqlx::query_as(
        r#"SELECT i."number", f."relativePath", p."position" FROM item_parts p
           JOIN items i ON i.id = p."itemId" JOIN media_files f ON f.id = p."mediaFileId"
           ORDER BY 1, 2"#,
    )
    .fetch_all(&c.st.db)
    .await
    .unwrap();
    let (range, single) = ("Show/Show - S01E01-E03.mkv", "Show/Show - S01E03.mkv");
    let want = [(1, range, 0), (2, range, 0), (3, range, 0), (3, single, 0)];
    assert_eq!(
        parts,
        want.map(|(n, f, p)| (n, f.to_owned(), p)),
        "the range file plays its three items, the single one is a second version of the third"
    );
    let owner: Option<i32> = sqlx::query_scalar(
        r#"SELECT fi."episodeId" FROM media_file_items fi JOIN media_files f ON f.id = fi."mediaFileId"
           WHERE f."relativePath" = $1"#,
    )
    .bind(range)
    .fetch_one(&c.st.db)
    .await
    .unwrap();
    let first: i32 =
        sqlx::query_scalar(r#"SELECT id FROM items WHERE "groupId" = $1 AND "number" = 1"#)
            .bind(g)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
    assert_eq!(
        owner,
        Some(first),
        "a file reports the lowest item it plays"
    );
}

#[sqlx::test(migrations = false)]
async fn a_refresh_gives_the_items_it_creates_inside_a_range_their_parts(pool: PgPool) {
    use crate::metadata::service::{EpisodeDetails, SeasonDetails};
    let c = ctx(pool).await;
    let lib = c.dir.join("series");
    let l = library(&c, "S", &lib, r#"["series"]"#).await;
    let s = media(&c, l, "Show", "series").await;
    touch(&lib.join("Show/Show - S01E01-E03.mkv"), b"x");
    rescan(&c, s).await.unwrap();
    let parts = || count(&c, r#"SELECT count(*) FROM item_parts"#);
    assert_eq!(parts().await, 1, "the rescan creates the owner only");
    let season = SeasonDetails {
        season_number: 1,
        overview: None,
        air_date: None,
        poster_url: None,
        episodes: (1..=3)
            .map(|n| EpisodeDetails {
                episode_number: n,
                title: format!("E{n}"),
                ..Default::default()
            })
            .collect(),
    };
    crate::media::write::apply_seasons(&c.st, s, &[season])
        .await
        .unwrap();
    assert_eq!(
        parts().await,
        3,
        "the refreshed episodes of the range play the file"
    );
}

#[sqlx::test(migrations = false)]
async fn rescan_links_a_movie_file_to_the_movie_item(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    touch(&lib.join("A/A.mkv"), b"a");
    let a = media(&c, l, "A", "movie").await;
    rescan(&c, a).await.unwrap();
    let rows: Vec<(Option<i32>, bool)> = sqlx::query_as(
        r#"SELECT fi."episodeId", i."groupId" IS NULL FROM item_parts p JOIN items i ON i.id = p."itemId"
           LEFT JOIN media_file_items fi ON fi."mediaFileId" = p."mediaFileId" WHERE p."mediaId" = $1"#,
    )
    .bind(a)
    .fetch_all(&c.st.db)
    .await
    .unwrap();
    assert_eq!(
        rows,
        [(None, true)],
        "one part on the ungrouped item, reported without an episode"
    );
}

#[sqlx::test(migrations = false)]
async fn rescan_probes_only_what_changed(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    touch(&lib.join("A/A.mkv"), b"a");
    let a = media(&c, l, "A", "movie").await;
    file_row(&c, a, "A.mkv").await;
    let probes = |c: &Ctx| c.fake.seen("POST", "/v1/probe").len();
    let first = rescan(&c, a).await.unwrap();
    assert_eq!(
        (first.updated, probes(&c), scans(&c, 0).await),
        (1, 2, 0),
        "unstamped row, same size: probe + embedded detection, no scan"
    );
    let second = rescan(&c, a).await.unwrap();
    assert_eq!(
        (second.updated, probes(&c), scans(&c, 0).await),
        (0, 2, 0),
        "stamped and unchanged: no probe, no scan"
    );
    sqlx::query(r#"UPDATE media_files SET "mtimeMs" = 0"#)
        .execute(&c.st.db)
        .await
        .unwrap();
    let third = rescan(&c, a).await.unwrap();
    assert_eq!(
        (third.updated, probes(&c), scans(&c, 1).await),
        (1, 4, 1),
        "a moved mtime probes and scans again"
    );
}

#[sqlx::test(migrations = false)]
async fn rescan_detects_embedded_subtitles_after_an_interrupted_walk(pool: PgPool) {
    use std::os::unix::fs::PermissionsExt;
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    touch(&lib.join("A/A.mkv"), b"a");
    let locked = lib.join("A/locked");
    fs::create_dir_all(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
    let a = media(&c, l, "A", "movie").await;
    let r = rescan(&c, a).await;
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(r.unwrap().added, 1);
    assert_eq!(
        c.fake.seen("POST", "/v1/probe").len(),
        2,
        "probe + embedded detection although the walk was incomplete"
    );
}

#[sqlx::test(migrations = false)]
async fn rescan_adds_the_good_files_when_one_insert_fails(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    for n in ["good1.mkv", "bad.mkv", "good2.mkv"] {
        touch(&lib.join("A").join(n), b"x");
    }
    let a = media(&c, l, "A", "movie").await;
    sqlx::query(
        r#"CREATE FUNCTION refuse_bad() RETURNS trigger AS $$
           BEGIN
             IF NEW."relativePath" = 'A/bad.mkv' THEN RAISE EXCEPTION 'refused'; END IF;
             RETURN NEW;
           END $$ LANGUAGE plpgsql"#,
    )
    .execute(&c.st.db)
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER refuse_bad BEFORE INSERT ON media_files FOR EACH ROW EXECUTE FUNCTION refuse_bad()")
        .execute(&c.st.db)
        .await
        .unwrap();
    let r = rescan(&c, a).await.unwrap();
    assert_eq!(r.added, 2);
    let rows: Vec<String> =
        sqlx::query_scalar(r#"SELECT "relativePath" FROM media_files ORDER BY 1"#)
            .fetch_all(&c.st.db)
            .await
            .unwrap();
    assert_eq!(rows, ["A/good1.mkv", "A/good2.mkv"]);
}

#[sqlx::test(migrations = false)]
async fn relink_in_place_is_contained(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    touch(&lib.join("Film (2001)/Film (2001).mkv"), b"f");
    touch(&c.dir.join("outside/Out.mkv"), b"o");
    let url = "/api/imports/library/orphans/relink";
    let body = |folder: &str, path: PathBuf| json!({"libraryId": l, "type": "movie", "folderName": folder, "files": [{"filePath": path}]});
    let (s, b) = call(
        &c,
        "POST",
        url,
        &c.admin,
        body("Film (2001)", lib.join("Film (2001)/Film (2001).mkv")),
    )
    .await;
    assert_eq!(
        (s, b["linked"].clone(), b["created"].clone()),
        (201, json!(1), json!(true)),
        "{b}"
    );
    let (s, b) = call(
        &c,
        "POST",
        url,
        &c.admin,
        body("Film (2001)", lib.join("Film (2001)/Film (2001).mkv")),
    )
    .await;
    assert_eq!(
        (s, b["linked"].clone(), b["created"].clone()),
        (201, json!(1), json!(false))
    );
    assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 1);
    let (s, _) = call(
        &c,
        "POST",
        url,
        &c.admin,
        body("Out", c.dir.join("outside/Out.mkv")),
    )
    .await;
    assert_eq!(s, 400);
    for bad in ["..", "../../outside", "a/b"] {
        let (s, _) = call(
            &c,
            "POST",
            url,
            &c.admin,
            body(bad, c.dir.join("outside/Out.mkv")),
        )
        .await;
        assert_eq!(s, 400, "{bad}");
    }
    assert_eq!(count(&c, "SELECT count(*) FROM media").await, 1);
    // Transfers are a library manager's action.
    let mut t = body("X", c.dir.join("outside/Out.mkv"));
    t["transfer"] = json!("copy");
    let (s, _) = call(&c, "POST", url, &c.editor, t).await;
    assert_eq!(s, 403);
    let (s, _) = call(&c, "POST", url, &c.editor, body("Y", lib.join("Y/Y.mkv"))).await;
    assert_eq!(s, 404);
    let m = media(&c, l, "Out (2000)", "movie").await;
    sqlx::query(
        r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value)
           VALUES ($1, 'movie', 'tmdb', '77')"#,
    )
    .bind(m)
    .execute(&c.st.db)
    .await
    .unwrap();
    let mut r = body("Out (2000)", c.dir.join("outside/Out.mkv"));
    r["externalId"] = json!("77");
    r["reorganize"] = json!(true);
    let (s, b) = call(&c, "POST", url, &c.admin, r).await;
    assert_eq!((s, b["linked"].clone()), (201, json!(0)), "{b}");
    assert!(c.dir.join("outside/Out.mkv").exists());
}

#[sqlx::test(migrations = false)]
async fn relink_transfer_copy_then_move(pool: PgPool) {
    let c = ctx(pool).await;
    let scan =
        json!({"type": "Scan", "scan": {"keyframes": [], "end": 2.0, "audioConfigChanges": {}}});
    c.fake
        .script("POST", "/v1/jobs", vec![ok(json!({"jobId": "j1"}))]);
    c.fake.script(
        "GET",
        "/v1/jobs/j1",
        vec![ok(json!({
            "jobId": "j1", "kind": "Scan", "mediaFileId": 0, "priority": "high", "state": "done",
            "pct": 100, "createdMs": 1, "result": scan,
        }))],
    );
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    let src = c.dir.join("dl/Some.Movie.2010.1080p.mkv");
    touch(&src, b"movie");
    touch(&c.dir.join("dl/Some.Movie.2010.1080p.en.srt"), b"sub");
    let url = "/api/imports/library/orphans/relink";
    let body = |t: &str| {
        json!({"libraryId": l, "type": "movie", "folderName": "dl", "title": "Some Movie", "year": 2010,
        "transfer": t, "files": [{"filePath": src}]})
    };
    let (s, b) = call(&c, "POST", url, &c.admin, body("copy")).await;
    assert_eq!((s, b["linked"].clone()), (201, json!(1)), "{b}");
    let dest = lib.join("Some Movie (2010)/Some Movie (2010) Bluray-1080p.mkv");
    assert!(src.exists());
    assert!(
        dest.exists() || fs::read_dir(lib.join("Some Movie (2010)")).is_ok(),
        "{:?}",
        tree(&lib)
    );
    let (s, b) = call(&c, "POST", url, &c.admin, body("copy")).await;
    assert_eq!(
        (s, b["linked"].clone(), b["alreadyPresent"].clone()),
        (201, json!(0), json!(1)),
        "{b}"
    );
    assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 1);
    let files: Vec<String> = tree(&lib).into_iter().map(|(p, _)| p).collect();
    assert!(files.iter().any(|p| p.ends_with(".en.srt")), "{files:?}");
    assert!(!c.fake.seen("POST", "/v1/probe").is_empty());
    assert_eq!(scans(&c, 1).await, 1, "one scan, carried over to the copy");
    assert_eq!(count(&c, "SELECT count(*) FROM media_file_scans").await, 1);

    let series = c.dir.join("series");
    let sl = library(&c, "S", &series, r#"["series"]"#).await;
    let eps = ["Show.S01E01.1080p.mkv", "Show.S01E02.1080p.mkv"].map(|n| c.dir.join("dl").join(n));
    eps.iter().for_each(|e| touch(e, b"ep"));
    let files: Vec<Value> = eps.iter().map(|e| json!({"filePath": e})).collect();
    let mv = json!({"libraryId": sl, "type": "series", "folderName": "Show", "title": "Show",
        "transfer": "move", "files": files});
    let (s, b) = call(&c, "POST", url, &c.admin, mv).await;
    assert_eq!((s, b["linked"].clone()), (201, json!(2)), "{b}");
    assert!(eps.iter().all(|e| !e.exists()));
    let moved: Vec<String> = tree(&series.join("Show"))
        .into_iter()
        .map(|(p, _)| p)
        .collect();
    assert_eq!(
        moved
            .iter()
            .filter(|p| p.starts_with("Season 01/") && p.ends_with(".mkv"))
            .count(),
        2,
        "{moved:?}"
    );
}

/// A 4800 s file whose scan ends at `end`, imported by a relink copy.
async fn relink_scanned(pool: PgPool, end: f64) -> (Ctx, Value, PathBuf) {
    let c = ctx(pool).await;
    let mut p = probe_ok();
    p["info"]["durationSeconds"] = json!(4800.0);
    c.fake.script("POST", "/v1/probe", vec![ok(p)]);
    let scan =
        json!({"type": "Scan", "scan": {"keyframes": [], "end": end, "audioConfigChanges": {}}});
    c.fake
        .script("POST", "/v1/jobs", vec![ok(json!({"jobId": "j1"}))]);
    c.fake.script(
        "GET",
        "/v1/jobs/j1",
        vec![ok(json!({
            "jobId": "j1", "kind": "Scan", "mediaFileId": 0, "priority": "high", "state": "done",
            "pct": 100, "createdMs": 1, "result": scan,
        }))],
    );
    let l = library(&c, "M", &c.dir.join("movies"), r#"["movie"]"#).await;
    let src = c.dir.join("dl/Some.Movie.2010.1080p.mkv");
    touch(&src, b"movie");
    let body = json!({"libraryId": l, "type": "movie", "folderName": "dl", "title": "Some Movie",
        "year": 2010, "transfer": "copy", "files": [{"filePath": src}]});
    let (s, b) = call(
        &c,
        "POST",
        "/api/imports/library/orphans/relink",
        &c.admin,
        body,
    )
    .await;
    assert_eq!(s, 201, "{b}");
    (c, b, src)
}

#[sqlx::test(migrations = false)]
async fn a_truncated_file_is_refused_and_kept(pool: PgPool) {
    let (c, b, src) = relink_scanned(pool, 1764.0).await;
    assert_eq!(b["linked"], json!(0), "{b}");
    let err = b["errors"][0].as_str().unwrap_or_default();
    assert!(
        err.contains("truncated file, its data ends at 29:24 of the 80:00"),
        "{b}"
    );
    assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 0);
    assert!(src.exists(), "the source is never touched");
    let placed: Vec<String> = tree(&c.dir.join("movies"))
        .into_iter()
        .map(|(p, _)| p)
        .collect();
    assert!(placed.iter().all(|p| !p.ends_with(".mkv")), "{placed:?}");
}

#[sqlx::test(migrations = false)]
async fn a_complete_file_is_imported(pool: PgPool) {
    let (c, b, _) = relink_scanned(pool, 4799.0).await;
    assert_eq!(
        (b["linked"].clone(), b["errors"].clone()),
        (json!(1), json!([])),
        "{b}"
    );
    assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 1);
    let bare = count(
        &c,
        r#"SELECT count(*) FROM media m WHERE NOT EXISTS (SELECT 1 FROM editions e WHERE e."mediaId" = m.id)
           OR NOT EXISTS (SELECT 1 FROM items i WHERE i."mediaId" = m.id AND i."groupId" IS NULL)"#,
    )
    .await;
    assert_eq!(bare, 0, "the unmatched media has its edition and item");
}

#[sqlx::test(migrations = false)]
async fn write_routes_apply_the_library_acl(pool: PgPool) {
    let c = ctx(pool).await;
    let l = library(&c, "M", &c.dir.join("movies"), r#"["movie"]"#).await;
    let a = media(&c, l, "A", "movie").await;
    // The editor has no library access at all.
    let (s, _) = call(
        &c,
        "PATCH",
        "/api/media/bulk",
        &c.editor,
        json!({"ids": [a], "monitored": false}),
    )
    .await;
    assert_eq!(s, 404);
    let (s, b) = call(
        &c,
        "PATCH",
        "/api/media/bulk",
        &c.admin,
        json!({"ids": [a, a], "monitored": false}),
    )
    .await;
    assert_eq!((s, b), (200, json!({"updated": 1})));
    let (s, _) = call(
        &c,
        "PATCH",
        "/api/media/bulk",
        &c.admin,
        json!({"ids": [1.5]}),
    )
    .await;
    assert_eq!(s, 400);
    let (s, _) = call(
        &c,
        "PATCH",
        &format!("/api/media/{a}/library"),
        &c.admin,
        json!({}),
    )
    .await;
    assert_eq!(s, 400);
    let (s, b) = call(
        &c,
        "POST",
        "/api/media/import/tmdb",
        &c.admin,
        json!({"type": "movie", "tmdbId": 5}),
    )
    .await;
    assert_eq!(
        (s, b["message"].clone()),
        (400, json!("TMDB API key is not configured"))
    );
    let (s, b) = call(
        &c,
        "PUT",
        &format!("/api/media/{a}"),
        &c.admin,
        json!({"monitored": true, "path": "/x"}),
    )
    .await;
    assert_eq!((s, b["monitored"].clone()), (200, json!(true)));
}

#[test]
fn file_names_are_single_components() {
    use super::library::file_component;
    assert!(file_component("A", ".sh").is_err());
    assert_eq!(file_component("A", ".MKV").unwrap(), "A.MKV");
    assert!(file_component("  ", ".mkv").is_err());
    assert!(file_component("..", ".mkv").is_err());
    assert!(file_component("a/b", ".mkv").is_err());
    let long = "é".repeat(200);
    let n = file_component(&long, ".mkv").unwrap();
    assert!(n.len() <= 255 && n.ends_with(".mkv"));
}

async fn second_folder(c: &Ctx, lib: i32, path: &Path) -> i32 {
    fs::create_dir_all(path).unwrap();
    sqlx::query_scalar(r#"INSERT INTO library_folders ("libraryId", path, position) VALUES ($1, $2, 1) RETURNING id"#)
        .bind(lib)
        .bind(path.to_string_lossy().as_ref())
        .fetch_one(&c.st.db)
        .await
        .unwrap()
}

#[sqlx::test(migrations = false)]
async fn rescan_visits_every_folder_and_skips_an_offline_one(pool: PgPool) {
    let c = ctx(pool).await;
    let (d1, d2) = (c.dir.join("m1"), c.dir.join("m2"));
    let l = library(&c, "M", &d1, r#"["movie"]"#).await;
    let f2 = second_folder(&c, l, &d2).await;
    touch(&d1.join("A/A.mkv"), b"a");
    touch(&d2.join("A/Old.mkv"), b"o");
    let a = media(&c, l, "A", "movie").await;
    sqlx::query(r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality, "folderId") VALUES ($1, 'A/Old.mkv', 1, 'x', $2)"#)
        .bind(a)
        .bind(f2)
        .execute(&c.st.db)
        .await
        .unwrap();
    // the new file lands in the target folder, the row of the second folder is kept
    let first = rescan(&c, a).await.unwrap();
    assert_eq!((first.added, first.removed), (1, 0));
    let rows = |c: &Ctx| {
        let db = c.st.db.clone();
        async move {
            sqlx::query_as::<_, (String, i32)>(
                r#"SELECT "relativePath", "folderId" FROM media_files ORDER BY id"#,
            )
            .fetch_all(&db)
            .await
            .unwrap()
        }
    };
    assert_eq!(
        rows(&c).await,
        [("A/Old.mkv".to_owned(), f2), ("A/A.mkv".to_owned(), 1)]
    );
    // an offline folder is skipped and loses no row
    fs::remove_dir_all(&d2).unwrap();
    let second = rescan(&c, a).await.unwrap();
    assert_eq!((second.added, second.removed), (0, 0));
    assert_eq!(rows(&c).await.len(), 2);
    // every folder holding rows offline: the refusal of rule 39
    fs::remove_dir_all(&d1).unwrap();
    assert_eq!(rescan(&c, a).await.unwrap_err().status(), 400);
    assert_eq!(rows(&c).await.len(), 2);
}

mod book_ingest {
    use super::*;
    use crate::ingest::{
        books::{self, Placed},
        library::{self, File, Request},
        transfer::Method,
    };
    use std::io::Write;
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    fn epub(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut png = vec![];
        image::RgbImage::new(2, 2)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let mut w = ZipWriter::new(fs::File::create(path).unwrap());
        let o = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        let opf = r#"<package><metadata xmlns:dc="x"><dc:title>Mirelune</dc:title>
            <dc:creator>Olympe Faucheval</dc:creator><dc:language>fre</dc:language>
            <dc:publisher>Editions Invention</dc:publisher><meta name="cover" content="c"/></metadata>
            <manifest><item id="c" href="c.png" media-type="image/png"/></manifest></package>"#;
        for (n, b) in [
            (
                "META-INF/container.xml",
                br#"<container><rootfiles><rootfile full-path="o.opf"/></rootfiles></container>"#
                    .as_slice(),
            ),
            ("o.opf", opf.as_bytes()),
            ("c.png", png.as_slice()),
        ] {
            w.start_file(n, o).unwrap();
            w.write_all(b).unwrap();
        }
        w.finish().unwrap();
    }

    fn audio_probe() -> Value {
        json!({"ok": true, "info": {"video": [], "audio": [{"streamIndex": 0, "codec": "mp3", "language": "und"}],
            "subtitles": [], "durationSeconds": 60.0,
            "chapters": [{"startSeconds": 0.0, "endSeconds": 60.0, "title": "One"}],
            "tags": {"album": "Orfaline", "artist": "Olympe Faucheval", "language": "fra"}}})
    }

    async fn book(c: &Ctx, folder: &str) -> i32 {
        let l = library(c, "B", &c.dir.join("books"), r#"["book"]"#).await;
        media(c, l, folder, "book").await
    }

    fn placed(c: &Ctx, rels: &[&str]) -> Vec<Placed> {
        rels.iter()
            .map(|r| Placed {
                folder_id: 1,
                rel: (*r).to_owned(),
                abs: c.dir.join("books").join(r),
            })
            .collect()
    }

    async fn parts(c: &Ctx, media: i32) -> Vec<(String, i32, i32)> {
        sqlx::query_as(
            r#"SELECT f."relativePath", p.version, p.position FROM item_parts p
               JOIN media_files f ON f.id = p."mediaFileId" WHERE p."mediaId" = $1
               ORDER BY p.version, p.position"#,
        )
        .bind(media)
        .fetch_all(&c.st.db)
        .await
        .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn an_epub_becomes_an_edition_with_its_hash_and_cover(pool: PgPool) {
        let c = ctx(pool).await;
        let m = book(&c, "Mirelune").await;
        epub(&c.dir.join("books/Mirelune/Mirelune.epub"));
        let done = books::register(&c.st, m, &placed(&c, &["Mirelune/Mirelune.epub"]))
            .await
            .unwrap();
        assert_eq!(done.files.len(), 1);
        let e: (String, Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            r#"SELECT family, format, language, publisher FROM editions WHERE "mediaId" = $1"#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            e,
            (
                "text".into(),
                Some("epub".into()),
                Some("fr".into()),
                Some("Editions Invention".into())
            )
        );
        assert_eq!(
            parts(&c, m).await,
            [("Mirelune/Mirelune.epub".to_owned(), 0, 0)]
        );
        assert_eq!(
            count(
                &c,
                "SELECT count(*) FROM media_file_hashes WHERE length(hash) = 32"
            )
            .await,
            1
        );
        let poster: Option<String> =
            sqlx::query_scalar(r#"SELECT "posterUrl" FROM media WHERE id = $1"#)
                .bind(m)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert!(poster.is_some());
        books::register(&c.st, m, &placed(&c, &["Mirelune/Mirelune.epub"]))
            .await
            .unwrap();
        assert!(books::identify_media(&c.st, m).await.is_err());
        assert_eq!(
            count(&c, "SELECT count(*) FROM edition_external_ids").await,
            0
        );
        assert_eq!(count(&c, "SELECT count(*) FROM editions").await, 1);
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn audio_parts_are_one_version_and_a_rescan_keeps_it(pool: PgPool) {
        let c = ctx(pool).await;
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let m = book(&c, "Orfaline").await;
        for r in ["CD1/02.mp3", "CD1/01.mp3", "CD2/01.mp3"] {
            touch(&c.dir.join("books/Orfaline").join(r), r.as_bytes());
        }
        books::register(
            &c.st,
            m,
            &placed(
                &c,
                &[
                    "Orfaline/CD1/02.mp3",
                    "Orfaline/CD1/01.mp3",
                    "Orfaline/CD2/01.mp3",
                ],
            ),
        )
        .await
        .unwrap();
        let expect = |rels: &[&str]| -> Vec<(String, i32, i32)> {
            rels.iter()
                .enumerate()
                .map(|(i, r)| ((*r).to_owned(), 0, i as i32))
                .collect()
        };
        assert_eq!(
            parts(&c, m).await,
            expect(&[
                "Orfaline/CD1/01.mp3",
                "Orfaline/CD1/02.mp3",
                "Orfaline/CD2/01.mp3"
            ])
        );
        let (format, duration): (Option<String>, Option<i32>) = sqlx::query_as(
            r#"SELECT format, "durationSeconds" FROM editions WHERE "mediaId" = $1"#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!((format.as_deref(), duration), (Some("mp3"), Some(180)));
        assert_eq!(
            count(
                &c,
                "SELECT count(*) FROM item_markers WHERE kind = 'chapter'"
            )
            .await,
            3
        );
        touch(&c.dir.join("books/Orfaline/CD2/02.mp3"), b"new");
        let counts = rescan(&c, m).await.unwrap();
        assert_eq!((counts.added, counts.removed), (1, 0));
        assert_eq!(
            parts(&c, m).await,
            expect(&[
                "Orfaline/CD1/01.mp3",
                "Orfaline/CD1/02.mp3",
                "Orfaline/CD2/01.mp3",
                "Orfaline/CD2/02.mp3"
            ])
        );
        touch(&c.dir.join("books/Orfaline/cover.jpg"), b"j");
        touch(&c.dir.join("books/Orfaline/clip.mkv"), b"v");
        assert_eq!(rescan(&c, m).await.unwrap().added, 0);
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 4);
    }

    /// Two mp3 parts registered in a library whose merge option is `on`, the engine ready to
    /// answer a `Merge` job with `chapters` chapters; the m4b is already on disk.
    async fn merging_ctx(pool: PgPool) -> Ctx {
        let mut hello = hello_body(&RUNTIME, "x");
        hello["jobFamilies"] = json!([{"kind": "Merge", "families": ["audio"]}]);
        ctx_hello(pool, None, hello).await
    }

    /// A file whose mtime is after any submit time: the fake engine cannot write mid-job.
    fn written_by_the_job(path: &std::path::Path, bytes: &[u8]) {
        touch(path, bytes);
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(3600))
            .unwrap();
    }

    async fn merge_setup(c: &Ctx, on: bool, chapters: usize) -> i32 {
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let m = book(c, "Orfaline").await;
        sqlx::query(r#"UPDATE libraries SET "mergeM4b" = $1"#)
            .bind(on)
            .execute(&c.st.db)
            .await
            .unwrap();
        for r in ["01.mp3", "02.mp3"] {
            touch(&c.dir.join("books/Orfaline").join(r), r.as_bytes());
        }
        books::register(
            &c.st,
            m,
            &placed(c, &["Orfaline/01.mp3", "Orfaline/02.mp3"]),
        )
        .await
        .unwrap();
        written_by_the_job(&c.dir.join("books/Orfaline/Orfaline.m4b"), b"merged");
        let chapter = json!({"startSeconds": 0.0, "endSeconds": 60.0, "title": "One"});
        c.fake
            .script("POST", "/v1/jobs", vec![ok(json!({"jobId": "j1"}))]);
        c.fake.script(
            "GET",
            "/v1/jobs/j1",
            vec![ok(json!({
                "jobId": "j1", "kind": "Merge", "mediaFileId": 1, "priority": "low",
                "state": "done", "pct": 100, "createdMs": 1,
                "result": {"type": "Merge", "merge": {
                    "path": c.dir.join("books/Orfaline/Orfaline.m4b"), "bytes": 6.0,
                    "durationSeconds": 60.0, "chapters": vec![chapter; chapters],
                    "reencoded": false}},
            }))],
        );
        m
    }

    #[sqlx::test(migrations = false)]
    async fn a_verified_merge_is_a_new_version_and_the_parts_stay(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(
            parts(&c, m).await,
            [
                ("Orfaline/01.mp3".to_owned(), 0, 0),
                ("Orfaline/02.mp3".to_owned(), 0, 1),
                ("Orfaline/Orfaline.m4b".to_owned(), 1, 0)
            ]
        );
        assert!(c.dir.join("books/Orfaline/01.mp3").exists());
        assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), 1);
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), 1, "an m4b ends it");
    }

    #[sqlx::test(migrations = false)]
    async fn a_merge_the_probe_does_not_confirm_is_removed_and_nothing_is_registered(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 2).await;
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert!(!c.dir.join("books/Orfaline/Orfaline.m4b").exists());
        assert!(c.dir.join("books/Orfaline/02.mp3").exists());
        assert_eq!(parts(&c, m).await.len(), 2);
    }

    async fn merge_state(c: &Ctx, m: i32) -> Option<String> {
        sqlx::query_scalar(r#"SELECT state FROM book_merges WHERE "mediaId" = $1"#)
            .bind(m)
            .fetch_optional(&c.st.db)
            .await
            .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn a_part_moved_or_changed_during_the_merge_discards_the_output(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        fs::rename(
            c.dir.join("books/Orfaline/02.mp3"),
            c.dir.join("books/Orfaline/elsewhere.mp3"),
        )
        .unwrap();
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert!(!c.dir.join("books/Orfaline/Orfaline.m4b").exists());
        assert!(c.dir.join("books/Orfaline/elsewhere.mp3").exists());
        assert_eq!(parts(&c, m).await.len(), 2);
        assert_eq!(merge_state(&c, m).await.as_deref(), Some("retry"));
    }

    #[sqlx::test(migrations = false)]
    async fn a_failed_merge_waits_for_the_parts_to_change(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 2).await;
        assert!(books::merge::run(&c.st, m).await.is_err());
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), 1, "no second run");
        touch(&c.dir.join("books/Orfaline/02.mp3"), b"longer part");
        rescan(&c, m).await.unwrap();
        touch(&c.dir.join("books/Orfaline/Orfaline.m4b"), b"merged");
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert_eq!(
            c.fake.seen("POST", "/v1/jobs").len(),
            2,
            "the parts changed"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_output_a_row_already_holds_is_not_removed_by_a_failed_check(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 2).await;
        sqlx::query(
            r#"INSERT INTO media_files ("folderId", "relativePath", size, quality)
               VALUES (1, 'Orfaline/Orfaline.m4b', 6, 'm4b')"#,
        )
        .execute(&c.st.db)
        .await
        .unwrap();
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert!(c.dir.join("books/Orfaline/Orfaline.m4b").exists());
    }

    /// A `running` row for the parts as registered, written before the files it concerns.
    async fn running_row(c: &Ctx, m: i32) {
        let rows = books::merge::load(&c.st, m).await.unwrap();
        let fp = books::merge::fingerprint(&books::merge::pick(&rows).unwrap());
        sqlx::query(
            r#"INSERT INTO book_merges ("mediaId", fingerprint, state, "folderId", output)
               VALUES ($1, $2, 'running', 1, 'Orfaline/Orfaline.m4b')"#,
        )
        .bind(m)
        .bind(fp)
        .execute(&c.st.db)
        .await
        .unwrap();
        sqlx::query(r#"UPDATE book_merges SET "jobId" = 'j1' WHERE "mediaId" = $1"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
    }

    fn job_answer(c: &Ctx, state: &str, bytes: f64, error: &str) -> Value {
        let chapter = json!({"startSeconds": 0.0, "endSeconds": 60.0, "title": "One"});
        json!({
            "jobId": "j1", "kind": "Merge", "mediaFileId": 1, "priority": "low",
            "state": state, "pct": 100, "createdMs": 1, "error": error,
            "result": {"type": "Merge", "merge": {
                "path": c.dir.join("books/Orfaline/Orfaline.m4b"), "bytes": bytes,
                "durationSeconds": 60.0, "chapters": [chapter], "reencoded": false}},
        })
    }

    #[sqlx::test(migrations = false)]
    async fn a_cut_run_whose_job_does_not_match_the_file_deletes_nothing(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        running_row(&c, m).await;
        c.fake.script(
            "GET",
            "/v1/jobs/j1",
            vec![ok(job_answer(&c, "done", 99.0, ""))],
        );
        let out = c.dir.join("books/Orfaline/Orfaline.m4b");
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert_eq!(
            fs::read(&out).unwrap(),
            b"merged",
            "not the job's file: left"
        );
        assert_ne!(merge_state(&c, m).await.as_deref(), Some("running"));
    }

    #[sqlx::test(migrations = false)]
    async fn a_cut_run_whose_done_job_matches_the_file_is_registered(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        running_row(&c, m).await;
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(parts(&c, m).await.len(), 3);
        assert!(c.fake.seen("POST", "/v1/jobs").is_empty(), "no new job");
        assert_eq!(merge_state(&c, m).await, None);
    }

    #[sqlx::test(migrations = false)]
    async fn a_transient_failure_then_one_ffmpeg_failure_is_not_sticky(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        let script = |what: &str| {
            c.fake.script(
                "GET",
                "/v1/jobs/j1",
                vec![ok(job_answer(&c, "failed", 0.0, what))],
            )
        };
        script("output exists");
        assert!(books::merge::run(&c.st, m).await.is_err());
        sqlx::query(r#"UPDATE book_merges SET "nextAttemptAt" = now()"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        script("ffmpeg exited with Some(1): bad");
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert_eq!(merge_state(&c, m).await.as_deref(), Some("retry"));
    }

    #[sqlx::test(migrations = false)]
    async fn a_verify_failure_leaves_a_file_the_engine_did_not_just_write(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 2).await;
        let out = c.dir.join("books/Orfaline/Orfaline.m4b");
        touch(&out, b"merged");
        std::fs::File::options()
            .write(true)
            .open(&out)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(3600))
            .unwrap();
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert!(out.exists(), "older than the submit: not the job's");
    }

    #[sqlx::test(migrations = false)]
    async fn a_job_that_fails_twice_on_the_same_parts_turns_sticky(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        c.fake.script(
            "GET",
            "/v1/jobs/j1",
            vec![ok(job_answer(
                &c,
                "failed",
                0.0,
                "ffmpeg exited with Some(1): bad",
            ))],
        );
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert_eq!(merge_state(&c, m).await.as_deref(), Some("retry"));
        sqlx::query(r#"UPDATE book_merges SET "nextAttemptAt" = now()"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert_eq!(merge_state(&c, m).await.as_deref(), Some("failed"));
    }

    #[sqlx::test(migrations = false)]
    async fn a_users_file_at_the_output_survives_a_refusing_engine_and_changed_parts(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        let out = c.dir.join("books/Orfaline/Orfaline.m4b");
        touch(&out, b"mine");
        c.fake.script(
            "GET",
            "/v1/jobs/j1",
            vec![ok(json!({
                "jobId": "j1", "kind": "Merge", "mediaFileId": 1, "priority": "low",
                "state": "failed", "pct": 0, "createdMs": 1, "error": "output exists"}))],
        );
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert_eq!(
            merge_state(&c, m).await.as_deref(),
            Some("retry"),
            "not sticky"
        );
        fs::rename(&out, c.dir.join("mine.bin")).unwrap();
        touch(&c.dir.join("books/Orfaline/02.mp3"), b"longer part");
        rescan(&c, m).await.unwrap();
        fs::rename(c.dir.join("mine.bin"), &out).unwrap();
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert_eq!(fs::read(&out).unwrap(), b"mine");
        assert_eq!(
            c.fake.seen("POST", "/v1/jobs").len(),
            2,
            "the parts changed"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn two_concurrent_runs_of_one_media_merge_once(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        let (a, b) = tokio::join!(books::merge::run(&c.st, m), books::merge::run(&c.st, m));
        a.unwrap();
        b.unwrap();
        assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), 1);
        assert_eq!(parts(&c, m).await.len(), 3);
    }

    #[sqlx::test(migrations = false)]
    async fn a_repeated_toggle_starts_one_backfill_and_failures_are_forgotten(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 2).await;
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert_eq!(merge_state(&c, m).await.as_deref(), Some("failed"));
        let lib: i32 = sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = $1"#)
            .bind(m)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        books::merge::forget_failures(&c.st, lib).await.unwrap();
        assert_eq!(merge_state(&c, m).await, None);
        books::merge::spawn_library(&c.st, lib);
        books::merge::spawn_library(&c.st, lib);
        assert_eq!(c.st.ingest.backfills.lock().unwrap().len(), 1);
        while !c.st.ingest.backfills.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    }

    #[sqlx::test(migrations = false)]
    async fn chapters_follow_the_version_played_and_default_to_the_merged_one(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        books::merge::run(&c.st, m).await.unwrap();
        let (user, lib, edition): (i32, i32, i32) = sqlx::query_as(
            r#"SELECT (SELECT min(id) FROM users), m."libraryId",
                      (SELECT id FROM editions WHERE "mediaId" = m.id AND family = 'audio')
               FROM media m WHERE m.id = $1"#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        let n = |v: Option<i32>| {
            let db = c.st.db.clone();
            async move {
                crate::media::books::chapters(&db, user, m, edition, v, &[lib])
                    .await
                    .unwrap()
                    .len()
            }
        };
        assert_eq!(
            (n(None).await, n(Some(1)).await, n(Some(0)).await),
            (1, 1, 2)
        );
        let missing =
            crate::media::books::chapters(&c.st.db, user, m, edition, Some(7), &[lib]).await;
        assert_eq!(
            missing.unwrap_err().status(),
            axum::http::StatusCode::NOT_FOUND
        );
    }

    #[sqlx::test(migrations = false)]
    async fn nothing_merges_while_the_library_option_is_off(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, false, 1).await;
        books::merge::run(&c.st, m).await.unwrap();
        assert!(c.fake.seen("POST", "/v1/jobs").is_empty());
        assert_eq!(parts(&c, m).await.len(), 2);
    }

    #[sqlx::test(migrations = false)]
    async fn an_ebook_and_an_audiobook_are_two_editions_of_one_work(pool: PgPool) {
        let c = ctx(pool).await;
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let m = book(&c, "Mirelune").await;
        epub(&c.dir.join("books/Mirelune/Mirelune.epub"));
        touch(&c.dir.join("books/Mirelune/Mirelune.m4b"), b"a");
        books::register(
            &c.st,
            m,
            &placed(&c, &["Mirelune/Mirelune.epub", "Mirelune/Mirelune.m4b"]),
        )
        .await
        .unwrap();
        let eds: Vec<(String, Option<String>)> = sqlx::query_as(
            r#"SELECT family, format FROM editions WHERE "mediaId" = $1 ORDER BY id"#,
        )
        .bind(m)
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            eds,
            [
                ("text".to_owned(), Some("epub".to_owned())),
                ("audio".to_owned(), Some("m4b".to_owned()))
            ]
        );
        assert_eq!(
            count(&c, "SELECT count(*) FROM items WHERE \"groupId\" IS NULL").await,
            2
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_transfer_keeps_every_part_and_names_them_by_position(pool: PgPool) {
        let c = ctx(pool).await;
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let m = book(&c, "Orfaline").await;
        let inbox = c.dir.join("inbox/Orfaline");
        for r in ["02.mp3", "01.mp3"] {
            touch(&inbox.join(r), r.as_bytes());
        }
        let guard = c.st.ingest.media.lock(m).await;
        let out = library::ingest(
            &c.st,
            &guard,
            Request {
                media_id: m,
                files: ["02.mp3", "01.mp3"]
                    .iter()
                    .map(|r| File {
                        path: inbox.join(r),
                        episode_id: None,
                    })
                    .collect(),
                transfer: Method::Copy,
                fallback_quality: None,
                release_name: None,
                force: false,
                uniquify_on_collision: false,
                replace_existing: false,
            },
        )
        .await
        .unwrap();
        assert_eq!((out.imported.len(), out.errors.len()), (2, 0));
        assert_eq!(
            parts(&c, m).await,
            [
                ("Orfaline/Orfaline - 01.mp3".to_owned(), 0, 0),
                ("Orfaline/Orfaline - 02.mp3".to_owned(), 0, 1)
            ]
        );
        assert!(inbox.join("01.mp3").exists());
    }

    #[sqlx::test(migrations = false)]
    async fn the_orphan_scan_groups_book_files_into_works(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("shelf");
        let l = library(&c, "B", &lib, r#"["book"]"#).await;
        for r in [
            "Brumevent/01.mp3",
            "Brumevent/02.mp3",
            "Aldric Vexmoor - Le Phare des Brumes.epub",
            "notes.txt",
        ] {
            touch(&lib.join(r), b"x");
        }
        let (s, b) = call(
            &c,
            "POST",
            &format!("/api/imports/library/{l}/orphans/scan"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 201);
        let groups = b["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        let audio = groups
            .iter()
            .find(|g| g["folderName"] == "Brumevent")
            .unwrap();
        assert_eq!(
            (
                audio["mediaType"].as_str(),
                audio["files"].as_array().unwrap().len()
            ),
            (Some("book"), 2)
        );
        let text = groups.iter().find(|g| g["folderName"] == "").unwrap();
        assert_eq!(text["guessTitle"], "Le Phare des Brumes");
        assert_eq!(b["orphanCount"], 3);
    }

    async fn shelf(c: &Ctx) -> i32 {
        library(c, "B", &c.dir.join("books"), r#"["book"]"#).await
    }

    async fn loose(c: &Ctx, l: i32, title: &str) -> i32 {
        let m = media(c, l, title, "book").await;
        sqlx::query(r#"UPDATE media SET "folderName" = '' WHERE id = $1"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
        m
    }

    #[sqlx::test(migrations = false)]
    async fn deleting_a_book_keeps_the_files_a_loose_book_owns_in_its_folder(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let a = media(&c, l, "Shared", "book").await;
        let b = loose(&c, l, "Other").await;
        epub(&lib.join("Shared/Mirelune.epub"));
        epub(&lib.join("Shared/Orfaline.epub"));
        books::register(&c.st, a, &placed(&c, &["Shared/Mirelune.epub"]))
            .await
            .unwrap();
        books::register(&c.st, b, &placed(&c, &["Shared/Orfaline.epub"]))
            .await
            .unwrap();
        let (s, _) = call(
            &c,
            "DELETE",
            &format!("/api/media/{a}"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 200);
        assert!(eventually(|| !lib.join("Shared/Mirelune.epub").exists()).await);
        assert!(lib.join("Shared/Orfaline.epub").exists());
    }

    #[sqlx::test(migrations = false)]
    async fn deleting_a_book_keeps_the_files_it_does_not_own(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let m = media(&c, l, "Solo", "book").await;
        epub(&lib.join("Solo/Sub/Mirelune.epub"));
        touch(&lib.join("Solo/notes.txt"), b"mine");
        books::register(&c.st, m, &placed(&c, &["Solo/Sub/Mirelune.epub"]))
            .await
            .unwrap();
        let (s, _) = call(
            &c,
            "DELETE",
            &format!("/api/media/{m}"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 200);
        assert!(eventually(|| !lib.join("Solo/Sub").exists()).await);
        assert_eq!(fs::read(lib.join("Solo/notes.txt")).unwrap(), b"mine");
    }

    #[sqlx::test(migrations = false)]
    async fn a_second_work_is_refused_before_it_is_moved(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let m = media(&c, l, "Mirelune", "book").await;
        epub(&lib.join("Mirelune/Mirelune.epub"));
        books::register(&c.st, m, &placed(&c, &["Mirelune/Mirelune.epub"]))
            .await
            .unwrap();
        let src = c.dir.join("inbox/Brumevent.epub");
        epub(&src);
        let guard = c.st.ingest.media.lock(m).await;
        let out = library::ingest(
            &c.st,
            &guard,
            Request {
                media_id: m,
                files: vec![File {
                    path: src.clone(),
                    episode_id: None,
                }],
                transfer: Method::Move,
                fallback_quality: None,
                release_name: None,
                force: false,
                uniquify_on_collision: true,
                replace_existing: false,
            },
        )
        .await
        .unwrap();
        assert_eq!((out.errors.len(), out.already_present.len()), (1, 0));
        assert!(src.exists());
        assert!(!lib.join("Mirelune/Mirelune (2).epub").exists());
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn a_rescan_leaves_the_files_of_other_books_in_the_folder(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let a = media(&c, l, "Shared", "book").await;
        let b = loose(&c, l, "Other").await;
        for r in ["Mirelune", "Orfaline", "Brumevent"] {
            epub(&lib.join(format!("Shared/{r}.epub")));
        }
        books::register(&c.st, a, &placed(&c, &["Shared/Mirelune.epub"]))
            .await
            .unwrap();
        books::register(&c.st, b, &placed(&c, &["Shared/Orfaline.epub"]))
            .await
            .unwrap();
        let counts = rescan(&c, a).await.unwrap();
        assert_eq!(counts.added, 0);
        assert_eq!(
            parts(&c, a).await,
            [("Shared/Mirelune.epub".to_owned(), 0, 0)]
        );
        assert_eq!(
            parts(&c, b).await,
            [("Shared/Orfaline.epub".to_owned(), 0, 0)]
        );
        let reg = books::register(
            &c.st,
            a,
            &placed(&c, &["Shared/Brumevent.epub", "Shared/Orfaline.epub"]),
        )
        .await
        .unwrap();
        assert_eq!((reg.files.len(), reg.conflicts.len()), (0, 2));
    }

    #[sqlx::test(migrations = false)]
    async fn a_book_in_an_author_folder_rescans_and_deletes_with_its_folder(pool: PgPool) {
        let c = ctx(pool).await;
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let m = media(&c, l, "Olympe Faucheval/Orfaline", "book").await;
        for r in ["01.mp3", "02.mp3"] {
            touch(&lib.join("Olympe Faucheval/Orfaline").join(r), b"x");
        }
        books::register(
            &c.st,
            m,
            &placed(
                &c,
                &[
                    "Olympe Faucheval/Orfaline/01.mp3",
                    "Olympe Faucheval/Orfaline/02.mp3",
                ],
            ),
        )
        .await
        .unwrap();
        touch(&lib.join("Olympe Faucheval/Orfaline/03.mp3"), b"x");
        assert_eq!(rescan(&c, m).await.unwrap().added, 1);
        std::fs::remove_file(lib.join("Olympe Faucheval/Orfaline/01.mp3")).unwrap();
        assert_eq!(rescan(&c, m).await.unwrap().removed, 1);
        let positions: Vec<i32> = parts(&c, m).await.iter().map(|p| p.2).collect();
        assert_eq!(positions, [0, 1]);
        let (s, _) = call(
            &c,
            "DELETE",
            &format!("/api/media/{m}"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 200);
        assert!(eventually(|| !lib.join("Olympe Faucheval/Orfaline").exists()).await);
        assert!(lib.join("Olympe Faucheval").exists());
    }

    #[sqlx::test(migrations = false)]
    async fn positions_close_up_when_a_part_goes_and_the_new_files_are_refused(pool: PgPool) {
        let c = ctx(pool).await;
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let m = media(&c, l, "Orfaline", "book").await;
        for r in ["01.mp3", "02.mp3", "03.mp3"] {
            touch(&lib.join("Orfaline").join(r), b"x");
        }
        books::register(
            &c.st,
            m,
            &placed(
                &c,
                &["Orfaline/01.mp3", "Orfaline/02.mp3", "Orfaline/03.mp3"],
            ),
        )
        .await
        .unwrap();
        fs::remove_file(lib.join("Orfaline/01.mp3")).unwrap();
        for r in ["Mirelune", "Brumevent"] {
            epub(&lib.join(format!("Orfaline/{r}.epub")));
        }
        let counts = rescan(&c, m).await.unwrap();
        assert_eq!((counts.removed, counts.added), (1, 0));
        let positions: Vec<i32> = parts(&c, m).await.iter().map(|p| p.2).collect();
        assert_eq!(positions, [0, 1]);
    }

    #[sqlx::test(migrations = false)]
    async fn the_orphan_scan_anchors_a_deep_work_and_not_a_shared_folder(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("shelf");
        let l = library(&c, "B", &lib, r#"["book"]"#).await;
        for r in [
            "Olympe Faucheval/Cycle/Orfaline/CD1/01.mp3",
            "Olympe Faucheval/Cycle/Orfaline/CD2/01.mp3",
            "Duo/Mirelune.epub",
            "Duo/Brumevent.epub",
            "Mixte/Nuee.epub",
            "Mixte/Cave/01.mp3",
        ] {
            touch(&lib.join(r), b"x");
        }
        let (s, b) = call(
            &c,
            "POST",
            &format!("/api/imports/library/{l}/orphans/scan"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 201);
        let mut named: Vec<(String, usize)> = b["groups"]
            .as_array()
            .unwrap()
            .iter()
            .map(|g| {
                (
                    g["folderName"].as_str().unwrap().to_owned(),
                    g["files"].as_array().unwrap().len(),
                )
            })
            .collect();
        named.sort();
        assert_eq!(
            named,
            [
                ("".to_owned(), 1),
                ("".to_owned(), 1),
                ("".to_owned(), 1),
                ("Mixte/Cave".to_owned(), 1),
                ("Olympe Faucheval/Cycle/Orfaline".to_owned(), 2),
            ]
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_linked_work_makes_its_folder_shared_for_the_orphan_scan(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let a = loose(&c, l, "Linked").await;
        epub(&lib.join("Duo/Mirelune.epub"));
        touch(&lib.join("Duo/Brumevent.epub"), b"x");
        books::register(&c.st, a, &placed(&c, &["Duo/Mirelune.epub"]))
            .await
            .unwrap();
        let (s, b) = call(
            &c,
            "POST",
            &format!("/api/imports/library/{l}/orphans/scan"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 201);
        let groups = b["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["folderName"], "");
    }

    #[sqlx::test(migrations = false)]
    async fn a_cover_is_checked_and_stored_under_one_lock(pool: PgPool) {
        let c = ctx(pool).await;
        let l = shelf(&c).await;
        let m = media(&c, l, "Mirelune", "book").await;
        let mut png = vec![];
        image::RgbImage::new(2, 2)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let held = c.st.ingest.covers.lock(m).await;
        let st = c.st.clone();
        let task = tokio::spawn(async move { books::store_cover(&st, m, &png).await });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        sqlx::query(r#"UPDATE media SET "posterUrl" = 'kept' WHERE id = $1"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
        drop(held);
        task.await.unwrap();
        let poster: Option<String> =
            sqlx::query_scalar(r#"SELECT "posterUrl" FROM media WHERE id = $1"#)
                .bind(m)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!(poster.as_deref(), Some("kept"));
    }
}

mod book_import {
    use super::*;
    use crate::{
        jobs::book_import,
        metadata::{
            Call, EditionRef, Guarded, MetadataProvider, PersonDetails, Search, Upstream,
            stub::serve,
        },
    };
    use fliks_domain::{
        external_id::Namespace,
        media::kind::MediaKind,
        metadata::{
            language::Resolved,
            limiter::{Limits, Priority},
        },
    };
    use std::{
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    /// OpenLibrary stand-in behind a real `Guarded`: a title answers a hit when its number is not a
    /// multiple of three, and every call is recorded with its priority.
    struct Stubbed {
        g: Guarded,
        limits: Limits,
        priorities: Mutex<Vec<Priority>>,
        busy: Mutex<(u32, u32)>,
        /// Searches that fail 503 before the first answer.
        down: Mutex<u32>,
        /// Searches rejected 400 before the first answer.
        rejects: Mutex<u32>,
        /// Dropped by the first search: deletes every book media, as a user would mid-import.
        wipe: Mutex<Option<PgPool>>,
    }

    fn number(s: &str) -> u32 {
        s.chars()
            .filter(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .unwrap_or(0)
    }

    impl Stubbed {
        async fn call(&self, path: String, p: Priority) -> Result<Value, Upstream> {
            self.priorities.lock().unwrap().push(p);
            {
                let mut b = self.busy.lock().unwrap();
                b.0 += 1;
                b.1 = b.1.max(b.0);
            }
            let r = self.g.get_json(&path, &[], p).await;
            self.busy.lock().unwrap().0 -= 1;
            r
        }
    }

    fn gone<T: Send + 'static>() -> Call<'static, T> {
        Box::pin(async { Err(Upstream::new(Some(500), "unused")) })
    }

    impl MetadataProvider for Stubbed {
        fn id(&self) -> Namespace {
            Namespace::OPENLIBRARY
        }
        fn supports(&self, kind: MediaKind) -> bool {
            kind == MediaKind::Book
        }
        fn has_persons(&self) -> bool {
            false
        }
        fn limits(&self) -> Limits {
            self.limits
        }
        fn search<'a>(
            &'a self,
            q: &'a Search<'a>,
            _: &'a Resolved,
            p: Priority,
        ) -> Call<'a, Vec<Value>> {
            Box::pin(async move {
                {
                    let mut down = self.down.lock().unwrap();
                    if *down > 0 {
                        *down -= 1;
                        return Err(Upstream::new(Some(503), "provider down"));
                    }
                }
                {
                    let mut rejects = self.rejects.lock().unwrap();
                    if *rejects > 0 {
                        *rejects -= 1;
                        return Err(Upstream::new(Some(400), "bad query"));
                    }
                }
                let wipe = self.wipe.lock().unwrap().take();
                if let Some(db) = wipe {
                    sqlx::query("DELETE FROM media WHERE type = 'book'")
                        .execute(&db)
                        .await
                        .unwrap();
                }
                let title = q.title.unwrap_or_default();
                let n = number(title);
                let hit = self.call(format!("/search/{n}"), p).await?;
                if hit["hit"] != true {
                    return Ok(vec![]);
                }
                let authors: Vec<Value> = q.author.iter().map(|a| json!({"name": a})).collect();
                Ok(vec![
                    json!({"externalId": format!("OL{n}W"), "title": title, "authors": authors}),
                ])
            })
        }
        fn fetch_work<'a>(
            &'a self,
            _: MediaKind,
            id: &'a str,
            _: &'a Resolved,
            p: Priority,
        ) -> Call<'a, Value> {
            Box::pin(async move {
                self.call(format!("/work/{}", number(id)), p).await?;
                Ok(
                    json!({"title": format!("Work {id}"), "authors": [{"name": format!("Writer {id}")}]}),
                )
            })
        }
        fn fetch_children<'a>(
            &'a self,
            _: MediaKind,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Vec<Value>> {
            gone()
        }
        fn child_stubs<'a>(
            &'a self,
            _: MediaKind,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Vec<Value>> {
            gone()
        }
        fn find_by<'a>(
            &'a self,
            _: Namespace,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Option<(String, MediaKind)>> {
            Box::pin(async { Ok(None) })
        }
        fn fetch_person<'a>(
            &'a self,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, PersonDetails> {
            gone()
        }
        fn person_credits<'a>(
            &'a self,
            _: &'a str,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, crate::metadata::Credits> {
            gone()
        }
        fn fetch_edition<'a>(
            &'a self,
            _: &'a EditionRef<'a>,
            _: &'a Resolved,
            _: Priority,
        ) -> Call<'a, Option<Value>> {
            Box::pin(async { Ok(None) })
        }
    }

    /// The stub, its limits and the instant of every request it served.
    async fn stubbed(limits: Limits) -> (Arc<Stubbed>, Arc<Mutex<Vec<Instant>>>) {
        let seen = Arc::new(Mutex::new(vec![]));
        let log = seen.clone();
        let (url, _) = serve(move |path, _| {
            log.lock().unwrap().push(Instant::now());
            let hit = path
                .strip_prefix("/search/")
                .is_none_or(|n| !number(n).is_multiple_of(3));
            (200, None, json!({"hit": hit}).to_string())
        })
        .await;
        let g = Guarded::new("stub", &url, Duration::from_secs(5), vec![], limits);
        let p = Stubbed {
            g,
            limits,
            priorities: Mutex::default(),
            busy: Mutex::default(),
            down: Mutex::default(),
            rejects: Mutex::default(),
            wipe: Mutex::default(),
        };
        (Arc::new(p), seen)
    }

    fn work(c: &Ctx, n: u32) {
        let (a, t) = (format!("Author{n:04}"), format!("Title{n:04}"));
        touch(
            &c.dir.join(format!("books/{a}/{t}/{t}.epub")),
            format!("book {n}").as_bytes(),
        );
    }

    async fn shelf(c: &Ctx) -> i32 {
        library(c, "B", &c.dir.join("books"), r#"["book"]"#).await
    }

    async fn start(c: &Ctx, lib: i32) -> (u16, Value) {
        let uri = format!("/api/imports/library/{lib}/books");
        call(c, "POST", &uri, &c.admin, json!({})).await
    }

    async fn state(c: &Ctx, lib: i32) -> Value {
        let uri = format!("/api/imports/library/{lib}/books");
        call(c, "GET", &uri, &c.admin, json!({})).await.1
    }

    async fn finished(c: &Ctx, lib: i32, secs: u64) -> Value {
        for _ in 0..secs * 10 {
            let s = state(c, lib).await;
            if s["status"] != "running" {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("the import did not finish");
    }

    async fn rows(c: &Ctx, sql: &'static str) -> Vec<(String, String)> {
        sqlx::query_as(sql).fetch_all(&c.st.db).await.unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn a_library_is_classified_imported_and_queued(pool: PgPool) {
        let (p, _) = stubbed(Limits::new(1000.0, 100)).await;
        let c = ctx_with(pool, Some(p)).await;
        let l = shelf(&c).await;
        let books = c.dir.join("books");
        work(&c, 1);
        work(&c, 3);
        touch(&books.join("Loose0002.epub"), b"2");
        touch(&books.join("Shelf/One0004.epub"), b"4");
        touch(&books.join("Shelf/Two0005.epub"), b"5");
        touch(&books.join("Gamma/Gamma0007.epub"), b"7");
        touch(&books.join("Gamma/Gamma0007.pdf"), b"7");
        touch(&books.join("Notes/readme.txt"), b"not a book");
        let other = media(&c, l, "", "book").await;
        sqlx::query(r#"INSERT INTO media_files ("mediaId", "folderId", "relativePath", size, quality)
               SELECT $1, df."folderId", 'Gamma/Gamma0007.epub', 1, 'epub' FROM library_default_folders df
               WHERE df."libraryId" = $2"#)
            .bind(other)
            .bind(l)
            .execute(&c.st.db)
            .await
            .unwrap();
        assert_eq!(
            call(
                &c,
                "GET",
                &format!("/api/imports/library/{l}/books"),
                &c.admin,
                json!({})
            )
            .await
            .0,
            404
        );
        let (s, b) = start(&c, l).await;
        assert_eq!(s, 202, "{b}");
        let done = finished(&c, l, 30).await;
        assert_eq!(done["status"], "completed", "{done}");
        let manual = rows(
            &c,
            "SELECT title, status FROM book_import_items WHERE status <> 'matched' ORDER BY title",
        )
        .await;
        assert_eq!(
            (&done["total"], &done["failed"], &done["skipped"]),
            (&json!(6), &json!(0), &json!(0)),
            "{done}"
        );
        // an odd title has no hit; a loose file has no author to confirm one
        assert_eq!(
            manual,
            [
                ("Loose0002".into(), "manual".into()),
                ("Title0003".into(), "manual".into())
            ]
        );
        let media_of = rows(
            &c,
            r#"SELECT f."relativePath", m."folderName" FROM media_files f JOIN media m ON m.id = f."mediaId"
               WHERE m.type = 'book' ORDER BY f."relativePath""#,
        )
        .await;
        let named: Vec<(&str, &str)> = media_of
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        assert_eq!(
            named,
            [
                (
                    "Author0001/Title0001/Title0001.epub",
                    "Author0001/Title0001"
                ),
                (
                    "Author0003/Title0003/Title0003.epub",
                    "Author0003/Title0003"
                ),
                ("Gamma/Gamma0007.epub", ""),
                ("Gamma/Gamma0007.pdf", ""),
                ("Loose0002.epub", ""),
                ("Shelf/One0004.epub", ""),
                ("Shelf/Two0005.epub", ""),
            ]
        );
        let owner: i32 = sqlx::query_scalar(
            r#"SELECT "mediaId" FROM media_files WHERE "relativePath" = 'Gamma/Gamma0007.epub'"#,
        )
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(owner, other);
        let (_, q) = call(
            &c,
            "GET",
            &format!("/api/imports/library/{l}/books/queue"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(q["total"], 2, "{q}");
        let first = q["items"][0]["mediaId"].as_i64().unwrap();
        sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'book', 'openlibrary', 'OL99W')"#)
            .bind(first)
            .execute(&c.st.db)
            .await
            .unwrap();
        let (_, q) = call(
            &c,
            "GET",
            &format!("/api/imports/library/{l}/books/queue"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(q["total"], 1, "{q}");
        assert_eq!(start(&c, l).await.0, 202);
        let again = finished(&c, l, 30).await;
        assert_eq!(
            (&again["total"], &again["status"]),
            (&json!(0), &json!("completed")),
            "{again}"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_second_import_is_refused_and_a_library_without_books_too(pool: PgPool) {
        let c = ctx(pool).await;
        let l = shelf(&c).await;
        let movies = library(&c, "M", &c.dir.join("movies"), r#"["movie"]"#).await;
        assert_eq!(start(&c, movies).await.0, 400);
        let user: i32 = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO book_imports ("libraryId", "userId", total) VALUES ($1, $2, 0)"#,
        )
        .bind(l)
        .bind(user)
        .execute(&c.st.db)
        .await
        .unwrap();
        let (s, b) = start(&c, l).await;
        assert_eq!(
            (s, b["message"].as_str()),
            (409, Some("errors.already_running"))
        );
    }

    #[sqlx::test(migrations = false)]
    async fn the_import_waits_for_a_folder_move(pool: PgPool) {
        let (p, _) = stubbed(Limits::new(1000.0, 100)).await;
        let c = ctx_with(pool, Some(p)).await;
        let l = shelf(&c).await;
        work(&c, 1);
        let moving = c.st.folder_moves.write().await;
        assert_eq!(start(&c, l).await.0, 202);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 0);
        assert_eq!(state(&c, l).await["status"], "running");
        drop(moving);
        assert_eq!(finished(&c, l, 20).await["status"], "completed");
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn an_interrupted_import_resumes_without_repeating_a_work(pool: PgPool) {
        let (p, _) = stubbed(Limits::new(1000.0, 100)).await;
        let c = ctx_with(pool, Some(p)).await;
        let l = shelf(&c).await;
        for n in 1..=40 {
            work(&c, n);
        }
        let user: i32 = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO book_imports ("libraryId", "userId") VALUES ($1, $2) RETURNING id"#,
        )
        .bind(l)
        .bind(user)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        let task = tokio::spawn(book_import::run(c.st.clone(), id));
        let mut seen = 0;
        while seen < 5 {
            tokio::time::sleep(Duration::from_millis(20)).await;
            seen = count(
                &c,
                "SELECT count(*) FROM book_import_items WHERE status <> 'pending'",
            )
            .await;
        }
        task.abort();
        let _ = task.await;
        let s = state(&c, l).await;
        assert_eq!(
            (&s["status"], &s["total"]),
            (&json!("running"), &json!(40)),
            "{s}"
        );
        assert!(s["pending"].as_i64().unwrap() > 0, "{s}");
        book_import::resume(&c.st).await;
        let done = finished(&c, l, 60).await;
        assert_eq!(
            (&done["status"], &done["pending"], &done["manual"]),
            (&json!("completed"), &json!(0), &json!(13)),
            "{done}"
        );
        assert_eq!(
            count(&c, "SELECT count(*) FROM media WHERE type = 'book'").await,
            40
        );
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 40);
    }

    #[sqlx::test(migrations = false)]
    async fn an_item_whose_media_vanishes_fails_alone(pool: PgPool) {
        let (p, _) = stubbed(Limits::new(1000.0, 100)).await;
        *p.wipe.lock().unwrap() = Some(pool.clone());
        let c = ctx_with(pool, Some(p)).await;
        let l = shelf(&c).await;
        work(&c, 1);
        work(&c, 2);
        assert_eq!(start(&c, l).await.0, 202);
        let done = finished(&c, l, 20).await;
        assert_eq!(
            (&done["status"], &done["pending"], &done["total"]),
            (&json!("completed"), &json!(0), &json!(2)),
            "{done}"
        );
        let first: (String, Option<i32>) = sqlx::query_as(
            r#"SELECT status, "mediaId" FROM book_import_items ORDER BY id LIMIT 1"#,
        )
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(first, ("manual".into(), None));
        assert_eq!(done["matched"], 1, "{done}");
    }

    #[sqlx::test(migrations = false)]
    async fn a_provider_outage_keeps_the_item_pending_until_it_recovers(pool: PgPool) {
        let (p, _) = stubbed(Limits::new(1000.0, 100)).await;
        *p.down.lock().unwrap() = 1;
        let c = ctx_with(pool, Some(p)).await;
        let l = shelf(&c).await;
        work(&c, 1);
        assert_eq!(start(&c, l).await.0, 202);
        let mut cause = None;
        for _ in 0..100 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            cause = sqlx::query_scalar::<_, Option<String>>(
                "SELECT error FROM book_import_items WHERE status = 'pending' LIMIT 1",
            )
            .fetch_optional(&c.st.db)
            .await
            .unwrap()
            .flatten();
            if cause.is_some() {
                break;
            }
        }
        assert!(cause.is_some_and(|e| e.contains("provider down")));
        let done = finished(&c, l, 30).await;
        assert_eq!(
            (&done["status"], &done["matched"], &done["manual"]),
            (&json!("completed"), &json!(1), &json!(0)),
            "{done}"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_permanent_provider_error_fails_its_item_and_not_the_next(pool: PgPool) {
        let (p, _) = stubbed(Limits::new(1000.0, 100)).await;
        *p.rejects.lock().unwrap() = 1;
        let c = ctx_with(pool, Some(p)).await;
        let l = shelf(&c).await;
        work(&c, 1);
        work(&c, 2);
        assert_eq!(start(&c, l).await.0, 202);
        let done = finished(&c, l, 20).await;
        assert_eq!(
            (
                &done["status"],
                &done["failed"],
                &done["matched"],
                &done["pending"]
            ),
            (&json!("completed"), &json!(1), &json!(1), &json!(0)),
            "{done}"
        );
        let cause: String =
            sqlx::query_scalar("SELECT error FROM book_import_items WHERE status = 'failed'")
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert!(cause.contains("bad query"), "{cause}");
    }

    #[sqlx::test(migrations = false)]
    async fn a_folder_that_moved_after_its_path_was_read_is_not_linked(pool: PgPool) {
        let c = ctx(pool).await;
        let l = shelf(&c).await;
        work(&c, 1);
        let user: i32 = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        let (folder, path): (i32, String) =
            sqlx::query_as(r#"SELECT id, path FROM library_folders WHERE "libraryId" = $1"#)
                .bind(l)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        let work = |folder_path: &str| crate::ingest::disk::BookWork {
            library_id: l,
            folder_id: folder,
            folder_path: folder_path.into(),
            folder_name: "Author0001/Title0001".into(),
            title: "Title0001".into(),
            year: None,
            files: vec![c.dir.join("books/Author0001/Title0001/Title0001.epub")],
        };
        let err = crate::ingest::disk::link_book_work(&c.st, user, work("/elsewhere"))
            .await
            .err()
            .expect("a stale folder path");
        assert_eq!(err.text(), crate::ingest::disk::FOLDER_MOVED);
        assert_eq!(count(&c, "SELECT count(*) FROM media").await, 0);
        let linked = crate::ingest::disk::link_book_work(&c.st, user, work(&path))
            .await
            .unwrap();
        assert_eq!(linked.linked, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn many_works_stay_under_the_provider_limits(pool: PgPool) {
        const WORKS: u32 = 200;
        let limits = Limits::new(200.0, 10);
        let (p, seen) = stubbed(limits).await;
        let c = ctx_with(pool, Some(p.clone())).await;
        let l = shelf(&c).await;
        for n in 1..=WORKS {
            work(&c, n);
        }
        assert_eq!(start(&c, l).await.0, 202);
        let done = finished(&c, l, 900).await;
        assert_eq!(done["status"], "completed", "{done}");
        let manual = (1..=WORKS).filter(|n| n % 3 == 0).count() as u32;
        assert_eq!(
            (
                &done["total"],
                &done["matched"],
                &done["manual"],
                &done["failed"]
            ),
            (
                &json!(WORKS),
                &json!(WORKS - manual),
                &json!(manual),
                &json!(0)
            ),
            "{done}"
        );
        assert!(
            p.priorities
                .lock()
                .unwrap()
                .iter()
                .all(|p| *p == Priority::Background)
        );
        assert_eq!(p.busy.lock().unwrap().1, 1, "lookups run one at a time");
        let at = seen.lock().unwrap().clone();
        let background = p.limits.rate_per_sec * p.limits.background_share;
        let ceiling = (f64::from(p.limits.burst) + background * 1.0 + 1.0) as usize;
        let busiest = (0..at.len())
            .map(|i| {
                at[i..]
                    .iter()
                    .take_while(|t| t.duration_since(at[i]) < Duration::from_secs(1))
                    .count()
            })
            .max()
            .unwrap_or(0);
        assert!(
            busiest <= ceiling,
            "{busiest} requests in one second, ceiling {ceiling}"
        );
    }
}

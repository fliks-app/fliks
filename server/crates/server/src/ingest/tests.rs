//! Write-path safety (`ingest.md` V1-V19, `media-write.md` V1-V3): generated trees under
//! `/tmp/fliks-parity/s5-ingest/tests`, a fake engine for the probes, a throwaway DB.
use super::fsx;
use crate::auth::testing as session;
use crate::{
    app,
    config::Config,
    engine::testkit::{Fake, RUNTIME, hello_body, ok, status},
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

/// A provider of `ns` serving movies and series, for a relink that names it.
fn video_provider(
    ns: fliks_domain::external_id::Namespace,
) -> Option<std::sync::Arc<dyn crate::metadata::MetadataProvider>> {
    use fliks_domain::media::kind::MediaKind::{Movie, Series};
    Some(std::sync::Arc::new(
        crate::metadata::books::tests::Fake::new(ns).serving(&[Movie, Series]),
    ))
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
    let images = crate::images::ImageStore::with_root(dir.join("data"));
    let mut st = AppState::new(pool.clone(), cfg, SECRET);
    st.images = std::sync::Arc::new(images);
    if let Some(p) = provider {
        st.metadata.add_plugin(p);
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
        toks.push(session::token(&st, id, name).await);
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
    super::rescan::rescan_files(&c.st, &g, id, false).await
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
    crate::media::write::apply_seasons(&c.st, s, &[season], false)
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
    let c = ctx_with(
        pool,
        video_provider(fliks_domain::external_id::Namespace::TMDB),
    )
    .await;
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
async fn relink_refuses_a_provider_that_serves_nothing(pool: PgPool) {
    let c = ctx(pool).await;
    let lib = c.dir.join("movies");
    let l = library(&c, "M", &lib, r#"["movie"]"#).await;
    touch(&lib.join("Film (2001)/Film (2001).mkv"), b"f");
    let url = "/api/imports/library/orphans/relink";
    for provider in ["imdb", "org.example.gone:aid"] {
        let body = json!({"libraryId": l, "type": "movie", "folderName": "Film (2001)",
            "provider": provider, "externalId": "1",
            "files": [{"filePath": lib.join("Film (2001)/Film (2001).mkv")}]});
        let (s, b) = call(&c, "POST", url, &c.admin, body).await;
        assert_eq!(s, 400, "{provider}: {b}");
    }
    assert_eq!(count(&c, "SELECT count(*) FROM media").await, 0);
}

#[sqlx::test(migrations = false)]
async fn relink_does_not_pick_a_non_unique_id_held_in_another_library(pool: PgPool) {
    let c = ctx_with(
        pool,
        video_provider(fliks_domain::external_id::Namespace::TVDB),
    )
    .await;
    let a = library(&c, "A", &c.dir.join("a"), r#"["movie"]"#).await;
    let b = library(&c, "SecretLib", &c.dir.join("b"), r#"["movie"]"#).await;
    let other = media(&c, b, "Other (2000)", "movie").await;
    sqlx::query(
        r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value)
           VALUES ($1, 'movie', 'tvdb', '55')"#,
    )
    .bind(other)
    .execute(&c.st.db)
    .await
    .unwrap();
    touch(&c.dir.join("a/Film (2001)/Film (2001).mkv"), b"f");
    let body = json!({"libraryId": a, "type": "movie", "folderName": "Film (2001)",
        "provider": "tvdb", "externalId": "55",
        "files": [{"filePath": c.dir.join("a/Film (2001)/Film (2001).mkv")}]});
    let (s, b) = call(
        &c,
        "POST",
        "/api/imports/library/orphans/relink",
        &c.admin,
        body,
    )
    .await;
    assert_ne!(s, 201, "{b}");
    assert!(!b.to_string().contains("SecretLib"), "{b}");
    assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 0);
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
async fn a_deleted_media_takes_only_what_nothing_else_holds(pool: PgPool) {
    let c = ctx(pool).await;
    let l = library(&c, "M", &c.dir.join("movies"), r#"["movie"]"#).await;
    let (kept, gone) = (
        media(&c, l, "A", "movie").await,
        media(&c, l, "B", "movie").await,
    );
    let db = &c.st.db;
    let row = |sql: &'static str, name: &'static str| async move {
        sqlx::query_scalar::<_, i32>(sql)
            .bind(name)
            .fetch_one(db)
            .await
            .unwrap()
    };
    let person = |n| row("INSERT INTO persons (name) VALUES ($1) RETURNING id", n);
    let collection = |n| row("INSERT INTO collections (name) VALUES ($1) RETURNING id", n);
    let (shared, orphaned, followed, unrelated) = (
        person("P1").await,
        person("P2").await,
        person("P3").await,
        person("P4").await,
    );
    let (held, emptied, watched, untouched) = (
        collection("C1").await,
        collection("C2").await,
        collection("C3").await,
        collection("C4").await,
    );
    let link = |sql: &'static str, a: i32, b: i32| async move {
        sqlx::query(sql).bind(a).bind(b).execute(db).await.unwrap();
    };
    let credit =
        r#"INSERT INTO media_credits ("mediaId", "personId", role) VALUES ($1, $2, 'author')"#;
    let entry = r#"INSERT INTO collection_entries ("mediaId", "collectionId") VALUES ($1, $2)"#;
    for (m, p) in [
        (kept, shared),
        (gone, shared),
        (gone, orphaned),
        (gone, followed),
    ] {
        link(credit, m, p).await;
    }
    for (m, k) in [(kept, held), (gone, held), (gone, emptied), (gone, watched)] {
        link(entry, m, k).await;
    }
    link(
        r#"INSERT INTO person_follows ("userId", "personId", role, "libraryId", wants)
           SELECT id, $1, 'author', $2, '{}'::jsonb FROM users WHERE username = 'admin'"#,
        followed,
        l,
    )
    .await;
    link(
        r#"INSERT INTO series_watches ("userId", "collectionId", "libraryId", wants)
           SELECT id, $1, $2, '{}'::jsonb FROM users WHERE username = 'admin'"#,
        watched,
        l,
    )
    .await;
    let data = c.dir.join("data");
    let files = [
        format!("media/{kept}/poster.jpg"),
        format!("media/{gone}/poster.jpg"),
        format!("persons/{shared}.jpg"),
        format!("persons/{orphaned}.jpg"),
        format!("persons/{orphaned}-thumb.jpg"),
        format!("persons/{unrelated}.jpg"),
    ];
    for f in &files {
        touch(&data.join(f), b"x");
    }
    let mut tx = db.begin().await.unwrap();
    let refs = crate::media::write::orphans::refs_of(&mut tx, gone)
        .await
        .unwrap();
    sqlx::query("DELETE FROM media WHERE id = $1")
        .bind(gone)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();

    crate::media::write::orphans::clean(&c.st, &refs)
        .await
        .unwrap();

    let ids = |sql: &'static str, all: Vec<i32>| async move {
        sqlx::query_scalar::<_, i32>(sql)
            .bind(all)
            .fetch_all(db)
            .await
            .unwrap()
    };
    let persons = ids(
        "SELECT id FROM persons WHERE id = ANY($1) ORDER BY id",
        vec![shared, orphaned, followed, unrelated],
    );
    assert_eq!(persons.await, [shared, followed, unrelated]);
    let collections = ids(
        "SELECT id FROM collections WHERE id = ANY($1) ORDER BY id",
        vec![held, emptied, watched, untouched],
    );
    assert_eq!(collections.await, [held, watched, untouched]);
    let exists: Vec<bool> = files.iter().map(|f| data.join(f).exists()).collect();
    assert_eq!(exists, [true, false, true, false, false, true]);
}

#[sqlx::test(migrations = false)]
async fn a_merged_book_leaves_no_orphan_and_keeps_its_poster(pool: PgPool) {
    let c = ctx(pool).await;
    let db = &c.st.db;
    let (from, into) = (1, 2);
    sqlx::raw_sql(
        r#"INSERT INTO media (id, title, type, "posterUrl") VALUES
             (1, 'Dup', 'book', '/api/images/media/1/poster?v=x'), (2, 'Held', 'book', NULL);
           INSERT INTO editions (id, "mediaId", family) VALUES (1, 1, 'text');
           INSERT INTO persons (id, name) VALUES (1, 'Work'), (2, 'Edition');
           INSERT INTO media_credits ("mediaId", "personId", role) VALUES (1, 1, 'author');
           INSERT INTO media_credits ("mediaId", "editionId", "personId", role)
             VALUES (1, 1, 2, 'narrator');"#,
    )
    .execute(db)
    .await
    .unwrap();
    let data = c.dir.join("data");
    let mut jpg = vec![];
    image::RgbImage::new(4, 4)
        .write_to(
            &mut std::io::Cursor::new(&mut jpg),
            image::ImageFormat::Jpeg,
        )
        .unwrap();
    touch(&data.join("media/1/poster.jpg"), &jpg);
    let mut tx = db.begin().await.unwrap();
    let refs = crate::metadata::books::absorb::absorb(&mut tx, from, into)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    crate::metadata::books::absorb::carry_poster(&c.st, from, into).await;
    crate::media::write::orphans::clean(&c.st, &refs)
        .await
        .unwrap();
    let persons: Vec<i32> = sqlx::query_scalar("SELECT id FROM persons ORDER BY id")
        .fetch_all(db)
        .await
        .unwrap();
    assert_eq!(persons, [2]);
    assert!(!data.join("media/1").exists());
    assert!(data.join("media/2/poster.jpg").exists());
    let url: Option<String> = sqlx::query_scalar(r#"SELECT "posterUrl" FROM media WHERE id = 2"#)
        .fetch_one(db)
        .await
        .unwrap();
    assert!(url.is_some_and(|u| u.starts_with("/api/images/media/2/poster")));
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
    let profile: i32 = sqlx::query_scalar(
        r#"INSERT INTO quality_profiles (name, cutoff, items) VALUES ('P', 18, '[]') RETURNING id"#,
    )
    .fetch_one(&c.st.db)
    .await
    .unwrap();
    let (s, b) = call(
        &c,
        "POST",
        "/api/media/import/tmdb",
        &c.admin,
        json!({"type": "movie", "tmdbId": 5, "qualityProfileId": profile}),
    )
    .await;
    assert_eq!(
        (s, b["message"].clone()),
        (503, json!("The tmdb provider is not available"))
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

#[sqlx::test(migrations = false)]
async fn rescan_keeps_root_level_rows_when_the_root_is_empty(pool: PgPool) {
    let c = ctx(pool).await;
    let root = c.dir.join("movies");
    let l = library(&c, "M", &root, r#"["movie"]"#).await;
    let m = media(&c, l, "A", "movie").await;
    sqlx::query(r#"UPDATE media SET "folderName" = '' WHERE id = $1"#)
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
    file_row(&c, m, "A.mkv").await;
    let r = rescan(&c, m).await.unwrap();
    assert_eq!(r.removed, 0);
    touch(&root.join("Other.mkv"), b"o");
    assert_eq!(rescan(&c, m).await.unwrap().removed, 1);
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

    #[sqlx::test(migrations = false)]
    async fn the_orphan_cover_is_read_under_an_accessible_library_or_by_a_settings_manager(
        pool: PgPool,
    ) {
        let c = ctx(pool).await;
        let shelf = c.dir.join("shelf");
        let l = library(&c, "B", &shelf, r#"["book"]"#).await;
        epub(&shelf.join("Mirelune.epub"));
        epub(&c.dir.join("elsewhere/Mirelune.epub"));
        touch(&shelf.join("notes.txt"), b"x");
        let get = |tok: &str, rel: &str| {
            let uri = format!(
                "/api/imports/orphans/cover?path={}",
                c.dir.join(rel).display()
            );
            let tok = tok.to_owned();
            let c = &c;
            async move { call(c, "GET", &uri, &tok, Value::Null).await.0 }
        };
        assert_eq!(get(&c.admin, "elsewhere/Mirelune.epub").await, 200);
        assert_eq!(get(&c.editor, "shelf/Mirelune.epub").await, 404);
        sqlx::query(
            r#"INSERT INTO library_user_access ("userId", "libraryId")
               SELECT id, $1 FROM users WHERE username = 'editor'"#,
        )
        .bind(l)
        .execute(&c.st.db)
        .await
        .unwrap();
        assert_eq!(get(&c.editor, "shelf/Mirelune.epub").await, 200);
        assert_eq!(
            get(&c.editor, "shelf/../elsewhere/Mirelune.epub").await,
            404
        );
        assert_eq!(get(&c.editor, "elsewhere/Mirelune.epub").await, 404);
        assert_eq!(get(&c.admin, "shelf/notes.txt").await, 404);
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
    async fn a_book_found_on_disk_is_wished_in_its_files_families_only(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("books");
        let l = library(&c, "B", &lib, r#"["book"]"#).await;
        epub(&lib.join("Mirelune/Mirelune.epub"));
        let body = json!({"libraryId": l, "type": "book", "folderName": "Mirelune",
            "files": [{"filePath": lib.join("Mirelune/Mirelune.epub")}]});
        let (s, b) = call(
            &c,
            "POST",
            "/api/imports/library/orphans/relink",
            &c.admin,
            body,
        )
        .await;
        assert_eq!((s, b["created"].clone()), (201, json!(true)), "{b}");
        let families: Vec<String> = sqlx::query_scalar("SELECT family FROM wants")
            .fetch_all(&c.st.db)
            .await
            .unwrap();
        assert_eq!(families, ["text"]);
    }

    #[sqlx::test(migrations = false)]
    async fn a_cbz_book_takes_its_first_page_as_its_cover(pool: PgPool) {
        let c = ctx(pool).await;
        let m = book(&c, "Brumevent").await;
        let path = c.dir.join("books/Brumevent/Brumevent T01.cbz");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut png = vec![];
        image::RgbImage::new(8, 12)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let mut w = ZipWriter::new(fs::File::create(&path).unwrap());
        let o = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        w.start_file("p01.png", o).unwrap();
        w.write_all(&png).unwrap();
        w.finish().unwrap();
        books::register(&c.st, m, &placed(&c, &["Brumevent/Brumevent T01.cbz"]))
            .await
            .unwrap();
        let state = || async {
            sqlx::query_as::<_, (Option<String>, i64)>(
                r#"SELECT "posterUrl", (SELECT count(*) FROM editions WHERE "mediaId" = $1) FROM media WHERE id = $1"#,
            )
            .bind(m)
            .fetch_one(&c.st.db)
            .await
            .unwrap()
        };
        assert!(state().await.0.is_some());

        sqlx::query(r#"UPDATE media SET "posterUrl" = NULL WHERE id = $1"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
        let c = &c;
        let rescan = |force| async move {
            let g = c.st.ingest.media.lock(m).await;
            crate::ingest::rescan::rescan_files(&c.st, &g, m, force)
                .await
                .unwrap()
        };
        rescan(false).await;
        assert_eq!(
            state().await,
            (None, 1),
            "an unchanged file is not read again"
        );
        let forced = rescan(true).await;
        assert_eq!((forced.added, forced.updated), (0, 1));
        let (poster, editions) = state().await;
        assert!(poster.is_some());
        assert_eq!(editions, 1);
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
    async fn a_requested_language_gets_its_own_edition_and_a_relay_keeps_each(pool: PgPool) {
        let c = ctx(pool).await;
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let m = book(&c, "Orfaline").await;
        for r in [
            "Orfaline.epub",
            "Orfaline (fr).epub",
            "Orfaline.m4b",
            "Orfaline (en).m4b",
            "Orfaline.pdf",
        ] {
            touch(&c.dir.join("books/Orfaline").join(r), r.as_bytes());
        }
        let rels = |names: &[&str]| -> Vec<Placed> {
            let full: Vec<String> = names.iter().map(|r| format!("Orfaline/{r}")).collect();
            placed(&c, &full.iter().map(String::as_str).collect::<Vec<_>>())
        };
        books::register(&c.st, m, &rels(&["Orfaline.epub", "Orfaline.m4b"]))
            .await
            .unwrap();
        books::register_language(&c.st, m, &rels(&["Orfaline (fr).epub"]), Some("fr"))
            .await
            .unwrap();
        books::register_language(&c.st, m, &rels(&["Orfaline (en).m4b"]), Some("en"))
            .await
            .unwrap();
        let held = || async {
            sqlx::query_as::<_, (String, Option<String>, String)>(
                r#"SELECT e.family, e.language, f."relativePath" FROM editions e
                   JOIN items i ON i."editionId" = e.id JOIN item_parts p ON p."itemId" = i.id
                   JOIN media_files f ON f.id = p."mediaFileId" WHERE e."mediaId" = $1
                   ORDER BY e.id, f."relativePath""#,
            )
            .bind(m)
            .fetch_all(&c.st.db)
            .await
            .unwrap()
        };
        let row = |f: &str, l: Option<&str>, p: &str| {
            (f.to_owned(), l.map(str::to_owned), format!("Orfaline/{p}"))
        };
        let expect = vec![
            row("text", None, "Orfaline.epub"),
            row("audio", Some("fr"), "Orfaline.m4b"),
            row("text", Some("fr"), "Orfaline (fr).epub"),
            row("audio", Some("en"), "Orfaline (en).m4b"),
        ];
        let mut got = held().await;
        got.sort();
        let mut want = expect.clone();
        want.sort();
        assert_eq!(got, want);
        books::relay(&c.st, m).await.unwrap();
        let mut again = held().await;
        again.sort();
        assert_eq!(again, want, "a relay keeps each file in its edition");
        books::register(&c.st, m, &rels(&["Orfaline.pdf"]))
            .await
            .unwrap();
        let more = held()
            .await
            .into_iter()
            .find(|r| r.2.ends_with("Orfaline.pdf"))
            .unwrap();
        assert_eq!(
            (more.0.as_str(), more.1),
            ("text", None),
            "no language: the first edition"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn mp3_of_two_languages_stay_in_their_editions_through_a_relay(pool: PgPool) {
        let c = ctx(pool).await;
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let m = book(&c, "Orfaline").await;
        let all = [
            "Orfaline (en) - 01.mp3",
            "Orfaline (en) - 02.mp3",
            "Orfaline (fr) - 01.mp3",
            "Orfaline (fr) - 02.mp3",
        ];
        for r in all {
            touch(&c.dir.join("books/Orfaline").join(r), r.as_bytes());
        }
        let rels = |names: &[&str]| -> Vec<Placed> {
            let full: Vec<String> = names.iter().map(|r| format!("Orfaline/{r}")).collect();
            placed(&c, &full.iter().map(String::as_str).collect::<Vec<_>>())
        };
        for (language, names) in [("en", &all[..2]), ("fr", &all[2..])] {
            let reg = books::register_language(&c.st, m, &rels(names), Some(language))
                .await
                .unwrap();
            assert_eq!(reg.conflicts.len(), 0, "{:?}", reg.conflicts);
        }
        let held = || async {
            sqlx::query_as::<_, (Option<String>, i32, String)>(
                r#"SELECT e.language, p.version, f."relativePath" FROM editions e
                   JOIN items i ON i."editionId" = e.id JOIN item_parts p ON p."itemId" = i.id
                   JOIN media_files f ON f.id = p."mediaFileId" WHERE e."mediaId" = $1
                   ORDER BY e.id, p.version, p.position"#,
            )
            .bind(m)
            .fetch_all(&c.st.db)
            .await
            .unwrap()
        };
        let row = |l: &str, p: &str| (Some(l.to_owned()), 0, format!("Orfaline/{p}"));
        let want = vec![
            row("en", all[0]),
            row("en", all[1]),
            row("fr", all[2]),
            row("fr", all[3]),
        ];
        assert_eq!(held().await, want);
        books::relay(&c.st, m).await.unwrap();
        assert_eq!(held().await, want, "a relay keeps each file in its edition");
        books::register(&c.st, m, &rels(&all)).await.unwrap();
        assert_eq!(
            held().await,
            want,
            "a rescan keeps each file in its edition"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_single_mp3_per_language_gets_an_edition_each(pool: PgPool) {
        let c = ctx(pool).await;
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let m = book(&c, "Orfaline").await;
        let all = ["Orfaline (en).mp3", "Orfaline (fr).mp3"];
        for r in all {
            touch(&c.dir.join("books/Orfaline").join(r), r.as_bytes());
        }
        for (language, name) in [("en", all[0]), ("fr", all[1])] {
            let p = placed(&c, &[&format!("Orfaline/{name}")]);
            books::register_language(&c.st, m, &p, Some(language))
                .await
                .unwrap();
        }
        let got: Vec<(Option<String>, String)> = sqlx::query_as(
            r#"SELECT e.language, f."relativePath" FROM editions e
               JOIN items i ON i."editionId" = e.id JOIN item_parts p ON p."itemId" = i.id
               JOIN media_files f ON f.id = p."mediaFileId" WHERE e."mediaId" = $1 ORDER BY e.id"#,
        )
        .bind(m)
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            got,
            [
                (
                    Some("en".to_owned()),
                    "Orfaline/Orfaline (en).mp3".to_owned()
                ),
                (
                    Some("fr".to_owned()),
                    "Orfaline/Orfaline (fr).mp3".to_owned()
                )
            ]
        );
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
    async fn a_rescan_after_a_merge_keeps_the_m4b_and_the_parts_in_one_work(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        books::merge::run(&c.st, m).await.unwrap();
        let all = [
            "Orfaline/01.mp3",
            "Orfaline/02.mp3",
            "Orfaline/Orfaline.m4b",
        ];
        books::register(&c.st, m, &placed(&c, &all)).await.unwrap();
        assert_eq!(parts(&c, m).await.len(), 3);
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
        let parts = books::merge::pick(&rows, &[]).unwrap();
        sqlx::query(
            r#"INSERT INTO book_merges ("mediaId", "editionId", fingerprint, state, "folderId", output)
               VALUES ($1, $2, $3, 'running', 1, 'Orfaline/Orfaline.m4b')"#,
        )
        .bind(m)
        .bind(parts[0].edition)
        .bind(books::merge::fingerprint(&parts))
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
        assert_eq!(merge_state(&c, m).await.as_deref(), Some("done"));
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

    /// Runs the merge in the background, paused at the engine's job poll; `during` acts while it waits.
    async fn merge_during(c: &Ctx, m: i32, during: impl std::future::Future<Output = ()>) -> bool {
        let pause = c.fake.pause("GET", "/v1/jobs/j1");
        let st = c.st.clone();
        let run = tokio::spawn(async move { books::merge::run(&st, m).await });
        pause.reached().await;
        during.await;
        pause.release();
        run.await.unwrap().is_ok()
    }

    #[sqlx::test(migrations = false)]
    async fn a_part_moved_while_the_job_runs_discards_the_output(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        let moved = async {
            fs::rename(
                c.dir.join("books/Orfaline/02.mp3"),
                c.dir.join("books/Orfaline/elsewhere.mp3"),
            )
            .unwrap();
        };
        assert!(!merge_during(&c, m, moved).await);
        assert!(!c.dir.join("books/Orfaline/Orfaline.m4b").exists());
        assert_eq!(parts(&c, m).await.len(), 2);
        assert_eq!(merge_state(&c, m).await.as_deref(), Some("retry"));
    }

    #[sqlx::test(migrations = false)]
    async fn a_part_deleted_while_the_job_runs_discards_the_output(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        let deleted = async {
            fs::remove_file(c.dir.join("books/Orfaline/02.mp3")).unwrap();
        };
        assert!(!merge_during(&c, m, deleted).await);
        assert!(!c.dir.join("books/Orfaline/Orfaline.m4b").exists());
        assert_eq!(parts(&c, m).await.len(), 2);
    }

    #[sqlx::test(migrations = false)]
    async fn a_rescan_registering_the_output_while_the_job_runs_keeps_one_row(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        let rescanned = async {
            rescan(&c, m).await.unwrap();
        };
        merge_during(&c, m, rescanned).await;
        let out = c.dir.join("books/Orfaline/Orfaline.m4b");
        assert!(out.exists(), "a registered output is not removed");
        assert_eq!(
            count(
                &c,
                r#"SELECT count(*) FROM media_files WHERE "relativePath" = 'Orfaline/Orfaline.m4b'"#
            )
            .await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_deleted_m4b_is_not_merged_again_for_the_same_parts(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        books::merge::run(&c.st, m).await.unwrap();
        sqlx::query(r#"DELETE FROM media_files WHERE quality = 'm4b'"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        assert_eq!(parts(&c, m).await.len(), 2);
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), 1);
    }

    #[sqlx::test(migrations = false)]
    async fn a_settle_waits_for_a_quiet_period_after_the_last_import(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        books::merge::settle(&c.st, m).await.unwrap();
        assert!(
            c.fake.seen("POST", "/v1/jobs").is_empty(),
            "parts just arrived"
        );
        sqlx::query(r#"UPDATE media_files SET "createdAt" = now() - interval '1 hour'"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        books::merge::settle(&c.st, m).await.unwrap();
        assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), 1);
    }

    #[sqlx::test(migrations = false)]
    async fn settles_while_parts_arrive_share_one_waiter(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        books::merge::settle(&c.st, m).await.unwrap();
        books::merge::settle(&c.st, m).await.unwrap();
        assert_eq!(c.st.ingest.merge_waiting.lock().unwrap().len(), 1);
        assert!(c.fake.seen("POST", "/v1/jobs").is_empty());
    }

    #[sqlx::test(migrations = false)]
    async fn a_restart_settles_a_book_whose_merge_never_started(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        sqlx::query(r#"UPDATE media_files SET "createdAt" = now() - interval '1 hour'"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        books::merge::resume_backfills(&c.st).await;
        assert!(eventually(|| c.fake.seen("POST", "/v1/jobs").len() == 1).await);
        for _ in 0..100 {
            if parts(&c, m).await.len() == 3 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(parts(&c, m).await.len(), 3);
    }

    #[sqlx::test(migrations = false)]
    async fn a_flagged_backfill_resumes_after_a_restart(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        sqlx::query(r#"UPDATE libraries SET "mergeM4bBackfill" = 1"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        books::merge::resume_backfills(&c.st).await;
        let flagged = r#"SELECT count(*) FROM libraries WHERE "mergeM4bBackfill" > 0"#;
        for _ in 0..100 {
            if count(&c, flagged).await == 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), 1);
        assert_eq!(parts(&c, m).await.len(), 3);
        assert_eq!(count(&c, flagged).await, 0);
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

    async fn replace_on(c: &Ctx) {
        sqlx::query(r#"UPDATE libraries SET "mergeM4bReplace" = true"#)
            .execute(&c.st.db)
            .await
            .unwrap();
    }

    #[sqlx::test(migrations = false)]
    async fn a_verified_merge_replaces_the_parts_and_playback_moves_to_the_m4b(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        replace_on(&c).await;
        let (user, item, lib, edition): (i32, i32, i32, i32) = sqlx::query_as(
            r#"SELECT (SELECT min(id) FROM users), (SELECT min(id) FROM items WHERE "mediaId" = m.id),
                      m."libraryId", (SELECT id FROM editions WHERE "mediaId" = m.id AND family = 'audio')
               FROM media m WHERE m.id = $1"#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO playback_states ("userId", "itemId", "mediaFileId", "positionSeconds",
                                            "lastPlayedAt")
               VALUES ($1, $2, 1, 42, now() - interval '1 day')"#,
        )
        .bind(user)
        .bind(item)
        .execute(&c.st.db)
        .await
        .unwrap();
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(
            parts(&c, m).await,
            [("Orfaline/Orfaline.m4b".to_owned(), 1, 0)]
        );
        assert!(!c.dir.join("books/Orfaline/01.mp3").exists());
        assert!(!c.dir.join("books/Orfaline/02.mp3").exists());
        assert!(c.dir.join("books/Orfaline/Orfaline.m4b").exists());
        let state: (Option<i32>, Option<i32>, f64) = sqlx::query_as(
            r#"SELECT "mediaFileId", version, "positionSeconds" FROM playback_states"#,
        )
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        let m4b: i32 = sqlx::query_scalar(r#"SELECT id FROM media_files WHERE quality = 'm4b'"#)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        assert_eq!(state, (Some(m4b), Some(1), 42.0));
        let chapters =
            crate::media::books::chapters(&c.st.db, user, m, edition, Some(0), &[lib]).await;
        assert_eq!(
            chapters.unwrap().len(),
            1,
            "the removed version reads the m4b"
        );
        assert_eq!(
            crate::media::items::aliased(&c.st.db, item, 0)
                .await
                .unwrap(),
            Some(1)
        );
    }

    #[sqlx::test(migrations = false)]
    async fn the_parts_stay_while_the_replace_option_is_off(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(parts(&c, m).await.len(), 3);
        assert!(c.dir.join("books/Orfaline/01.mp3").exists());
    }

    #[sqlx::test(migrations = false)]
    async fn the_replace_option_does_nothing_without_the_merge_option(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, false, 1).await;
        replace_on(&c).await;
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(parts(&c, m).await.len(), 2);
        assert!(c.dir.join("books/Orfaline/02.mp3").exists());
    }

    #[sqlx::test(migrations = false)]
    async fn a_part_changed_during_the_merge_is_kept(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        replace_on(&c).await;
        touch(&c.dir.join("books/Orfaline/02.mp3"), b"changed bytes");
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert_eq!(parts(&c, m).await.len(), 2);
        assert!(c.dir.join("books/Orfaline/01.mp3").exists());
        assert!(c.dir.join("books/Orfaline/02.mp3").exists());
    }

    #[sqlx::test(migrations = false)]
    async fn a_part_referenced_by_another_item_is_kept(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        replace_on(&c).await;
        sqlx::query(
            r#"WITH i AS (INSERT INTO items ("mediaId", "editionId", monitored)
                          SELECT $1, id, true FROM editions WHERE "mediaId" = $1 AND family = 'audio'
                          RETURNING id)
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version)
               SELECT i.id, 1, $1, 0 FROM i"#,
        )
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
        books::merge::run(&c.st, m).await.unwrap();
        assert!(c.dir.join("books/Orfaline/01.mp3").exists());
        assert!(c.dir.join("books/Orfaline/02.mp3").exists());
        assert!(c.dir.join("books/Orfaline/Orfaline.m4b").exists());
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 3);
    }

    #[sqlx::test(migrations = false)]
    async fn a_folder_re_pointed_during_the_job_keeps_the_parts_and_registers_nothing(
        pool: PgPool,
    ) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        replace_on(&c).await;
        let moves = c.st.folder_moves.write().await;
        let (st, fake) = (c.st.clone(), &c.fake);
        let job = tokio::spawn(async move { books::merge::run(&st, m).await });
        assert!(eventually(|| !fake.seen("GET", "/v1/jobs/j1").is_empty()).await);
        let elsewhere = c.dir.join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        sqlx::query("UPDATE library_folders SET path = $1")
            .bind(elsewhere.to_string_lossy().as_ref())
            .execute(&c.st.db)
            .await
            .unwrap();
        drop(moves);
        assert!(job.await.unwrap().is_err());
        assert_eq!(parts(&c, m).await.len(), 2);
        assert!(c.dir.join("books/Orfaline/01.mp3").exists());
        assert!(c.dir.join("books/Orfaline/02.mp3").exists());
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 2);
    }

    #[sqlx::test(migrations = false)]
    async fn a_failed_unlink_leaves_an_orphan_file_not_a_cut_version(pool: PgPool) {
        use std::os::unix::fs::PermissionsExt;
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        replace_on(&c).await;
        let books = c.dir.join("books/Orfaline");
        for (from, to) in [("01.mp3", "CD1/01.mp3"), ("02.mp3", "CD2/02.mp3")] {
            fs::create_dir_all(books.join(to).parent().unwrap()).unwrap();
            fs::rename(books.join(from), books.join(to)).unwrap();
            sqlx::query(r#"UPDATE media_files SET "relativePath" = $2 WHERE "relativePath" = $1"#)
                .bind(format!("Orfaline/{from}"))
                .bind(format!("Orfaline/{to}"))
                .execute(&c.st.db)
                .await
                .unwrap();
        }
        let cd2 = books.join("CD2");
        fs::set_permissions(&cd2, fs::Permissions::from_mode(0o555)).unwrap();
        let can_write = fs::File::create(cd2.join("probe")).is_ok();
        let run = books::merge::run(&c.st, m).await;
        fs::set_permissions(&cd2, fs::Permissions::from_mode(0o755)).unwrap();
        if can_write {
            return;
        }
        run.unwrap();
        assert_eq!(
            parts(&c, m).await,
            [("Orfaline/Orfaline.m4b".to_owned(), 1, 0)]
        );
        assert!(!books.join("CD1/01.mp3").exists());
        assert!(cd2.join("02.mp3").exists(), "an orphan, not a lost file");
    }

    #[sqlx::test(migrations = false)]
    async fn a_book_played_a_minute_ago_keeps_its_parts(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        replace_on(&c).await;
        sqlx::query(
            r#"INSERT INTO playback_states ("userId", "itemId", "mediaFileId", "positionSeconds")
               SELECT (SELECT min(id) FROM users), id, 1, 42 FROM items WHERE "mediaId" = $1"#,
        )
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(parts(&c, m).await.len(), 3);
        assert!(c.dir.join("books/Orfaline/01.mp3").exists());
        assert!(c.dir.join("books/Orfaline/Orfaline.m4b").exists());
    }

    #[sqlx::test(migrations = false)]
    async fn a_replace_held_for_a_listener_is_done_on_a_later_run(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        replace_on(&c).await;
        sqlx::query(
            r#"INSERT INTO playback_states ("userId", "itemId", "mediaFileId", "positionSeconds")
               SELECT (SELECT min(id) FROM users), id, 1, 42 FROM items WHERE "mediaId" = $1"#,
        )
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(merge_state(&c, m).await.as_deref(), Some("replace"));
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(parts(&c, m).await.len(), 3, "still listened to");
        sqlx::query(r#"UPDATE playback_states SET "lastPlayedAt" = now() - interval '1 day'"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(
            parts(&c, m).await,
            [("Orfaline/Orfaline.m4b".to_owned(), 1, 0)]
        );
        assert!(!c.dir.join("books/Orfaline/01.mp3").exists());
        assert_eq!(merge_state(&c, m).await, None);
        assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), 1);
    }

    #[sqlx::test(migrations = false)]
    async fn a_held_replace_whose_m4b_changed_keeps_the_parts_and_drops_the_record(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        replace_on(&c).await;
        sqlx::query(
            r#"INSERT INTO playback_states ("userId", "itemId", "mediaFileId", "positionSeconds")
               SELECT (SELECT min(id) FROM users), id, 1, 42 FROM items WHERE "mediaId" = $1"#,
        )
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(merge_state(&c, m).await.as_deref(), Some("replace"));
        touch(&c.dir.join("books/Orfaline/Orfaline.m4b"), b"another file");
        sqlx::query(r#"UPDATE playback_states SET "lastPlayedAt" = now() - interval '1 day'"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(parts(&c, m).await.len(), 3);
        assert!(c.dir.join("books/Orfaline/01.mp3").exists());
        assert_eq!(merge_state(&c, m).await, None);
    }

    #[sqlx::test(migrations = false)]
    async fn the_m4b_joins_the_edition_of_its_parts_whatever_its_tags_say(pool: PgPool) {
        let c = merging_ctx(pool).await;
        let m = merge_setup(&c, true, 1).await;
        sqlx::query(r#"UPDATE editions SET language = NULL"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO editions ("mediaId", family, language) VALUES ($1, 'audio', 'fr')"#,
        )
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
        books::merge::run(&c.st, m).await.unwrap();
        let editions: Vec<(i32,)> = sqlx::query_as(
            r#"SELECT DISTINCT i."editionId" FROM item_parts p JOIN items i ON i.id = p."itemId"
               WHERE p."mediaId" = $1"#,
        )
        .bind(m)
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(editions.len(), 1, "parts and m4b share one edition");
    }

    #[sqlx::test(migrations = false)]
    async fn each_edition_keeps_its_own_merge_record(pool: PgPool) {
        let c = merging_ctx(pool).await;
        c.fake.script("POST", "/v1/probe", vec![ok(audio_probe())]);
        let m = book(&c, "Orfaline").await;
        sqlx::query(r#"UPDATE libraries SET "mergeM4b" = true"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        let all = [
            "Orfaline (en) - 01.mp3",
            "Orfaline (en) - 02.mp3",
            "Orfaline (fr) - 01.mp3",
            "Orfaline (fr) - 02.mp3",
        ];
        for (language, names) in [("en", &all[..2]), ("fr", &all[2..])] {
            let full: Vec<String> = names.iter().map(|r| format!("Orfaline/{r}")).collect();
            for r in &full {
                touch(&c.dir.join("books").join(r), r.as_bytes());
            }
            let p = placed(&c, &full.iter().map(String::as_str).collect::<Vec<_>>());
            books::register_language(&c.st, m, &p, Some(language))
                .await
                .unwrap();
        }
        c.fake
            .script("POST", "/v1/jobs", vec![status(400), status(400)]);
        assert!(books::merge::run(&c.st, m).await.is_err());
        assert!(books::merge::run(&c.st, m).await.is_err());
        let rows: Vec<(String,)> =
            sqlx::query_as(r#"SELECT state FROM book_merges WHERE "mediaId" = $1"#)
                .bind(m)
                .fetch_all(&c.st.db)
                .await
                .unwrap();
        assert_eq!(rows, [("failed".to_owned(),), ("failed".to_owned(),)]);
        books::merge::run(&c.st, m).await.unwrap();
        assert_eq!(c.fake.seen("POST", "/v1/jobs").len(), 2, "both are skipped");
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
                language: None,
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

    /// Copies `src` into the book `m` as a file of `language`; the errors of the ingest.
    async fn ingest_as(c: &Ctx, m: i32, src: PathBuf, language: Option<&str>) -> Vec<String> {
        let guard = c.st.ingest.media.lock(m).await;
        let req = Request {
            media_id: m,
            files: vec![File {
                path: src,
                episode_id: None,
            }],
            transfer: Method::Copy,
            fallback_quality: None,
            release_name: None,
            force: false,
            uniquify_on_collision: false,
            replace_existing: false,
            language: language.map(str::to_owned),
        };
        library::ingest(&c.st, &guard, req).await.unwrap().errors
    }

    async fn names(c: &Ctx, m: i32) -> Vec<String> {
        let mut got: Vec<String> = parts(c, m).await.into_iter().map(|p| p.0).collect();
        got.sort();
        got
    }

    #[sqlx::test(migrations = false)]
    async fn a_requested_language_is_in_the_file_name(pool: PgPool) {
        let c = ctx(pool).await;
        let m = book(&c, "Orfaline").await;
        for (dir, language) in [("a", Some("fr")), ("b", Some("en")), ("c", None)] {
            let src = c.dir.join("inbox/Orfaline").join(dir).join("x.epub");
            touch(&src, dir.as_bytes());
            assert_eq!(ingest_as(&c, m, src, language).await.len(), 0);
        }
        assert_eq!(
            names(&c, m).await,
            [
                "Orfaline/Orfaline (en).epub",
                "Orfaline/Orfaline (fr).epub",
                "Orfaline/Orfaline.epub"
            ]
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_language_token_in_the_format_keeps_two_languages_apart(pool: PgPool) {
        let c = ctx(pool).await;
        sqlx::query("INSERT INTO app_settings (key, value) VALUES ('naming_book_format', '{Title} {Language}')")
            .execute(&c.st.db)
            .await
            .unwrap();
        let m = book(&c, "Orfaline").await;
        for (dir, language) in [("a", "fr"), ("b", "en")] {
            let src = c.dir.join("inbox/Orfaline").join(dir).join("x.epub");
            touch(&src, dir.as_bytes());
            assert_eq!(ingest_as(&c, m, src, Some(language)).await.len(), 0);
        }
        assert_eq!(
            names(&c, m).await,
            ["Orfaline/Orfaline en.epub", "Orfaline/Orfaline fr.epub"]
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_language_joins_a_book_linked_under_another_name(pool: PgPool) {
        let c = ctx(pool).await;
        let m = book(&c, "Orfaline").await;
        let linked = "Orfaline/Olympe Faucheval - Orfaline.epub";
        touch(&c.dir.join("books").join(linked), b"x");
        books::register(&c.st, m, &placed(&c, &[linked]))
            .await
            .unwrap();
        let src = c.dir.join("inbox/Orfaline/x.epub");
        touch(&src, b"fr");
        assert_eq!(ingest_as(&c, m, src, Some("fr")).await.len(), 0);
        books::relay(&c.st, m).await.unwrap();
        assert_eq!(
            names(&c, m).await,
            [
                "Orfaline/Olympe Faucheval - Orfaline.epub",
                "Orfaline/Orfaline (fr).epub"
            ]
        );
    }

    #[sqlx::test(migrations = false)]
    async fn one_tagged_part_keeps_an_audiobook_in_one_edition(pool: PgPool) {
        let c = ctx(pool).await;
        let tagged = audio_probe();
        let mut untagged = audio_probe();
        untagged["info"]["tags"]["language"] = Value::Null;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![ok(untagged.clone()), ok(tagged), ok(untagged)],
        );
        let m = book(&c, "Orfaline").await;
        let all = [
            "Orfaline - 01.mp3",
            "Orfaline - 02.mp3",
            "Orfaline - 03.mp3",
        ];
        for r in all {
            touch(&c.dir.join("books/Orfaline").join(r), r.as_bytes());
        }
        let both: Vec<String> = all.iter().map(|r| format!("Orfaline/{r}")).collect();
        let files = placed(&c, &both.iter().map(String::as_str).collect::<Vec<_>>());
        books::register(&c.st, m, &files).await.unwrap();
        let got: Vec<(i32, i32)> = sqlx::query_as(
            r#"SELECT i."editionId", p.version FROM items i JOIN item_parts p ON p."itemId" = i.id
               WHERE i."mediaId" = $1"#,
        )
        .bind(m)
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(got.len(), 3);
        assert!(got.iter().all(|g| *g == got[0]), "{got:?}");
    }

    #[sqlx::test(migrations = false)]
    async fn untagged_files_of_two_languages_land_in_two_editions(pool: PgPool) {
        let c = ctx(pool).await;
        let m = book(&c, "Orfaline").await;
        let all = ["Orfaline (fr).epub", "Orfaline (de).epub"];
        for r in all {
            touch(&c.dir.join("books/Orfaline").join(r), r.as_bytes());
        }
        let both: Vec<String> = all.iter().map(|r| format!("Orfaline/{r}")).collect();
        let files = placed(&c, &both.iter().map(String::as_str).collect::<Vec<_>>());
        books::register(&c.st, m, &files).await.unwrap();
        let got: Vec<(Option<String>, String)> = sqlx::query_as(
            r#"SELECT e.language, f."relativePath" FROM editions e
               JOIN items i ON i."editionId" = e.id JOIN item_parts p ON p."itemId" = i.id
               JOIN media_files f ON f.id = p."mediaFileId" WHERE e."mediaId" = $1 ORDER BY f."relativePath""#,
        )
        .bind(m)
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(got.len(), 2);
        assert_ne!(got[0].0, got[1].0, "{got:?}");
    }

    #[sqlx::test(migrations = false)]
    async fn the_orphan_scan_names_a_series_after_its_show_not_its_first_episode(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("tv");
        let l = library(&c, "T", &lib, r#"["series", "movie"]"#).await;
        let season = lib.join("Placeholder Show/Season 1");
        touch(&season.join("Placeholder.Show.S01E01.Pilot.mkv"), b"x");
        touch(&season.join("Placeholder.Show.S01E01.Pilot.nfo"), b"<episodedetails><title>Pilot</title><uniqueid type='tmdb'>9</uniqueid></episodedetails>");
        touch(&lib.join("Root Film (2001).mkv"), b"x");
        touch(
            &lib.join("movie.nfo"),
            b"<movie><title>Stray</title></movie>",
        );
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
        let show = groups.iter().find(|g| g["mediaType"] == "series").unwrap();
        assert_eq!(
            (&show["guessTitle"], &show["fileIds"]),
            (&json!("Placeholder Show"), &json!([]))
        );
        let film = groups.iter().find(|g| g["mediaType"] == "movie").unwrap();
        assert_eq!(
            (&film["guessTitle"], &film["guessYear"]),
            (&json!("Root Film"), &json!(2001))
        );
        touch(
            &lib.join("Placeholder Show/tvshow.nfo"),
            b"<tvshow><title>Show NFO</title><uniqueid type='tmdb'>4242</uniqueid></tvshow>",
        );
        let (_, b) = call(
            &c,
            "POST",
            &format!("/api/imports/library/{l}/orphans/scan"),
            &c.admin,
            json!({}),
        )
        .await;
        let show = b["groups"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["mediaType"] == "series")
            .unwrap()
            .clone();
        assert_eq!(show["guessTitle"], "Show NFO");
        assert_eq!(
            show["fileIds"],
            json!([{"provider": "tmdb", "externalId": "4242"}])
        );
    }

    #[sqlx::test(migrations = false)]
    async fn the_orphan_scan_ignores_the_library_path_when_it_looks_for_specials(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("Special Forces (2011)/films");
        let l = library(&c, "M", &lib, r#"["movie"]"#).await;
        touch(&lib.join("Plain Film (2001)/Plain Film (2001).mkv"), b"x");
        let (s, b) = call(
            &c,
            "POST",
            &format!("/api/imports/library/{l}/orphans/scan"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 201);
        assert_eq!(b["groups"][0]["mediaType"], "movie");
    }

    #[sqlx::test(migrations = false)]
    async fn an_orphan_of_a_second_library_folder_imports_as_unmatched(pool: PgPool) {
        let c = ctx(pool).await;
        let (first, second) = (c.dir.join("films"), c.dir.join("films-b"));
        let l = library(&c, "F", &first, r#"["movie"]"#).await;
        let folder = second_folder(&c, l, &second).await;
        let file = second.join("Placeholder Film (2001)/Placeholder Film (2001).mkv");
        touch(&file, b"x");
        let (s, b) = call(
            &c,
            "POST",
            "/api/imports/library/orphans/relink",
            &c.admin,
            json!({"libraryId": l, "folderId": folder, "type": "movie",
                   "folderName": "Placeholder Film (2001)", "files": [{"filePath": file}]}),
        )
        .await;
        assert_eq!(s, 201, "{b}");
    }

    #[sqlx::test(migrations = false)]
    async fn an_unmatched_video_shows_its_nfo_and_a_refresh_without_id_merges_it_again(
        pool: PgPool,
    ) {
        let c = ctx(pool).await;
        let lib = c.dir.join("films");
        let l = library(&c, "F", &lib, r#"["movie"]"#).await;
        let file = lib.join("Placeholder Film (2001)/Placeholder Film (2001).mkv");
        touch(&file, b"x");
        let nfo = lib.join("Placeholder Film (2001)/movie.nfo");
        touch(
            &nfo,
            b"<movie><title>Placeholder Film</title><plot>A plot.</plot><genre>Drama</genre>\
              <runtime>93</runtime><premiered>2001-05-04</premiered></movie>",
        );
        let (s, b) = call(
            &c,
            "POST",
            "/api/imports/library/orphans/relink",
            &c.admin,
            json!({"libraryId": l, "type": "movie", "folderName": "Placeholder Film (2001)",
                   "files": [{"filePath": file}]}),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        let id = b["mediaId"].as_i64().unwrap();
        let (overview, runtime, genres): (Option<String>, Option<i32>, Value) =
            sqlx::query_as("SELECT overview, runtime, genres FROM media WHERE id = $1")
                .bind(id as i32)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!(
            (overview.as_deref(), runtime, genres),
            (Some("A plot."), Some(93), json!(["Drama"]))
        );
        let sources = "SELECT count(*) FROM media_field_sources WHERE provider = 'file'";
        assert!(count(&c, sources).await > 0);
        touch(
            &nfo,
            b"<movie><title>Placeholder Film</title><plot>Another plot.</plot></movie>",
        );
        let (s, b) = call(
            &c,
            "POST",
            &format!("/api/media/{id}/refresh"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        let q =
            format!("SELECT count(*) FROM media WHERE id = {id} AND overview = 'Another plot.'");
        let mut merged = false;
        for _ in 0..50 {
            merged = count(&c, &q).await == 1;
            if merged {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(merged);
    }

    #[sqlx::test(migrations = false)]
    async fn a_file_merge_keeps_what_was_set_by_hand_and_a_typed_year(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("films");
        let l = library(&c, "F", &lib, r#"["movie"]"#).await;
        let file = lib.join("Placeholder Film (2001)/Placeholder Film (2001).mkv");
        touch(&file, b"x");
        let nfo = lib.join("Placeholder Film (2001)/movie.nfo");
        touch(
            &nfo,
            b"<movie><title>Placeholder Film</title><year>2001</year><plot>A plot.</plot></movie>",
        );
        let (s, b) = call(
            &c,
            "POST",
            "/api/imports/library/orphans/relink",
            &c.admin,
            json!({"libraryId": l, "type": "movie", "folderName": "Placeholder Film (2001)",
                   "year": 1999, "files": [{"filePath": file}]}),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        let id = b["mediaId"].as_i64().unwrap() as i32;
        let (s, b) = call(
            &c,
            "PUT",
            &format!("/api/media/{id}"),
            &c.admin,
            json!({"title": "Hand Title"}),
        )
        .await;
        assert_eq!(s, 200, "{b}");
        touch(
            &nfo,
            b"<movie><title>Other Title</title><year>2005</year><plot>Plot two.</plot></movie>",
        );
        assert!(
            crate::media::write::fields::merge_unmatched(&c.st, id)
                .await
                .unwrap()
        );
        let (title, year, overview): (String, Option<i32>, Option<String>) =
            sqlx::query_as("SELECT title, year, overview FROM media WHERE id = $1")
                .bind(id)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!(
            (title.as_str(), year, overview.as_deref()),
            ("Hand Title", Some(1999), Some("Plot two."))
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_file_merge_reads_nothing_of_an_offline_file(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("films");
        let l = library(&c, "F", &lib, r#"["movie"]"#).await;
        let m = media(&c, l, "Offline Film", "movie").await;
        file_row(&c, m, "Offline Film.mkv").await;
        assert!(
            !crate::media::write::fields::merge_unmatched(&c.st, m)
                .await
                .unwrap()
        );
        let stamped: Option<chrono::DateTime<chrono::Utc>> =
            sqlx::query_scalar(r#"SELECT "metadataRefreshedAt" FROM media WHERE id = $1"#)
                .bind(m)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert!(stamped.is_none());
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
        assert_eq!(text["guessAuthors"], json!(["Aldric Vexmoor"]));
        assert_eq!(b["orphanCount"], 3);
    }

    #[sqlx::test(migrations = false)]
    async fn the_orphan_scan_suggests_a_book_provider_for_a_book_group(pool: PgPool) {
        let p = std::sync::Arc::new(crate::metadata::books::tests::anchor());
        let c = ctx_with(pool, Some(p)).await;
        let lib = c.dir.join("mixed");
        let l = library(&c, "X", &lib, r#"["movie", "book"]"#).await;
        sqlx::query(r#"UPDATE libraries SET "preferredProvider" = 'tmdb' WHERE id = $1"#)
            .bind(l)
            .execute(&c.st.db)
            .await
            .unwrap();
        touch(&lib.join("Placeholder Film (2001).mkv"), b"x");
        touch(
            &lib.join("Placeholder Author - Placeholder Book.epub"),
            b"x",
        );
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
        let book = groups.iter().find(|g| g["mediaType"] == "book").unwrap();
        assert_eq!(book["suggestedProvider"], "openlibrary");
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
    async fn an_unmatched_book_takes_no_profile_of_another_family(pool: PgPool) {
        let c = ctx(pool).await;
        let l = shelf(&c).await;
        sqlx::query(r#"INSERT INTO quality_profiles (name, cutoff, items) VALUES ('P', 18, '[]')"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        let file = c.dir.join("books/Mirelune.epub");
        epub(&file);
        let body = json!({"libraryId": l, "type": "book", "folderName": "", "title": "Mirelune",
            "files": [{"filePath": file}]});
        let (s, b) = call(
            &c,
            "POST",
            "/api/imports/library/orphans/relink",
            &c.admin,
            body,
        )
        .await;
        assert_eq!((s, &b["linked"]), (201, &json!(1)), "{b}");
        assert_eq!(count(&c, "SELECT count(*) FROM wants").await, 1);
        assert_eq!(
            count(
                &c,
                r#"SELECT count(*) FROM wants WHERE "qualityProfileId" IS NOT NULL"#
            )
            .await,
            0
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_title_typed_in_the_panel_is_locked_and_a_guessed_one_is_not(pool: PgPool) {
        let c = ctx(pool).await;
        let l = shelf(&c).await;
        let file = c.dir.join("books/Mirelune.epub");
        epub(&file);
        let body = json!({"libraryId": l, "type": "book", "folderName": "", "title": "Typed Name",
            "files": [{"filePath": file}]});
        let (s, _) = call(
            &c,
            "POST",
            "/api/imports/library/orphans/relink",
            &c.admin,
            body,
        )
        .await;
        assert_eq!(s, 201);
        assert_eq!(
            count(
                &c,
                r#"SELECT count(*) FROM media_field_sources WHERE field = 'title' AND locked AND provider IS NULL"#
            )
            .await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn refreshing_an_unmatched_book_merges_its_file_record(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let m = media(&c, l, "Solo", "book").await;
        sqlx::query(r#"INSERT INTO media_field_sources ("mediaId", field, provider) VALUES ($1, 'title', 'file')"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
        epub(&lib.join("Solo/Mirelune.epub"));
        books::register(&c.st, m, &placed(&c, &["Solo/Mirelune.epub"]))
            .await
            .unwrap();
        let r = books::refresh_media(
            &c.st,
            m,
            fliks_domain::metadata::limiter::Priority::Interactive,
        )
        .await;
        assert!(
            r.is_err_and(|e| e.retry),
            "the outage is reported for a retry"
        );
        assert_eq!(
            count(
                &c,
                r#"SELECT count(*) FROM media WHERE title = 'Mirelune' AND "metadataRefreshedAt" IS NOT NULL"#
            )
            .await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_book_refresh_during_a_provider_outage_is_a_503(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let m = media(&c, l, "Solo", "book").await;
        epub(&lib.join("Solo/Mirelune.epub"));
        books::register(&c.st, m, &placed(&c, &["Solo/Mirelune.epub"]))
            .await
            .unwrap();
        let row = crate::ingest::load_media(&c.st.db, m)
            .await
            .unwrap()
            .unwrap();
        let e = crate::media::write::refresh_any(
            &c.st,
            &row,
            false,
            fliks_domain::metadata::limiter::Priority::Interactive,
        )
        .await
        .unwrap_err();
        assert_eq!(e.status(), axum::http::StatusCode::SERVICE_UNAVAILABLE);
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
                language: None,
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
    async fn an_unreadable_file_leaves_the_rest_of_the_batch_registered(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("books");
        let l = shelf(&c).await;
        let m = media(&c, l, "Mirelune", "book").await;
        epub(&lib.join("Mirelune/Mirelune.epub"));
        let reg = books::register_language(
            &c.st,
            m,
            &placed(&c, &["Mirelune/Gone.epub", "Mirelune/Mirelune.epub"]),
            Some("en"),
        )
        .await
        .unwrap();
        assert_eq!((reg.files.len(), reg.conflicts.len()), (1, 1));
        assert_eq!(parts(&c, m).await.len(), 1);
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

mod relink_identified {
    use super::*;
    use crate::{
        ingest::books,
        metadata::books::tests::{Fake as Books, ISBN, anchor},
    };
    use fliks_domain::external_id::Namespace;
    use std::sync::Arc;

    const URL: &str = "/api/imports/library/orphans/relink";
    const ASIN: &str = "B000000001";

    fn pick(l: i32, folder: &str, file: &Path, provider: &str, id: &str) -> Value {
        json!({"libraryId": l, "type": "book", "folderName": folder, "provider": provider,
            "externalId": id, "files": [{"filePath": file}]})
    }

    fn google(isbn: &str) -> Books {
        Books::new(Namespace::GOOGLEBOOKS).edition(
            Namespace::GOOGLEBOOKS,
            "gb1",
            json!({"externalId": "gb1", "title": "Alpha", "year": 1999, "isbn13": [isbn],
                   "authors": [{"name": "Una Roe"}]}),
        )
    }

    async fn shelf(c: &Ctx) -> i32 {
        library(c, "B", &c.dir.join("books"), r#"["book"]"#).await
    }

    async fn work_of(c: &Ctx, media: i32) -> Option<String> {
        sqlx::query_scalar(
            r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = 'openlibrary'"#,
        )
        .bind(media)
        .fetch_optional(&c.st.db)
        .await
        .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn a_book_is_relinked_by_its_work_and_found_again(pool: PgPool) {
        let c = ctx_with(pool, Some(Arc::new(anchor()))).await;
        let l = shelf(&c).await;
        let file = c.dir.join("books/Alpha/Alpha.epub");
        touch(&file, b"a");
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(l, "Alpha", &file, "openlibrary", "OL1W"),
        )
        .await;
        assert_eq!((s, b["linked"].clone()), (201, json!(1)), "{b}");
        let m: i32 = sqlx::query_scalar("SELECT id FROM media WHERE type = 'book'")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        assert_eq!(work_of(&c, m).await.as_deref(), Some("OL1W"));
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 1);
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(l, "Alpha", &file, "openlibrary", "OL1W"),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        assert_eq!(
            count(&c, "SELECT count(*) FROM media WHERE type = 'book'").await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_edition_pick_is_imported_under_the_work_its_isbn_names(pool: PgPool) {
        let ol = anchor().find(Namespace::ISBN, ISBN, "OL1W");
        let c = ctx_with(pool, Some(Arc::new(ol))).await;
        c.st.metadata.add_plugin(Arc::new(google(ISBN)));
        let l = shelf(&c).await;
        let file = c.dir.join("books/Alpha/Alpha.epub");
        touch(&file, b"a");
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(l, "Alpha", &file, "googlebooks", "gb1"),
        )
        .await;
        assert_eq!((s, b["linked"].clone()), (201, json!(1)), "{b}");
        let m: i32 = sqlx::query_scalar("SELECT id FROM media WHERE type = 'book'")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        assert_eq!(work_of(&c, m).await.as_deref(), Some("OL1W"));
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT provider || ':' || value FROM edition_external_ids ORDER BY 1",
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(ids, ["googlebooks:gb1".to_owned(), format!("isbn:{ISBN}")]);
        assert_eq!(count(&c, "SELECT count(*) FROM editions").await, 1);
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(l, "Alpha", &file, "googlebooks", "gb1"),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        assert_eq!(
            count(&c, "SELECT count(*) FROM media WHERE type = 'book'").await,
            1
        );
    }

    const OTHER_LIBRARY: &str = "Media already belongs to another library";
    const TAKEN: &str = "This title is already in the library";

    /// The editor reads only the library `other`; `held` is the library holding the title.
    async fn held_elsewhere_ctx(
        pool: PgPool,
        provider: Arc<dyn crate::metadata::MetadataProvider>,
    ) -> (Ctx, i32, i32) {
        let c = ctx_with(pool, Some(provider)).await;
        c.st.metadata.add_plugin(Arc::new(google(ISBN)));
        let held = shelf(&c).await;
        let other = library(&c, "C", &c.dir.join("more"), r#"["book"]"#).await;
        sqlx::query(
            r#"INSERT INTO library_user_access ("userId", "libraryId")
               SELECT id, $1 FROM users WHERE username = 'editor'"#,
        )
        .bind(other)
        .execute(&c.st.db)
        .await
        .unwrap();
        (c, held, other)
    }

    #[sqlx::test(migrations = false)]
    async fn an_edition_of_a_book_held_in_another_library_answers_by_readability(pool: PgPool) {
        let ol = anchor().find(Namespace::ISBN, ISBN, "OL1W");
        let (c, held, other) = held_elsewhere_ctx(pool, Arc::new(ol)).await;
        let file = c.dir.join("books/Alpha/Alpha.epub");
        touch(&file, b"a");
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(held, "Alpha", &file, "googlebooks", "gb1"),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        let editor_pick = pick(other, "Alpha", &file, "googlebooks", "gb1");
        let (s, b) = call(&c, "POST", URL, &c.editor, editor_pick).await;
        assert_eq!((s, b["message"].clone()), (409, json!(TAKEN)));
        for provider in ["googlebooks", "openlibrary"] {
            let id = if provider == "openlibrary" {
                "OL1W"
            } else {
                "gb1"
            };
            let (s, b) = call(
                &c,
                "POST",
                URL,
                &c.admin,
                pick(other, "Alpha", &file, provider, id),
            )
            .await;
            assert_eq!(
                (s, b["message"].clone()),
                (400, json!(OTHER_LIBRARY)),
                "{provider}"
            );
        }
    }

    #[sqlx::test(migrations = false)]
    async fn a_video_held_in_another_library_answers_by_readability(pool: PgPool) {
        let mut tmdb = crate::metadata::books::tests::Fake::new(Namespace::TMDB)
            .serving(&[fliks_domain::media::kind::MediaKind::Movie]);
        tmdb.works.insert(
            "77".into(),
            json!({"title": "Film", "year": 2001, "tmdbId": 77}),
        );
        let (c, held, other) = held_elsewhere_ctx(pool, Arc::new(tmdb)).await;
        sqlx::query(r#"UPDATE libraries SET "mediaTypes" = '["book","movie"]' WHERE true"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        let m = media(&c, held, "Film (2001)", "movie").await;
        sqlx::query(
            r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value)
               VALUES ($1, 'movie', 'tmdb', '77')"#,
        )
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
        let file = c.dir.join("more/Film (2001)/Film (2001).mkv");
        touch(&file, b"f");
        let body = json!({"libraryId": other, "type": "movie", "folderName": "Film (2001)",
            "provider": "tmdb", "externalId": "77", "files": [{"filePath": file}]});
        let (s, b) = call(&c, "POST", URL, &c.admin, body.clone()).await;
        assert_eq!((s, b["message"].clone()), (400, json!(OTHER_LIBRARY)));
        let (s, b) = call(&c, "POST", URL, &c.editor, body).await;
        assert_eq!((s, b["message"].clone()), (409, json!(TAKEN)));
    }

    #[sqlx::test(migrations = false)]
    async fn an_edition_the_anchor_does_not_know_makes_an_unmatched_book(pool: PgPool) {
        let c = ctx_with(pool, Some(Arc::new(anchor()))).await;
        c.st.metadata.add_plugin(Arc::new(google(ISBN)));
        let l = shelf(&c).await;
        let file = c.dir.join("books/Alpha/Alpha.epub");
        touch(&file, b"a");
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(l, "Alpha", &file, "googlebooks", "gb1"),
        )
        .await;
        assert_eq!((s, b["linked"].clone()), (201, json!(1)), "{b}");
        assert_eq!(
            count(
                &c,
                "SELECT count(*) FROM media_external_ids WHERE provider = 'openlibrary'"
            )
            .await,
            0
        );
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT provider || ':' || value FROM edition_external_ids ORDER BY 1",
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(ids, ["googlebooks:gb1".to_owned(), format!("isbn:{ISBN}")]);
        assert_eq!(count(&c, "SELECT count(*) FROM editions").await, 1);
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 1);
    }

    #[sqlx::test(migrations = false)]
    async fn an_explicit_work_survives_the_settle(pool: PgPool) {
        let mut ol = anchor();
        ol.works.insert("OL9W".into(), json!({"title": "Other"}));
        ol.found =
            vec![json!({"externalId": "OL1W", "title": "Alpha", "authors": [{"name": "Una Roe"}]})];
        let c = ctx_with(pool, Some(Arc::new(ol))).await;
        let l = shelf(&c).await;
        let file = c.dir.join("books/Una Roe/Alpha/Alpha.epub");
        touch(&file, b"a");
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(l, "Una Roe/Alpha", &file, "openlibrary", "OL9W"),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        let m: i32 = sqlx::query_scalar("SELECT id FROM media WHERE type = 'book'")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        assert_eq!(books::identify_media(&c.st, m).await.ok(), Some(m));
        assert_eq!(work_of(&c, m).await.as_deref(), Some("OL9W"));
        assert_eq!(
            count(&c, "SELECT count(*) FROM media WHERE type = 'book'").await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_comic_is_relinked_by_its_plugin_id(pool: PgPool) {
        use crate::metadata::comics::tests::{NS, fake};
        let c = ctx_with(pool, None).await;
        c.st.metadata.add_plugin(Arc::new(fake()));
        sqlx::raw_sql(
            r#"INSERT INTO provider_namespaces (name, "pluginId", "idPattern", "case", label)
                 VALUES ('org.test.comic:vol', 'org.test.comic', '^[0-9]+$', 'preserve', 'Test Comics');
               INSERT INTO plugin_packages ("pluginId", version, archive, origin, signature, manifest)
                 VALUES ('org.test.comic', '1.0.0', '\x00', 'manual', 'sig',
                         '{"id": "org.test.comic", "homepage": "https://cv.test"}');"#,
        )
        .execute(&c.st.db)
        .await
        .unwrap();
        crate::plugins::namespaces::load(&c.st.db, &c.st.plugins.namespaces)
            .await
            .unwrap();
        let l = library(&c, "C", &c.dir.join("comics"), r#"["comic"]"#).await;
        let file = c.dir.join("comics/Alpha Run/Alpha Run 001.cbz");
        touch(&file, b"a");
        let mut body = pick(l, "Alpha Run", &file, NS, "42");
        body["type"] = json!("comic");
        let (s, b) = call(&c, "POST", URL, &c.admin, body).await;
        assert_eq!(s, 201, "{b}");
        assert_eq!(
            count(&c, "SELECT count(*) FROM media_external_ids WHERE provider = 'org.test.comic:vol' AND value = '42'").await,
            1
        );
        assert_eq!(
            count(&c, "SELECT count(*) FROM media WHERE type = 'comic'").await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_provider_serving_nothing_is_refused_before_the_lookup(pool: PgPool) {
        let c = ctx(pool).await;
        let lib = c.dir.join("movies");
        let l = library(&c, "M", &lib, r#"["movie"]"#).await;
        let m = media(&c, l, "Film (2001)", "movie").await;
        sqlx::query(
            r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value)
               VALUES ($1, 'movie', 'tmdb', '77')"#,
        )
        .bind(m)
        .execute(&c.st.db)
        .await
        .unwrap();
        touch(&lib.join("Film (2001)/Film (2001).mkv"), b"f");
        let body = json!({"libraryId": l, "type": "movie", "folderName": "Film (2001)",
            "provider": "tmdb", "externalId": "77",
            "files": [{"filePath": lib.join("Film (2001)/Film (2001).mkv")}]});
        let (s, b) = call(&c, "POST", URL, &c.admin, body).await;
        assert_eq!(s, 400, "{b}");
        assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 0);
    }

    #[sqlx::test(migrations = false)]
    async fn an_edition_pick_of_a_held_work_joins_that_book(pool: PgPool) {
        let ol = anchor().find(Namespace::ISBN, ISBN, "OL1W");
        let c = ctx_with(pool, Some(Arc::new(ol))).await;
        c.st.metadata.add_plugin(Arc::new(google(ISBN)));
        let l = shelf(&c).await;
        let first = c.dir.join("books/Alpha/Alpha.epub");
        touch(&first, b"a");
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(l, "Alpha", &first, "openlibrary", "OL1W"),
        )
        .await;
        assert_eq!((s, b["created"].clone()), (201, json!(true)), "{b}");
        let second = c.dir.join("books/Alpha/Alpha 2.epub");
        touch(&second, b"b");
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(l, "Alpha", &second, "googlebooks", "gb1"),
        )
        .await;
        assert_eq!((s, b["created"].clone()), (201, json!(false)), "{b}");
        let m: i32 = sqlx::query_scalar("SELECT id FROM media WHERE type = 'book'")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        assert_eq!(b["mediaId"], json!(m));
        assert_eq!(
            count(
                &c,
                "SELECT count(*) FROM edition_external_ids WHERE provider = 'googlebooks' AND value = 'gb1'"
            )
            .await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_audible_asin_is_a_pickable_edition_id(pool: PgPool) {
        let ol = anchor().find(Namespace::ASIN, ASIN, "OL1W");
        let c = ctx_with(pool, Some(Arc::new(ol))).await;
        c.st.metadata
            .add_plugin(Arc::new(Books::new(Namespace::AUDIBLE).edition(
            Namespace::ASIN,
            ASIN,
            json!({"externalId": ASIN, "title": "Alpha", "asin": ASIN, "durationSeconds": 3600}),
        )));
        let l = shelf(&c).await;
        let file = c.dir.join("books/Alpha/Alpha.m4b");
        touch(&file, b"a");
        let (s, b) = call(
            &c,
            "POST",
            URL,
            &c.admin,
            pick(l, "Alpha", &file, "asin", ASIN),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        let m: i32 = sqlx::query_scalar("SELECT id FROM media WHERE type = 'book'")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        assert_eq!(work_of(&c, m).await.as_deref(), Some("OL1W"));
        assert_eq!(
            count(
                &c,
                &format!("SELECT count(*) FROM edition_external_ids WHERE provider = 'asin' AND value = '{ASIN}'")
            )
            .await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_non_canonical_id_is_refused(pool: PgPool) {
        let c = ctx_with(pool, super::video_provider(Namespace::TMDB)).await;
        let lib = c.dir.join("movies");
        let l = library(&c, "M", &lib, r#"["movie"]"#).await;
        touch(&lib.join("Film (2001)/Film (2001).mkv"), b"f");
        let body = json!({"libraryId": l, "type": "movie", "folderName": "Film (2001)",
            "provider": "tmdb", "externalId": "007",
            "files": [{"filePath": lib.join("Film (2001)/Film (2001).mkv")}]});
        let (s, b) = call(&c, "POST", URL, &c.admin, body).await;
        assert_eq!(s, 400, "{b}");
        assert_eq!(count(&c, "SELECT count(*) FROM media").await, 0);
    }
}

mod comic_ingest {
    use super::*;
    use crate::ingest::{books::Placed, comics};
    use std::io::Write;
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut out = vec![];
        image::RgbImage::new(w, h)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn cbz(path: &Path, pages: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut w = ZipWriter::new(fs::File::create(path).unwrap());
        let o = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for i in 0..pages {
            w.start_file(format!("p{:02}.png", i + 1), o).unwrap();
            w.write_all(&png(8, 12)).unwrap();
        }
        w.finish().unwrap();
    }

    async fn comic(c: &Ctx, folder: &str) -> i32 {
        let l = library(c, "C", &c.dir.join("comics"), r#"["comic"]"#).await;
        media(c, l, folder, "comic").await
    }

    fn placed(c: &Ctx, rels: &[&str]) -> Vec<Placed> {
        rels.iter()
            .map(|r| Placed {
                folder_id: 1,
                rel: (*r).to_owned(),
                abs: c.dir.join("comics").join(r),
            })
            .collect()
    }

    /// `(label, kind, pageCount, files)` of every issue, by sort key.
    async fn issues(c: &Ctx, m: i32) -> Vec<(String, String, Option<i32>, i64)> {
        sqlx::query_as(
            r#"SELECT ci.label, ci.kind, ci."pageCount",
                      (SELECT count(*) FROM item_parts p WHERE p."itemId" = ci."itemId")
               FROM comic_issues ci WHERE ci."mediaId" = $1 ORDER BY ci.kind, ci."sortNumber""#,
        )
        .bind(m)
        .fetch_all(&c.st.db)
        .await
        .unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn deleting_a_comic_keeps_the_files_it_does_not_own(pool: PgPool) {
        let c = ctx(pool).await;
        let m = comic(&c, "Shared").await;
        let d = c.dir.join("comics/Shared");
        cbz(&d.join("One.cbz"), 2);
        cbz(&d.join("Sub/Other 001.cbz"), 2);
        comics::register(&c.st, m, &placed(&c, &["Shared/One.cbz"]))
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
        assert!(eventually(|| !d.join("One.cbz").exists()).await);
        assert!(d.join("Sub/Other 001.cbz").exists());
    }

    #[sqlx::test(migrations = false)]
    async fn archives_become_issues_of_one_image_edition_with_a_cover(pool: PgPool) {
        let c = ctx(pool).await;
        let m = comic(&c, "Star Gardens").await;
        let d = c.dir.join("comics/Star Gardens");
        for (n, pages) in [
            ("Star Gardens 002.cbz", 3),
            ("Star Gardens 001.cbz", 2),
            ("Star Gardens 001 (Variant).cbz", 2),
            ("Star Gardens Annual 01.cbz", 5),
        ] {
            cbz(&d.join(n), pages);
        }
        fs::write(d.join("Star Gardens 003.pdf"), b"%PDF-1.4").unwrap();
        let rels: Vec<String> = fs::read_dir(&d)
            .unwrap()
            .map(|e| format!("Star Gardens/{}", e.unwrap().file_name().to_string_lossy()))
            .collect();
        let refs: Vec<&str> = rels.iter().map(String::as_str).collect();
        let done = comics::register(&c.st, m, &placed(&c, &refs))
            .await
            .unwrap();
        assert_eq!(done.files.len(), 5);
        assert_eq!(
            issues(&c, m).await,
            [
                ("1".to_owned(), "annual".to_owned(), Some(5), 1),
                ("1".to_owned(), "issue".to_owned(), Some(2), 2),
                ("2".to_owned(), "issue".to_owned(), Some(3), 1),
                ("3".to_owned(), "issue".to_owned(), None, 1),
            ]
        );
        assert_eq!(
            count(&c, "SELECT count(*) FROM editions WHERE family = 'image'").await,
            1
        );
        assert_eq!(count(&c, "SELECT count(*) FROM items").await, 4);
        let poster: Option<String> =
            sqlx::query_scalar(r#"SELECT "posterUrl" FROM media WHERE id = $1"#)
                .bind(m)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert!(poster.is_some());
        // a cbz and a pdf in one volume: the edition has no single format
        let format: Option<String> =
            sqlx::query_scalar(r#"SELECT format FROM editions WHERE "mediaId" = $1"#)
                .bind(m)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!(format, None);
        // a second run neither duplicates an issue nor a part
        comics::register(&c.st, m, &placed(&c, &refs))
            .await
            .unwrap();
        assert_eq!(count(&c, "SELECT count(*) FROM items").await, 4);
        assert_eq!(count(&c, "SELECT count(*) FROM item_parts").await, 5);
    }

    #[sqlx::test(migrations = false)]
    async fn a_rescan_registers_new_files_and_queues_no_media_job(pool: PgPool) {
        let c = ctx(pool).await;
        let m = comic(&c, "Moon Tales").await;
        cbz(&c.dir.join("comics/Moon Tales/Moon Tales 01.cbz"), 2);
        assert_eq!(rescan(&c, m).await.unwrap().added, 1);
        cbz(&c.dir.join("comics/Moon Tales/Moon Tales 02.cbz"), 2);
        assert_eq!(rescan(&c, m).await.unwrap().added, 1);
        assert_eq!(issues(&c, m).await.len(), 2);
        assert!(c.st.ingest.queue.is_idle());
    }

    #[sqlx::test(migrations = false)]
    async fn unnumbered_files_are_issues_of_their_own_apart_from_issue_zero(pool: PgPool) {
        let c = ctx(pool).await;
        let m = comic(&c, "Moon Tales").await;
        let d = c.dir.join("comics/Moon Tales");
        for n in [
            "Prologue.cbz",
            "Epilogue.cbz",
            "Moon Tales 000.cbz",
            "Moon Tales 01.cbz",
        ] {
            cbz(&d.join(n), 2);
        }
        let rels: Vec<String> = [
            "Prologue.cbz",
            "Epilogue.cbz",
            "Moon Tales 000.cbz",
            "Moon Tales 01.cbz",
        ]
        .iter()
        .map(|n| format!("Moon Tales/{n}"))
        .collect();
        let refs: Vec<&str> = rels.iter().map(String::as_str).collect();
        comics::register(&c.st, m, &placed(&c, &refs))
            .await
            .unwrap();
        comics::register(&c.st, m, &placed(&c, &refs))
            .await
            .unwrap();
        let labels = issues(&c, m).await;
        assert_eq!(labels.len(), 4, "{labels:?}");
        assert_eq!(labels.iter().filter(|i| i.0 == "0").count(), 1);
        assert_eq!(count(&c, "SELECT count(*) FROM item_parts").await, 4);
    }

    fn cbz_with_info(path: &Path, xml: &str) {
        cbz(path, 1);
        let mut z = zip::ZipWriter::new_append(
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .unwrap(),
        )
        .unwrap();
        z.start_file("ComicInfo.xml", SimpleFileOptions::default())
            .unwrap();
        z.write_all(xml.as_bytes()).unwrap();
        z.finish().unwrap();
    }

    #[sqlx::test(migrations = false)]
    async fn comic_info_fills_the_issue_and_the_volume_before_the_file_name(pool: PgPool) {
        let c = ctx(pool).await;
        let m = comic(&c, "Moon Tales").await;
        let d = c.dir.join("comics/Moon Tales");
        cbz_with_info(
            &d.join("Moon Tales 05.cbz"),
            "<ComicInfo><Number>7</Number><Title>Seven</Title><Summary>Sum</Summary><Publisher>Pub</Publisher>\
             <Volume>2016</Volume><Year>2017</Year><Month>3</Month><Day>9</Day></ComicInfo>",
        );
        cbz_with_info(&d.join("Moon Tales 09.cbz"), "<ComicInfo><Number>");
        cbz_with_info(
            &d.join("Moon Tales 08.cbz"),
            "<!DOCTYPE x [<!ENTITY y \"z\">]><ComicInfo><Title>&y;</Title></ComicInfo>",
        );
        let refs = [
            "Moon Tales/Moon Tales 05.cbz",
            "Moon Tales/Moon Tales 09.cbz",
            "Moon Tales/Moon Tales 08.cbz",
        ];
        comics::register(&c.st, m, &placed(&c, &refs))
            .await
            .unwrap();
        type Got = (String, Option<String>, Option<String>, Option<String>);
        let got: Vec<Got> = sqlx::query_as(
            r#"SELECT ci.label, i.title, i.overview, i."airDate"::text FROM comic_issues ci
               JOIN items i ON i.id = ci."itemId" WHERE ci."mediaId" = $1 ORDER BY ci."sortNumber""#,
        )
        .bind(m)
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        let s = |v: &str| Some(v.to_owned());
        assert_eq!(
            got,
            [
                ("7".to_owned(), s("Seven"), s("Sum"), s("2017-03-09")),
                ("8".to_owned(), None, None, None),
                ("9".to_owned(), None, None, None),
            ]
        );
        let d: (Option<String>, Option<i32>, Option<i32>) = sqlx::query_as(
            r#"SELECT publisher, "startYear", volume FROM comic_details WHERE "mediaId" = $1"#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(d, (None, None, None));
        crate::media::write::fields::merge_unmatched(&c.st, m)
            .await
            .unwrap();
        let d: (Option<String>, Option<i32>, Option<i32>) = sqlx::query_as(
            r#"SELECT publisher, "startYear", volume FROM comic_details WHERE "mediaId" = $1"#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(d, (s("Pub"), Some(2016), None));
    }

    #[sqlx::test(migrations = false)]
    async fn a_locked_field_is_not_filled_by_a_new_version(pool: PgPool) {
        let c = ctx(pool).await;
        let m = comic(&c, "Moon Tales").await;
        let d = c.dir.join("comics/Moon Tales");
        cbz(&d.join("Moon Tales 01.cbz"), 1);
        comics::register(&c.st, m, &placed(&c, &["Moon Tales/Moon Tales 01.cbz"]))
            .await
            .unwrap();
        sqlx::query(r#"UPDATE comic_issues SET "lockedFields" = '{title}' WHERE "mediaId" = $1"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
        sqlx::query(r#"INSERT INTO media_field_sources ("mediaId", field, locked) VALUES ($1, 'publisher', true)"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
        cbz_with_info(
            &d.join("Moon Tales 01 (Variant).cbz"),
            "<ComicInfo><Title>New</Title><Summary>S</Summary><Publisher>P</Publisher></ComicInfo>",
        );
        comics::register(
            &c.st,
            m,
            &placed(&c, &["Moon Tales/Moon Tales 01 (Variant).cbz"]),
        )
        .await
        .unwrap();
        let (title, overview): (Option<String>, Option<String>) =
            sqlx::query_as(r#"SELECT title, overview FROM items WHERE "mediaId" = $1"#)
                .bind(m)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!((title, overview), (None, Some("S".to_owned())));
        crate::media::write::fields::merge_unmatched(&c.st, m)
            .await
            .unwrap();
        let p: Option<String> =
            sqlx::query_scalar(r#"SELECT publisher FROM comic_details WHERE "mediaId" = $1"#)
                .bind(m)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!(p, None);
    }
}

mod scene_import {
    use super::*;
    use crate::ingest::{
        library::{self, File, Request},
        transfer::Method,
    };

    /// A series with `seasons` as (number, episodes), each episode an item with its own number.
    async fn series(c: &Ctx, tvdb: i32, seasons: &[(i32, i32)]) -> i32 {
        let lib = library(c, "S", &c.dir.join("series"), r#"["series"]"#).await;
        let m = media(c, lib, "Show", "series").await;
        let edition = crate::media::items::video_edition(&c.st.db, m)
            .await
            .unwrap();
        sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'series', 'tvdb', $2)"#)
            .bind(m)
            .bind(tvdb.to_string())
            .execute(&c.st.db)
            .await
            .unwrap();
        for (n, eps) in seasons {
            let g: i32 = sqlx::query_scalar(r#"INSERT INTO item_groups ("mediaId", "number", monitored) VALUES ($1, $2, true) RETURNING id"#)
                .bind(m)
                .bind(n)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
            sqlx::query(r#"INSERT INTO items ("mediaId", "editionId", "groupId", "number", monitored) SELECT $1, $2, $3, e, true FROM generate_series(1, $4) e"#)
                .bind(m)
                .bind(edition)
                .bind(g)
                .bind(eps)
                .execute(&c.st.db)
                .await
                .unwrap();
        }
        m
    }

    /// A mapping of scene season 4 onto aired season 3, library seasons 1 to 3 holding 10, 7, 8.
    async fn mapped(c: &Ctx, tvdb: i32) -> i32 {
        let m = series(c, tvdb, &[(1, 10), (2, 7), (3, 8)]).await;
        let map: fliks_domain::release::scene::SceneMap = serde_json::from_str(include_str!(
            "../../../../fixtures/scene-numbering/map.json"
        ))
        .unwrap();
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId", entries) VALUES ($1, $2)"#)
            .bind(tvdb)
            .bind(sqlx::types::Json(map))
            .execute(&c.st.db)
            .await
            .unwrap();
        m
    }

    async fn import(c: &Ctx, m: i32, name: &str, episode_id: Option<i32>) -> library::Outcome {
        let path = c.dir.join("dl").join(name);
        touch(&path, b"ep");
        let guard = c.st.ingest.media.lock(m).await;
        let req = Request {
            media_id: m,
            files: vec![File { path, episode_id }],
            transfer: Method::Copy,
            fallback_quality: None,
            release_name: None,
            force: false,
            uniquify_on_collision: false,
            replace_existing: false,
            language: None,
        };
        library::ingest(&c.st, &guard, req).await.unwrap()
    }

    #[sqlx::test(migrations = false)]
    async fn a_scene_named_file_imports_into_its_aired_episode(pool: PgPool) {
        let c = ctx(pool).await;
        let m = mapped(&c, 375921).await;
        let out = import(&c, m, "Show.S04E01.1080p.mkv", None).await;
        assert_eq!(out.errors.len(), 0, "{:?}", out.errors);
        let i = &out.imported[0];
        assert_eq!((i.season_number, i.episode_number), (Some(3), Some(1)));
    }

    #[sqlx::test(migrations = false)]
    async fn an_explicit_episode_wins_over_the_name(pool: PgPool) {
        let c = ctx(pool).await;
        let m = mapped(&c, 375921).await;
        let ep: i32 = sqlx::query_scalar(r#"SELECT e.id FROM items e JOIN item_groups g ON g.id = e."groupId" WHERE g."mediaId" = $1 AND g."number" = 1 AND e."number" = 2"#)
            .bind(m)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        let out = import(&c, m, "Show.S02E01-E02.1080p.mkv", Some(ep)).await;
        let i = &out.imported[0];
        assert_eq!((i.season_number, i.episode_number), (Some(1), Some(2)));
        assert_eq!(
            i.episode_end,
            Some(2),
            "the name's end stays untranslated, not 7"
        );
    }

    async fn unknown(c: &Ctx) -> i32 {
        let down = std::sync::Arc::new(crate::metadata::scene_stub::SceneStub::default());
        down.down.store(true, std::sync::atomic::Ordering::SeqCst);
        c.st.metadata.add_plugin(down);
        let m = series(c, 375921, &[(3, 8)]).await;
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId") VALUES (375921)"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        m
    }

    #[sqlx::test(migrations = false)]
    async fn an_unknown_mapping_skips_and_fails_the_import(pool: PgPool) {
        let c = ctx(pool).await;
        let m = unknown(&c).await;
        let out = import(&c, m, "Show.S04E01.1080p.mkv", None).await;
        assert!(out.imported.is_empty() && out.errors.is_empty());
        assert!(out.retry[0].contains("scene mapping"), "{:?}", out.retry);
    }

    #[sqlx::test(migrations = false)]
    async fn an_explicit_episode_imports_whatever_the_mapping_state(pool: PgPool) {
        let c = ctx(pool).await;
        let m = unknown(&c).await;
        let ep: i32 = sqlx::query_scalar(r#"SELECT e.id FROM items e JOIN item_groups g ON g.id = e."groupId" WHERE g."mediaId" = $1 AND e."number" = 2"#)
            .bind(m)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        let out = import(&c, m, "Show.S04E01.1080p.mkv", Some(ep)).await;
        assert_eq!(
            (out.imported.len(), out.errors.len(), out.retry.len()),
            (1, 0, 0)
        );
        assert_eq!(out.imported[0].episode_number, Some(2));
    }

    #[sqlx::test(migrations = false)]
    async fn an_ambiguous_number_is_a_plain_error_not_a_retry(pool: PgPool) {
        let c = ctx(pool).await;
        let m = series(&c, 375921, &[(1, 3), (2, 4), (3, 1)]).await;
        let map: fliks_domain::release::scene::SceneMap = serde_json::from_str(include_str!(
            "../../../../fixtures/scene-numbering/map-ambiguous.json"
        ))
        .unwrap();
        sqlx::query(r#"INSERT INTO scene_mappings ("tvdbId", entries) VALUES (375921, $1)"#)
            .bind(sqlx::types::Json(map))
            .execute(&c.st.db)
            .await
            .unwrap();
        let out = import(&c, m, "Show.S02E01.1080p.mkv", None).await;
        assert_eq!(
            (out.imported.len(), out.errors.len(), out.retry.len()),
            (0, 1, 0)
        );
        assert!(out.errors[0].contains("ambiguous"), "{:?}", out.errors);
    }

    #[sqlx::test(migrations = false)]
    async fn a_second_ingest_of_a_placed_file_is_already_present(pool: PgPool) {
        let c = ctx(pool).await;
        let m = mapped(&c, 375921).await;
        let path = c.dir.join("dl").join("Show.S04E01.1080p.mkv");
        touch(&path, b"ep");
        let run = || async {
            let guard = c.st.ingest.media.lock(m).await;
            let req = Request {
                media_id: m,
                files: vec![File {
                    path: path.clone(),
                    episode_id: None,
                }],
                transfer: Method::Copy,
                fallback_quality: None,
                release_name: None,
                force: false,
                uniquify_on_collision: false,
                replace_existing: true,
                language: None,
            };
            library::ingest(&c.st, &guard, req).await.unwrap()
        };
        let first = run().await;
        assert_eq!(first.imported.len(), 1, "{:?}", first.errors);
        let again = run().await;
        assert_eq!(
            (again.imported.len(), again.already_present.len()),
            (0, 1),
            "{:?}",
            again.errors
        );
        assert!(again.errors.is_empty() && again.retry.is_empty());
    }
}

mod music_ingest {
    use super::*;
    use crate::{
        ingest::{
            books::Placed,
            music::{self, identify},
        },
        metadata::music::{
            self as meta,
            tests::{ARTIST, GROUP, MusicFake, RELEASE},
        },
    };
    use fliks_domain::{
        external_id::Namespace, media::kind::MediaKind, metadata::limiter::Priority,
    };
    use std::sync::Arc;

    const OTHER_RELEASE: &str = "0f6b9c1e-7a52-4d0b-8a6c-33c1c8e5f0aa";
    const MERGED: &str = "9a8d2e17-5f43-4c6a-b1d9-6e7a0c4b2f55";

    fn track(title: &str, number: u32, disc: u32, extra: Value) -> crate::engine::testkit::Answer {
        let mut tags = json!({"title": title, "album": "Alpha", "artist": "Ana", "albumArtist": "Ana",
            "genre": "Rock; Pop", "year": 1999, "track": number, "disc": disc, "lyrics": "la la la"});
        tags.as_object_mut()
            .unwrap()
            .extend(extra.as_object().cloned().unwrap_or_default());
        ok(
            json!({"ok": true, "info": {"video": [], "audio": [{"streamIndex": 0, "codec": "flac", "language": "und"}],
            "subtitles": [], "durationSeconds": 200.0, "tags": tags}}),
        )
    }

    async fn album_lib(c: &Ctx) -> i32 {
        library(c, "Music", &c.dir.join("music"), r#"["album"]"#).await
    }

    fn place(c: &Ctx, rels: &[&str]) -> Vec<Placed> {
        rels.iter()
            .map(|r| {
                touch(&c.dir.join("music").join(r), r.as_bytes());
                Placed {
                    folder_id: 1,
                    rel: (*r).to_owned(),
                    abs: c.dir.join("music").join(r),
                }
            })
            .collect()
    }

    type TrackRow = (String, i32, i32, Option<i32>, Option<String>);
    type MatchedRow = (String, i32, Option<String>, Option<f64>, bool);

    fn edition_release(id: &str, tracks: Value) -> Value {
        json!({"externalId": id, "title": "Alpha", "country": "FR", "status": "official", "media": "cd",
            "trackCount": 3, "discCount": 2, "releaseDate": "1999-05-01", "label": "Placeholder Records",
            "tracks": tracks})
    }

    fn tracklist() -> Value {
        json!([
            {"title": "One", "discNumber": 1, "position": 1, "number": 1, "durationMs": 200000,
             "recordingId": "11111111-1111-4111-8111-111111111111",
             "releaseTrackId": "21111111-1111-4111-8111-111111111111",
             "artists": [{"name": "Ana", "id": ARTIST}], "popularity": 12.5,
             "works": [{"title": "Suite", "externalId": "31111111-1111-4111-8111-111111111111"}]},
            {"title": "Two", "discNumber": 1, "position": 2, "number": 2, "durationMs": 200000,
             "recordingId": "11111111-1111-4111-8111-111111111112"},
            {"title": "Three", "discNumber": 2, "position": 3, "number": 1, "durationMs": 200000,
             "recordingId": "11111111-1111-4111-8111-111111111113"}
        ])
    }

    fn provider() -> Arc<MusicFake> {
        let f = Arc::new(MusicFake::default());
        f.works.lock().unwrap().insert(
            GROUP.into(),
            json!({"externalId": GROUP, "title": "Alpha (Provider)", "primaryType": "album", "year": 1999,
                "firstReleaseDate": "1999-05-01", "genres": ["Provider Genre"], "popularity": 7.0,
                "artists": [{"name": "Ana", "id": ARTIST, "sortName": "Ana"}], "mediaType": "album"}),
        );
        f.children.lock().unwrap().insert(
            GROUP.into(),
            vec![
                json!({"externalId": RELEASE, "title": "Alpha", "country": "FR", "trackCount": 3}),
            ],
        );
        f.editions
            .lock()
            .unwrap()
            .insert(RELEASE.into(), edition_release(RELEASE, tracklist()));
        f
    }

    async fn ctx_music(pool: PgPool, f: Option<Arc<MusicFake>>) -> Ctx {
        let p: Option<Arc<dyn crate::metadata::MetadataProvider>> = f.map(|f| f as _);
        ctx_with(pool, p).await
    }

    async fn album(c: &Ctx, lib: i32, folder: &str) -> i32 {
        media(c, lib, folder, "album").await
    }

    #[sqlx::test(migrations = false)]
    async fn a_folder_of_discs_is_one_edition_of_ungrouped_tracks_and_lyrics_stay_out_of_stream_info(
        pool: PgPool,
    ) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Ana/Alpha").await;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                track("One", 1, 1, json!({})),
                track("Two", 2, 1, json!({"composer": "Cy", "conductor": "Di"})),
                track("Three", 1, 2, json!({"discSubtitle": "Bonus"})),
            ],
        );
        let files = place(
            &c,
            &[
                "Ana/Alpha/CD1/01.flac",
                "Ana/Alpha/CD1/02.flac",
                "Ana/Alpha/CD2/01.flac",
            ],
        );
        let reg = music::register(&c.st, m, &files).await.unwrap();
        assert_eq!(
            (reg.files.len(), reg.conflicts.len()),
            (3, 0),
            "{:?}",
            reg.conflicts
        );
        assert_eq!(
            count(&c, "SELECT count(*) FROM editions WHERE family = 'audio'").await,
            1
        );
        assert_eq!(
            count(
                &c,
                "SELECT count(*) FROM items WHERE \"groupId\" IS NULL AND number IS NULL"
            )
            .await,
            3
        );
        assert_eq!(count(&c, "SELECT count(*) FROM item_groups").await, 0);
        let rows: Vec<TrackRow> = sqlx::query_as(
            r#"SELECT i.title, td."discNumber", td.position, td."trackNumber", td."discTitle"
               FROM items i JOIN track_details td ON td."itemId" = i.id ORDER BY td.position"#,
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            rows,
            [
                ("One".into(), 1, 1, Some(1), None),
                ("Two".into(), 1, 2, Some(2), None),
                ("Three".into(), 2, 3, Some(1), Some("Bonus".into())),
            ]
        );
        // One part per file, each a first version.
        assert_eq!(
            count(
                &c,
                "SELECT count(*) FROM item_parts WHERE version = 0 AND position = 0"
            )
            .await,
            3
        );
        assert_eq!(
            count(
                &c,
                r#"SELECT count(*) FROM media_files WHERE "streamInfo"::text LIKE '%la la la%'"#
            )
            .await,
            0
        );
        assert_eq!(
            count(&c, r#"SELECT count(*) FROM media_files WHERE "streamInfo"->'tags'->>'title' IS NOT NULL"#).await,
            3
        );
        let credits: Vec<(String, String)> = sqlx::query_as(
            r#"SELECT c.role, p.name FROM item_credits c JOIN persons p ON p.id = c."personId"
               JOIN items i ON i.id = c."itemId" WHERE i.title = 'Two' ORDER BY c.role"#,
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            credits,
            [
                ("artist".into(), "Ana".into()),
                ("composer".into(), "Cy".into()),
                ("conductor".into(), "Di".into())
            ]
        );
        let (artists, details): (i64, i64) = (
            count(
                &c,
                r#"SELECT count(*) FROM media_credits WHERE role = 'artist'"#,
            )
            .await,
            count(&c, "SELECT count(*) FROM album_details").await,
        );
        assert_eq!((artists, details), (1, 1));
        let (tracks, discs): (Option<i32>, Option<i32>) = sqlx::query_as(
            r#"SELECT "trackCount", "discCount" FROM editions WHERE family = 'audio'"#,
        )
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!((tracks, discs), (Some(3), Some(2)));
        // The same files again change nothing; a file moved takes its track back.
        c.fake
            .script("POST", "/v1/probe", vec![track("One", 1, 1, json!({}))]);
        music::register(&c.st, m, &files).await.unwrap();
        assert_eq!(count(&c, "SELECT count(*) FROM items").await, 3);
        sqlx::query(r#"DELETE FROM media_files WHERE "relativePath" = 'Ana/Alpha/CD1/01.flac'"#)
            .execute(&c.st.db)
            .await
            .unwrap();
        let moved = place(&c, &["Ana/Alpha/CD1/01 - One.flac"]);
        music::register(&c.st, m, &moved).await.unwrap();
        assert_eq!(count(&c, "SELECT count(*) FROM items").await, 3);
        assert_eq!(
            count(&c, "SELECT count(*) FROM items i WHERE NOT EXISTS (SELECT 1 FROM item_parts p WHERE p.\"itemId\" = i.id)").await,
            0
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_track_without_a_disc_tag_takes_the_disc_of_its_folder(pool: PgPool) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Ana/Alpha").await;
        let bare = |t: &str, n: u32| track(t, n, 1, json!({"disc": null, "lyrics": null}));
        c.fake
            .script("POST", "/v1/probe", vec![bare("One", 1), bare("Two", 1)]);
        let files = place(&c, &["Ana/Alpha/CD1/01.flac", "Ana/Alpha/CD2/01.flac"]);
        music::register(&c.st, m, &files).await.unwrap();
        let discs: Vec<(String, i32)> = sqlx::query_as(
            r#"SELECT i.title, td."discNumber" FROM items i JOIN track_details td ON td."itemId" = i.id ORDER BY i.title"#,
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(discs, [("One".into(), 1), ("Two".into(), 2)]);
        // Both files go and come back: each takes the track of its own disc, not the first with number 1.
        sqlx::query(r#"DELETE FROM media_files WHERE "mediaId" = $1"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
        c.fake
            .script("POST", "/v1/probe", vec![bare("Two", 1), bare("One", 1)]);
        let again = place(
            &c,
            &["Ana/Alpha/CD2/01 - Two.flac", "Ana/Alpha/CD1/01 - One.flac"],
        );
        music::register(&c.st, m, &again).await.unwrap();
        assert_eq!(count(&c, "SELECT count(*) FROM items").await, 2);
        let held: Vec<(String, String)> = sqlx::query_as(
            r#"SELECT i.title, f."relativePath" FROM items i JOIN item_parts p ON p."itemId" = i.id
               JOIN media_files f ON f.id = p."mediaFileId" ORDER BY i.title"#,
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            held,
            [
                ("One".into(), "Ana/Alpha/CD1/01 - One.flac".into()),
                ("Two".into(), "Ana/Alpha/CD2/01 - Two.flac".into())
            ]
        );
    }

    #[sqlx::test(migrations = false)]
    async fn two_untagged_discs_of_a_download_keep_their_own_file_names(pool: PgPool) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        let bare = || {
            track(
                "x",
                1,
                1,
                json!({"title": null, "track": null, "disc": null, "lyrics": null}),
            )
        };
        c.fake.script("POST", "/v1/probe", vec![bare()]);
        let inbox = c.dir.join("inbox/Alpha");
        let files: Vec<_> = ["CD1/01.flac", "CD2/01.flac"]
            .iter()
            .map(|r| {
                touch(&inbox.join(r), r.as_bytes());
                crate::ingest::library::File {
                    path: inbox.join(r),
                    episode_id: None,
                }
            })
            .collect();
        let guard = c.st.ingest.media.lock(m).await;
        let out = crate::ingest::library::ingest(
            &c.st,
            &guard,
            crate::ingest::library::Request {
                media_id: m,
                files,
                transfer: crate::ingest::transfer::Method::Copy,
                fallback_quality: None,
                release_name: None,
                force: false,
                uniquify_on_collision: false,
                replace_existing: false,
                language: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            (
                out.imported.len(),
                out.already_present.len(),
                out.errors.len()
            ),
            (2, 0, 0),
            "{:?}",
            out.errors
        );
        let discs: Vec<(String, i32)> = sqlx::query_as(
            r#"SELECT f."relativePath", td."discNumber" FROM track_details td
               JOIN item_parts p ON p."itemId" = td."itemId" JOIN media_files f ON f.id = p."mediaFileId"
               ORDER BY td."discNumber""#,
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            discs,
            [
                ("Alpha/CD1/01.flac".into(), 1),
                ("Alpha/CD2/01.flac".into(), 2)
            ]
        );
    }

    #[sqlx::test(migrations = false)]
    async fn lyrics_are_found_served_edited_and_carried_to_the_new_file(pool: PgPool) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        let embedded = track(
            "One",
            1,
            1,
            json!({"lyrics": "plain one\nplain two", "syncedLyrics": "[00:01.00]sung one\n[00:03.00]sung two"}),
        );
        c.fake.script("POST", "/v1/probe", vec![embedded]);
        let files = place(&c, &["Alpha/01.flac"]);
        std::fs::write(
            c.dir.join("music/Alpha/01.fr.lrc"),
            "[00:02.00]<00:02.00>un <00:02.50>deux\n",
        )
        .unwrap();
        music::register(&c.st, m, &files).await.unwrap();
        let item: i32 = sqlx::query_scalar("SELECT id FROM items")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        let uri = format!("/api/items/{item}/lyrics?enhanced=true");
        let (s, v) = call(&c, "GET", &uri, &c.admin, Value::Null).await;
        assert_eq!(s, 200, "{v}");
        let list = v["structuredLyrics"].as_array().unwrap();
        assert_eq!(list.len(), 2, "{v}");
        // The sidecar outranks the embedded text; its words come as cues.
        assert_eq!(list[0]["source"], "sidecar");
        assert_eq!(list[0]["lang"], "fr");
        assert_eq!(list[0]["cueLine"][0]["cue"][1]["value"], "deux");
        assert_eq!(list[1]["source"], "embedded");
        assert_eq!(list[1]["line"][1]["value"], "sung two");
        assert_eq!(
            count(
                &c,
                r#"SELECT count(*) FROM media_files WHERE "streamInfo"::text LIKE '%sung one%'"#
            )
            .await,
            0
        );
        let (s, _) = call(&c, "GET", &uri, "nope", Value::Null).await;
        assert_eq!(s, 401);
        // A paste is the user's, the offset nudge is kept, .
        let put = json!({"kind": "main", "lang": "en", "format": "lrc", "body": "[00:05.00]mine"});
        let (s, _) = call(
            &c,
            "PUT",
            &format!("/api/items/{item}/lyrics"),
            &c.admin,
            put,
        )
        .await;
        assert_eq!(s, 200);
        let (s, _) = call(
            &c,
            "PUT",
            &format!("/api/items/{item}/lyrics"),
            &c.admin,
            json!({"format": "lrc", "body": "no lyrics here at all [x"}),
        )
        .await;
        assert_eq!(s, 200, "a text with no time tag is plain, not refused");
        let (s, _) = call(
            &c,
            "PUT",
            &format!("/api/items/{item}/lyrics"),
            &c.admin,
            json!({"format": "ttml", "body": "<html/>"}),
        )
        .await;
        assert_eq!(s, 400);
        let id: i32 =
            sqlx::query_scalar(r#"SELECT id FROM lyrics WHERE source = 'user' AND lang = 'en'"#)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        let (s, v) = call(
            &c,
            "PATCH",
            &format!("/api/lyrics/{id}"),
            &c.admin,
            json!({"offsetMs": 250, "preferred": true}),
        )
        .await;
        assert_eq!(s, 200);
        assert_eq!(v["structuredLyrics"][0]["offset"], 250);
        assert_eq!(v["structuredLyrics"][0]["source"], "user");
        // The file is replaced by one of the same length: every row follows the track, user text included.
        sqlx::query(r#"DELETE FROM media_files WHERE "mediaId" = $1"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![track("One", 1, 1, json!({"lyrics": null}))],
        );
        music::register(&c.st, m, &place(&c, &["Alpha/01 - One.flac"]))
            .await
            .unwrap();
        assert_eq!(count(&c, "SELECT count(*) FROM items").await, 1);
        assert_eq!(
            count(
                &c,
                r#"SELECT count(*) FROM lyrics WHERE source = 'user' AND "mediaFileId" IS NOT NULL"#
            )
            .await,
            2
        );
        assert_eq!(
            count(&c, "SELECT count(*) FROM lyrics WHERE source = 'embedded'").await,
            0
        );
        // A file 30 s longer drops the timing of what stays and keeps the text.
        sqlx::query(
            r#"UPDATE lyrics SET "audioDurationMs" = 100000 WHERE source = 'user' AND lang = 'en'"#,
        )
        .execute(&c.st.db)
        .await
        .unwrap();
        sqlx::query(r#"DELETE FROM media_files WHERE "mediaId" = $1"#)
            .bind(m)
            .execute(&c.st.db)
            .await
            .unwrap();
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![track("One", 1, 1, json!({"lyrics": null}))],
        );
        music::register(&c.st, m, &place(&c, &["Alpha/01 - One again.flac"]))
            .await
            .unwrap();
        let (sync, off): (String, i32) = sqlx::query_as(
            r#"SELECT sync, "offsetMs" FROM lyrics WHERE source = 'user' AND lang = 'en'"#,
        )
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!((sync.as_str(), off), ("none", 0));
        let (s, _) = call(
            &c,
            "DELETE",
            &format!("/api/lyrics/{id}"),
            &c.admin,
            Value::Null,
        )
        .await;
        assert_eq!(s, 204);
    }

    #[sqlx::test(migrations = false)]
    async fn a_provider_fills_missing_lyrics_and_a_miss_is_remembered(pool: PgPool) {
        let fake = Arc::new(MusicFake::default());
        let hit = crate::metadata::LyricsHit {
            format: "lrc".into(),
            document: "[00:01.00]hello\n[00:02.00]world".into(),
            instrumental: false,
            lang: Some("en".into()),
            source_ref: Some("42".into()),
        };
        *fake.lyrics.lock().unwrap() = Some(Some(hit.clone()));
        let c = ctx_music(pool, Some(fake.clone())).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![track("One", 1, 1, json!({"lyrics": null}))],
        );
        music::register(&c.st, m, &place(&c, &["Alpha/01.flac"]))
            .await
            .unwrap();
        let item: i32 = sqlx::query_scalar("SELECT id FROM items")
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        let fetch = format!("/api/items/{item}/lyrics/fetch");
        let (s, v) = call(&c, "POST", &fetch, &c.admin, json!({})).await;
        assert_eq!(s, 200, "{v}");
        assert_eq!(v["structuredLyrics"][0]["source"], "provider:musicbrainz");
        assert_eq!(v["structuredLyrics"][0]["lang"], "en");
        assert_eq!(v["structuredLyrics"][0]["synced"], true);
        // A synced document ends the asking; a miss is cached against the provider, `force` ignores it.
        let asked = |f: &MusicFake| f.calls().iter().filter(|c| c.starts_with("lyrics")).count();
        call(&c, "POST", &fetch, &c.admin, json!({})).await;
        assert_eq!(asked(&fake), 1);
        sqlx::query("DELETE FROM lyrics")
            .execute(&c.st.db)
            .await
            .unwrap();
        *fake.lyrics.lock().unwrap() = Some(None);
        call(&c, "POST", &fetch, &c.admin, json!({})).await;
        *fake.lyrics.lock().unwrap() = Some(Some(hit));
        let (_, v) = call(&c, "POST", &fetch, &c.admin, json!({})).await;
        assert_eq!(v["structuredLyrics"].as_array().unwrap().len(), 0);
        assert_eq!(asked(&fake), 2);
        let (_, v) = call(&c, "POST", &fetch, &c.admin, json!({"force": true})).await;
        assert_eq!(v["structuredLyrics"].as_array().unwrap().len(), 1);
    }

    #[sqlx::test(migrations = false)]
    async fn a_release_id_in_the_tags_makes_its_own_edition(pool: PgPool) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                track(
                    "One",
                    1,
                    1,
                    json!({"musicbrainzReleaseId": RELEASE, "label": "Placeholder Records",
                    "mediaType": "x", "releaseStatus": "Official"}),
                ),
                track("One", 1, 1, json!({"musicbrainzReleaseId": OTHER_RELEASE})),
                track("Two", 2, 1, json!({"musicbrainzReleaseId": RELEASE})),
            ],
        );
        let files = place(&c, &["Alpha/a.flac", "Alpha/b.flac", "Alpha/c.flac"]);
        music::register(&c.st, m, &files).await.unwrap();
        let held: Vec<(String, i64)> = sqlx::query_as(
            r#"SELECT x.value, count(i.id) FROM editions e JOIN edition_external_ids x ON x."editionId" = e.id
               JOIN items i ON i."editionId" = e.id WHERE x.provider = 'musicbrainz' GROUP BY x.value ORDER BY x.value"#,
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            held,
            [(OTHER_RELEASE.to_owned(), 1), (RELEASE.to_owned(), 2)]
        );
        let (publisher, status): (Option<String>, Option<String>) = sqlx::query_as(
            r#"SELECT e.publisher, e.status FROM editions e JOIN edition_external_ids x ON x."editionId" = e.id
               WHERE x.value = $1"#,
        )
        .bind(RELEASE)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            (publisher.as_deref(), status.as_deref()),
            (Some("Placeholder Records"), Some("official"))
        );
    }

    #[sqlx::test(migrations = false)]
    async fn works_and_movements_come_from_the_tags(pool: PgPool) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        let movement = |n: u32, name: &str| {
            track(
                name,
                n,
                1,
                json!({"work": "Symphony No. 1", "movement": name, "movementNumber": n,
                    "composer": "Cy", "musicbrainzWorkId": format!("4000000{n}-1111-4111-8111-111111111111")}),
            )
        };
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![movement(1, "Allegro"), movement(2, "Adagio")],
        );
        music::register(&c.st, m, &place(&c, &["Alpha/1.flac", "Alpha/2.flac"]))
            .await
            .unwrap();
        let rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            r#"SELECT w.title, p.title, c.name FROM works w LEFT JOIN works p ON p.id = w."parentWorkId"
               LEFT JOIN persons c ON c.id = w."composerPersonId" WHERE w.mbid IS NOT NULL ORDER BY w.title"#,
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            rows,
            [
                (
                    "Adagio".into(),
                    Some("Symphony No. 1".into()),
                    Some("Cy".into())
                ),
                (
                    "Allegro".into(),
                    Some("Symphony No. 1".into()),
                    Some("Cy".into())
                ),
            ]
        );
        assert_eq!(
            count(
                &c,
                "SELECT count(*) FROM works WHERE title = 'Symphony No. 1'"
            )
            .await,
            1
        );
        assert_eq!(count(&c, "SELECT count(*) FROM item_works").await, 2);
        // Work search.
        let (s, b) = call(&c, "GET", "/api/works?q=adag", &c.admin, Value::Null).await;
        assert_eq!(s, 200);
        assert_eq!(b[0]["title"], "Adagio");
        assert_eq!(b[0]["parent"]["title"], "Symphony No. 1");
    }

    #[sqlx::test(migrations = false)]
    async fn the_ids_of_the_tags_identify_the_album_and_the_release_fills_its_tracks(pool: PgPool) {
        let f = provider();
        let c = ctx_music(pool, Some(f.clone())).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        let ids = json!({"musicbrainzReleaseGroupId": GROUP, "musicbrainzReleaseId": RELEASE});
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                track("One (live)", 1, 1, ids.clone()),
                track("Two", 2, 1, ids.clone()),
                track("Extra", 9, 2, ids.clone()),
            ],
        );
        music::register(
            &c.st,
            m,
            &place(&c, &["Alpha/1.flac", "Alpha/2.flac", "Alpha/9.flac"]),
        )
        .await
        .unwrap();
        let out = identify::identify_media(&c.st, m).await.unwrap();
        assert_eq!(out, identify::Outcome::Applied);
        let id: String = sqlx::query_scalar(
            r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = 'musicbrainz'"#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(id, GROUP);
        let (title, genres): (String, Value) =
            sqlx::query_as("SELECT title, genres FROM media WHERE id = $1")
                .bind(m)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        // The tags give genres: the provider's do not replace them; the title is the provider's.
        assert_eq!(
            (title.as_str(), genres),
            ("Alpha (Provider)", json!(["Rock", "Pop"]))
        );
        let tracks: Vec<MatchedRow> = sqlx::query_as(
            r#"SELECT i.title, td.position, td."releaseTrackMbid"::text, td.popularity, td."orphanedAt" IS NOT NULL
               FROM items i JOIN track_details td ON td."itemId" = i.id ORDER BY td.position, i.id"#,
        )
        .fetch_all(&c.st.db)
        .await
        .unwrap();
        assert_eq!(tracks[0].0, "One");
        assert_eq!(
            tracks[0].2.as_deref(),
            Some("21111111-1111-4111-8111-111111111111")
        );
        assert_eq!(tracks[0].3, Some(12.5));
        assert_eq!(tracks[1].0, "Two");
        // The file the release does not list is flagged, not deleted.
        let extra = tracks.iter().find(|t| t.0 == "Extra").unwrap();
        assert!(extra.4);
        let (country, discs, status): (Option<String>, Option<i32>, Option<String>) =
            sqlx::query_as(
                r#"SELECT country, "discCount", status FROM editions WHERE family = 'audio'"#,
            )
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        assert_eq!(
            (country.as_deref(), discs, status.as_deref()),
            (Some("FR"), Some(2), Some("official"))
        );
        let (primary, compilation, orphaned): (Option<String>, bool, bool) = sqlx::query_as(
            r#"SELECT "primaryType", "isCompilation", "orphanedAt" IS NOT NULL FROM album_details WHERE "mediaId" = $1"#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            (primary.as_deref(), compilation, orphaned),
            (Some("album"), false, false)
        );
        // The work the release names is kept, linked to the track.
        assert_eq!(count(&c, "SELECT count(*) FROM item_works").await, 1);
        // The album artist is the provider's person, with its id.
        assert_eq!(
            count(
                &c,
                &format!("SELECT count(*) FROM person_external_ids WHERE value = '{ARTIST}'")
            )
            .await,
            1
        );
        // A second identify has nothing left to do.
        assert_eq!(
            identify::identify_media(&c.st, m).await.unwrap(),
            identify::Outcome::Nothing
        );
    }

    #[sqlx::test(migrations = false)]
    async fn untagged_files_of_an_identified_album_fill_its_target_edition_and_satisfy_the_want(
        pool: PgPool,
    ) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ({m}, 'album', 'musicbrainz', '{GROUP}');
               INSERT INTO editions ("mediaId", family) VALUES ({m}, 'audio');
               INSERT INTO items ("mediaId", "editionId", monitored, title)
                 SELECT {m}, e.id, true, t FROM editions e, unnest(ARRAY['One', 'Two', 'Three']) t;
               INSERT INTO track_details ("itemId", "mediaId", position, "discNumber", "trackNumber")
                 SELECT i.id, {m}, row_number() OVER (ORDER BY i.id), CASE i.title WHEN 'Three' THEN 2 ELSE 1 END,
                        CASE i.title WHEN 'Two' THEN 2 ELSE 1 END
                   FROM items i WHERE i."mediaId" = {m};
               INSERT INTO edition_external_ids ("editionId", "mediaId", provider, value)
                 SELECT id, {m}, 'musicbrainz', '{RELEASE}' FROM editions;
               INSERT INTO album_details ("mediaId", "targetEditionId") SELECT {m}, id FROM editions"#
        )))
        .execute(&c.st.db)
        .await
        .unwrap();
        let plain = |t: &str, n: u32, d: u32| track(t, n, d, json!({}));
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                plain("One", 1, 1),
                plain("Two", 2, 1),
                plain("three", 1, 2),
                plain("Stray", 7, 1),
            ],
        );
        music::register(
            &c.st,
            m,
            &place(
                &c,
                &["Alpha/1.mp3", "Alpha/2.mp3", "Alpha/3.mp3", "Alpha/7.mp3"],
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            count(&c, "SELECT count(*) FROM editions WHERE family = 'audio'").await,
            2,
            "the file no track pairs with gets the release-less edition"
        );
        assert_eq!(
            count(
                &c,
                "SELECT count(*) FROM item_parts p JOIN items i ON i.id = p.\"itemId\" JOIN album_details ad ON ad.\"mediaId\" = i.\"mediaId\" WHERE i.\"editionId\" = ad.\"targetEditionId\""
            )
            .await,
            3
        );
        let wants = crate::media::wants::list(&c.st.db, m).await.unwrap();
        assert!(wants.iter().all(|w| w.satisfied), "{:?}", wants.len());
    }

    #[sqlx::test(migrations = false)]
    async fn a_compilation_has_various_artists_as_its_album_artist(pool: PgPool) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Mix").await;
        let by = |t: &str, n: u32, who: &str| {
            track(
                t,
                n,
                1,
                json!({"artist": who, "albumArtist": null, "lyrics": null}),
            )
        };
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![by("One", 1, "Ana"), by("Two", 2, "Bo")],
        );
        music::register(&c.st, m, &place(&c, &["Mix/1.flac", "Mix/2.flac"]))
            .await
            .unwrap();
        let (compilation, names): (bool, Vec<String>) = sqlx::query_as(
            r#"SELECT ad."isCompilation", COALESCE(array_agg(p.name) FILTER (WHERE p.name IS NOT NULL), '{}')
               FROM album_details ad LEFT JOIN media_credits mc ON mc."mediaId" = ad."mediaId" AND mc.role = 'artist'
               LEFT JOIN persons p ON p.id = mc."personId" WHERE ad."mediaId" = $1 GROUP BY ad."isCompilation""#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(
            (compilation, names),
            (true, vec!["Various Artists".to_owned()])
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_missing_release_group_a_shrunk_tracklist_and_a_merged_id_never_delete(pool: PgPool) {
        let f = provider();
        let c = ctx_music(pool, Some(f.clone())).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        let ids = json!({"musicbrainzReleaseGroupId": GROUP, "musicbrainzReleaseId": RELEASE});
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                track("One", 1, 1, ids.clone()),
                track("Two", 2, 1, ids.clone()),
                track("Three", 1, 2, ids),
            ],
        );
        music::register(
            &c.st,
            m,
            &place(&c, &["Alpha/1.flac", "Alpha/2.flac", "Alpha/3.flac"]),
        )
        .await
        .unwrap();
        identify::identify_media(&c.st, m).await.unwrap();
        let items = count(&c, "SELECT count(*) FROM items").await;
        let orphans = |sql: &'static str| {
            let c = &c;
            async move { count(c, sql).await }
        };
        // A shrunk tracklist flags the track the release dropped.
        {
            let mut e = f.editions.lock().unwrap();
            let v = e.get_mut(RELEASE).unwrap();
            v["tracks"].as_array_mut().unwrap().pop();
        }
        sqlx::query("DELETE FROM metadata_snapshots")
            .execute(&c.st.db)
            .await
            .unwrap();
        meta::refresh(&c.st, m, Priority::Background).await.unwrap();
        assert_eq!(
            orphans(r#"SELECT count(*) FROM track_details WHERE "orphanedAt" IS NOT NULL"#).await,
            1
        );
        // The track comes back with the release.
        f.editions
            .lock()
            .unwrap()
            .insert(RELEASE.into(), edition_release(RELEASE, tracklist()));
        meta::refresh(&c.st, m, Priority::Background).await.unwrap();
        assert_eq!(
            orphans(r#"SELECT count(*) FROM track_details WHERE "orphanedAt" IS NOT NULL"#).await,
            0
        );
        // A release the group no longer lists is flagged.
        f.children.lock().unwrap().insert(
            GROUP.into(),
            vec![json!({"externalId": OTHER_RELEASE, "title": "Alpha"})],
        );
        meta::refresh(&c.st, m, Priority::Background).await.unwrap();
        assert_eq!(
            orphans(r#"SELECT count(*) FROM editions WHERE "orphanedAt" IS NOT NULL"#).await,
            1
        );
        // A 404 flags the album and removes nothing.
        f.works.lock().unwrap().clear();
        assert!(meta::refresh(&c.st, m, Priority::Background).await.unwrap());
        assert_eq!(
            orphans(r#"SELECT count(*) FROM album_details WHERE "orphanedAt" IS NOT NULL"#).await,
            1
        );
        assert_eq!(count(&c, "SELECT count(*) FROM items").await, items);
        assert_eq!(count(&c, "SELECT count(*) FROM editions").await, 1);
        // A merged id: the provider answers another id for the group; the old one becomes an alias.
        let mut w = provider()
            .works
            .lock()
            .unwrap()
            .get(GROUP)
            .cloned()
            .unwrap();
        w["externalId"] = json!(MERGED);
        f.works.lock().unwrap().insert(GROUP.into(), w);
        f.children.lock().unwrap().insert(MERGED.into(), vec![]);
        meta::refresh(&c.st, m, Priority::Background).await.unwrap();
        let live: String = sqlx::query_scalar(
            r#"SELECT value FROM media_external_ids WHERE "mediaId" = $1 AND provider = 'musicbrainz'"#,
        )
        .bind(m)
        .fetch_one(&c.st.db)
        .await
        .unwrap();
        assert_eq!(live, MERGED);
        for id in [GROUP, MERGED] {
            assert_eq!(
                crate::media::external_ids::find(
                    &c.st.db,
                    MediaKind::Album,
                    Namespace::MUSICBRAINZ,
                    id
                )
                .await
                .unwrap(),
                Some(m),
                "{id}"
            );
        }
        assert_eq!(
            meta::aliases::album_of(&c.st.db, GROUP).await.unwrap(),
            Some(m)
        );
        // The alias is never also a live id, and an alias that becomes live again is dropped.
        let moved = meta::aliases::redirect_album(&c.st, m, MERGED, GROUP)
            .await
            .unwrap();
        assert_eq!(moved.0, meta::aliases::Moved::Renamed);
        assert_eq!(
            count(
                &c,
                &format!("SELECT count(*) FROM media_external_id_aliases WHERE value = '{GROUP}'")
            )
            .await,
            0
        );
        assert_eq!(
            count(
                &c,
                &format!("SELECT count(*) FROM media_external_id_aliases WHERE value = '{MERGED}'")
            )
            .await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_album_folded_into_the_one_holding_the_merged_id_carries_its_files_and_aliases(
        pool: PgPool,
    ) {
        let f = provider();
        let c = ctx_music(pool, Some(f)).await;
        let l = album_lib(&c).await;
        let (a, b) = (album(&c, l, "A").await, album(&c, l, "B").await);
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![track("One", 1, 1, json!({})), track("Two", 2, 1, json!({}))],
        );
        for (m, rel) in [(b, "B/1.flac"), (a, "A/2.flac")] {
            music::register(&c.st, m, &place(&c, &[rel])).await.unwrap();
        }
        for (media, id) in [(a, MERGED), (b, GROUP)] {
            sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'album', 'musicbrainz', $2)"#)
                .bind(media)
                .bind(id)
                .execute(&c.st.db)
                .await
                .unwrap();
        }
        sqlx::query(r#"INSERT INTO media_external_id_aliases ("mediaId", kind, provider, value) VALUES ($1, 'album', 'musicbrainz', $2)"#)
            .bind(b)
            .bind("7c2a1d55-1b2c-4d3e-8f90-aabbccddeeff")
            .execute(&c.st.db)
            .await
            .unwrap();
        // B holds GROUP; the provider says A's id MERGED is now GROUP: A folds into B.
        let (moved, refs) = meta::aliases::redirect_album(&c.st, a, MERGED, GROUP)
            .await
            .unwrap();
        assert_eq!(moved, meta::aliases::Moved::Folded(b));
        drop(refs);
        assert_eq!(
            count(&c, &format!("SELECT count(*) FROM media WHERE id = {a}")).await,
            0
        );
        // The tracks of the absorbed album are the survivor's now.
        assert_eq!(
            count(
                &c,
                &format!(r#"SELECT count(*) FROM track_details WHERE "mediaId" = {b}"#)
            )
            .await,
            2
        );
        assert_eq!(
            meta::aliases::album_of(&c.st.db, MERGED).await.unwrap(),
            Some(b)
        );
        assert_eq!(
            meta::aliases::album_of(&c.st.db, "7c2a1d55-1b2c-4d3e-8f90-aabbccddeeff")
                .await
                .unwrap(),
            Some(b)
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_search_applies_a_close_release_and_offers_a_far_one_for_review(pool: PgPool) {
        let f = provider();
        f.found
            .lock()
            .unwrap()
            .push(json!({"externalId": GROUP, "title": "Alpha", "year": 1999,
            "artists": [{"name": "Ana"}], "mediaType": "album"}));
        let c = ctx_music(pool, Some(f.clone())).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                track("One", 1, 1, json!({})),
                track("Two", 2, 1, json!({})),
                track("Three", 1, 2, json!({})),
            ],
        );
        music::register(
            &c.st,
            m,
            &place(&c, &["Alpha/1.flac", "Alpha/2.flac", "Alpha/3.flac"]),
        )
        .await
        .unwrap();
        assert_eq!(
            identify::identify_media(&c.st, m).await.unwrap(),
            identify::Outcome::Applied
        );
        assert!(f.calls().iter().any(|c| c.starts_with("search ")));
        // Files of another album are not applied.
        let other = album(&c, l, "Other").await;
        let mismatch = |n: u32, t: &str| {
            ok(
                json!({"ok": true, "info": {"video": [], "audio": [], "subtitles": [], "durationSeconds": 200.0,
                "tags": {"title": t, "album": "Beta", "artist": "Zed", "track": n, "year": 1980}}}),
            )
        };
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![mismatch(1, "Nine"), mismatch(2, "Ten")],
        );
        music::register(&c.st, other, &place(&c, &["Other/1.flac", "Other/2.flac"]))
            .await
            .unwrap();
        let before = f.calls().len();
        assert_eq!(
            identify::identify_media(&c.st, other).await.unwrap(),
            identify::Outcome::Nothing
        );
        assert!(f.calls().len() >= before);
        assert_eq!(
            count(
                &c,
                &format!(r#"SELECT count(*) FROM media_external_ids WHERE "mediaId" = {other}"#)
            )
            .await,
            0
        );
    }

    #[sqlx::test(migrations = false)]
    async fn the_scan_lists_albums_by_folder_and_the_relink_creates_an_unmatched_one_from_the_tags(
        pool: PgPool,
    ) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![track(
                "One",
                1,
                1,
                json!({"musicbrainzReleaseGroupId": GROUP}),
            )],
        );
        for r in [
            "Ana/Alpha/CD1/01.flac",
            "Ana/Alpha/CD2/01.flac",
            "Ana/Beta/01.mp3",
            "Ana/Beta/cover.jpg",
        ] {
            touch(&c.dir.join("music").join(r), r.as_bytes());
        }
        let (s, b) = call(
            &c,
            "POST",
            &format!("/api/imports/library/{l}/orphans/scan"),
            &c.admin,
            Value::Null,
        )
        .await;
        assert_eq!(s, 201);
        let groups = b["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2, "{b}");
        let alpha = groups
            .iter()
            .find(|g| g["folderName"] == "Ana/Alpha")
            .unwrap();
        assert_eq!(alpha["mediaType"], "album");
        assert_eq!(alpha["files"].as_array().unwrap().len(), 2);
        assert_eq!(alpha["guessTitle"], "Alpha");
        assert_eq!(
            alpha["fileIds"],
            json!([{"provider": "musicbrainz", "externalId": GROUP}])
        );
        assert_eq!(b["orphanCount"], 3);
        let files: Vec<Value> = alpha["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| json!({"filePath": f["filePath"]}))
            .collect();
        let body =
            json!({"libraryId": l, "type": "album", "folderName": "Ana/Alpha", "files": files});
        let (s, r) = call(
            &c,
            "POST",
            "/api/imports/library/orphans/relink",
            &c.admin,
            body.clone(),
        )
        .await;
        assert_eq!(
            (s, r["created"].clone(), r["linked"].clone()),
            (201, json!(true), json!(2)),
            "{r}"
        );
        let m = r["mediaId"].as_i64().unwrap();
        let (title, folder, monitored): (String, String, bool) =
            sqlx::query_as(r#"SELECT title, "folderName", monitored FROM media WHERE id = $1"#)
                .bind(m as i32)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!(
            (title.as_str(), folder.as_str(), monitored),
            ("Alpha", "Ana/Alpha", false)
        );
        assert_eq!(count(&c, "SELECT count(*) FROM items").await, 2);
        // A second relink of the same folder finds the same album.
        let (_, again) = call(
            &c,
            "POST",
            "/api/imports/library/orphans/relink",
            &c.admin,
            body,
        )
        .await;
        assert_eq!(
            (again["mediaId"].as_i64().unwrap(), again["created"].clone()),
            (m, json!(false))
        );
        // A folder whose tags name a release group an album already holds joins that album.
        sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'album', 'musicbrainz', $2)"#)
            .bind(m as i32)
            .bind(GROUP)
            .execute(&c.st.db)
            .await
            .unwrap();
        let beta = c.dir.join("music/Ana/Beta/01.mp3");
        let body = json!({"libraryId": l, "type": "album", "folderName": "Ana/Beta", "files": [{"filePath": beta}]});
        let (_, joined) = call(
            &c,
            "POST",
            "/api/imports/library/orphans/relink",
            &c.admin,
            body,
        )
        .await;
        assert_eq!(
            (
                joined["mediaId"].as_i64().unwrap(),
                joined["created"].clone()
            ),
            (m, json!(false)),
            "{joined}"
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_library_of_books_keeps_mp3_as_books_and_a_library_of_albums_owns_audio(
        pool: PgPool,
    ) {
        let c = ctx_music(pool, None).await;
        let lib = c.dir.join("shared");
        for r in ["a.mp3", "b.wav", "c.epub"] {
            touch(&lib.join(r), b"x");
        }
        let mut out = vec![];
        super::super::disk::collect(&lib, 0, &[MediaKind::Album], &mut out);
        let names: Vec<String> = out
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["a.mp3", "b.wav"]);
        out.clear();
        super::super::disk::collect(&lib, 0, &[MediaKind::Album, MediaKind::Book], &mut out);
        let names: Vec<String> = out
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["a.mp3", "c.epub"]);
    }

    #[sqlx::test(migrations = false)]
    async fn an_album_is_imported_from_its_release_group_and_a_merged_id_the_caller_named_is_kept_as_an_alias(
        pool: PgPool,
    ) {
        let f = provider();
        let mut w = f.works.lock().unwrap().get(GROUP).cloned().unwrap();
        w["externalId"] = json!(MERGED);
        f.works.lock().unwrap().insert(GROUP.into(), w);
        f.children.lock().unwrap().insert(MERGED.into(), vec![]);
        let c = ctx_music(pool, Some(f)).await;
        let l = album_lib(&c).await;
        let body = json!({"type": "album", "provider": "musicbrainz", "externalId": GROUP, "libraryId": l});
        let (s, b) = call(&c, "POST", "/api/media/import", &c.admin, body.clone()).await;
        assert_eq!(s, 201, "{b}");
        let m = b["id"].as_i64().unwrap() as i32;
        assert_eq!(
            (b["title"].as_str(), b["type"].as_str()),
            (Some("Alpha (Provider)"), Some("album"))
        );
        assert_eq!(
            meta::aliases::album_of(&c.st.db, MERGED).await.unwrap(),
            Some(m)
        );
        assert_eq!(
            meta::aliases::album_of(&c.st.db, GROUP).await.unwrap(),
            Some(m)
        );
        assert_eq!(count(&c, "SELECT count(*) FROM album_details").await, 1);
        let (s, _) = call(&c, "POST", "/api/media/import", &c.admin, body).await;
        assert_eq!(s, 409);
        // Identifying another album against an id the first one holds is refused.
        let other = album(&c, l, "Other").await;
        let (s, _) = call(
            &c,
            "POST",
            &format!("/api/media/{other}/identify"),
            &c.admin,
            json!({"provider": "musicbrainz", "externalId": MERGED}),
        )
        .await;
        assert_eq!(s, 409);
        let (s, _) = call(
            &c,
            "POST",
            &format!("/api/media/{other}/identify"),
            &c.admin,
            json!({"tmdbId": 5}),
        )
        .await;
        assert_eq!(s, 400);
    }

    #[sqlx::test(migrations = false)]
    async fn a_merged_artist_keeps_its_row_and_its_old_id_as_an_alias(pool: PgPool) {
        let c = ctx_music(pool, None).await;
        let p: i32 =
            sqlx::query_scalar(r#"INSERT INTO persons (name) VALUES ('Ana') RETURNING id"#)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        sqlx::query(r#"INSERT INTO person_external_ids ("personId", provider, value) VALUES ($1, 'musicbrainz', $2)"#)
            .bind(p)
            .bind(ARTIST)
            .execute(&c.st.db)
            .await
            .unwrap();
        let moved = meta::aliases::redirect_person(&c.st.db, p, ARTIST, MERGED)
            .await
            .unwrap();
        assert_eq!(moved, meta::aliases::Moved::Renamed);
        assert_eq!(
            meta::aliases::person_of(&c.st.db, ARTIST).await.unwrap(),
            Some(p)
        );
        assert_eq!(
            meta::aliases::person_of(&c.st.db, MERGED).await.unwrap(),
            Some(p)
        );
        let live: String =
            sqlx::query_scalar(r#"SELECT value FROM person_external_ids WHERE "personId" = $1"#)
                .bind(p)
                .fetch_one(&c.st.db)
                .await
                .unwrap();
        assert_eq!(live, MERGED);
        // Another person holding the new id keeps it: nothing moves.
        let q: i32 = sqlx::query_scalar(r#"INSERT INTO persons (name) VALUES ('Bo') RETURNING id"#)
            .fetch_one(&c.st.db)
            .await
            .unwrap();
        sqlx::query(r#"INSERT INTO person_external_ids ("personId", provider, value) VALUES ($1, 'musicbrainz', $2)"#)
            .bind(q)
            .bind(GROUP)
            .execute(&c.st.db)
            .await
            .unwrap();
        assert_eq!(
            meta::aliases::redirect_person(&c.st.db, p, MERGED, GROUP)
                .await
                .unwrap(),
            meta::aliases::Moved::Folded(q)
        );
        // The search finds a person by its sort name.
        sqlx::query(r#"UPDATE persons SET "sortName" = 'Zzyzx, Ana' WHERE id = $1"#)
            .bind(p)
            .execute(&c.st.db)
            .await
            .unwrap();
        let (s, b) = call(
            &c,
            "GET",
            "/api/persons/search?q=zzyzx",
            &c.admin,
            Value::Null,
        )
        .await;
        assert_eq!((s, b[0]["name"].as_str()), (200, Some("Ana")));
    }

    #[sqlx::test(migrations = false)]
    async fn the_candidates_of_an_album_are_listed_without_applying_any(pool: PgPool) {
        let f = provider();
        f.found
            .lock()
            .unwrap()
            .push(json!({"externalId": GROUP, "title": "Alpha", "year": 1999,
            "artists": [{"name": "Ana"}], "mediaType": "album"}));
        let c = ctx_music(pool, Some(f)).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                track("One", 1, 1, json!({})),
                track("Two", 2, 1, json!({})),
                track("Three", 1, 2, json!({})),
            ],
        );
        music::register(
            &c.st,
            m,
            &place(&c, &["Alpha/1.flac", "Alpha/2.flac", "Alpha/3.flac"]),
        )
        .await
        .unwrap();
        let (s, b) = call(
            &c,
            "GET",
            &format!("/api/media/{m}/music/candidates"),
            &c.admin,
            Value::Null,
        )
        .await;
        assert_eq!(s, 200, "{b}");
        assert_eq!(
            (b[0]["group"].as_str(), b[0]["release"].as_str()),
            (Some(GROUP), Some(RELEASE))
        );
        assert!(b[0]["similarity"].as_f64().unwrap() > 0.9);
        assert_eq!(
            count(&c, "SELECT count(*) FROM media_external_ids").await,
            0
        );
        let book = media(&c, l, "NotAlbum", "book").await;
        let (s, _) = call(
            &c,
            "GET",
            &format!("/api/media/{book}/music/candidates"),
            &c.admin,
            Value::Null,
        )
        .await;
        assert_eq!(s, 400);
    }
    #[sqlx::test(migrations = false)]
    async fn an_album_is_never_folded_into_another_librarys(pool: PgPool) {
        let f = provider();
        f.found
            .lock()
            .unwrap()
            .push(json!({"externalId": GROUP, "title": "Alpha", "year": 1999,
            "artists": [{"name": "Ana"}], "mediaType": "album"}));
        let c = ctx_music(pool, Some(f)).await;
        let (l1, l2) = (
            album_lib(&c).await,
            library(&c, "Music 2", &c.dir.join("music2"), r#"["album"]"#).await,
        );
        let (a, b) = (album(&c, l1, "A").await, album(&c, l2, "B").await);
        for (media, id) in [(a, MERGED), (b, GROUP)] {
            sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'album', 'musicbrainz', $2)"#)
                .bind(media)
                .bind(id)
                .execute(&c.st.db)
                .await
                .unwrap();
        }
        let (moved, _) = meta::aliases::redirect_album(&c.st, a, MERGED, GROUP)
            .await
            .unwrap();
        assert_eq!(moved, meta::aliases::Moved::Elsewhere);
        assert_eq!(
            meta::aliases::album_of(&c.st.db, MERGED).await.unwrap(),
            Some(a)
        );
        // Files matched to a group the other library holds leave their album unidentified.
        let m = album(&c, l1, "Alpha").await;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                track("One", 1, 1, json!({})),
                track("Two", 2, 1, json!({})),
                track("Three", 1, 2, json!({})),
            ],
        );
        music::register(
            &c.st,
            m,
            &place(&c, &["Alpha/1.flac", "Alpha/2.flac", "Alpha/3.flac"]),
        )
        .await
        .unwrap();
        assert_eq!(
            identify::identify_media(&c.st, m).await.unwrap(),
            identify::Outcome::Nothing
        );
        assert_eq!(
            count(&c, "SELECT count(*) FROM media WHERE type = 'album'").await,
            3
        );
        assert_eq!(
            meta::aliases::album_of(&c.st.db, GROUP).await.unwrap(),
            Some(b)
        );
    }

    #[sqlx::test(migrations = false)]
    async fn a_release_the_found_group_does_not_list_falls_back_to_the_search(pool: PgPool) {
        let f = provider();
        f.found
            .lock()
            .unwrap()
            .push(json!({"externalId": GROUP, "title": "Alpha", "year": 1999,
            "artists": [{"name": "Ana"}], "mediaType": "album"}));
        let c = ctx_music(pool, Some(f.clone())).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        let ids = json!({"musicbrainzReleaseId": OTHER_RELEASE});
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                track("One", 1, 1, ids.clone()),
                track("Two", 2, 1, ids.clone()),
                track("Three", 1, 2, ids),
            ],
        );
        music::register(
            &c.st,
            m,
            &place(&c, &["Alpha/1.flac", "Alpha/2.flac", "Alpha/3.flac"]),
        )
        .await
        .unwrap();
        assert_eq!(
            identify::identify_media(&c.st, m).await.unwrap(),
            identify::Outcome::Applied
        );
        let calls = f.calls();
        assert!(
            !calls.contains(&format!("edition {OTHER_RELEASE}")),
            "{calls:?}"
        );
        assert!(calls.iter().any(|c| c == &format!("edition {RELEASE}")));
    }

    #[sqlx::test(migrations = false)]
    async fn a_manual_pick_matches_the_files_to_a_release(pool: PgPool) {
        let f = provider();
        f.found
            .lock()
            .unwrap()
            .push(json!({"externalId": GROUP, "title": "Alpha", "year": 1999,
            "artists": [{"name": "Ana"}], "mediaType": "album"}));
        let c = ctx_music(pool, Some(f)).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Alpha").await;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![
                track("One", 1, 1, json!({})),
                track("Two", 2, 1, json!({})),
                track("Three", 1, 2, json!({})),
            ],
        );
        music::register(
            &c.st,
            m,
            &place(&c, &["Alpha/1.flac", "Alpha/2.flac", "Alpha/3.flac"]),
        )
        .await
        .unwrap();
        // The client's flow: the candidates, then the chosen release group.
        let (s, cands) = call(
            &c,
            "GET",
            &format!("/api/media/{m}/music/candidates"),
            &c.admin,
            Value::Null,
        )
        .await;
        assert_eq!(s, 200, "{cands}");
        let (s, b) = call(
            &c,
            "POST",
            &format!("/api/media/{m}/identify"),
            &c.admin,
            json!({"provider": "musicbrainz", "externalId": cands[0]["group"]}),
        )
        .await;
        assert_eq!(s, 201, "{b}");
        let sql = r#"SELECT count(*) FROM track_details WHERE "releaseTrackMbid" IS NOT NULL"#;
        for _ in 0..100 {
            if count(&c, sql).await > 0 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert_eq!(count(&c, sql).await, 1);
        assert_eq!(
            count(
                &c,
                &format!("SELECT count(*) FROM edition_external_ids WHERE value = '{RELEASE}'")
            )
            .await,
            1
        );
    }

    #[sqlx::test(migrations = false)]
    async fn an_album_rescan_descends_only_into_disc_folders(pool: PgPool) {
        let c = ctx_music(pool, None).await;
        let l = album_lib(&c).await;
        let m = album(&c, l, "Ana/Alpha").await;
        c.fake.script(
            "POST",
            "/v1/probe",
            vec![track("One", 1, 1, json!({})), track("Two", 2, 1, json!({}))],
        );
        place(&c, &["Ana/Alpha/CD1/01.flac", "Ana/Alpha/Scans/02.flac"]);
        rescan(&c, m).await.unwrap();
        assert_eq!(
            count(
                &c,
                &format!(r#"SELECT count(*) FROM media_files WHERE "mediaId" = {m}"#)
            )
            .await,
            1
        );
    }
}

mod album_acquisition;

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
    crate::db::migrate(&pool).await.unwrap();
    let fake = Fake::start().await;
    fake.hello(Some(hello_body(&RUNTIME, "x")));
    fake.script("POST", "/v1/probe", vec![ok(probe_ok())]);
    let env = [
        ("FLIKS_ENGINE_URL", fake.url.clone()),
        ("FLIKS_ENGINE_TOKEN", "tok".into()),
    ];
    let cfg = Config::from_lookup(|k| env.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone()));
    let st = AppState::new(pool.clone(), cfg, SECRET);
    st.engine.start_with(Some(pool.clone()), 4849).await;
    let app = app::router(st.clone(), None, "/nonexistent".into(), None);
    let dir = tmp();
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

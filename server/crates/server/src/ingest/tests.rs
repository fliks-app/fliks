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
    sqlx::query_scalar(r#"INSERT INTO libraries (name, path, "mediaTypes") VALUES ($1, $2, $3::jsonb) RETURNING id"#)
        .bind(name)
        .bind(path.to_string_lossy().as_ref())
        .bind(types)
        .fetch_one(&c.st.db)
        .await
        .unwrap()
}

async fn media(c: &Ctx, lib: i32, folder: &str, t: &str) -> i32 {
    sqlx::query_scalar(r#"INSERT INTO media (title, type, "libraryId", "folderName") VALUES ($1, $2::text::media_type_enum, $3, $1) RETURNING id"#)
        .bind(folder)
        .bind(t)
        .bind(lib)
        .fetch_one(&c.st.db)
        .await
        .unwrap()
}

async fn file_row(c: &Ctx, m: i32, rel: &str) -> i32 {
    sqlx::query_scalar(r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality) VALUES ($1, $2, 1, 'x') RETURNING id"#)
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
        let f = file_row(&c, a, rel).await;
        let (s, _) = call(
            &c,
            "DELETE",
            &format!("/api/media/{a}/files/{f}?deleteOnDisk=true"),
            &c.admin,
            json!({}),
        )
        .await;
        assert_eq!(s, 400, "{rel}");
    }
    assert!(c.dir.join("victim.mkv").exists());
    assert_eq!(count(&c, "SELECT count(*) FROM media_files").await, 3);
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
    assert_eq!(rows, ["Season 01/Show - S01E02.mkv"]);
    assert_eq!(
        count(&c, r#"SELECT count(*) FROM episodes WHERE "hasFile""#).await,
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
    let sp: i32 = sqlx::query_scalar(r#"INSERT INTO seasons ("mediaId", "seasonNumber", monitored) VALUES ($1, 0, false) RETURNING id"#)
        .bind(s).fetch_one(&c.st.db).await.unwrap();
    let special: i32 = sqlx::query_scalar(r#"INSERT INTO episodes ("seasonId", "episodeNumber", title, monitored) VALUES ($1, 1, 'Making Of', true) RETURNING id"#)
        .bind(sp).fetch_one(&c.st.db).await.unwrap();
    touch(&lib.join("Show/Making Of.mkv"), b"m");
    let r = rescan(&c, s).await.unwrap();
    assert_eq!((r.added, r.removed), (3, 1));
    let has: Vec<(i32, i32, Option<i32>, bool)> = sqlx::query_as(
        r#"SELECT s."seasonNumber", e."episodeNumber", e."endEpisodeNumber", e."hasFile"
           FROM episodes e JOIN seasons s ON s.id = e."seasonId" WHERE s."mediaId" = $1
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
            &format!(r#"SELECT count("episodeId") FROM media_files WHERE id = {unlinked}"#)
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &c,
            &format!(r#"SELECT count(*) FROM media_files WHERE "episodeId" = {special}"#)
        )
        .await,
        1
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
        (first.updated, probes(&c)),
        (1, 2),
        "unstamped row: probe + embedded detection"
    );
    let second = rescan(&c, a).await.unwrap();
    assert_eq!(
        (second.updated, probes(&c)),
        (0, 2),
        "stamped and unchanged: no probe"
    );
    sqlx::query(r#"UPDATE media_files SET "mtimeMs" = 0"#)
        .execute(&c.st.db)
        .await
        .unwrap();
    let third = rescan(&c, a).await.unwrap();
    assert_eq!(
        (third.updated, probes(&c)),
        (1, 4),
        "a moved mtime probes again"
    );
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
    sqlx::query(r#"UPDATE media SET "tmdbId" = 77 WHERE id = $1"#)
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

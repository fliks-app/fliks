//! The comic page routes (`docs/spec/comics.md`, pages rules) on synthetic archives built here.
use axum::{Router, body::Body, http::Request};
use fliks_server::{comics, config::Config, state::AppState};
use serde_json::Value;
use sqlx::PgPool;
use std::{io::Write, path::PathBuf};
use tower::ServiceExt;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const SECRET: &str = "0123456789abcdef0123456789abcdef";

fn png(w: u32, h: u32) -> Vec<u8> {
    let mut out = vec![];
    image::RgbImage::new(w, h)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

fn cbz(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut w = ZipWriter::new(std::io::Cursor::new(vec![]));
    let o = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for (n, b) in entries {
        w.start_file(*n, o).unwrap();
        w.write_all(b).unwrap();
    }
    w.finish().unwrap().into_inner()
}

struct Dir(PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

struct Ctx {
    app: Router,
    admin: String,
    plain: String,
    stream: String,
    bound1: String,
    bound2: String,
    _dir: Dir,
}

struct Res {
    status: u16,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Res {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn header(&self, n: &str) -> &str {
        self.headers
            .get(n)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }
}

/// Issues: 1 a three page cbz, 2 its twin in a hidden edition, 3 a pdf, 4 a corrupt archive, 5 a text file named `.png`.
async fn ctx(pool: PgPool, tag: &str) -> Ctx {
    // 7z and RAR are read by a child of the server binary, as in production.
    #[cfg(target_os = "linux")]
    comics::sandbox::set_exe(PathBuf::from(env!("CARGO_BIN_EXE_fliks-server")));
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let dir =
        Dir(std::env::temp_dir().join(format!("fliks-comics-it-{}-{tag}", std::process::id())));
    let (one, two) = (dir.0.join("one"), dir.0.join("two"));
    std::fs::create_dir_all(&one).unwrap();
    std::fs::create_dir_all(&two).unwrap();
    let pages = cbz(&[
        ("p10.png", png(32, 48)),
        ("p2.png", png(16, 24)),
        ("p1.png", png(8, 12)),
    ]);
    std::fs::write(one.join("a.cbz"), &pages).unwrap();
    std::fs::write(two.join("b.cbz"), &pages).unwrap();
    std::fs::write(one.join("c.pdf"), b"%PDF-1.4").unwrap();
    std::fs::write(one.join("d.cbz"), b"PK\x03\x04broken").unwrap();
    std::fs::write(
        one.join("e.cbz"),
        cbz(&[("p1.png", b"<html><script>x()</script></html>".to_vec())]),
    )
    .unwrap();
    #[cfg(target_os = "linux")]
    {
        use libarchive2::{ArchiveFormat, WriteArchive};
        let mut w = WriteArchive::new()
            .format(ArchiveFormat::SevenZip)
            .open_file(one.join("f.cb7"))
            .unwrap();
        for (n, b) in [("p2.png", png(16, 24)), ("p1.png", png(8, 12))] {
            w.add_file(n, &b).unwrap();
        }
        w.finish().unwrap();
    }
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'plain', false, 1);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'L1', '["comic"]'), (2, 'L2', '["comic"]');
        INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '{one}'), (2, 2, '{two}');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2);
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES
          (10, 'Alpha', 'comic', 1, ''), (11, 'Beta', 'comic', 1, ''), (12, 'Gamma', 'comic', 1, ''), (13, 'Delta', 'comic', 1, '');
        INSERT INTO editions (id, "mediaId", family, format, "libraryId") VALUES
          (1, 10, 'image', 'cbz', NULL), (2, 11, 'image', 'cbz', 2), (3, 12, 'image', NULL, NULL), (4, 13, 'image', 'cb7', NULL);
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 10, 1), (2, 11, 2), (3, 12, 3), (4, 12, 3), (5, 12, 3), (6, 13, 4);
        INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label) VALUES
          (1, 10, 'issue', 1, '1'), (2, 11, 'issue', 1, '1'), (3, 12, 'issue', 1, '1'), (4, 12, 'issue', 2, '2'), (5, 12, 'issue', 3, '3'), (6, 13, 'issue', 1, '1');
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality) VALUES
          (1, 10, 1, 'a.cbz', 1, 'cbz'), (2, 11, 2, 'b.cbz', 1, 'cbz'), (3, 12, 1, 'c.pdf', 1, 'pdf'),
          (4, 12, 1, 'd.cbz', 1, 'cbz'), (5, 12, 1, 'e.cbz', 1, 'cbz'), (6, 13, 1, 'f.cb7', 1, 'cb7');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (2, 2, 11, 0, 0), (3, 3, 12, 0, 0), (4, 4, 12, 0, 0), (5, 5, 12, 0, 0), (6, 6, 13, 0, 0);
        "#,
        one = one.display(),
        two = two.display()
    )))
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        admin: st.jwt.sign_access(1, "admin").unwrap().token,
        plain: st.jwt.sign_access(2, "plain").unwrap().token,
        stream: st.jwt.sign_stream(2, "plain").unwrap().token,
        bound1: st.jwt.sign_stream_for(2, "plain", 1).unwrap().token,
        bound2: st.jwt.sign_stream_for(2, "plain", 2).unwrap().token,
        app: comics::router().with_state(st),
        _dir: dir,
    }
}

impl Ctx {
    async fn get(&self, token: Option<&str>, uri: &str, extra: &[(&str, &str)]) -> Res {
        let mut req = Request::builder().uri(uri);
        if let Some(t) = token {
            req = req.header("authorization", format!("Bearer {t}"));
        }
        for (k, v) in extra {
            req = req.header(*k, *v);
        }
        let res = self
            .app
            .clone()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        Res {
            status: res.status().as_u16(),
            headers: res.headers().clone(),
            body: axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        }
    }
}

#[sqlx::test(migrations = false)]
async fn the_list_gives_sizes_in_reading_order(pool: PgPool) {
    let c = ctx(pool, "list").await;
    let r = c.get(Some(&c.admin), "/api/comics/1/pages", &[]).await;
    assert_eq!(r.status, 200);
    let sizes: Vec<(u64, u64)> = r.json()["pages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["width"].as_u64().unwrap(), p["height"].as_u64().unwrap()))
        .collect();
    assert_eq!(sizes, [(8, 12), (16, 24), (32, 48)]);
    let etag = r.header("etag").to_owned();
    let again = c
        .get(
            Some(&c.admin),
            "/api/comics/1/pages",
            &[("if-none-match", &etag)],
        )
        .await;
    assert_eq!(again.status, 304);
}

#[sqlx::test(migrations = false)]
async fn a_page_is_the_original_or_a_downscaled_jpeg(pool: PgPool) {
    let c = ctx(pool, "page").await;
    let r = c.get(Some(&c.admin), "/api/comics/1/pages/1", &[]).await;
    assert_eq!((r.status, r.header("content-type")), (200, "image/png"));
    assert_eq!(r.body, png(16, 24));
    assert_eq!(r.header("x-content-type-options"), "nosniff");
    assert_eq!(r.header("cache-control"), "private, no-cache");
    let small = c
        .get(Some(&c.admin), "/api/comics/1/pages/2?width=16", &[])
        .await;
    assert_eq!(
        (small.status, small.header("content-type")),
        (200, "image/jpeg")
    );
    let img = image::load_from_memory(&small.body).unwrap();
    // widths snap up to the next 256 px step and a page is never upscaled
    assert_eq!((img.width(), img.height()), (32, 48));
    let never_up = c
        .get(Some(&c.admin), "/api/comics/1/pages/0?width=512", &[])
        .await;
    assert_eq!(image::load_from_memory(&never_up.body).unwrap().width(), 8);
    let etag = r.header("etag").to_owned();
    let cached = c
        .get(
            Some(&c.admin),
            "/api/comics/1/pages/1",
            &[("if-none-match", &etag)],
        )
        .await;
    assert_eq!(cached.status, 304);
    assert_eq!(
        c.get(Some(&c.admin), "/api/comics/1/pages/3", &[])
            .await
            .status,
        404
    );
    assert_eq!(
        c.get(Some(&c.admin), "/api/comics/1/pages/-1", &[])
            .await
            .status,
        404
    );
    assert_eq!(
        c.get(Some(&c.admin), "/api/comics/1/pages/0?width=0", &[])
            .await
            .status,
        400
    );
    assert_eq!(
        c.get(Some(&c.admin), "/api/comics/1/pages/0?width=99999", &[])
            .await
            .status,
        400
    );
}

#[sqlx::test(migrations = false)]
async fn access_follows_the_epub_reader_rules(pool: PgPool) {
    let c = ctx(pool, "acl").await;
    assert_eq!(c.get(None, "/api/comics/1/pages", &[]).await.status, 401);
    assert_eq!(
        c.get(Some(&c.plain), "/api/comics/1/pages", &[])
            .await
            .status,
        200
    );
    // hidden edition and unknown item read alike
    assert_eq!(
        c.get(Some(&c.plain), "/api/comics/2/pages", &[])
            .await
            .status,
        404
    );
    assert_eq!(
        c.get(Some(&c.plain), "/api/comics/999/pages", &[])
            .await
            .status,
        404
    );
    // the playback token rides in the query, bound to the file it reads
    let uri = format!("/api/comics/1/pages/0?token={}", c.bound1);
    assert_eq!(c.get(None, &uri, &[]).await.status, 200);
    let uri = format!("/api/comics/1/pages?token={}", c.bound2);
    assert_eq!(c.get(None, &uri, &[]).await.status, 404);
    let uri = format!("/api/comics/2/pages/0?token={}", c.bound2);
    assert_eq!(c.get(None, &uri, &[]).await.status, 404);
    let uri = format!("/api/comics/1/pages/0?token={}", c.stream);
    assert_eq!(c.get(None, &uri, &[]).await.status, 401);
}

#[sqlx::test(migrations = false)]
async fn a_pdf_a_corrupt_archive_and_a_fake_image_answer_errors(pool: PgPool) {
    let c = ctx(pool, "errors").await;
    let pdf = c.get(Some(&c.admin), "/api/comics/3/pages", &[]).await;
    assert_eq!(pdf.status, 404);
    assert_eq!(pdf.json()["message"], "Issue #3 is a PDF");
    assert_eq!(
        c.get(Some(&c.admin), "/api/comics/4/pages", &[])
            .await
            .status,
        422
    );
    assert_eq!(
        c.get(Some(&c.admin), "/api/comics/5/pages/0", &[])
            .await
            .status,
        422
    );
}

#[cfg(target_os = "linux")]
#[sqlx::test(migrations = false)]
async fn a_7z_serves_pages_in_reading_order_from_one_decode(pool: PgPool) {
    let c = ctx(pool, "seven").await;
    let r = c.get(Some(&c.admin), "/api/comics/6/pages", &[]).await;
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    assert_eq!(r.json()["pages"][0]["width"], 8);
    for _ in 0..2 {
        let p = c.get(Some(&c.admin), "/api/comics/6/pages/1", &[]).await;
        assert_eq!((p.status, p.body), (200, png(16, 24)));
    }
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for b in data {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & 0u32.wrapping_sub(crc & 1));
        }
    }
    !crc
}

fn rss_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|v| v.trim().trim_end_matches("kB").trim().parse().ok())
        .unwrap_or(0)
}

/// A few bytes of 7z whose header asks libarchive for `files` entries (72 bytes each) before any is read.
#[cfg(target_os = "linux")]
#[sqlx::test(migrations = false)]
async fn a_7z_header_asking_for_gigabytes_dies_in_the_child(pool: PgPool) {
    let _c = ctx(pool, "numfiles").await;
    let dir = Dir(std::env::temp_dir().join(format!("fliks-comics-bomb-{}", std::process::id())));
    std::fs::create_dir_all(&dir.0).unwrap();
    let mut header = vec![0x01, 0x05, 0xFF];
    header.extend(50_000_000u64.to_le_bytes());
    let mut start = 0u64.to_le_bytes().to_vec();
    start.extend((header.len() as u64).to_le_bytes());
    start.extend(crc32(&header).to_le_bytes());
    let mut file = b"7z\xBC\xAF\x27\x1C\x00\x04".to_vec();
    file.extend(crc32(&start).to_le_bytes());
    file.extend(&start);
    file.extend(&header);
    let p = dir.0.join("bomb.cb7");
    std::fs::write(&p, &file).unwrap();
    let before = rss_kb();
    let out = comics::archive::page_count(&p);
    assert!(out.is_err(), "{out:?}");
    assert!(
        rss_kb() < before + 200 * 1024,
        "the parent grew by {} kB",
        rss_kb() - before
    );
}

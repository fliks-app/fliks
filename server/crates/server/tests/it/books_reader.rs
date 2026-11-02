//! The EPUB reader routes (`docs/spec/books-reader.md`): manifest, positions and sanitised resources, on
//! synthetic EPUBs built here.
use axum::{Router, body::Body, http::Request};
use fliks_server::{books, config::Config, state::AppState};
use serde_json::Value;
use sqlx::PgPool;
use std::{io::Write, path::PathBuf};
use tower::ServiceExt;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const SECRET: &str = "0123456789abcdef0123456789abcdef";

fn epub(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut w = ZipWriter::new(std::io::Cursor::new(vec![]));
    let o = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (n, b) in entries {
        w.start_file(*n, o).unwrap();
        w.write_all(b).unwrap();
    }
    w.finish().unwrap().into_inner()
}

const CONTAINER: &str = r#"<?xml version="1.0"?><container><rootfiles>
  <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#;

const HOSTILE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title><script>steal()</script>
<meta http-equiv="refresh" content="0;url=http://evil.example/"/><script src="evil.js"/></head>
<body onload="steal()"><p onclick="steal()">Aldric &amp; Mirelune</p><img src="img.png" onerror="steal()"/>
<iframe src="javascript:steal()"/><object data="x.svg"/><form action="/x"/><a href="javascript:steal()">x</a>
<a href="ch2.xhtml">next</a></body></html>"#;

fn opf(extra_manifest: &str, direction: &str, layout: &str) -> Vec<u8> {
    format!(
        r##"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>Le Phare des Brumes</dc:title><dc:creator>Aldric Vexmoor</dc:creator><dc:language>fr</dc:language>
  <dc:identifier id="u">urn:uuid:0b6c1a52-0000-4000-8000-000000000001</dc:identifier>{layout}</metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c3" href="ch%203.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="img" href="img.png" media-type="image/png"/>
    <item id="svg" href="evil.svg" media-type="image/svg+xml"/>
    <item id="js" href="script.js" media-type="text/javascript"/>
    <item id="remote" href="https://evil.example/a.png" media-type="image/png"/>
    <item id="ghost" href="ghost.xhtml" media-type="application/xhtml+xml"/>
    <item id="up" href="../../OEBPS/../../../secret.png" media-type="image/png"/>
    {extra_manifest}
  </manifest>
  <spine {direction}><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/><itemref idref="ghost"/></spine></package>"##
    )
    .into_bytes()
}

const NAV: &str = r#"<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>
  <li><a href="ch1.xhtml">Chapter One</a><ol><li><a href="ch1.xhtml#s1">Section</a></li></ol></li>
  <li><a href="ch2.xhtml">Chapter Two</a></li><li><a href="https://evil.example/">Away</a></li>
  <li><a href="missing.xhtml">Gone</a></li></ol></nav></body></html>"#;

fn book(extra: &[(&str, Vec<u8>)], extra_manifest: &str, direction: &str, layout: &str) -> Vec<u8> {
    let plain = "<html><head/><body><p>text</p></body></html>";
    let mut entries: Vec<(&str, Vec<u8>)> = vec![
        ("mimetype", b"application/epub+zip".to_vec()),
        ("META-INF/container.xml", CONTAINER.into()),
        ("OEBPS/content.opf", opf(extra_manifest, direction, layout)),
        ("OEBPS/nav.xhtml", NAV.into()),
        ("OEBPS/ch1.xhtml", HOSTILE.into()),
        ("OEBPS/ch2.xhtml", plain.into()),
        ("OEBPS/ch 3.xhtml", plain.into()),
        ("OEBPS/style.css", b"p { color: red }".to_vec()),
        ("OEBPS/img.png", b"\x89PNG\r\n\x1a\nxxxx".to_vec()),
        ("OEBPS/evil.svg", br#"<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script><rect/></svg>"#.to_vec()),
        ("OEBPS/script.js", b"steal()".to_vec()),
        ("OEBPS/secret.txt", b"not in the manifest".to_vec()),
    ];
    entries.extend(extra.iter().map(|(n, b)| (*n, b.clone())));
    epub(&entries)
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
    noperm: String,
    _dir: Dir,
}

/// Library 1 is readable by `plain`, library 2 is not. Items: 1 the book, 2 its twin in a hidden edition,
/// 3 a book of library 2, 4 a PDF, 5 a fixed layout book, 6 an oversize book, 7 an audio item.
async fn ctx(pool: PgPool, tag: &str, big: &[(&str, Vec<u8>)], big_manifest: &str) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let dir = Dir(std::env::temp_dir().join(format!("fliks-reader-{}-{tag}", std::process::id())));
    let (one, two) = (dir.0.join("one"), dir.0.join("two"));
    std::fs::create_dir_all(&one).unwrap();
    std::fs::create_dir_all(&two).unwrap();
    let fixed = r#"<meta property="rendition:layout">pre-paginated</meta>"#;
    let files = [
        (&one, "a.epub", book(&[], "", "", "")),
        (&one, "b.epub", book(&[], "", "", "")),
        (&two, "c.epub", book(&[], "", "", "")),
        (&one, "d.pdf", b"%PDF".to_vec()),
        (
            &one,
            "e.epub",
            book(&[], "", r#"page-progression-direction="rtl""#, fixed),
        ),
        (&one, "f.epub", book(big, big_manifest, "", "")),
    ];
    for (d, n, b) in files {
        std::fs::write(d.join(n), b).unwrap();
    }
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false), (2, 'None', '[]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'plain', false, 1), (3, 'noperm', false, 2);
        INSERT INTO libraries (id, name) VALUES (1, 'L1'), (2, 'L2');
        INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '{one}'), (2, 2, '{two}');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2), (1, 3);
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES
          (10, 'Alpha', 'book', 1, 'a'), (11, 'Beta', 'book', 1, 'b'), (12, 'Gamma', 'book', 2, 'c'),
          (13, 'Delta', 'book', 1, 'd'), (14, 'Fixed', 'book', 1, 'e'), (15, 'Big', 'book', 1, 'f');
        INSERT INTO editions (id, "mediaId", family, format, "libraryId") VALUES
          (1, 10, 'text', 'epub', NULL), (2, 11, 'text', 'epub', 2), (3, 12, 'text', 'epub', NULL),
          (4, 13, 'text', 'pdf', NULL), (5, 14, 'text', 'epub', NULL), (6, 15, 'text', 'epub', NULL),
          (7, 10, 'audio', 'm4b', NULL);
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 10, 1), (2, 11, 2), (3, 12, 3), (4, 13, 4), (5, 14, 5), (6, 15, 6), (7, 10, 7);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, 'a.epub', 1, 'EPUB', '{{}}'), (2, 11, 1, 'b.epub', 1, 'EPUB', '{{}}'), (3, 12, 2, 'c.epub', 1, 'EPUB', '{{}}'),
          (4, 13, 1, 'd.pdf', 1, 'PDF', '{{}}'), (5, 14, 1, 'e.epub', 1, 'EPUB', '{{}}'), (6, 15, 1, 'f.epub', 1, 'EPUB', '{{}}'),
          (7, 10, 1, 'a.m4b', 1, 'M4B', '{{}}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (2, 2, 11, 0, 0), (3, 3, 12, 0, 0), (4, 4, 13, 0, 0), (5, 5, 14, 0, 0), (6, 6, 15, 0, 0), (7, 7, 10, 0, 0);
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
        noperm: st.jwt.sign_access(3, "noperm").unwrap().token,
        app: books::router().with_state(st),
        _dir: dir,
    }
}

struct Res {
    status: u16,
    headers: axum::http::HeaderMap,
    body: Vec<u8>,
}

impl Res {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    fn header(&self, name: &str) -> &str {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }
}

impl Ctx {
    async fn get(&self, token: &str, uri: &str) -> Res {
        let req = Request::builder()
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        Res {
            status: res.status().as_u16(),
            headers: res.headers().clone(),
            body: axum::body::to_bytes(res.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        }
    }

    async fn pub_(&self, item: i32, path: &str) -> Res {
        self.get(&self.admin, &format!("/api/books/{item}/pub/{path}"))
            .await
    }
}

fn assert_hardened(r: &Res, what: &str) {
    assert!(
        r.header("content-security-policy")
            .contains("script-src 'none'"),
        "{what}"
    );
    assert!(
        r.header("content-security-policy").ends_with("sandbox"),
        "{what}"
    );
    assert_eq!(r.header("x-content-type-options"), "nosniff", "{what}");
    assert_eq!(
        r.header("cross-origin-resource-policy"),
        "same-origin",
        "{what}"
    );
}

#[sqlx::test(migrations = false)]
async fn manifest_follows_the_package(pool: PgPool) {
    let c = ctx(pool, "manifest", &[], "").await;
    let r = c.pub_(1, "manifest.json").await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(r.header("content-type"), "application/webpub+json");
    assert_hardened(&r, "manifest");
    let m = r.json();
    assert_eq!(m["metadata"]["title"], "Le Phare des Brumes");
    assert_eq!(
        m["metadata"]["identifier"],
        "urn:uuid:0b6c1a52-0000-4000-8000-000000000001"
    );
    assert_eq!(m["metadata"]["language"][0], "fr");
    assert_eq!(m["metadata"]["author"][0], "Aldric Vexmoor");
    assert!(
        m["metadata"].get("layout").is_none() && m["metadata"].get("readingProgression").is_none()
    );
    assert_eq!(m["links"][0]["href"], "/api/books/1/pub/manifest.json");
    assert_eq!(
        m["links"][1]["rel"],
        "http://readium.org/restricted/positions"
    );
    let hrefs = |k: &str| -> Vec<String> {
        m[k].as_array()
            .unwrap()
            .iter()
            .map(|l| l["href"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(
        hrefs("readingOrder"),
        ["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml", "OEBPS/ch%203.xhtml"]
    );
    assert_eq!(m["readingOrder"][0]["title"], "Chapter One");
    assert_eq!(m["readingOrder"][0]["type"], "application/xhtml+xml");
    // the script, the remote item, the missing entries and the escaping `..` are not listed
    let mut res = hrefs("resources");
    res.sort();
    assert_eq!(
        res,
        [
            "OEBPS/evil.svg",
            "OEBPS/img.png",
            "OEBPS/nav.xhtml",
            "OEBPS/style.css"
        ]
    );
    let toc = m["toc"].as_array().unwrap();
    assert_eq!(toc.len(), 2, "{toc:?}");
    assert_eq!(toc[0]["children"][0]["href"], "OEBPS/ch1.xhtml#s1");
}

#[sqlx::test(migrations = false)]
async fn fixed_layout_and_direction(pool: PgPool) {
    let c = ctx(pool, "fixed", &[], "").await;
    let m = c.pub_(5, "manifest.json").await.json();
    assert_eq!(m["metadata"]["layout"], "fixed");
    assert_eq!(m["metadata"]["readingProgression"], "rtl");
    let p = c.pub_(5, "positions.json").await.json();
    assert_eq!(p["total"], 3);
    assert_eq!(p["positions"][2]["locations"]["position"], 3);
}

#[sqlx::test(migrations = false)]
async fn positions_count_one_per_kilobyte(pool: PgPool) {
    let c = ctx(pool, "positions", &[], "").await;
    let r = c.pub_(1, "positions.json").await;
    assert_eq!(r.status, 200);
    assert_eq!(
        r.header("content-type"),
        "application/vnd.readium.position-list+json"
    );
    assert_hardened(&r, "positions");
    let p = r.json();
    let list = p["positions"].as_array().unwrap();
    // ch1 is the hostile 2 chapter-sized file, the two others are one position each
    let ch1 = list
        .iter()
        .filter(|x| x["href"] == "OEBPS/ch1.xhtml")
        .count() as u64;
    assert_eq!(ch1, (HOSTILE.len() as u64).div_ceil(1024).max(1));
    assert_eq!(p["total"].as_u64().unwrap(), ch1 + 2);
    assert_eq!(list[0]["locations"]["position"], 1);
    assert_eq!(list[0]["locations"]["totalProgression"], 0.0);
    assert_eq!(list.last().unwrap()["href"], "OEBPS/ch%203.xhtml");
}

#[sqlx::test(migrations = false)]
async fn resources_are_sanitised_and_hardened(pool: PgPool) {
    let c = ctx(pool, "sanitise", &[], "").await;
    let r = c.pub_(1, "OEBPS/ch1.xhtml").await;
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(
        r.header("content-type"),
        "application/xhtml+xml; charset=utf-8"
    );
    assert_hardened(&r, "xhtml");
    let t = r.text();
    for bad in [
        "steal",
        "<script",
        "evil.js",
        "onload",
        "onclick",
        "onerror",
        "<iframe",
        "<object",
        "<form",
        "refresh",
        "javascript:",
    ] {
        assert!(!t.contains(bad), "{bad} survived: {t}");
    }
    assert!(t.contains("Aldric &amp; Mirelune") && t.contains(r#"href="ch2.xhtml""#));
    assert!(
        t.contains("<head><meta http-equiv=\"Content-Security-Policy\""),
        "{t}"
    );

    let svg = c.pub_(1, "OEBPS/evil.svg").await;
    assert_eq!(svg.header("content-type"), "image/svg+xml; charset=utf-8");
    assert_hardened(&svg, "svg");
    assert!(
        !svg.text().contains("script")
            && !svg.text().contains("onload")
            && svg.text().contains("<rect/>")
    );

    let css = c.pub_(1, "OEBPS/style.css").await;
    assert_eq!(
        (css.status, css.header("content-type"), css.text().as_str()),
        (200, "text/css", "p { color: red }")
    );
    assert_hardened(&css, "css");
    let png = c.pub_(1, "OEBPS/img.png").await;
    assert_eq!((png.status, png.header("content-type")), (200, "image/png"));
    assert_eq!(png.body, b"\x89PNG\r\n\x1a\nxxxx");
    assert_hardened(&png, "png");
    // the manifest's percent-encoded href reads back
    assert_eq!(c.pub_(1, "OEBPS/ch%203.xhtml").await.status, 200);
}

#[sqlx::test(migrations = false)]
async fn only_manifest_resources_are_served(pool: PgPool) {
    let c = ctx(pool, "refusals", &[], "").await;
    for path in [
        "OEBPS/script.js",  // JavaScript is never served
        "OEBPS/secret.txt", // in the archive, not in the manifest
        "OEBPS/content.opf",
        "META-INF/container.xml",
        "mimetype",
        "OEBPS/ghost.xhtml", // in the manifest, not in the archive
        "OEBPS/missing.png",
        "https://evil.example/a.png", // an item with a URL scheme
        "../META-INF/container.xml",  // traversal
        "OEBPS/../META-INF/container.xml",
        "OEBPS/%2e%2e/OEBPS/ch2.xhtml",
        "%2e%2e/%2e%2e/etc/passwd",
        "OEBPS/./ch2.xhtml",
        "OEBPS//ch2.xhtml",
        "/etc/passwd", // absolute
        "OEBPS%2Fch2.xhtml/..",
        "OEBPS\\ch2.xhtml",
        "OEBPS%5Cch2.xhtml",
        "OEBPS/ch2.xhtml%00",
        "OEBPS/",
        "secret.png", // the manifest's `..` clamps to the root
        "etc/passwd",
    ] {
        let r = c.pub_(1, path).await;
        assert_eq!(r.status, 404, "{path}: {}", r.text());
    }
}

#[sqlx::test(migrations = false)]
async fn oversize_and_malformed_resources_are_refused(pool: PgPool) {
    let huge_xhtml = format!(
        "<html><head/><body>{}</body></html>",
        " ".repeat(9 * 1024 * 1024)
    );
    let extra = [
        ("OEBPS/big.png", vec![0u8; 33 * 1024 * 1024]),
        ("OEBPS/huge.xhtml", huge_xhtml.into_bytes()),
        ("OEBPS/bad.xhtml", b"<html><body><p></body></html>".to_vec()),
        ("OEBPS/utf16.xhtml", b"\xFF\xFE<\0h\0/\0>\0".to_vec()),
        ("OEBPS/ok.png", vec![0u8; 1024 * 1024]),
    ];
    let manifest = r#"<item id="big" href="big.png" media-type="image/png"/>
        <item id="huge" href="huge.xhtml" media-type="application/xhtml+xml"/>
        <item id="bad" href="bad.xhtml" media-type="application/xhtml+xml"/>
        <item id="u16" href="utf16.xhtml" media-type="application/xhtml+xml"/>
        <item id="ok" href="ok.png" media-type="image/png"/>"#;
    let c = ctx(pool, "oversize", &extra, manifest).await;
    let r = c.pub_(6, "OEBPS/big.png").await;
    assert_eq!(r.status, 413, "{}", r.text());
    assert_eq!(c.pub_(6, "OEBPS/huge.xhtml").await.status, 413);
    assert_eq!(c.pub_(6, "OEBPS/bad.xhtml").await.status, 422);
    assert_eq!(c.pub_(6, "OEBPS/utf16.xhtml").await.status, 422);
    assert_eq!(c.pub_(6, "OEBPS/ok.png").await.body.len(), 1024 * 1024);
}

#[sqlx::test(migrations = false)]
async fn a_hidden_edition_answers_like_a_missing_item(pool: PgPool) {
    let c = ctx(pool, "acl", &[], "").await;
    let uris = |item: i32| {
        ["manifest.json", "positions.json", "OEBPS/ch2.xhtml"]
            .map(|p| format!("/api/books/{item}/pub/{p}"))
    };
    // item 2: its edition sits in library 2; item 3: its media does; 4: no EPUB part; 7: audio; 99: none
    for item in [2, 3, 4, 7, 99] {
        for uri in uris(item) {
            let r = c.get(&c.plain, &uri).await;
            assert_eq!(r.status, 404, "{uri}");
            assert_eq!(
                r.json()["message"],
                format!("Item #{item} not found"),
                "{uri}"
            );
        }
    }
    for item in [2, 3] {
        assert_eq!(c.get(&c.admin, &uris(item)[0]).await.status, 200);
    }
    for uri in uris(1) {
        assert_eq!(c.get(&c.plain, &uri).await.status, 200, "{uri}");
        assert_eq!(c.get(&c.noperm, &uri).await.status, 403, "{uri}");
    }
    let anon = c
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(&uris(1)[0])
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(anon.status().as_u16(), 401);
}

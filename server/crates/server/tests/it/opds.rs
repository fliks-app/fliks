//! `/api/opds` (`docs/spec/opds.md`): the Basic device-token credential, the ACL on every feed and the shapes.
use axum::{Router, body::Body, http::Request};
use base64::{Engine, engine::general_purpose::STANDARD};
use fliks_server::{
    config::Config,
    device_tokens::{Kind, issue},
    opds,
    state::AppState,
};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    opds: String,
    kosync: String,
    noperm: String,
}

struct Res {
    status: u16,
    headers: axum::http::HeaderMap,
    body: String,
}

async fn token(pool: &PgPool, user: i32, kind: Kind) -> String {
    let (token, hash) = issue(kind);
    sqlx::query(
        r#"INSERT INTO device_tokens ("userId", name, kind, hash) VALUES ($1, 'd', $2::device_token_kind, $3)"#,
    )
    .bind(user)
    .bind(kind.as_str())
    .bind(hash)
    .execute(pool)
    .await
    .unwrap();
    token
}

/// Library 1 is readable by `plain` (user 2), 2 is not, 3 holds films. Books: 10 Alpha (text edition, plus a
/// hidden audio edition), 11 Beta (only a hidden edition), 13 Secret (library 2), 14 Gamma (its file is also
/// linked by the hidden edition).
async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false), (2, 'None', '[]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (2, 'plain', false, 1), (3, 'noperm', false, 2);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Books', '["book"]'), (2, 'Secret', '["book"]');
        INSERT INTO libraries (id, name) VALUES (3, 'Films');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b/one'), (2, '/b/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2), (3, 2), (1, 3);
        INSERT INTO persons (id, name, "sortName") VALUES (1, 'Una Writer', 'Writer, Una'), (2, 'Hidden Hank', NULL);
        INSERT INTO media (id, title, overview, year, "posterUrl", type, "libraryId", "folderName") VALUES
          (10, 'Alpha', 'A & <b>', 2001, '/api/images/media/10/poster?v=ab', 'book', 1, 'a'),
          (11, 'Beta', NULL, NULL, NULL, 'book', 1, 'b'),
          (13, 'Secret', NULL, NULL, NULL, 'book', 2, 'h'),
          (14, 'Gamma', NULL, NULL, NULL, 'book', 1, 'g'),
          (15, 'Film', NULL, NULL, NULL, 'movie', 1, 'f');
        INSERT INTO editions (id, "mediaId", family, format, language, publisher, "libraryId") VALUES
          (1, 10, 'text', 'epub', 'fr', 'Pub', NULL), (2, 10, 'audio', 'm4b', 'en', NULL, 2),
          (3, 11, 'audio', 'm4b', 'fr', NULL, 2), (4, 13, 'text', 'epub', NULL, NULL, NULL),
          (5, 14, 'text', 'epub', NULL, NULL, NULL), (6, 14, 'audio', 'm4b', NULL, NULL, 2);
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 10, 1), (2, 10, 2), (3, 11, 3), (4, 13, 4), (5, 14, 5), (6, 14, 6);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 1, 'a.epub', 11, 'EPUB', '{}'), (2, 10, 1, 'a.m4b', 1, 'M4B', '{}'),
          (3, 11, 1, 'b.m4b', 1, 'M4B', '{}'), (4, 13, 2, 'h.epub', 1, 'EPUB', '{}'), (5, 14, 1, 'g.epub', 1, 'EPUB', '{}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (2, 2, 10, 0, 0), (3, 3, 11, 0, 0), (4, 4, 13, 0, 0), (5, 5, 14, 0, 0), (6, 5, 14, 0, 0);
        INSERT INTO media_credits ("mediaId", "editionId", "personId", role, position) VALUES
          (10, NULL, 1, 'author', 0), (11, NULL, 1, 'author', 0), (13, NULL, 1, 'author', 0), (13, NULL, 2, 'author', 1);
        INSERT INTO collections (id, name) VALUES (1, 'Cycle'), (2, 'Lonely'), (3, 'Trilogy');
        INSERT INTO collection_entries ("collectionId", "mediaId", position) VALUES (1, 10, 1), (1, 11, 2), (1, 13, 3), (2, 13, 1), (3, 15, 1);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    Ctx {
        opds: token(&pool, 2, Kind::Opds).await,
        kosync: token(&pool, 2, Kind::Kosync).await,
        noperm: token(&pool, 3, Kind::Opds).await,
        app: opds::router().with_state(st),
    }
}

impl Ctx {
    async fn raw(&self, uri: &str, auth: Option<String>) -> Res {
        let mut req = Request::builder().uri(uri);
        if let Some(a) = auth {
            req = req.header("authorization", a);
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
            body: String::from_utf8_lossy(
                &axum::body::to_bytes(res.into_body(), usize::MAX)
                    .await
                    .unwrap(),
            )
            .into_owned(),
        }
    }

    async fn get(&self, uri: &str) -> Res {
        self.raw(uri, Some(basic(&self.opds))).await
    }
}

fn basic(token: &str) -> String {
    format!("Basic {}", STANDARD.encode(format!("reader:{token}")))
}

#[sqlx::test(migrations = false)]
async fn only_a_basic_opds_token_opens_the_catalogue(pool: PgPool) {
    let c = ctx(pool).await;
    let none = c.raw("/api/opds", None).await;
    assert_eq!(none.status, 401);
    assert!(
        none.headers["www-authenticate"]
            .to_str()
            .unwrap()
            .starts_with("Basic")
    );
    for auth in [
        format!("Bearer {}", c.opds),
        basic(&c.kosync),
        basic("fkd_nothex"),
        basic(&format!("fkd_{}", "0".repeat(64))),
        "Basic !!!".to_owned(),
    ] {
        assert_eq!(
            c.raw("/api/opds", Some(auth.clone())).await.status,
            401,
            "{auth}"
        );
    }
    assert_eq!(c.raw("/api/opds", Some(basic(&c.noperm))).await.status, 403);
    let ok = c.get("/api/opds").await;
    assert_eq!(ok.status, 200);
    assert_eq!(
        ok.headers["content-type"],
        "application/atom+xml;profile=opds-catalog;kind=navigation; charset=utf-8"
    );
    assert_eq!(ok.headers["cache-control"], "private, no-cache");
}

#[sqlx::test(migrations = false)]
async fn failures_are_throttled_but_a_valid_token_never_is(pool: PgPool) {
    let c = ctx(pool).await;
    let bad = basic(&format!("fkd_{}", "1".repeat(64)));
    for _ in 0..5 {
        assert_eq!(c.raw("/api/opds", Some(bad.clone())).await.status, 401);
    }
    let r = c.raw("/api/opds", Some(bad.clone())).await;
    assert_eq!(r.status, 429);
    assert_eq!(r.headers["retry-after"], "900");
    assert_eq!(
        c.raw("/api/opds/recent", None).await.status,
        401,
        "a challenge is free"
    );
    assert_eq!(c.get("/api/opds").await.status, 200);
}

#[sqlx::test(migrations = false)]
async fn navigation_lists_only_what_the_owner_reads(pool: PgPool) {
    let c = ctx(pool).await;
    let root = c.get("/api/opds").await.body;
    assert!(root.contains("urn:fliks:opds:libraries:1"));
    for hidden in ["libraries:2", "libraries:3"] {
        assert!(!root.contains(hidden), "{hidden}");
    }
    assert!(root.contains("opensearch.xml") && root.contains("{searchTerms}"));
    let authors = c.get("/api/opds/authors").await.body;
    assert!(authors.contains("Una Writer") && authors.contains("2 books<"));
    assert!(!authors.contains("Hidden Hank"));
    let series = c.get("/api/opds/series").await.body;
    assert!(series.contains("Cycle") && !series.contains("Lonely"));
    let os = c.get("/api/opds/opensearch.xml").await;
    assert!(
        os.headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/opensearchdescription+xml")
    );
}

#[sqlx::test(migrations = false)]
async fn entries_carry_acquisition_links_and_hide_what_is_hidden(pool: PgPool) {
    let c = ctx(pool).await;
    for uri in [
        "/api/opds/libraries/1",
        "/api/opds/recent",
        "/api/opds/authors/1",
        "/api/opds/series/1",
        "/api/opds/search?q=Alpha",
    ] {
        let r = c.get(uri).await;
        assert_eq!(r.status, 200, "{uri}");
        assert!(r.body.contains("kind=acquisition"), "{uri}");
        assert!(r.body.contains("urn:fliks:book:10"), "{uri}");
        for hidden in [
            "book:11",
            "book:13",
            "book:14",
            "/api/stream/2?",
            "/api/stream/5?",
        ] {
            assert!(!r.body.contains(hidden), "{uri} {hidden}");
        }
    }
    let r = c.get("/api/opds/libraries/1").await.body;
    assert!(r.contains(
        r#"href="/api/stream/1?download=1" type="application/epub+zip" title="EPUB" length="11""#
    ));
    assert!(r.contains("/api/images/media/10/poster?v=ab&amp;size=thumb"));
    assert!(r.contains("<summary type=\"text\">A &amp; &lt;b&gt;</summary>"));
    assert!(
        r.contains("<dc:language>fr</dc:language>")
            && r.contains("<dc:publisher>Pub</dc:publisher>")
    );
    assert!(r.contains("<name>Una Writer</name>"));
    let s = c.get("/api/opds/search?q=Secret").await.body;
    assert!(!s.contains("<entry>"));
    assert!(!c.get("/api/opds/search?q=").await.body.contains("<entry>"));
}

#[sqlx::test(migrations = false)]
async fn a_hidden_collection_reads_like_a_missing_one(pool: PgPool) {
    let c = ctx(pool).await;
    for kind in ["libraries", "authors", "series"] {
        let hidden = c.get(&format!("/api/opds/{kind}/2")).await;
        let missing = c.get(&format!("/api/opds/{kind}/99")).await;
        assert_eq!(
            (hidden.status, &hidden.body[..]),
            (404, missing.body.replace("99", "2").as_str()),
            "{kind}"
        );
    }
    assert_eq!(c.get("/api/opds/libraries/3").await.status, 404, "no books");
    assert_eq!(
        c.get("/api/opds/series/3").await.status,
        404,
        "a movie collection"
    );
    assert_eq!(c.get("/api/opds/recent?page=0").await.status, 400);
    assert_eq!(c.get("/api/opds/recent?page=x").await.status, 400);
}

fn png(w: u32, h: u32) -> Vec<u8> {
    let mut out = vec![];
    image::RgbImage::new(w, h)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

fn cbz() -> Vec<u8> {
    use std::io::Write;
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
    let o =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for n in ["p1.png", "p2.png", "p3.png"] {
        w.start_file(n, o).unwrap();
        w.write_all(&png(600, 900)).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// Libraries: 1 comics readable, 2 comics hidden, 4 books and comics readable. Volume 20 (library 1): issue 1
/// (cbz, read to page 2), issue 2 (pdf), annual 1 (cbz); volume 21 (library 2): issue 1.
async fn comics_ctx(pool: PgPool, tag: &str) -> (Ctx, std::path::PathBuf) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let dir = std::env::temp_dir().join(format!("fliks-opds-it-{}-{tag}", std::process::id()));
    let (one, two) = (dir.join("one"), dir.join("two"));
    std::fs::create_dir_all(&one).unwrap();
    std::fs::create_dir_all(&two).unwrap();
    for (d, n) in [(&one, "a.cbz"), (&one, "c.cbz"), (&two, "h.cbz")] {
        std::fs::write(d.join(n), cbz()).unwrap();
    }
    std::fs::write(one.join("b.pdf"), b"%PDF-1.4").unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false), (2, 'None', '[]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (2, 'plain', false, 1), (3, 'noperm', false, 2);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Comics', '["comic"]'), (2, 'Hidden', '["comic"]'), (4, 'Mixed', '["book", "comic"]');
        INSERT INTO library_folders (id, "libraryId", path) VALUES (1, 1, '{one}'), (2, 2, '{two}');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2), (4, 2);
        INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (20, 'Alpha Annual Run', 'comic', 1, ''), (21, 'Secret', 'comic', 2, '');
        INSERT INTO editions (id, "mediaId", family) VALUES (1, 20, 'image'), (2, 21, 'image');
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 20, 1), (2, 20, 1), (3, 20, 1), (4, 21, 2);
        INSERT INTO comic_issues ("itemId", "mediaId", kind, "sortNumber", label, "pageCount") VALUES
          (1, 20, 'issue', 1, '1', 3), (2, 20, 'issue', 2, '2', NULL), (3, 20, 'annual', 1, '1', 3), (4, 21, 'issue', 1, '1', 3);
        INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality) VALUES
          (1, 20, 1, 'a.cbz', 5, 'cbz'), (2, 20, 1, 'b.pdf', 8, 'pdf'), (3, 20, 1, 'c.cbz', 5, 'cbz'), (4, 21, 2, 'h.cbz', 5, 'cbz');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 20, 0, 0), (2, 2, 20, 0, 0), (3, 3, 20, 0, 0), (4, 4, 21, 0, 0);
        INSERT INTO playback_states ("userId", "mediaFileId", "itemId", locator, "lastPlayedAt")
          VALUES (2, 1, 1, '{{"page": 2}}', '2026-01-02T03:04:05Z');
        INSERT INTO playback_states ("userId", "mediaFileId", "itemId", locator) VALUES (2, 3, 3, '{{"page": 1e12}}');
        "#,
        one = one.display(),
        two = two.display()
    )))
    .execute(&pool)
    .await
    .unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let c = Ctx {
        opds: token(&pool, 2, Kind::Opds).await,
        kosync: token(&pool, 2, Kind::Kosync).await,
        noperm: token(&pool, 3, Kind::Opds).await,
        app: opds::router().with_state(st),
    };
    (c, dir)
}

#[sqlx::test(migrations = false)]
async fn a_comic_volume_feed_streams_pages_with_the_pse_attributes(pool: PgPool) {
    let (c, dir) = comics_ctx(pool, "feed").await;
    let f = c.get("/api/opds/comics/20").await;
    assert_eq!(f.status, 200);
    assert!(
        f.headers["content-type"]
            .to_str()
            .unwrap()
            .contains("kind=acquisition")
    );
    let b = &f.body;
    assert!(b.contains("xmlns:pse=\"http://vaemendis.net/opds-pse/ns\""));
    assert!(b.contains(
        "rel=\"http://vaemendis.net/opds-pse/stream\" href=\"/api/opds/issues/1/pages/{pageNumber}?width={maxWidth}\" \
         type=\"image/jpeg\" pse:count=\"3\" pse:lastRead=\"2\" pse:lastReadDate=\"2026-01-02T03:04:05Z\""
    ));
    assert!(b.contains("href=\"/api/stream/1?download=1\" type=\"application/vnd.comicbook+zip\""));
    assert!(b.contains("type=\"application/pdf\""));
    assert_eq!(
        b.matches("opds-pse/stream").count(),
        2,
        "the pdf has no PSE link"
    );
    assert_eq!(b.matches("lastRead=").count(), 2);
    assert!(
        b.contains("pse:lastRead=\"3\""),
        "a huge page is clamped to the count"
    );
    let at = |t: &str| b.find(t).unwrap();
    assert!(at("<title>Alpha Annual Run #1</title>") < at("<title>Alpha Annual Run #2</title>"));
    assert!(
        at("<title>Alpha Annual Run #2</title>") < at("<title>Alpha Annual Run Annual #1</title>")
    );
    std::fs::remove_dir_all(dir).ok();
}

#[sqlx::test(migrations = false)]
async fn comics_are_listed_through_the_acl(pool: PgPool) {
    let (c, dir) = comics_ctx(pool, "list").await;
    let root = c.get("/api/opds").await.body;
    assert!(root.contains("/api/opds/libraries/1\"") && root.contains("/api/opds/libraries/4\""));
    assert!(root.contains("href=\"/api/opds/comics\""));
    assert!(!root.contains("/api/opds/libraries/2\""));
    let lib = c.get("/api/opds/libraries/1").await;
    assert!(
        lib.headers["content-type"]
            .to_str()
            .unwrap()
            .contains("kind=navigation")
    );
    assert!(lib.body.contains("href=\"/api/opds/comics/20\""));
    assert_eq!(c.get("/api/opds/libraries/2").await.status, 404);
    let all = c.get("/api/opds/comics").await.body;
    assert!(
        all.contains("Alpha Annual Run") && all.contains("3 issues") && !all.contains("Secret")
    );
    assert!(
        c.get("/api/opds/search?q=Alpha")
            .await
            .body
            .contains("/api/opds/comics/20")
    );
    assert!(
        !c.get("/api/opds/search?q=Secret")
            .await
            .body
            .contains("<entry>")
    );
    let hidden = c.get("/api/opds/comics/21").await;
    let missing = c.get("/api/opds/comics/99").await;
    assert_eq!(
        (hidden.status, &hidden.body[..]),
        (404, missing.body.replace("99", "21").as_str())
    );
    std::fs::remove_dir_all(dir).ok();
}

#[sqlx::test(migrations = false)]
async fn the_pse_page_route_takes_the_opds_credential_and_the_page_acl(pool: PgPool) {
    let (c, dir) = comics_ctx(pool, "page").await;
    assert_eq!(c.raw("/api/opds/issues/1/pages/0", None).await.status, 401);
    assert_eq!(
        c.raw("/api/opds/issues/1/pages/0", Some(basic(&c.kosync)))
            .await
            .status,
        401
    );
    let ok = c.get("/api/opds/issues/1/pages/0?width=300").await;
    assert_eq!(ok.status, 200);
    assert_eq!(ok.headers["content-type"], "image/jpeg");
    assert_eq!(c.get("/api/opds/issues/1/pages/2").await.status, 200);
    assert_eq!(
        c.get("/api/opds/issues/1/pages/0?width=9999").await.status,
        200
    );
    assert_eq!(
        c.get("/api/opds/issues/1/pages/3").await.status,
        404,
        "past the last page"
    );
    assert_eq!(
        c.get("/api/opds/issues/2/pages/0").await.status,
        404,
        "a pdf"
    );
    assert_eq!(
        c.get("/api/opds/issues/4/pages/0").await.status,
        404,
        "a hidden library"
    );
    assert_eq!(c.get("/api/opds/issues/99/pages/0").await.status, 404);
    assert_eq!(
        c.get("/api/opds/issues/1/pages/0?width={maxWidth}")
            .await
            .status,
        200,
        "an unreplaced template"
    );
    assert_eq!(c.get("/api/opds/issues/x/pages/0").await.status, 400);
    for auth in [
        format!("Bearer {}", c.opds),
        format!("Basic {}", STANDARD.encode(format!("r:{}", "x".repeat(8)))),
    ] {
        assert_eq!(
            c.raw("/api/opds/issues/1/pages/0", Some(auth)).await.status,
            401
        );
    }
    assert_eq!(
        c.raw("/api/opds/issues/1/pages/0?token=abc", None)
            .await
            .status,
        401
    );
    assert_eq!(
        c.raw("/api/opds/issues/1/pages/0", Some(basic(&c.noperm)))
            .await
            .status,
        403
    );
    let etag = ok.headers["etag"].to_str().unwrap().to_owned();
    let req = Request::builder()
        .uri("/api/opds/issues/1/pages/0?width=300")
        .header("authorization", basic(&c.opds))
        .header("if-none-match", etag)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        c.app.clone().oneshot(req).await.unwrap().status().as_u16(),
        304
    );
    std::fs::remove_dir_all(dir).ok();
}

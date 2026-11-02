//! The book read routes (`books-api.md`): filters, sorts, the edition ACL, the watched rule, chapters, series, authors.
use axum::{Router, body::Body, http::Request};
use fliks_server::{collections, config::Config, media, persons, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";

struct Ctx {
    app: Router,
    admin: String,
    plain: String,
    noperm: String,
}

/// Library 1 is readable by `plain`, library 2 is not; edition 2 of book 10 sits in library 2.
async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false), (2, 'None', '[]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'plain', false, 1), (3, 'noperm', false, 2);
        INSERT INTO libraries (id, name, path) VALUES (1, 'L1', '/b/one'), (2, 'L2', '/b/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2), (1, 3);
        INSERT INTO persons (id, name, "sortName") VALUES (1, 'Una Writer', 'Writer, Una'), (2, 'Vic Voice', NULL), (3, 'Aaron Zed', NULL);
        INSERT INTO media (id, title, year, type, "libraryId", "folderName") VALUES
          (10, 'Alpha', 2001, 'book', 1, 'a'), (11, 'Beta', 2005, 'book', 1, 'b'), (12, 'Gamma', NULL, 'book', 1, 'c'),
          (13, 'Hidden', 2003, 'book', 2, 'h'), (14, 'Delta', 1999, 'book', 1, 'd'), (15, 'Epsilon', 2010, 'book', 1, 'e'),
          (16, 'Movie', 2000, 'movie', 1, 'm');
        INSERT INTO media_release_dates ("mediaId", "editionId", kind, date) VALUES (10, NULL, 'release', '2001-05-01');
        INSERT INTO editions (id, "mediaId", family, format, language, publisher, "libraryId", "pageCount", "durationSeconds", label) VALUES
          (1, 10, 'text', 'epub', 'fr', 'Pub', NULL, 300, NULL, 'Paper'),
          (2, 10, 'audio', 'm4b', 'en', NULL, 2, NULL, 3600, 'Hidden audio'),
          (3, 11, 'audio', 'm4b', 'fr', NULL, NULL, NULL, 150, NULL),
          (4, 12, 'audio', 'mp3', 'fr', NULL, NULL, NULL, NULL, NULL);
        INSERT INTO media_release_dates ("mediaId", "editionId", kind, date) VALUES (10, 1, 'release', '2002-02-02');
        INSERT INTO items (id, "mediaId", "editionId") VALUES (1, 10, 1), (2, 10, 2), (3, 11, 3), (4, 12, 4);
        INSERT INTO media_files (id, "mediaId", "relativePath", size, quality, "streamInfo") VALUES
          (1, 10, 'a.epub', 1, 'EPUB', '{}'), (2, 10, 'a.m4b', 1, 'M4B', '{}'),
          (3, 11, 'b1.m4b', 1, 'M4B', '{"durationSeconds": 100, "chapters": [
            {"title": "A", "startSeconds": 0, "endSeconds": 40}, {"title": "B", "startSeconds": 40, "endSeconds": 100}]}'),
          (4, 11, 'b2.m4b', 1, 'M4B', '{"durationSeconds": 50, "chapters": [{"title": "C", "startSeconds": 0, "endSeconds": 50}]}'),
          (5, 12, 'c.mp3', 1, 'MP3', '{"durationSeconds": 300}');
        INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position) VALUES
          (1, 1, 10, 0, 0), (2, 2, 10, 0, 0), (3, 3, 11, 0, 0), (3, 4, 11, 0, 1), (4, 5, 12, 0, 0);
        INSERT INTO edition_external_ids ("editionId", "mediaId", provider, value) VALUES
          (4, 12, 'asin', 'B000000001'), (1, 10, 'isbn', '9780000000002');
        INSERT INTO edition_field_sources ("editionId", field, provider, locked) VALUES (1, 'title', 'openlibrary', false);
        INSERT INTO metadata_snapshots (provider, resource, kind, "externalId", language, body) VALUES
          ('audnexus', 'chapters', 'book', 'B000000001', '', '{"chapters": [
            {"title": "Intro", "startMs": 0, "lengthMs": 60000}, {"title": "One", "startMs": 60000, "lengthMs": 120000}]}');
        INSERT INTO media_credits ("mediaId", "editionId", "personId", role, position) VALUES
          (10, NULL, 1, 'author', 0), (11, NULL, 1, 'author', 0), (12, NULL, 1, 'author', 0), (13, NULL, 1, 'author', 0),
          (14, NULL, 3, 'author', 0), (10, 2, 2, 'narrator', 0), (11, 3, 2, 'narrator', 0), (11, NULL, 3, 'translator', 0);
        INSERT INTO collections (id, name) VALUES (1, 'Cycle'), (2, 'Lonely');
        INSERT INTO collection_external_ids ("collectionId", provider, value) VALUES (1, 'asin', 'B0ABCDEFGH');
        INSERT INTO collection_entries ("collectionId", "mediaId", position, "positionLabel") VALUES
          (1, 10, 1, NULL), (1, 11, 2, 'II'), (1, 13, 3, NULL), (1, 12, 4, NULL), (2, 13, 1, NULL);
        INSERT INTO playback_states ("userId", "itemId", "positionSeconds", "durationSeconds", completed, "lastPlayedAt") VALUES
          (2, 1, 30, 100, false, '2026-01-02'), (2, 2, 10, 3600, false, '2026-01-05'), (1, 3, 150, 150, true, '2026-01-03');
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        admin: st.jwt.sign_access(1, "admin").unwrap().token,
        plain: st.jwt.sign_access(2, "plain").unwrap().token,
        noperm: st.jwt.sign_access(3, "noperm").unwrap().token,
        app: media::router()
            .merge(collections::router())
            .merge(persons::router())
            .with_state(st),
    }
}

impl Ctx {
    async fn get(&self, token: &str, uri: &str) -> (u16, Value) {
        let req = Request::builder()
            .uri(uri)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn ids(&self, token: &str, uri: &str) -> Vec<i64> {
        let (s, v) = self.get(token, uri).await;
        assert_eq!(s, 200, "{uri}: {v}");
        v["data"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_i64().unwrap())
            .collect()
    }
}

fn nums(v: &Value) -> Vec<i64> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_i64().unwrap())
        .collect()
}

#[sqlx::test(migrations = false)]
async fn filters_follow_the_edition_acl(pool: PgPool) {
    let c = ctx(pool).await;
    let q = |f: &str| format!("/api/media?type=book&sortBy=title&{f}");
    // edition 2 (audio, library 2, narrated by 2, english) is hidden from `plain`
    assert_eq!(c.ids(&c.admin, &q("format=audio")).await, [10, 11, 12]);
    assert_eq!(c.ids(&c.plain, &q("format=audio")).await, [11, 12]);
    assert_eq!(c.ids(&c.plain, &q("format=text")).await, [10]);
    assert_eq!(c.ids(&c.admin, &q("language=EN")).await, [10]);
    assert!(c.ids(&c.plain, &q("language=en")).await.is_empty());
    assert_eq!(c.ids(&c.admin, &q("narratorId=2")).await, [10, 11]);
    assert_eq!(c.ids(&c.plain, &q("narratorId=2")).await, [11]);
    assert_eq!(c.ids(&c.plain, &q("authorId=3")).await, [14]);
    assert_eq!(c.ids(&c.plain, &q("seriesId=1")).await, [10, 11, 12]);
    assert_eq!(c.ids(&c.admin, &q("seriesId=1")).await, [10, 11, 12, 13]);
    assert_eq!(c.ids(&c.plain, &q("inProgress=true")).await, [10]);
    assert!(c.ids(&c.admin, &q("inProgress=true")).await.is_empty());
    assert_eq!(
        c.ids(&c.admin, &q("inProgress=false&authorId=3")).await,
        [14]
    );
}

#[sqlx::test(migrations = false)]
async fn book_keys_are_refused_for_other_types(pool: PgPool) {
    let c = ctx(pool).await;
    for uri in [
        "/api/media?format=audio",
        "/api/media?type=movie&authorId=1",
        "/api/media?type=series&inProgress=false",
    ] {
        let (s, v) = c.get(&c.admin, uri).await;
        assert_eq!(s, 400, "{uri}");
        assert!(
            v["message"][0]
                .as_str()
                .unwrap()
                .ends_with("is only valid with type=book")
        );
    }
    let (s, v) = c.get(&c.admin, "/api/media?type=book&format=pdf").await;
    assert_eq!(
        (s, v["message"][0].as_str()),
        (
            400,
            Some("format must be one of the following values: text, audio")
        )
    );
}

#[sqlx::test(migrations = false)]
async fn book_sorts_put_missing_data_last(pool: PgPool) {
    let c = ctx(pool).await;
    let q = |s: &str| format!("/api/media?type=book&sortBy={s}");
    // Aaron Zed sorts before Writer, Una; the book with no author is last
    assert_eq!(c.ids(&c.plain, &q("author")).await, [14, 10, 11, 12, 15]);
    assert_eq!(c.ids(&c.plain, &q("series")).await, [10, 11, 12, 14, 15]);
    assert_eq!(
        c.ids(&c.plain, &q("series&sortOrder=DESC")).await,
        [12, 11, 10, 14, 15]
    );
    // 1999, 2001-05-01, 2005, 2010, then no date and no year
    assert_eq!(c.ids(&c.plain, &q("published")).await, [14, 10, 11, 15, 12]);
}

#[sqlx::test(migrations = false)]
async fn list_items_carry_the_book_object_and_other_kinds_do_not(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, v) = c.get(&c.plain, "/api/media?sortBy=title&limit=0").await;
    let by_id = |id: i64| {
        v["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == id)
            .unwrap()
            .clone()
    };
    assert!(by_id(16).get("book").is_none());
    let b = &by_id(10)["book"];
    assert_eq!(
        b,
        &json!({
            "authors": [{"id": 1, "name": "Una Writer", "sortName": "Writer, Una"}],
            "series": {"id": 1, "name": "Cycle", "position": 1, "positionLabel": null},
            "formats": ["text"],
            "lastFamily": "text",
        })
    );
    let (_, v) = c.get(&c.admin, "/api/media?type=book&limit=0").await;
    let admin_10 = v["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == 10)
        .unwrap();
    assert_eq!(admin_10["book"]["formats"], json!(["text", "audio"]));
}

#[sqlx::test(migrations = false)]
async fn watched_is_any_completed_item_and_progress_is_100_then(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, v) = c.get(&c.admin, "/api/media?type=book&limit=0").await;
    let m = v["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == 11)
        .unwrap();
    assert_eq!(
        (&m["watched"], &m["progressPercent"]),
        (&json!(true), &json!(100))
    );
    let (_, v) = c.get(&c.plain, "/api/media?type=book&limit=0").await;
    let m = v["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == 11)
        .unwrap();
    assert_eq!(
        (&m["watched"], &m["progressPercent"]),
        (&json!(false), &json!(0))
    );
}

#[sqlx::test(migrations = false)]
async fn detail_hides_the_editions_of_unreadable_libraries(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, plain) = c.get(&c.plain, "/api/media/10").await;
    assert_eq!(s, 200);
    let ed = plain["book"]["editions"].as_array().unwrap();
    assert_eq!(ed.len(), 1);
    assert_eq!(
        ed[0],
        json!({
            "id": 1, "itemId": 1, "family": "text", "format": "epub", "language": "fr", "title": null,
            "publisher": "Pub", "published": "2002-02-02", "coverUrl": null, "durationSeconds": null,
            "pageCount": 300, "libraryId": null, "label": "Paper", "narrators": [], "hasFile": true,
            "fileIds": [1], "externalIds": [{"provider": "isbn", "value": "9780000000002"}],
            "fieldSources": [{"field": "title", "provider": "openlibrary", "locked": false}],
        })
    );
    // the hidden edition's file is not among the work's files
    assert_eq!(plain["files"].as_array().unwrap().len(), 1);
    let (_, grid) = c
        .get(&c.plain, "/api/media?type=book&view=grid&sortBy=title")
        .await;
    assert_eq!(grid["data"][0]["fileCount"], 1);
    let (_, admin_grid) = c
        .get(&c.admin, "/api/media?type=book&view=grid&sortBy=title")
        .await;
    assert_eq!(admin_grid["data"][0]["fileCount"], 2);
    // the hidden edition holds the most recent state, yet progress does not name it
    assert_eq!(plain["book"]["progress"]["editionId"], 1);
    assert_eq!(plain["book"]["progress"]["itemId"], 1);
    assert_eq!(plain["book"]["progress"]["progression"], 0.3);

    let (_, admin) = c.get(&c.admin, "/api/media/10").await;
    let ids: Vec<i64> = admin["book"]["editions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [1, 2]);
    assert_eq!(
        admin["book"]["editions"][1]["narrators"][0]["name"],
        "Vic Voice"
    );
    assert_eq!(admin["book"]["editions"][1]["libraryId"], 2);
    assert_eq!(admin["book"]["progress"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn detail_names_the_neighbours_in_each_series(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, plain) = c.get(&c.plain, "/api/media/11").await;
    let s = &plain["book"]["series"][0];
    assert_eq!(
        (&s["name"], &s["position"], &s["positionLabel"]),
        (&json!("Cycle"), &json!(2), &json!("II"))
    );
    assert_eq!(
        s["previous"],
        json!({"id": 10, "title": "Alpha", "position": 1})
    );
    // book 13 (position 3) is in a library `plain` cannot read
    assert_eq!(
        s["next"],
        json!({"id": 12, "title": "Gamma", "position": 4})
    );
    let (_, admin) = c.get(&c.admin, "/api/media/11").await;
    assert_eq!(admin["book"]["series"][0]["next"]["id"], 13);
    assert_eq!(plain["book"]["translators"][0]["name"], "Aaron Zed");
    assert_eq!(plain["book"]["subjects"], json!([]));
    let (_, movie) = c.get(&c.admin, "/api/media/16").await;
    assert!(movie.get("book").is_none());
}

#[sqlx::test(migrations = false)]
async fn chapters_follow_the_version_timeline(pool: PgPool) {
    let c = ctx(pool).await;
    // two parts of 100 s and 50 s: the second part's chapter starts at 100
    let (s, v) = c.get(&c.plain, "/api/media/11/editions/3/chapters").await;
    assert_eq!(s, 200);
    assert_eq!(
        v,
        json!([
            {"title": "A", "startSeconds": 0.0, "endSeconds": 40.0, "source": "file"},
            {"title": "B", "startSeconds": 40.0, "endSeconds": 100.0, "source": "file"},
            {"title": "C", "startSeconds": 100.0, "endSeconds": 150.0, "source": "file"},
        ])
    );
    let (_, v) = c.get(&c.plain, "/api/media/12/editions/4/chapters").await;
    assert_eq!(
        v,
        json!([
            {"title": "Intro", "startSeconds": 0.0, "endSeconds": 60.0, "source": "audnexus"},
            {"title": "One", "startSeconds": 60.0, "endSeconds": 180.0, "source": "audnexus"},
        ])
    );
    let (_, v) = c.get(&c.plain, "/api/media/10/editions/1/chapters").await;
    assert_eq!(v, json!([]));
}

#[sqlx::test(migrations = false)]
async fn chapters_of_a_hidden_or_foreign_edition_are_404(pool: PgPool) {
    let c = ctx(pool).await;
    for (token, uri) in [
        (&c.plain, "/api/media/10/editions/2/chapters"),
        (&c.plain, "/api/media/10/editions/3/chapters"),
        (&c.admin, "/api/media/10/editions/3/chapters"),
        (&c.plain, "/api/media/13/editions/1/chapters"),
    ] {
        let (s, _) = c.get(token, uri).await;
        assert_eq!(s, 404, "{uri}");
    }
    let (s, v) = c.get(&c.plain, "/api/media/10/editions/2/chapters").await;
    assert_eq!(
        (s, v["message"].as_str()),
        (404, Some("Edition #2 not found"))
    );
    let (s, _) = c.get(&c.admin, "/api/media/10/editions/2/chapters").await;
    assert_eq!(s, 200);
}

#[sqlx::test(migrations = false)]
async fn collections_list_counts_what_the_caller_can_read(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, plain) = c.get(&c.plain, "/api/collections?kind=book").await;
    assert_eq!(
        plain,
        json!([{"id": 1, "name": "Cycle", "count": 3, "maxPosition": 4, "posters": []}])
    );
    let (_, admin) = c.get(&c.admin, "/api/collections?kind=book").await;
    assert_eq!(admin.as_array().unwrap().len(), 2);
    assert_eq!(admin[0]["count"], 4);
    let (_, q) = c.get(&c.admin, "/api/collections?q=lone").await;
    assert_eq!(q[0]["name"], "Lonely");
    let (_, none) = c.get(&c.admin, "/api/collections?kind=movie").await;
    assert_eq!(none, json!([]));
    let (_, page) = c.get(&c.admin, "/api/collections?limit=1&page=2").await;
    assert_eq!(page[0]["name"], "Lonely");
    let (s, _) = c.get(&c.admin, "/api/collections?kind=nope").await;
    assert_eq!(s, 400);
}

#[sqlx::test(migrations = false)]
async fn collection_detail_lists_gaps_and_the_next_book(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, plain) = c.get(&c.plain, "/api/collections/1").await;
    assert_eq!(s, 200);
    assert_eq!(
        plain["externalIds"],
        json!([{"provider": "asin", "value": "B0ABCDEFGH"}])
    );
    let order: Vec<i64> = plain["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["media"]["id"].as_i64().unwrap())
        .collect();
    assert_eq!(order, [10, 11, 12]);
    // book 13 holds position 3 but is unreadable for `plain`
    assert_eq!(
        (nums(&plain["missingPositions"]), &plain["nextUp"]),
        (vec![3], &json!(10))
    );
    assert_eq!(plain["entries"][1]["positionLabel"], "II");
    assert_eq!(
        plain["entries"][0]["media"]["book"]["formats"],
        json!(["text"])
    );
    let (_, admin) = c.get(&c.admin, "/api/collections/1").await;
    assert_eq!(
        (nums(&admin["missingPositions"]), &admin["nextUp"]),
        (vec![], &json!(10))
    );
    // admin finished book 11; the first unwatched is still 10
    assert_eq!(admin["entries"][1]["media"]["watched"], true);
}

#[sqlx::test(migrations = false)]
async fn a_collection_with_no_readable_entry_is_404(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, v) = c.get(&c.plain, "/api/collections/2").await;
    assert_eq!(
        (s, v["message"].as_str()),
        (404, Some("Collection #2 not found"))
    );
    assert_eq!(c.get(&c.admin, "/api/collections/2").await.0, 200);
    assert_eq!(c.get(&c.admin, "/api/collections/99").await.0, 404);
}

#[sqlx::test(migrations = false)]
async fn persons_list_authors_and_narrators_of_readable_books(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, authors) = c.get(&c.plain, "/api/persons?role=author").await;
    // `Aaron Zed` has no sortName: sorted as written, before `Writer, Una`
    assert_eq!(
        authors,
        json!([
            {"id": 3, "name": "Aaron Zed", "sortName": null, "avatarUrl": null, "workCount": 1},
            {"id": 1, "name": "Una Writer", "sortName": "Writer, Una", "avatarUrl": null, "workCount": 3},
        ])
    );
    let (_, admin) = c
        .get(&c.admin, "/api/persons?role=author&sortBy=works")
        .await;
    assert_eq!(
        (admin[0]["id"].clone(), admin[0]["workCount"].clone()),
        (json!(1), json!(4))
    );
    // narrator 2 voices edition 2 (hidden to plain) and edition 3
    let (_, n) = c.get(&c.plain, "/api/persons?role=narrator").await;
    assert_eq!(n[0]["workCount"], 1);
    let (_, n) = c.get(&c.admin, "/api/persons?role=narrator").await;
    assert_eq!(n[0]["workCount"], 2);
    let (_, q) = c.get(&c.admin, "/api/persons?role=author&q=aar").await;
    assert_eq!(q.as_array().unwrap().len(), 1);
    let (_, lib) = c
        .get(&c.admin, "/api/persons?role=author&libraryId=2")
        .await;
    assert_eq!(
        (lib[0]["id"].clone(), lib[0]["workCount"].clone()),
        (json!(1), json!(1))
    );
    for uri in [
        "/api/persons?role=editor",
        "/api/persons",
        "/api/persons/1/works",
    ] {
        assert_eq!(c.get(&c.admin, uri).await.0, 400, "{uri}");
    }
}

#[sqlx::test(migrations = false)]
async fn person_works_group_by_series_and_standalone(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, w) = c.get(&c.plain, "/api/persons/1/works?role=author").await;
    assert_eq!(s, 200);
    assert_eq!(
        w["series"][0]["collection"],
        json!({"id": 1, "name": "Cycle"})
    );
    let ids: Vec<i64> = w["series"][0]["works"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["media"]["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, [10, 11, 12]);
    assert_eq!(w["standalone"], json!([]));
    let (_, w) = c.get(&c.plain, "/api/persons/3/works?role=author").await;
    assert_eq!(
        (w["series"].clone(), w["standalone"][0]["id"].clone()),
        (json!([]), json!(14))
    );
    // book 13 is in two collections and unreadable for plain, readable for admin
    let (_, w) = c.get(&c.admin, "/api/persons/1/works?role=author").await;
    assert_eq!(w["series"].as_array().unwrap().len(), 2);
    let (_, w) = c.get(&c.plain, "/api/persons/2/works?role=narrator").await;
    assert_eq!(w["standalone"], json!([]));
    assert_eq!(w["series"][0]["works"][0]["media"]["id"], 11);
    assert_eq!(
        c.get(&c.plain, "/api/persons/99/works?role=author").await.0,
        404
    );
}

#[sqlx::test(migrations = false)]
async fn the_routes_need_media_read(pool: PgPool) {
    let c = ctx(pool).await;
    for uri in [
        "/api/collections",
        "/api/collections/1",
        "/api/persons?role=author",
        "/api/persons/1/works?role=author",
        "/api/media/10/editions/1/chapters",
    ] {
        assert_eq!(c.get(&c.noperm, uri).await.0, 403, "{uri}");
    }
}

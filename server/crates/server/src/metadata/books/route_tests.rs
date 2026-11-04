//! The book metadata routes against fake providers (`docs/spec/book-metadata.md` rules 18-25).
use super::tests::{Fake, ISBN, anchor, state};
use crate::{media, state::AppState};
use axum::{Router, body::Body, http::Request};
use fliks_domain::external_id::Namespace;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

struct Ctx {
    app: Router,
    admin: String,
    reader: String,
    pool: PgPool,
}

fn work_hit() -> Value {
    json!({"externalId": "OL1W", "title": "Alpha", "subtitle": "Sub", "authors": [{"name": "Una Roe", "id": "OL7A"}],
           "year": 1999, "posterUrl": "http://img/a.jpg", "series": [{"name": "Cycle", "position": 2}],
           "editionCount": 7})
}

fn editions() -> Vec<Value> {
    vec![
        json!({"externalId": "OL5M", "title": "Alpha", "publisher": "Pub", "format": "EPUB", "language": "fre",
               "isbn13": [ISBN], "pageCount": 320, "releaseDate": "2001-05"}),
        json!({"externalId": "OL6M", "format": "m4b", "narrators": [{"name": "Vic Voice"}], "asin": "B000000001"}),
    ]
}

/// Library 1 takes books and is readable by `reader` (media.read only); library 2 is not.
async fn ctx(pool: PgPool, fakes: Vec<Fake>) -> (Ctx, AppState) {
    crate::db::migrate(&pool).await.unwrap();
    let st = state(&pool, fakes);
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'reader', false, 1);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Books', '["book"]'), (2, 'Other', '["book"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b/one'), (2, '/b/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let c = Ctx {
        admin: st.jwt.sign_access(1, "admin").unwrap().token,
        reader: st.jwt.sign_access(2, "reader").unwrap().token,
        app: crate::metadata::router()
            .merge(media::router())
            .with_state(st.clone()),
        pool,
    };
    (c, st)
}

impl Ctx {
    async fn call(
        &self,
        token: &str,
        method: &str,
        uri: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
        let body = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                Body::from(b.to_string())
            }
            None => Body::empty(),
        };
        let res = self
            .app
            .clone()
            .oneshot(req.body(body).unwrap())
            .await
            .unwrap();
        let status = res.status().as_u16();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn get(&self, uri: &str) -> (u16, Value) {
        self.call(&self.admin, "GET", uri, None).await
    }

    async fn book(&self, library: i32) -> i32 {
        sqlx::query_scalar(r#"INSERT INTO media (title, type, "libraryId") VALUES ('Untitled', 'book', $1) RETURNING id"#)
            .bind(library)
            .fetch_one(&self.pool)
            .await
            .unwrap()
    }

    async fn edition(&self, media: i32, family: &str) -> i32 {
        sqlx::query_scalar(
            r#"INSERT INTO editions ("mediaId", family) VALUES ($1, $2) RETURNING id"#,
        )
        .bind(media)
        .bind(family)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }
}

fn full_anchor() -> Fake {
    let mut ol = anchor();
    ol.found = vec![work_hit(), json!({"title": "no id"})];
    ol.children.insert("OL1W".into(), editions());
    ol.works.insert("OL2W".into(), json!({"title": "Beta"}));
    ol
}

#[sqlx::test(migrations = false)]
async fn the_providers_route_lists_the_book_providers(pool: PgPool) {
    let (c, _) = ctx(pool, vec![anchor()]).await;
    let (_, v) = c.get("/api/metadata/providers").await;
    assert_eq!(
        v["serving"]["book"],
        json!([{"provider": "openlibrary", "label": "Open Library"}])
    );
}

#[sqlx::test(migrations = false)]
async fn search_maps_hits_and_marks_owned_works(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let owned = c.book(1).await;
    sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'book', 'openlibrary', 'OL1W')"#)
        .bind(owned)
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, v) = c.get("/api/metadata/search/book?q=alpha").await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        v,
        json!([{"provider": "openlibrary", "externalId": "OL1W", "mediaType": "book", "title": "Alpha",
                "subtitle": "Sub", "authors": ["Una Roe"], "year": 1999, "posterUrl": "http://img/a.jpg",
                "series": {"name": "Cycle", "position": "2"}, "editionCount": 7, "existingMediaId": owned}])
    );
    let (_, v) = c
        .get("/api/metadata/search/book?title=alpha&author=roe")
        .await;
    assert_eq!(v[0]["existingMediaId"], owned);
}

#[sqlx::test(migrations = false)]
async fn search_hides_a_work_held_in_an_unreadable_library(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let hidden = c.book(2).await;
    sqlx::query(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES ($1, 'book', 'openlibrary', 'OL1W')"#)
        .bind(hidden)
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, v) = c
        .call(&c.reader, "GET", "/api/metadata/search/book?q=a", None)
        .await;
    assert_eq!(v[0]["existingMediaId"], Value::Null);
    let (_, v) = c.get("/api/metadata/search/book?q=a").await;
    assert_eq!(v[0]["existingMediaId"], hidden);
}

#[sqlx::test(migrations = false)]
async fn search_validates_and_falls_back(pool: PgPool) {
    let mut gb = Fake::new(Namespace::GOOGLEBOOKS);
    gb.found = vec![json!({"externalId": "gb1", "title": "Gamma", "authors": ["Sol"]})];
    let mut ol = full_anchor();
    ol.found = vec![];
    let (c, _) = ctx(pool, vec![ol, gb]).await;
    assert_eq!(c.get("/api/metadata/search/book").await, (200, json!([])));
    assert_eq!(c.get("/api/metadata/search/book?page=0&q=a").await.0, 400);
    assert_eq!(c.get("/api/metadata/search/book?page=x&q=a").await.0, 400);
    assert_eq!(
        c.get("/api/metadata/search/book?provider=tmdb&q=a").await.0,
        400
    );
    assert_eq!(
        c.call("bad", "GET", "/api/metadata/search/book?q=a", None)
            .await
            .0,
        401
    );
    let (_, v) = c.get("/api/metadata/search/book?q=a").await;
    assert_eq!(
        (v[0]["provider"].as_str(), v[0]["externalId"].as_str()),
        (Some("googlebooks"), Some("gb1"))
    );
    assert_eq!(v[0]["authors"], json!(["Sol"]));
    let (_, v) = c
        .get("/api/metadata/search/book?q=a&provider=openlibrary")
        .await;
    assert_eq!(v[0]["provider"], "googlebooks");
}

#[sqlx::test(migrations = false)]
async fn search_names_an_audible_hit_by_its_asin_and_finds_the_held_edition(pool: PgPool) {
    let mut audible = Fake::new(Namespace::AUDIBLE);
    audible.found =
        vec![json!({"externalId": "B000000001", "title": "Alpha", "authors": ["Una Roe"]})];
    let mut ol = full_anchor();
    ol.found = vec![];
    let (c, _) = ctx(pool, vec![ol, audible]).await;
    let (_, v) = c.get("/api/metadata/search/book?q=a").await;
    assert_eq!(
        (v[0]["provider"].as_str(), v[0]["externalId"].as_str()),
        (Some("asin"), Some("B000000001"))
    );
    assert_eq!(v[0]["existingMediaId"], Value::Null);
    let owned = c.book(1).await;
    let e = c.edition(owned, "audio").await;
    sqlx::query(r#"INSERT INTO edition_external_ids ("editionId", "mediaId", provider, value) VALUES ($1, $2, 'asin', 'B000000001')"#)
        .bind(e)
        .bind(owned)
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, v) = c.get("/api/metadata/search/book?q=a").await;
    assert_eq!(v[0]["existingMediaId"], owned);
}

#[sqlx::test(migrations = false)]
async fn search_asks_the_preferred_provider_of_the_media_first(pool: PgPool) {
    let mut gb = Fake::new(Namespace::GOOGLEBOOKS);
    gb.found = vec![json!({"externalId": "gb1", "title": "Gamma", "authors": ["Sol"]})];
    let (c, _) = ctx(pool, vec![full_anchor(), gb]).await;
    let m = c.book(1).await;
    sqlx::query(r#"UPDATE libraries SET "preferredProvider" = 'googlebooks' WHERE id = 1"#)
        .execute(&c.pool)
        .await
        .unwrap();
    let (_, v) = c.get("/api/metadata/search/book?q=a").await;
    assert_eq!(v[0]["provider"], "openlibrary");
    let (_, v) = c
        .get(&format!("/api/metadata/search/book?q=a&mediaId={m}"))
        .await;
    assert_eq!(v[0]["provider"], "googlebooks");
}

#[sqlx::test(migrations = false)]
async fn search_answers_503_when_every_provider_fails(pool: PgPool) {
    let mut ol = full_anchor();
    ol.broken = true;
    let (c, _) = ctx(pool, vec![ol]).await;
    assert_eq!(c.get("/api/metadata/search/book?q=a").await.0, 503);
}

#[sqlx::test(migrations = false)]
async fn preview_describes_the_work_and_its_editions(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let (s, v) = c.get("/api/metadata/openlibrary/book/OL1W").await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        (
            v["title"].as_str(),
            v["description"].as_str(),
            v["editionCount"].as_i64()
        ),
        (Some("Alpha"), Some("OL text"), Some(2))
    );
    assert_eq!(v["subjects"], json!(["Novel"]));
    assert_eq!(v["unofficial"], false);
    assert_eq!(
        v["editions"][0],
        json!({"provider": "openlibrary", "externalId": "OL5M", "family": "text", "format": "epub", "language": "fre",
               "title": "Alpha", "publisher": "Pub", "published": "2001-05", "isbn13": [ISBN], "asin": null,
               "coverUrl": null, "narrators": [], "durationSeconds": null, "pageCount": 320})
    );
    assert_eq!(
        (
            v["editions"][1]["family"].as_str(),
            v["editions"][1]["narrators"].clone()
        ),
        (Some("audio"), json!(["Vic Voice"]))
    );
    assert_eq!(c.get("/api/metadata/openlibrary/book/OL9W").await.0, 404);
    assert_eq!(c.get("/api/metadata/openlibrary/book/OL1M").await.0, 400);
    assert_eq!(c.get("/api/metadata/googlebooks/book/OL1W").await.0, 400);
    assert_eq!(c.get("/api/metadata/tmdb/book/OL1W").await.0, 400);
}

fn import(extra: Value) -> Value {
    let mut b = json!({"type": "book", "provider": "openlibrary", "externalId": "OL1W"});
    b.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    b
}

#[sqlx::test(migrations = false)]
async fn import_creates_the_book_and_links_the_work(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let (s, v) = c.get("/api/media").await;
    assert_eq!((s, v["total"].as_i64()), (200, Some(0)));
    let (s, v) = c
        .call(
            &c.admin,
            "POST",
            "/api/media/import",
            Some(import(json!({"libraryId": 1}))),
        )
        .await;
    assert_eq!(s, 201, "{v}");
    assert_eq!(
        (
            v["type"].as_str(),
            v["title"].as_str(),
            v["libraryId"].as_i64()
        ),
        (Some("book"), Some("Alpha"), Some(1))
    );
    assert_eq!(v["folderName"], "Alpha");
    assert_eq!(v["book"]["authors"][0]["name"], "Una Roe");
    assert_eq!(v["book"]["series"][0]["name"], "Cycle");
    let id = v["id"].as_i64().unwrap();
    let (_, src) = c.get(&format!("/api/media/{id}/sources")).await;
    assert_eq!(
        src["work"],
        json!({"provider": "openlibrary", "value": "OL1W"})
    );
    let wants: i64 = sqlx::query_scalar("SELECT count(*) FROM wants WHERE \"mediaId\" = $1")
        .bind(id as i32)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(wants, 2);
    let (s, v) = c
        .call(
            &c.admin,
            "POST",
            "/api/media/import",
            Some(import(json!({}))),
        )
        .await;
    assert_eq!(
        (s, v["message"].as_str()),
        (409, Some("This title is already in the library"))
    );
}

#[sqlx::test(migrations = false)]
async fn import_records_the_chosen_folder_on_both_wants(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let second: i32 = sqlx::query_scalar(
        r#"INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b/extra') RETURNING id"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let (s, v) = c
        .call(
            &c.admin,
            "POST",
            "/api/media/import",
            Some(import(json!({"libraryId": 1, "folderId": second}))),
        )
        .await;
    assert_eq!(s, 201, "{v}");
    let rows: Vec<(String, Option<i32>)> = sqlx::query_as(
        r#"SELECT family, "folderId" FROM wants WHERE "mediaId" = $1 ORDER BY family"#,
    )
    .bind(v["id"].as_i64().unwrap() as i32)
    .fetch_all(&c.pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|(_, f)| *f == Some(second)), "{rows:?}");
}

#[sqlx::test(migrations = false)]
async fn import_validates_before_it_writes(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let post = |b: Value| c.call(&c.admin, "POST", "/api/media/import", Some(b));
    let (s, v) = post(import(json!({"libraryId": 1, "folderId": 2}))).await;
    assert_eq!(
        (s, v["message"].as_str()),
        (400, Some("errors.folder_not_in_library"))
    );
    assert_eq!(
        post(import(json!({"libraryId": 1, "folderId": 1}))).await.0,
        201
    );
    assert_eq!(
        post(import(
            json!({"externalId": "OL2W", "libraryId": 1, "qualityProfileId": 1})
        ))
        .await
        .0,
        400
    );
    assert_eq!(post(import(json!({"externalId": "OL1M"}))).await.0, 400);
    assert_eq!(
        post(import(
            json!({"provider": "googlebooks", "externalId": "x"})
        ))
        .await
        .0,
        400
    );
    assert_eq!(
        post(import(json!({"libraryId": 99, "externalId": "OL2W"})))
            .await
            .0,
        404
    );
    assert_eq!(
        c.call(
            &c.reader,
            "POST",
            "/api/media/import",
            Some(import(json!({"libraryId": 1})))
        )
        .await
        .0,
        403
    );
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[sqlx::test(migrations = false)]
async fn a_failed_import_leaves_no_book(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let (s, _) = c
        .call(
            &c.admin,
            "POST",
            "/api/media/import",
            Some(import(json!({"externalId": "OL9W", "libraryId": 1}))),
        )
        .await;
    assert_eq!(s, 404);
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

fn sources_uri(id: i32) -> String {
    format!("/api/media/{id}/sources")
}

#[sqlx::test(migrations = false)]
async fn the_work_is_relinked_unless_another_book_holds_it(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let (a, b) = (c.book(1).await, c.book(1).await);
    let put = async |id: i32, w: &str| {
        let body = json!({"level": "work", "provider": "openlibrary", "value": w});
        c.call(&c.admin, "PUT", &sources_uri(id), Some(body)).await
    };
    let (s, v) = put(a, "OL1W").await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(v["work"]["value"], "OL1W");
    let title: String = sqlx::query_scalar("SELECT title FROM media WHERE id = $1")
        .bind(a)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(title, "Alpha");
    let (s, v) = put(b, "OL1W").await;
    assert_eq!((s, v["message"].as_str()), (409, Some("taken")));
    let (s, v) = put(a, "OL2W").await;
    assert_eq!((s, v["work"]["value"].as_str()), (200, Some("OL2W")));
    assert_eq!(put(a, "OL9W").await.0, 404);
    let (_, v) = c.get(&sources_uri(a)).await;
    assert_eq!(v["work"]["value"], "OL2W");
    let (s, v) = c
        .call(
            &c.admin,
            "DELETE",
            &format!(
                "{}?level=work&provider=openlibrary&value=OL2W",
                sources_uri(a)
            ),
            None,
        )
        .await;
    assert_eq!((s, v["work"].clone()), (200, Value::Null));
}

#[sqlx::test(migrations = false)]
async fn edition_ids_are_added_replaced_and_removed(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let media = c.book(1).await;
    let ed = c.edition(media, "audio").await;
    let uri = sources_uri(media);
    let put = |p: &str, v: &str| {
        c.call(
            &c.admin,
            "PUT",
            &uri,
            Some(json!({"level": "edition", "editionId": ed, "provider": p, "value": v})),
        )
    };
    // no work yet: the id is stored, nothing is read
    let (s, v) = put("asin", "B000000001").await;
    assert_eq!(s, 200, "{v}");
    assert_eq!(
        v["editions"],
        json!([{"editionId": ed, "ids": [{"provider": "asin", "value": "B000000001"}]}])
    );
    c.call(
        &c.admin,
        "PUT",
        &uri,
        Some(json!({"level": "work", "provider": "openlibrary", "value": "OL1W"})),
    )
    .await;
    let (_, v) = put("asin", "B000000002").await;
    assert_eq!(
        v["editions"][0]["ids"],
        json!([{"provider": "asin", "value": "B000000002"}])
    );
    let (_, v) = put("isbn", ISBN).await;
    let ids = &v["editions"][0]["ids"];
    assert!(
        ids.as_array()
            .unwrap()
            .contains(&json!({"provider": "isbn", "value": ISBN})),
        "{ids}"
    );
    let (_, v) = c
        .call(
            &c.admin,
            "DELETE",
            &format!("{uri}?level=edition&editionId={ed}&provider=isbn&value={ISBN}"),
            None,
        )
        .await;
    assert!(!v["editions"][0]["ids"].to_string().contains(ISBN), "{v}");
}

#[sqlx::test(migrations = false)]
async fn sources_check_access_kind_and_input(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let (mine, hidden) = (c.book(1).await, c.book(2).await);
    let movie: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, type, "libraryId") VALUES ('M', 'movie', 1) RETURNING id"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    let ed = c.edition(hidden, "text").await;
    let work = json!({"level": "work", "provider": "openlibrary", "value": "OL1W"});
    assert_eq!(
        c.call(&c.reader, "GET", &sources_uri(mine), None).await.0,
        200
    );
    assert_eq!(
        c.call(&c.reader, "PUT", &sources_uri(mine), Some(work.clone()))
            .await
            .0,
        403
    );
    assert_eq!(
        c.call(&c.reader, "GET", &sources_uri(hidden), None).await.0,
        404
    );
    assert_eq!(
        c.call(&c.admin, "GET", &sources_uri(movie), None).await.0,
        400
    );
    let bad = [
        json!({"level": "work", "provider": "asin", "value": "B000000001"}),
        json!({"level": "work", "provider": "openlibrary", "value": "OL1M"}),
        json!({"level": "work", "editionId": 1, "provider": "openlibrary", "value": "OL1W"}),
        json!({"level": "edition", "provider": "isbn", "value": ISBN}),
        json!({"level": "edition", "editionId": ed, "provider": "isbn", "value": "123"}),
        json!({"level": "edition", "editionId": ed, "provider": "audible", "value": "B000000001"}),
        json!({"level": "volume", "provider": "isbn", "value": ISBN}),
        json!({"level": "work", "provider": "openlibrary", "value": "OL1W", "extra": 1}),
    ];
    for b in bad {
        assert_eq!(
            c.call(&c.admin, "PUT", &sources_uri(mine), Some(b.clone()))
                .await
                .0,
            400,
            "{b}"
        );
    }
    let (s, v) = c
        .call(
            &c.admin,
            "PUT",
            &sources_uri(mine),
            Some(json!({"level": "edition", "editionId": ed, "provider": "isbn", "value": ISBN})),
        )
        .await;
    assert_eq!(
        (s, v["message"].as_str()),
        (404, Some(&*format!("Edition #{ed} not found")))
    );
}

#[sqlx::test(migrations = false)]
async fn identify_links_the_work_of_a_book_and_refuses_one_another_book_holds(pool: PgPool) {
    let (c, _) = ctx(pool, vec![full_anchor()]).await;
    let (a, b) = (c.book(1).await, c.book(1).await);
    let identify = async |id: i32, body: Value| {
        c.call(
            &c.admin,
            "POST",
            &format!("/api/media/{id}/identify"),
            Some(body),
        )
        .await
    };
    let (s, v) = identify(a, json!({"provider": "openlibrary", "externalId": "OL1W"})).await;
    assert_eq!(s, 201, "{v}");
    let (_, v) = c.get(&sources_uri(a)).await;
    assert_eq!(v["work"]["value"], "OL1W");
    let (s, _) = identify(b, json!({"provider": "openlibrary", "externalId": "OL1W"})).await;
    assert_eq!(s, 409);
    let (s, _) = identify(b, json!({"tmdbId": 5})).await;
    assert_eq!(s, 400);
}

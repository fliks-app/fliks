//! Wants, follows, the wanted list and the follow refresh (`docs/spec/wants-follows.md`).
use super::{refresh, refresh_follows};
use crate::{
    media,
    metadata::books::tests::{Fake, anchor, state},
    state::AppState,
};
use axum::{Router, body::Body, http::Request};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

struct Ctx {
    app: Router,
    admin: String,
    reader: String,
    pool: PgPool,
    st: AppState,
}

fn hit(id: &str, date: &str, author: (&str, &str)) -> Value {
    json!({"externalId": id, "title": format!("Title {id}"), "releaseDate": date,
           "authors": [{"name": author.0, "id": author.1}]})
}

/// An anchor whose search lists a new work, a backlist work and a work of another author.
fn provider() -> Fake {
    let mut ol = anchor();
    ol.found = vec![
        hit("OL9W", "2999-01-01", ("Una Roe", "OL7A")),
        hit("OL8W", "2001-05-01", ("Una Roe", "OL7A")),
        hit("OL10W", "2999-02-01", ("Else Where", "OL99A")),
        hit("OL11W", "2999-03-01", ("Una Roe", "OL55A")),
    ];
    for id in ["OL9W", "OL8W", "OL10W"] {
        ol.works.insert(
            id.into(),
            json!({"title": format!("Title {id}"), "year": 2999, "releaseDate": "2999-01-01",
                   "authors": [{"name": "Una Roe", "id": "OL7A"}]}),
        );
    }
    ol
}

async fn ctx(pool: PgPool) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let st = state(&pool, vec![provider()]);
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES (1, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES (1, 'admin', true, NULL), (2, 'reader', false, 1);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Books', '["book"]'), (2, 'Films', '["movie"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b/one'), (2, '/b/two');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2), (2, 2);
        INSERT INTO persons (id, name) VALUES (1, 'Una Roe');
        INSERT INTO person_external_ids ("personId", provider, value) VALUES (1, 'openlibrary', 'OL7A');
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    Ctx {
        admin: st.jwt.sign_access(1, "admin").unwrap().token,
        reader: st.jwt.sign_access(2, "reader").unwrap().token,
        app: media::router()
            .merge(super::router())
            .with_state(st.clone()),
        pool,
        st,
    }
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

    async fn admin(&self, method: &str, uri: &str, body: Option<Value>) -> (u16, Value) {
        self.call(&self.admin, method, uri, body).await
    }

    /// A monitored book of library 1 with the shell's two wants.
    async fn book(&self) -> i32 {
        let mut tx = self.pool.begin().await.unwrap();
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO media (title, type, "libraryId", monitored) VALUES ('Alpha', 'book', 1, true) RETURNING id"#,
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        media::items::create_shell(
            &mut tx,
            id,
            fliks_domain::media::kind::MediaKind::Book,
            Default::default(),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        id
    }

    async fn count(&self, sql: &'static str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(&self.pool).await.unwrap()
    }
}

fn wants_of(v: &Value) -> Vec<(String, Option<String>)> {
    v["wants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| {
            (
                w["family"].as_str().unwrap().to_owned(),
                w["language"].as_str().map(str::to_owned),
            )
        })
        .collect()
}

#[sqlx::test(migrations = false)]
async fn wants_are_replaced_whole_and_validated(pool: PgPool) {
    let c = ctx(pool).await;
    let id = c.book().await;
    let uri = format!("/api/media/{id}/wants");
    let (s, v) = c.admin("GET", &uri, None).await;
    assert_eq!(
        (s, wants_of(&v)),
        (200, vec![("audio".into(), None), ("text".into(), None)])
    );

    let put = json!({"wants": [{"family": "text", "language": "fre"}, {"family": "audio", "language": "en"}]});
    let (s, v) = c.admin("PUT", &uri, Some(put)).await;
    assert_eq!(s, 200);
    assert_eq!(
        wants_of(&v),
        vec![
            ("audio".into(), Some("en".into())),
            ("text".into(), Some("fr".into()))
        ]
    );
    assert!(
        v["wants"]
            .as_array()
            .unwrap()
            .iter()
            .all(|w| w["folderId"].is_number())
    );

    let (s, v) = c
        .admin("PUT", &uri, Some(json!({"wants": [{"family": "text"}]})))
        .await;
    assert_eq!((s, wants_of(&v)), (200, vec![("text".into(), None)]));
    for bad in [
        json!({"wants": []}),
        json!({"wants": [{"family": "video"}]}),
        json!({"wants": [{"family": "text", "qualityProfileId": 99999}]}),
        json!({}),
    ] {
        assert_eq!(c.admin("PUT", &uri, Some(bad)).await.0, 400);
    }
    assert_eq!(
        c.call(
            &c.reader,
            "PUT",
            &uri,
            Some(json!({"wants": [{"family": "text"}]}))
        )
        .await
        .0,
        403
    );
    assert_eq!(c.admin("GET", "/api/media/9999/wants", None).await.0, 404);
}

#[sqlx::test(migrations = false)]
async fn concurrent_replacements_leave_one_whole_list(pool: PgPool) {
    let c = ctx(pool).await;
    let id = c.book().await;
    let uri = format!("/api/media/{id}/wants");
    let a = json!({"wants": [{"family": "text", "language": "fr"}]});
    let b = json!({"wants": [{"family": "audio", "language": "en"}, {"family": "text", "language": "de"}]});
    let (ra, rb) = tokio::join!(
        c.admin("PUT", &uri, Some(a.clone())),
        c.admin("PUT", &uri, Some(b.clone()))
    );
    assert_eq!((ra.0, rb.0), (200, 200));
    let (_, v) = c.admin("GET", &uri, None).await;
    let got = wants_of(&v);
    let a = vec![("text".to_owned(), Some("fr".to_owned()))];
    let b = vec![
        ("audio".to_owned(), Some("en".to_owned())),
        ("text".to_owned(), Some("de".to_owned())),
    ];
    assert!(got == a || got == b, "{got:?}");
}

#[sqlx::test(migrations = false)]
async fn the_wanted_list_holds_unsatisfied_wants_of_monitored_media(pool: PgPool) {
    let c = ctx(pool).await;
    let id = c.book().await;
    let (s, v) = c.admin("GET", "/api/wanted", None).await;
    assert_eq!((s, v["total"].clone()), (200, json!(2)));
    assert_eq!(v["data"][0]["type"], "book");
    assert_eq!(
        c.admin("GET", "/api/wanted?type=movie", None).await.1["total"],
        0
    );
    assert_eq!(
        c.admin("GET", "/api/wanted?released=false", None).await.1["total"],
        0
    );
    assert_eq!(
        c.admin("GET", "/api/wanted?released=true", None).await.1["total"],
        2
    );
    assert_eq!(c.admin("GET", "/api/wanted?bogus=1", None).await.0, 400);

    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO editions (id, "mediaId", family, language) VALUES (500, {id}, 'text', 'fr');
           INSERT INTO items (id, "mediaId", "editionId", monitored) VALUES (600, {id}, 500, true);
           INSERT INTO media_files (id, "mediaId", "relativePath", size, quality, "folderId")
             VALUES (700, {id}, 'a.epub', 1, 'epub', (SELECT id FROM library_folders WHERE "libraryId" = 1));
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") VALUES (600, 700, {id}, 0);
           UPDATE media SET monitored = true WHERE id = {id};"#
    )))
    .execute(&c.pool)
    .await
    .unwrap();
    // a French ebook satisfies the any-language text want only; audio stays wanted
    let (_, v) = c.admin("GET", "/api/wanted", None).await;
    assert_eq!(v["total"], 1);
    assert_eq!(v["data"][0]["family"], "audio");
    sqlx::query("UPDATE media SET monitored = false")
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(c.admin("GET", "/api/wanted", None).await.1["total"], 0);
}

#[sqlx::test(migrations = false)]
async fn a_follow_is_saved_per_user_and_checked(pool: PgPool) {
    let c = ctx(pool).await;
    let uri = "/api/persons/1/follow";
    let (s, v) = c.admin("GET", uri, None).await;
    assert_eq!(
        (s, v["follow"].clone(), v["canFollow"].clone()),
        (200, Value::Null, json!(true))
    );
    let put = json!({"libraryId": 1, "wants": [{"family": "text", "language": "fr"}]});
    let (s, v) = c.admin("PUT", uri, Some(put)).await;
    assert_eq!(
        (
            s,
            v["follow"]["libraryId"].clone(),
            v["follow"]["newReleases"].clone()
        ),
        (200, json!(1), json!(true))
    );
    let (_, v) = c
        .admin(
            "PUT",
            uri,
            Some(json!({"libraryId": 1, "newReleases": false})),
        )
        .await;
    assert_eq!(v["follow"]["wants"][0]["language"], "fr");
    assert_eq!(v["follow"]["newReleases"], false);
    assert_eq!(
        c.admin("GET", "/api/follows", None).await.1["persons"][0]["name"],
        "Una Roe"
    );
    assert_eq!(
        c.call(&c.reader, "GET", "/api/follows", None).await.1["persons"],
        json!([])
    );
    assert_eq!(
        c.call(&c.reader, "PUT", uri, Some(json!({"libraryId": 1})))
            .await
            .0,
        403
    );
    assert_eq!(
        c.admin("PUT", uri, Some(json!({"libraryId": 2}))).await.0,
        400
    );
    assert_eq!(c.admin("PUT", uri, Some(json!({}))).await.0, 400);
    assert_eq!(
        c.admin(
            "PUT",
            "/api/persons/9/follow",
            Some(json!({"libraryId": 1}))
        )
        .await
        .0,
        404
    );
    assert_eq!(c.admin("DELETE", uri, None).await.0, 204);
    assert_eq!(c.admin("DELETE", uri, None).await.0, 204);
    assert_eq!(c.admin("GET", uri, None).await.1["follow"], Value::Null);
}

#[sqlx::test(migrations = false)]
async fn a_person_who_is_no_author_cannot_be_followed(pool: PgPool) {
    let c = ctx(pool).await;
    sqlx::query("INSERT INTO persons (id, name) VALUES (2, 'Actor')")
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, v) = c.admin("GET", "/api/persons/2/follow", None).await;
    assert_eq!((s, v["canFollow"].clone()), (200, json!(false)));
    assert_eq!(
        c.admin(
            "PUT",
            "/api/persons/2/follow",
            Some(json!({"libraryId": 1}))
        )
        .await
        .0,
        400
    );
}

async fn follow(c: &Ctx) {
    sqlx::query(
        r#"INSERT INTO person_follows ("userId", "personId", role, "libraryId", wants, since)
           VALUES (1, 1, 'author', 1, '[{"family":"text","language":"fr"}]', '2020-01-01')"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
}

#[sqlx::test(migrations = false)]
async fn the_refresh_adds_each_new_title_once_with_the_follow_wants(pool: PgPool) {
    let c = ctx(pool).await;
    follow(&c).await;
    refresh_follows(&c.st).await.unwrap();
    let added =
        "SELECT count(*) FROM media_external_ids WHERE provider = 'openlibrary' AND value = 'OL9W'";
    assert_eq!(c.count(added).await, 1);
    assert_eq!(
        c.count(
            "SELECT count(*) FROM media_external_ids WHERE value IN ('OL8W', 'OL10W', 'OL11W')"
        )
        .await,
        0
    );
    let (id, user, monitored): (i32, Option<i32>, bool) =
        sqlx::query_as(r#"SELECT id, "addedById", monitored FROM media WHERE type = 'book'"#)
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!((user, monitored), (Some(1), true));
    let (_, v) = c
        .admin("GET", &format!("/api/media/{id}/wants"), None)
        .await;
    assert_eq!(wants_of(&v), vec![("text".into(), Some("fr".into()))]);
    assert!(
        c.count(r#"SELECT count(*) FROM person_follows WHERE "refreshedAt" IS NOT NULL AND "failedAdds" = 0"#)
            .await
            == 1
    );
    let ledger: Option<i32> = sqlx::query_scalar(r#"SELECT "mediaId" FROM discovered_works"#)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(ledger, Some(id));

    refresh_follows(&c.st).await.unwrap();
    assert_eq!(
        c.count("SELECT count(*) FROM media WHERE type = 'book'")
            .await,
        1
    );
    assert_eq!(c.count("SELECT count(*) FROM discovered_works").await, 1);

    let (_, cal) = c
        .admin(
            "GET",
            "/api/media/calendar?start=2999-01-01&end=2999-01-31&type=book",
            None,
        )
        .await;
    assert_eq!(cal[0]["type"], "book");
    assert_eq!(cal[0]["event"], "release");
}

#[sqlx::test(migrations = false)]
async fn overlapping_runs_add_a_title_once(pool: PgPool) {
    let c = ctx(pool).await;
    follow(&c).await;
    let (a, b) = tokio::join!(refresh_follows(&c.st), refresh_follows(&c.st));
    a.unwrap();
    b.unwrap();
    assert_eq!(
        c.count("SELECT count(*) FROM media WHERE type = 'book'")
            .await,
        1
    );
    assert_eq!(c.count("SELECT count(*) FROM discovered_works").await, 1);
}

#[sqlx::test(migrations = false)]
async fn a_deleted_title_is_not_added_again(pool: PgPool) {
    let c = ctx(pool).await;
    follow(&c).await;
    refresh_follows(&c.st).await.unwrap();
    sqlx::query("DELETE FROM media WHERE type = 'book'")
        .execute(&c.pool)
        .await
        .unwrap();
    refresh_follows(&c.st).await.unwrap();
    assert_eq!(
        c.count("SELECT count(*) FROM media WHERE type = 'book'")
            .await,
        0
    );
}

#[sqlx::test(migrations = false)]
async fn a_follow_removed_or_paused_adds_nothing(pool: PgPool) {
    let c = ctx(pool).await;
    follow(&c).await;
    let job = refresh::Job::author(1, 1, "Una Roe", "2020-01-01".parse().unwrap());
    sqlx::query(r#"DELETE FROM person_follows"#)
        .execute(&c.pool)
        .await
        .unwrap();
    assert!(!refresh::add(&c.st, &job, "OL9W").await.unwrap());
    follow(&c).await;
    sqlx::query(r#"UPDATE person_follows SET "newReleases" = false"#)
        .execute(&c.pool)
        .await
        .unwrap();
    refresh_follows(&c.st).await.unwrap();
    assert!(!refresh::add(&c.st, &job, "OL9W").await.unwrap());
    assert_eq!(
        c.count("SELECT count(*) FROM media WHERE type = 'book'")
            .await,
        0
    );
}

#[sqlx::test(migrations = false)]
async fn a_follower_who_may_no_longer_add_adds_nothing(pool: PgPool) {
    let c = ctx(pool).await;
    follow(&c).await;
    sqlx::query("UPDATE users SET enabled = false WHERE id = 1")
        .execute(&c.pool)
        .await
        .unwrap();
    refresh_follows(&c.st).await.unwrap();
    assert_eq!(
        c.count("SELECT count(*) FROM media WHERE type = 'book'")
            .await,
        0
    );
    sqlx::query("UPDATE users SET enabled = true WHERE id = 1")
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM person_follows")
        .execute(&c.pool)
        .await
        .unwrap();
    // the reader has no media.create
    sqlx::query(
        r#"INSERT INTO person_follows ("userId", "personId", role, "libraryId", wants, since)
           VALUES (2, 1, 'author', 1, '[{"family":"text"}]', '2020-01-01')"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    refresh_follows(&c.st).await.unwrap();
    assert_eq!(
        c.count("SELECT count(*) FROM media WHERE type = 'book'")
            .await,
        0
    );
    // and an admin who lost the library is skipped too
    sqlx::query("DELETE FROM person_follows")
        .execute(&c.pool)
        .await
        .unwrap();
    follow(&c).await;
    sqlx::query("DELETE FROM media_credits")
        .execute(&c.pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM person_external_ids")
        .execute(&c.pool)
        .await
        .unwrap();
    refresh_follows(&c.st).await.unwrap();
    assert_eq!(
        c.count("SELECT count(*) FROM media WHERE type = 'book'")
            .await,
        0
    );
}

#[sqlx::test(migrations = false)]
async fn a_deleted_quality_profile_is_dropped_and_a_bad_one_is_refused(pool: PgPool) {
    let c = ctx(pool).await;
    let bad = json!({"libraryId": 1, "wants": [{"family": "text", "qualityProfileId": 99999}]});
    assert_eq!(
        c.admin("PUT", "/api/persons/1/follow", Some(bad)).await.0,
        400
    );
    sqlx::query(
        r#"INSERT INTO person_follows ("userId", "personId", role, "libraryId", wants, since)
           VALUES (1, 1, 'author', 1, '[{"family":"text","qualityProfileId":99999}]', '2020-01-01')"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    refresh_follows(&c.st).await.unwrap();
    assert_eq!(
        c.count("SELECT count(*) FROM media WHERE type = 'book'")
            .await,
        1
    );
    assert_eq!(
        c.count("SELECT count(*) FROM wants WHERE \"qualityProfileId\" IS NOT NULL")
            .await,
        0
    );
    let body = json!({"type": "book", "provider": "openlibrary", "externalId": "OL8W",
                      "wants": [{"family": "text", "qualityProfileId": 99999}]});
    assert_eq!(
        c.admin("POST", "/api/media/import", Some(body)).await.0,
        400
    );
}

#[sqlx::test(migrations = false)]
async fn a_year_only_title_of_the_follow_year_is_new(pool: PgPool) {
    let c = ctx(pool).await;
    let mut fake = provider();
    fake.found = vec![json!({"externalId": "OL9W", "title": "Beta", "year": 2999,
                             "authors": [{"name": "Una Roe", "id": "OL7A"}]})];
    let st = state(&c.pool, vec![fake]);
    sqlx::query(
        r#"INSERT INTO person_follows ("userId", "personId", role, "libraryId", wants, since)
           VALUES (1, 1, 'author', 1, '[{"family":"text"}]', '2999-06-01')"#,
    )
    .execute(&c.pool)
    .await
    .unwrap();
    refresh_follows(&st).await.unwrap();
    assert_eq!(
        c.count("SELECT count(*) FROM media WHERE type = 'book'")
            .await,
        1
    );
}

#[sqlx::test(migrations = false)]
async fn a_file_goes_to_the_folder_of_a_language_specific_want(pool: PgPool) {
    let c = ctx(pool).await;
    let id = c.book().await;
    let extra: i32 = sqlx::query_scalar(
        r#"INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b/extra') RETURNING id"#,
    )
    .fetch_one(&c.pool)
    .await
    .unwrap();
    c.admin(
        "PUT",
        &format!("/api/media/{id}/wants"),
        Some(json!({"wants": [{"family": "text", "language": "fr"}]})),
    )
    .await;
    sqlx::query(r#"UPDATE wants SET "folderId" = $1 WHERE "mediaId" = $2"#)
        .bind(extra)
        .bind(id)
        .execute(&c.pool)
        .await
        .unwrap();
    let f = crate::ingest::books::folder_for(
        &c.pool,
        id,
        fliks_domain::media::family::Family::Text,
        None,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(f.id, extra);
}

#[sqlx::test(migrations = false)]
async fn a_series_watch_adds_the_new_volume_of_its_series(pool: PgPool) {
    let c = ctx(pool).await;
    let mut fake = provider();
    fake.found = vec![
        json!({"externalId": "OL9W", "title": "Vol 3", "releaseDate": "2999-01-01",
        "authors": [{"name": "Una Roe", "id": "OL7A"}], "series": [{"name": "The Cycle", "position": "3"}]}),
        json!({"externalId": "OL10W", "title": "Other", "releaseDate": "2999-01-01",
        "authors": [{"name": "Una Roe", "id": "OL7A"}], "series": [{"name": "Another", "position": "1"}]}),
    ];
    let st = state(&c.pool, vec![fake]);
    let id = c.book().await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO collections (id, name) VALUES (1, 'The Cycle');
           INSERT INTO collection_entries ("collectionId", "mediaId", position) VALUES (1, {id}, 1);
           INSERT INTO media_credits ("mediaId", "personId", role, position) VALUES ({id}, 1, 'author', 0);"#
    )))
    .execute(&c.pool)
    .await
    .unwrap();
    let uri = "/api/collections/1/watch";
    assert_eq!(
        c.admin("PUT", uri, Some(json!({"libraryId": 1}))).await.0,
        200
    );
    assert_eq!(c.admin("GET", uri, None).await.1["watch"]["libraryId"], 1);
    refresh_follows(&st).await.unwrap();
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT value FROM media_external_ids WHERE provider = 'openlibrary' ORDER BY value",
    )
    .fetch_all(&c.pool)
    .await
    .unwrap();
    assert_eq!(ids, vec!["OL9W".to_owned()]);
    assert_eq!(c.admin("DELETE", uri, None).await.0, 204);
}

#[sqlx::test(migrations = false)]
async fn an_import_creates_the_book_with_the_chosen_wants(pool: PgPool) {
    let c = ctx(pool).await;
    let body = json!({"type": "book", "provider": "openlibrary", "externalId": "OL9W", "libraryId": 1,
                      "wants": [{"family": "text", "language": "fr"}, {"family": "audio", "language": "en"}]});
    let (s, v) = c.admin("POST", "/api/media/import", Some(body)).await;
    assert_eq!(s, 201, "{v}");
    let id = v["id"].as_i64().unwrap();
    let (_, w) = c
        .admin("GET", &format!("/api/media/{id}/wants"), None)
        .await;
    assert_eq!(
        wants_of(&w),
        vec![
            ("audio".into(), Some("en".into())),
            ("text".into(), Some("fr".into()))
        ]
    );
    let bad = json!({"type": "book", "provider": "openlibrary", "externalId": "OL8W", "wants": [{"family": "video"}]});
    assert_eq!(c.admin("POST", "/api/media/import", Some(bad)).await.0, 400);
}

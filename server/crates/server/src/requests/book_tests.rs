//! Book requests (`docs/spec/requests.md` rules 45-50) through the real routers over a fake Open Library.
use super::Lifecycle;
use crate::{
    media,
    metadata::books::tests::{anchor, state},
    state::AppState,
};
use axum::{Router, body::Body, http::Request};
use fliks_domain::media::{family::Family, wants::WantSpec};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::time::{Duration, Instant};
use tower::ServiceExt;

struct Ctx {
    app: Router,
    st: AppState,
    pool: PgPool,
    admin: String,
    user: String,
    manager: String,
    reader: String,
}

async fn ctx(pool: PgPool) -> Ctx {
    slow_ctx(pool, Duration::ZERO).await
}

async fn slow_ctx(pool: PgPool, delay: Duration) -> Ctx {
    crate::db::migrate(&pool).await.unwrap();
    let mut ol = anchor();
    ol.delay = delay;
    for n in 2..=9 {
        ol.works.insert(
            format!("OL{n}W"),
            json!({"title": format!("Title {n}"), "year": 2001}),
        );
    }
    let st = state(&pool, vec![ol]);
    sqlx::raw_sql(
        r#"
        INSERT INTO roles (id, name, permissions, "isDefault") VALUES
          (1, 'U', '["media.read","requests.create"]', false),
          (2, 'M', '["media.read","requests.create","requests.manage"]', false),
          (3, 'R', '["media.read"]', false);
        INSERT INTO users (id, username, "isAdmin", "roleId") VALUES
          (1, 'admin', true, NULL), (2, 'user', false, 1), (3, 'manager', false, 2), (4, 'reader', false, 3);
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'Books', '["book"]');
        INSERT INTO library_folders ("libraryId", path) VALUES (1, '/b/one');
        INSERT INTO quality_profiles (id, name, family, cutoff, items)
          VALUES (1, 'Text', 'text', 1, '[]'), (2, 'Audio', 'audio', 1, '[]');
        INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 2), (1, 3), (1, 4);
        INSERT INTO user_quotas ("userId", kind, "limit") VALUES (2, 'book', 2);
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let tok = |id, name| st.jwt.sign_access(id, name).unwrap().token;
    Ctx {
        admin: tok(1, "admin"),
        user: tok(2, "user"),
        manager: tok(3, "manager"),
        reader: tok(4, "reader"),
        app: media::router()
            .merge(super::router())
            .with_state(st.clone()),
        pool,
        st,
    }
}

impl Ctx {
    async fn call(&self, tok: &str, method: &str, uri: &str, body: Value) -> (u16, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {tok}"))
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status().as_u16();
        let b = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }

    async fn request(&self, tok: &str, work: &str, wants: Value) -> (u16, Value) {
        let body = json!({"mediaType": "book", "externalId": work, "title": work, "wants": wants});
        self.call(tok, "POST", "/api/requests", body).await
    }

    async fn wants(&self, media: i32) -> Vec<(String, Option<String>)> {
        sqlx::query_as(
            "SELECT family, language FROM wants WHERE \"mediaId\" = $1 ORDER BY family, language NULLS FIRST",
        )
        .bind(media)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }
}

fn want(family: &str, language: Option<&str>) -> Value {
    let profile = if family == "audio" { 2 } else { 1 };
    json!({"family": family, "language": language, "qualityProfileId": profile})
}

fn import_body() -> Value {
    json!({"type": "book", "provider": "openlibrary", "externalId": "OL2W",
           "wants": [want("text", None), want("audio", None)]})
}

#[sqlx::test(migrations = false)]
async fn a_book_is_requested_per_edition(pool: PgPool) {
    let c = ctx(pool).await;
    let (s, r) = c
        .request(&c.user, "OL2W", json!([want("text", Some("fr"))]))
        .await;
    assert_eq!(
        (s, &r["status"], &r["tmdbId"]),
        (201, &json!("pending"), &Value::Null),
        "{r}"
    );
    assert_eq!(
        (&r["externalId"], &r["wants"][0]["family"]),
        (&json!("OL2W"), &json!("text"))
    );
    let (_, state) = c
        .call(
            &c.user,
            "GET",
            "/api/requests/title-state?mediaType=book&externalId=OL2W",
            json!(null),
        )
        .await;
    assert_eq!(
        (&state["requested"], &state["requestedWants"][0]["language"]),
        (&json!(true), &json!("fr"))
    );

    for (wants, clash) in [
        (json!([want("text", Some("fr"))]), true),
        (json!([want("text", None)]), true),
        (json!([want("text", Some("en"))]), false),
    ] {
        let (s, r) = c.request(&c.manager, "OL2W", wants).await;
        assert_eq!(s, if clash { 409 } else { 201 }, "{r}");
    }
    for body in [
        json!({"mediaType": "book", "externalId": "OL2W", "title": "t"}),
        json!({"mediaType": "book", "externalId": "10", "title": "t", "wants": [want("text", None)]}),
        json!({"mediaType": "book", "tmdbId": 10, "title": "t", "wants": [want("text", None)]}),
        json!({"mediaType": "book", "externalId": "OL3W", "title": "t", "wants": [want("video", None)]}),
    ] {
        assert_eq!(
            c.call(&c.user, "POST", "/api/requests", body.clone())
                .await
                .0,
            400,
            "{body}"
        );
    }
}

#[sqlx::test(migrations = false)]
async fn concurrent_requests_cannot_pass_the_quota_together(pool: PgPool) {
    let c = ctx(pool).await;
    let calls = (2..=9).map(|n| {
        let (app, tok) = (c.app.clone(), c.user.clone());
        tokio::spawn(async move {
            let body = json!({"mediaType": "book", "externalId": format!("OL{n}W"), "title": "t",
                              "wants": [want("text", None)]});
            let req = Request::builder()
                .method("POST")
                .uri("/api/requests")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {tok}"))
                .body(Body::from(body.to_string()))
                .unwrap();
            let res = app.oneshot(req).await.unwrap();
            let status = res.status().as_u16();
            if status == 500 {
                eprintln!(
                    "{:?}",
                    axum::body::to_bytes(res.into_body(), usize::MAX).await
                );
            }
            status
        })
    });
    let mut codes = vec![];
    for h in calls.collect::<Vec<_>>() {
        codes.push(h.await.unwrap());
    }
    assert_eq!(codes.iter().filter(|s| **s == 201).count(), 2, "{codes:?}");
    assert_eq!(codes.iter().filter(|s| **s == 403).count(), 6, "{codes:?}");
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM requests WHERE \"userId\" = 2")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(n, 2);
}

#[sqlx::test(migrations = false)]
async fn only_a_manager_approves_and_the_book_gets_the_requested_wants(pool: PgPool) {
    let c = ctx(pool).await;
    let wants = json!([want("text", Some("fr")), want("audio", Some("en"))]);
    let (_, r) = c.request(&c.user, "OL2W", wants).await;
    let uri = format!("/api/requests/{}/approve", r["id"]);
    for tok in [&c.user, &c.reader] {
        assert_eq!(c.call(tok, "POST", &uri, json!({})).await.0, 403);
    }
    let (s, r) = c.call(&c.manager, "POST", &uri, json!({})).await;
    assert_eq!((s, &r["status"]), (201, &json!("approved")), "{r}");
    let media = r["mediaId"].as_i64().unwrap() as i32;
    assert_eq!(
        c.wants(media).await,
        [
            ("audio".into(), Some("en".into())),
            ("text".into(), Some("fr".into()))
        ]
    );
    let monitored: bool = sqlx::query_scalar("SELECT monitored FROM media WHERE id = $1")
        .bind(media)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert!(monitored);
    assert_eq!(c.call(&c.manager, "POST", &uri, json!({})).await.0, 409);
}

#[sqlx::test(migrations = false)]
async fn a_book_already_in_the_library_gets_the_wants_added(pool: PgPool) {
    let c = ctx(pool).await;
    let body = import_body();
    let (s, m) = c.call(&c.admin, "POST", "/api/media/import", body).await;
    assert_eq!(s, 201, "{m}");
    let media = m["id"].as_i64().unwrap() as i32;
    let (_, r) = c
        .request(&c.user, "OL2W", json!([want("audio", Some("fr"))]))
        .await;
    let uri = format!("/api/requests/{}/approve", r["id"]);
    let (s, r) = c.call(&c.manager, "POST", &uri, json!({})).await;
    assert_eq!((s, &r["mediaId"]), (201, &json!(media)), "{r}");
    assert_eq!(
        c.wants(media).await,
        [
            ("audio".into(), None),
            ("audio".into(), Some("fr".into())),
            ("text".into(), None)
        ]
    );
}

#[sqlx::test(migrations = false)]
async fn a_request_is_available_once_every_want_has_a_part(pool: PgPool) {
    let c = ctx(pool).await;
    let wants = json!([want("text", Some("fr")), want("audio", Some("en"))]);
    let (_, r) = c.request(&c.user, "OL2W", wants).await;
    let id = r["id"].as_i64().unwrap();
    let uri = format!("/api/requests/{id}/approve");
    let (_, r) = c.call(&c.manager, "POST", &uri, json!({})).await;
    let media = r["mediaId"].as_i64().unwrap();
    let status = async || -> String {
        Lifecycle::of(&c.st)
            .on_import_complete(media as i32)
            .await
            .unwrap();
        sqlx::query_scalar("SELECT status::text FROM requests WHERE id = $1")
            .bind(id as i32)
            .fetch_one(&c.pool)
            .await
            .unwrap()
    };
    assert_eq!(status().await, "approved");
    for (n, family, language) in [(0, "text", "fr"), (1, "audio", "fr"), (2, "audio", "en")] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            r#"INSERT INTO editions (id, "mediaId", family, language) VALUES ({e}, {media}, '{family}', '{language}');
               INSERT INTO items (id, "mediaId", "editionId", monitored) VALUES ({i}, {media}, {e}, true);
               INSERT INTO media_files (id, "mediaId", "relativePath", size, quality, "folderId")
                 VALUES ({f}, {media}, 'f{n}', 1, 'x', (SELECT id FROM library_folders WHERE "libraryId" = 1));
               INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") VALUES ({i}, {f}, {media}, 0);"#,
            e = 500 + n,
            i = 600 + n,
            f = 700 + n
        )))
        .execute(&c.pool)
        .await
        .unwrap();
        let expected = if n == 0 { "approved" } else { "available" };
        // the French audio edition does not satisfy the English want
        let expected = if n == 1 { "approved" } else { expected };
        assert_eq!(status().await, expected, "after {family}-{language}");
    }
}

#[sqlx::test(migrations = false)]
async fn a_grab_starts_only_the_requests_wishing_its_family(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, r) = c
        .request(&c.user, "OL2W", json!([want("text", Some("fr"))]))
        .await;
    let id = r["id"].as_i64().unwrap() as i32;
    let uri = format!("/api/requests/{id}/approve");
    let (_, r) = c.call(&c.manager, "POST", &uri, json!({})).await;
    let media = r["mediaId"].as_i64().unwrap() as i32;
    let status = async || -> String {
        sqlx::query_scalar("SELECT status::text FROM requests WHERE id = $1")
            .bind(id)
            .fetch_one(&c.pool)
            .await
            .unwrap()
    };
    let lc = Lifecycle::of(&c.st);
    lc.mark_in_progress(media, None, Family::Audio)
        .await
        .unwrap();
    assert_eq!(status().await, "approved");
    lc.mark_in_progress(media, None, Family::Text)
        .await
        .unwrap();
    assert_eq!(status().await, "processing");
}

#[sqlx::test(migrations = false)]
async fn auto_approval_reads_the_book_kind_and_fails_closed_on_tmdb_facts(pool: PgPool) {
    let c = ctx(pool).await;
    let rule = async |criteria: Value| {
        let body = json!({"name": "r", "criteria": criteria});
        assert_eq!(
            c.call(&c.admin, "POST", "/api/auto-approval-rules", body)
                .await
                .0,
            201
        );
    };
    rule(json!({"mediaType": "book", "genreIds": [1]})).await;
    let (_, r) = c
        .request(&c.manager, "OL2W", json!([want("text", None)]))
        .await;
    assert_eq!(r["status"], "pending", "genre criteria cannot match a book");
    rule(json!({"mediaType": "book", "userIds": [3]})).await;
    let (s, r) = c
        .request(&c.manager, "OL3W", json!([want("text", Some("de"))]))
        .await;
    assert_eq!((s, &r["status"]), (201, &json!("approved")), "{r}");
    assert!(r["media"]["id"].is_i64(), "{r}");
    let (_, r) = c
        .request(&c.user, "OL4W", json!([want("text", None)]))
        .await;
    assert_eq!(r["status"], "pending", "the rule names another user");
    rule(json!({"mediaType": "book", "maxSeasons": 1, "userIds": [2]})).await;
    let (_, r) = c
        .request(&c.user, "OL5W", json!([want("text", None)]))
        .await;
    assert_eq!(r["status"], "approved", "maxSeasons is ignored for a book");
}

#[sqlx::test(migrations = false)]
async fn concurrent_approvals_of_one_work_keep_every_edition_wished(pool: PgPool) {
    let c = ctx(pool).await;
    let import = |w: WantSpec| {
        let st = c.st.clone();
        tokio::spawn(async move {
            crate::media::write::import_book_for_request(
                &st,
                "OL6W",
                &[w],
                (Some(1), None),
                (Some(2), &[1]),
            )
            .await
            .map_err(|e| e.status())
        })
    };
    let spec = |family, language: &str| WantSpec {
        family,
        language: Some(language.into()),
        quality_profile_id: None,
    };
    let (a, b) = (
        import(spec(Family::Text, "fr")),
        import(spec(Family::Audio, "en")),
    );
    let (a, b) = (a.await.unwrap().unwrap(), b.await.unwrap().unwrap());
    assert_eq!(a, b);
    assert_eq!(
        c.wants(a).await,
        [
            ("audio".into(), Some("en".into())),
            ("text".into(), Some("fr".into()))
        ]
    );
}

#[sqlx::test(migrations = false)]
async fn a_book_request_needs_a_profile_on_every_want(pool: PgPool) {
    let c = ctx(pool).await;
    let wants = json!([want("text", None), {"family": "audio"}]);
    let (s, r) = c.request(&c.user, "OL2W", wants).await;
    assert_eq!(
        (s, &r["message"]),
        (400, &json!(["A quality profile is required"])),
        "{r}"
    );
}

#[sqlx::test(migrations = false)]
async fn a_book_delete_request_takes_no_wants(pool: PgPool) {
    let c = ctx(pool).await;
    let body = json!({"mediaType": "book", "kind": "delete", "externalId": "OL2W", "title": "t",
                      "wants": [want("text", None)]});
    assert_eq!(c.call(&c.user, "POST", "/api/requests", body).await.0, 400);
}

#[sqlx::test(migrations = false)]
async fn requesting_needs_the_requests_permission(pool: PgPool) {
    let c = ctx(pool).await;
    assert_eq!(
        c.request(&c.reader, "OL2W", json!([want("text", None)]))
            .await
            .0,
        403
    );
    assert_eq!(
        c.request("", "OL2W", json!([want("text", None)])).await.0,
        401
    );
}

#[sqlx::test(migrations = false)]
async fn an_auto_approved_import_holds_no_lock_while_the_provider_answers(pool: PgPool) {
    let c = slow_ctx(pool, Duration::from_secs(3)).await;
    let rule = json!({"name": "r", "criteria": {"mediaType": "book"}});
    assert_eq!(
        c.call(&c.admin, "POST", "/api/auto-approval-rules", rule)
            .await
            .0,
        201
    );
    let folder: i32 = sqlx::query_scalar("SELECT id FROM library_folders WHERE \"libraryId\" = 1")
        .fetch_one(&c.pool)
        .await
        .unwrap();
    let body = json!({"mediaType": "book", "externalId": "OL2W", "title": "t", "folderId": folder,
                      "wants": [want("text", None)]});
    let slow = {
        let (app, tok) = (c.app.clone(), c.user.clone());
        tokio::spawn(async move {
            let req = Request::builder()
                .method("POST")
                .uri("/api/requests")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {tok}"))
                .body(Body::from(body.to_string()))
                .unwrap();
            app.oneshot(req).await.unwrap().status().as_u16()
        })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let t = Instant::now();
    let mut tx = c.pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout = '1s'")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("SELECT 1 FROM library_folders WHERE id = $1 FOR UPDATE")
        .bind(folder)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert!(t.elapsed() < Duration::from_secs(1));
    let (s, other) = c
        .request(&c.manager, "OL2W", json!([want("text", None)]))
        .await;
    assert_eq!(
        s, 409,
        "the approved row answers the duplicate guard at once: {other}"
    );
    assert_eq!(slow.await.unwrap(), 201);
}

#[sqlx::test(migrations = false)]
async fn a_failed_auto_approved_import_inserts_nothing(pool: PgPool) {
    let c = ctx(pool).await;
    let rule = json!({"name": "r", "criteria": {"mediaType": "book"}});
    c.call(&c.admin, "POST", "/api/auto-approval-rules", rule)
        .await;
    let (s, _) = c
        .request(&c.user, "OL404W", json!([want("text", None)]))
        .await;
    assert!(s >= 400, "{s}");
    let n: i64 =
        sqlx::query_scalar("SELECT count(*) FROM requests WHERE \"externalId\" = 'OL404W'")
            .fetch_one(&c.pool)
            .await
            .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test(migrations = false)]
async fn an_existing_work_only_gets_the_missing_wants_and_stays_inside_the_requesters_libraries(
    pool: PgPool,
) {
    let c = ctx(pool).await;
    let body = import_body();
    let (_, m) = c.call(&c.admin, "POST", "/api/media/import", body).await;
    let media = m["id"].as_i64().unwrap() as i32;
    let before: Vec<(String, Option<i32>)> = sqlx::query_as(
        "SELECT family, \"qualityProfileId\" FROM wants WHERE \"mediaId\" = $1 ORDER BY family",
    )
    .bind(media)
    .fetch_all(&c.pool)
    .await
    .unwrap();
    let wants = json!([want("text", None), want("audio", Some("fr"))]);
    let (_, r) = c.request(&c.user, "OL2W", wants).await;
    let uri = format!("/api/requests/{}/approve", r["id"]);
    // the requester loses the library: the approval is refused and the request stays pending
    sqlx::query("DELETE FROM library_user_access WHERE \"userId\" = 2")
        .execute(&c.pool)
        .await
        .unwrap();
    let (s, r) = c.call(&c.manager, "POST", &uri, json!({})).await;
    assert_eq!(
        (s, &r["message"]),
        (403, &json!("errors.book_library_not_accessible")),
        "{r}"
    );
    sqlx::query("INSERT INTO library_user_access (\"libraryId\", \"userId\") VALUES (1, 2)")
        .execute(&c.pool)
        .await
        .unwrap();
    assert_eq!(c.call(&c.manager, "POST", &uri, json!({})).await.0, 201);
    let after: Vec<(String, Option<i32>)> =
        sqlx::query_as("SELECT family, \"qualityProfileId\" FROM wants WHERE \"mediaId\" = $1 AND language IS NULL ORDER BY family")
            .bind(media)
            .fetch_all(&c.pool)
            .await
            .unwrap();
    assert_eq!(after, before, "the existing wants are untouched");
    assert_eq!(c.wants(media).await.len(), before.len() + 1);
}

#[sqlx::test(migrations = false)]
async fn a_book_request_refuses_a_request_level_profile_patch(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, r) = c
        .request(&c.user, "OL2W", json!([want("text", None)]))
        .await;
    let uri = format!("/api/requests/{}", r["id"]);
    for body in [
        json!({"qualityProfileId": 1}),
        json!({"languageProfileId": null}),
    ] {
        assert_eq!(c.call(&c.user, "PATCH", &uri, body).await.0, 400);
    }
    assert_eq!(
        c.call(&c.user, "PATCH", &uri, json!({"libraryId": 1}))
            .await
            .0,
        200
    );
}

#[sqlx::test(migrations = false)]
async fn a_lock_timeout_answers_busy_not_500(pool: PgPool) {
    use super::{TitleKey, db, flow::lock_err};
    use fliks_domain::media::kind::MediaKind;
    let key = TitleKey::tmdb(MediaKind::Movie, 1);
    let mut holder = pool.begin().await.unwrap();
    db::lock_title(&mut holder, &key).await.unwrap();
    db::lock_user_quota(&mut holder, 2).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout = '100ms'")
        .execute(&mut *tx)
        .await
        .unwrap();
    let e = db::lock_title(&mut tx, &key).await.unwrap_err();
    assert_eq!(lock_err(e, true).status().as_u16(), 409);
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL lock_timeout = '100ms'")
        .execute(&mut *tx)
        .await
        .unwrap();
    let e = db::lock_user_quota(&mut tx, 2).await.unwrap_err();
    assert_eq!(lock_err(e, false).status().as_u16(), 503);
}

#[sqlx::test(migrations = false)]
async fn an_approved_request_without_media_returns_to_pending_after_an_hour(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, r) = c
        .request(&c.user, "OL2W", json!([want("text", None)]))
        .await;
    let id = r["id"].as_i64().unwrap() as i32;
    let age = async |hours: i32| {
        sqlx::query(
            "UPDATE requests SET status = 'approved', \"approvedById\" = 3, \"mediaId\" = NULL WHERE id = $1",
        )
        .bind(id)
        .execute(&c.pool)
        .await
        .unwrap();
        sqlx::query("ALTER TABLE requests DISABLE TRIGGER set_updated_at")
            .execute(&c.pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE requests SET \"updatedAt\" = now() - make_interval(hours => $2) WHERE id = $1",
        )
        .bind(id)
        .bind(hours)
        .execute(&c.pool)
        .await
        .unwrap();
        sqlx::query("ALTER TABLE requests ENABLE TRIGGER set_updated_at")
            .execute(&c.pool)
            .await
            .unwrap();
        super::db::reset_orphans(&c.pool).await.unwrap()
    };
    assert_eq!(age(0).await, 0, "an import may still be running");
    assert_eq!(age(2).await, 1);
    let status: String = sqlx::query_scalar("SELECT status::text FROM requests WHERE id = $1")
        .bind(id)
        .fetch_one(&c.pool)
        .await
        .unwrap();
    assert_eq!(status, "pending");
}

#[sqlx::test(migrations = false)]
async fn an_approval_holds_no_title_lock_while_the_provider_answers(pool: PgPool) {
    let c = slow_ctx(pool, Duration::from_secs(3)).await;
    let (_, r) = c
        .request(&c.user, "OL2W", json!([want("text", Some("fr"))]))
        .await;
    let slow = {
        let (app, tok, uri) = (
            c.app.clone(),
            c.manager.clone(),
            format!("/api/requests/{}/approve", r["id"]),
        );
        tokio::spawn(async move {
            let req = Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {tok}"))
                .body(Body::empty())
                .unwrap();
            app.oneshot(req).await.unwrap().status().as_u16()
        })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;
    let t = Instant::now();
    let (s, other) = c
        .request(&c.user, "OL2W", json!([want("text", Some("fr"))]))
        .await;
    assert_eq!(
        s, 409,
        "the approved row answers the duplicate guard: {other}"
    );
    assert!(t.elapsed() < Duration::from_secs(2));
    assert_eq!(slow.await.unwrap(), 201);
}

#[sqlx::test(migrations = false)]
async fn a_pending_requests_wants_are_edited_before_approval(pool: PgPool) {
    let c = ctx(pool).await;
    let (_, r) = c
        .request(&c.user, "OL2W", json!([want("text", Some("fr"))]))
        .await;
    let (_, other) = c
        .request(&c.manager, "OL2W", json!([want("audio", Some("en"))]))
        .await;
    let uri = format!("/api/requests/{}", r["id"]);
    let patch = |wants: Value| json!({ "wants": wants });
    assert_eq!(
        c.call(
            &c.user,
            "PATCH",
            &uri,
            patch(json!([want("audio", Some("en"))]))
        )
        .await
        .0,
        409,
        "another active request holds that edition"
    );
    assert_eq!(
        c.call(&c.user, "PATCH", &uri, patch(json!([]))).await.0,
        400
    );
    let (s, r) = c
        .call(
            &c.user,
            "PATCH",
            &uri,
            patch(json!([want("text", Some("en"))])),
        )
        .await;
    assert_eq!((s, &r["wants"][0]["language"]), (200, &json!("en")), "{r}");
    let (s, r) = c
        .call(
            &c.manager,
            "PATCH",
            &uri,
            patch(json!([want("text", None)])),
        )
        .await;
    assert_eq!((s, &r["wants"][0]["language"]), (200, &Value::Null), "{r}");
    let approve = format!("/api/requests/{}/approve", other["id"]);
    assert_eq!(c.call(&c.manager, "POST", &approve, json!({})).await.0, 201);
    let approve = format!("/api/requests/{}/approve", r["id"]);
    assert_eq!(c.call(&c.manager, "POST", &approve, json!({})).await.0, 201);
    assert_eq!(
        c.call(&c.user, "PATCH", &uri, patch(json!([want("text", None)])))
            .await
            .0,
        403,
        "an approved request is no longer editable"
    );
}

#[sqlx::test(migrations = false)]
async fn a_book_whose_wants_are_all_satisfied_is_refused(pool: PgPool) {
    let c = ctx(pool).await;
    let body = import_body();
    let (_, m) = c.call(&c.admin, "POST", "/api/media/import", body).await;
    let media = m["id"].as_i64().unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO editions (id, "mediaId", family, language) VALUES (500, {media}, 'text', 'fr');
           INSERT INTO items (id, "mediaId", "editionId", monitored) VALUES (600, {media}, 500, true);
           INSERT INTO media_files (id, "mediaId", "relativePath", size, quality, "folderId")
             VALUES (700, {media}, 'f', 1, 'x', (SELECT id FROM library_folders WHERE "libraryId" = 1));
           INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", "version") VALUES (600, 700, {media}, 0);"#
    )))
    .execute(&c.pool)
    .await
    .unwrap();
    let (s, r) = c
        .request(&c.user, "OL2W", json!([want("text", Some("fr"))]))
        .await;
    assert_eq!(s, 409, "{r}");
    let (s, r) = c
        .request(
            &c.user,
            "OL2W",
            json!([want("text", Some("fr")), want("audio", Some("fr"))]),
        )
        .await;
    assert_eq!(s, 201, "{r}");
}

#[sqlx::test(migrations = false)]
async fn auto_approval_rules_filter_book_requests_by_family_and_language(pool: PgPool) {
    let c = ctx(pool).await;
    let rule = json!({"name": "r", "criteria": {"families": ["text"], "languages": ["fr"]}});
    assert_eq!(
        c.call(&c.admin, "POST", "/api/auto-approval-rules", rule)
            .await
            .0,
        201
    );
    let bad = json!({"name": "r", "criteria": {"families": ["book"]}});
    assert_eq!(
        c.call(&c.admin, "POST", "/api/auto-approval-rules", bad)
            .await
            .0,
        400
    );
    let (_, r) = c
        .request(&c.user, "OL2W", json!([want("audio", Some("fr"))]))
        .await;
    assert_eq!(r["status"], json!("pending"), "{r}");
    let (_, r) = c
        .request(&c.user, "OL3W", json!([want("text", Some("fr"))]))
        .await;
    assert_eq!(r["status"], json!("approved"), "{r}");
}

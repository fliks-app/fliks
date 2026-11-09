//! Every route that names a media (`items.md` rules 13, 36): a bare pair for a media with several
//! items is a 409 `ambiguous_item`, an `itemId` of a visible edition works and one of a hidden
//! edition is a 404, whichever route takes it.
use crate::session;
use axum::{Router, body::Body, http::Request};
use fliks_server::{app, config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

const SECRET: &str = "0123456789abcdef0123456789abcdef";
const SOON: &str = "2099-01-01T00:00:00Z";

/// Media 10: an album of 3 tracks (items 20-22, one edition, all with a file). Media 11: a book with 2
/// editions (items 23, 24; the edition of 24 sits in library 2, which the caller cannot read). Media
/// 12: an album of 3 tracks of which only item 25 has a file. File `n` belongs to item `n`.
const FIXTURE: &str = r#"
    INSERT INTO libraries (id, name) VALUES (1, 'visible'), (2, 'hidden');
    INSERT INTO library_folders ("libraryId", path) VALUES (1, '/m1'), (2, '/m2');
    INSERT INTO media (id, title, type, "libraryId") VALUES
      (10, 'album three', 'album', 1), (11, 'book', 'book', 1), (12, 'album one of three', 'album', 1);
    INSERT INTO editions (id, "mediaId", family, "libraryId") VALUES
      (10, 10, 'audio', NULL), (11, 11, 'text', NULL), (12, 11, 'text', 2), (13, 12, 'audio', NULL);
    INSERT INTO items (id, "mediaId", "editionId", title) VALUES
      (20, 10, 10, 't1'), (21, 10, 10, 't2'), (22, 10, 10, 't3'), (23, 11, 11, 'x'), (24, 11, 12, 'y'),
      (25, 12, 13, 'u1'), (26, 12, 13, 'u2'), (27, 12, 13, 'u3');
    INSERT INTO track_details ("itemId", "mediaId", "discNumber", position, "durationMs") VALUES
      (20, 10, 1, 1, 1), (21, 10, 1, 2, 1), (22, 10, 1, 3, 1),
      (25, 12, 1, 1, 1), (26, 12, 1, 2, 1), (27, 12, 1, 3, 1);
    INSERT INTO album_details ("mediaId", "targetEditionId") VALUES (10, 10), (12, 13);
    INSERT INTO media_files (id, "mediaId", "folderId", "relativePath", size, quality)
      SELECT i.id, i."mediaId", (SELECT min(id) FROM library_folders), 'f' || i.id, 1, 'q'
      FROM items i WHERE i.id IN (20, 21, 22, 23, 24, 25);
    INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", version, position)
      SELECT id, id, "mediaId", 0, 0 FROM items WHERE id IN (20, 21, 22, 23, 24, 25);
"#;

struct Ctx {
    app: Router,
    token: String,
    friend: i32,
}

async fn ctx(pool: PgPool) -> Ctx {
    fliks_server::db::migrate(&pool).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(FIXTURE))
        .execute(&pool)
        .await
        .unwrap();
    let st = AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET);
    let role: i32 = sqlx::query_scalar(
        r#"INSERT INTO roles (name, permissions, "isDefault") VALUES ('r', '["media.read","parties.create"]', false) RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let user = |name: &'static str, public: bool| {
        let pool = pool.clone();
        async move {
            sqlx::query_scalar::<_, i32>(
                r#"INSERT INTO users (username, "roleId", "profileVisibility")
                   VALUES ($1, $2, CASE WHEN $3 THEN 'public' ELSE 'private' END::users_profilevisibility_enum)
                   RETURNING id"#,
            )
            .bind(name)
            .bind(role)
            .bind(public)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    let (me, friend) = (user("u", false).await, user("v", true).await);
    sqlx::query(r#"INSERT INTO library_user_access ("userId", "libraryId") VALUES ($1, 1)"#)
        .bind(me)
        .execute(&pool)
        .await
        .unwrap();
    Ctx {
        token: session::token(&st, me, "u").await,
        app: app::router(st, None, "/nonexistent".into(), None),
        friend,
    }
}

impl Ctx {
    async fn call(&self, method: &str, uri: &str, body: Value) -> (u16, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {}", self.token))
            .header("x-fliks-kinds", "movie,series,book,comic,album")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
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

    async fn playlist(&self) -> i64 {
        let (s, b) = self
            .call("POST", "/api/playlists", json!({"name": "p"}))
            .await;
        assert_eq!(s, 201, "{b}");
        b["id"].as_i64().unwrap()
    }

    async fn party(&self) -> i64 {
        let items = json!([{"mediaId": 10, "itemId": 20}]);
        let (s, b) = self
            .call(
                "POST",
                "/api/parties",
                json!({"name": "p", "items": items, "scheduledAt": SOON}),
            )
            .await;
        assert_eq!(s, 201, "{b}");
        b["id"].as_i64().unwrap()
    }
}

/// How a media is named: the bare pair, or its `itemId`.
#[derive(Clone, Copy)]
enum Name {
    Bare,
    Item(i32),
}

fn pair(media: i32, name: Name) -> Value {
    match name {
        Name::Bare => json!({"mediaId": media}),
        Name::Item(i) => json!({"mediaId": media, "itemId": i}),
    }
}

/// What a route answers for each case; `None` is "any success".
struct Expect {
    bare_album: u16,
    bare_book: u16,
    bare_partial_album: u16,
    item: u16,
    hidden: u16,
}

const AMBIGUOUS: Expect = Expect {
    bare_album: 409,
    bare_book: 409,
    bare_partial_album: 409,
    item: 200,
    hidden: 404,
};

fn state(media: i32, name: Name) -> String {
    match name {
        Name::Bare => format!("/api/playback/media/{media}/state"),
        Name::Item(i) => format!("/api/playback/media/{media}/state?itemId={i}"),
    }
}

async fn check(what: &str, expect: &Expect, mut run: impl AsyncFnMut(i32, Name) -> (u16, Value)) {
    let cases = [
        ("bare album", 10, Name::Bare, expect.bare_album),
        ("bare book", 11, Name::Bare, expect.bare_book),
        (
            "bare partial album",
            12,
            Name::Bare,
            expect.bare_partial_album,
        ),
        ("item", 10, Name::Item(20), expect.item),
        ("book edition", 11, Name::Item(23), expect.item),
        ("hidden edition", 11, Name::Item(24), expect.hidden),
    ];
    for (case, media, name, want) in cases {
        let (s, b) = run(media, name).await;
        // 200 stands for any success: a create answers 201.
        let ok = if want == 200 {
            (200..300).contains(&s)
        } else {
            s == want
        };
        assert!(ok, "{what}, {case}: expected {want}, got {s}: {b}");
        if want == 409 {
            assert_eq!(b["message"], "ambiguous_item", "{what}, {case}");
        }
    }
}

#[sqlx::test(migrations = false)]
async fn playback_state_routes(pool: PgPool) {
    let c = ctx(pool).await;
    check(
        "GET state",
        &Expect {
            hidden: 200,
            ..AMBIGUOUS
        },
        async |m, n| c.call("GET", &state(m, n), json!({})).await,
    )
    .await;
    check(
        "DELETE state",
        &Expect {
            hidden: 200,
            ..AMBIGUOUS
        },
        async |m, n| c.call("DELETE", &state(m, n), json!({})).await,
    )
    .await;
    check("PUT state", &Expect { hidden: 200, ..AMBIGUOUS }, async |m, n| {
        let body = match n {
            Name::Bare => json!({"mediaFileId": 20, "positionSeconds": 1, "durationSeconds": 10}),
            Name::Item(i) => {
                json!({"mediaFileId": i, "itemId": i, "positionSeconds": 1, "durationSeconds": 10})
            }
        };
        c.call("PUT", &format!("/api/playback/media/{m}/state"), body)
            .await
    })
    .await;
    check("toggle-watched", &AMBIGUOUS, async |m, n| {
        let body = match n {
            Name::Bare => json!({}),
            Name::Item(i) => json!({"itemId": i, "mediaFileId": i}),
        };
        c.call(
            "POST",
            &format!("/api/playback/media/{m}/toggle-watched"),
            body,
        )
        .await
    })
    .await;
}

#[sqlx::test(migrations = false)]
async fn playlist_add(pool: PgPool) {
    let c = ctx(pool).await;
    let want = Expect {
        bare_album: 201,
        bare_book: 409,
        bare_partial_album: 201,
        item: 201,
        hidden: 404,
    };
    check("playlist add", &want, async |m, n| {
        let p = c.playlist().await;
        c.call("POST", &format!("/api/playlists/{p}/items"), pair(m, n))
            .await
    })
    .await;
    let p = c.playlist().await;
    let (_, b) = c
        .call(
            "POST",
            &format!("/api/playlists/{p}/items"),
            json!({"mediaId": 12}),
        )
        .await;
    assert_eq!(
        b["added"], 1,
        "an album with one owned track adds that track"
    );
    let (_, b) = c
        .call(
            "POST",
            &format!("/api/playlists/{p}/items"),
            json!({"mediaId": 10}),
        )
        .await;
    assert_eq!(b["added"], 3);
}

#[sqlx::test(migrations = false)]
async fn party_routes(pool: PgPool) {
    let c = ctx(pool).await;
    check(
        "POST /api/parties items",
        &Expect {
            item: 201,
            ..AMBIGUOUS
        },
        async |m, n| {
            c.call(
                "POST",
                "/api/parties",
                json!({"name": "p", "items": [pair(m, n)], "scheduledAt": SOON}),
            )
            .await
        },
    )
    .await;
    for (media, want) in [(10, 409), (11, 409), (12, 409)] {
        let body = json!({"name": "p", "mediaId": media, "scheduledAt": SOON});
        let (s, b) = c.call("POST", "/api/parties", body).await;
        assert_eq!(
            (s, &b["message"]),
            (want, &json!("ambiguous_item")),
            "top-level {media}"
        );
    }
    let party = c.party().await;
    check("PUT programme", &AMBIGUOUS, async |m, n| {
        c.call(
            "PUT",
            &format!("/api/parties/{party}/programme"),
            json!({"items": [pair(m, n)]}),
        )
        .await
    })
    .await;
    check("POST select", &AMBIGUOUS, async |m, n| {
        c.call("POST", &format!("/api/parties/{party}/select"), pair(m, n))
            .await
    })
    .await;
    check(
        "POST proposals",
        &Expect {
            item: 201,
            ..AMBIGUOUS
        },
        async |m, n| {
            c.call(
                "POST",
                &format!("/api/parties/{party}/proposals"),
                pair(m, n),
            )
            .await
        },
    )
    .await;
}

#[sqlx::test(migrations = false)]
async fn like_and_recommend(pool: PgPool) {
    let c = ctx(pool).await;
    let want = Expect {
        bare_album: 201,
        bare_book: 201,
        bare_partial_album: 201,
        item: 201,
        hidden: 404,
    };
    check("like", &want, async |m, n| {
        c.call("POST", "/api/likes", pair(m, n)).await
    })
    .await;
    check("recommend", &want, async |m, n| {
        let mut body = pair(m, n);
        body["recipientId"] = json!(c.friend);
        c.call("POST", "/api/social/recommend", body).await
    })
    .await;
}

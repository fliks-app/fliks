//! The music model (`music.md`): the album kind, its details, editions, tracks, credits, works and ratings.
use fliks_domain::media::kind::MediaKind;
use sqlx::PgPool;

const MB: &str = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const MB2: &str = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d";

async fn seed(pool: &PgPool) {
    fliks_server::db::migrate(pool).await.unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"
        INSERT INTO users (id, username) VALUES (1, 'u');
        INSERT INTO libraries (id, name, "mediaTypes") VALUES (1, 'L', '["album"]');
        INSERT INTO media (id, title, year, type, "libraryId", "folderName") VALUES (10, 'Alpha', 1973, 'album', 1, 'a');
        INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES (10, 'album', 'musicbrainz', '{MB}');
        INSERT INTO editions (id, "mediaId", family, country, status, media, barcode, "catalogNumber", "trackCount",
          "discCount", "albumGain", "albumPeak")
          VALUES (1, 10, 'audio', 'FR', 'official', 'cd', '0123456789012', 'CAT 1', 2, 2, -7.5, 0.98);
        INSERT INTO items (id, "mediaId", "editionId", title) VALUES (1, 10, 1, 'One'), (2, 10, 1, 'Two');
        INSERT INTO persons (id, name) VALUES (1, 'Ana'), (2, 'Bo');
        "#
    )))
    .execute(pool)
    .await
    .unwrap();
}

async fn refused(pool: &PgPool, sql: &str) -> bool {
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql.to_owned()))
        .execute(pool)
        .await
        .is_err()
}

#[sqlx::test(migrations = false)]
async fn an_album_has_details_a_target_edition_and_a_json_arm(pool: PgPool) {
    seed(&pool).await;
    sqlx::query(r#"INSERT INTO album_details ("mediaId", "primaryType", "secondaryTypes", "isCompilation", popularity)
        VALUES (10, 'album', '{live,remix}', false, 12.5)"#)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(r#"UPDATE album_details SET "targetEditionId" = 1 WHERE "mediaId" = 10"#)
        .execute(&pool)
        .await
        .unwrap();
    let j: serde_json::Value = sqlx::query_scalar("SELECT media_details_json(10)")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (&j["popularity"], &j["budget"]),
        (&serde_json::json!(12.5), &serde_json::Value::Null)
    );
    for bad in [
        r#"UPDATE album_details SET "primaryType" = 'lp'"#,
        r#"UPDATE album_details SET "secondaryTypes" = '{live,nope}'"#,
        r#"UPDATE album_details SET popularity = -1"#,
        // the target edition belongs to the album
        r#"UPDATE album_details SET "targetEditionId" = 99"#,
        r#"INSERT INTO media (id, title, type) VALUES (11, 'B', 'album'); INSERT INTO album_details ("mediaId", kind) VALUES (11, 'movie')"#,
    ] {
        assert!(refused(&pool, bad).await, "{bad}");
    }
    // a removed target edition leaves the album and its other columns alone
    sqlx::query("DELETE FROM editions WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let (t, p): (Option<i32>, Option<String>) = sqlx::query_as(
        r#"SELECT "targetEditionId", "primaryType" FROM album_details WHERE "mediaId" = 10"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((t, p.as_deref()), (None, Some("album")));
}

#[sqlx::test(migrations = false)]
async fn edition_facts_are_checked(pool: PgPool) {
    seed(&pool).await;
    for bad in [
        "country = 'fr'",
        "status = 'live'",
        "media = 'tape'",
        "barcode = '12'",
        r#""catalogNumber" = ''"#,
        r#""trackCount" = -1"#,
        r#""discCount" = 0"#,
        r#""albumPeak" = 0"#,
    ] {
        assert!(
            refused(&pool, &format!("UPDATE editions SET {bad} WHERE id = 1")).await,
            "{bad}"
        );
    }
    sqlx::query(r#"UPDATE editions SET "orphanedAt" = now() WHERE id = 1"#)
        .execute(&pool)
        .await
        .unwrap();
}

#[sqlx::test(migrations = false)]
async fn a_track_is_an_ungrouped_item_with_its_facts_and_credits(pool: PgPool) {
    seed(&pool).await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO track_details ("itemId", "mediaId", "discNumber", "position", "trackNumber", label, "recordingMbid",
             isrc, "durationMs", explicit, gain, peak)
           VALUES (1, 10, 1, 1, 1, 'A1', '{MB}', 'USRC17607839', 61000, true, -6.2, 1.0), (2, 10, 2, 2, 1, NULL, NULL, NULL, NULL, false, NULL, NULL);
           INSERT INTO item_credits ("itemId", "personId", role, position, "creditedName", "joinPhrase")
             VALUES (1, 1, 'artist', 0, 'A.', ' feat. '), (1, 2, 'artist', 1, NULL, NULL), (1, 2, 'performer', 0, NULL, NULL);
           INSERT INTO media_credits ("mediaId", "personId", role, position) VALUES (10, 1, 'artist', 0);"#
    )))
    .execute(&pool)
    .await
    .unwrap();
    let grouped: i64 = sqlx::query_scalar(
        r#"SELECT count(*) FROM items WHERE "mediaId" = 10 AND "groupId" IS NOT NULL"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(grouped, 0, "a disc is never an episode group");
    for bad in [
        r#"UPDATE track_details SET "discNumber" = 0"#,
        r#"UPDATE track_details SET position = 0"#,
        r#"UPDATE track_details SET isrc = 'usrc17607839'"#,
        r#"UPDATE track_details SET "durationMs" = 0"#,
        r#"UPDATE track_details SET gain = 101"#,
        r#"UPDATE track_details SET label = ''"#,
        r#"INSERT INTO track_details ("itemId", "mediaId", position) VALUES (1, 10, 5)"#,
        r#"INSERT INTO track_details ("itemId", "mediaId", position) VALUES (1, 11, 5)"#,
        r#"INSERT INTO item_credits ("itemId", "personId", role, position) VALUES (1, 1, 'artist', 0)"#,
        r#"INSERT INTO item_credits ("itemId", "personId", role, position) VALUES (1, 1, 'producer', 3)"#,
        r#"INSERT INTO item_credits ("itemId", "personId", role, position, instrument) VALUES (1, 1, 'composer', 3, 'oboe')"#,
        r#"INSERT INTO item_credits ("itemId", "personId", role, position, instrument) VALUES (1, 1, 'performer', 3, '')"#,
    ] {
        assert!(refused(&pool, bad).await, "{bad}");
    }
    sqlx::query(
        r#"INSERT INTO item_credits ("itemId", "personId", role, position, instrument) VALUES (1, 1, 'performer', 1, 'oboe')"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    // deleting the item takes its facts and credits
    sqlx::query("DELETE FROM items WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar(
        r#"SELECT (SELECT count(*) FROM track_details WHERE "itemId" = 1) + (SELECT count(*) FROM item_credits WHERE "itemId" = 1)"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(left, 0);
}

#[sqlx::test(migrations = false)]
async fn works_nest_movements_and_ratings_are_per_user(pool: PgPool) {
    seed(&pool).await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO works (id, mbid, title, "composerPersonId") VALUES (1, '{MB}', 'Symphony', 1);
           INSERT INTO works (id, mbid, title, "parentWorkId") VALUES (2, '{MB2}', 'Allegro', 1);
           INSERT INTO item_works ("itemId", "workId", position) VALUES (1, 2, 0), (2, 2, 1);
           INSERT INTO item_ratings ("userId", "itemId", rating) VALUES (1, 1, 5);"#
    )))
    .execute(&pool)
    .await
    .unwrap();
    for bad in [
        format!(r#"INSERT INTO works (mbid, title) VALUES ('{MB}', 'Again')"#),
        r#"INSERT INTO works (title) VALUES ('')"#.into(),
        r#"UPDATE works SET "parentWorkId" = id WHERE id = 1"#.into(),
        r#"INSERT INTO item_ratings ("userId", "itemId", rating) VALUES (1, 2, 0)"#.into(),
        r#"INSERT INTO item_ratings ("userId", "itemId", rating) VALUES (1, 2, 6)"#.into(),
        r#"INSERT INTO item_ratings ("userId", "itemId", rating) VALUES (1, 1, 4)"#.into(),
    ] {
        assert!(refused(&pool, &bad).await, "{bad}");
    }
    // a removed work leaves its movements without a parent and the tracks without the link
    sqlx::query("DELETE FROM works WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let parent: Option<i32> =
        sqlx::query_scalar(r#"SELECT "parentWorkId" FROM works WHERE id = 2"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(parent, None);
    sqlx::query("DELETE FROM items WHERE id = 1")
        .execute(&pool)
        .await
        .unwrap();
    let rated: i64 = sqlx::query_scalar("SELECT count(*) FROM item_ratings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rated, 0);
}

#[sqlx::test(migrations = false)]
async fn musicbrainz_ids_are_uuids_and_name_one_album_and_one_artist(pool: PgPool) {
    seed(&pool).await;
    for bad in [
        // one release group names one album
        format!(r#"INSERT INTO media (id, title, type) VALUES (11, 'Dup', 'album'); INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES (11, 'album', 'musicbrainz', '{MB}')"#),
        r#"INSERT INTO media (id, title, type) VALUES (11, 'Bad', 'album'); INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES (11, 'album', 'musicbrainz', 'nope')"#.into(),
        format!(r#"INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES (10, 'album', 'musicbrainz', '{}')"#, MB.to_uppercase()),
        r#"INSERT INTO edition_external_ids ("editionId", "mediaId", provider, value) VALUES (1, 10, 'musicbrainz', 'x')"#.into(),
        r#"INSERT INTO person_external_ids ("personId", provider, value) VALUES (1, 'musicbrainz', '12')"#.into(),
    ] {
        assert!(refused(&pool, &bad).await, "{bad}");
    }
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO edition_external_ids ("editionId", "mediaId", provider, value) VALUES (1, 10, 'musicbrainz', '{MB}'), (1, 10, 'musicbrainz', '{MB2}');
           INSERT INTO person_external_ids ("personId", provider, value) VALUES (1, 'musicbrainz', '{MB}'), (1, 'tmdb', '5');
           INSERT INTO media_external_id_aliases ("mediaId", kind, provider, value) VALUES (10, 'album', 'musicbrainz', '{MB2}');
           INSERT INTO person_external_id_aliases ("personId", provider, value) VALUES (1, 'musicbrainz', '{MB2}');"#
    )))
    .execute(&pool)
    .await
    .unwrap();
    // an album of the same id is another title in another kind
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO media (id, title, type) VALUES (12, 'M', 'movie');
           INSERT INTO media_external_ids ("mediaId", kind, provider, value) VALUES (12, 'movie', 'musicbrainz', '{MB}');"#
    )))
    .execute(&pool)
    .await
    .unwrap();
    // an alias goes with its media
    sqlx::query("DELETE FROM media WHERE id = 10")
        .execute(&pool)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("SELECT count(*) FROM media_external_id_aliases")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
}

#[sqlx::test(migrations = false)]
async fn an_album_kind_follows_quotas_requests_and_follows(pool: PgPool) {
    seed(&pool).await;
    for ok in [
        r#"INSERT INTO user_quotas ("userId", kind, "limit") VALUES (1, 'album', 3)"#.to_owned(),
        format!(
            r#"INSERT INTO requests ("mediaType", provider, "externalId", title, "userId") VALUES ('album', 'musicbrainz', '{MB}', 'A', 1)"#
        ),
        r#"INSERT INTO person_follows ("userId", "personId", role, "libraryId", wants) VALUES (1, 1, 'artist', 1, '[]')"#.to_owned(),
        r#"INSERT INTO cleanup_rules (name, levels, criteria) VALUES ('r', '{album}', '{}')"#.to_owned(),
    ] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(ok.clone())).execute(&pool).await.unwrap_or_else(|e| panic!("{ok}: {e}"));
    }
    assert!(
        refused(&pool, r#"INSERT INTO person_follows ("userId", "personId", role, "libraryId", wants) VALUES (1, 1, 'singer', 1, '[]')"#)
            .await
    );
    assert_eq!(MediaKind::Album.families().len(), 1);
}

mod api {
    use crate::session;
    use axum::{Router, body::Body, http::Request};
    use fliks_server::{config::Config, media, requests, state::AppState};
    use serde_json::{Value, json};
    use sqlx::PgPool;
    use tower::ServiceExt;

    async fn app(pool: &PgPool) -> (Router, String) {
        super::seed(pool).await;
        sqlx::raw_sql(
            r#"INSERT INTO album_details ("mediaId", popularity) VALUES (10, 3.5);
               INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES (11, 'Beta', 'album', 1, 'b'), (12, 'M', 'movie', 1, 'm')"#,
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::raw_sql(r#"UPDATE users SET "isAdmin" = true WHERE id = 1"#)
            .execute(pool)
            .await
            .unwrap();
        let st = AppState::new(
            pool.clone(),
            Config::from_lookup(|_| None),
            "0123456789abcdef0123456789abcdef",
        );
        let t = session::token(&st, 1, "u").await;
        (media::router().merge(requests::router()).with_state(st), t)
    }

    async fn send(app: &Router, t: &str, method: &str, uri: &str, body: Value) -> (u16, Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("x-fliks-kinds", "movie,series,book,comic,album")
            .header("authorization", format!("Bearer {t}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        let s = res.status().as_u16();
        let b = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }

    #[sqlx::test(migrations = false)]
    async fn an_album_is_read_counted_and_cannot_change_type(pool: PgPool) {
        let (app, t) = app(&pool).await;
        let (s, v) = send(&app, &t, "GET", "/api/media/10", json!({})).await;
        assert_eq!(
            (s, &v["type"], &v["metadata"]["popularity"]),
            (200, &json!("album"), &json!(3.5))
        );
        let (_, c) = send(&app, &t, "GET", "/api/media/counts", json!({})).await;
        assert_eq!(c["albums"], 2);
        for (id, to) in [(10, "movie"), (12, "album")] {
            let (s, b) = send(
                &app,
                &t,
                "PUT",
                &format!("/api/media/{id}"),
                json!({"type": to}),
            )
            .await;
            assert_eq!(s, 400, "{id}");
            assert_eq!(b["message"], "An album cannot change type");
        }
        let (s, b) = send(
            &app,
            &t,
            "POST",
            "/api/requests",
            json!({"mediaType": "album", "tmdbId": 1, "title": "t"}),
        )
        .await;
        assert_eq!(s, 400);
        assert!(
            b.to_string().contains("MusicBrainz release group id"),
            "{b}"
        );
    }
}

//! Snapshots, provenance and locks (`docs/spec/metadata-orchestrator.md` rules 29-37).
use super::{Ctx, ctx, media, person};
use fliks_domain::{
    external_id::ExternalProvider, media::kind::MediaKind, metadata::limiter::Priority,
};
use futures_util::FutureExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

fn sample() -> Value {
    json!({"id": 603, "title": "Sample Film", "overview": "Plot", "release_date": "1999-03-30",
           "status": "Released", "tagline": "t", "genres": [{"id": 28, "name": "Action"}],
           "credits": {"cast": [{"id": 9, "name": "N", "character": "C", "order": 0}], "crew": []}})
}

async fn refresh(c: &Ctx, id: i32) {
    fliks_server::media::write::refresh_metadata(&c.st, id, false, Priority::Background)
        .await
        .unwrap();
}

const BG: Priority = Priority::Background;

type Source = (String, Option<String>, bool);

async fn sources(pool: &PgPool, fields: &str) -> Vec<Source> {
    sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT field, provider, locked FROM media_field_sources
           WHERE "mediaId" = 1 AND field IN ({fields}) ORDER BY field"#
    )))
    .fetch_all(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = false)]
async fn a_refresh_calls_the_provider_each_time_and_records_provenance(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    media(&pool, 1, "movie", Some(603), None, 1).await;
    c.stub.json("/tmdb/3/movie/603", 200, sample());
    refresh(&c, 1).await;
    refresh(&c, 1).await;
    assert_eq!(c.stub.seen("/tmdb/3/movie/603").len(), 2);
    let snaps: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM metadata_snapshots")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(snaps, 0, "a zero TTL stores nothing");
    let got = sources(
        &pool,
        "'title', 'overview', 'genres', 'credits', 'details', 'ids', 'logoUrl'",
    )
    .await;
    let names: Vec<_> = got.iter().map(|(f, ..)| f.as_str()).collect();
    assert_eq!(
        names,
        ["credits", "details", "genres", "ids", "overview", "title"]
    );
    assert!(
        got.iter()
            .all(|(_, p, l)| p.as_deref() == Some("tmdb") && !l)
    );
}

#[sqlx::test(migrations = false)]
async fn a_locked_field_survives_a_refresh(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    media(&pool, 1, "movie", Some(603), None, 1).await;
    person(&pool, 1, "tmdb", 1, "P", "1 day").await;
    sqlx::raw_sql(
        r#"UPDATE media SET overview = 'mine', genres = '["x"]' WHERE id = 1;
           INSERT INTO media_credits (role, character, position, "mediaId", "personId")
             VALUES ('cast', 'A', 1, 1, 1);
           INSERT INTO media_field_sources ("mediaId", field, provider, locked)
             VALUES (1, 'title', NULL, true), (1, 'overview', NULL, true), (1, 'genres', NULL, true),
                    (1, 'credits', NULL, true), (1, 'status', 'tvdb', false)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    c.stub.json("/tmdb/3/movie/603", 200, sample());
    refresh(&c, 1).await;
    let (title, overview, genres, status): (String, String, Value, String) =
        sqlx::query_as(r#"SELECT title, overview, genres, status::text FROM media WHERE id = 1"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        (title.as_str(), overview.as_str(), genres, status.as_str()),
        ("m1", "mine", json!(["x"]), "released")
    );
    let credits: Vec<(String, Option<String>)> =
        sqlx::query_as(r#"SELECT role::text, character FROM media_credits WHERE "mediaId" = 1"#)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(credits, [("cast".into(), Some("A".into()))]);
    let tagline: Option<String> =
        sqlx::query_scalar(r#"SELECT tagline FROM movie_details WHERE "mediaId" = 1"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        tagline.as_deref(),
        Some("t"),
        "an unlocked field still refreshes"
    );
    assert_eq!(
        sources(&pool, "'title', 'credits', 'status'").await,
        [
            ("credits".into(), None, true),
            ("status".into(), Some("tmdb".into()), false),
            ("title".into(), None, true)
        ]
    );
}

fn key(id: &str) -> fliks_server::metadata::Key {
    fliks_server::metadata::Key {
        provider: ExternalProvider::Tmdb,
        resource: "work",
        kind: MediaKind::Movie,
        id: id.into(),
        language: "en-US".into(),
    }
}

#[sqlx::test(migrations = false)]
async fn a_snapshot_answers_inside_its_ttl_and_one_call_serves_concurrent_callers(pool: PgPool) {
    let c = ctx(pool.clone()).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let fetch = || {
        let calls = calls.clone();
        move || {
            async move {
                let n = calls.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                Ok(json!({"call": n}))
            }
            .boxed()
        }
    };
    let count = || calls.load(Ordering::SeqCst);
    let (day, zero) = (Some(Duration::from_secs(86_400)), Some(Duration::ZERO));
    let m = &c.st.metadata;
    let first = m.snapshot(key("1"), BG, day, fetch()).await.unwrap();
    let second = m.snapshot(key("1"), BG, day, fetch()).await.unwrap();
    assert_eq!((first, second), (json!({"call": 0}), json!({"call": 0})));
    assert_eq!(count(), 1, "inside its TTL no call is made");
    sqlx::query(r#"UPDATE metadata_snapshots SET "expiresAt" = now() - interval '1 second'"#)
        .execute(&pool)
        .await
        .unwrap();
    let third = m.snapshot(key("1"), BG, day, fetch()).await.unwrap();
    assert_eq!(
        third,
        json!({"call": 1}),
        "past its TTL the provider is asked again"
    );
    for _ in 0..2 {
        m.snapshot(key("2"), BG, zero, fetch()).await.unwrap();
    }
    assert_eq!(count(), 4, "a zero TTL always calls");
    let shared =
        futures_util::future::join_all((0..5).map(|_| m.snapshot(key("3"), BG, zero, fetch())))
            .await;
    assert!(
        shared
            .iter()
            .all(|r| r.as_ref().unwrap() == &json!({"call": 4}))
    );
    assert_eq!(count(), 5, "concurrent callers share one call");
    let rows: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM metadata_snapshots WHERE "externalId" IN ('2', '3')"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows, 0, "a zero TTL stores nothing");
    m.snapshot(key("4"), BG, None, fetch()).await.unwrap();
    let never: Option<String> = sqlx::query_scalar(
        r#"SELECT "expiresAt"::text FROM metadata_snapshots WHERE "externalId" = '4'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(never, None);
    m.snapshot(key("4"), BG, None, fetch()).await.unwrap();
    assert_eq!(count(), 6, "a never-expiring row answers too");
}

#[sqlx::test(migrations = false)]
async fn pruning_keeps_what_expired_less_than_thirty_days_ago(pool: PgPool) {
    let _c = ctx(pool.clone()).await;
    sqlx::query(
        r#"INSERT INTO metadata_snapshots (provider, resource, kind, "externalId", body, "expiresAt")
           VALUES ('tmdb', 'work', 'movie', 'old', '{}', now() - interval '31 days'),
                  ('tmdb', 'work', 'movie', 'recent', '{}', now() - interval '29 days'),
                  ('tmdb', 'work', 'movie', 'never', '{}', NULL)"#,
    )
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        fliks_server::metadata::prune_snapshots(&pool)
            .await
            .unwrap(),
        1
    );
    let left: Vec<String> =
        sqlx::query_scalar(r#"SELECT "externalId" FROM metadata_snapshots ORDER BY 1"#)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(left, ["never", "recent"]);
}

type Fetch =
    futures_util::future::BoxFuture<'static, Result<Value, fliks_server::metadata::Upstream>>;

fn slow(calls: &Arc<AtomicUsize>) -> impl FnOnce() -> Fetch + use<> {
    let calls = calls.clone();
    move || {
        async move {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(100)).await;
            Ok(json!({"call": n}))
        }
        .boxed()
    }
}

#[sqlx::test(migrations = false)]
async fn a_call_nobody_waits_for_runs_on_and_frees_its_key(pool: PgPool) {
    let c = ctx(pool).await;
    let (m, calls, zero) = (
        &c.st.metadata,
        Arc::new(AtomicUsize::new(0)),
        Some(Duration::ZERO),
    );
    let gave_up = tokio::time::timeout(
        Duration::from_millis(10),
        m.snapshot(key("5"), BG, zero, slow(&calls)),
    )
    .await;
    assert!(gave_up.is_err());
    let joined = m.snapshot(key("5"), BG, zero, slow(&calls)).await.unwrap();
    assert_eq!(
        joined,
        json!({"call": 0}),
        "a new caller joins the running call"
    );
    let fresh = m.snapshot(key("5"), BG, zero, slow(&calls)).await.unwrap();
    assert_eq!(
        fresh,
        json!({"call": 1}),
        "the finished call left nothing behind"
    );
}

#[sqlx::test(migrations = false)]
async fn a_panicking_call_answers_an_error_and_frees_its_key(pool: PgPool) {
    let c = ctx(pool).await;
    let (m, calls, zero) = (
        &c.st.metadata,
        Arc::new(AtomicUsize::new(0)),
        Some(Duration::ZERO),
    );
    let boom = || {
        async move {
            let n: i32 = "x".parse().unwrap();
            Ok(json!(n))
        }
        .boxed()
    };
    let failed = m.snapshot(key("6"), BG, zero, boom).await;
    assert!(matches!(
        failed,
        Err(fliks_server::metadata::MetaError::Upstream(_))
    ));
    let next = m.snapshot(key("6"), BG, zero, slow(&calls)).await.unwrap();
    assert_eq!(next, json!({"call": 0}));
}

#[sqlx::test(migrations = false)]
async fn interactive_and_background_callers_do_not_share_a_call(pool: PgPool) {
    let c = ctx(pool).await;
    let (m, calls, zero) = (
        &c.st.metadata,
        Arc::new(AtomicUsize::new(0)),
        Some(Duration::ZERO),
    );
    let (a, b) = tokio::join!(
        m.snapshot(key("7"), Priority::Interactive, zero, slow(&calls)),
        m.snapshot(key("7"), BG, zero, slow(&calls)),
    );
    assert!(a.is_ok() && b.is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

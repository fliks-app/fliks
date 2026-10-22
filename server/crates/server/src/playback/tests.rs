//! Offline replays (`playedAt`) against the live heartbeat write, on a throwaway database.
use super::{
    db::find_state,
    watched::{Watch, record_watch},
};
use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;

async fn seed(pool: &PgPool) -> (i32, i32, i32) {
    crate::db::migrate(pool).await.unwrap();
    let user = sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ('u') RETURNING id"#)
        .fetch_one(pool)
        .await
        .unwrap();
    let lib: i32 =
        sqlx::query_scalar(r#"INSERT INTO libraries (name, path) VALUES ('L', '/l') RETURNING id"#)
            .fetch_one(pool)
            .await
            .unwrap();
    let media: i32 = sqlx::query_scalar(
        r#"INSERT INTO media (title, type, "libraryId", "folderName")
           VALUES ('M', 'movie', $1, 'M') RETURNING id"#,
    )
    .bind(lib)
    .fetch_one(pool)
    .await
    .unwrap();
    let file = sqlx::query_scalar(
        r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality)
           VALUES ($1, 'M.mkv', 1, 'x') RETURNING id"#,
    )
    .bind(media)
    .fetch_one(pool)
    .await
    .unwrap();
    (user, media, file)
}

fn watch(file: i32, position: f64, at: Option<DateTime<Utc>>) -> Watch {
    Watch {
        position,
        duration: 3600.0,
        file,
        episode: None,
        client_played_at: at,
    }
}

async fn play(pool: &PgPool, ids: (i32, i32, i32), position: f64, at: Option<DateTime<Utc>>) {
    let (user, media, file) = ids;
    record_watch(pool, user, media, &watch(file, position, at))
        .await
        .unwrap();
}

async fn row(pool: &PgPool, user: i32, media: i32) -> (f64, bool, DateTime<Utc>) {
    let r = find_state(pool, user, media, None).await.unwrap().unwrap();
    (r.position_seconds, r.completed, r.last_played_at)
}

fn ms(t: DateTime<Utc>) -> DateTime<Utc> {
    DateTime::from_timestamp_millis(t.timestamp_millis()).unwrap()
}

#[sqlx::test(migrations = false)]
async fn stale_replay_leaves_the_newer_row_alone(pool: PgPool) {
    let ids = seed(&pool).await;
    play(&pool, ids, 900.0, None).await;
    let before = row(&pool, ids.0, ids.1).await;
    let old = Utc::now() - Duration::days(2);
    let out = record_watch(&pool, ids.0, ids.1, &watch(ids.2, 100.0, Some(old)))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(out["positionSeconds"], 900.0);
    assert_eq!(row(&pool, ids.0, ids.1).await, before);
}

#[sqlx::test(migrations = false)]
async fn newer_replay_is_applied_with_its_own_timestamp(pool: PgPool) {
    let ids = seed(&pool).await;
    play(&pool, ids, 100.0, None).await;
    let at = ms(Utc::now() + Duration::minutes(5));
    play(&pool, ids, 700.0, Some(at)).await;
    assert_eq!(row(&pool, ids.0, ids.1).await, (700.0, false, at));
}

#[sqlx::test(migrations = false)]
async fn replay_creates_a_missing_row_and_never_uncompletes(pool: PgPool) {
    let ids = seed(&pool).await;
    let at = ms(Utc::now() - Duration::hours(1));
    play(&pool, ids, 10.0, Some(at)).await;
    assert_eq!(row(&pool, ids.0, ids.1).await, (10.0, false, at));
    play(&pool, ids, 3590.0, None).await;
    play(
        &pool,
        ids,
        60.0,
        Some(ms(Utc::now() + Duration::minutes(5))),
    )
    .await;
    let (pos, completed, _) = row(&pool, ids.0, ids.1).await;
    assert!(completed && pos == 60.0);
}

#[sqlx::test(migrations = false)]
async fn live_beat_still_stamps_now(pool: PgPool) {
    let ids = seed(&pool).await;
    let t0 = Utc::now();
    play(&pool, ids, 50.0, None).await;
    assert!(row(&pool, ids.0, ids.1).await.2 >= t0 - Duration::seconds(1));
}

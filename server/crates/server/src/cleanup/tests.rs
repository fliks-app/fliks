use super::{dto, job, rules};
use crate::{config::Config, state::AppState};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{fs, path::PathBuf};

const SECRET: &str = "0123456789abcdef0123456789abcdef";

async fn exec(pool: &PgPool, sql: &str) {
    sqlx::query(sql).execute(pool).await.unwrap();
}

async fn scalar(pool: &PgPool, sql: &str) -> i32 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn ids(pool: &PgPool, c: Value) -> Vec<i32> {
    let mut v: Vec<i32> = rules::matched(pool, &c, "delete")
        .await
        .unwrap()
        .iter()
        .map(|m| m.id)
        .collect();
    v.sort();
    v
}

struct Seed {
    m1: i32,
    m2: i32,
    m3: i32,
    lib2: i32,
    user: i32,
}

/// m1: old movie, rated 3, 2 GB, never played, requested (not liked); m2: fresh ended series, rated 9,
/// played and liked; m3: old movie with an unknown rating and no genres.
async fn seed(pool: &PgPool) -> Seed {
    crate::db::migrate(pool).await.unwrap();
    let dir = tmp();
    let lib1 = scalar(
        pool,
        &format!(
            r#"INSERT INTO libraries (name, path) VALUES ('one', '{}') RETURNING id"#,
            dir.display()
        ),
    )
    .await;
    let lib2 = scalar(
        pool,
        r#"INSERT INTO libraries (name) VALUES ('two') RETURNING id"#,
    )
    .await;
    let user = scalar(
        pool,
        r#"INSERT INTO users (username) VALUES ('u') RETURNING id"#,
    )
    .await;
    let m1 = scalar(
        pool,
        &format!(
            r#"INSERT INTO media (title, type, "libraryId", "createdAt", rating, genres, "releaseDate")
            VALUES ('a', 'movie', {lib1}, now() - interval '100 days', 3, '["Drama"]', '2000-01-01') RETURNING id"#
        ),
    )
    .await;
    let m2 = scalar(
        pool,
        &format!(
            r#"INSERT INTO media (title, type, "libraryId", rating, genres, status)
            VALUES ('b', 'series', {lib2}, 9, '["Comedy"]', 'ended') RETURNING id"#
        ),
    )
    .await;
    let m3 = scalar(
        pool,
        &format!(
            r#"INSERT INTO media (title, type, "libraryId", "createdAt", rating)
            VALUES ('c', 'movie', {lib1}, now() - interval '100 days', 0) RETURNING id"#
        ),
    )
    .await;
    exec(
        pool,
        &format!(
            r#"INSERT INTO media_files ("mediaId", "relativePath", size, quality) VALUES ({m1}, 'a.mkv', 2147483648, 'x')"#
        ),
    )
    .await;
    exec(
        pool,
        &format!(
            r#"INSERT INTO playback_states ("userId", "mediaId", completed, "lastPlayedAt")
            VALUES ({user}, {m2}, true, now() - interval '1 day')"#
        ),
    )
    .await;
    exec(
        pool,
        &format!(r#"INSERT INTO likes ("userId", "mediaId") VALUES ({user}, {m2})"#),
    )
    .await;
    exec(
        pool,
        &format!(
            r#"INSERT INTO requests ("mediaType", "tmdbId", title, "userId", "mediaId")
            VALUES ('movie', 1, 'a', {user}, {m1}), ('series', 2, 'b', {user}, {m2})"#
        ),
    )
    .await;
    Seed {
        m1,
        m2,
        m3,
        lib2,
        user,
    }
}

fn tmp() -> PathBuf {
    let d = PathBuf::from("/tmp/fliks-parity/cleanup").join(crate::config::random_hex(6));
    fs::create_dir_all(&d).unwrap();
    d
}

#[sqlx::test]
async fn each_criterion_filters(pool: PgPool) {
    let s = seed(&pool).await;
    let (a, b, c) = (s.m1, s.m2, s.m3);
    let cases = [
        (json!({}), vec![a, b, c]),
        (json!({"libraryIds": [s.lib2]}), vec![b]),
        (json!({"mediaType": "series"}), vec![b]),
        (json!({"addedOlderThanDays": 30}), vec![a, c]),
        (json!({"releasedOlderThanDays": 365}), vec![a]),
        (json!({"lastPlayedOlderThanDays": 30}), vec![a, c]),
        (json!({"neverPlayed": true}), vec![a, c]),
        (json!({"watchedByRequester": true}), vec![]),
        (json!({"ratingBelow": 5}), vec![a]),
        (json!({"ratingBelow": 5, "minVotes": 100}), vec![]),
        (json!({"sizeAboveGb": 1}), vec![a]),
        (json!({"genres": ["Drama", "Other"]}), vec![a]),
        (json!({"excludeGenres": ["Drama"]}), vec![b, c]),
        (json!({"seriesEnded": true}), vec![b]),
        (json!({"notLiked": true}), vec![a, c]),
        (json!({"likedByFewerThan": 1}), vec![a, c]),
        (json!({"likedByFewerThan": 2}), vec![a, b, c]),
        (json!({"notLikedByRequester": true}), vec![a, c]),
        (json!({"diskFreeBelowPercent": 101}), vec![a, c]),
    ];
    for (criteria, want) in cases {
        assert_eq!(ids(&pool, criteria.clone()).await, want, "{criteria}");
    }
    exec(
        &pool,
        &format!(r#"INSERT INTO media_metadata ("mediaId", "voteCount") VALUES ({a}, 500)"#),
    )
    .await;
    assert_eq!(
        ids(&pool, json!({"ratingBelow": 5, "minVotes": 100})).await,
        vec![a]
    );
    exec(
        &pool,
        &format!(r#"INSERT INTO cleanup_exclusions ("mediaId") VALUES ({a})"#),
    )
    .await;
    assert_eq!(ids(&pool, json!({})).await, vec![b, c]);
    exec(
        &pool,
        &format!(
            r#"INSERT INTO requests ("mediaType", "tmdbId", title, "userId", "mediaId") VALUES ('movie', 3, 'c', {u}, {c})"#,
            u = s.user
        ),
    )
    .await;
    exec(
        &pool,
        &format!(
            r#"INSERT INTO playback_states ("userId", "mediaId", completed) VALUES ({}, {c}, true)"#,
            s.user
        ),
    )
    .await;
    assert_eq!(
        ids(&pool, json!({"watchedByRequester": true})).await,
        vec![c]
    );
}

#[test]
fn unknown_keys_and_wrong_types_are_rejected() {
    let ok = json!({"name": "r", "criteria": {"neverPlayed": true, "ratingBelow": 4.5}});
    assert!(dto::rule(ok).is_ok());
    for criteria in [
        json!({"nope": 1}),
        json!({"neverPlayed": "yes"}),
        json!({"addedOlderThanDays": -1}),
        json!({"genres": [1]}),
        json!({"mediaType": "episode"}),
        json!({"diskFreeBelowPercent": 0}),
        json!({"minVotes": 10}),
    ] {
        let r = dto::rule(json!({"name": "r", "criteria": criteria}));
        assert!(r.is_err(), "{criteria}");
    }
    assert!(dto::rule(json!({"name": "r", "criteria": {}, "extra": 1})).is_err());
    assert!(dto::rule(json!({"name": "r", "criteria": {}, "action": "burn"})).is_err());
}

async fn state(pool: &PgPool) -> AppState {
    AppState::new(pool.clone(), Config::from_lookup(|_| None), SECRET)
}

async fn rule(pool: &PgPool, criteria: Value, action: &str, grace: Option<i32>) -> i32 {
    sqlx::query_scalar(
        r#"INSERT INTO cleanup_rules (name, criteria, action, "graceDays") VALUES ('r', $1, $2, $3) RETURNING id"#,
    )
    .bind(criteria)
    .bind(action)
    .bind(grace)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn candidates(pool: &PgPool) -> Vec<i32> {
    sqlx::query_scalar(r#"SELECT "mediaId" FROM cleanup_candidates ORDER BY "mediaId""#)
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn media_ids(pool: &PgPool) -> Vec<i32> {
    sqlx::query_scalar("SELECT id FROM media ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn due_now(pool: &PgPool) {
    exec(
        pool,
        r#"UPDATE cleanup_candidates SET "deleteAt" = now() - interval '1 hour'"#,
    )
    .await;
}

#[sqlx::test]
async fn nothing_is_deleted_before_the_grace_period_ends(pool: PgPool) {
    let s = seed(&pool).await;
    let st = state(&pool).await;
    rule(&pool, json!({"neverPlayed": true}), "delete", Some(7)).await;
    job::run(&st).await.unwrap();
    assert_eq!(candidates(&pool).await, vec![s.m1, s.m3]);
    let days: f64 = sqlx::query_scalar(
        r#"SELECT (EXTRACT(EPOCH FROM ("deleteAt" - now())) / 86400)::float8 FROM cleanup_candidates LIMIT 1"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!((6.9..=7.0).contains(&days), "{days}");
    assert_eq!(media_ids(&pool).await.len(), 3);
    due_now(&pool).await;
    job::run(&st).await.unwrap();
    assert_eq!(media_ids(&pool).await, vec![s.m2]);
}

#[sqlx::test]
async fn an_excluded_media_is_never_flagged(pool: PgPool) {
    let s = seed(&pool).await;
    let st = state(&pool).await;
    exec(
        &pool,
        &format!(
            r#"INSERT INTO cleanup_exclusions ("mediaId") VALUES ({})"#,
            s.m1
        ),
    )
    .await;
    rule(&pool, json!({"neverPlayed": true}), "delete", Some(0)).await;
    job::run(&st).await.unwrap();
    assert_eq!(media_ids(&pool).await, vec![s.m1, s.m2]);
}

#[sqlx::test]
async fn max_per_run_caps_the_deletions(pool: PgPool) {
    seed(&pool).await;
    let st = state(&pool).await;
    exec(
        &pool,
        r#"INSERT INTO app_settings (key, value) VALUES ('cleanup_max_per_run', '1')"#,
    )
    .await;
    rule(&pool, json!({}), "delete", Some(0)).await;
    job::run(&st).await.unwrap();
    assert_eq!(media_ids(&pool).await.len(), 2);
    job::run(&st).await.unwrap();
    assert_eq!(media_ids(&pool).await.len(), 1);
}

#[sqlx::test]
async fn a_media_that_stops_matching_is_unflagged(pool: PgPool) {
    let s = seed(&pool).await;
    let st = state(&pool).await;
    let id = rule(&pool, json!({"neverPlayed": true}), "delete", Some(7)).await;
    job::run(&st).await.unwrap();
    assert_eq!(candidates(&pool).await, vec![s.m1, s.m3]);
    exec(
        &pool,
        &format!(
            r#"INSERT INTO playback_states ("userId", "mediaId") VALUES ({}, {})"#,
            s.user, s.m1
        ),
    )
    .await;
    job::run(&st).await.unwrap();
    assert_eq!(candidates(&pool).await, vec![s.m3]);
    exec(
        &pool,
        &format!("UPDATE cleanup_rules SET enabled = false WHERE id = {id}"),
    )
    .await;
    job::run(&st).await.unwrap();
    assert!(candidates(&pool).await.is_empty());
}

#[sqlx::test]
async fn the_none_action_flags_but_never_acts(pool: PgPool) {
    seed(&pool).await;
    let st = state(&pool).await;
    rule(&pool, json!({}), "none", Some(0)).await;
    job::run(&st).await.unwrap();
    assert_eq!(candidates(&pool).await.len(), 3);
    due_now(&pool).await;
    job::run(&st).await.unwrap();
    assert_eq!(media_ids(&pool).await.len(), 3);
}

#[sqlx::test]
async fn the_lowest_rule_id_wins_a_media(pool: PgPool) {
    let s = seed(&pool).await;
    let st = state(&pool).await;
    let first = rule(&pool, json!({"mediaType": "series"}), "none", None).await;
    rule(&pool, json!({}), "none", None).await;
    job::run(&st).await.unwrap();
    let owner: i32 =
        sqlx::query_scalar(r#"SELECT "ruleId" FROM cleanup_candidates WHERE "mediaId" = $1"#)
            .bind(s.m2)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(owner, first);
    let dates: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM cleanup_candidates WHERE "deleteAt" IS NOT NULL"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(dates, 0, "a null graceDays never schedules a deletion");
}

#[sqlx::test]
async fn unmonitor_removes_the_files_and_keeps_the_media(pool: PgPool) {
    let s = seed(&pool).await;
    let st = state(&pool).await;
    let lib: String = sqlx::query_scalar(
        r#"SELECT l.path FROM media m JOIN libraries l ON l.id = m."libraryId" WHERE m.id = $1"#,
    )
    .bind(s.m1)
    .fetch_one(&pool)
    .await
    .unwrap();
    exec(
        &pool,
        &format!(r#"UPDATE media SET "folderName" = 'A' WHERE id = {}"#, s.m1),
    )
    .await;
    fs::create_dir_all(format!("{lib}/A")).unwrap();
    fs::write(format!("{lib}/A/a.mkv"), b"x").unwrap();
    rule(
        &pool,
        json!({"sizeAboveGb": 1}),
        "delete_files_unmonitor",
        Some(0),
    )
    .await;
    job::run(&st).await.unwrap();
    assert!(!PathBuf::from(format!("{lib}/A/a.mkv")).exists());
    assert_eq!(media_ids(&pool).await.len(), 3);
    let monitored: bool = sqlx::query_scalar("SELECT monitored FROM media WHERE id = $1")
        .bind(s.m1)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!monitored);
    assert!(candidates(&pool).await.is_empty());
}

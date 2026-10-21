use super::{
    db::{self, Scope},
    dto, job, routes, rules,
};
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
    let mut v = vec![];
    for level in ["movie", "series"] {
        let m = rules::matched(pool, &c, &[level.to_owned()], "delete")
            .await
            .unwrap();
        v.extend(m.iter().map(|m| m.id));
    }
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
    let history =
        json!({"playCountBelow": 3, "playCountByUsersBelow": 2, "notPlayedInLastDays": 0});
    assert!(dto::rule(json!({"name": "r", "criteria": history})).is_ok());
    for criteria in [
        json!({"nope": 1}),
        json!({"neverPlayed": "yes"}),
        json!({"addedOlderThanDays": -1}),
        json!({"genres": [1]}),
        json!({"mediaType": "series"}),
        json!({"diskFreeBelowPercent": 0}),
        json!({"minVotes": 10}),
        json!({"playCountBelow": 0}),
        json!({"playCountByUsersBelow": 0}),
        json!({"notPlayedInLastDays": -1}),
    ] {
        let r = dto::rule(json!({"name": "r", "criteria": criteria}));
        assert!(r.is_err(), "{criteria}");
    }
    assert!(dto::rule(json!({"name": "r", "criteria": {}, "extra": 1})).is_err());
    assert!(dto::rule(json!({"name": "r", "criteria": {}, "action": "burn"})).is_err());
}

fn no_scope() -> routes::ScopeQuery {
    routes::ScopeQuery {
        season_id: None,
        episode_id: None,
    }
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
    assert_eq!(candidates(&pool).await.len(), 2);
    due_now(&pool).await;
    job::run(&st).await.unwrap();
    assert_eq!(media_ids(&pool).await.len(), 3);
}

#[sqlx::test]
async fn the_lowest_rule_id_wins_a_media(pool: PgPool) {
    let s = seed(&pool).await;
    let st = state(&pool).await;
    let first = rule(&pool, json!({}), "none", None).await;
    exec(
        &pool,
        &format!(r#"UPDATE cleanup_rules SET levels = '{{series}}' WHERE id = {first}"#),
    )
    .await;
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

struct Show {
    media: i32,
    dir: PathBuf,
    /// seasons 1, 2
    seasons: [i32; 2],
    /// S1E1, S1E2, S2E1, S2E2, aired in that order
    eps: [i32; 4],
}

/// A series with two seasons of two episodes, one 1 GB file each, written on disk.
async fn show(pool: &PgPool) -> Show {
    crate::db::migrate(pool).await.unwrap();
    let dir = tmp();
    let lib = scalar(
        pool,
        &format!(
            r#"INSERT INTO libraries (name, path) VALUES ('tv', '{}') RETURNING id"#,
            dir.display()
        ),
    )
    .await;
    let media = scalar(
        pool,
        &format!(
            r#"INSERT INTO media (title, type, "libraryId", "folderName") VALUES ('Show', 'series', {lib}, 'Show') RETURNING id"#
        ),
    )
    .await;
    fs::create_dir_all(dir.join("Show")).unwrap();
    let mut seasons = [0; 2];
    let mut eps = [0; 4];
    for (i, season) in seasons.iter_mut().enumerate() {
        *season = scalar(
            pool,
            &format!(
                r#"INSERT INTO seasons ("seasonNumber", "mediaId") VALUES ({}, {media}) RETURNING id"#,
                i + 1
            ),
        )
        .await;
        for n in 0..2 {
            let k = i * 2 + n;
            let ep = scalar(
                pool,
                &format!(
                    r#"INSERT INTO episodes ("episodeNumber", "seasonId", "hasFile", "airDate")
                    VALUES ({}, {season}, true, '2020-01-0{}') RETURNING id"#,
                    n + 1,
                    k + 1
                ),
            )
            .await;
            let name = format!("S0{}E0{}.mkv", i + 1, n + 1);
            fs::write(dir.join("Show").join(&name), b"x").unwrap();
            exec(
                pool,
                &format!(
                    r#"INSERT INTO media_files ("mediaId", "episodeId", "relativePath", size, quality)
                    VALUES ({media}, {ep}, '{name}', 1073741824, 'x')"#
                ),
            )
            .await;
            eps[k] = ep;
        }
    }
    Show {
        media,
        dir,
        seasons,
        eps,
    }
}

async fn matched_ids(pool: &PgPool, level: &str, c: Value) -> Vec<i32> {
    let mut v: Vec<i32> = rules::matched(pool, &c, &[level.to_owned()], "delete")
        .await
        .unwrap()
        .iter()
        .map(|m| m.episode_id.or(m.season_id).unwrap())
        .collect();
    v.sort();
    v
}

async fn played(pool: &PgPool, ep: i32, days_ago: i32) {
    let user = scalar(
        pool,
        &format!(r#"INSERT INTO users (username) VALUES ('p{ep}') RETURNING id"#),
    )
    .await;
    exec(
        pool,
        &format!(
            r#"INSERT INTO playback_states ("userId", "mediaId", "episodeId", completed, "lastPlayedAt")
            SELECT {user}, s."mediaId", {ep}, true, now() - interval '{days_ago} days'
            FROM episodes e JOIN seasons s ON s.id = e."seasonId" WHERE e.id = {ep}"#
        ),
    )
    .await;
}

async fn files_left(pool: &PgPool) -> Vec<String> {
    sqlx::query_scalar(r#"SELECT "relativePath" FROM media_files ORDER BY id"#)
        .fetch_all(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn season_level_reads_the_episodes_of_the_season(pool: PgPool) {
    let s = show(&pool).await;
    played(&pool, s.eps[0], 100).await;
    played(&pool, s.eps[2], 1).await;
    let [s1, s2] = s.seasons;
    let cases = [
        (json!({}), vec![s1, s2]),
        (json!({"neverPlayed": true}), vec![]),
        (json!({"lastPlayedOlderThanDays": 30}), vec![s1]),
        (json!({"watchedByRequester": true}), vec![]),
        (json!({"sizeAboveGb": 1.5}), vec![s1, s2]),
        (json!({"sizeAboveGb": 2.5}), vec![]),
        (json!({"addedOlderThanDays": 1}), vec![]),
        (json!({"releasedOlderThanDays": 1}), vec![s1, s2]),
        (json!({"ratingBelow": 5}), vec![]),
    ];
    for (criteria, want) in cases {
        assert_eq!(
            matched_ids(&pool, "season", criteria.clone()).await,
            want,
            "{criteria}"
        );
    }
}

#[sqlx::test]
async fn episode_level_matches_one_episode(pool: PgPool) {
    let s = show(&pool).await;
    played(&pool, s.eps[0], 100).await;
    played(&pool, s.eps[1], 1).await;
    let [a, b, c, d] = s.eps;
    assert_eq!(
        matched_ids(&pool, "episode", json!({})).await,
        vec![a, b, c, d]
    );
    assert_eq!(
        matched_ids(&pool, "episode", json!({"neverPlayed": true})).await,
        vec![c, d]
    );
    assert_eq!(
        matched_ids(&pool, "episode", json!({"lastPlayedOlderThanDays": 30})).await,
        vec![a, c, d]
    );
    assert_eq!(
        matched_ids(&pool, "episode", json!({"sizeAboveGb": 0.5})).await,
        vec![a, b, c, d]
    );
    exec(
        &pool,
        &format!(r#"DELETE FROM media_files WHERE "episodeId" = {a}"#),
    )
    .await;
    assert_eq!(
        matched_ids(&pool, "episode", json!({})).await,
        vec![b, c, d]
    );
}

#[sqlx::test]
async fn keep_latest_episodes_keeps_the_newest_on_disk(pool: PgPool) {
    let s = show(&pool).await;
    let [a, b, c, d] = s.eps;
    assert_eq!(
        matched_ids(&pool, "episode", json!({"keepLatestEpisodes": 1})).await,
        vec![a, b, c]
    );
    assert_eq!(
        matched_ids(&pool, "episode", json!({"keepLatestEpisodes": 3})).await,
        vec![a]
    );
    exec(
        &pool,
        &format!(r#"DELETE FROM media_files WHERE "episodeId" = {d}"#),
    )
    .await;
    assert_eq!(
        matched_ids(&pool, "episode", json!({"keepLatestEpisodes": 3})).await,
        Vec::<i32>::new()
    );
}

async fn scoped_rule(pool: &PgPool, level: &str, c: Value, action: &str, empty: bool) {
    sqlx::query(
        r#"INSERT INTO cleanup_rules (name, levels, criteria, action, "graceDays", "deleteSeriesWhenEmpty")
        VALUES ('r', ARRAY[$1], $2, $3, 0, $4)"#,
    )
    .bind(level)
    .bind(c)
    .bind(action)
    .bind(empty)
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test]
async fn a_season_is_deleted_and_unmonitored_but_the_series_stays(pool: PgPool) {
    let s = show(&pool).await;
    let st = state(&pool).await;
    played(&pool, s.eps[0], 1).await;
    scoped_rule(
        &pool,
        "season",
        json!({"neverPlayed": true}),
        "delete",
        false,
    )
    .await;
    job::run(&st).await.unwrap();
    assert_eq!(files_left(&pool).await, ["S01E01.mkv", "S01E02.mkv"]);
    assert!(!s.dir.join("Show/S02E01.mkv").exists());
    assert!(s.dir.join("Show/S01E01.mkv").exists());
    let m: Vec<bool> = sqlx::query_scalar("SELECT monitored FROM episodes ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(m, [true, true, false, false]);
    let sm: Vec<bool> = sqlx::query_scalar("SELECT monitored FROM seasons ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(sm, [true, false]);
    assert_eq!(media_ids(&pool).await, vec![s.media]);
    assert!(candidates(&pool).await.is_empty());
    job::run(&st).await.unwrap();
    assert_eq!(
        files_left(&pool).await.len(),
        2,
        "a cleaned season is not flagged again"
    );
}

#[sqlx::test]
async fn an_episode_is_deleted_alone(pool: PgPool) {
    let s = show(&pool).await;
    let st = state(&pool).await;
    scoped_rule(
        &pool,
        "episode",
        json!({"keepLatestEpisodes": 3}),
        "delete_files_unmonitor",
        false,
    )
    .await;
    job::run(&st).await.unwrap();
    assert_eq!(
        files_left(&pool).await,
        ["S01E02.mkv", "S02E01.mkv", "S02E02.mkv"]
    );
    let m: Vec<bool> = sqlx::query_scalar("SELECT monitored FROM episodes ORDER BY id")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(m, [false, true, true, true]);
    let season_monitored: bool = sqlx::query_scalar("SELECT monitored FROM seasons WHERE id = $1")
        .bind(s.seasons[0])
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(season_monitored);
    assert_eq!(media_ids(&pool).await, vec![s.media]);
}

#[sqlx::test]
async fn delete_series_when_empty_removes_the_series_with_its_last_file(pool: PgPool) {
    let s = show(&pool).await;
    let st = state(&pool).await;
    scoped_rule(&pool, "episode", json!({}), "delete", true).await;
    job::run(&st).await.unwrap();
    assert!(files_left(&pool).await.is_empty());
    assert!(media_ids(&pool).await.is_empty());
    assert!(!s.dir.join("Show").exists());
}

#[sqlx::test]
async fn the_series_stays_without_the_option(pool: PgPool) {
    let s = show(&pool).await;
    let st = state(&pool).await;
    scoped_rule(&pool, "episode", json!({}), "delete", false).await;
    job::run(&st).await.unwrap();
    assert!(files_left(&pool).await.is_empty());
    assert_eq!(media_ids(&pool).await, vec![s.media]);
}

#[sqlx::test]
async fn an_excluded_episode_protects_itself_and_its_season(pool: PgPool) {
    let s = show(&pool).await;
    let st = state(&pool).await;
    let [a, b, c, d] = s.eps;
    let [s1, s2] = s.seasons;
    let user = scalar(
        &pool,
        r#"INSERT INTO users (username) VALUES ('admin') RETURNING id"#,
    )
    .await;
    let one = Scope {
        season: Some(s1),
        episode: Some(a),
    };
    db::exclude(&pool, s.media, one, user).await.unwrap();
    assert_eq!(
        matched_ids(&pool, "episode", json!({})).await,
        vec![b, c, d]
    );
    assert_eq!(matched_ids(&pool, "season", json!({})).await, vec![s2]);
    scoped_rule(&pool, "episode", json!({}), "none", false).await;
    job::run(&st).await.unwrap();
    assert_eq!(scoped_candidates(&pool).await.len(), 3);
    let scope = Scope {
        season: Some(s2),
        episode: None,
    };
    db::exclude(&pool, s.media, scope, user).await.unwrap();
    job::run(&st).await.unwrap();
    assert_eq!(scoped_candidates(&pool).await, vec![(Some(s1), Some(b))]);
    assert!(db::unexclude(&pool, s.media, scope).await.unwrap());
}

async fn scoped_candidates(pool: &PgPool) -> Vec<(Option<i32>, Option<i32>)> {
    sqlx::query_as(r#"SELECT "seasonId", "episodeId" FROM cleanup_candidates ORDER BY id"#)
        .fetch_all(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn candidates_of_one_media_are_unique_per_scope(pool: PgPool) {
    let s = show(&pool).await;
    let r = scalar(
        &pool,
        r#"INSERT INTO cleanup_rules (name, criteria) VALUES ('r', '{}') RETURNING id"#,
    )
    .await;
    let insert = |season: String, ep: String| {
        format!(
            r#"INSERT INTO cleanup_candidates ("mediaId", "seasonId", "episodeId", "ruleId") VALUES ({}, {season}, {ep}, {r})"#,
            s.media
        )
    };
    exec(&pool, &insert("NULL".into(), "NULL".into())).await;
    assert!(
        sqlx::query(&insert("NULL".into(), "NULL".into()))
            .execute(&pool)
            .await
            .is_err()
    );
    exec(&pool, &insert(s.seasons[0].to_string(), "NULL".into())).await;
    exec(
        &pool,
        &insert(s.seasons[0].to_string(), s.eps[0].to_string()),
    )
    .await;
    assert_eq!(scoped_candidates(&pool).await.len(), 3);
}

#[test]
fn level_rules_are_validated() {
    let level = |level: &str, criteria: Value| {
        dto::rule(json!({"name": "r", "levels": [level], "criteria": criteria}))
    };
    assert!(
        level(
            "episode",
            json!({"keepLatestEpisodes": 3, "neverPlayed": true})
        )
        .is_ok()
    );
    assert!(level("season", json!({"lastPlayedOlderThanDays": 5})).is_ok());
    for (l, c) in [
        ("season", json!({"keepLatestEpisodes": 3})),
        ("movie", json!({"keepLatestEpisodes": 3})),
        ("movie", json!({"mediaType": "movie"})),
        ("season", json!({"mediaType": "series"})),
        ("episode", json!({"keepLatestEpisodes": 0})),
        ("shot", json!({})),
    ] {
        assert!(level(l, c.clone()).is_err(), "{l} {c}");
    }
    let rule = |v: Value| {
        let mut body = json!({"name": "r", "criteria": {}});
        body.as_object_mut()
            .unwrap()
            .extend(v.as_object().unwrap().clone());
        dto::rule(body)
    };
    assert!(rule(json!({"levels": ["season"], "deleteSeriesWhenEmpty": true})).is_ok());
    assert!(rule(json!({"levels": ["movie", "season"], "deleteSeriesWhenEmpty": true})).is_ok());
    assert!(rule(json!({"levels": ["movie"], "deleteSeriesWhenEmpty": true})).is_err());
    assert!(rule(json!({"deleteSeriesWhenEmpty": "yes"})).is_err());
    assert_eq!(rule(json!({})).unwrap().levels, ["movie"]);
    assert_eq!(
        rule(json!({"levels": ["episode", "movie"]}))
            .unwrap()
            .levels,
        ["movie", "episode"]
    );
}

#[test]
fn levels_are_validated_together() {
    let body = |levels: Value, criteria: Value| {
        dto::rule(json!({"name": "r", "levels": levels, "criteria": criteria}))
    };
    for ok in [
        json!(["movie"]),
        json!(["series"]),
        json!(["season"]),
        json!(["episode"]),
        json!(["movie", "series"]),
        json!(["movie", "season"]),
        json!(["movie", "episode"]),
    ] {
        assert!(body(ok.clone(), json!({})).is_ok(), "{ok}");
    }
    for bad in [
        json!([]),
        json!("movie"),
        json!(["shot"]),
        json!(["movie", "movie"]),
        json!(["series", "season"]),
        json!(["series", "episode"]),
        json!(["season", "episode"]),
    ] {
        assert!(body(bad.clone(), json!({})).is_err(), "{bad}");
    }
    let err = |l: Value, c: Value| body(l, c).unwrap_err().text();
    assert!(
        err(
            json!(["movie", "episode"]),
            json!({"keepLatestEpisodes": 2})
        )
        .contains("only available at episode level")
    );
    assert!(body(json!(["episode"]), json!({"keepLatestEpisodes": 2})).is_ok());
    assert!(
        err(json!(["movie", "season"]), json!({"playCountBelow": 2}))
            .contains("not available at season level")
    );
    assert!(body(json!(["movie", "series"]), json!({"playCountBelow": 2})).is_ok());
    let both = err(json!(["series", "season"]), json!({}));
    assert!(both.contains("at most one of series, season and episode"));
    assert!(
        dto::rule(json!({"name": "r", "level": "movie", "criteria": {}}))
            .unwrap_err()
            .text()
            .contains("property level should not exist")
    );
}

#[sqlx::test]
async fn movie_and_series_levels_select_their_media_type(pool: PgPool) {
    let s = seed(&pool).await;
    let at = |levels: &[&str]| {
        let levels: Vec<String> = levels.iter().map(|l| (*l).to_owned()).collect();
        let pool = pool.clone();
        async move {
            let m = rules::matched(&pool, &json!({}), &levels, "delete").await;
            let mut v: Vec<i32> = m.unwrap().iter().map(|m| m.id).collect();
            v.sort();
            v
        }
    };
    assert_eq!(at(&["series"]).await, vec![s.m2]);
    assert_eq!(at(&["movie"]).await, vec![s.m1, s.m3]);
    assert_eq!(at(&["movie", "series"]).await, vec![s.m1, s.m2, s.m3]);
}

#[sqlx::test]
async fn play_history_criteria(pool: PgPool) {
    let s = seed(&pool).await;
    let u2 = scalar(
        &pool,
        r#"INSERT INTO users (username) VALUES ('v') RETURNING id"#,
    )
    .await;
    for (u, m, ago) in [
        (s.user, s.m1, 40),
        (s.user, s.m1, 50),
        (u2, s.m1, 60),
        (s.user, s.m2, 1),
    ] {
        exec(
            &pool,
            &format!(
                r#"INSERT INTO playback_history ("userId", "mediaId", "playedAt") VALUES ({u}, {m}, now() - interval '{ago} days')"#
            ),
        )
        .await;
    }
    let (a, b, c) = (s.m1, s.m2, s.m3);
    let cases = [
        (json!({"playCountBelow": 1}), vec![c]),
        (json!({"playCountBelow": 2}), vec![b, c]),
        (json!({"playCountBelow": 4}), vec![a, b, c]),
        (json!({"playCountByUsersBelow": 2}), vec![b, c]),
        (json!({"playCountByUsersBelow": 3}), vec![a, b, c]),
        (json!({"notPlayedInLastDays": 30}), vec![a, c]),
        (json!({"notPlayedInLastDays": 0}), vec![a, b, c]),
        (json!({"notPlayedInLastDays": 45}), vec![c]),
    ];
    for (criteria, want) in cases {
        assert_eq!(ids(&pool, criteria.clone()).await, want, "{criteria}");
    }
}

async fn last_reminder(pool: &PgPool) -> Vec<Option<i32>> {
    sqlx::query_scalar(r#"SELECT "lastReminderDays" FROM cleanup_candidates ORDER BY "mediaId""#)
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn deadline(pool: &PgPool, interval: &str) {
    exec(
        pool,
        &format!(r#"UPDATE cleanup_candidates SET "deleteAt" = now() + interval '{interval}'"#),
    )
    .await;
}

#[sqlx::test]
async fn reminders_follow_the_thresholds(pool: PgPool) {
    seed(&pool).await;
    let st = state(&pool).await;
    rule(&pool, json!({"neverPlayed": true}), "none", Some(30)).await;
    job::run(&st).await.unwrap();
    assert_eq!(last_reminder(&pool).await, vec![None, None]);
    deadline(&pool, "10 days").await;
    job::run(&st).await.unwrap();
    assert_eq!(last_reminder(&pool).await, vec![None, None]);
    deadline(&pool, "6 days 12 hours").await;
    job::run(&st).await.unwrap();
    assert_eq!(last_reminder(&pool).await, vec![Some(7), Some(7)]);
    deadline(&pool, "3 days").await;
    job::run(&st).await.unwrap();
    assert_eq!(last_reminder(&pool).await, vec![Some(7), Some(7)]);
    deadline(&pool, "23 hours").await;
    job::run(&st).await.unwrap();
    assert_eq!(last_reminder(&pool).await, vec![Some(1), Some(1)]);
}

#[sqlx::test]
async fn a_late_flag_records_the_smallest_crossed_threshold(pool: PgPool) {
    seed(&pool).await;
    let st = state(&pool).await;
    let id = rule(&pool, json!({"neverPlayed": true}), "none", Some(3)).await;
    job::run(&st).await.unwrap();
    assert_eq!(last_reminder(&pool).await, vec![Some(7), Some(7)]);
    exec(&pool, "DELETE FROM cleanup_candidates").await;
    exec(&pool, &format!(r#"UPDATE cleanup_rules SET "graceDays" = 1, "reminderDays" = '{{14,7,1}}' WHERE id = {id}"#)).await;
    job::run(&st).await.unwrap();
    assert_eq!(last_reminder(&pool).await, vec![Some(1), Some(1)]);
}

#[test]
fn reminder_days_are_validated_and_sorted() {
    let rule = |v: Value| dto::rule(json!({"name": "r", "criteria": {}, "reminderDays": v}));
    assert_eq!(
        rule(json!([1, 14, 7])).unwrap().reminder_days,
        vec![14, 7, 1]
    );
    assert_eq!(rule(Value::Null).unwrap().reminder_days, vec![7, 1]);
    assert!(rule(json!([])).unwrap().reminder_days.is_empty());
    for bad in [
        json!([0]),
        json!([-1]),
        json!([7, 7]),
        json!([1, 2, 3, 4, 5, 6]),
        json!(["a"]),
        json!(7),
    ] {
        assert!(rule(bad.clone()).is_err(), "{bad}");
    }
    assert_eq!(
        dto::rule(json!({"name": "r", "criteria": {}}))
            .unwrap()
            .reminder_days,
        vec![7, 1]
    );
}

#[sqlx::test]
async fn export_then_import_round_trips_library_names(pool: PgPool) {
    let s = seed(&pool).await;
    let one: i32 = scalar(&pool, "SELECT id FROM libraries WHERE name = 'one'").await;
    let criteria = json!({"libraryIds": [one], "excludeLibraryIds": [s.lib2], "neverPlayed": true});
    let id = rule(&pool, criteria.clone(), "none", Some(30)).await;
    let stored = db::rule_find(&pool, id).await.unwrap().unwrap();
    let libs = db::library_names(&pool).await.unwrap();
    let out = routes::export(&stored, &libs);
    assert_eq!(out["fliksCleanupRule"], 2);
    assert_eq!(out["criteria"]["libraryIds"], json!(["one"]));
    assert_eq!(out["criteria"]["excludeLibraryIds"], json!(["two"]));
    let r = dto::import(out, &libs).unwrap();
    assert!(!r.enabled);
    assert_eq!(r.criteria, criteria);
    assert_eq!((r.action.as_str(), r.grace_days), ("none", Some(30)));
}

#[sqlx::test]
async fn import_rejects_unknown_library_version_and_keys(pool: PgPool) {
    seed(&pool).await;
    let libs = db::library_names(&pool).await.unwrap();
    let base = |extra: Value| {
        let mut v = json!({"fliksCleanupRule": 1, "name": "r", "criteria": {}});
        v.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        v
    };
    let err = |v: Value| dto::import(v, &libs).unwrap_err().text();
    assert!(
        err(base(json!({"criteria": {"libraryIds": ["nope"]}}))).contains("unknown library nope")
    );
    assert!(err(base(json!({"fliksCleanupRule": 3}))).contains("fliksCleanupRule must be 1 or 2"));
    assert!(err(json!({"name": "r", "criteria": {}})).contains("fliksCleanupRule must be 1 or 2"));
    assert!(err(base(json!({"extra": 1}))).contains("property extra should not exist"));
    assert!(dto::import(base(json!({"enabled": true})), &libs).is_ok_and(|r| !r.enabled));
    let v1 = |extra: Value, c: Value| {
        let mut v = base(extra);
        v["fliksCleanupRule"] = json!(1);
        v["criteria"] = c;
        v
    };
    let legacy = json!({"mediaType": "series", "neverPlayed": true});
    let r = dto::import(v1(json!({}), legacy.clone()), &libs).unwrap();
    assert_eq!(r.levels, ["series"]);
    assert_eq!(r.criteria, json!({"neverPlayed": true}));
    let r = dto::import(v1(json!({"level": "season"}), json!({})), &libs).unwrap();
    assert_eq!(r.levels, ["season"]);
    assert_eq!(
        dto::import(v1(json!({}), json!({})), &libs).unwrap().levels,
        ["movie"]
    );
    assert!(dto::import(v1(json!({"level": "series"}), legacy.clone()), &libs).is_ok());
    assert!(err(v1(json!({"level": "movie"}), legacy)).contains("contradicts level movie"));
    assert!(err(v1(json!({"levels": ["movie"]}), json!({}))).contains("levels should not exist"));
    let v2 = base(json!({"fliksCleanupRule": 2, "levels": ["movie", "season"]}));
    assert_eq!(dto::import(v2, &libs).unwrap().levels, ["movie", "season"]);
    assert!(
        err(base(json!({"fliksCleanupRule": 2, "level": "movie"})))
            .contains("property level should not exist")
    );
}

#[sqlx::test]
async fn exclude_library_ids_is_the_opposite_of_library_ids(pool: PgPool) {
    let s = seed(&pool).await;
    assert_eq!(
        ids(&pool, json!({"excludeLibraryIds": [s.lib2]})).await,
        vec![s.m1, s.m3]
    );
    assert_eq!(
        ids(&pool, json!({"excludeLibraryIds": []})).await,
        vec![s.m1, s.m2, s.m3]
    );
}

#[test]
fn bulk_body_is_validated() {
    assert!(
        dto::bulk(
            json!({"action": "keep", "items": [{"mediaId": 1}, {"mediaId": 2, "seasonId": 3}]})
        )
        .is_ok()
    );
    assert!(
        dto::bulk(json!({"action": "delete-now", "items": [{"mediaId": 1}]}))
            .is_ok_and(|b| b.delete_now)
    );
    assert!(dto::bulk(json!({"action": "keep", "items": []})).is_err());
    assert!(dto::bulk(json!({"action": "keep", "items": [{"seasonId": 1}]})).is_err());
    assert!(dto::bulk(json!({"action": "burn", "items": [{"mediaId": 1}]})).is_err());
    let many: Vec<Value> = (1..=201).map(|i| json!({"mediaId": i})).collect();
    assert!(dto::bulk(json!({"action": "keep", "items": many})).is_err());
}

#[sqlx::test]
async fn bulk_keep_and_delete_now_report_each_item(pool: PgPool) {
    let s = seed(&pool).await;
    let st = state(&pool).await;
    rule(&pool, json!({}), "none", None).await;
    job::run(&st).await.unwrap();
    exec(
        &pool,
        &format!(r#"UPDATE media SET "folderName" = 'A' WHERE id = {}"#, s.m1),
    )
    .await;
    let lib: String = sqlx::query_scalar(r#"SELECT path FROM libraries WHERE name = 'one'"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    fs::create_dir_all(format!("{lib}/A")).unwrap();
    // m2 is outside the allowed libraries, 999999 does not exist
    let allowed = [scalar(&pool, "SELECT id FROM libraries WHERE name = 'one'").await];
    assert!(
        routes::delete_one(&st, &allowed, s.m1, no_scope())
            .await
            .is_ok()
    );
    assert!(
        routes::delete_one(&st, &allowed, s.m2, no_scope())
            .await
            .is_err()
    );
    assert!(
        routes::delete_one(&st, &allowed, 999_999, no_scope())
            .await
            .is_err()
    );
    assert!(!PathBuf::from(format!("{lib}/A")).exists());
    assert_eq!(media_ids(&pool).await, vec![s.m2, s.m3]);
    routes::keep_one(&st, s.user, &[allowed[0], s.lib2], s.m2, no_scope())
        .await
        .unwrap();
    assert!(
        routes::keep_one(&st, s.user, &allowed, s.m2, no_scope())
            .await
            .is_err()
    );
    assert_eq!(candidates(&pool).await, vec![s.m3]);
    let excluded: i64 =
        sqlx::query_scalar(r#"SELECT COUNT(*) FROM cleanup_exclusions WHERE "mediaId" = $1"#)
            .bind(s.m2)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(excluded, 1);
}

#[sqlx::test]
async fn export_carries_levels_scope_flag_and_new_criteria(pool: PgPool) {
    seed(&pool).await;
    let criteria = json!({"playCountBelow": 2, "notPlayedInLastDays": 10});
    let id: i32 = sqlx::query_scalar(
        r#"INSERT INTO cleanup_rules (name, levels, criteria) VALUES ('m', '{movie}', $1) RETURNING id"#,
    )
    .bind(&criteria)
    .fetch_one(&pool)
    .await
    .unwrap();
    let scoped: i32 = sqlx::query_scalar(
        r#"INSERT INTO cleanup_rules (name, levels, "deleteSeriesWhenEmpty", criteria)
        VALUES ('s', '{season}', true, '{}') RETURNING id"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    for (id, level, empty) in [(id, "movie", false), (scoped, "season", true)] {
        let stored = db::rule_find(&pool, id).await.unwrap().unwrap();
        let out = routes::export(&stored, &[]);
        assert_eq!(
            (&out["levels"], &out["deleteSeriesWhenEmpty"]),
            (&json!([level]), &json!(empty))
        );
        let r = dto::import(out, &[]).unwrap();
        assert_eq!(
            (r.levels[0].as_str(), r.delete_series_when_empty),
            (level, empty)
        );
        assert!(!r.enabled);
    }
}

#[sqlx::test]
async fn recommendations_merge_reasons_and_skip_kept_and_flagged(pool: PgPool) {
    let s = seed(&pool).await;
    let st = state(&pool).await;
    let titles = |v: &Value| -> Vec<(i64, Vec<String>)> {
        v["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| {
                let r = i["reasons"].as_array().unwrap();
                (
                    i["mediaId"].as_i64().unwrap(),
                    r.iter().map(|x| x.as_str().unwrap().to_owned()).collect(),
                )
            })
            .collect()
    };
    let all = rules::recommendations(&pool).await.unwrap();
    assert_eq!(all["reasons"].as_array().unwrap().len(), 4);
    let never = vec!["never_played".to_owned()];
    assert_eq!(
        titles(&all),
        vec![
            (i64::from(s.m1), never.clone()),
            (i64::from(s.m3), never.clone())
        ]
    );
    let lib = scalar(&pool, "SELECT id FROM libraries WHERE name = 'one'").await;
    routes::keep_one(&st, s.user, &[lib], s.m3, no_scope())
        .await
        .unwrap();
    assert_eq!(
        titles(&rules::recommendations(&pool).await.unwrap()).len(),
        1
    );
    rule(&pool, json!({"neverPlayed": true}), "none", None).await;
    job::run(&st).await.unwrap();
    assert!(titles(&rules::recommendations(&pool).await.unwrap()).is_empty());
}

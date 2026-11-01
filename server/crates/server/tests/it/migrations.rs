//! Each logic migration is run on a DB built at the previous version.
use sqlx::PgPool;
use sqlx::migrate::Migrator;

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

async fn apply(pool: &PgPool, keep: impl Fn(i64) -> bool) {
    for m in MIGRATOR.iter().filter(|m| keep(m.version)) {
        sqlx::raw_sql(m.sql.as_ref())
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("migration {}: {e}", m.version));
    }
}

async fn apply_until(pool: &PgPool, version: i64) {
    apply(pool, |v| v < version).await;
}

async fn apply_only(pool: &PgPool, version: i64) {
    apply(pool, |v| v == version).await;
}

async fn sql(pool: &PgPool, q: &str) {
    sqlx::raw_sql(sqlx::AssertSqlSafe(q))
        .execute(pool)
        .await
        .unwrap();
}

async fn rows<T>(pool: &PgPool, q: &str) -> Vec<T>
where
    T: for<'r> sqlx::FromRow<'r, sqlx::postgres::PgRow> + Send + Unpin,
{
    sqlx::query_as(sqlx::AssertSqlSafe(q))
        .fetch_all(pool)
        .await
        .unwrap()
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[sqlx::test(migrations = false)]
async fn m1778300_seeds_default_language_profile(pool: PgPool) {
    apply_until(&pool, 1_778_300_000_000).await;
    sql(
        &pool,
        r#"
        DELETE FROM language_profiles;
        INSERT INTO media (id, title, type) VALUES (1, 'a', 'movie'), (2, 'b', 'series');
    "#,
    )
    .await;
    apply_only(&pool, 1_778_300_000_000).await;

    let got: Vec<(i32, String)> = rows(&pool, r#"SELECT m.id, p.name FROM media m JOIN language_profiles p ON p.id = m."languageProfileId" ORDER BY m.id"#).await;
    let name = "Toutes les langues (défaut)".to_string();
    assert_eq!(got, vec![(1, name.clone()), (2, name)]);
}

#[sqlx::test(migrations = false)]
async fn m1778300_keeps_existing_profiles_and_attaches_the_lowest_id(pool: PgPool) {
    apply_until(&pool, 1_778_300_000_000).await;
    sql(&pool, r#"
        DELETE FROM language_profiles;
        INSERT INTO language_profiles (id, name) VALUES (7, 'seven'), (3, 'three');
        INSERT INTO media (id, title, type, "languageProfileId") VALUES (1, 'a', 'movie', NULL), (2, 'b', 'movie', 7);
    "#).await;
    apply_only(&pool, 1_778_300_000_000).await;

    let profiles: Vec<(String,)> =
        rows(&pool, "SELECT name FROM language_profiles ORDER BY id").await;
    assert_eq!(
        profiles,
        vec![("three".to_string(),), ("seven".to_string(),)]
    );
    let got: Vec<(i32, i32)> = rows(
        &pool,
        r#"SELECT id, "languageProfileId" FROM media ORDER BY id"#,
    )
    .await;
    assert_eq!(got, vec![(1, 3), (2, 7)]);
}

const SEED_1779100: &str = r#"
    INSERT INTO roles (id, name) VALUES (1, 'r');
    INSERT INTO users (id, username) VALUES (1, 'u1'), (2, 'u2');
    INSERT INTO libraries (id, name, icon, color, "mediaTypes", "preferredProvider", "stalledCleanupProfile", "isDefaultForMovies", "isDefaultForSeries")
      VALUES (1, 'Movies', 'film', 'red', '["movie"]', 'tmdb', 'strict', true, true),
             (2, 'Solo', NULL, NULL, '["series"]', NULL, NULL, false, false);
    INSERT INTO root_folders (id, path, "libraryId") VALUES
      (10, '/data/a', 1), (11, '/data/b', 1), (12, '/data/c/', 1), (13, '/', 1), (20, '/solo', 2);
    INSERT INTO media (id, title, type, "rootFolderId", "libraryId") VALUES
      (1, 'b1', 'movie', 11, 1), (2, 'b2', 'movie', 11, 1),
      (3, 'c1', 'movie', 12, 1), (4, 'c2', 'movie', 12, 1), (5, 's', 'series', 20, 2);
    INSERT INTO library_user_access ("libraryId", "userId") VALUES (1, 1), (1, 2), (2, 1);
    INSERT INTO role_default_libraries ("roleId", "libraryId") VALUES (1, 1);
    SELECT setval('libraries_id_seq', 2);
"#;

#[sqlx::test(migrations = false)]
async fn m1779100_collapses_multi_root_libraries_into_spin_offs(pool: PgPool) {
    apply_until(&pool, 1_779_100_000_000).await;
    sql(&pool, SEED_1779100).await;
    apply_only(&pool, 1_779_100_000_000).await;

    // Most media wins, ties go to the lowest id; the rest spin off in that order.
    let libs: Vec<(String,)> = rows(&pool, "SELECT name FROM libraries ORDER BY id").await;
    let names: Vec<_> = libs.iter().map(|l| l.0.as_str()).collect();
    assert_eq!(
        names,
        [
            "Movies",
            "Solo",
            "Movies (c)",
            "Movies (a)",
            "Movies (path-13)"
        ]
    );
    let settings: Vec<(String,)> = rows(&pool, r#"SELECT concat_ws('|', icon, "preferredProvider", "stalledCleanupProfile", "mediaTypes", "isDefaultForMovies", "isDefaultForSeries") FROM libraries WHERE id <> 2 ORDER BY id"#).await;
    let want = [
        r#"film|tmdb|strict|["movie"]|t|t"#,
        r#"film|tmdb|strict|["movie"]|f|f"#,
    ];
    assert_eq!(settings[0].0, want[0]);
    assert!(settings[1..].iter().all(|l| l.0 == want[1]), "{settings:?}");

    let rfs: Vec<(i32, i32)> = rows(
        &pool,
        r#"SELECT id, "libraryId" FROM root_folders ORDER BY id"#,
    )
    .await;
    assert_eq!(rfs, vec![(10, 4), (11, 1), (12, 3), (13, 5), (20, 2)]);
    let media: Vec<(i32, i32)> =
        rows(&pool, r#"SELECT id, "libraryId" FROM media ORDER BY id"#).await;
    assert_eq!(media, vec![(1, 1), (2, 1), (3, 3), (4, 3), (5, 2)]);

    let access: Vec<(i32, i32)> = rows(
        &pool,
        r#"SELECT "libraryId", "userId" FROM library_user_access ORDER BY 1, 2"#,
    )
    .await;
    assert_eq!(
        access,
        vec![
            (1, 1),
            (1, 2),
            (2, 1),
            (3, 1),
            (3, 2),
            (4, 1),
            (4, 2),
            (5, 1),
            (5, 2)
        ]
    );
    let roles: Vec<(i32, i32)> = rows(
        &pool,
        r#"SELECT "roleId", "libraryId" FROM role_default_libraries ORDER BY 2"#,
    )
    .await;
    assert_eq!(roles, vec![(1, 1), (1, 3), (1, 4), (1, 5)]);

    assert!(
        sqlx::raw_sql(r#"INSERT INTO root_folders (path, "libraryId") VALUES ('/dup', 1)"#)
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::raw_sql(r#"INSERT INTO root_folders (path, "libraryId") VALUES ('/null', NULL)"#)
            .execute(&pool)
            .await
            .is_err()
    );
}

#[sqlx::test(migrations = false)]
async fn m1779100_refuses_orphan_root_folders(pool: PgPool) {
    apply_until(&pool, 1_779_100_000_000).await;
    sql(
        &pool,
        r#"INSERT INTO root_folders (id, path, "libraryId") VALUES (1, '/orphan', NULL)"#,
    )
    .await;
    let err = sqlx::raw_sql(
        MIGRATOR
            .iter()
            .find(|m| m.version == 1_779_100_000_000)
            .unwrap()
            .sql
            .as_ref(),
    )
    .execute(&pool)
    .await
    .unwrap_err();
    assert!(err.to_string().contains("orphan rows exist"), "{err}");
}

#[sqlx::test(migrations = false)]
async fn m1779500_keeps_the_newest_duplicate_per_media_and_title(pool: PgPool) {
    apply_until(&pool, 1_779_500_000_000).await;
    sql(&pool, r#"
        INSERT INTO media (id, title, type) VALUES (1, 'm1', 'movie'), (2, 'm2', 'movie');
        INSERT INTO download_history (id, "sourceTitle", quality, status, "mediaId", "updatedAt") VALUES
          (1, 'Foo', 'q', 'grabbed', 1, '2024-01-01'),
          (2, 'foo', 'q', 'failed',  1, '2024-01-02'),
          (3, 'FOO', 'q', 'warning', 1, '2024-01-03'),
          (4, 'FOO', 'q', 'grabbed', 1, '2024-01-03'),
          (5, 'Bar', 'q', 'grabbed', 1, '2024-01-01'),
          (6, 'Bar', 'q', 'completed', 1, '2024-01-09'),
          (7, 'Foo', 'q', 'grabbed', 2, '2024-01-01');
    "#).await;
    apply_only(&pool, 1_779_500_000_000).await;

    // Ties on updatedAt go to the highest id; non-pending rows never rank.
    let got: Vec<(i32, String, Option<String>)> = rows(
        &pool,
        r#"SELECT id, status, "statusMessage" FROM download_history ORDER BY id"#,
    )
    .await;
    let marker = Some("Legacy duplicate collapsed by 1779500000000 migration".to_string());
    let expected: Vec<(i32, &str, Option<String>)> = vec![
        (1, "completed", marker.clone()),
        (2, "completed", marker.clone()),
        (3, "completed", marker.clone()),
        (4, "grabbed", None),
        (5, "grabbed", None),
        (6, "completed", None),
        (7, "grabbed", None),
    ];
    assert_eq!(
        got.into_iter().map(|r| (r.0, r.1, r.2)).collect::<Vec<_>>(),
        expected
            .into_iter()
            .map(|r| (r.0, r.1.to_string(), r.2))
            .collect::<Vec<_>>()
    );
}

#[sqlx::test(migrations = false)]
async fn m1783000_attaches_utc_to_naive_timestamps(pool: PgPool) {
    apply_until(&pool, 1_783_000_000_000).await;
    sql(&pool, r#"INSERT INTO app_settings (key, "createdAt", "updatedAt") VALUES ('k', '2024-03-01 12:00:00', '2024-03-02 01:30:00')"#).await;
    apply_only(&pool, 1_783_000_000_000).await;

    let (created, updated): (bool, bool) = sqlx::query_as(r#"SELECT "createdAt" = '2024-03-01 12:00:00+00', "updatedAt" = '2024-03-02 01:30:00+00' FROM app_settings"#).fetch_one(&pool).await.unwrap();
    assert!(created && updated);
    let naive: Vec<(String, String)> = rows(&pool, r#"SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('createdAt', 'updatedAt') AND data_type = 'timestamp without time zone'"#).await;
    assert!(naive.is_empty(), "{naive:?}");
}

#[sqlx::test(migrations = false)]
async fn m1784300_adds_spoiler_columns_with_defaults_on_existing_users(pool: PgPool) {
    apply_until(&pool, 1_784_300_000_000).await;
    sql(&pool, "INSERT INTO users (id, username) VALUES (1, 'u')").await;
    apply_only(&pool, 1_784_300_000_000).await;

    let got: (bool, bool, bool, bool) = sqlx::query_as(r#"SELECT "hideSpoilers", "spoilerHideStills", "spoilerHideOverviews", "spoilerHideTitles" FROM users"#).fetch_one(&pool).await.unwrap();
    assert_eq!(got, (false, true, true, true));
}

#[sqlx::test(migrations = false)]
async fn m1784400_adds_remote_control_flags_default_off(pool: PgPool) {
    apply_until(&pool, 1_784_400_000_000).await;
    sql(&pool, "INSERT INTO users (id, username) VALUES (1, 'u')").await;
    apply_only(&pool, 1_784_400_000_000).await;

    let got: (bool, bool) = sqlx::query_as(
        r#"SELECT "allowRemoteControlOfOthers", "allowRemoteControlOfMyDevices" FROM users"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(got, (false, false));
}

#[sqlx::test(migrations = false)]
async fn m1784500_creates_grants_and_drops_the_user_flags(pool: PgPool) {
    apply_until(&pool, 1_784_500_000_000).await;
    apply_only(&pool, 1_784_500_000_000).await;

    let cols: Vec<(String,)> = rows(&pool, r#"SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name LIKE 'allowRemoteControl%'"#).await;
    assert!(cols.is_empty());
    let idx: Vec<(String,)> = rows(&pool, "SELECT indexname FROM pg_indexes WHERE tablename = 'remote_control_grants' AND indexname LIKE 'IDX_%' ORDER BY 1").await;
    assert_eq!(
        idx.into_iter().map(|i| i.0).collect::<Vec<_>>(),
        s(&[
            "IDX_28efb3a0402a49dca862fb62e6",
            "IDX_34d4b3c63c41ebc088ba3cfcdb",
            "IDX_735e31a7f8cf53db91cc04339d",
            "IDX_a5a52f3d116c44c2944f0b1088"
        ])
    );
}

#[sqlx::test(migrations = false)]
async fn m1785000_raises_only_zero_min_sizes(pool: PgPool) {
    apply_until(&pool, 1_785_000_000_000).await;
    sql(
        &pool,
        r#"
        DELETE FROM quality_definitions;
        INSERT INTO quality_definitions ("qualityId", title, "minSize") VALUES
          (11, 'a', 0), (12, 'b', 99), (19, 'c', 0), (24, 'd', 0), (10, 'e', 0), (99, 'f', 0);
    "#,
    )
    .await;
    apply_only(&pool, 1_785_000_000_000).await;

    let got: Vec<(i32, f64)> = rows(
        &pool,
        r#"SELECT "qualityId", "minSize" FROM quality_definitions ORDER BY 1"#,
    )
    .await;
    assert_eq!(
        got,
        vec![
            (10, 0.0),
            (11, 150.0),
            (12, 99.0),
            (19, 8000.0),
            (24, 15000.0),
            (99, 0.0)
        ]
    );
}

async fn setting(pool: &PgPool, key: &str) -> Option<String> {
    sqlx::query_scalar("SELECT value FROM app_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .unwrap()
        .flatten()
}

fn json(v: Option<String>) -> serde_json::Value {
    serde_json::from_str(&v.unwrap()).unwrap()
}

#[sqlx::test(migrations = false)]
async fn m1785600_normalises_channels_grants_and_settings(pool: PgPool) {
    apply_until(&pool, 1_785_600_000_000).await;
    sql(&pool, r#"
        INSERT INTO users (id, username) VALUES (1, 'u1'), (2, 'u2');
        INSERT INTO livetv_channels (id, name, "groupName") VALUES
          (1, 'a', NULL), (2, 'b', ''), (3, 'c', '   '), (4, 'd', ' News '), (5, 'e', 'Sports');
        INSERT INTO livetv_group_access (id, "userId", "groupName") VALUES
          (1, 1, 'A'), (2, 1, ' A'), (3, 1, 'C'), (4, 2, ' B '), (5, 2, 'A');
        INSERT INTO app_settings (key, value) VALUES
          ('livetv_restricted_groups', '[" Sports", "News ", "Sports", 5, "", "  ", "Zebra", "apple", null, "\tTab\u00a0", "\u2028Zebra\ufeff"]'),
          ('livetv_restricted_groups_exempt', 'not json'),
          ('livetv_restricted_groups_vanished', '{" A":"2024-02-01T00:00:00.000Z","A":"2024-01-01T00:00:00.000Z","B ":5,"  ":"2024-01-01T00:00:00.000Z","C":"2024-03-01T00:00:00.000Z","\nD\u3000":"2024-04-01T00:00:00.000Z"}');
    "#).await;
    apply_only(&pool, 1_785_600_000_000).await;

    let ch: Vec<(i32, String)> = rows(
        &pool,
        r#"SELECT id, "groupName" FROM livetv_channels ORDER BY id"#,
    )
    .await;
    let u = "__livetv_ungrouped__";
    assert_eq!(
        ch,
        vec![
            (1, u.into()),
            (2, u.into()),
            (3, u.into()),
            (4, "News".into()),
            (5, "Sports".into())
        ]
    );
    let acc: Vec<(i32, String)> = rows(
        &pool,
        r#"SELECT id, "groupName" FROM livetv_group_access ORDER BY id"#,
    )
    .await;
    assert_eq!(
        acc,
        vec![
            (1, "A".into()),
            (3, "C".into()),
            (4, "B".into()),
            (5, "A".into())
        ]
    );

    // Code-point order, as JS's default sort: uppercase before lowercase.
    assert_eq!(
        json(setting(&pool, "livetv_restricted_groups").await),
        serde_json::json!(["News", "Sports", "Tab", "Zebra", "apple"])
    );
    assert_eq!(
        setting(&pool, "livetv_restricted_groups_exempt")
            .await
            .as_deref(),
        Some("not json")
    );
    assert_eq!(
        json(setting(&pool, "livetv_restricted_groups_vanished").await),
        serde_json::json!({"A": "2024-01-01T00:00:00.000Z", "C": "2024-03-01T00:00:00.000Z", "D": "2024-04-01T00:00:00.000Z"})
    );
}

#[sqlx::test(migrations = false)]
async fn m1785600_skips_unexpected_setting_shapes(pool: PgPool) {
    apply_until(&pool, 1_785_600_000_000).await;
    sql(
        &pool,
        r#"
        INSERT INTO app_settings (key, value) VALUES
          ('livetv_restricted_groups', '{"a":1}'),
          ('livetv_restricted_groups_exempt', ' ["x"] '),
          ('livetv_restricted_groups_vanished', '[1]');
    "#,
    )
    .await;
    apply_only(&pool, 1_785_600_000_000).await;

    assert_eq!(
        setting(&pool, "livetv_restricted_groups").await.as_deref(),
        Some(r#"{"a":1}"#)
    );
    assert_eq!(
        json(setting(&pool, "livetv_restricted_groups_exempt").await),
        serde_json::json!(["x"])
    );
    assert_eq!(
        setting(&pool, "livetv_restricted_groups_vanished")
            .await
            .as_deref(),
        Some("[1]")
    );
}

#[sqlx::test(migrations = false)]
async fn m1787600_backfills_one_row_per_completed_state(pool: PgPool) {
    apply_until(&pool, 1_787_600_000_000).await;
    sql(
        &pool,
        r#"
        INSERT INTO users (id, username) VALUES (1, 'u');
        INSERT INTO media (id, title, type) VALUES (1, 'a', 'movie'), (2, 'b', 'movie'), (3, 'c', 'movie');
        INSERT INTO playback_states ("userId", "mediaId", completed, "lastPlayedAt", "playedAt") VALUES
          (1, 1, true, '2024-02-01T00:00:00Z', '2024-01-01T00:00:00Z'),
          (1, 2, true, '2024-03-01T00:00:00Z', NULL),
          (1, 3, false, '2024-04-01T00:00:00Z', NULL);
    "#,
    )
    .await;
    apply_only(&pool, 1_787_600_000_000).await;

    let got: Vec<(i32, String)> = rows(
        &pool,
        r#"SELECT "mediaId", to_char("playedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') FROM playback_history ORDER BY "mediaId""#,
    )
    .await;
    assert_eq!(
        got,
        vec![(1, "2024-01-01".into()), (2, "2024-03-01".into())]
    );
}

#[sqlx::test(migrations = false)]
async fn m1787800_moves_media_type_into_level(pool: PgPool) {
    apply_until(&pool, 1_787_800_000_000).await;
    sql(
        &pool,
        r#"INSERT INTO cleanup_rules (id, name, criteria, level) VALUES
          (1, 'a', '{"mediaType":"series","neverPlayed":true}', 'movie'),
          (2, 'b', '{"mediaType":"movie"}', 'movie'),
          (3, 'c', '{"mediaType":"series"}', 'series'),
          (4, 'd', '{"neverPlayed":true}', 'episode')"#,
    )
    .await;
    apply_only(&pool, 1_787_800_000_000).await;
    let got: Vec<(i32, String, String)> = rows(
        &pool,
        r#"SELECT id, level, criteria::text FROM cleanup_rules ORDER BY id"#,
    )
    .await;
    assert_eq!(
        got,
        vec![
            (1, "series".into(), r#"{"neverPlayed": true}"#.into()),
            (2, "movie".into(), "{}".into()),
            (3, "series".into(), "{}".into()),
            (4, "episode".into(), r#"{"neverPlayed": true}"#.into()),
        ]
    );
}

#[sqlx::test(migrations = false)]
async fn m1787900_turns_level_into_levels(pool: PgPool) {
    apply_until(&pool, 1_787_900_000_000).await;
    sql(
        &pool,
        r#"INSERT INTO cleanup_rules (id, name, criteria, level) VALUES
          (1, 'a', '{}', 'movie'), (2, 'b', '{}', 'series'), (3, 'c', '{}', 'season'), (4, 'd', '{}', 'episode')"#,
    )
    .await;
    apply_only(&pool, 1_787_900_000_000).await;
    let got: Vec<(i32, String)> = rows(
        &pool,
        r#"SELECT id, "levels"::text FROM cleanup_rules ORDER BY id"#,
    )
    .await;
    let want = [(1, "movie"), (2, "series"), (3, "season"), (4, "episode")];
    assert_eq!(got, want.map(|(i, l)| (i, format!("{{{l}}}"))).to_vec());
    let dropped: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'cleanup_rules' AND column_name = 'level'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(dropped, 0);
}

#[sqlx::test(migrations = false)]
async fn m1789000020_turns_the_media_kind_enums_into_checked_text(pool: PgPool) {
    apply_until(&pool, 1_789_000_000_020).await;
    sql(
        &pool,
        r#"INSERT INTO media (id, title, type) VALUES (1, 'a', 'movie'), (2, 'b', 'series');
           INSERT INTO requests ("mediaType", "tmdbId", title) VALUES ('movie', 1, 'a'), ('series', 2, 'b')"#,
    )
    .await;
    apply_only(&pool, 1_789_000_000_020).await;

    let media: Vec<(i32, String)> = rows(&pool, "SELECT id, type FROM media ORDER BY id").await;
    assert_eq!(media, vec![(1, "movie".into()), (2, "series".into())]);
    let reqs: Vec<(String,)> = rows(&pool, r#"SELECT "mediaType" FROM requests ORDER BY id"#).await;
    assert_eq!(reqs, vec![("movie".into(),), ("series".into(),)]);
    for bad in [
        "INSERT INTO media (title, type) VALUES ('x', 'book')",
        r#"INSERT INTO requests ("mediaType", "tmdbId", title) VALUES ('book', 3, 'x')"#,
    ] {
        assert!(sqlx::raw_sql(bad).execute(&pool).await.is_err(), "{bad}");
    }
}

#[sqlx::test(migrations = false)]
async fn m1789000030_moves_the_provider_ids_into_media_external_ids(pool: PgPool) {
    apply_until(&pool, 1_789_000_000_030).await;
    sql(
        &pool,
        r#"INSERT INTO media (id, title, type, "tmdbId", "tvdbId", "imdbId") VALUES
          (1, 'a', 'movie', 603, 111, 'tt1'), (2, 'b', 'series', 603, 222, 'tt2'),
          (3, 'c', 'series', 604, 222, 'tt2'), (4, 'd', 'movie', 0, 0, ''), (5, 'e', 'movie', NULL, NULL, NULL)"#,
    )
    .await;
    apply_only(&pool, 1_789_000_000_030).await;

    let got: Vec<(i32, String, String, String)> = rows(
        &pool,
        r#"SELECT "mediaId", kind, provider, value FROM media_external_ids ORDER BY "mediaId", provider"#,
    )
    .await;
    // TVDB and IMDb ids were never unique: media 3 keeps the ones media 2 has.
    let want = [
        (1, "movie", "imdb", "tt1"),
        (1, "movie", "tmdb", "603"),
        (1, "movie", "tvdb", "111"),
        (2, "series", "imdb", "tt2"),
        (2, "series", "tmdb", "603"),
        (2, "series", "tvdb", "222"),
        (3, "series", "imdb", "tt2"),
        (3, "series", "tmdb", "604"),
        (3, "series", "tvdb", "222"),
    ];
    let want: Vec<_> = want
        .iter()
        .map(|(i, a, b, c)| (*i, a.to_string(), b.to_string(), c.to_string()))
        .collect();
    assert_eq!(got, want);
    let gone: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'media' AND column_name IN ('tmdbId', 'tvdbId', 'imdbId')"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(gone, 0);
    sql(
        &pool,
        "INSERT INTO media (id, title, type) VALUES (9, 'f', 'movie')",
    )
    .await;
    for bad in [
        // movie 1 holds TMDB 603
        r#"INSERT INTO media_external_ids VALUES (9, 'movie', 'tmdb', '603')"#,
        r#"INSERT INTO media_external_ids VALUES (9, 'movie', 'tmdb', '0603')"#,
        r#"INSERT INTO media_external_ids VALUES (9, 'movie', 'tvdb', 'x')"#,
        r#"INSERT INTO media_external_ids VALUES (9, 'movie', 'imdb', '')"#,
        r#"INSERT INTO media_external_ids VALUES (9, 'movie', 'isbn', '5')"#,
        // the kind must be the media's, and the media must exist
        r#"INSERT INTO media_external_ids VALUES (9, 'series', 'tvdb', '5')"#,
        r#"INSERT INTO media_external_ids VALUES (99, 'movie', 'tvdb', '5')"#,
    ] {
        assert!(sqlx::raw_sql(bad).execute(&pool).await.is_err(), "{bad}");
    }
    // The same TVDB id on two media of a kind is fine, and the rows follow their media.
    sql(
        &pool,
        r#"INSERT INTO media_external_ids VALUES (9, 'movie', 'tvdb', '111');
           UPDATE media SET type = 'series' WHERE id = 9"#,
    )
    .await;
    let kind: String =
        sqlx::query_scalar(r#"SELECT kind FROM media_external_ids WHERE "mediaId" = 9"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(kind, "series");
    sql(&pool, "DELETE FROM media WHERE id = 9").await;
    let left: i64 =
        sqlx::query_scalar(r#"SELECT COUNT(*) FROM media_external_ids WHERE "mediaId" = 9"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(left, 0);
}

#[sqlx::test(migrations = false)]
async fn m1789000040_names_request_titles_by_provider_and_external_id(pool: PgPool) {
    apply_until(&pool, 1_789_000_000_040).await;
    sql(
        &pool,
        r#"INSERT INTO requests ("mediaType", kind, "tmdbId", title, status) VALUES
          ('movie', 'add', 603, 'a', 'approved'), ('series', 'delete', 1396, 'b', 'pending'),
          ('movie', 'add', 0, 'c', 'pending'), ('movie', 'add', 1000000000, 'd', 'pending')"#,
    )
    .await;
    apply_only(&pool, 1_789_000_000_040).await;

    let got: Vec<(String, String, String, String)> = rows(
        &pool,
        r#"SELECT "mediaType", kind::text, provider, "externalId" FROM requests ORDER BY id"#,
    )
    .await;
    // A pending request for a title outside the library keeps its row; ids no provider issues go.
    let want = [
        ("movie", "add", "tmdb", "603"),
        ("series", "delete", "tmdb", "1396"),
    ];
    let want: Vec<_> = want
        .iter()
        .map(|(a, b, c, d)| (a.to_string(), b.to_string(), c.to_string(), d.to_string()))
        .collect();
    assert_eq!(got, want);
    let gone: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'requests' AND column_name = 'tmdbId'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(gone, 0);
    for bad in [
        r#"INSERT INTO requests ("mediaType", provider, "externalId", title) VALUES ('movie', 'isbn', '5', 'x')"#,
        r#"INSERT INTO requests ("mediaType", provider, "externalId", title) VALUES ('movie', 'tmdb', '0603', 'x')"#,
        r#"INSERT INTO requests ("mediaType", provider, "externalId", title) VALUES ('movie', 'imdb', '', 'x')"#,
    ] {
        assert!(sqlx::raw_sql(bad).execute(&pool).await.is_err(), "{bad}");
    }
    // Requests are not unique per title: several users can ask for one.
    sql(
        &pool,
        r#"INSERT INTO requests ("mediaType", provider, "externalId", title) VALUES
          ('movie', 'tmdb', '603', 'again'), ('movie', 'imdb', 'tt0133093', 'imdb')"#,
    )
    .await;
}

#[sqlx::test(migrations = false)]
async fn m1789000050_turns_seasons_and_episodes_into_items(pool: PgPool) {
    apply_until(&pool, 1_789_000_000_050).await;
    sql(
        &pool,
        r#"INSERT INTO media (id, title, type) VALUES (1, 'm', 'movie'), (2, 's', 'series'), (3, 'n', 'movie');
          INSERT INTO seasons (id, "seasonNumber", "mediaId") VALUES (1, 1, 2), (2, 0, NULL);
          INSERT INTO episodes (id, "episodeNumber", "endEpisodeNumber", "seasonId", "hasFile", "updatedAt") VALUES
            (1, 1, 2, 1, true, '2026-01-01'), (2, 3, NULL, 1, false, '2026-01-01'),
            (3, 1, NULL, 2, false, '2026-01-01'), (4, 1, NULL, NULL, false, '2026-01-01');
          SELECT setval('episodes_id_seq', 4);
          INSERT INTO media_files (id, "mediaId", "relativePath", size, quality, "episodeId") VALUES
            (1, 1, 'a', 1, 'q', NULL), (2, 2, 'b', 1, 'q', 1);
          INSERT INTO episode_markers ("episodeId", type, "startSeconds", "endSeconds") VALUES (1, 'intro', 1, 2), (3, 'intro', 1, 2)"#,
    )
    .await;
    apply_only(&pool, 1_789_000_000_050).await;

    // The orphan season and the episodes without a season go; ids of the others are kept.
    let groups: Vec<(i32, i32, i32)> = rows(
        &pool,
        r#"SELECT id, "mediaId", number FROM item_groups ORDER BY id"#,
    )
    .await;
    assert_eq!(groups, [(1, 2, 1)]);
    type Item = (i32, i32, Option<i32>, Option<i32>, Option<i32>, bool);
    let got: Vec<Item> = rows(
        &pool,
        r#"SELECT id, "mediaId", "groupId", number, "endNumber", "hasFile" FROM items ORDER BY id"#,
    )
    .await;
    // Each movie gets one ungrouped item with a fresh id.
    let want = [
        (1, 2, Some(1), Some(1), Some(2), true),
        (2, 2, Some(1), Some(3), None, false),
        (5, 1, None, None, None, true),
        (6, 3, None, None, None, false),
    ];
    assert_eq!(got, want);
    let editions: Vec<(i32, String)> = rows(
        &pool,
        r#"SELECT "mediaId", family FROM editions ORDER BY "mediaId""#,
    )
    .await;
    assert_eq!(
        editions,
        [
            (1, "video".to_string()),
            (2, "video".to_string()),
            (3, "video".to_string())
        ]
    );
    let bumped: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM items WHERE "groupId" IS NOT NULL AND "updatedAt" <> '2026-01-01'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bumped, 0, "the migration keeps the episodes' updatedAt");
    let markers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM episode_markers")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(markers, 1);
    let file_item: Option<i32> =
        sqlx::query_scalar(r#"SELECT "episodeId" FROM media_files WHERE id = 2"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(file_item, Some(1));

    for bad in [
        // an item's edition and group belong to its media
        r#"INSERT INTO items ("mediaId", "editionId") VALUES (1, (SELECT id FROM editions WHERE "mediaId" = 2))"#,
        r#"INSERT INTO items ("mediaId", "editionId", "groupId", number) VALUES (3, (SELECT id FROM editions WHERE "mediaId" = 3), 1, 1)"#,
        // a grouped item is numbered
        r#"INSERT INTO items ("mediaId", "editionId", "groupId") VALUES (2, (SELECT id FROM editions WHERE "mediaId" = 2), 1)"#,
        r#"INSERT INTO editions ("mediaId", family) VALUES (1, 'audio')"#,
    ] {
        assert!(sqlx::raw_sql(bad).execute(&pool).await.is_err(), "{bad}");
    }
    sql(&pool, "DELETE FROM media WHERE id = 2").await;
    let left: i64 = sqlx::query_scalar(
        r#"SELECT (SELECT COUNT(*) FROM items WHERE "mediaId" = 2) + (SELECT COUNT(*) FROM item_groups) + (SELECT COUNT(*) FROM editions WHERE "mediaId" = 2)"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(left, 0);
}

#[sqlx::test(migrations = false)]
async fn m1789000060_links_files_to_items_through_parts(pool: PgPool) {
    apply_until(&pool, 1_789_000_000_060).await;
    sql(
        &pool,
        r#"INSERT INTO media (id, title, type) VALUES (1, 'm', 'movie'), (2, 's', 'series'), (3, 't', 'series');
          INSERT INTO editions ("mediaId", family) SELECT id, 'video' FROM media;
          INSERT INTO items ("mediaId", "editionId", monitored, "hasFile")
            SELECT 1, id, true, true FROM editions WHERE "mediaId" = 1;
          INSERT INTO item_groups (id, "number", "mediaId") VALUES (1, 1, 2);
          INSERT INTO items (id, "groupId", "mediaId", "editionId", "number", "endNumber", "hasFile") VALUES
            (10, 1, 2, (SELECT id FROM editions WHERE "mediaId" = 2), 1, 3, true),
            (11, 1, 2, (SELECT id FROM editions WHERE "mediaId" = 2), 3, NULL, false);
          INSERT INTO media_files (id, "mediaId", "relativePath", size, quality, "episodeId") VALUES
            (1, 1, 'a', 1, 'q', NULL), (2, 1, 'b', 1, 'q', NULL),
            (3, 2, 'range', 1, 'q', 10), (4, 2, 'version', 1, 'q', 11),
            (5, 2, 'loose', 1, 'q', NULL), (6, 3, 'foreign', 1, 'q', 10),
            (7, 1, 'stale', 1, 'q', 10)"#,
    )
    .await;
    apply_only(&pool, 1_789_000_000_060).await;

    let parts: Vec<(i32, i32, i32)> = rows(
        &pool,
        r#"SELECT "itemId", "mediaFileId", position FROM item_parts ORDER BY 1, 2"#,
    )
    .await;
    let movie_item: i32 = sqlx::query_scalar(r#"SELECT id FROM items WHERE "mediaId" = 1"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    // Every file of a movie is a version of its item, even one with a stale episode; a range reaches the existing item inside it
    // and not the missing one; a loose file and one of another media get no part.
    assert_eq!(
        parts,
        [
            (movie_item, 1, 0),
            (movie_item, 2, 0),
            (movie_item, 7, 0),
            (10, 3, 0),
            (11, 3, 0),
            (11, 4, 0)
        ]
    );
    let owners: Vec<(i32, i32, Option<i32>)> = rows(
        &pool,
        r#"SELECT "mediaFileId", "itemId", "episodeId" FROM media_file_items ORDER BY 1"#,
    )
    .await;
    assert_eq!(
        owners,
        [
            (1, movie_item, None),
            (2, movie_item, None),
            (3, 10, Some(10)),
            (4, 11, Some(11)),
            (7, movie_item, None)
        ]
    );
    let dropped: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public'
           AND ((table_name = 'media_files' AND column_name = 'episodeId')
             OR (table_name = 'items' AND column_name = 'hasFile'))"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(dropped, 0);

    for bad in [
        // a part joins a file and an item of one media
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId") VALUES (10, 6, 3)"#,
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId") VALUES (10, 6, 2)"#,
        r#"INSERT INTO item_parts ("itemId", "mediaFileId", "mediaId", position) VALUES (10, 5, 2, -1)"#,
    ] {
        assert!(sqlx::raw_sql(bad).execute(&pool).await.is_err(), "{bad}");
    }
    sql(&pool, "DELETE FROM media_files WHERE id = 3").await;
    sql(&pool, "DELETE FROM items WHERE id = 11").await;
    let left: i64 = sqlx::query_scalar(r#"SELECT COUNT(*) FROM item_parts WHERE "mediaId" = 2"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0, "parts go with their file or their item");
}

#[sqlx::test(migrations = false)]
async fn m1789000070_keys_progress_and_history_by_item(pool: PgPool) {
    apply_until(&pool, 1_789_000_000_070).await;
    sql(
        &pool,
        r#"INSERT INTO users (id, username) VALUES (1, 'u'), (2, 'v');
          INSERT INTO media (id, title, type) VALUES (1, 'm', 'movie'), (2, 's', 'series'), (3, 't', 'series');
          INSERT INTO editions ("mediaId", family) SELECT id, 'video' FROM media;
          INSERT INTO items ("mediaId", "editionId") SELECT "mediaId", id FROM editions WHERE "mediaId" = 1;
          INSERT INTO item_groups (id, "number", "mediaId") VALUES (1, 1, 2), (2, 1, 3);
          INSERT INTO items (id, "groupId", "mediaId", "editionId", "number") VALUES
            (10, 1, 2, (SELECT id FROM editions WHERE "mediaId" = 2), 1),
            (11, 2, 3, (SELECT id FROM editions WHERE "mediaId" = 3), 1);
          INSERT INTO media_files (id, "mediaId", "relativePath", size, quality) VALUES (1, 1, 'a', 1, 'q');
          INSERT INTO playback_states (id, "userId", "mediaId", "mediaFileId", "episodeId", "positionSeconds", "updatedAt") VALUES
            (1, 1, 1, 1, NULL, 30, '2020-01-01'),
            (2, 1, 2, NULL, 10, 40, '2020-01-01'),
            (3, 2, 2, NULL, 11, 50, '2020-01-01'),
            (4, 2, 2, NULL, NULL, 60, '2020-01-01'),
            (5, 2, 1, NULL, 10, 70, '2020-01-01');
          INSERT INTO playback_history ("userId", "mediaId", "episodeId") VALUES
            (1, 1, NULL), (1, 2, 10), (2, 3, 11), (2, 2, NULL), (2, 1, 10)"#,
    )
    .await;
    apply_only(&pool, 1_789_000_000_070).await;

    let movie_item: i32 = sqlx::query_scalar(r#"SELECT id FROM items WHERE "mediaId" = 1"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    let states: Vec<(i32, i32, i32)> = rows(
        &pool,
        r#"SELECT id, "userId", "itemId" FROM playback_states ORDER BY id"#,
    )
    .await;
    // A series row without episode has no item and goes; an episode of another media keeps its episode.
    assert_eq!(
        states,
        [(1, 1, movie_item), (2, 1, 10), (3, 2, 11), (5, 2, 10)]
    );
    let history: Vec<(i32, i32)> = rows(
        &pool,
        r#"SELECT "userId", "itemId" FROM playback_history ORDER BY id"#,
    )
    .await;
    // The last row is an episode of another media: it keeps its episode as item.
    assert_eq!(history, [(1, movie_item), (1, 10), (2, 11), (2, 10)]);
    let bumped: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM playback_states WHERE "updatedAt" > '2021-01-01'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bumped, 0, "the migration keeps the states' updatedAt");

    sql(&pool, "DELETE FROM media_files WHERE id = 1").await;
    let kept: Option<i32> =
        sqlx::query_scalar(r#"SELECT "mediaFileId" FROM playback_states WHERE id = 1"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(kept, None, "the last file played is never the key");
    assert!(
        sqlx::raw_sql(r#"INSERT INTO playback_states ("userId", "itemId") VALUES (1, 10)"#)
            .execute(&pool)
            .await
            .is_err(),
        "one row per user and item"
    );
    sql(&pool, "DELETE FROM items WHERE id = 10").await;
    let left: i64 = sqlx::query_scalar(
        r#"SELECT (SELECT COUNT(*) FROM playback_states WHERE "itemId" = 10)
              + (SELECT COUNT(*) FROM playback_history WHERE "itemId" = 10)"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(left, 0, "progress and history go with their item");
}

#[sqlx::test(migrations = false)]
async fn m1789000080_keys_playlists_and_parties_by_item(pool: PgPool) {
    apply_until(&pool, 1_789_000_000_080).await;
    sql(
        &pool,
        r#"INSERT INTO users (id, username) VALUES (1, 'u');
          INSERT INTO media (id, title, type) VALUES (1, 'm', 'movie'), (2, 's', 'series');
          INSERT INTO editions ("mediaId", family) SELECT id, 'video' FROM media;
          INSERT INTO items ("mediaId", "editionId") SELECT "mediaId", id FROM editions WHERE "mediaId" = 1;
          INSERT INTO item_groups (id, "number", "mediaId") VALUES (1, 1, 2);
          INSERT INTO items (id, "groupId", "mediaId", "editionId", "number") VALUES
            (10, 1, 2, (SELECT id FROM editions WHERE "mediaId" = 2), 1),
            (11, 1, 2, (SELECT id FROM editions WHERE "mediaId" = 2), 2);
          INSERT INTO media_files (id, "mediaId", "relativePath", size, quality) VALUES (1, 1, 'a', 1, 'q');
          INSERT INTO playlists (id, name, "ownerId") VALUES (1, 'p', 1), (2, 'q', 1);
          INSERT INTO playlist_items (id, "playlistId", "mediaId", "episodeId", position, "updatedAt") VALUES
            (1, 1, 1, NULL, 0, '2020-01-01'), (2, 1, 2, 10, 1, '2020-01-01'),
            (3, 1, 2, 11, 2, '2020-01-01'), (4, 2, 1, 10, 0, '2020-01-01');
          INSERT INTO watch_parties (id, name, "ownerId", "inviteToken", status, "mediaId", "episodeId", "mediaFileId") VALUES
            (1, 'a', 1, 't1', 'live', 1, NULL, 1), (2, 'b', 1, 't2', 'live', 2, 11, NULL),
            (3, 'c', 1, 't3', 'live', 2, 999, NULL), (4, 'd', 1, 't4', 'scheduled', NULL, NULL, NULL),
            (5, 'e', 1, 't5', 'ended', 2, 999, 1);
          INSERT INTO watch_party_items ("partyId", position, "mediaId", "episodeId") VALUES
            (4, 0, 1, NULL), (4, 1, 2, 10), (4, 2, 1, 10);
          INSERT INTO watch_party_proposals (id, "partyId", "mediaId", "episodeId", "proposedBy", "createdAt") VALUES
            (1, 4, 1, NULL, 1, '2020-01-01'), (2, 4, 2, 10, 1, '2020-01-02'), (3, 4, 1, 10, 1, '2020-01-03');
          INSERT INTO watch_party_votes ("proposalId", "userId") VALUES (2, 1), (3, 1)"#,
    )
    .await;
    apply_only(&pool, 1_789_000_000_080).await;

    let movie_item: i32 = sqlx::query_scalar(r#"SELECT id FROM items WHERE "mediaId" = 1"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    let playlist: Vec<(i32, i32)> = rows(
        &pool,
        r#"SELECT "playlistId", "itemId" FROM playlist_items ORDER BY id"#,
    )
    .await;
    // The row of another media's episode keeps its episode.
    assert_eq!(playlist, [(1, movie_item), (1, 10), (1, 11), (2, 10)]);
    let bumped: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM playlist_items WHERE "updatedAt" > '2021-01-01'"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(bumped, 0, "the migration keeps the rows' updatedAt");

    let parties: Vec<(i32, Option<i32>, String, Option<i32>)> = rows(
        &pool,
        r#"SELECT id, "itemId", status, "mediaFileId" FROM watch_parties ORDER BY id"#,
    )
    .await;
    // A live party whose episode is gone ends; an ended one drops its file with its item.
    assert_eq!(
        parties,
        [
            (1, Some(movie_item), "live".into(), Some(1)),
            (2, Some(11), "live".into(), None),
            (3, None, "ended".into(), None),
            (4, None, "scheduled".into(), None),
            (5, None, "ended".into(), None),
        ]
    );
    let programme: Vec<(i32, i32, i32)> = rows(
        &pool,
        r#"SELECT "partyId", position, "itemId" FROM watch_party_items ORDER BY position"#,
    )
    .await;
    assert_eq!(programme, [(4, 0, movie_item), (4, 1, 10)]);
    let proposals: Vec<(i32, i32)> = rows(
        &pool,
        r#"SELECT "partyId", "itemId" FROM watch_party_proposals ORDER BY id"#,
    )
    .await;
    // Two rows naming one item across media collapse to the first, and the lost row's votes go.
    assert_eq!(proposals, [(4, movie_item), (4, 10)]);
    let votes: Vec<(i32,)> = rows(&pool, r#"SELECT "proposalId" FROM watch_party_votes"#).await;
    assert_eq!(votes, [(2,)]);

    for bad in [
        r#"INSERT INTO playlist_items ("playlistId", "itemId", position) VALUES (1, 10, 9)"#,
        r#"INSERT INTO watch_party_items ("partyId", position, "itemId") VALUES (4, 9, 10)"#,
        r#"INSERT INTO watch_party_proposals ("partyId", "itemId", "proposedBy") VALUES (4, 10, 1)"#,
        r#"UPDATE watch_parties SET "itemId" = NULL WHERE id = 1"#,
    ] {
        assert!(sqlx::raw_sql(bad).execute(&pool).await.is_err(), "{bad}");
    }
    sql(&pool, "DELETE FROM items WHERE id = 11").await;
    let left: i64 = sqlx::query_scalar(
        r#"SELECT (SELECT COUNT(*) FROM playlist_items WHERE "itemId" = 11)
              + (SELECT COUNT(*) FROM watch_parties WHERE id = 2)"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(left, 0, "rows and a live party go with their item");
}

const V4_VERSIONS: i64 = 81;
fn sql_files() -> i64 {
    MIGRATOR.migrations.len() as i64
}
const LAST_V4_VERSION: i64 = 1_786_300_000_000;

#[sqlx::test(migrations = false)]
async fn migrate_builds_a_fresh_database(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();

    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations WHERE success")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(n, sql_files());
}

/// One text line per column, index, constraint and enum value, ledgers excluded.
const SCHEMA: &str = r#"
    SELECT 'col ' || concat_ws(' | ', table_name, column_name, data_type, udt_name, is_nullable, column_default)
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name NOT IN ('migrations', '_sqlx_migrations')
    UNION ALL SELECT 'idx ' || indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename NOT IN ('migrations', '_sqlx_migrations')
    UNION ALL SELECT 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text NOT IN ('migrations', '_sqlx_migrations')
    UNION ALL SELECT 'enum ' || t.typname || ' ' || e.enumlabel
      FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    ORDER BY 1
"#;

#[sqlx::test(migrations = false)]
async fn adopting_a_v4_database_matches_a_fresh_one(pool: PgPool) {
    sqlx::raw_sql(include_str!("fixtures/typeorm-81.sql"))
        .execute(&pool)
        .await
        .unwrap();
    fliks_server::db::migrate(&pool).await.unwrap();

    let ledger: Vec<(i64, i64)> = rows(
        &pool,
        "SELECT version, execution_time FROM _sqlx_migrations ORDER BY version",
    )
    .await;
    assert_eq!(ledger.len() as i64, sql_files());
    let adopted_rows = || ledger.iter().filter(|r| r.0 <= LAST_V4_VERSION);
    assert_eq!(adopted_rows().count() as i64, V4_VERSIONS);
    assert!(adopted_rows().all(|r| r.1 == 0), "a 4.x migration re-ran");
    let new_rows = ledger.iter().filter(|r| r.0 > LAST_V4_VERSION);
    assert!(
        new_rows.clone().count() as i64 == sql_files() - V4_VERSIONS
            && new_rows.into_iter().all(|r| r.1 > 0)
    );

    let fresh_db = "fliks_p7_fresh";
    for stmt in [
        format!("DROP DATABASE IF EXISTS {fresh_db}"),
        format!("CREATE DATABASE {fresh_db}"),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(stmt))
            .execute(&pool)
            .await
            .unwrap();
    }
    let fresh = PgPool::connect_with(pool.connect_options().as_ref().clone().database(fresh_db))
        .await
        .unwrap();
    fliks_server::db::migrate(&fresh).await.unwrap();

    let adopted: Vec<(String,)> = rows(&pool, SCHEMA).await;
    let built: Vec<(String,)> = rows(&fresh, SCHEMA).await;
    fresh.close().await;
    sqlx::query(sqlx::AssertSqlSafe(format!("DROP DATABASE {fresh_db}")))
        .execute(&pool)
        .await
        .unwrap();

    assert!(built.len() > 100);
    let only_in = |a: &[(String,)], b: &[(String,)]| -> Vec<String> {
        a.iter()
            .filter(|x| !b.contains(x))
            .map(|x| x.0.clone())
            .collect()
    };
    assert_eq!(
        only_in(&adopted, &built),
        Vec::<String>::new(),
        "only in the 4.x-built schema"
    );
    assert_eq!(
        only_in(&built, &adopted),
        Vec::<String>::new(),
        "only in the sqlx-built schema"
    );
}

#[sqlx::test(migrations = false)]
async fn updating_a_row_bumps_updated_at(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    sql(
        &pool,
        r#"INSERT INTO app_settings (key, value, "updatedAt") VALUES ('k', 'a', '2020-01-01')"#,
    )
    .await;

    sql(&pool, "UPDATE app_settings SET value = 'b'").await;
    let bumped: bool =
        sqlx::query_scalar(r#"SELECT "updatedAt" > now() - interval '1 minute' FROM app_settings"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(bumped);

    sql(
        &pool,
        r#"UPDATE app_settings SET "updatedAt" = '2021-01-01'"#,
    )
    .await;
    let kept: bool =
        sqlx::query_scalar(r#"SELECT "updatedAt" = '2021-01-01+00' FROM app_settings"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(kept);
}

#[sqlx::test(migrations = false)]
async fn migrate_enables_pg_trgm(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let sim: f32 = sqlx::query_scalar("SELECT similarity('a', 'a')")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sim, 1.0);
}

#[sqlx::test(migrations = false)]
async fn m1786600_backfills_the_search_vector_and_keeps_it_current(pool: PgPool) {
    apply_until(&pool, 1_786_600_000_000).await;
    sql(
        &pool,
        r#"INSERT INTO media (id, title, overview, type, "updatedAt") VALUES (1, 'Les Évadés', 'Un banquier', 'movie', '2026-01-01')"#,
    )
    .await;
    apply_only(&pool, 1_786_600_000_000).await;
    let got: Vec<(bool, String)> = rows(
        &pool,
        r#"SELECT "searchVector" = setweight(to_tsvector('french', 'Les Évadés'), 'A')
                  || setweight(to_tsvector('french', ''), 'B') || setweight(to_tsvector('french', 'Un banquier'), 'C'),
                  to_char("updatedAt", 'YYYY-MM-DD') FROM media"#,
    )
    .await;
    assert_eq!(got, vec![(true, "2026-01-01".to_string())]);

    sql(&pool, r#"UPDATE media SET title = 'Zorro' WHERE id = 1"#).await;
    let (weighted,): (bool,) =
        sqlx::query_as(r#"SELECT "searchVector"::text LIKE '%''zorro'':1A%' FROM media"#)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(weighted);
    sql(&pool, r#"INSERT INTO media (id, title, "originalTitle", type) VALUES (2, 'x', 'Original', 'movie')"#).await;
    let (b,): (bool,) = sqlx::query_as(
        r#"SELECT "searchVector"::text LIKE '%''original'':2B%' FROM media WHERE id = 2"#,
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(b);
}

#[sqlx::test(migrations = false)]
async fn m1786700_iso_ms_ignores_the_session_time_zone(pool: PgPool) {
    apply_until(&pool, 1_786_800_000_000).await;
    let mut c = pool.acquire().await.unwrap();
    sqlx::raw_sql("SET TIME ZONE 'Europe/Paris'")
        .execute(&mut *c)
        .await
        .unwrap();
    let got: (String, String) = sqlx::query_as(
        "SELECT iso_ms('2026-01-02 03:04:05.6789'::timestamp), iso_ms('2026-01-02 03:04:05.6789+01'::timestamptz)",
    )
    .fetch_one(&mut *c)
    .await
    .unwrap();
    assert_eq!(
        got,
        (
            "2026-01-02T03:04:05.678Z".into(),
            "2026-01-02T02:04:05.678Z".into()
        )
    );
}

#[sqlx::test(migrations = false)]
async fn m1787200_normalises_media_server_urls_and_events(pool: PgPool) {
    apply_until(&pool, 1_787_200_000_000).await;
    sql(
        &pool,
        r#"INSERT INTO media_servers (id, name, type, url, events) VALUES
           (1, 'a', 'emby', 'emby:8096', '["library.rescan", "bogus", "media.deleted"]'),
           (2, 'b', 'emby', ' https://ok/ ', '[]'),
           (3, 'c', 'emby', 'ftp://x', '["library.rescan"]'),
           (4, 'd', 'plex', 'plex.lan', '["library.rescan"]'),
           (5, 'e', 'emby', '', '[1, null, "file.deleted"]')"#,
    )
    .await;
    apply_only(&pool, 1_787_200_000_000).await;
    let got: Vec<(i32, String, String)> = rows(
        &pool,
        "SELECT id, url, events::text FROM media_servers ORDER BY id",
    )
    .await;
    assert_eq!(
        got,
        vec![
            (
                1,
                "http://emby:8096".into(),
                r#"["library.rescan", "media.deleted"]"#.into()
            ),
            (2, " https://ok/ ".into(), "[]".into()),
            (3, "ftp://x".into(), r#"["library.rescan"]"#.into()),
            (4, "http://plex.lan".into(), "[]".into()),
            (5, "".into(), r#"["file.deleted"]"#.into()),
        ]
    );
}

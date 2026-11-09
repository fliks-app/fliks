//! Ledger, adoption and schema tests; what each migration does is frozen by its checksum.
use sqlx::PgPool;
use sqlx::migrate::Migrator;

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// Test databases are copies of a migrated template1: an empty one for the tests that start from a 4.x schema.
async fn empty(admin: &PgPool) -> PgPool {
    let name = format!("empty_{}", fliks_server::config::random_hex(6));
    sql(admin, &format!("CREATE DATABASE {name} TEMPLATE template0")).await;
    PgPool::connect_with(admin.connect_options().as_ref().clone().database(&name))
        .await
        .unwrap()
}

async fn dispose(admin: &PgPool, pool: PgPool) {
    let name = pool.connect_options().get_database().unwrap().to_owned();
    pool.close().await;
    sql(admin, &format!("DROP DATABASE {name}")).await;
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
async fn adopting_a_v4_database_matches_a_fresh_one(fresh: PgPool) {
    let pool = empty(&fresh).await;
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

    fliks_server::db::migrate(&fresh).await.unwrap();
    let adopted: Vec<(String,)> = rows(&pool, SCHEMA).await;
    let built: Vec<(String,)> = rows(&fresh, SCHEMA).await;
    dispose(&fresh, pool).await;

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

/// Every single-column CHECK as (table.constraint, column, quoted literals sorted).
async fn single_column_checks(pool: &PgPool) -> Vec<(String, String, Vec<String>)> {
    let found: Vec<(String, String, String)> = sqlx::query_as(
        r#"SELECT c.conrelid::regclass::text || '.' || c.conname, a.attname::text, pg_get_constraintdef(c.oid)
             FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'c' AND cardinality(c.conkey) = 1 AND c.connamespace = 'public'::regnamespace
            ORDER BY 1"#,
    )
    .fetch_all(pool)
    .await
    .unwrap();
    found
        .into_iter()
        .map(|(name, column, def)| {
            let mut v: Vec<String> = def
                .split('\'')
                .skip(1)
                .step_by(2)
                .map(str::to_string)
                .collect();
            v.sort();
            v.dedup();
            (name, column, v)
        })
        .collect()
}

/// A kind or family added to the domain must reach every CHECK that lists one, found by its literals.
#[sqlx::test(migrations = false)]
async fn kind_and_family_checks_match_the_domain(pool: PgPool) {
    use fliks_domain::media::kind::MediaKind;
    fliks_server::db::migrate(&pool).await.unwrap();
    let checks = single_column_checks(&pool).await;
    let mut kinds: Vec<String> = MediaKind::ALL.iter().map(|k| k.as_str().into()).collect();
    kinds.sort();

    let (mut lists, mut per_kind, mut levels) = (vec![], vec![], false);
    // `primaryType` is the vocabulary of release types, where `album` is one of them.
    for (name, _, values) in checks
        .iter()
        .filter(|c| c.1 != "primaryType" && c.2.iter().any(|v| kinds.contains(v)))
    {
        if values.len() == 1 {
            per_kind.push(values[0].clone());
        } else if name.starts_with("cleanup_rules.") {
            let rest: Vec<&String> = values.iter().filter(|v| !kinds.contains(v)).collect();
            assert!(
                kinds.iter().all(|k| values.contains(k)),
                "{name} misses a kind"
            );
            assert_eq!(rest, ["episode", "season"], "{name}");
            levels = true;
        } else {
            assert_eq!(values, &kinds, "{name}");
            lists.push(name.clone());
        }
    }
    per_kind.sort();
    assert_eq!(per_kind, kinds, "one details table per kind");
    assert!(levels, "no CHECK on the cleanup levels");
    for table in ["media.", "requests.", "user_quotas."] {
        assert!(
            lists.iter().any(|l| l.starts_with(table)),
            "no kind CHECK on {table}"
        );
    }

    // A family CHECK lists the families some kind is wished in; the other domain families wait for their kind.
    let mut used: Vec<String> = MediaKind::ALL
        .iter()
        .flat_map(|k| k.families().iter().map(|f| f.as_str().to_string()))
        .collect();
    used.sort();
    used.dedup();
    let families: Vec<_> = checks.iter().filter(|c| c.1 == "family").collect();
    assert!(families.len() >= 4, "family checks found: {families:?}");
    for (name, _, values) in families {
        assert_eq!(values, &used, "{name}");
    }
}

/// A cascade or restrict check on the parent scans the child unless an index leads with the FK columns;
/// a partial index is useless to it.
#[sqlx::test(migrations = false)]
async fn every_foreign_key_has_a_covering_index(pool: PgPool) {
    fliks_server::db::migrate(&pool).await.unwrap();
    let missing: Vec<(String, String, String)> = rows(
        &pool,
        r#"
        SELECT c.conrelid::regclass::text, c.conname,
               (SELECT string_agg(a.attname, ', ' ORDER BY a.attnum)
                  FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey))
          FROM pg_constraint c
         WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
           AND NOT EXISTS (
             SELECT 1 FROM pg_index i
              WHERE i.indrelid = c.conrelid AND i.indisvalid AND i.indpred IS NULL
                AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] <@ c.conkey
                AND c.conkey <@ (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)])
         ORDER BY 1, 2"#,
    )
    .await;
    assert!(
        missing.is_empty(),
        "foreign keys without a non-partial index led by their columns (table, constraint, columns): {missing:?}"
    );
}

const PREFLIGHT: i64 = 1_789_000_000_015;

async fn count(pool: &PgPool, table: &str) -> i64 {
    sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
        .fetch_one(pool)
        .await
        .unwrap()
}

const V4_LIBRARIES: &str = r#"INSERT INTO libraries (id, name, path, "mediaTypes") VALUES
    (1, 'Movies', '/data/movies/', '["movie"]'), (2, 'Shows', '/data/shows', '["series"]');
  INSERT INTO media (id, title, type, "libraryId", "folderName") VALUES
    (1, 'Film', 'movie', 1, 'Film (2020)'), (2, 'Loose', 'movie', NULL, 'Loose (2021)'), (3, 'Show', 'series', 2, 'Show');
  INSERT INTO media_files (id, "mediaId", "relativePath", size, quality) VALUES
    (1, 1, 'Film (2020).mkv', 1, 'q'), (2, 2, 'Loose (2021).mkv', 1, 'q'), (3, 3, 'Season 01/Show - S01E01.mkv', 1, 'q')"#;

#[sqlx::test(migrations = false)]
async fn adopting_a_v4_database_places_its_files_in_folders(admin: PgPool) {
    let pool = empty(&admin).await;
    sqlx::raw_sql(include_str!("fixtures/typeorm-81.sql"))
        .execute(&pool)
        .await
        .unwrap();
    sql(&pool, V4_LIBRARIES).await;
    fliks_server::db::migrate(&pool).await.unwrap();

    let got: Vec<(i32, String, String)> = rows(
        &pool,
        r#"SELECT f.id, lf.path, f."relativePath" FROM media_files f JOIN library_folders lf ON lf.id = f."folderId" ORDER BY f.id"#,
    )
    .await;
    assert_eq!(
        got,
        vec![
            (
                1,
                "/data/movies".into(),
                "Film (2020)/Film (2020).mkv".into()
            ),
            (
                2,
                "/data/movies".into(),
                "Loose (2021)/Loose (2021).mkv".into()
            ),
            (
                3,
                "/data/shows".into(),
                "Show/Season 01/Show - S01E01.mkv".into()
            ),
        ],
        "the paths are normalised, the media outside any library joins the one that takes movies"
    );
    let lib: Option<i32> = sqlx::query_scalar(r#"SELECT "libraryId" FROM media WHERE id = 2"#)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(lib, Some(1));
    dispose(&admin, pool).await;
}

#[sqlx::test(migrations = false)]
async fn a_refused_adoption_leaves_the_4x_database_as_it_was(admin: PgPool) {
    let pool = empty(&admin).await;
    sqlx::raw_sql(include_str!("fixtures/typeorm-81.sql"))
        .execute(&pool)
        .await
        .unwrap();
    sql(&pool, V4_LIBRARIES).await;
    sql(&pool, "UPDATE libraries SET path = NULL WHERE id = 2").await;
    let e = fliks_server::db::migrate(&pool).await.expect_err("refused");
    assert!(e.to_string().contains("hold files but have no path"), "{e}");
    let newest: i64 = sqlx::query_scalar("SELECT max(version) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(newest < PREFLIGHT, "no 6.0.0 migration committed");
    assert_eq!(count(&pool, "media_files").await, 3);
    dispose(&admin, pool).await;
}

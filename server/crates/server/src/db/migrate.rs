use sha2::{Digest, Sha384};
use sqlx::ConnectOptions;
use sqlx::migrate::{Migrate, Migrator};
use sqlx::postgres::{PgPool, PgPoolOptions};
use std::time::{Duration, Instant};

pub use sqlx::migrate::MigrateError;

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

/// How a backup's ledger row compares with this build's migration of that version.
#[derive(Debug, PartialEq)]
pub enum Ledger {
    /// A later build wrote it.
    Unknown,
    /// Same version, other file: an unreleased migration edited since.
    Edited,
    Same,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The checksum a build whose checkout turned the file into CRLF (a Windows runner) embedded.
fn crlf_checksum(m: &sqlx::migrate::Migration) -> Vec<u8> {
    let crlf = m.sql.as_str().replace("\r\n", "\n").replace('\n', "\r\n");
    Sha384::digest(crlf.as_bytes()).to_vec()
}

/// `checksum` is the bytea as `COPY` writes it (`\\x<hex>`); absent when the dump has no such column.
/// The file's CRLF twin counts as the same file: only the line endings differ.
pub fn ledger_row(version: i64, checksum: Option<&str>) -> Ledger {
    let Some(m) = migration_for_version(version) else {
        return Ledger::Unknown;
    };
    match checksum.map(|c| c.strip_prefix("\\\\x")) {
        Some(c)
            if c != Some(hex(&m.checksum).as_str())
                && c != Some(hex(&crlf_checksum(m)).as_str()) =>
        {
            Ledger::Edited
        }
        _ => Ledger::Same,
    }
}

/// A database migrated by a build that saw CRLF files holds the CRLF checksums: rewrite them to the file's own,
/// so the ledger of one database fits a build from any checkout.
async fn normalise_line_endings(
    pool: &PgPool,
    applied: &[sqlx::migrate::AppliedMigration],
) -> Result<(), MigrateError> {
    for a in applied {
        let Some(m) = migration_for_version(a.version) else {
            continue;
        };
        if a.checksum.as_ref() != m.checksum.as_ref()
            && a.checksum.as_ref() == crlf_checksum(m).as_slice()
        {
            sqlx::query("UPDATE _sqlx_migrations SET checksum = $1 WHERE version = $2")
                .bind(m.checksum.as_ref())
                .bind(a.version)
                .execute(pool)
                .await
                .map_err(MigrateError::Execute)?;
        }
    }
    Ok(())
}

/// A ledger row this build has no file for was written by a newer Fliks: say so instead of sqlx's raw text.
fn newer_database(e: MigrateError) -> MigrateError {
    match e {
        MigrateError::VersionMissing(v) => MigrateError::Source(
            format!(
                "the database holds migration {v}, which this version of Fliks does not know: it was \
                 migrated by a newer version. Start that version, or put back a backup taken before \
                 the upgrade (`fliks-server restore <file>`, which needs PostgreSQL 17 or later, then \
                 start the older version)"
            )
            .into(),
        ),
        e => e,
    }
}

fn migration_for_version(version: i64) -> Option<&'static sqlx::migrate::Migration> {
    MIGRATOR.iter().find(|m| m.version == version)
}

async fn table_exists(pool: &PgPool, name: &str) -> Result<bool, MigrateError> {
    let exists = sqlx::query_scalar!(
        r#"SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = $1
        ) AS "exists!""#,
        name
    )
    .fetch_one(pool)
    .await
    .map_err(MigrateError::Execute)?;

    Ok(exists)
}

pub async fn adopt_typeorm(pool: &PgPool) -> Result<(), MigrateError> {
    if table_exists(pool, "_sqlx_migrations").await? {
        return Ok(());
    }

    let has_ledger = table_exists(pool, "migrations").await?;
    // The legacy ledger tables are not in the migrated schema, so these two stay runtime queries.
    let typeorm_rows: Vec<(i64, String)> = if has_ledger {
        sqlx::query_as("SELECT timestamp, name FROM migrations ORDER BY timestamp")
            .fetch_all(pool)
            .await
            .map_err(MigrateError::Execute)?
    } else {
        Vec::new()
    };

    if typeorm_rows.is_empty() {
        let others = sqlx::query_scalar!(
            r#"SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'migrations') AS "others!""#,
        )
        .fetch_one(pool)
        .await
        .map_err(MigrateError::Execute)?;
        if others {
            return Err(MigrateError::Source(
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "database built by TypeORM synchronize (empty migrations ledger): re-baseline it, see CLAUDE.md (repo root) 'Dev database re-baseline'",
                )
                .into(),
            ));
        }
        if !has_ledger {
            return Ok(());
        }
    }

    let mut tx = pool.begin().await.map_err(MigrateError::Execute)?;

    tx.ensure_migrations_table("_sqlx_migrations").await?;

    for (timestamp, name) in typeorm_rows {
        let Some(migration) = migration_for_version(timestamp) else {
            return Err(MigrateError::Source(
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "no embedded sqlx migration for TypeORM ledger row timestamp={timestamp} name={name:?}"
                    ),
                )
                .into(),
            ));
        };

        sqlx::query(
            r#"
INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
VALUES ($1, $2, TRUE, $3, 0)
            "#,
        )
        .bind(migration.version)
        .bind(migration.description.as_ref())
        .bind(migration.checksum.as_ref())
        .execute(&mut *tx)
        .await
        .map_err(MigrateError::Execute)?;
    }

    tx.commit().await.map_err(MigrateError::Execute)?;

    Ok(())
}

/// Newest applied version when an embedded migration is pending; `None` for an empty or up-to-date database.
pub async fn pending_version(pool: &PgPool) -> Result<Option<i64>, MigrateError> {
    let applied: Vec<i64> = if table_exists(pool, "_sqlx_migrations").await? {
        sqlx::query_scalar("SELECT version FROM _sqlx_migrations WHERE success")
    } else if table_exists(pool, "migrations").await? {
        sqlx::query_scalar("SELECT timestamp FROM migrations")
    } else {
        sqlx::query_scalar("SELECT 0::bigint WHERE false")
    }
    .fetch_all(pool)
    .await
    .map_err(MigrateError::Execute)?;
    if applied.is_empty() {
        let any: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public')",
        )
        .fetch_one(pool)
        .await
        .map_err(MigrateError::Execute)?;
        return Ok(any.then_some(0));
    }
    let behind = MIGRATOR.iter().any(|m| !applied.contains(&m.version));
    Ok(behind.then(|| applied.into_iter().max().unwrap_or(0)))
}

pub async fn migrate(pool: &PgPool) -> Result<(), MigrateError> {
    adopt_typeorm(pool).await?;
    // A migration rewrites whole tables: slow by design, not worth a slow-statement warning.
    let opts = migration_options(pool);
    let quiet = PgPoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(MigrateError::Execute)?;
    let result = run_logged(&quiet).await.map_err(newer_database);
    quiet.close().await;
    result
}

/// The pool's login without its slow-statement log and its `lock_timeout`: a migration waits for its locks.
fn migration_options(pool: &PgPool) -> sqlx::postgres::PgConnectOptions {
    (*pool.connect_options())
        .clone()
        .options([("lock_timeout", "0")])
        .log_slow_statements(log::LevelFilter::Off, Duration::ZERO)
}

async fn run_logged(pool: &PgPool) -> Result<(), MigrateError> {
    let mut conn = pool.acquire().await.map_err(MigrateError::Execute)?;
    conn.ensure_migrations_table(&MIGRATOR.table_name).await?;
    let applied = conn.list_applied_migrations(&MIGRATOR.table_name).await?;
    drop(conn);
    normalise_line_endings(pool, &applied).await?;
    let pending = MIGRATOR
        .iter()
        .filter(|m| !m.migration_type.is_down_migration())
        .filter(|m| !applied.iter().any(|a| a.version == m.version))
        .count();
    if pending > 0 {
        tracing::info!("applying {pending} database migration(s), this can take a while");
    }
    let started = Instant::now();
    MIGRATOR.run(pool).await?;
    if pending > 0 {
        tracing::info!(
            "database migrations applied in {:.1} s",
            started.elapsed().as_secs_f64()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, PgConnection};

    /// Test databases are copies of a migrated template1: these tests start from an empty one.
    async fn empty(admin: &PgPool) -> PgPool {
        let name = format!("empty_{}", crate::config::random_hex(6));
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "CREATE DATABASE {name} TEMPLATE template0"
        )))
        .execute(admin)
        .await
        .unwrap();
        PgPool::connect_with(admin.connect_options().as_ref().clone().database(&name))
            .await
            .unwrap()
    }

    async fn dispose(admin: &PgPool, pool: PgPool) {
        let name = pool.connect_options().get_database().unwrap().to_owned();
        pool.close().await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!("DROP DATABASE {name}")))
            .execute(admin)
            .await
            .unwrap();
    }

    async fn create_typeorm_migrations(pool: &PgPool) -> Result<(), sqlx::Error> {
        sqlx::query(
            "CREATE TABLE migrations (
                id serial PRIMARY KEY,
                timestamp bigint NOT NULL,
                name varchar NOT NULL
            )",
        )
        .execute(pool)
        .await?;
        Ok(())
    }

    #[sqlx::test(migrations = false)]
    async fn adopt_typeorm_maps_typeorm_ledger(admin: PgPool) -> sqlx::Result<()> {
        let pool = empty(&admin).await;
        create_typeorm_migrations(&pool).await?;

        sqlx::query("INSERT INTO migrations (timestamp, name) VALUES ($1, $2)")
            .bind(1_777_816_212_948_i64)
            .bind("Baseline1777816212948")
            .execute(&pool)
            .await?;
        sqlx::query("INSERT INTO migrations (timestamp, name) VALUES ($1, $2)")
            .bind(1_786_300_000_000_i64)
            .bind("CreatePlaybackQoe1786300000000")
            .execute(&pool)
            .await?;

        adopt_typeorm(&pool).await.expect("adopt should succeed");

        let baseline = migration_for_version(1_777_816_212_948).unwrap();
        let playback = migration_for_version(1_786_300_000_000).unwrap();

        let rows: Vec<(i64, bool, i64, Vec<u8>)> = sqlx::query_as(
            "SELECT version, success, execution_time, checksum
             FROM _sqlx_migrations
             ORDER BY version",
        )
        .fetch_all(&pool)
        .await?;

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, baseline.version);
        assert!(rows[0].1);
        assert_eq!(rows[0].2, 0);
        assert_eq!(rows[0].3.as_slice(), baseline.checksum.as_ref());
        assert_eq!(rows[1].0, playback.version);
        assert!(rows[1].1);
        assert_eq!(rows[1].2, 0);
        assert_eq!(rows[1].3.as_slice(), playback.checksum.as_ref());

        adopt_typeorm(&pool)
            .await
            .expect("second adopt is idempotent");

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*)::bigint FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await?;
        assert_eq!(count, 2);

        dispose(&admin, pool).await;
        Ok(())
    }

    #[sqlx::test(migrations = false)]
    async fn adopt_typeorm_rejects_unknown_typeorm_row(admin: PgPool) -> sqlx::Result<()> {
        let pool = empty(&admin).await;
        create_typeorm_migrations(&pool).await?;

        sqlx::query("INSERT INTO migrations (timestamp, name) VALUES ($1, $2)")
            .bind(1_i64)
            .bind("nope")
            .execute(&pool)
            .await?;

        assert!(adopt_typeorm(&pool).await.is_err());

        assert!(
            !table_exists(&pool, "_sqlx_migrations")
                .await
                .expect("existence check")
        );

        dispose(&admin, pool).await;
        Ok(())
    }

    #[sqlx::test(migrations = false)]
    async fn a_ledger_written_from_crlf_files_is_normalised(admin: PgPool) -> sqlx::Result<()> {
        let pool = empty(&admin).await;
        migrate(&pool).await.unwrap();
        let m = MIGRATOR.iter().next().unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = $1 WHERE version = $2")
            .bind(crlf_checksum(m))
            .bind(m.version)
            .execute(&pool)
            .await?;
        migrate(&pool).await.unwrap();
        let stored: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = $1")
                .bind(m.version)
                .fetch_one(&pool)
                .await?;
        assert_eq!(stored.as_slice(), m.checksum.as_ref());
        dispose(&admin, pool).await;
        Ok(())
    }

    #[test]
    fn a_backup_ledger_with_the_crlf_checksum_is_the_same_file() {
        let m = MIGRATOR.iter().next().unwrap();
        let dump = |sum: &[u8]| format!("\\\\x{}", hex(sum));
        assert_eq!(
            ledger_row(m.version, Some(&dump(&crlf_checksum(m)))),
            Ledger::Same
        );
        assert_eq!(
            ledger_row(m.version, Some(&dump(&m.checksum))),
            Ledger::Same
        );
        assert_eq!(
            ledger_row(m.version, Some(&dump(&[0u8; 48]))),
            Ledger::Edited
        );
    }

    #[sqlx::test(migrations = false)]
    async fn migrations_wait_for_their_locks(admin: PgPool) -> sqlx::Result<()> {
        let capped = PgPoolOptions::new()
            .max_connections(1)
            .connect_with(
                admin
                    .connect_options()
                    .as_ref()
                    .clone()
                    .options([("lock_timeout", "60s")]),
            )
            .await?;
        let mut conn = PgConnection::connect_with(&migration_options(&capped)).await?;
        let timeout: String = sqlx::query_scalar("SELECT current_setting('lock_timeout')")
            .fetch_one(&mut conn)
            .await?;
        assert_eq!(timeout, "0");
        Ok(())
    }

    #[sqlx::test(migrations = false)]
    async fn adopt_typeorm_refuses_synchronize_built_database(admin: PgPool) -> sqlx::Result<()> {
        let pool = empty(&admin).await;
        create_typeorm_migrations(&pool).await?;
        sqlx::query("CREATE TABLE users (id serial PRIMARY KEY)")
            .execute(&pool)
            .await?;

        let err = migrate(&pool).await.unwrap_err();
        assert!(err.to_string().contains("empty migrations ledger"), "{err}");
        assert!(!table_exists(&pool, "_sqlx_migrations").await.unwrap());

        dispose(&admin, pool).await;
        Ok(())
    }

    #[sqlx::test(migrations = false)]
    async fn adopt_typeorm_refuses_synchronize_database_without_ledger(
        admin: PgPool,
    ) -> sqlx::Result<()> {
        let pool = empty(&admin).await;
        sqlx::query("CREATE TABLE users (id serial PRIMARY KEY)")
            .execute(&pool)
            .await?;

        let err = migrate(&pool).await.unwrap_err();
        assert!(err.to_string().contains("empty migrations ledger"), "{err}");
        assert!(!table_exists(&pool, "_sqlx_migrations").await.unwrap());

        dispose(&admin, pool).await;
        Ok(())
    }
}

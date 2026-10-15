use sqlx::migrate::{Migrate, Migrator};
use sqlx::postgres::PgPool;

pub use sqlx::migrate::MigrateError;

static MIGRATOR: Migrator = sqlx::migrate!("../../migrations");

fn migration_for_version(version: i64) -> Option<&'static sqlx::migrate::Migration> {
    MIGRATOR.iter().find(|m| m.version == version)
}

async fn table_exists(pool: &PgPool, name: &str) -> Result<bool, MigrateError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (
            SELECT 1
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = $1
        )",
    )
    .bind(name)
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
    let typeorm_rows: Vec<(i64, String)> = if has_ledger {
        sqlx::query_as("SELECT timestamp, name FROM migrations ORDER BY timestamp")
            .fetch_all(pool)
            .await
            .map_err(MigrateError::Execute)?
    } else {
        Vec::new()
    };

    if typeorm_rows.is_empty() {
        let others: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name <> 'migrations')",
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

    tx.ensure_migrations_table().await?;

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

pub async fn migrate(pool: &PgPool) -> Result<(), MigrateError> {
    adopt_typeorm(pool).await?;
    MIGRATOR.run(pool).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn adopt_typeorm_maps_typeorm_ledger(pool: PgPool) -> sqlx::Result<()> {
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

        Ok(())
    }

    #[sqlx::test(migrations = false)]
    async fn adopt_typeorm_rejects_unknown_typeorm_row(pool: PgPool) -> sqlx::Result<()> {
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

        Ok(())
    }

    #[sqlx::test(migrations = false)]
    async fn adopt_typeorm_refuses_synchronize_built_database(pool: PgPool) -> sqlx::Result<()> {
        create_typeorm_migrations(&pool).await?;
        sqlx::query("CREATE TABLE users (id serial PRIMARY KEY)")
            .execute(&pool)
            .await?;

        let err = migrate(&pool).await.unwrap_err();
        assert!(err.to_string().contains("empty migrations ledger"), "{err}");
        assert!(!table_exists(&pool, "_sqlx_migrations").await.unwrap());

        Ok(())
    }

    #[sqlx::test(migrations = false)]
    async fn adopt_typeorm_refuses_synchronize_database_without_ledger(
        pool: PgPool,
    ) -> sqlx::Result<()> {
        sqlx::query("CREATE TABLE users (id serial PRIMARY KEY)")
            .execute(&pool)
            .await?;

        let err = migrate(&pool).await.unwrap_err();
        assert!(err.to_string().contains("empty migrations ledger"), "{err}");
        assert!(!table_exists(&pool, "_sqlx_migrations").await.unwrap());

        Ok(())
    }
}

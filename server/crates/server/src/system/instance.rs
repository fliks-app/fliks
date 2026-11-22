//! One server per database: the running server holds a session advisory lock that `fliks-server restore` tests.
//! It covers a restore started from another container, which no loopback probe sees.
use sqlx::PgConnection;

const KEY: &str = "fliks:instance";

/// Takes the lock on `conn`, which must then stay open; false when another session holds it.
pub async fn claim(conn: &mut PgConnection) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtext($1))")
        .bind(KEY)
        .fetch_one(conn)
        .await
}

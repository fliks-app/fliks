//! One server per database: the running server holds a session advisory lock that `fliks-server restore` tests.
//! It covers a restore started from another container, which no loopback probe sees.
use sqlx::{Connection, PgConnection, postgres::PgConnectOptions};
use std::time::{Duration, Instant};

const KEY: &str = "fliks:instance";
const RETRY: Duration = Duration::from_secs(2);

/// Takes the lock on `conn`, which must then stay open; false when another session holds it.
pub async fn claim(conn: &mut PgConnection) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT pg_try_advisory_lock(hashtext($1))")
        .bind(KEY)
        .fetch_one(conn)
        .await
}

/// Boot: waits for the holder (a restore, or the server being replaced) up to `wait`, so no migration or
/// plugin boot runs on a database a restore is rewriting.
pub async fn claim_waiting(conn: &mut PgConnection, wait: Duration) -> Result<(), String> {
    let started = Instant::now();
    let mut warned = false;
    while !claim(conn).await.map_err(|e| e.to_string())? {
        if started.elapsed() >= wait {
            return Err(format!(
                "another Fliks server or restore has held this database for {} s: stop it or wait for it to end",
                wait.as_secs()
            ));
        }
        if !std::mem::replace(&mut warned, true) {
            tracing::warn!(
                "another Fliks server or restore is using this database, waiting for it"
            );
        }
        tokio::time::sleep(RETRY).await;
    }
    Ok(())
}

/// Keeps the lock for the life of the process: a Postgres restart ends the session and its lock, so a dead
/// connection is replaced and the lock taken again.
pub fn keep(db: PgConnectOptions, mut conn: PgConnection, every: Duration) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(every).await;
            if conn.ping().await.is_ok() {
                continue;
            }
            match PgConnection::connect_with(&db).await {
                Ok(mut c) => match claim(&mut c).await {
                    Ok(true) => {
                        tracing::info!(
                            "instance lock taken again after the database connection was lost"
                        );
                        conn = c;
                    }
                    Ok(false) => {
                        tracing::warn!("another Fliks server or restore holds the instance lock")
                    }
                    Err(e) => tracing::warn!("instance lock not taken again: {e}"),
                },
                Err(e) => tracing::warn!("instance lock not taken again: {e}"),
            }
        }
    });
}

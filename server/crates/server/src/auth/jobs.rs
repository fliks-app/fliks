//! Boot-time loop: hourly pairing and sign-in-row cleanup; the refresh-token prune runs in the daily prune tick.
use super::db;
use chrono::Utc;
use sqlx::PgPool;
use std::time::Duration;
use tokio::time::{Instant, MissedTickBehavior, interval_at};

pub fn spawn(pool: PgPool) {
    tokio::spawn(async move {
        let hour = Duration::from_secs(3600);
        let mut tick = interval_at(Instant::now() + hour, hour);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if let Err(e) = db::cleanup_pairings(&pool, Utc::now()).await {
                tracing::warn!(error = %e, "pairing cleanup failed");
            }
            if let Err(e) = super::oidc::cleanup_logins(&pool, Utc::now()).await {
                tracing::warn!(error = %e, "oidc login cleanup failed");
            }
        }
    });
}

/// The refresh tokens past their lifetime, pruned once a day by the jobs runner.
pub async fn prune_refresh_tokens(db: &PgPool) {
    match db::prune_refresh_tokens(db, Utc::now()).await {
        Ok(n) => tracing::info!(rows = n, "refresh tokens pruned"),
        Err(e) => tracing::warn!(error = %e, "refresh token prune failed"),
    }
}

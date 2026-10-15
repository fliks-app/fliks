//! Boot-time loops: hourly pairing cleanup, daily refresh-token prune (F6) at 03:30 local.
use super::db;
use chrono::{Duration as Span, Local, NaiveDateTime, Utc};
use sqlx::PgPool;
use std::time::Duration;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};

pub fn spawn(db: PgPool) {
    let pool = db.clone();
    tokio::spawn(async move {
        let hour = Duration::from_secs(3600);
        let mut tick = interval_at(Instant::now() + hour, hour);
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if let Err(e) = db::cleanup_pairings(&pool, Utc::now()).await {
                tracing::warn!(error = %e, "pairing cleanup failed");
            }
        }
    });
    tokio::spawn(async move {
        loop {
            sleep(until_next(Local::now().naive_local())).await;
            match db::prune_refresh_tokens(&db, Utc::now()).await {
                Ok(n) => tracing::info!(rows = n, "refresh tokens pruned"),
                Err(e) => tracing::warn!(error = %e, "refresh token prune failed"),
            }
            // Avoid re-firing within the same second.
            sleep(Duration::from_secs(1)).await;
        }
    });
}

/// Wait until the next 03:30 wall-clock; a DST change shifts one run by an hour at most.
fn until_next(now: NaiveDateTime) -> Duration {
    let mut at = now.date().and_hms_opt(3, 30, 0).expect("valid time");
    if at <= now {
        at += Span::days(1);
    }
    (at - now).to_std().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }

    #[test]
    fn next_run_is_the_coming_0330() {
        assert_eq!(until_next(at("2026-01-01 03:00:00")).as_secs(), 1800);
        assert_eq!(until_next(at("2026-01-01 03:30:00")).as_secs(), 86400);
        assert_eq!(until_next(at("2026-01-01 23:30:00")).as_secs(), 4 * 3600);
    }
}

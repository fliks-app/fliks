//! The three live TV jobs (`livetv-sources.md` rules 46-47, `livetv-guide.md` rules 31 and 47): their
//! bodies; the audit row, the claim and the cron are the job runner's.
use super::{
    guide,
    model::{GUIDE_SOURCE_COLS, GuideSource, SOURCE_COLS, Source},
    sync::{self, SyncError},
};
use crate::state::AppState;
use chrono::{DateTime, Duration, Utc};

/// A sync that finished a few minutes late must not wait a whole extra tick.
const DUE_TOLERANCE: Duration = Duration::minutes(5);

/// Never synced, or last synced at least its interval ago (less the tolerance).
pub fn is_due(
    last_sync_at: Option<DateTime<Utc>>,
    interval_hours: i32,
    now: DateTime<Utc>,
) -> bool {
    last_sync_at
        .is_none_or(|t| now - t >= Duration::hours(i64::from(interval_hours)) - DUE_TOLERANCE)
}

/// A scheduled live TV job with nothing to act on is skipped before its audit row.
pub async fn idle(st: &AppState, name: &str) -> bool {
    let probe = match name {
        "LiveTvSourceRefresh" => "SELECT EXISTS (SELECT 1 FROM livetv_sources WHERE enabled)",
        "LiveTvGuideRefresh" => "SELECT EXISTS (SELECT 1 FROM livetv_guide_sources WHERE enabled)",
        "LiveTvGuidePrune" => "SELECT EXISTS (SELECT 1 FROM livetv_programs)",
        _ => return false,
    };
    matches!(sqlx::query_scalar(probe).fetch_one(&st.db).await, Ok(false))
}

/// `LiveTvSourceRefresh`: every enabled, due source in turn; one failing never costs the ones after it.
pub async fn refresh_sources(st: &AppState) -> Result<(), String> {
    let sources: Vec<Source> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {SOURCE_COLS} FROM livetv_sources ORDER BY priority, name, id"
    )))
    .fetch_all(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    for s in sources {
        if !s.enabled || !is_due(s.last_sync_at, s.refresh_interval_hours, Utc::now()) {
            continue;
        }
        match sync::sync(st, s.id).await {
            Ok(_) => {}
            Err(SyncError::Running) => {
                tracing::warn!("Source #{} sync skipped: already running", s.id)
            }
            Err(SyncError::NotFound(_)) => {}
            Err(SyncError::Db(e)) => tracing::warn!("Source #{} sync skipped: {e}", s.id),
        }
    }
    Ok(())
}

/// `LiveTvGuideRefresh`: the same sweep over the guide sources, by name.
pub async fn refresh_guides(st: &AppState) -> Result<(), String> {
    let sources: Vec<GuideSource> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {GUIDE_SOURCE_COLS} FROM livetv_guide_sources ORDER BY name, id"
    )))
    .fetch_all(&st.db)
    .await
    .map_err(|e| e.to_string())?;
    for g in sources {
        if !g.enabled || !is_due(g.last_sync_at, g.refresh_interval_hours, Utc::now()) {
            continue;
        }
        match guide::sync(st, g.id).await {
            Ok(_) | Err(SyncError::NotFound(_)) => {}
            Err(SyncError::Running) => {
                tracing::warn!("Guide source #{} sync skipped: already running", g.id)
            }
            Err(SyncError::Db(e)) => tracing::warn!("Guide source #{} sync skipped: {e}", g.id),
        }
    }
    Ok(())
}

/// `LiveTvGuidePrune`.
pub async fn prune_guide(st: &AppState) -> Result<(), String> {
    let removed = guide::prune(&st.db).await.map_err(|e| e.to_string())?;
    tracing::info!("Guide prune: removed {removed} stale program(s)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn due_means_never_synced_or_an_interval_ago_within_five_minutes() {
        let now = Utc.with_ymd_and_hms(2026, 1, 1, 12, 0, 0).unwrap();
        assert!(is_due(None, 12, now));
        assert!(!is_due(Some(now - Duration::hours(11)), 12, now));
        assert!(is_due(
            Some(now - Duration::hours(11) - Duration::minutes(55)),
            12,
            now
        ));
        assert!(!is_due(
            Some(now - Duration::hours(11) - Duration::minutes(54)),
            12,
            now
        ));
        assert!(is_due(Some(now - Duration::hours(13)), 12, now));
    }
}

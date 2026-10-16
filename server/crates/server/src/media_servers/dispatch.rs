//! Library refresh dispatch (`docs/spec/media-servers.md` rules 10-12); callers spawn it and ignore the result.
use super::{db, emby};
use crate::state::AppState;
use futures_util::future::join_all;

/// Refreshes every enabled Emby server subscribed to `event`; failures are logged, never raised.
pub async fn dispatch(st: &AppState, event: &str) {
    let servers = match db::enabled(&st.db).await {
        Ok(s) => s,
        Err(e) => return tracing::error!(error = %e, event, "media-server dispatch"),
    };
    let targets = servers
        .iter()
        .filter(|s| s.r#type == emby::TYPE && s.events.iter().any(|e| e == event));
    join_all(targets.map(|s| async move {
        let conn = emby::Conn::new(&s.url, s.api_key.as_deref());
        match conn.refresh_library().await {
            Ok(()) => tracing::info!("Emby library refresh triggered on {}", s.name),
            Err(e) => tracing::warn!("Failed to dispatch {event} to {}: {e}", s.name),
        }
    }))
    .await;
}

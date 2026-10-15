//! Household fan-out of `remote.state|stopped|targets_changed` (spec rules 31-34).
use super::db;
use crate::{
    events::{Hub, SseEvent},
    state::AppState,
};
use sqlx::PgPool;
use std::{
    collections::{BTreeSet, HashMap},
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const CACHE: Duration = Duration::from_secs(30);

type Cached = Mutex<HashMap<String, (Vec<i32>, Instant)>>;

struct FanOut {
    db: PgPool,
    hub: Hub,
    // Never invalidated on grant changes, like Nest; keys are one per device or owner seen.
    cache: Cached,
}

/// Grants are keyed by device id: every tab and reconnect of a device shares one permission.
pub fn device_id_of(target_id: &str) -> &str {
    target_id.split('#').next().unwrap_or_default()
}

pub fn init(st: &AppState) {
    let fan = Arc::new(FanOut {
        db: st.db.clone(),
        hub: st.hub.clone(),
        cache: Mutex::default(),
    });
    st.hub.register_household_fan_out(move |ev, owner| {
        let (fan, ev) = (fan.clone(), ev.clone());
        tokio::spawn(async move {
            if let Err(e) = fan.run(&ev, owner).await {
                tracing::warn!(error = %e, "household fan-out failed");
            }
        });
    });
}

impl FanOut {
    async fn cached(
        &self,
        key: String,
        fresh: impl Future<Output = sqlx::Result<Vec<i32>>>,
    ) -> sqlx::Result<Vec<i32>> {
        let hit = {
            let c = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            c.get(&key).filter(|(_, at)| at.elapsed() < CACHE).cloned()
        };
        if let Some((ids, _)) = hit {
            return Ok(ids);
        }
        let ids = fresh.await?;
        self.cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, (ids.clone(), Instant::now()));
        Ok(ids)
    }

    async fn run(&self, ev: &SseEvent, owner: i32) -> sqlx::Result<()> {
        let viewers = match ev {
            SseEvent::RemoteState { target_id, .. } | SseEvent::RemoteStopped { target_id } => {
                let device = device_id_of(target_id);
                self.cached(
                    format!("device:{device}"),
                    db::grantees_of_device(&self.db, device),
                )
                .await?
            }
            _ => {
                self.cached(
                    format!("owner:{owner}"),
                    db::grantees_of_owner(&self.db, owner),
                )
                .await?
            }
        };
        let admins = self
            .cached("admins".into(), db::enabled_admin_ids(&self.db))
            .await?;
        let audience: BTreeSet<i32> = viewers
            .into_iter()
            .chain(admins)
            .filter(|u| *u != owner)
            .collect();
        if !audience.is_empty() {
            self.hub
                .emit_to_users(&audience.into_iter().collect::<Vec<_>>(), ev.clone());
        }
        Ok(())
    }
}

//! Household fan-out of `remote.state|stopped|targets_changed` (spec rules 31-34).
use super::db;
use crate::sync::MutexExt;
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
    // Never invalidated on grant changes; keys are one per device or owner seen.
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
            let c = self.cache.lock_clean();
            c.get(&key).filter(|(_, at)| at.elapsed() < CACHE).cloned()
        };
        if let Some((ids, _)) = hit {
            return Ok(ids);
        }
        let ids = fresh.await?;
        self.cache
            .lock_clean()
            .insert(key, (ids.clone(), Instant::now()));
        Ok(ids)
    }

    async fn run(&self, ev: &SseEvent, owner: i32) -> sqlx::Result<()> {
        let audience = self.audience(ev, owner).await?;
        if !audience.is_empty() {
            self.hub.emit_to_users(&audience, ev.clone());
        }
        Ok(())
    }

    async fn audience(&self, ev: &SseEvent, owner: i32) -> sqlx::Result<Vec<i32>> {
        let viewers = match ev {
            SseEvent::RemoteState { target_id, .. } | SseEvent::RemoteStopped { target_id } => {
                let device = device_id_of(target_id);
                self.cached(
                    format!("device:{owner}:{device}"),
                    db::grantees_of_device(&self.db, owner, device),
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
        Ok(audience.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn user(db: &PgPool, name: &str) -> i32 {
        sqlx::query_scalar(r#"INSERT INTO users (username) VALUES ($1) RETURNING id"#)
            .bind(name)
            .fetch_one(db)
            .await
            .unwrap()
    }

    async fn grant(db: &PgPool, owner: i32, grantee: i32) {
        sqlx::query(
            r#"INSERT INTO remote_control_grants ("deviceId", "ownerUserId", "granteeUserId", "deviceName", "codeExpiresAt")
               VALUES ('tv', $1, $2, 'TV', now())"#,
        )
        .bind(owner)
        .bind(grantee)
        .execute(db)
        .await
        .unwrap();
    }

    #[sqlx::test(migrations = false)]
    async fn state_frames_reach_only_grantees_of_the_devices_owner(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let (owner, guest, minter, claimant) = (
            user(&db, "owner").await,
            user(&db, "guest").await,
            user(&db, "minter").await,
            user(&db, "claimant").await,
        );
        grant(&db, owner, guest).await;
        // A code minted by another account for the owner's device id, then claimed.
        grant(&db, minter, claimant).await;
        let fan = FanOut {
            db,
            hub: Hub::new(),
            cache: Mutex::default(),
        };
        let ev = SseEvent::RemoteStopped {
            target_id: "tv#tab".into(),
        };
        assert_eq!(fan.audience(&ev, owner).await.unwrap(), vec![guest]);
    }
}

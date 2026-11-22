//! Household fan-out of `remote.state|ack|stopped|targets_changed` (spec rules 31-34).
use super::db;
use crate::sync::MutexExt;
use crate::{
    events::{Hub, SseEvent},
    state::AppState,
};
use sqlx::PgPool;
use std::{
    collections::{BTreeSet, HashMap, VecDeque, hash_map::Entry},
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const CACHE: Duration = Duration::from_secs(30);

type Cached = Mutex<HashMap<String, (Vec<i32>, Instant)>>;

struct FanOut {
    db: PgPool,
    hub: Hub,
    // An owner's keys go on its `remote.targets_changed`; one key per device or owner seen.
    cache: Cached,
    /// Events waiting per owner; an entry exists while a task drains it, so delivery stays ordered.
    lanes: Mutex<HashMap<i32, VecDeque<SseEvent>>>,
}

/// Grants are keyed by device id: every tab and reconnect of a device shares one permission.
pub fn device_id_of(target_id: &str) -> &str {
    target_id.split('#').next().unwrap_or_default()
}

pub fn init(st: &AppState) {
    FanOut::install(st.db.clone(), st.hub.clone());
}

impl FanOut {
    fn new(db: PgPool, hub: Hub) -> Self {
        Self {
            db,
            hub,
            cache: Mutex::default(),
            lanes: Mutex::default(),
        }
    }

    fn install(db: PgPool, hub: Hub) -> Arc<Self> {
        let fan = Arc::new(Self::new(db, hub.clone()));
        let hooked = fan.clone();
        hub.register_household_fan_out(move |ev, owner| hooked.submit(ev.clone(), owner));
        fan
    }

    fn submit(self: &Arc<Self>, ev: SseEvent, owner: i32) {
        match self.lanes.lock_clean().entry(owner) {
            Entry::Occupied(mut lane) => lane.get_mut().push_back(ev),
            Entry::Vacant(lane) => {
                lane.insert(VecDeque::from([ev]));
                tokio::spawn(self.clone().drain(owner));
            }
        }
    }

    async fn drain(self: Arc<Self>, owner: i32) {
        loop {
            let ev = {
                let mut lanes = self.lanes.lock_clean();
                let Some(ev) = lanes.get_mut(&owner).and_then(VecDeque::pop_front) else {
                    lanes.remove(&owner);
                    return;
                };
                ev
            };
            if let Err(e) = self.run(&ev, owner).await {
                tracing::warn!(error = %e, "household fan-out failed");
            }
        }
    }

    fn forget(&self, owner: i32) {
        let (own, devices) = (format!("owner:{owner}"), format!("device:{owner}:"));
        self.cache
            .lock_clean()
            .retain(|k, _| *k != own && !k.starts_with(&devices));
    }

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
        if matches!(ev, SseEvent::RemoteTargetsChanged {}) {
            self.forget(owner);
        }
        let audience = self.audience(ev, owner).await?;
        if !audience.is_empty() {
            self.hub.emit_to_users(&audience, ev.clone());
        }
        Ok(())
    }

    async fn audience(&self, ev: &SseEvent, owner: i32) -> sqlx::Result<Vec<i32>> {
        let viewers = match ev {
            SseEvent::RemoteState { target_id, .. }
            | SseEvent::RemoteAck { target_id, .. }
            | SseEvent::RemoteStopped { target_id, .. } => {
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
        let admins = db::enabled_admin_ids(&self.db).await?;
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

    async fn grant(db: &PgPool, owner: i32, grantee: i32, device: &str) {
        sqlx::query(
            r#"INSERT INTO remote_control_grants ("deviceId", "ownerUserId", "granteeUserId", "deviceName", "codeExpiresAt")
               VALUES ($1, $2, $3, 'TV', now())"#,
        )
        .bind(device)
        .bind(owner)
        .bind(grantee)
        .execute(db)
        .await
        .unwrap();
    }

    fn stopped(target_id: &str) -> SseEvent {
        SseEvent::RemoteStopped {
            target_id: target_id.into(),
            session_id: "s".into(),
        }
    }

    async fn settle(fan: &FanOut) {
        while !fan.lanes.lock_clean().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
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
        grant(&db, owner, guest, "tv").await;
        // A code minted by another account for the owner's device id, then claimed.
        grant(&db, minter, claimant, "tv").await;
        let fan = FanOut::new(db, Hub::new());
        assert_eq!(
            fan.audience(&stopped("tv#tab"), owner).await.unwrap(),
            vec![guest]
        );
    }

    #[sqlx::test(migrations = false)]
    async fn events_of_one_owner_are_delivered_in_the_order_they_were_sent(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let (owner, guest) = (user(&db, "owner").await, user(&db, "guest").await);
        grant(&db, owner, guest, "tv").await;
        grant(&db, owner, guest, "tv2").await;
        let hub = Hub::new();
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = seen.clone();
        hub.register_users_hook(move |ev, _| {
            if let SseEvent::RemoteStopped { target_id, .. } = ev {
                sink.lock_clean().push(target_id.clone());
            }
        });
        let fan = FanOut::install(db, hub);
        // A cache hit must not overtake the miss sent before it.
        fan.audience(&stopped("tv2#tab"), owner).await.unwrap();
        fan.submit(stopped("tv#tab"), owner);
        fan.submit(stopped("tv2#tab"), owner);
        settle(&fan).await;
        assert_eq!(*seen.lock_clean(), ["tv#tab", "tv2#tab"]);
        assert!(fan.lanes.lock_clean().is_empty());
    }

    #[sqlx::test(migrations = false)]
    async fn targets_changed_forgets_only_its_owners_audience(db: PgPool) {
        crate::db::migrate(&db).await.unwrap();
        let (owner, other, guest) = (
            user(&db, "owner").await,
            user(&db, "other").await,
            user(&db, "guest").await,
        );
        grant(&db, owner, guest, "tv").await;
        grant(&db, other, guest, "tv").await;
        let fan = FanOut::new(db, Hub::new());
        for o in [owner, other] {
            fan.audience(&stopped("tv#tab"), o).await.unwrap();
            fan.audience(&SseEvent::RemoteTargetsChanged {}, o)
                .await
                .unwrap();
        }
        fan.forget(owner);
        let mut keys: Vec<String> = fan.cache.lock_clean().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [format!("device:{other}:tv"), format!("owner:{other}")]
        );
    }
}

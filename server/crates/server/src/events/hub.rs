//! The SSE hub (`docs/spec/events-hub.md`): connection registry, audiences, replay cache, polled
//! targets and attribution. Every method locks briefly and never awaits; the household hook runs unlocked.
use super::{
    Bus, SseEvent,
    activity::Activity,
    event::{Download, RawEvent},
    replay::Replay,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc, watch};

/// A polled target is present only while it keeps polling.
const POLLED_TARGET_TTL: Duration = Duration::from_secs(30);
/// A remote launch is claimed here and taken by the playback that starts a moment later.
const ATTRIBUTION_TTL: Duration = Duration::from_secs(60);
/// Bounds a device that registers and never polls.
const POLLED_QUEUE_MAX: usize = 20;
const BUS_CAPACITY: usize = 4096;

/// What a connection (or polled target) knows about itself; absent query params stay `None`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Identity {
    /// `deviceId#tabNonce`; empty counts as absent.
    pub target_id: Option<String>,
    pub form_factor: Option<String>,
    pub tv_platform: Option<String>,
    pub device_name: Option<String>,
    pub user_agent: Option<String>,
}

impl Identity {
    fn target(&self) -> Option<&str> {
        self.target_id.as_deref().filter(|t| !t.is_empty())
    }
}

/// One row of the target registry; `connection_id` is `polled:<targetId>` for a polled target.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub connection_id: String,
    pub user_id: i32,
    pub identity: Identity,
    /// Epoch ms the target appeared.
    pub since: i64,
}

pub(super) enum Msg {
    Event(Arc<str>),
    Close,
}

struct Conn {
    user: i32,
    identity: Identity,
    since: i64,
    seq: u64,
    tx: mpsc::UnboundedSender<Msg>,
}

struct Polled {
    identity: Identity,
    since: i64,
    seq: u64,
    queue: Vec<SseEvent>,
    last_poll: Instant,
}

struct Claim {
    user: i32,
    media_file_id: i64,
    at: Instant,
}

#[derive(Default)]
struct Inner {
    conns: HashMap<String, Conn>,
    /// Keyed by owner and `polled:<targetId>` (F14): another account cannot take a device over.
    polled: HashMap<(i32, String), Polled>,
    claims: HashMap<String, Claim>,
    replay: Replay,
    seq: u64,
}

type FanOut = Arc<dyn Fn(&SseEvent, i32) + Send + Sync>;

pub struct Shared {
    inner: Mutex<Inner>,
    bus: broadcast::Sender<Arc<Bus>>,
    fan_out: Mutex<Option<FanOut>>,
    down: watch::Sender<bool>,
    pub(super) activity: Activity,
}

#[derive(Clone)]
pub struct Hub(pub(super) Arc<Shared>);

enum Aud<'a> {
    All,
    Users(&'a [i32]),
    Conn(&'a str),
}

struct Out {
    json: Arc<str>,
    bus: Bus,
}

impl Out {
    fn sse(ev: SseEvent) -> Self {
        Self {
            json: serde_json::to_string(&ev).expect("typed event").into(),
            bus: Bus::Sse(ev),
        }
    }
}

/// A live SSE stream: frames queue here until the response body drains them. Dropping it tears the
/// connection down (rule 15).
pub struct Connection {
    pub id: String,
    pub(super) rx: mpsc::UnboundedReceiver<Msg>,
    _teardown: Teardown,
}

struct Teardown(Hub, String);

impl Drop for Teardown {
    fn drop(&mut self) {
        self.0.teardown(&self.1);
    }
}

pub(crate) fn uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("os rng");
    b[6] = b[6] & 0x0f | 0x40;
    b[8] = b[8] & 0x3f | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        Self(Arc::new_cyclic(|w| Shared {
            inner: Mutex::default(),
            bus: broadcast::channel(BUS_CAPACITY).0,
            fan_out: Mutex::new(None),
            down: watch::channel(false).0,
            activity: Activity::new(w.clone()),
        }))
    }

    pub fn activity(&self) -> &Activity {
        &self.0.activity
    }

    /// Every event of both kinds, whatever its audience: the in-process subscribers' feed.
    /// At-most-once; a slow receiver lags and loses events.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Bus>> {
        self.0.bus.subscribe()
    }

    /// Closes every SSE stream and refuses new ones, so a graceful shutdown is not held open.
    pub fn shutdown(&self) {
        self.0.down.send_replace(true);
        for (_, c) in self.lock().conns.drain() {
            let _ = c.tx.send(Msg::Close);
        }
    }

    /// Set once by the remote module: widens `remote.state|targets_changed|stopped` sent through
    /// `emit_to_user` past their owner. It must use `emit_to_users`, which never calls it back.
    pub fn register_household_fan_out(&self, f: impl Fn(&SseEvent, i32) + Send + Sync + 'static) {
        *self.0.fan_out.lock().unwrap_or_else(|e| e.into_inner()) = Some(Arc::new(f));
    }

    /// To every connection of every user.
    pub fn emit(&self, ev: SseEvent) {
        self.send(Aud::All, Out::sse(ev));
    }

    pub fn emit_to_user(&self, user: i32, ev: SseEvent) {
        let widened = ev.is_household_scoped().then(|| ev.clone());
        self.send(Aud::Users(&[user]), Out::sse(ev));
        if let Some(ev) = widened {
            self.fan_out(&ev, user);
        }
    }

    /// An empty list delivers to nobody.
    pub fn emit_to_users(&self, users: &[i32], ev: SseEvent) {
        self.send(Aud::Users(users), Out::sse(ev));
    }

    /// A plugin event (`type` is the full `plugin.<id>.<type>`); `None` broadcasts.
    pub fn emit_raw(&self, r#type: &str, payload: serde_json::Value, users: Option<&[i32]>) {
        let raw = RawEvent {
            r#type: r#type.to_owned(),
            payload,
        };
        let out = Out {
            json: serde_json::to_string(&raw).expect("json value").into(),
            bus: Bus::Raw(raw),
        };
        self.send(users.map_or(Aud::All, Aud::Users), out);
    }

    /// In-process only (rules 37-39); never reaches a browser.
    pub fn emit_domain(&self, ev: super::DomainEvent) {
        let _ = self.0.bus.send(Arc::new(Bus::Domain(ev)));
    }

    /// To exactly one connection or polled target of `owner`; false when it is gone or its queue is
    /// full. A caller must not fall back to `emit_to_user` for `remote.command`.
    pub fn emit_to_connection(&self, owner: i32, connection_id: &str, ev: SseEvent) -> bool {
        let mut g = self.lock();
        if let Some(p) = g.polled.get_mut(&(owner, connection_id.to_owned())) {
            if p.queue.len() >= POLLED_QUEUE_MAX {
                tracing::warn!(
                    "Dropped {}: queue full for polled target {}",
                    name(&ev),
                    connection_id
                );
                return false;
            }
            p.queue.push(ev);
            return true;
        }
        if !g.conns.get(connection_id).is_some_and(|c| c.user == owner) {
            tracing::warn!(
                "Dropped {}: SSE connection {connection_id} is gone",
                name(&ev)
            );
            return false;
        }
        self.dispatch(&mut g, Aud::Conn(connection_id), Out::sse(ev));
        true
    }

    /// Registers the connection and queues `sse.connected` plus the user's progress replay (rule 9).
    pub fn connect(&self, user: i32, identity: Identity) -> Connection {
        let id = uuid_v4();
        let (tx, rx) = mpsc::unbounded_channel();
        let has_target = identity.target().is_some();
        {
            let mut g = self.lock();
            if let Some(target) = identity.target() {
                let stale: Vec<String> = g
                    .conns
                    .iter()
                    .filter(|(_, c)| c.user == user && c.identity.target() == Some(target))
                    .map(|(id, _)| id.clone())
                    .collect();
                for sid in stale {
                    if let Some(c) = g.conns.remove(&sid) {
                        let _ = c.tx.send(Msg::Close);
                    }
                    tracing::info!("Evicted superseded connection for target {target}");
                }
                // Before registering, so the new stream does not receive its own announce.
                self.dispatch(
                    &mut g,
                    Aud::Users(&[user]),
                    Out::sse(SseEvent::RemoteTargetsChanged {}),
                );
            }
            g.seq += 1;
            let seq = g.seq;
            let connected = Out::sse(SseEvent::SseConnected {
                connection_id: id.clone(),
            });
            let _ = tx.send(Msg::Event(connected.json));
            for ev in g.replay.snapshot_for(user, Instant::now()) {
                let _ = tx.send(Msg::Event(Out::sse(ev).json));
            }
            // A request accepted while shutting down would otherwise hold the graceful shutdown open.
            if *self.0.down.borrow() {
                let _ = tx.send(Msg::Close);
            } else {
                g.conns.insert(
                    id.clone(),
                    Conn {
                        user,
                        identity,
                        since: now_ms(),
                        seq,
                        tx,
                    },
                );
            }
        }
        if has_target {
            self.fan_out(&SseEvent::RemoteTargetsChanged {}, user);
        }
        Connection {
            _teardown: Teardown(self.clone(), id.clone()),
            id,
            rx,
        }
    }

    /// Every connection and polled target of the user, SSE and polled alike (account disabled or role
    /// changed). Each closed stream with a target announces itself like a normal teardown.
    pub fn drop_connections_for_user(&self, user: i32) {
        let mut announces = 0;
        let mut sse = 0;
        let polled;
        {
            let mut g = self.lock();
            let ids: Vec<String> = g
                .conns
                .iter()
                .filter(|(_, c)| c.user == user)
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                announces += self.close_locked(&mut g, &id) as usize;
                sse += 1;
            }
            let before = g.polled.len();
            g.polled.retain(|(owner, _), _| *owner != user);
            polled = before - g.polled.len();
            if polled > 0 {
                self.dispatch(
                    &mut g,
                    Aud::Users(&[user]),
                    Out::sse(SseEvent::RemoteTargetsChanged {}),
                );
                announces += 1;
            }
        }
        if sse > 0 || polled > 0 {
            tracing::info!(
                "Dropped {sse} SSE connection(s) and {polled} polled target(s) for user {user}"
            );
        }
        self.announce_n(user, announces);
    }

    /// Only the caller's own device (a plain logout); a miss is logged, not an error.
    pub fn drop_connections_for_target(&self, user: i32, target_id: &str) {
        let mut announces = 0;
        let (mut sse, mut polled) = (0, 0);
        {
            let mut g = self.lock();
            let ids: Vec<String> = g
                .conns
                .iter()
                .filter(|(_, c)| {
                    c.user == user && c.identity.target_id.as_deref() == Some(target_id)
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                announces += self.close_locked(&mut g, &id) as usize;
                sse += 1;
            }
            if g.polled
                .remove(&(user, format!("polled:{target_id}")))
                .is_some()
            {
                polled += 1;
                self.dispatch(
                    &mut g,
                    Aud::Users(&[user]),
                    Out::sse(SseEvent::RemoteTargetsChanged {}),
                );
                announces += 1;
            }
        }
        if sse + polled == 0 {
            tracing::warn!("Logout target scope: no connection for user {user} target {target_id}");
            return;
        }
        tracing::info!(
            "Dropped {} connection(s) for user {user} target {target_id}",
            sse + polled
        );
        self.announce_n(user, announces);
    }

    pub fn has_connection(&self, connection_id: &str) -> bool {
        self.lock().conns.contains_key(connection_id)
    }

    /// The target of an SSE connection or a polled key; `None` for an unknown or absent id.
    pub fn target_id_for(&self, connection_id: Option<&str>) -> Option<String> {
        let id = connection_id?;
        let g = self.lock();
        g.conns
            .get(id)
            .and_then(|c| c.identity.target_id.clone())
            .or_else(|| {
                g.polled
                    .iter()
                    .find(|((_, key), _)| key == id)
                    .and_then(|(_, p)| p.identity.target_id.clone())
            })
    }

    /// Targets owned by `user`, newest first.
    pub fn list_for_user(&self, user: i32) -> Vec<Target> {
        self.collect(Some(user), Instant::now())
    }

    /// Every target whichever account owns it (admin listing).
    pub fn list_all(&self) -> Vec<Target> {
        self.collect(None, Instant::now())
    }

    fn collect(&self, owner: Option<i32>, now: Instant) -> Vec<Target> {
        let mut expired = vec![];
        let mut rows = vec![];
        {
            let mut g = self.lock();
            let mut conns: Vec<_> = g
                .conns
                .iter()
                .filter(|(_, c)| owner.is_none_or(|u| c.user == u) && c.identity.target().is_some())
                .map(|(id, c)| (c.seq, id.clone(), c.user, c.identity.clone(), c.since))
                .collect();
            conns.sort_by_key(|r| r.0);
            rows.extend(
                conns
                    .into_iter()
                    .map(|(_, id, user_id, identity, since)| Target {
                        connection_id: id,
                        user_id,
                        identity,
                        since,
                    }),
            );
            let mut keys: Vec<_> = g.polled.iter().map(|(k, p)| (p.seq, k.clone())).collect();
            keys.sort();
            for (_, key) in keys {
                let p = &g.polled[&key];
                let user = key.0;
                if now.saturating_duration_since(p.last_poll) > POLLED_TARGET_TTL {
                    tracing::info!(
                        "Polled target {} stopped polling",
                        p.identity.target_id.as_deref().unwrap_or_default()
                    );
                    g.polled.remove(&key);
                    self.dispatch(
                        &mut g,
                        Aud::Users(&[user]),
                        Out::sse(SseEvent::RemoteTargetsChanged {}),
                    );
                    expired.push(user);
                    continue;
                }
                if owner.is_none_or(|u| user == u) && p.identity.target().is_some() {
                    rows.push(Target {
                        connection_id: key.1,
                        user_id: user,
                        identity: p.identity.clone(),
                        since: p.since,
                    });
                }
            }
        }
        for user in expired {
            self.fan_out(&SseEvent::RemoteTargetsChanged {}, user);
        }
        rows.sort_by_key(|t| std::cmp::Reverse(t.since));
        rows
    }

    /// The newest connection of `user` with this target; scoping to the user is the authorization.
    pub fn resolve_target(&self, user: i32, target_id: &str) -> Option<String> {
        let matches: Vec<_> = self
            .list_for_user(user)
            .into_iter()
            .filter(|t| t.identity.target_id.as_deref() == Some(target_id))
            .collect();
        if matches.len() > 1 {
            tracing::warn!(
                "Target {target_id} maps to {} live connections for user {user}: using the newest",
                matches.len()
            );
        }
        matches.into_iter().next().map(|t| t.connection_id)
    }

    /// For a client that cannot hold an SSE stream (the native TV app); the key doubles as its connection id.
    pub fn register_polled_target(&self, user: i32, identity: Identity) {
        let Some(target) = identity.target_id.clone().filter(|t| !t.is_empty()) else {
            tracing::warn!("Refused a polled-target registration with no target id (user {user})");
            return;
        };
        let key = (user, format!("polled:{target}"));
        let first = {
            let mut g = self.lock();
            let existing = g.polled.remove(&key);
            let first = existing.is_none();
            let (since, seq, queue) = match existing {
                Some(p) => (p.since, p.seq, p.queue),
                None => {
                    g.seq += 1;
                    (now_ms(), g.seq, vec![])
                }
            };
            g.polled.insert(
                key,
                Polled {
                    identity,
                    since,
                    seq,
                    queue,
                    last_poll: Instant::now(),
                },
            );
            first
        };
        if first {
            self.emit_to_user(user, SseEvent::RemoteTargetsChanged {});
        }
    }

    /// The pending commands, each at most once; `None` for an unknown target or another owner.
    pub fn drain_commands(&self, user: i32, target_id: &str) -> Option<Vec<SseEvent>> {
        let mut g = self.lock();
        let p = g.polled.get_mut(&(user, format!("polled:{target_id}")))?;
        p.last_poll = Instant::now();
        Some(std::mem::take(&mut p.queue))
    }

    /// `user` started this file on `target_id` from elsewhere; one claim per target.
    pub fn claim_attribution(&self, target_id: &str, user: i32, media_file_id: i64) {
        tracing::debug!("User {user} claims file {media_file_id} on {target_id}");
        self.lock().claims.insert(
            target_id.to_owned(),
            Claim {
                user,
                media_file_id,
                at: Instant::now(),
            },
        );
    }

    /// The claim is consumed by any read; it only counts when fresh and for the same file.
    pub fn take_attribution(&self, target_id: Option<&str>, media_file_id: i64) -> Option<i32> {
        self.take_attribution_at(target_id, media_file_id, Instant::now())
    }

    fn take_attribution_at(
        &self,
        target_id: Option<&str>,
        media_file_id: i64,
        now: Instant,
    ) -> Option<i32> {
        let claim = self.lock().claims.remove(target_id?)?;
        (now.saturating_duration_since(claim.at) <= ATTRIBUTION_TTL
            && claim.media_file_id == media_file_id)
            .then_some(claim.user)
    }

    /// The downloads last stated for a media (plugin host replay read); empty when none.
    pub fn progress_current(&self, media_id: i64) -> Vec<Download> {
        self.lock()
            .replay
            .current(media_id)
            .unwrap_or_default()
            .to_vec()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn send(&self, aud: Aud<'_>, out: Out) {
        let mut g = self.lock();
        self.dispatch(&mut g, aud, out);
    }

    /// The single funnel of every emit: records or clears the replay cache for user-scoped events
    /// (rule 23), delivers, then feeds the in-process bus.
    fn dispatch(&self, inner: &mut Inner, aud: Aud<'_>, out: Out) {
        if let (Aud::Users(users), Bus::Sse(ev)) = (&aud, &out.bus) {
            match ev {
                SseEvent::DownloadProgress {
                    media_id,
                    media_type,
                    downloads,
                } => inner
                    .replay
                    .record(users, *media_id, *media_type, downloads, Instant::now()),
                SseEvent::ImportComplete {
                    media_id,
                    season_number,
                    episode_number,
                    ..
                } => inner
                    .replay
                    .clear(*media_id, *season_number, *episode_number),
                _ => {}
            }
        }
        for (id, c) in &inner.conns {
            let to_it = match &aud {
                Aud::All => true,
                Aud::Users(users) => users.contains(&c.user),
                Aud::Conn(only) => only == id,
            };
            if to_it {
                let _ = c.tx.send(Msg::Event(out.json.clone()));
            }
        }
        let _ = self.0.bus.send(Arc::new(out.bus));
    }

    fn fan_out(&self, ev: &SseEvent, owner: i32) {
        let hook = self
            .0
            .fan_out
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(hook) = hook {
            hook(ev, owner);
        }
    }

    fn announce_n(&self, user: i32, n: usize) {
        for _ in 0..n {
            self.fan_out(&SseEvent::RemoteTargetsChanged {}, user);
        }
    }

    /// Removes the connection, ends its stream and announces it when it was a target; true if announced.
    fn close_locked(&self, inner: &mut Inner, id: &str) -> bool {
        let Some(c) = inner.conns.remove(id) else {
            return false;
        };
        let _ = c.tx.send(Msg::Close);
        let had_target = c.identity.target().is_some();
        if had_target {
            self.dispatch(
                inner,
                Aud::Users(&[c.user]),
                Out::sse(SseEvent::RemoteTargetsChanged {}),
            );
        }
        had_target
    }

    /// Runs when the client's stream ends. An evicted or dropped connection is already gone and says nothing.
    fn teardown(&self, id: &str) {
        let user = {
            let mut g = self.lock();
            let user = g.conns.get(id).map(|c| c.user);
            user.filter(|_| self.close_locked(&mut g, id))
        };
        if let Some(user) = user {
            self.fan_out(&SseEvent::RemoteTargetsChanged {}, user);
        }
    }
}

fn name(ev: &SseEvent) -> String {
    serde_json::to_value(ev)
        .ok()
        .and_then(|v| v["type"].as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::event::{DownloadState, MediaKind};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn at(device: &str) -> Identity {
        Identity {
            target_id: Some(device.into()),
            ..Identity::default()
        }
    }

    /// Queued messages as event types, `<close>` for the end marker.
    fn got(c: &mut Connection) -> Vec<String> {
        let mut out = vec![];
        while let Ok(m) = c.rx.try_recv() {
            out.push(match m {
                Msg::Close => "<close>".into(),
                Msg::Event(j) => serde_json::from_str::<serde_json::Value>(&j).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .into(),
            });
        }
        out
    }

    const CHANGED: &str = "remote.targets_changed";

    fn progress(media: i64, season: i64) -> SseEvent {
        SseEvent::DownloadProgress {
            media_id: media,
            media_type: MediaKind::Series,
            downloads: vec![Download {
                r#ref: "r".into(),
                season_number: Some(season),
                episode_number: None,
                progress: 0.5.into(),
                dlspeed: 1.into(),
                eta: 1.into(),
                state: DownloadState::Active,
            }],
        }
    }

    #[test]
    fn connect_sends_connected_then_replay_and_announces_to_the_others_only() {
        let hub = Hub::new();
        hub.emit_to_users(&[1], progress(7, 1));
        hub.emit(progress(8, 1));
        let mut other = hub.connect(1, Identity::default());
        let _ = got(&mut other);
        let mut c = hub.connect(1, at("d1#a"));
        assert_eq!(got(&mut c), ["sse.connected", "download.progress"]);
        assert_eq!(got(&mut other), [CHANGED]);
        hub.emit(SseEvent::QueueUpdated {});
        assert_eq!(got(&mut c), ["queue.updated"]);
    }

    #[test]
    fn audiences_filter_by_user_and_connection() {
        let hub = Hub::new();
        let (mut a, mut b) = (
            hub.connect(1, Identity::default()),
            hub.connect(2, Identity::default()),
        );
        let (ida, _) = (a.id.clone(), got(&mut a));
        let _ = got(&mut b);
        hub.emit_to_user(1, SseEvent::QueueUpdated {});
        hub.emit_to_users(&[], SseEvent::StalledRemoved { title: "t".into() });
        hub.emit_to_users(&[1, 2], SseEvent::CommandStarted { name: "n".into() });
        hub.emit_raw("plugin.x.y", serde_json::json!({"k": 1}), Some(&[2]));
        assert!(hub.emit_to_connection(1, &ida, SseEvent::ActivityChanged {}));
        assert!(!hub.emit_to_connection(2, &ida, SseEvent::ActivityChanged {}));
        assert!(!hub.emit_to_connection(1, "nope", SseEvent::ActivityChanged {}));
        hub.emit(SseEvent::SeerrImportStarted {});
        assert_eq!(
            got(&mut a),
            [
                "queue.updated",
                "command.started",
                "activity.changed",
                "seerr.import.started"
            ]
        );
        assert_eq!(
            got(&mut b),
            ["command.started", "plugin.x.y", "seerr.import.started"]
        );
    }

    #[tokio::test]
    async fn the_bus_sees_every_event_whatever_its_audience() {
        let hub = Hub::new();
        let mut rx = hub.subscribe();
        let c = hub.connect(1, Identity::default());
        hub.emit_to_users(&[], SseEvent::QueueUpdated {});
        hub.emit_to_connection(1, &c.id, SseEvent::ActivityChanged {});
        hub.emit_domain(super::super::DomainEvent::SettingsChanged { key: "k".into() });
        let kinds: Vec<_> = (0..3)
            .map(|_| match &*rx.try_recv().unwrap() {
                Bus::Sse(_) => "sse",
                Bus::Raw(_) => "raw",
                Bus::Domain(_) => "domain",
            })
            .collect();
        assert_eq!(kinds, ["sse", "sse", "domain"]);
    }

    #[test]
    fn a_superseded_connection_is_closed_and_leaves_the_registry_quietly() {
        let hub = Hub::new();
        let mut old = hub.connect(1, at("d#a"));
        let mut tab = hub.connect(1, at("d#b"));
        let mut other_user = hub.connect(2, at("d#a"));
        let _ = (got(&mut old), got(&mut tab), got(&mut other_user));
        let new = hub.connect(1, at("d#a"));
        assert_eq!(got(&mut old), ["<close>"]);
        assert_eq!(got(&mut tab), [CHANGED]);
        assert!(got(&mut other_user).is_empty());
        assert!(!hub.has_connection(&old.id) && hub.has_connection(&new.id));
        drop(old);
        assert!(got(&mut tab).is_empty());
        assert_eq!(hub.list_for_user(1).len(), 2);
        drop(new);
        assert_eq!(got(&mut tab), [CHANGED]);
    }

    #[test]
    fn an_empty_device_is_never_a_target() {
        let hub = Hub::new();
        let mut a = hub.connect(1, at(""));
        let mut b = hub.connect(1, at(""));
        assert!(got(&mut a).len() == 1 && got(&mut b).len() == 1);
        assert!(hub.list_all().is_empty());
        drop(b);
        assert!(got(&mut a).is_empty());
    }

    #[test]
    fn dropping_a_user_closes_their_streams_and_polled_targets_and_announces() {
        let hub = Hub::new();
        let (mut a, mut b) = (hub.connect(1, at("d1#a")), hub.connect(2, at("d2#a")));
        let mut plain = hub.connect(1, Identity::default());
        hub.register_polled_target(1, at("tv#native"));
        let _ = (got(&mut a), got(&mut b), got(&mut plain));
        hub.drop_connections_for_user(1);
        assert_eq!(got(&mut a), ["<close>"]);
        assert_eq!(got(&mut plain).last().map(String::as_str), Some("<close>"));
        assert_eq!(got(&mut b), [] as [&str; 0]);
        assert!(hub.list_for_user(1).is_empty() && hub.list_for_user(2).len() == 1);
        assert!(hub.drain_commands(1, "tv#native").is_none());
        drop(a);
        assert!(got(&mut plain).is_empty());
    }

    #[test]
    fn a_target_scoped_drop_leaves_the_users_other_devices() {
        let hub = Hub::new();
        let (mut a, mut b) = (hub.connect(1, at("d1#a")), hub.connect(1, at("d2#a")));
        let _ = (got(&mut a), got(&mut b));
        hub.drop_connections_for_target(1, "d2#a");
        hub.drop_connections_for_target(2, "d1#a");
        hub.drop_connections_for_target(1, "missing");
        assert_eq!(got(&mut b), ["<close>"]);
        assert_eq!(got(&mut a), [CHANGED]);
        assert!(hub.has_connection(&a.id) && !hub.has_connection(&b.id));
    }

    #[test]
    fn polled_targets_queue_drain_cap_and_expire() {
        let hub = Hub::new();
        let mut watcher = hub.connect(1, Identity::default());
        let _ = got(&mut watcher);
        hub.register_polled_target(1, at("tv#native"));
        hub.register_polled_target(1, at("tv#native"));
        hub.register_polled_target(1, Identity::default());
        assert_eq!(got(&mut watcher), [CHANGED]);
        let key = "polled:tv#native";
        assert_eq!(hub.resolve_target(1, "tv#native").as_deref(), Some(key));
        assert_eq!(hub.target_id_for(Some(key)).as_deref(), Some("tv#native"));
        assert!(!hub.has_connection(key));
        for _ in 0..POLLED_QUEUE_MAX {
            assert!(hub.emit_to_connection(1, key, SseEvent::QueueUpdated {}));
        }
        assert!(!hub.emit_to_connection(1, key, SseEvent::QueueUpdated {}));
        assert!(hub.drain_commands(2, "tv#native").is_none());
        assert_eq!(
            hub.drain_commands(1, "tv#native").unwrap().len(),
            POLLED_QUEUE_MAX
        );
        assert!(hub.drain_commands(1, "tv#native").unwrap().is_empty());
        let later = Instant::now() + POLLED_TARGET_TTL + Duration::from_secs(1);
        assert!(hub.collect(Some(1), later).is_empty());
        assert_eq!(got(&mut watcher), [CHANGED]);
        assert!(hub.drain_commands(1, "tv#native").is_none());
    }

    #[test]
    fn a_polled_device_is_per_account() {
        let hub = Hub::new();
        hub.register_polled_target(1, at("dev#native"));
        hub.register_polled_target(2, at("dev#native"));
        let key = hub.resolve_target(1, "dev#native").unwrap();
        assert!(hub.emit_to_connection(1, &key, SseEvent::QueueUpdated {}));
        assert!(hub.drain_commands(2, "dev#native").unwrap().is_empty());
        assert_eq!(hub.drain_commands(1, "dev#native").unwrap().len(), 1);
        hub.drop_connections_for_target(2, "dev#native");
        assert!(hub.list_for_user(2).is_empty() && hub.list_for_user(1).len() == 1);
    }

    #[test]
    fn targets_list_newest_first_and_resolve_to_the_newest() {
        let hub = Hub::new();
        let _a = hub.connect(1, at("d1#a"));
        std::thread::sleep(Duration::from_millis(2));
        let b = hub.connect(1, at("d2#a"));
        let _c = hub.connect(2, at("d3#a"));
        let ids: Vec<_> = hub
            .list_for_user(1)
            .iter()
            .map(|t| t.identity.target_id.clone().unwrap())
            .collect();
        assert_eq!(ids, ["d2#a", "d1#a"]);
        assert_eq!(hub.list_all().len(), 3);
        assert_eq!(hub.resolve_target(1, "d2#a"), Some(b.id.clone()));
        assert_eq!(hub.resolve_target(1, "d3#a"), None);
        assert_eq!(hub.target_id_for(Some(&b.id)).as_deref(), Some("d2#a"));
        assert_eq!(hub.target_id_for(None), None);
    }

    #[test]
    fn attribution_is_taken_once_for_the_same_file_within_a_minute() {
        let hub = Hub::new();
        hub.claim_attribution("t", 5, 10);
        assert_eq!(hub.take_attribution(Some("t"), 10), Some(5));
        assert_eq!(hub.take_attribution(Some("t"), 10), None);
        hub.claim_attribution("t", 5, 10);
        assert_eq!(hub.take_attribution(Some("t"), 11), None);
        assert_eq!(hub.take_attribution(Some("t"), 10), None);
        hub.claim_attribution("t", 5, 10);
        let late = Instant::now() + ATTRIBUTION_TTL + Duration::from_secs(1);
        assert_eq!(hub.take_attribution_at(Some("t"), 10, late), None);
        assert_eq!(hub.take_attribution(None, 10), None);
    }

    #[test]
    fn the_household_hook_runs_for_remote_events_of_emit_to_user_only() {
        let hub = Hub::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        hub.register_household_fan_out(move |_, owner| {
            assert_eq!(owner, 1);
            n.fetch_add(1, Ordering::SeqCst);
        });
        hub.emit_to_user(1, SseEvent::QueueUpdated {});
        hub.emit_to_users(&[1], SseEvent::RemoteTargetsChanged {});
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        hub.emit_to_user(
            1,
            SseEvent::RemoteStopped {
                target_id: "t".into(),
            },
        );
        let c = hub.connect(1, at("d#a"));
        drop(c);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn the_replay_cache_follows_audience_import_complete_and_the_empty_snapshot() {
        let hub = Hub::new();
        hub.emit_to_users(&[1], progress(7, 1));
        hub.emit_to_users(&[2], progress(8, 1));
        assert_eq!(hub.progress_current(7).len(), 1);
        let mut c = hub.connect(1, Identity::default());
        assert_eq!(got(&mut c), ["sse.connected", "download.progress"]);
        hub.emit_to_users(
            &[1],
            SseEvent::ImportComplete {
                media_id: 7,
                title: "t".into(),
                season_number: Some(1),
                episode_number: None,
            },
        );
        assert!(hub.progress_current(7).is_empty());
        hub.emit_to_users(
            &[2],
            SseEvent::DownloadProgress {
                media_id: 8,
                media_type: MediaKind::Movie,
                downloads: vec![],
            },
        );
        assert!(hub.progress_current(8).is_empty());
    }

    #[test]
    fn shutdown_closes_every_stream() {
        let hub = Hub::new();
        let mut c = hub.connect(1, Identity::default());
        let _ = got(&mut c);
        hub.shutdown();
        assert_eq!(got(&mut c), ["<close>"]);
        assert!(*hub.0.down.borrow());
        let mut late = hub.connect(1, Identity::default());
        assert_eq!(got(&mut late), ["sse.connected", "<close>"]);
    }

    #[test]
    fn connection_ids_are_v4_uuids() {
        let id = uuid_v4();
        let p: Vec<_> = id.split('-').map(str::len).collect();
        assert_eq!(p, [8, 4, 4, 4, 12]);
        assert!(id.as_bytes()[14] == b'4' && "89ab".contains(id.as_bytes()[19] as char));
    }
}

//! The account session (`docs/spec/session.md`): the one playback an account has at a time.
mod routes;
mod store;

pub use routes::*;

use crate::{
    events::{
        SseEvent,
        event::{Queue, Repeat},
    },
    presence::{now_ms, ttl_ms},
    state::AppState,
};
use chrono::{DateTime, Utc};
use fliks_domain::media::kind::MediaKind;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tokio::sync::Mutex;

/// The old owner saves its position before its engine session goes.
pub const SUPERSEDED_STOP_DELAY: Duration = Duration::from_secs(3);
pub const SWEEP_EVERY: Duration = Duration::from_secs(15);
const PARKED_TTL: chrono::Duration = chrono::Duration::hours(24);
const PERSIST_EVERY_MS: i64 = 30_000;
const SEEK_JUMP: f64 = 30.0;
/// Most items a queue carries (`remote.md` rule 35).
const QUEUE_MAX: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Playing,
    Paused,
    Buffering,
    Parked,
}

impl State {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Playing => "playing",
            Self::Paused => "paused",
            Self::Buffering => "buffering",
            Self::Parked => "parked",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        [Self::Playing, Self::Paused, Self::Buffering, Self::Parked]
            .into_iter()
            .find(|v| v.as_str() == s)
    }
}

/// The queue of an audio playback as stored and served.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    pub item_ids: Vec<i64>,
    pub index: i64,
    #[serde(default)]
    pub shuffle: bool,
    #[serde(default = "off")]
    pub repeat: Repeat,
}

fn off() -> Repeat {
    Repeat::Off
}

impl QueueState {
    /// A beat's `queue`: anything malformed or oversized counts as absent (`heartbeat.md` rule 25).
    pub fn from_beat(v: &serde_json::Value) -> Option<Self> {
        let q: Self = serde_json::from_value(v.clone()).ok()?;
        let in_range = q.index >= 0 && (q.item_ids.is_empty() || q.index < q.item_ids.len() as i64);
        (q.item_ids.len() <= QUEUE_MAX && in_range).then_some(q)
    }
}

impl From<&Queue> for QueueState {
    fn from(q: &Queue) -> Self {
        Self {
            item_ids: q.item_ids.clone(),
            index: q.index,
            shuffle: false,
            repeat: Repeat::Off,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Owner {
    pub target_id: Option<String>,
    pub device_name: Option<String>,
    pub form_factor: Option<String>,
}

/// One `account_sessions` row.
#[derive(Debug, Clone)]
pub struct Row {
    pub user_id: i32,
    pub session_id: String,
    pub epoch: i64,
    pub item_id: i32,
    pub media_file_id: Option<i32>,
    pub kind: MediaKind,
    pub state: State,
    pub position: f64,
    pub duration: Option<f64>,
    pub owner: Owner,
    pub queue: Option<QueueState>,
    pub updated_at: DateTime<Utc>,
}

/// Who to tell, and where, when another device takes the session over.
struct Held {
    hub_user: i32,
    connection: Option<String>,
}

struct Entry {
    row: Row,
    held: Option<Held>,
    persisted_at: i64,
    persisted_pos: f64,
}

/// A sid that claimed: its target, and when its engine session ended (ms).
struct Claim {
    target: Option<String>,
    ended_at: Option<i64>,
}

#[derive(Default)]
struct Inner {
    rows: HashMap<i32, Entry>,
    /// Every sid that claimed: a sid claims once (rule 4), and an ended one stays until the engine
    /// can no longer revive it.
    claimed: HashMap<String, Claim>,
    /// Sids found out of scope at their first beat, so later beats skip the preference read.
    unscoped: HashSet<String>,
}

impl Inner {
    /// What a beat of an already claimed `sid` is for `account` (rule 8).
    fn claimed_verdict(&self, account: i32, sid: &str) -> Option<Verdict> {
        let claim = self.claimed.get(sid)?;
        Some(
            match self.rows.get(&account).map(|e| &e.row.owner.target_id) {
                Some(owner) if owner != &claim.target => Verdict::Superseded,
                _ => Verdict::Ignored,
            },
        )
    }
}

/// What a beat changes for its sender (`session.md` rule 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Current,
    Superseded,
    Ignored,
}

/// The facts of a first or later beat of an engine session.
pub struct BeatIn {
    /// The credited account.
    pub account: i32,
    /// The login user of the device, whose connection is told when it is superseded.
    pub hub_user: i32,
    pub sid: String,
    pub connection: Option<String>,
    pub owner: Owner,
    pub kind: MediaKind,
    pub item: i32,
    pub file: Option<i32>,
    pub state: State,
    pub position: f64,
    pub duration: Option<f64>,
    pub queue: Option<QueueState>,
}

/// Cheap to clone, every clone shares the one lock.
#[derive(Clone, Default)]
pub struct AccountSessions(Arc<Mutex<Inner>>);

fn announce(st: &AppState, user: i32, row: Option<&Row>) {
    st.hub.emit_to_user(
        user,
        SseEvent::SessionChanged {
            epoch: row.map(|r| r.epoch),
            item_id: row.map(|r| i64::from(r.item_id)),
            state: row.map(|r| r.state.as_str().to_owned()),
            owner_target_id: row.and_then(|r| r.owner.target_id.clone()),
        },
    );
}

async fn persist(st: &AppState, e: &mut Entry) {
    if let Err(err) = store::upsert(&st.db, &e.row).await {
        tracing::warn!(user = e.row.user_id, "account session not stored: {err}");
    }
    e.persisted_at = now_ms() as i64;
    e.persisted_pos = e.row.position;
}

fn park(e: &mut Entry) {
    e.row.state = State::Parked;
    e.row.updated_at = Utc::now();
    e.held = None;
}

/// Ends the presence and the engine session of `sid`, announcing nothing: its owner already knows.
async fn stop_session(st: &AppState, sid: &str) {
    if let Some(stopped) = st.presence.stop(sid) {
        st.qoe.end_session(&stopped.session_id).await;
    }
    if st.engine.runtime()
        && let Err(e) = st.engine.delete_session(sid, None).await
    {
        tracing::warn!("engine session {sid} not deleted: {e}");
    }
    st.account_sessions.ended(st, sid).await;
}

impl AccountSessions {
    /// Boot: no owner is known any more, so every live row is parked; old parked rows go.
    pub async fn load(&self, st: &AppState) -> Result<(), sqlx::Error> {
        store::park_all(&st.db).await?;
        store::delete_expired(&st.db, Utc::now() - PARKED_TTL).await?;
        let mut g = self.0.lock().await;
        g.rows = store::all(&st.db)
            .await?
            .into_iter()
            .map(|row| {
                let pos = row.position;
                let entry = Entry {
                    row,
                    held: None,
                    persisted_at: now_ms() as i64,
                    persisted_pos: pos,
                };
                (entry.row.user_id, entry)
            })
            .collect();
        Ok(())
    }

    /// Claims, updates or supersedes (`session.md` rules 4-10). A database failure never fails the beat.
    pub async fn beat(&self, st: &AppState, b: BeatIn) -> Verdict {
        let mut g = self.0.lock().await;
        let current = g
            .rows
            .get(&b.account)
            .is_some_and(|e| e.row.session_id == b.sid);
        if current {
            return Self::update(st, &mut g, b).await;
        }
        if let Some(v) = g.claimed_verdict(b.account, &b.sid) {
            return v;
        }
        if b.owner.target_id.is_none() || g.unscoped.contains(&b.sid) {
            return Verdict::Ignored;
        }
        if !store::in_scope(&st.db, b.account, b.kind).await {
            g.unscoped.insert(b.sid);
            return Verdict::Ignored;
        }
        Self::claim(st, &mut g, b).await;
        Verdict::Current
    }

    /// Whether a beat of `sid` is superseded, whatever else is known of its sender.
    pub async fn is_superseded(&self, account: i32, sid: &str) -> bool {
        let g = self.0.lock().await;
        let current = g
            .rows
            .get(&account)
            .is_some_and(|e| e.row.session_id == sid);
        !current && g.claimed_verdict(account, sid) == Some(Verdict::Superseded)
    }

    async fn update(st: &AppState, g: &mut Inner, b: BeatIn) -> Verdict {
        let Some(e) = g.rows.get_mut(&b.account) else {
            return Verdict::Ignored;
        };
        let was = (
            e.row.item_id,
            e.row.media_file_id,
            e.row.kind,
            e.row.state,
            e.row.queue.clone(),
            e.row.owner.target_id.clone(),
        );
        let r = &mut e.row;
        (r.item_id, r.media_file_id, r.kind, r.state) = (b.item, b.file, b.kind, b.state);
        (r.position, r.duration, r.updated_at) = (b.position, b.duration, Utc::now());
        if b.queue.is_some() {
            r.queue = b.queue;
        }
        r.owner = b.owner;
        e.held = Some(Held {
            hub_user: b.hub_user,
            connection: b.connection,
        });
        let r = &e.row;
        let now = (
            r.item_id,
            r.media_file_id,
            r.kind,
            r.state,
            r.queue.clone(),
            r.owner.target_id.clone(),
        );
        let changed = was != now;
        let due = now_ms() as i64 - e.persisted_at >= PERSIST_EVERY_MS;
        if changed || due || (e.row.position - e.persisted_pos).abs() > SEEK_JUMP {
            persist(st, e).await;
        }
        if changed {
            announce(st, b.account, Some(&e.row));
        }
        Verdict::Current
    }

    async fn claim(st: &AppState, g: &mut Inner, b: BeatIn) {
        let claim = Claim {
            target: b.owner.target_id.clone(),
            ended_at: None,
        };
        g.claimed.insert(b.sid.clone(), claim);
        let prior = g.rows.remove(&b.account);
        let same_owner = prior
            .as_ref()
            .is_some_and(|p| p.row.owner.target_id == b.owner.target_id);
        let epoch = match &prior {
            Some(p) if same_owner => p.row.epoch,
            Some(p) => p.row.epoch + 1,
            None => 1,
        };
        if let Some(p) = prior.as_ref().filter(|_| !same_owner) {
            Self::supersede(st, p, &b, epoch);
        }
        let mut entry = Entry {
            row: Row {
                user_id: b.account,
                session_id: b.sid,
                epoch,
                item_id: b.item,
                media_file_id: b.file,
                kind: b.kind,
                state: b.state,
                position: b.position,
                duration: b.duration,
                owner: b.owner,
                queue: b
                    .queue
                    .or(prior.and_then(|p| p.row.queue).filter(|_| same_owner)),
                updated_at: Utc::now(),
            },
            held: Some(Held {
                hub_user: b.hub_user,
                connection: b.connection,
            }),
            persisted_at: 0,
            persisted_pos: 0.0,
        };
        persist(st, &mut entry).await;
        announce(st, b.account, Some(&entry.row));
        let target = entry.row.owner.target_id.clone();
        g.rows.insert(b.account, entry);
        for (user, other) in g.rows.iter_mut() {
            if *user != b.account
                && other.row.state != State::Parked
                && other.row.owner.target_id == target
            {
                park(other);
                persist(st, other).await;
                announce(st, *user, Some(&other.row));
            }
        }
    }

    /// Tells a live previous owner and stops its engine session once it had time to save.
    fn supersede(st: &AppState, prior: &Entry, by: &BeatIn, epoch: i64) {
        if prior.row.state == State::Parked {
            return;
        }
        if let Some(h) = &prior.held
            && let Some(conn) = &h.connection
        {
            st.hub.emit_to_connection(
                h.hub_user,
                conn,
                SseEvent::SessionSuperseded {
                    session_id: prior.row.session_id.clone(),
                    by_device_name: by.owner.device_name.clone(),
                    epoch,
                },
            );
        }
        let (st, sid) = (st.clone(), prior.row.session_id.clone());
        tokio::spawn(async move {
            tokio::time::sleep(SUPERSEDED_STOP_DELAY).await;
            stop_session(&st, &sid).await;
        });
    }

    /// The history write completed the item of `sid`: the row goes (rule 11).
    pub async fn complete(&self, st: &AppState, account: i32, sid: &str) {
        let mut g = self.0.lock().await;
        if g.rows
            .get(&account)
            .is_some_and(|e| e.row.session_id == sid)
        {
            g.rows.remove(&account);
            if let Err(e) = store::delete(&st.db, account).await {
                tracing::warn!(account, "account session not deleted: {e}");
            }
            announce(st, account, None);
        }
    }

    /// The engine session `sid` ended: its row is parked and the claim kept for the revive window (rule 14b).
    pub async fn ended(&self, st: &AppState, sid: &str) {
        let mut g = self.0.lock().await;
        g.unscoped.remove(sid);
        if let Some(c) = g.claimed.get_mut(sid) {
            c.ended_at = Some(now_ms() as i64);
        }
        let Some(e) = g
            .rows
            .values_mut()
            .find(|e| e.row.session_id == sid && e.row.state != State::Parked)
        else {
            return;
        };
        park(e);
        persist(st, e).await;
        announce(st, e.row.user_id, Some(&e.row));
    }

    /// Parks every live row whose owner stopped beating, drops the parked rows past their day (rule 14a, 12).
    pub async fn sweep(&self, st: &AppState) {
        let mut g = self.0.lock().await;
        Self::park_silent(st, &mut g, None).await;
        let revive =
            i64::from(crate::engine::lifetime(|k| std::env::var(k).ok()).session_revive_ttl_ms);
        let now = now_ms() as i64;
        g.claimed.retain(|sid, c| {
            c.ended_at.is_none_or(|t| now - t < revive) || st.presence.peek(sid).is_some()
        });
        let cutoff = Utc::now() - PARKED_TTL;
        let old: Vec<i32> = g
            .rows
            .iter()
            .filter(|(_, e)| e.row.state == State::Parked && e.row.updated_at < cutoff)
            .map(|(u, _)| *u)
            .collect();
        for user in old {
            g.rows.remove(&user);
            if let Err(e) = store::delete(&st.db, user).await {
                tracing::warn!(user, "account session not deleted: {e}");
            }
            announce(st, user, None);
        }
    }

    async fn park_silent(st: &AppState, g: &mut Inner, only: Option<i32>) {
        let (now, ttl) = (now_ms(), ttl_ms());
        for (user, e) in g.rows.iter_mut() {
            let live = e.row.state != State::Parked && only.is_none_or(|u| u == *user);
            let silent = st
                .presence
                .peek(&e.row.session_id)
                .is_none_or(|p| now - p.last_beat > ttl);
            if live && silent {
                park(e);
                persist(st, e).await;
                announce(st, *user, Some(&e.row));
            }
        }
    }

    /// The row of `user` after the staleness check; `None` when there is none.
    pub async fn get(&self, st: &AppState, user: i32) -> Option<Row> {
        let mut g = self.0.lock().await;
        Self::park_silent(st, &mut g, Some(user)).await;
        g.rows.get(&user).map(|e| e.row.clone())
    }

    /// A row whose item is gone (the database cascaded it) is dropped from memory too.
    async fn forget(&self, user: i32) {
        self.0.lock().await.rows.remove(&user);
    }

    pub async fn dismiss(&self, st: &AppState, user: i32) -> Result<(), crate::http::AppError> {
        let mut g = self.0.lock().await;
        match g.rows.get(&user).map(|e| e.row.state) {
            None => Ok(()),
            Some(State::Parked) => {
                g.rows.remove(&user);
                store::delete(&st.db, user).await?;
                announce(st, user, None);
                Ok(())
            }
            Some(_) => Err(crate::http::AppError::conflict("session.error_not_parked")),
        }
    }
}

/// Boots the store and the sweep (`session.md` Jobs/timers).
pub async fn spawn(st: &AppState) {
    if let Err(e) = st.account_sessions.load(st).await {
        tracing::warn!("account sessions not loaded: {e}");
    }
    let st = st.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(SWEEP_EVERY);
        loop {
            tick.tick().await;
            st.account_sessions.sweep(&st).await;
        }
    });
}

#[cfg(test)]
mod tests;

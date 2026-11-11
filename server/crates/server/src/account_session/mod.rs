//! The account session (`docs/spec/session.md`): the one playback an account has at a time.
mod routes;
mod store;

pub use routes::*;
pub use store::kind_of;

use crate::{
    events::{
        SseEvent,
        event::{Queue, Repeat},
    },
    presence::{now_ms, ttl_ms},
    remote::device_id_of,
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

/// How long the old owner's engine session outlives its supersede, so its beats are still answered.
pub const SUPERSEDED_STOP_DELAY: Duration = Duration::from_secs(3);
pub const SWEEP_EVERY: Duration = Duration::from_secs(15);
const PARKED_TTL: chrono::Duration = chrono::Duration::hours(24);
const PERSIST_EVERY_MS: i64 = 30_000;
const SEEK_JUMP: f64 = 30.0;
/// Most items a queue carries (`remote.md` rule 35).
const QUEUE_MAX: usize = 500;
/// How long a transfer waits for the target's first beat to claim; past it the claim is a plain takeover.
const HANDOFF_TTL_MS: i64 = 60_000;

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

/// Two targets of one device.
fn same_device(a: &Option<String>, b: &Option<String>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => device_id_of(a) == device_id_of(b),
        _ => a == b,
    }
}

/// Whether a claim of `target` continues the owner of `row`: the same target, or another target of
/// its device once its beats stopped (a reload with a new tab nonce); a tab still beating is another owner.
/// A device's `#native` face and its web layer are one owner.
fn continues(st: &AppState, row: &Row, target: &Option<String>) -> bool {
    let owner = &row.owner.target_id;
    if owner == target {
        return true;
    }
    let native = [owner, target]
        .iter()
        .any(|t| t.as_deref().is_some_and(|t| t.ends_with("#native")));
    same_device(owner, target)
        && (native
            || row.state == State::Parked
            || st
                .presence
                .peek(&row.session_id)
                .is_none_or(|p| now_ms() - p.last_beat > ttl_ms()))
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
    /// For a reader's row: the sid and target of the playback row it replaced.
    replaced: Option<(String, Option<String>)>,
    /// The history completed its item: the row lives on in memory while it plays, never stored again.
    done: bool,
}

/// A sid that claimed: the account and target it claimed for, when its engine session ended (ms), and whether it was superseded.
struct Claim {
    account: i32,
    target: Option<String>,
    ended_at: Option<i64>,
    /// Another owner took the row over from this sid, whichever device it was on.
    superseded: bool,
}

#[derive(Default)]
struct Inner {
    rows: HashMap<i32, Entry>,
    /// Every sid that claimed: a sid claims once (rule 4), and an ended one stays until the engine
    /// can no longer revive it.
    claimed: HashMap<String, Claim>,
    /// Sids found out of scope at their first beat, so later beats skip the preference read.
    unscoped: HashSet<String>,
    /// Transfers sent but not yet claimed: (account, target) to the item and when the record lapses (ms).
    handoffs: HashMap<(i32, String), (i32, i64)>,
}

impl Inner {
    /// Consumes the transfer record of a claiming target: true only for its item and inside the TTL.
    fn take_handoff(&mut self, account: i32, target: Option<&str>, item: i32, now: i64) -> bool {
        let rec = target.and_then(|t| self.handoffs.remove(&(account, t.to_owned())));
        rec.is_some_and(|(i, until)| i == item && until > now)
    }

    /// What a beat of an already claimed `sid` is (rule 8), judged on the account it claimed for.
    /// `None` when it is free to claim again: never claimed, or a reader's row replaced its own.
    fn claimed_verdict(&self, sid: &str) -> Option<Verdict> {
        let claim = self.claimed.get(sid)?;
        if claim.superseded {
            return Some(Verdict::Superseded);
        }
        let entry = self.rows.get(&claim.account);
        let owner = match entry {
            Some(e) if e.row.session_id.starts_with(READER_PREFIX) => match &e.replaced {
                Some((rsid, target)) if rsid != sid && !same_device(target, &claim.target) => {
                    target
                }
                _ => return None,
            },
            Some(e) => &e.row.owner.target_id,
            None => return Some(Verdict::Ignored),
        };
        Some(if same_device(owner, &claim.target) {
            Verdict::Ignored
        } else {
            Verdict::Superseded
        })
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
    /// The sender started this session on purpose to take it over: the previous owner stops silently.
    pub handoff: bool,
}

/// A reader's saved position (`session.md` rule 19): the item and how far through it the account is.
pub struct ReadingIn {
    pub account: i32,
    pub owner: Owner,
    pub kind: MediaKind,
    pub item: i32,
    pub file: i32,
    /// 0..1 over the whole item.
    pub progression: f64,
}

const READER_PREFIX: &str = "reader:";

/// The sid of the parked row a reader leaves for `item`; nothing ever beats under it.
fn reader_sid(item: i32) -> String {
    format!("{READER_PREFIX}{item}")
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
    if e.done {
        return;
    }
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

/// Parks the live row of `user`; a completed one has nothing left to resume and goes instead.
async fn park_or_drop(st: &AppState, g: &mut Inner, user: i32) {
    if g.rows.get(&user).is_some_and(|e| e.done) {
        g.rows.remove(&user);
        announce(st, user, None);
    } else if let Some(e) = g.rows.get_mut(&user) {
        park(e);
        persist(st, e).await;
        announce(st, user, Some(&e.row));
    }
}

/// Ends the presence and the engine session of `sid`; its owner already knows, the household is told.
async fn stop_session(st: &AppState, sid: &str) {
    if let Some(stopped) = st.presence.stop(sid) {
        crate::presence::announce_stopped(st, &stopped);
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
        let rows = store::all(&st.db).await?;
        let mut g = self.0.lock().await;
        let now = now_ms() as i64;
        for row in &rows {
            let claim = Claim {
                account: row.user_id,
                target: row.owner.target_id.clone(),
                ended_at: Some(now),
                superseded: false,
            };
            g.claimed.insert(row.session_id.clone(), claim);
        }
        g.rows = rows
            .into_iter()
            .map(|row| {
                let pos = row.position;
                let entry = Entry {
                    row,
                    held: None,
                    persisted_at: now,
                    persisted_pos: pos,
                    replaced: None,
                    done: false,
                };
                (entry.row.user_id, entry)
            })
            .collect();
        Ok(())
    }

    /// Claims, updates or supersedes (`session.md` rules 4-10). A database failure never fails the beat.
    pub async fn beat(&self, st: &AppState, b: BeatIn) -> Verdict {
        let mut scope = None;
        loop {
            let mut g = self.0.lock().await;
            if g.rows
                .get(&b.account)
                .is_some_and(|e| e.row.session_id == b.sid)
            {
                return Self::update(st, &mut g, b).await;
            }
            if let Some(v) = g.claimed_verdict(&b.sid) {
                return v;
            }
            if b.owner.target_id.is_none() || g.unscoped.contains(&b.sid) {
                return Verdict::Ignored;
            }
            let Some(scope) = scope.take() else {
                // The preference read stays out of the lock; the decision is taken again after it.
                drop(g);
                scope = Some(store::in_scope(&st.db, b.account, b.kind).await);
                continue;
            };
            match scope {
                Ok(true) => {}
                Ok(false) => {
                    g.unscoped.insert(b.sid);
                    return Verdict::Ignored;
                }
                Err(e) => {
                    tracing::warn!(account = b.account, "account session scope not read: {e}");
                    return Verdict::Ignored;
                }
            }
            Self::claim(st, &mut g, b).await;
            return Verdict::Current;
        }
    }

    /// A transfer of the account's session to `target` was sent: its first beat of `item` claims silently.
    pub async fn expect_handoff(&self, st: &AppState, account: i32, target: &str, item: i32) {
        let mut g = self.0.lock().await;
        let now = now_ms() as i64;
        Self::announce_lapsed_handoffs(st, &mut g, now);
        g.handoffs
            .insert((account, target.to_owned()), (item, now + HANDOFF_TTL_MS));
    }

    /// Runs `f` on the row of `user` while it is still `sid` playing `item`, under the lock the claims
    /// take: whatever `f` emits is ordered with their `session.changed`.
    pub async fn while_current(&self, user: i32, sid: &str, item: i32, f: impl FnOnce(&Row)) {
        let g = self.0.lock().await;
        if let Some(e) = g.rows.get(&user).filter(|e| {
            e.row.session_id == sid && e.row.item_id == item && e.row.state != State::Parked
        }) {
            f(&e.row);
        }
    }

    /// Whether a beat of `sid` is superseded, whatever else is known of its sender.
    pub async fn is_superseded(&self, sid: &str) -> bool {
        self.0.lock().await.claimed_verdict(sid) == Some(Verdict::Superseded)
    }

    /// The item of the row of the account `sid` claimed for, to tell a superseded beat of another
    /// item from one of the row's.
    pub async fn item_of(&self, sid: &str) -> Option<i32> {
        let g = self.0.lock().await;
        let account = g.claimed.get(sid)?.account;
        g.rows.get(&account).map(|e| e.row.item_id)
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
        if b.owner.target_id.is_some() {
            r.owner = b.owner;
        }
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
            account: b.account,
            target: b.owner.target_id.clone(),
            ended_at: None,
            superseded: false,
        };
        g.claimed.insert(b.sid.clone(), claim);
        let prior = g.rows.remove(&b.account);
        let same_owner = prior
            .as_ref()
            .is_some_and(|p| continues(st, &p.row, &b.owner.target_id));
        let epoch = match &prior {
            Some(p) if same_owner => p.row.epoch,
            Some(p) => p.row.epoch + 1,
            None => 1,
        };
        let expected = g.take_handoff(
            b.account,
            b.owner.target_id.as_deref(),
            b.item,
            now_ms() as i64,
        );
        if let Some(p) = prior.as_ref().filter(|_| !same_owner) {
            if let Some(c) = g.claimed.get_mut(&p.row.session_id) {
                c.superseded = true;
            }
            Self::supersede(st, p, &b, epoch, b.handoff || expected);
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
                queue: b.queue.or(prior
                    .and_then(|p| p.row.queue)
                    .filter(|q| same_owner && q.item_ids.contains(&i64::from(b.item)))),
                updated_at: Utc::now(),
            },
            held: Some(Held {
                hub_user: b.hub_user,
                connection: b.connection,
            }),
            persisted_at: 0,
            persisted_pos: 0.0,
            replaced: None,
            done: false,
        };
        persist(st, &mut entry).await;
        announce(st, b.account, Some(&entry.row));
        let target = entry.row.owner.target_id.clone();
        g.rows.insert(b.account, entry);
        let taken: Vec<i32> = g
            .rows
            .iter()
            .filter(|(user, other)| {
                **user != b.account
                    && other.row.state != State::Parked
                    && same_device(&other.row.owner.target_id, &target)
            })
            .map(|(user, _)| *user)
            .collect();
        for user in taken {
            park_or_drop(st, g, user).await;
        }
    }

    /// Tells a live previous owner and stops its engine session once it had time to save.
    fn supersede(st: &AppState, prior: &Entry, by: &BeatIn, epoch: i64, silent: bool) {
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
                    silent,
                },
            );
        }
        let (st, sid) = (st.clone(), prior.row.session_id.clone());
        tokio::spawn(async move {
            tokio::time::sleep(SUPERSEDED_STOP_DELAY).await;
            stop_session(&st, &sid).await;
        });
    }

    /// A reader saved its position: the account's row becomes a parked row of that item. Never a
    /// claim, an epoch bump or a supersede: a live playback keeps the row (rule 19).
    pub async fn reading(&self, st: &AppState, r: ReadingIn) {
        match store::in_scope(&st.db, r.account, r.kind).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(e) => {
                tracing::warn!(account = r.account, "account session scope not read: {e}");
                return;
            }
        }
        let mut g = self.0.lock().await;
        let sid = reader_sid(r.item);
        match g.rows.get_mut(&r.account) {
            Some(e) if e.row.state != State::Parked => return,
            Some(e) if e.row.session_id == sid && e.row.owner == r.owner => {
                let moved = e.row.media_file_id != Some(r.file);
                (e.row.position, e.row.media_file_id) = (r.progression, Some(r.file));
                e.row.updated_at = Utc::now();
                if moved || now_ms() as i64 - e.persisted_at >= PERSIST_EVERY_MS {
                    persist(st, e).await;
                }
                return;
            }
            _ => {}
        }
        let epoch = g.rows.get(&r.account).map_or(1, |e| e.row.epoch);
        let replaced = g.rows.get(&r.account).and_then(|e| {
            if e.row.session_id.starts_with(READER_PREFIX) {
                e.replaced.clone()
            } else {
                Some((e.row.session_id.clone(), e.row.owner.target_id.clone()))
            }
        });
        let mut entry = Entry {
            row: Row {
                user_id: r.account,
                session_id: sid,
                epoch,
                item_id: r.item,
                media_file_id: Some(r.file),
                kind: r.kind,
                state: State::Parked,
                position: r.progression,
                duration: Some(1.0),
                owner: r.owner,
                queue: None,
                updated_at: Utc::now(),
            },
            held: None,
            persisted_at: 0,
            persisted_pos: 0.0,
            replaced,
            done: false,
        };
        persist(st, &mut entry).await;
        announce(st, r.account, Some(&entry.row));
        g.rows.insert(r.account, entry);
    }

    /// A reader finished `item`: its row goes like a video's (rule 11).
    pub async fn complete_reading(&self, st: &AppState, account: i32, item: i32) {
        self.complete(st, account, &reader_sid(item)).await;
    }

    /// The history write completed the item of `sid`: the stored row goes at once, the live one
    /// when it stops playing (rule 11).
    pub async fn complete(&self, st: &AppState, account: i32, sid: &str) {
        let mut g = self.0.lock().await;
        let Some(e) = g
            .rows
            .get(&account)
            .filter(|e| e.row.session_id == sid && !e.done)
        else {
            return;
        };
        let parked = e.row.state == State::Parked;
        if let Err(e) = store::delete(&st.db, account).await {
            tracing::warn!(account, "account session not deleted: {e}");
            return;
        }
        if parked {
            g.rows.remove(&account);
            announce(st, account, None);
        } else if let Some(e) = g.rows.get_mut(&account) {
            e.done = true;
        }
    }

    /// The engine session `sid` ended: its row is parked and the claim kept for the revive window (rule 14b).
    pub async fn ended(&self, st: &AppState, sid: &str) {
        let mut g = self.0.lock().await;
        g.unscoped.remove(sid);
        if let Some(c) = g.claimed.get_mut(sid) {
            c.ended_at = Some(now_ms() as i64);
        }
        let live = g
            .rows
            .values()
            .find(|e| e.row.session_id == sid && e.row.state != State::Parked)
            .map(|e| e.row.user_id);
        if let Some(user) = live {
            park_or_drop(st, &mut g, user).await;
        }
    }

    /// Parks every live row whose owner stopped beating, drops the parked rows past their day (rule 14a, 12).
    pub async fn sweep(&self, st: &AppState) {
        let mut g = self.0.lock().await;
        Self::park_silent(st, &mut g, None).await;
        let revive =
            i64::from(crate::engine::lifetime(|k| std::env::var(k).ok()).session_revive_ttl_ms);
        let now = now_ms() as i64;
        for (sid, c) in g.claimed.iter_mut() {
            if c.ended_at.is_none() && st.presence.peek(sid).is_none() {
                c.ended_at = Some(now);
            }
        }
        g.claimed.retain(|sid, c| {
            c.ended_at.is_none_or(|t| now - t < revive) || st.presence.peek(sid).is_some()
        });
        Self::announce_lapsed_handoffs(st, &mut g, now);
        let cutoff = Utc::now() - PARKED_TTL;
        let old: Vec<i32> = g
            .rows
            .iter()
            .filter(|(_, e)| e.row.state == State::Parked && e.row.updated_at < cutoff)
            .map(|(u, _)| *u)
            .collect();
        for user in old {
            if let Err(e) = store::delete(&st.db, user).await {
                tracing::warn!(user, "account session not deleted: {e}");
                continue;
            }
            g.rows.remove(&user);
            announce(st, user, None);
        }
    }

    /// Drops the transfer records past their TTL and tells each account, so a waiting originator stops.
    fn announce_lapsed_handoffs(st: &AppState, g: &mut Inner, now: i64) {
        let mut lapsed: Vec<i32> = g
            .handoffs
            .extract_if(|_, (_, until)| *until <= now)
            .map(|((account, _), _)| account)
            .collect();
        lapsed.sort_unstable();
        lapsed.dedup();
        for account in lapsed {
            announce(st, account, g.rows.get(&account).map(|e| &e.row));
        }
    }

    async fn park_silent(st: &AppState, g: &mut Inner, only: Option<i32>) {
        let (now, ttl) = (now_ms(), ttl_ms());
        let silent: Vec<i32> = g
            .rows
            .iter()
            .filter(|(user, e)| {
                e.row.state != State::Parked
                    && only.is_none_or(|u| u == **user)
                    && st
                        .presence
                        .peek(&e.row.session_id)
                        .is_none_or(|p| now - p.last_beat > ttl)
            })
            .map(|(user, _)| *user)
            .collect();
        for user in silent {
            park_or_drop(st, g, user).await;
        }
    }

    /// Whether the device of `target` holds `file`, however long ago it last beat: its newest row
    /// among `accounts` (the sender and the target's owner, never another account's state) names it;
    /// a live row outranks a parked one, as parking restamps `updated_at`.
    pub async fn holds(&self, accounts: &[i32], target: &str, file: i64) -> bool {
        let target = Some(target.to_owned());
        self.0
            .lock()
            .await
            .rows
            .iter()
            .filter(|(user, e)| {
                accounts.contains(user) && same_device(&e.row.owner.target_id, &target)
            })
            .max_by_key(|(_, e)| (e.row.state != State::Parked, e.row.updated_at))
            .is_some_and(|(_, e)| e.row.media_file_id.is_some_and(|f| i64::from(f) == file))
    }

    /// The row of `user` after the staleness check; `None` when there is none.
    pub async fn get(&self, st: &AppState, user: i32) -> Option<Row> {
        let mut g = self.0.lock().await;
        Self::park_silent(st, &mut g, Some(user)).await;
        g.rows.get(&user).map(|e| e.row.clone())
    }

    /// A row whose item is gone (the database cascaded it) is dropped from memory too, unless a
    /// newer row replaced it meanwhile.
    async fn forget(&self, user: i32, sid: &str, item: i32) {
        let mut g = self.0.lock().await;
        if let Some(e) = g.rows.get(&user)
            && (e.row.session_id.as_str(), e.row.item_id) == (sid, item)
        {
            g.rows.remove(&user);
        }
    }

    /// The file of the row is gone (the database nulled it): memory follows.
    async fn unfile(&self, user: i32, sid: &str, file: i32) {
        if let Some(e) = self.0.lock().await.rows.get_mut(&user)
            && e.row.session_id == sid
            && e.row.media_file_id == Some(file)
        {
            e.row.media_file_id = None;
        }
    }

    pub async fn dismiss(&self, st: &AppState, user: i32) -> Result<(), crate::http::AppError> {
        let mut g = self.0.lock().await;
        Self::park_silent(st, &mut g, Some(user)).await;
        match g.rows.get(&user).map(|e| e.row.state) {
            None => Ok(()),
            Some(State::Parked) => {
                store::delete(&st.db, user).await?;
                g.rows.remove(&user);
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
            // A listing expires polled targets and announces silent streams.
            st.hub.list_all();
        }
    });
}

#[cfg(test)]
mod tests;

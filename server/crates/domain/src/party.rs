//! Watch-party state machine (`docs/spec/watch-party.md`, State machine): pure, the clock is passed in.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

pub const WAIT_TIMEOUT_MS: i64 = 10_000;
pub const MIN_START_DELAY_MS: i64 = 500;
pub const AWAY_GRACE_MS: i64 = 120_000;
pub const EMPTY_TTL_MS: i64 = 600_000;
pub const LOBBY_OPEN_BEFORE_MS: i64 = 900_000;
pub const SCHEDULE_EXPIRY_MS: i64 = 7_200_000;
pub const VOICE_MAX: usize = 8;
pub const CHAT_CAP: usize = 200;
pub const SNAPSHOT_MESSAGES: usize = 50;
/// Reactions with an animated asset under `public/emoji/`; `scripts/fetch-reaction-emoji.py` reads
/// this block to fetch them.
pub const ANIMATED_REACTIONS: [&str; 32] = [
    "👍", "👎", "😂", "🤣", "😮", "😱", "😢", "😭", "😡", "🤬", "❤️", "😍", "🥰", "🔥", "👏", "🙌",
    "🎉", "💯", "🤔", "🙄", "😴", "🤯", "😬", "🫣", "😅", "😎", "🥲", "💀", "👀", "🍿", "🤢", "😳",
];
/// The reaction bar a device starts with.
pub const DEFAULT_REACTIONS: [&str; 8] = ["👍", "😂", "😮", "😢", "😡", "❤️", "🔥", "👏"];
const READY_TOLERANCE_S: f64 = 1.0;
const RATE_WINDOW_MS: i64 = 10_000;
const MAX_MESSAGES: usize = 5;
const MAX_REACTIONS: usize = 10;
const MAX_SIGNALS: usize = 60;

/// Noto's asset name for an emoji: its codepoints in lowercase hex, joined by `_`.
pub fn noto_code(emoji: &str) -> String {
    emoji
        .chars()
        .map(|c| format!("{:x}", c as u32))
        .collect::<Vec<_>>()
        .join("_")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Idle,
    Waiting,
    Paused,
    Playing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemberStatus {
    Ready,
    Buffering,
    Away,
    Waiting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Host,
    Member,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Policy {
    Everyone,
    HostOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Play,
    Pause,
    Seek,
    SetItem,
    Ended,
}

impl Action {
    fn wire(self) -> &'static str {
        match self {
            Self::Play => "play",
            Self::Pause => "pause",
            Self::Seek => "seek",
            Self::SetItem => "setItem",
            Self::Ended => "ended",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    HostEnded,
    Expired,
    Kicked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub media_id: i32,
    pub media_file_id: Option<i32>,
    pub episode_id: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub position: f64,
    pub server_time_ms: i64,
}

/// A member in the voice channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Voice {
    pub muted: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Member {
    pub user_id: i32,
    pub username: String,
    pub device_id: String,
    pub connection_id: String,
    pub status: MemberStatus,
    pub last_seen_ms: i64,
    pub rtt_ms: i64,
    pub away_since: Option<i64>,
    pub voice: Option<Voice>,
    joined: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct System {
    pub kind: String,
    pub by: Option<String>,
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: u64,
    pub user_id: Option<i32>,
    pub username: Option<String>,
    pub text: String,
    pub system: Option<System>,
    pub sent_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct By {
    pub user_id: i32,
    pub username: String,
}

/// What a mutation tells the outside world; `Closed` names its own recipients, the rest go to the
/// members present at the end of the call.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    State {
        rev: u64,
        state: State,
        item: Item,
        anchor: Anchor,
        when_ms: Option<i64>,
        by: Option<By>,
        action: Option<&'static str>,
    },
    Members {
        rev: u64,
        host_id: i32,
        members: Vec<Member>,
    },
    Settings {
        rev: u64,
        name: String,
        policy: Policy,
    },
    Message(Message),
    Reaction {
        user_id: i32,
        username: String,
        emoji: String,
    },
    Closed {
        reason: CloseReason,
        to: Vec<(i32, String)>,
    },
    /// Rule 8: the row's position and item follow every transition.
    Persist {
        position: f64,
        item: Item,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    NotMember,
    HostOnly,
    Stale,
    Invalid(&'static str),
    RateLimited,
    VoiceFull,
    VoiceNotJoined,
}

/// A client intent (`play|pause|seek|setItem|ended`) with the revision it was made on.
pub struct Intent {
    pub action: Action,
    pub position: Option<f64>,
    pub item: Option<Item>,
    pub base_rev: u64,
}

#[derive(Debug, Clone)]
struct Phase {
    target_playing: bool,
    since: i64,
    by: Option<By>,
    action: &'static str,
}

pub struct Live {
    pub name: String,
    pub policy: Policy,
    pub host_id: i32,
    pub item: Item,
    pub state: State,
    pub anchor: Anchor,
    pub rev: u64,
    pub members: Vec<Member>,
    pub chat: VecDeque<Message>,
    /// Users kicked since the last token regeneration.
    pub blocked: Vec<i32>,
    /// A scheduled party's open lobby: members start `waiting` until they say ready.
    pub lobby: bool,
    phase: Option<Phase>,
    empty_since: Option<i64>,
    next_msg: u64,
    next_join: u64,
    limits: HashMap<(i32, String, Limit), VecDeque<i64>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Limit {
    Message,
    Reaction,
    Signal,
}

fn by_of(m: &Member) -> By {
    By {
        user_id: m.user_id,
        username: m.username.clone(),
    }
}

impl Live {
    /// A party that has just opened: idle at `position`, host = the owner.
    pub fn new(
        name: String,
        policy: Policy,
        host_id: i32,
        item: Item,
        position: f64,
        now: i64,
    ) -> Self {
        Self {
            name,
            policy,
            host_id,
            item,
            state: State::Idle,
            anchor: Anchor {
                position,
                server_time_ms: now,
            },
            rev: 1,
            members: vec![],
            chat: VecDeque::new(),
            blocked: vec![],
            lobby: false,
            phase: None,
            empty_since: Some(now),
            next_msg: 1,
            next_join: 0,
            limits: HashMap::new(),
        }
    }

    /// Rule 10: after a restart, paused at the stored position with nobody in.
    pub fn boot(
        name: String,
        policy: Policy,
        host_id: i32,
        item: Item,
        position: f64,
        now: i64,
    ) -> Self {
        let mut l = Self::new(name, policy, host_id, item, position, now);
        l.state = State::Paused;
        l
    }

    /// Never before the anchor: a pause during the start delay keeps the anchor position.
    pub fn position_at(&self, now: i64) -> f64 {
        match self.state {
            State::Playing => {
                self.anchor.position + (now - self.anchor.server_time_ms).max(0) as f64 / 1000.0
            }
            _ => self.anchor.position,
        }
    }

    pub fn role_of(&self, m: &Member) -> Role {
        if m.user_id == self.host_id {
            Role::Host
        } else {
            Role::Member
        }
    }

    pub fn has_user(&self, user_id: i32) -> bool {
        self.members.iter().any(|m| m.user_id == user_id)
    }

    pub fn audience(&self) -> Vec<(i32, String)> {
        self.members
            .iter()
            .filter(|m| m.status != MemberStatus::Away)
            .map(|m| (m.user_id, m.connection_id.clone()))
            .collect()
    }

    pub fn recent_messages(&self) -> Vec<Message> {
        let skip = self.chat.len().saturating_sub(SNAPSHOT_MESSAGES);
        self.chat.iter().skip(skip).cloned().collect()
    }

    /// The party reopens its countdown when it goes live with the lobby possibly long empty.
    pub fn reset_empty(&mut self, now: i64) {
        self.empty_since =
            (!self.members.iter().any(|m| m.status != MemberStatus::Away)).then_some(now);
    }

    /// `POST /start`: the lobby goes live and every member, invited or not, gets the new state.
    pub fn go_live(&mut self, now: i64) -> Vec<Effect> {
        let mut out = Vec::new();
        self.lobby = false;
        self.reset_empty(now);
        self.state_effect(&mut out, now, None, None, None);
        out
    }

    fn bump(&mut self) -> u64 {
        self.rev += 1;
        self.rev
    }

    fn find(&self, user: i32, device: &str) -> Option<usize> {
        self.members
            .iter()
            .position(|m| m.user_id == user && m.device_id == device)
    }

    fn sys(&mut self, out: &mut Vec<Effect>, kind: &str, by: Option<&str>, args: Value, now: i64) {
        let m = Message {
            id: self.next_msg,
            user_id: None,
            username: None,
            text: String::new(),
            system: Some(System {
                kind: kind.into(),
                by: by.map(Into::into),
                args,
            }),
            sent_at_ms: now,
        };
        self.push_message(m.clone());
        out.push(Effect::Message(m));
    }

    fn push_message(&mut self, m: Message) {
        self.next_msg += 1;
        self.chat.push_back(m);
        if self.chat.len() > CHAT_CAP {
            self.chat.pop_front();
        }
    }

    fn members_effect(&mut self, out: &mut Vec<Effect>) {
        let rev = self.bump();
        out.push(Effect::Members {
            rev,
            host_id: self.host_id,
            members: self.members.clone(),
        });
    }

    fn state_effect(
        &mut self,
        out: &mut Vec<Effect>,
        now: i64,
        when_ms: Option<i64>,
        by: Option<By>,
        action: Option<&'static str>,
    ) {
        let rev = self.bump();
        out.push(Effect::Persist {
            position: self.position_at(now),
            item: self.item.clone(),
        });
        out.push(Effect::State {
            rev,
            state: self.state,
            item: self.item.clone(),
            anchor: self.anchor,
            when_ms,
            by,
            action,
        });
    }

    fn all_ready(&self) -> bool {
        self.members
            .iter()
            .filter(|m| m.status != MemberStatus::Away)
            .all(|m| m.status == MemberStatus::Ready)
    }

    fn enter_waiting(
        &mut self,
        out: &mut Vec<Effect>,
        position: f64,
        target_playing: bool,
        by: &Member,
        action: Action,
        now: i64,
    ) {
        let keep = self.state == State::Waiting && action != Action::Play;
        let target = if keep {
            self.phase.as_ref().is_some_and(|p| p.target_playing)
        } else {
            target_playing
        };
        self.state = State::Waiting;
        self.anchor = Anchor {
            position,
            server_time_ms: now,
        };
        for m in &mut self.members {
            if m.status != MemberStatus::Away {
                m.status = MemberStatus::Waiting;
            }
        }
        let by = Some(by_of(by));
        self.phase = Some(Phase {
            target_playing: target,
            since: now,
            by: by.clone(),
            action: action.wire(),
        });
        self.state_effect(out, now, None, by, Some(action.wire()));
    }

    /// Rule 3. Members still not ready are left as they are and catch up alone.
    fn complete(&mut self, out: &mut Vec<Effect>, now: i64) {
        let Some(phase) = self.phase.take() else {
            return;
        };
        let position = self.anchor.position;
        let when = if phase.target_playing {
            let rtt = self.members.iter().map(|m| m.rtt_ms).max().unwrap_or(0);
            let when = now + (2 * rtt).max(MIN_START_DELAY_MS);
            self.state = State::Playing;
            self.anchor = Anchor {
                position,
                server_time_ms: when,
            };
            Some(when)
        } else {
            self.state = State::Paused;
            self.anchor = Anchor {
                position,
                server_time_ms: now,
            };
            None
        };
        self.state_effect(out, now, when, phase.by, Some(phase.action));
    }

    fn settle(&mut self, out: &mut Vec<Effect>, now: i64) {
        if self.state == State::Waiting && self.all_ready() {
            self.complete(out, now);
        }
    }

    fn transfer_if_host_gone(&mut self, out: &mut Vec<Effect>, now: i64) {
        if self.has_user(self.host_id) {
            return;
        }
        let next = self
            .members
            .iter()
            .filter(|m| m.status != MemberStatus::Away)
            .chain(&self.members)
            .min_by_key(|m| (m.status == MemberStatus::Away, m.joined))
            .map(|m| (m.user_id, m.username.clone()));
        if let Some((id, username)) = next {
            self.host_id = id;
            self.sys(
                out,
                "host_changed",
                None,
                json!({ "username": username }),
                now,
            );
        }
    }

    /// A rejoin of the same `(user, device)` replaces the connection and resets the status.
    pub fn join(
        &mut self,
        user_id: i32,
        username: &str,
        device_id: &str,
        connection_id: &str,
        now: i64,
    ) -> Vec<Effect> {
        let mut out = vec![];
        let status = if self.state == State::Waiting || self.lobby {
            MemberStatus::Waiting
        } else {
            MemberStatus::Ready
        };
        let isnew = match self.find(user_id, device_id) {
            Some(i) => {
                let m = &mut self.members[i];
                m.connection_id = connection_id.into();
                m.status = status;
                m.away_since = None;
                m.last_seen_ms = now;
                false
            }
            None => {
                self.next_join += 1;
                self.members.push(Member {
                    user_id,
                    username: username.into(),
                    device_id: device_id.into(),
                    connection_id: connection_id.into(),
                    status,
                    last_seen_ms: now,
                    rtt_ms: 0,
                    away_since: None,
                    voice: None,
                    joined: self.next_join,
                });
                true
            }
        };
        self.empty_since = None;
        self.members_effect(&mut out);
        if isnew {
            self.sys(&mut out, "joined", Some(username), json!({}), now);
        }
        out
    }

    pub fn leave(&mut self, user_id: i32, device_id: &str, now: i64) -> Result<Vec<Effect>, Error> {
        let i = self.find(user_id, device_id).ok_or(Error::NotMember)?;
        let m = self.members.remove(i);
        let mut out = vec![];
        self.members_effect(&mut out);
        self.sys(&mut out, "left", Some(&m.username), json!({}), now);
        self.transfer_if_host_gone(&mut out, now);
        self.settle(&mut out, now);
        Ok(out)
    }

    pub fn intent(
        &mut self,
        user_id: i32,
        device_id: &str,
        req: Intent,
        now: i64,
    ) -> Result<(u64, Vec<Effect>), Error> {
        let Intent {
            action,
            position,
            item,
            base_rev,
        } = req;
        let i = self.find(user_id, device_id).ok_or(Error::NotMember)?;
        let actor = self.members[i].clone();
        let host = user_id == self.host_id;
        let mut out = vec![];
        if action == Action::Ended {
            if host && self.state != State::Idle {
                self.anchor = Anchor {
                    position: self.position_at(now),
                    server_time_ms: now,
                };
                self.state = State::Idle;
                self.phase = None;
                self.state_effect(&mut out, now, None, Some(by_of(&actor)), Some("ended"));
            }
            return Ok((self.rev, out));
        }
        if self.policy == Policy::HostOnly && !host {
            return Err(Error::HostOnly);
        }
        let moves = matches!(action, Action::Seek | Action::SetItem);
        if moves && base_rev < self.rev {
            return Err(Error::Stale);
        }
        let playing_ctx = self.state == State::Playing;
        let name = actor.username.clone();
        match action {
            Action::Play => {
                if matches!(self.state, State::Idle | State::Paused) {
                    let p = self.anchor.position;
                    self.enter_waiting(&mut out, p, true, &actor, action, now);
                    self.sys(
                        &mut out,
                        "resumed",
                        Some(&name),
                        json!({ "position": p }),
                        now,
                    );
                } else if self.state == State::Waiting
                    && let Some(p) = &mut self.phase
                {
                    p.target_playing = true;
                }
            }
            Action::Pause => match self.state {
                State::Playing => {
                    let p = self.position_at(now);
                    self.state = State::Paused;
                    self.anchor = Anchor {
                        position: p,
                        server_time_ms: now,
                    };
                    self.state_effect(&mut out, now, None, Some(by_of(&actor)), Some("pause"));
                    self.sys(
                        &mut out,
                        "paused",
                        Some(&name),
                        json!({ "position": p }),
                        now,
                    );
                }
                State::Waiting => {
                    if let Some(p) = &mut self.phase {
                        p.target_playing = false;
                    }
                    self.sys(&mut out, "paused", Some(&name), json!({}), now);
                }
                _ => {}
            },
            Action::Seek => {
                let p = position
                    .filter(|p| p.is_finite() && *p >= 0.0)
                    .ok_or(Error::Invalid("position"))?;
                self.enter_waiting(&mut out, p, playing_ctx, &actor, action, now);
                self.sys(
                    &mut out,
                    "seeked",
                    Some(&name),
                    json!({ "position": p }),
                    now,
                );
            }
            Action::SetItem => {
                let it = item.ok_or(Error::Invalid("item"))?;
                self.item = it;
                self.enter_waiting(&mut out, 0.0, playing_ctx, &actor, action, now);
                self.sys(&mut out, "item_changed", Some(&name), json!({}), now);
            }
            Action::Ended => {}
        }
        Ok((self.rev, out))
    }

    /// Rules 2 and 5: only an `ready` near the anchor counts during `waiting`.
    pub fn status(
        &mut self,
        user_id: i32,
        device_id: &str,
        status: MemberStatus,
        position: f64,
        rtt_ms: Option<i64>,
        now: i64,
    ) -> Result<Vec<Effect>, Error> {
        let i = self.find(user_id, device_id).ok_or(Error::NotMember)?;
        let near = (position - self.anchor.position).abs() <= READY_TOLERANCE_S;
        let waiting = self.state == State::Waiting;
        let m = &mut self.members[i];
        m.last_seen_ms = now;
        if let Some(r) = rtt_ms {
            m.rtt_ms = r.max(0);
        }
        let new = match status {
            MemberStatus::Ready if waiting && !near => m.status,
            MemberStatus::Ready | MemberStatus::Buffering | MemberStatus::Waiting => status,
            MemberStatus::Away => return Err(Error::Invalid("status")),
        };
        let mut out = vec![];
        if new != m.status {
            m.status = new;
            m.away_since = None;
            self.members_effect(&mut out);
        }
        self.settle(&mut out, now);
        Ok(out)
    }

    /// Rules 3, 9: the 1 s tick. `alive` says whether a connection id is still open.
    pub fn tick(&mut self, now: i64, alive: impl Fn(&str) -> bool) -> Vec<Effect> {
        let mut out = vec![];
        let mut changed = false;
        for m in &mut self.members {
            if m.status != MemberStatus::Away && !alive(&m.connection_id) {
                m.status = MemberStatus::Away;
                m.away_since = Some(now);
                changed = true;
            }
        }
        let gone: Vec<Member> = self
            .members
            .iter()
            .filter(|m| m.away_since.is_some_and(|s| now - s >= AWAY_GRACE_MS))
            .cloned()
            .collect();
        self.members.retain(|m| !gone.contains(m));
        if changed || !gone.is_empty() {
            self.members_effect(&mut out);
        }
        for m in &gone {
            self.sys(&mut out, "left", Some(&m.username), json!({}), now);
        }
        if !gone.is_empty() {
            self.transfer_if_host_gone(&mut out, now);
        }
        if self.state == State::Waiting
            && (self.all_ready()
                || self
                    .phase
                    .as_ref()
                    .is_some_and(|p| now - p.since >= WAIT_TIMEOUT_MS))
        {
            self.complete(&mut out, now);
        }
        if self.members.iter().any(|m| m.status != MemberStatus::Away) {
            self.empty_since = None;
        } else if now - *self.empty_since.get_or_insert(now) >= EMPTY_TTL_MS {
            out.push(Effect::Closed {
                reason: CloseReason::Expired,
                to: vec![],
            });
        }
        out
    }

    pub fn set_settings(&mut self, name: Option<String>, policy: Option<Policy>) -> Vec<Effect> {
        let mut out = vec![];
        if let Some(n) = name {
            self.name = n;
        }
        if let Some(p) = policy {
            self.policy = p;
        }
        let rev = self.bump();
        out.push(Effect::Settings {
            rev,
            name: self.name.clone(),
            policy: self.policy,
        });
        out
    }

    /// The target must be a member; the host role moves to that user.
    pub fn transfer(&mut self, to_user: i32, by: &str, now: i64) -> Result<Vec<Effect>, Error> {
        let m = self
            .members
            .iter()
            .find(|m| m.user_id == to_user)
            .ok_or(Error::NotMember)?;
        let username = m.username.clone();
        self.host_id = to_user;
        let mut out = vec![];
        self.members_effect(&mut out);
        self.sys(
            &mut out,
            "host_changed",
            Some(by),
            json!({ "username": username }),
            now,
        );
        Ok(out)
    }

    /// Removes every member of the user and blocks token rejoin (`blocked`).
    pub fn kick(&mut self, user_id: i32, by: &str, now: i64) -> Result<Vec<Effect>, Error> {
        if user_id == self.host_id {
            return Err(Error::Invalid("host"));
        }
        let (gone, keep): (Vec<_>, Vec<_>) =
            self.members.drain(..).partition(|m| m.user_id == user_id);
        self.members = keep;
        let first = gone.first().ok_or(Error::NotMember)?;
        let username = first.username.clone();
        self.blocked.push(user_id);
        let mut out = vec![Effect::Closed {
            reason: CloseReason::Kicked,
            to: gone
                .iter()
                .map(|m| (m.user_id, m.connection_id.clone()))
                .collect(),
        }];
        self.members_effect(&mut out);
        self.sys(
            &mut out,
            "kicked",
            Some(by),
            json!({ "username": username }),
            now,
        );
        self.settle(&mut out, now);
        Ok(out)
    }

    pub fn close(&self, reason: CloseReason) -> Effect {
        Effect::Closed {
            reason,
            to: self.audience(),
        }
    }

    fn rate_ok(&mut self, user: i32, device: &str, kind: Limit, now: i64) -> bool {
        let max = match kind {
            Limit::Message => MAX_MESSAGES,
            Limit::Reaction => MAX_REACTIONS,
            Limit::Signal => MAX_SIGNALS,
        };
        let q = self.limits.entry((user, device.into(), kind)).or_default();
        while q.front().is_some_and(|t| now - t >= RATE_WINDOW_MS) {
            q.pop_front();
        }
        if q.len() >= max {
            return false;
        }
        q.push_back(now);
        true
    }

    /// Joins, leaves or mutes the voice channel; always bumps `rev`.
    pub fn set_voice(
        &mut self,
        user_id: i32,
        device_id: &str,
        joined: bool,
        muted: bool,
        now: i64,
    ) -> Result<Vec<Effect>, Error> {
        let i = self.find(user_id, device_id).ok_or(Error::NotMember)?;
        let was = self.members[i].voice.is_some();
        let count = self.members.iter().filter(|m| m.voice.is_some()).count();
        if joined && !was && count >= VOICE_MAX {
            return Err(Error::VoiceFull);
        }
        self.members[i].voice = joined.then_some(Voice { muted });
        let mut out = vec![];
        self.members_effect(&mut out);
        if joined != was {
            let kind = if joined { "voice_joined" } else { "voice_left" };
            let name = self.members[i].username.clone();
            self.sys(&mut out, kind, Some(&name), json!({}), now);
        }
        Ok(out)
    }

    /// The `(user, connection)` a signal goes to; both ends need `voice`.
    pub fn signal_target(
        &mut self,
        user_id: i32,
        device_id: &str,
        to: &str,
        now: i64,
    ) -> Result<(i32, String), Error> {
        let i = self.find(user_id, device_id).ok_or(Error::NotMember)?;
        let target = self
            .members
            .iter()
            .find(|m| m.device_id == to && m.voice.is_some())
            .map(|m| (m.user_id, m.connection_id.clone()));
        let target = target.filter(|_| self.members[i].voice.is_some());
        let target = target.ok_or(Error::VoiceNotJoined)?;
        if !self.rate_ok(user_id, device_id, Limit::Signal, now) {
            return Err(Error::RateLimited);
        }
        Ok(target)
    }

    pub fn post_message(
        &mut self,
        user_id: i32,
        device_id: &str,
        text: &str,
        now: i64,
    ) -> Result<(Message, Vec<Effect>), Error> {
        let i = self.find(user_id, device_id).ok_or(Error::NotMember)?;
        if !self.rate_ok(user_id, device_id, Limit::Message, now) {
            return Err(Error::RateLimited);
        }
        let m = Message {
            id: self.next_msg,
            user_id: Some(user_id),
            username: Some(self.members[i].username.clone()),
            text: text.into(),
            system: None,
            sent_at_ms: now,
        };
        self.push_message(m.clone());
        Ok((m.clone(), vec![Effect::Message(m)]))
    }

    pub fn react(
        &mut self,
        user_id: i32,
        device_id: &str,
        emoji: &str,
        now: i64,
    ) -> Result<Vec<Effect>, Error> {
        let i = self.find(user_id, device_id).ok_or(Error::NotMember)?;
        if !self.rate_ok(user_id, device_id, Limit::Reaction, now) {
            return Err(Error::RateLimited);
        }
        Ok(vec![Effect::Reaction {
            user_id,
            username: self.members[i].username.clone(),
            emoji: emoji.into(),
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reaction_catalog_is_coherent() {
        assert_eq!(noto_code("❤️"), "2764_fe0f");
        let mut emojis = ANIMATED_REACTIONS.to_vec();
        emojis.sort_unstable();
        emojis.dedup();
        assert_eq!(emojis.len(), ANIMATED_REACTIONS.len());
        assert!(DEFAULT_REACTIONS.iter().all(|d| emojis.contains(d)));
    }

    fn item() -> Item {
        Item {
            media_id: 1,
            media_file_id: None,
            episode_id: None,
        }
    }

    /// Host 1 and member 2, both ready, party idle.
    fn party() -> Live {
        let mut l = Live::new("p".into(), Policy::Everyone, 1, item(), 0.0, 0);
        l.join(1, "alice", "d1", "c1", 0);
        l.join(2, "bob", "d2", "c2", 0);
        l
    }

    fn play(l: &mut Live, user: i32, dev: &str, now: i64) -> Vec<Effect> {
        l.intent(
            user,
            dev,
            Intent {
                action: Action::Play,
                position: None,
                item: None,
                base_rev: l.rev,
            },
            now,
        )
        .unwrap()
        .1
    }

    fn ready(l: &mut Live, user: i32, dev: &str, pos: f64, now: i64) -> Vec<Effect> {
        l.status(user, dev, MemberStatus::Ready, pos, None, now)
            .unwrap()
    }

    fn state_of(out: &[Effect]) -> Option<(State, Option<i64>)> {
        out.iter().find_map(|e| match e {
            Effect::State { state, when_ms, .. } => Some((*state, *when_ms)),
            _ => None,
        })
    }

    #[test]
    fn play_waits_then_starts_when_everyone_is_ready() {
        let mut l = party();
        let out = play(&mut l, 2, "d2", 1000);
        assert_eq!(state_of(&out), Some((State::Waiting, None)));
        assert!(l.members.iter().all(|m| m.status == MemberStatus::Waiting));
        assert!(
            ready(&mut l, 1, "d1", 0.0, 1100)
                .iter()
                .all(|e| state_of(std::slice::from_ref(e)).is_none())
        );
        l.members[1].rtt_ms = 400;
        let out = ready(&mut l, 2, "d2", 0.5, 1200);
        assert_eq!(state_of(&out), Some((State::Playing, Some(2000))));
        assert_eq!(
            l.anchor,
            Anchor {
                position: 0.0,
                server_time_ms: 2000
            }
        );
        assert_eq!(l.position_at(3000), 1.0);
    }

    #[test]
    fn a_far_ready_does_not_count_and_the_timeout_releases_the_group() {
        let mut l = party();
        play(&mut l, 1, "d1", 0);
        ready(&mut l, 1, "d1", 0.0, 10);
        ready(&mut l, 2, "d2", 30.0, 20);
        assert_eq!(l.members[1].status, MemberStatus::Waiting);
        assert!(state_of(&l.tick(9_999, |_| true)).is_none());
        let out = l.tick(10_000, |_| true);
        assert_eq!(state_of(&out), Some((State::Playing, Some(10_500))));
        assert_eq!(l.members[1].status, MemberStatus::Waiting);
    }

    #[test]
    fn seek_while_paused_ends_paused_and_while_playing_ends_playing() {
        let mut l = party();
        l.state = State::Paused;
        l.intent(
            1,
            "d1",
            Intent {
                action: Action::Seek,
                position: Some(50.0),
                item: None,
                base_rev: l.rev,
            },
            0,
        )
        .unwrap();
        ready(&mut l, 1, "d1", 50.0, 1);
        let out = ready(&mut l, 2, "d2", 50.0, 2);
        assert_eq!(state_of(&out), Some((State::Paused, None)));
        play(&mut l, 1, "d1", 3);
        ready(&mut l, 1, "d1", 50.0, 4);
        ready(&mut l, 2, "d2", 50.0, 5);
        assert_eq!(l.state, State::Playing);
        l.intent(
            2,
            "d2",
            Intent {
                action: Action::Seek,
                position: Some(80.0),
                item: None,
                base_rev: l.rev,
            },
            6000,
        )
        .unwrap();
        ready(&mut l, 1, "d1", 80.0, 6001);
        let out = ready(&mut l, 2, "d2", 80.0, 6002);
        assert_eq!(state_of(&out).map(|s| s.0), Some(State::Playing));
    }

    #[test]
    fn pause_while_playing_is_immediate_and_while_waiting_retargets() {
        let mut l = party();
        play(&mut l, 1, "d1", 0);
        l.intent(
            2,
            "d2",
            Intent {
                action: Action::Pause,
                position: None,
                item: None,
                base_rev: 0,
            },
            5,
        )
        .unwrap();
        ready(&mut l, 1, "d1", 0.0, 6);
        let out = ready(&mut l, 2, "d2", 0.0, 7);
        assert_eq!(state_of(&out), Some((State::Paused, None)));
        play(&mut l, 1, "d1", 8);
        ready(&mut l, 1, "d1", 0.0, 9);
        ready(&mut l, 2, "d2", 0.0, 10);
        assert_eq!(l.state, State::Playing);
        let start = l.anchor.server_time_ms;
        let out = l
            .intent(
                1,
                "d1",
                Intent {
                    action: Action::Pause,
                    position: None,
                    item: None,
                    base_rev: 0,
                },
                start + 4000,
            )
            .unwrap()
            .1;
        assert_eq!(state_of(&out), Some((State::Paused, None)));
        assert_eq!(l.anchor.position, 4.0);
    }

    #[test]
    fn buffering_never_pauses_the_group_and_a_late_member_never_waits() {
        let mut l = party();
        play(&mut l, 1, "d1", 0);
        ready(&mut l, 1, "d1", 0.0, 1);
        ready(&mut l, 2, "d2", 0.0, 2);
        let rev = l.rev;
        l.status(2, "d2", MemberStatus::Buffering, 3.0, None, 3000)
            .unwrap();
        assert_eq!(l.state, State::Playing);
        assert_eq!(l.members[1].status, MemberStatus::Buffering);
        assert!(l.rev > rev);
        let out = l.join(3, "carol", "d3", "c3", 4000);
        assert!(state_of(&out).is_none());
        assert_eq!(l.state, State::Playing);
        assert_eq!(l.members[2].status, MemberStatus::Ready);
    }

    #[test]
    fn lobby_members_start_waiting_and_toggle_ready() {
        let mut l = Live::new("p".into(), Policy::Everyone, 1, item(), 0.0, 0);
        l.lobby = true;
        l.join(2, "bob", "d2", "c2", 0);
        assert_eq!(l.members[0].status, MemberStatus::Waiting);
        let out = ready(&mut l, 2, "d2", 0.0, 1);
        assert!(out.iter().any(|e| matches!(e, Effect::Members { .. })));
        assert_eq!(l.members[0].status, MemberStatus::Ready);
        l.status(2, "d2", MemberStatus::Waiting, 0.0, None, 2)
            .unwrap();
        assert_eq!(l.members[0].status, MemberStatus::Waiting);
        assert_eq!(l.state, State::Idle);
        let out = l.go_live(3);
        assert!(!l.lobby);
        assert!(out.iter().any(|e| matches!(e, Effect::State { .. })));
    }

    #[test]
    fn host_only_blocks_non_host_moves_but_not_status() {
        let mut l = party();
        l.policy = Policy::HostOnly;
        for a in [Action::Play, Action::Pause, Action::Seek, Action::SetItem] {
            let r = l.intent(
                2,
                "d2",
                Intent {
                    action: a,
                    position: Some(1.0),
                    item: Some(item()),
                    base_rev: l.rev,
                },
                0,
            );
            assert_eq!(r.unwrap_err(), Error::HostOnly);
        }
        assert!(
            l.intent(
                1,
                "d1",
                Intent {
                    action: Action::Play,
                    position: None,
                    item: None,
                    base_rev: l.rev
                },
                0
            )
            .is_ok()
        );
    }

    #[test]
    fn a_stale_seek_or_set_item_is_refused_but_play_pause_apply() {
        let mut l = party();
        let old = l.rev;
        play(&mut l, 1, "d1", 0);
        assert!(l.rev > old);
        let r = l.intent(
            2,
            "d2",
            Intent {
                action: Action::Seek,
                position: Some(9.0),
                item: None,
                base_rev: old,
            },
            1,
        );
        assert_eq!(r.unwrap_err(), Error::Stale);
        let r = l.intent(
            2,
            "d2",
            Intent {
                action: Action::SetItem,
                position: None,
                item: Some(item()),
                base_rev: old,
            },
            1,
        );
        assert_eq!(r.unwrap_err(), Error::Stale);
        assert!(
            l.intent(
                2,
                "d2",
                Intent {
                    action: Action::Pause,
                    position: None,
                    item: None,
                    base_rev: old
                },
                1
            )
            .is_ok()
        );
        assert!(
            l.intent(
                2,
                "d2",
                Intent {
                    action: Action::Play,
                    position: None,
                    item: None,
                    base_rev: old
                },
                2
            )
            .is_ok()
        );
    }

    #[test]
    fn set_item_resets_the_position_and_ended_goes_idle_for_the_host_only() {
        let mut l = party();
        l.state = State::Paused;
        l.anchor.position = 42.0;
        let next = Item {
            media_id: 1,
            media_file_id: None,
            episode_id: Some(7),
        };
        let out = l
            .intent(
                1,
                "d1",
                Intent {
                    action: Action::SetItem,
                    position: None,
                    item: Some(next.clone()),
                    base_rev: l.rev,
                },
                0,
            )
            .unwrap()
            .1;
        assert_eq!(l.item, next);
        assert_eq!(l.anchor.position, 0.0);
        assert!(
            out.iter()
                .any(|e| matches!(e, Effect::Persist { position, .. } if *position == 0.0))
        );
        l.state = State::Playing;
        let before = l.rev;
        assert!(
            l.intent(
                2,
                "d2",
                Intent {
                    action: Action::Ended,
                    position: None,
                    item: None,
                    base_rev: 0
                },
                5
            )
            .unwrap()
            .1
            .is_empty()
        );
        assert_eq!(l.rev, before);
        let out = l
            .intent(
                1,
                "d1",
                Intent {
                    action: Action::Ended,
                    position: None,
                    item: None,
                    base_rev: 0,
                },
                5,
            )
            .unwrap()
            .1;
        assert_eq!(state_of(&out), Some((State::Idle, None)));
        assert_eq!(l.item, next);
    }

    #[test]
    fn host_leaving_hands_over_to_the_oldest_member() {
        let mut l = party();
        l.join(3, "carol", "d3", "c3", 0);
        l.leave(1, "d1", 10).unwrap();
        assert_eq!(l.host_id, 2);
        assert!(
            l.chat
                .iter()
                .any(|m| m.system.as_ref().is_some_and(|s| s.kind == "host_changed"))
        );
        l.join(2, "bob", "d2b", "c2b", 11);
        l.leave(2, "d2", 12).unwrap();
        assert_eq!(l.host_id, 2);
    }

    #[test]
    fn a_dropped_connection_goes_away_then_is_removed_and_the_host_moves() {
        let mut l = party();
        let out = l.tick(1000, |c| c != "c1");
        assert!(out.iter().any(|e| matches!(e, Effect::Members { .. })));
        assert_eq!(l.members[0].status, MemberStatus::Away);
        l.tick(1000 + AWAY_GRACE_MS - 1, |c| c != "c1");
        assert_eq!(l.members.len(), 2);
        l.tick(1000 + AWAY_GRACE_MS, |c| c != "c1");
        assert_eq!(l.members.len(), 1);
        assert_eq!(l.host_id, 2);
    }

    #[test]
    fn an_away_member_does_not_block_waiting_and_can_rejoin() {
        let mut l = party();
        l.tick(0, |c| c != "c2");
        play(&mut l, 1, "d1", 1);
        let out = ready(&mut l, 1, "d1", 0.0, 2);
        assert_eq!(state_of(&out).map(|s| s.0), Some(State::Playing));
        l.join(2, "bob", "d2", "c2x", 3);
        assert_eq!(l.members[1].status, MemberStatus::Ready);
        assert_eq!(l.members[1].connection_id, "c2x");
        assert_eq!(l.members.len(), 2);
    }

    #[test]
    fn an_empty_party_expires_after_the_ttl() {
        let mut l = party();
        assert!(
            l.tick(0, |_| false)
                .iter()
                .all(|e| !matches!(e, Effect::Closed { .. }))
        );
        let expired = |out: &[Effect]| {
            out.iter().any(|e| {
                matches!(
                    e,
                    Effect::Closed {
                        reason: CloseReason::Expired,
                        ..
                    }
                )
            })
        };
        assert!(!expired(&l.tick(EMPTY_TTL_MS - 1, |_| false)));
        assert!(expired(&l.tick(EMPTY_TTL_MS, |_| false)));
        let mut b = Live::boot("p".into(), Policy::Everyone, 1, item(), 12.0, 0);
        assert_eq!(
            (b.state, b.anchor.position, b.members.len()),
            (State::Paused, 12.0, 0)
        );
        assert!(!expired(&b.tick(EMPTY_TTL_MS - 1, |_| true)));
        assert!(expired(&b.tick(EMPTY_TTL_MS, |_| true)));
    }

    #[test]
    fn kick_removes_every_device_and_blocks_the_user() {
        let mut l = party();
        l.join(2, "bob", "d2b", "c2b", 0);
        let out = l.kick(2, "alice", 5).unwrap();
        assert!(
            matches!(&out[0], Effect::Closed { reason: CloseReason::Kicked, to } if to.len() == 2)
        );
        assert!(!l.has_user(2));
        assert_eq!(l.blocked, vec![2]);
        assert_eq!(l.kick(1, "alice", 6).unwrap_err(), Error::Invalid("host"));
    }

    #[test]
    fn chat_and_reactions_are_rate_limited_per_member() {
        let mut l = party();
        for i in 0..5 {
            l.post_message(1, "d1", "hi", i).unwrap();
        }
        assert_eq!(
            l.post_message(1, "d1", "hi", 5).unwrap_err(),
            Error::RateLimited
        );
        assert!(l.post_message(2, "d2", "hi", 5).is_ok());
        assert!(l.post_message(1, "d1", "hi", RATE_WINDOW_MS).is_ok());
        for i in 0..10 {
            l.react(1, "d1", "🔥", i).unwrap();
        }
        assert_eq!(l.react(1, "d1", "🔥", 10).unwrap_err(), Error::RateLimited);
    }

    fn voice(l: &mut Live, user: i32, dev: &str, joined: bool) -> Result<Vec<Effect>, Error> {
        l.set_voice(user, dev, joined, false, 0)
    }

    #[test]
    fn voice_join_and_leave_bump_rev_and_write_a_system_message() {
        let mut l = party();
        let rev = l.rev;
        let out = voice(&mut l, 2, "d2", true).unwrap();
        assert_eq!(l.rev, rev + 1);
        assert_eq!(l.members[1].voice, Some(Voice { muted: false }));
        assert!(out.iter().any(|e| matches!(e, Effect::Message(m)
            if m.system.as_ref().is_some_and(|s| s.kind == "voice_joined"))));
        let out = l.set_voice(2, "d2", true, true, 1).unwrap();
        assert_eq!(l.members[1].voice, Some(Voice { muted: true }));
        assert!(!out.iter().any(|e| matches!(e, Effect::Message(_))));
        let out = voice(&mut l, 2, "d2", false).unwrap();
        assert_eq!(l.members[1].voice, None);
        assert!(out.iter().any(|e| matches!(e, Effect::Message(m)
            if m.system.as_ref().is_some_and(|s| s.kind == "voice_left"))));
        assert_eq!(voice(&mut l, 3, "d3", true), Err(Error::NotMember));
    }

    #[test]
    fn the_ninth_voice_member_is_refused_but_a_mute_change_is_not() {
        let mut l = Live::new("p".into(), Policy::Everyone, 1, item(), 0.0, 0);
        for i in 0..=VOICE_MAX as i32 {
            l.join(i, "u", "d", &format!("c{i}"), 0);
        }
        for i in 0..VOICE_MAX as i32 {
            voice(&mut l, i, "d", true).unwrap();
        }
        assert_eq!(
            voice(&mut l, VOICE_MAX as i32, "d", true),
            Err(Error::VoiceFull)
        );
        l.set_voice(0, "d", true, true, 0).unwrap();
        voice(&mut l, 0, "d", false).unwrap();
        voice(&mut l, VOICE_MAX as i32, "d", true).unwrap();
    }

    #[test]
    fn voice_is_cleared_by_leave_kick_and_removal_and_kept_while_away() {
        let mut l = party();
        voice(&mut l, 1, "d1", true).unwrap();
        voice(&mut l, 2, "d2", true).unwrap();
        l.tick(1, |c| c != "c2");
        assert_eq!(l.members[1].status, MemberStatus::Away);
        assert!(l.members[1].voice.is_some());
        l.join(2, "bob", "d2", "c2b", 2);
        assert!(l.members[1].voice.is_some());
        l.kick(2, "alice", 3).unwrap();
        l.join(2, "bob", "d2", "c2", 4);
        assert_eq!(l.members[1].voice, None);
        voice(&mut l, 2, "d2", true).unwrap();
        l.leave(2, "d2", 5).unwrap();
        l.join(2, "bob", "d2", "c2", 6);
        assert_eq!(l.members[1].voice, None);
        voice(&mut l, 2, "d2", true).unwrap();
        l.tick(7, |c| c != "c2");
        l.tick(7 + AWAY_GRACE_MS, |c| c != "c2");
        assert_eq!(l.members.len(), 1);
    }

    #[test]
    fn signals_need_voice_on_both_sides_and_are_rate_limited() {
        let mut l = party();
        assert_eq!(
            l.signal_target(1, "d1", "d2", 0),
            Err(Error::VoiceNotJoined)
        );
        voice(&mut l, 1, "d1", true).unwrap();
        assert_eq!(
            l.signal_target(1, "d1", "d2", 0),
            Err(Error::VoiceNotJoined)
        );
        voice(&mut l, 2, "d2", true).unwrap();
        assert_eq!(l.signal_target(1, "d1", "d2", 0), Ok((2, "c2".into())));
        assert_eq!(
            l.signal_target(1, "d1", "nope", 0),
            Err(Error::VoiceNotJoined)
        );
        let rev = l.rev;
        for _ in 1..MAX_SIGNALS {
            l.signal_target(1, "d1", "d2", 1).unwrap();
        }
        assert_eq!(l.signal_target(1, "d1", "d2", 2), Err(Error::RateLimited));
        assert!(l.signal_target(1, "d1", "d2", RATE_WINDOW_MS + 1).is_ok());
        assert_eq!(l.rev, rev);
    }

    #[test]
    fn every_mutation_bumps_rev_and_chat_is_a_ring() {
        let mut l = party();
        let r = l.rev;
        l.set_settings(Some("n".into()), Some(Policy::HostOnly));
        assert_eq!(l.rev, r + 1);
        for i in 0..250 {
            l.post_message(1, "d1", "m", i * RATE_WINDOW_MS).unwrap();
        }
        assert_eq!(l.chat.len(), CHAT_CAP);
        assert_eq!(l.recent_messages().len(), SNAPSHOT_MESSAGES);
    }
}

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

impl Policy {
    /// The `watch_parties.policy` column value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Everyone => "everyone",
            Self::HostOnly => "host_only",
        }
    }
}

impl TryFrom<String> for Policy {
    type Error = String;

    fn try_from(s: String) -> Result<Self, String> {
        match s.as_str() {
            "everyone" => Ok(Self::Everyone),
            "host_only" => Ok(Self::HostOnly),
            _ => Err(format!("unknown party policy `{s}`")),
        }
    }
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

/// The queue rows to try, nearest first, after (before) `current`. A current item that left the
/// queue counts as sitting before the first row: forward starts at the top, backward has none.
pub fn candidates(queue: &[Item], current: &Item, forward: bool) -> Vec<Item> {
    let at = queue.iter().position(|i| same_row(i, current));
    match (at, forward) {
        (Some(i), true) => queue[i + 1..].to_vec(),
        (Some(i), false) => queue[..i].iter().rev().cloned().collect(),
        (None, true) => queue.to_vec(),
        (None, false) => vec![],
    }
}

fn same_row(a: &Item, b: &Item) -> bool {
    a.media_id == b.media_id && a.episode_id == b.episode_id
}

/// The server's pick for a queue step: the titles passed over and the row that plays (`None`:
/// nothing playable is left in that direction).
pub struct Step {
    pub forward: bool,
    pub skipped: Vec<String>,
    pub next: Option<(Item, String)>,
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
        reactions_enabled: bool,
        chat_enabled: bool,
        link_sharing: bool,
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
    /// The film the start will play changed.
    Selection {
        rev: u64,
        item: Item,
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
    ReactionsOff,
    ChatOff,
    Stale,
    Invalid(&'static str),
    RateLimited,
    VoiceFull,
    VoiceNotJoined,
    /// A start with no film chosen.
    NoItem,
    /// A playback intent before the start.
    NotStarted,
}

/// A client intent (`play|pause|seek|setItem|ended`) with the revision it was made on;
/// `item_title` labels a `setItem` in its system message; an `ended` names `item`, the one it ended.
pub struct Intent {
    pub action: Action,
    pub position: Option<f64>,
    pub item: Option<Item>,
    pub item_title: Option<String>,
    pub base_rev: u64,
}

#[derive(Debug, Clone)]
struct Phase {
    target_playing: bool,
    since: i64,
    by: Option<By>,
    action: &'static str,
}

/// Who is in the party and how it is set up, whether or not a film plays.
pub struct Room {
    pub name: String,
    pub policy: Policy,
    /// Host switches for the whole party: reactions and chat messages are refused while off.
    pub reactions_enabled: bool,
    pub chat_enabled: bool,
    /// Whether members, not only the host, receive the invite token.
    pub link_sharing: bool,
    pub host_id: i32,
    /// The film the start plays, set by the host before it.
    pub selection: Option<Item>,
    pub rev: u64,
    pub members: Vec<Member>,
    pub chat: VecDeque<Message>,
    empty_since: Option<i64>,
    next_msg: u64,
    next_join: u64,
    limits: HashMap<(i32, String, Limit), VecDeque<i64>>,
}

/// What plays: one item, its state and its anchor.
pub struct Playback {
    pub item: Item,
    pub state: State,
    pub anchor: Anchor,
    phase: Option<Phase>,
}

/// A party: its room, and the playback once the host has started it.
pub struct Live {
    pub room: Room,
    pub playback: Option<Playback>,
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

impl Room {
    /// `rev` and message ids start at `now` so a recreated room never reuses what a client holds.
    fn new(name: String, policy: Policy, host_id: i32, now: i64) -> Self {
        Self {
            name,
            policy,
            reactions_enabled: true,
            chat_enabled: true,
            link_sharing: true,
            host_id,
            selection: None,
            rev: now.max(1) as u64,
            members: vec![],
            chat: VecDeque::new(),
            empty_since: Some(now),
            next_msg: now.max(1) as u64,
            next_join: 0,
            limits: HashMap::new(),
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

    /// The party reopens its countdown when it goes live with the room possibly long empty.
    pub fn reset_empty(&mut self, now: i64) {
        self.empty_since =
            (!self.members.iter().any(|m| m.status != MemberStatus::Away)).then_some(now);
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

    fn all_ready(&self) -> bool {
        self.members
            .iter()
            .filter(|m| m.status != MemberStatus::Away)
            .all(|m| m.status == MemberStatus::Ready)
    }

    /// Moves the host role to the oldest present member when the host has no member left; returns
    /// the new host's username.
    fn hand_over(&mut self) -> Option<String> {
        if self.has_user(self.host_id) {
            return None;
        }
        let next = self
            .members
            .iter()
            .min_by_key(|m| (m.status == MemberStatus::Away, m.joined))?;
        let (id, username) = (next.user_id, next.username.clone());
        self.host_id = id;
        Some(username)
    }

    fn announce_host(&mut self, out: &mut Vec<Effect>, username: Option<String>, now: i64) {
        if let Some(username) = username {
            self.sys(
                out,
                "host_changed",
                None,
                json!({ "username": username }),
                now,
            );
        }
    }

    /// Drops the rate counters of members who left, keeping a window still running so a rejoin
    /// cannot reset it.
    fn prune_limits(&mut self, now: i64) {
        let members = &self.members;
        self.limits.retain(|(user, device, _), q| {
            members
                .iter()
                .any(|m| m.user_id == *user && m.device_id == *device)
                || q.back().is_some_and(|t| now - t < RATE_WINDOW_MS)
        });
    }

    /// A rejoin of the same `(user, device)` replaces the connection and resets the status;
    /// `waiting` starts a new member not ready.
    fn join(
        &mut self,
        (user_id, username, device_id, connection_id): (i32, &str, &str, &str),
        waiting: bool,
        now: i64,
    ) -> Vec<Effect> {
        let mut out = vec![];
        let status = if waiting {
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

    /// Fixes the film the start will play; the host's choice, announced to the room.
    pub fn select(&mut self, item: Item) -> Vec<Effect> {
        self.selection = Some(item.clone());
        let rev = self.bump();
        vec![Effect::Selection { rev, item }]
    }

    pub fn set_settings(
        &mut self,
        name: Option<String>,
        policy: Option<Policy>,
        reactions_enabled: Option<bool>,
        chat_enabled: Option<bool>,
        link_sharing: Option<bool>,
    ) -> Vec<Effect> {
        if let Some(n) = name {
            self.name = n;
        }
        if let Some(p) = policy {
            self.policy = p;
        }
        self.reactions_enabled = reactions_enabled.unwrap_or(self.reactions_enabled);
        self.chat_enabled = chat_enabled.unwrap_or(self.chat_enabled);
        self.link_sharing = link_sharing.unwrap_or(self.link_sharing);
        let rev = self.bump();
        vec![Effect::Settings {
            rev,
            name: self.name.clone(),
            policy: self.policy,
            reactions_enabled: self.reactions_enabled,
            chat_enabled: self.chat_enabled,
            link_sharing: self.link_sharing,
        }]
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
        let count = self
            .members
            .iter()
            .filter(|m| m.voice.is_some() && m.status != MemberStatus::Away)
            .count();
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
        if !self.chat_enabled {
            return Err(Error::ChatOff);
        }
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
        if !self.reactions_enabled {
            return Err(Error::ReactionsOff);
        }
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

impl Playback {
    /// Idle on `item` at `position`.
    pub fn new(item: Item, position: f64, now: i64) -> Self {
        Self {
            item,
            state: State::Idle,
            anchor: Anchor {
                position,
                server_time_ms: now,
            },
            phase: None,
        }
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

    fn state_effect(
        &mut self,
        room: &mut Room,
        out: &mut Vec<Effect>,
        now: i64,
        when_ms: Option<i64>,
        by: Option<By>,
        action: Option<&'static str>,
    ) {
        let rev = room.bump();
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

    #[allow(clippy::too_many_arguments)]
    fn enter_waiting(
        &mut self,
        room: &mut Room,
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
        for m in &mut room.members {
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
        self.state_effect(room, out, now, None, by, Some(action.wire()));
    }

    /// Rule 3. Members still not ready are left as they are and catch up alone.
    fn complete(&mut self, room: &mut Room, out: &mut Vec<Effect>, now: i64) {
        let Some(phase) = self.phase.take() else {
            return;
        };
        let position = self.anchor.position;
        let when = if phase.target_playing {
            let rtt = room.members.iter().map(|m| m.rtt_ms).max().unwrap_or(0);
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
        self.state_effect(room, out, now, when, phase.by, Some(phase.action));
    }

    fn settle(&mut self, room: &mut Room, out: &mut Vec<Effect>, now: i64) {
        if self.state == State::Waiting && room.all_ready() {
            self.complete(room, out, now);
        }
    }

    fn intent(
        &mut self,
        room: &mut Room,
        user_id: i32,
        device_id: &str,
        req: Intent,
        now: i64,
    ) -> Result<(u64, Vec<Effect>), Error> {
        let Intent {
            action,
            position,
            item,
            item_title,
            base_rev,
        } = req;
        let i = room.find(user_id, device_id).ok_or(Error::NotMember)?;
        let actor = room.members[i].clone();
        let host = user_id == room.host_id;
        let mut out = vec![];
        if action == Action::Ended {
            if self.can_end(room, user_id, device_id, item.as_ref()) {
                self.idle(room, &mut out, now, &actor);
            }
            return Ok((room.rev, out));
        }
        if room.policy == Policy::HostOnly && !host {
            return Err(Error::HostOnly);
        }
        let moves = matches!(action, Action::Seek | Action::SetItem);
        if moves && base_rev < room.rev {
            return Err(Error::Stale);
        }
        let playing_ctx = self.state == State::Playing;
        let name = actor.username.clone();
        match action {
            Action::Play => {
                if matches!(self.state, State::Idle | State::Paused) {
                    let p = self.anchor.position;
                    self.enter_waiting(room, &mut out, p, true, &actor, action, now);
                    room.sys(
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
                    self.state_effect(
                        room,
                        &mut out,
                        now,
                        None,
                        Some(by_of(&actor)),
                        Some("pause"),
                    );
                    room.sys(
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
                    room.sys(&mut out, "paused", Some(&name), json!({}), now);
                }
                _ => {}
            },
            Action::Seek => {
                let p = position
                    .filter(|p| p.is_finite() && *p >= 0.0)
                    .ok_or(Error::Invalid("position"))?;
                self.enter_waiting(room, &mut out, p, playing_ctx, &actor, action, now);
                room.sys(
                    &mut out,
                    "seeked",
                    Some(&name),
                    json!({ "position": p }),
                    now,
                );
            }
            Action::SetItem => {
                let it = item.ok_or(Error::Invalid("item"))?;
                self.change_item(room, &mut out, &actor, it, item_title, now);
            }
            Action::Ended => {}
        }
        Ok((room.rev, out))
    }

    /// `setItem` once its gates passed: the item changes, everyone waits at 0.
    fn change_item(
        &mut self,
        room: &mut Room,
        out: &mut Vec<Effect>,
        actor: &Member,
        item: Item,
        title: Option<String>,
        now: i64,
    ) {
        let playing = self.state == State::Playing;
        self.item = item;
        self.enter_waiting(room, out, 0.0, playing, actor, Action::SetItem, now);
        room.sys(
            out,
            "item_changed",
            Some(&actor.username),
            json!({ "title": title }),
            now,
        );
    }

    fn idle(&mut self, room: &mut Room, out: &mut Vec<Effect>, now: i64, by: &Member) {
        self.anchor = Anchor {
            position: self.position_at(now),
            server_time_ms: now,
        };
        self.state = State::Idle;
        self.phase = None;
        self.state_effect(room, out, now, None, Some(by_of(by)), Some("ended"));
    }

    fn can_end(&self, room: &Room, user_id: i32, device_id: &str, item: Option<&Item>) -> bool {
        let host_away = !room
            .members
            .iter()
            .any(|m| m.user_id == room.host_id && m.status != MemberStatus::Away);
        room.find(user_id, device_id).is_some()
            && matches!(self.state, State::Playing | State::Paused)
            && item.is_none_or(|i| same_row(i, &self.item))
            && (user_id == room.host_id || (item.is_some() && host_away))
    }

    fn walk(
        &mut self,
        room: &mut Room,
        out: &mut Vec<Effect>,
        actor: &Member,
        step: Step,
        ended: bool,
        now: i64,
    ) {
        let Some((item, title)) = step.next else {
            if !step.forward || (self.state == State::Idle && !ended) {
                return;
            }
            Self::skipped(room, out, &step.skipped, now);
            if self.state != State::Idle {
                self.idle(room, out, now, actor);
            }
            room.sys(out, "queue_ended", None, json!({}), now);
            return;
        };
        Self::skipped(room, out, &step.skipped, now);
        self.change_item(room, out, actor, item, Some(title), now);
    }

    fn skipped(room: &mut Room, out: &mut Vec<Effect>, titles: &[String], now: i64) {
        for title in titles {
            room.sys(out, "item_skipped", None, json!({ "title": title }), now);
        }
    }
}

impl Live {
    /// A party that has just opened: a room with the host and, maybe, a film already chosen.
    /// Nothing plays until `go_live`.
    pub fn new(
        name: String,
        policy: Policy,
        host_id: i32,
        selection: Option<Item>,
        now: i64,
    ) -> Self {
        let mut room = Room::new(name, policy, host_id, now);
        room.selection = selection;
        Self {
            room,
            playback: None,
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
        let mut l = Self::new(name, policy, host_id, None, now);
        let mut pb = Playback::new(item, position, now);
        pb.state = State::Paused;
        l.playback = Some(pb);
        l
    }

    pub fn position_at(&self, now: i64) -> f64 {
        self.playback.as_ref().map_or(0.0, |p| p.position_at(now))
    }

    /// Whether an `ended` takes effect: the party plays or is paused on `item` (any item when the
    /// client sent none) and the sender is the host, or any member naming `item` while the host is away.
    pub fn can_end(&self, user_id: i32, device_id: &str, item: Option<&Item>) -> bool {
        self.playback
            .as_ref()
            .is_some_and(|p| p.can_end(&self.room, user_id, device_id, item))
    }

    /// `POST /start`: plays `item`, the row's chosen film. Every member, invited or not, gets the
    /// new state; with the host in, it plays once everyone has loaded.
    pub fn go_live(&mut self, item: Item, now: i64) -> Vec<Effect> {
        self.room.selection = None;
        let mut pb = Playback::new(item, 0.0, now);
        let room = &mut self.room;
        room.reset_empty(now);
        let host = room
            .members
            .iter()
            .find(|m| m.user_id == room.host_id && m.status != MemberStatus::Away)
            .cloned();
        let mut out = Vec::new();
        match host {
            Some(h) => pb.enter_waiting(room, &mut out, 0.0, true, &h, Action::Play, now),
            None => pb.state_effect(room, &mut out, now, None, None, None),
        }
        self.playback = Some(pb);
        out
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
        let waiting = self
            .playback
            .as_ref()
            .is_none_or(|p| p.state == State::Waiting);
        self.room
            .join((user_id, username, device_id, connection_id), waiting, now)
    }

    fn settle(&mut self, out: &mut Vec<Effect>, now: i64) {
        if let Some(p) = &mut self.playback {
            p.settle(&mut self.room, out, now);
        }
    }

    pub fn leave(&mut self, user_id: i32, device_id: &str, now: i64) -> Result<Vec<Effect>, Error> {
        let room = &mut self.room;
        let i = room.find(user_id, device_id).ok_or(Error::NotMember)?;
        let m = room.members.remove(i);
        room.prune_limits(now);
        let host = room.hand_over();
        let mut out = vec![];
        room.members_effect(&mut out);
        room.sys(&mut out, "left", Some(&m.username), json!({}), now);
        room.announce_host(&mut out, host, now);
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
        let pb = self.playback.as_mut().ok_or(Error::NotStarted)?;
        pb.intent(&mut self.room, user_id, device_id, req, now)
    }

    /// A queue step chosen by the server: one `item_skipped` message per passed-over title, then
    /// `step.next` as a `setItem` would (`None`: nothing playable is left). The gates of `setItem`
    /// run first, so a refused call leaves no message behind. Only a forward step that finds
    /// nothing idles the party and appends `queue_ended`, once; a backward one, or a forward one on
    /// an already idle party, changes nothing.
    pub fn advance(
        &mut self,
        user_id: i32,
        device_id: &str,
        base_rev: u64,
        step: Step,
        now: i64,
    ) -> Result<(u64, Vec<Effect>), Error> {
        let pb = self.playback.as_mut().ok_or(Error::NotStarted)?;
        let room = &mut self.room;
        let i = room.find(user_id, device_id).ok_or(Error::NotMember)?;
        let actor = room.members[i].clone();
        if room.policy == Policy::HostOnly && user_id != room.host_id {
            return Err(Error::HostOnly);
        }
        if base_rev < room.rev {
            return Err(Error::Stale);
        }
        let mut out = vec![];
        pb.walk(room, &mut out, &actor, step, false, now);
        Ok((room.rev, out))
    }

    /// A host `ended` (or a member's while the host is away) that moves the queue on, in one step
    /// under one lock. Nothing happens unless the party is still on `from`, the item `step` was
    /// computed for.
    pub fn advance_after_ended(
        &mut self,
        user_id: i32,
        device_id: &str,
        item: Option<&Item>,
        from: &Item,
        step: Step,
        now: i64,
    ) -> Result<(u64, Vec<Effect>), Error> {
        let pb = self.playback.as_mut().ok_or(Error::NotStarted)?;
        let room = &mut self.room;
        let i = room.find(user_id, device_id).ok_or(Error::NotMember)?;
        let actor = room.members[i].clone();
        let mut out = vec![];
        if pb.can_end(room, user_id, device_id, item) && same_row(from, &pb.item) {
            pb.idle(room, &mut out, now, &actor);
            pb.walk(room, &mut out, &actor, step, true, now);
        }
        Ok((room.rev, out))
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
        let room = &mut self.room;
        let i = room.find(user_id, device_id).ok_or(Error::NotMember)?;
        let waiting = self
            .playback
            .as_ref()
            .filter(|p| p.state == State::Waiting)
            .map(|p| p.anchor.position);
        let near = waiting.is_none_or(|a| (position - a).abs() <= READY_TOLERANCE_S);
        let m = &mut room.members[i];
        m.last_seen_ms = now;
        if let Some(r) = rtt_ms {
            m.rtt_ms = r.max(0);
        }
        let new = match status {
            MemberStatus::Ready if waiting.is_some() && !near => m.status,
            MemberStatus::Ready | MemberStatus::Buffering | MemberStatus::Waiting => status,
            MemberStatus::Away => return Err(Error::Invalid("status")),
        };
        let mut out = vec![];
        if new != m.status {
            m.status = new;
            m.away_since = None;
            room.members_effect(&mut out);
        }
        self.settle(&mut out, now);
        Ok(out)
    }

    /// Rules 3, 9: the 1 s tick. `alive` says whether a connection id is still open.
    pub fn tick(&mut self, now: i64, alive: impl Fn(&str) -> bool) -> Vec<Effect> {
        let room = &mut self.room;
        let mut out = vec![];
        let mut changed = false;
        for m in &mut room.members {
            if m.status != MemberStatus::Away && !alive(&m.connection_id) {
                m.status = MemberStatus::Away;
                m.away_since = Some(now);
                changed = true;
            }
        }
        let gone: Vec<Member> = room
            .members
            .iter()
            .filter(|m| m.away_since.is_some_and(|s| now - s >= AWAY_GRACE_MS))
            .cloned()
            .collect();
        room.members.retain(|m| !gone.contains(m));
        room.prune_limits(now);
        let host = room.hand_over();
        if changed || !gone.is_empty() {
            room.members_effect(&mut out);
        }
        for m in &gone {
            room.sys(&mut out, "left", Some(&m.username), json!({}), now);
        }
        room.announce_host(&mut out, host, now);
        if let Some(pb) = &mut self.playback
            && pb.state == State::Waiting
            && (room.all_ready()
                || pb
                    .phase
                    .as_ref()
                    .is_some_and(|p| now - p.since >= WAIT_TIMEOUT_MS))
        {
            pb.complete(room, &mut out, now);
        }
        if room.members.iter().any(|m| m.status != MemberStatus::Away) {
            room.empty_since = None;
        } else if now - *room.empty_since.get_or_insert(now) >= EMPTY_TTL_MS {
            out.push(Effect::Closed {
                reason: CloseReason::Expired,
                to: vec![],
            });
        }
        out
    }

    /// Removes every member of the user; the caller records the kick so the token stops working.
    pub fn kick(&mut self, user_id: i32, by: &str, now: i64) -> Result<Vec<Effect>, Error> {
        let room = &mut self.room;
        if user_id == room.host_id {
            return Err(Error::Invalid("host"));
        }
        let (gone, keep): (Vec<_>, Vec<_>) =
            room.members.drain(..).partition(|m| m.user_id == user_id);
        room.members = keep;
        let first = gone.first().ok_or(Error::NotMember)?;
        let username = first.username.clone();
        room.prune_limits(now);
        let mut out = vec![Effect::Closed {
            reason: CloseReason::Kicked,
            to: gone
                .iter()
                .map(|m| (m.user_id, m.connection_id.clone()))
                .collect(),
        }];
        room.members_effect(&mut out);
        room.sys(
            &mut out,
            "kicked",
            Some(by),
            json!({ "username": username }),
            now,
        );
        self.settle(&mut out, now);
        Ok(out)
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

    fn started(now: i64) -> Live {
        let mut l = Live::new("p".into(), Policy::Everyone, 1, None, now);
        l.playback = Some(Playback::new(item(), 0.0, now));
        l
    }

    impl Live {
        fn pb(&self) -> &Playback {
            self.playback.as_ref().unwrap()
        }

        fn pb_mut(&mut self) -> &mut Playback {
            self.playback.as_mut().unwrap()
        }
    }

    /// Host 1 and member 2, both ready, party idle.
    fn party() -> Live {
        let mut l = started(0);
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
                item_title: None,
                base_rev: l.room.rev,
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
        assert!(
            l.room
                .members
                .iter()
                .all(|m| m.status == MemberStatus::Waiting)
        );
        assert!(
            ready(&mut l, 1, "d1", 0.0, 1100)
                .iter()
                .all(|e| state_of(std::slice::from_ref(e)).is_none())
        );
        l.room.members[1].rtt_ms = 400;
        let out = ready(&mut l, 2, "d2", 0.5, 1200);
        assert_eq!(state_of(&out), Some((State::Playing, Some(2000))));
        assert_eq!(
            l.pb().anchor,
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
        assert_eq!(l.room.members[1].status, MemberStatus::Waiting);
        assert!(state_of(&l.tick(9_999, |_| true)).is_none());
        let out = l.tick(10_000, |_| true);
        assert_eq!(state_of(&out), Some((State::Playing, Some(10_500))));
        assert_eq!(l.room.members[1].status, MemberStatus::Waiting);
    }

    #[test]
    fn seek_while_paused_ends_paused_and_while_playing_ends_playing() {
        let mut l = party();
        l.pb_mut().state = State::Paused;
        l.intent(
            1,
            "d1",
            Intent {
                action: Action::Seek,
                position: Some(50.0),
                item: None,
                item_title: None,
                base_rev: l.room.rev,
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
        assert_eq!(l.pb().state, State::Playing);
        l.intent(
            2,
            "d2",
            Intent {
                action: Action::Seek,
                position: Some(80.0),
                item: None,
                item_title: None,
                base_rev: l.room.rev,
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
                item_title: None,
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
        assert_eq!(l.pb().state, State::Playing);
        let start = l.pb().anchor.server_time_ms;
        let out = l
            .intent(
                1,
                "d1",
                Intent {
                    action: Action::Pause,
                    position: None,
                    item: None,
                    item_title: None,
                    base_rev: 0,
                },
                start + 4000,
            )
            .unwrap()
            .1;
        assert_eq!(state_of(&out), Some((State::Paused, None)));
        assert_eq!(l.pb().anchor.position, 4.0);
    }

    #[test]
    fn buffering_never_pauses_the_group_and_a_late_member_never_waits() {
        let mut l = party();
        play(&mut l, 1, "d1", 0);
        ready(&mut l, 1, "d1", 0.0, 1);
        ready(&mut l, 2, "d2", 0.0, 2);
        let rev = l.room.rev;
        l.status(2, "d2", MemberStatus::Buffering, 3.0, None, 3000)
            .unwrap();
        assert_eq!(l.pb().state, State::Playing);
        assert_eq!(l.room.members[1].status, MemberStatus::Buffering);
        assert!(l.room.rev > rev);
        let out = l.join(3, "carol", "d3", "c3", 4000);
        assert!(state_of(&out).is_none());
        assert_eq!(l.pb().state, State::Playing);
        assert_eq!(l.room.members[2].status, MemberStatus::Ready);
    }

    #[test]
    fn lobby_members_start_waiting_and_toggle_ready() {
        let mut l = Live::new("p".into(), Policy::Everyone, 1, Some(item()), 0);
        l.join(2, "bob", "d2", "c2", 0);
        assert_eq!(l.room.members[0].status, MemberStatus::Waiting);
        let out = ready(&mut l, 2, "d2", 0.0, 1);
        assert!(out.iter().any(|e| matches!(e, Effect::Members { .. })));
        assert_eq!(l.room.members[0].status, MemberStatus::Ready);
        l.status(2, "d2", MemberStatus::Waiting, 0.0, None, 2)
            .unwrap();
        assert_eq!(l.room.members[0].status, MemberStatus::Waiting);
        assert!(l.playback.is_none());
        let out = l.go_live(item(), 3);
        assert!(out.iter().any(|e| matches!(e, Effect::State { .. })));
        assert_eq!(l.pb().state, State::Idle);
        assert_eq!(l.pb().item, item());
        assert_eq!(l.room.selection, None);
    }

    #[test]
    fn a_room_without_playback_refuses_playback_intents_and_a_selection_is_announced() {
        let mut l = Live::new("p".into(), Policy::Everyone, 1, None, 0);
        l.join(1, "alice", "d1", "c1", 0);
        let intent = Intent {
            action: Action::Play,
            position: None,
            item: None,
            item_title: None,
            base_rev: 0,
        };
        assert_eq!(l.intent(1, "d1", intent, 1).err(), Some(Error::NotStarted));
        assert!(l.playback.is_none());
        let out = l.room.select(item());
        assert!(matches!(&out[..], [Effect::Selection { .. }]));
        l.go_live(item(), 3);
        assert_eq!(l.pb().state, State::Waiting);
    }

    #[test]
    fn go_live_with_the_host_in_plays_once_everyone_is_ready() {
        let mut l = Live::new("p".into(), Policy::Everyone, 1, Some(item()), 0);
        l.join(1, "alice", "d1", "c1", 0);
        l.join(2, "bob", "d2", "c2", 0);
        l.go_live(item(), 1);
        assert_eq!(l.pb().state, State::Waiting);
        ready(&mut l, 1, "d1", 0.0, 2);
        assert_eq!(l.pb().state, State::Waiting);
        let out = ready(&mut l, 2, "d2", 0.0, 3);
        assert_eq!(state_of(&out).map(|s| s.0), Some(State::Playing));
    }

    #[test]
    fn host_only_blocks_non_host_moves_but_not_status() {
        let mut l = party();
        l.room.policy = Policy::HostOnly;
        for a in [Action::Play, Action::Pause, Action::Seek, Action::SetItem] {
            let r = l.intent(
                2,
                "d2",
                Intent {
                    action: a,
                    position: Some(1.0),
                    item: Some(item()),
                    item_title: None,
                    base_rev: l.room.rev,
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
                    item_title: None,
                    base_rev: l.room.rev
                },
                0
            )
            .is_ok()
        );
    }

    #[test]
    fn a_stale_seek_or_set_item_is_refused_but_play_pause_apply() {
        let mut l = party();
        let old = l.room.rev;
        play(&mut l, 1, "d1", 0);
        assert!(l.room.rev > old);
        let r = l.intent(
            2,
            "d2",
            Intent {
                action: Action::Seek,
                position: Some(9.0),
                item: None,
                item_title: None,
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
                item_title: None,
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
                    item_title: None,
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
                    item_title: None,
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
        l.pb_mut().state = State::Paused;
        l.pb_mut().anchor.position = 42.0;
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
                    item_title: None,
                    base_rev: l.room.rev,
                },
                0,
            )
            .unwrap()
            .1;
        assert_eq!(l.pb().item, next);
        assert_eq!(l.pb().anchor.position, 0.0);
        assert!(
            out.iter()
                .any(|e| matches!(e, Effect::Persist { position, .. } if *position == 0.0))
        );
        l.pb_mut().state = State::Playing;
        let before = l.room.rev;
        assert!(
            l.intent(
                2,
                "d2",
                Intent {
                    action: Action::Ended,
                    position: None,
                    item: None,
                    item_title: None,
                    base_rev: 0
                },
                5
            )
            .unwrap()
            .1
            .is_empty()
        );
        assert_eq!(l.room.rev, before);
        let out = l
            .intent(
                1,
                "d1",
                Intent {
                    action: Action::Ended,
                    position: None,
                    item: None,
                    item_title: None,
                    base_rev: 0,
                },
                5,
            )
            .unwrap()
            .1;
        assert_eq!(state_of(&out), Some((State::Idle, None)));
        assert_eq!(l.pb().item, next);
    }

    #[test]
    fn host_leaving_hands_over_to_the_oldest_member() {
        let mut l = party();
        l.join(3, "carol", "d3", "c3", 0);
        l.leave(1, "d1", 10).unwrap();
        assert_eq!(l.room.host_id, 2);
        assert!(
            l.room
                .chat
                .iter()
                .any(|m| m.system.as_ref().is_some_and(|s| s.kind == "host_changed"))
        );
        l.join(2, "bob", "d2b", "c2b", 11);
        l.leave(2, "d2", 12).unwrap();
        assert_eq!(l.room.host_id, 2);
    }

    #[test]
    fn a_dropped_connection_goes_away_then_is_removed_and_the_host_moves() {
        let mut l = party();
        let out = l.tick(1000, |c| c != "c1");
        assert!(out.iter().any(|e| matches!(e, Effect::Members { .. })));
        assert_eq!(l.room.members[0].status, MemberStatus::Away);
        l.tick(1000 + AWAY_GRACE_MS - 1, |c| c != "c1");
        assert_eq!(l.room.members.len(), 2);
        l.tick(1000 + AWAY_GRACE_MS, |c| c != "c1");
        assert_eq!(l.room.members.len(), 1);
        assert_eq!(l.room.host_id, 2);
    }

    #[test]
    fn an_away_member_does_not_block_waiting_and_can_rejoin() {
        let mut l = party();
        l.tick(0, |c| c != "c2");
        play(&mut l, 1, "d1", 1);
        let out = ready(&mut l, 1, "d1", 0.0, 2);
        assert_eq!(state_of(&out).map(|s| s.0), Some(State::Playing));
        l.join(2, "bob", "d2", "c2x", 3);
        assert_eq!(l.room.members[1].status, MemberStatus::Ready);
        assert_eq!(l.room.members[1].connection_id, "c2x");
        assert_eq!(l.room.members.len(), 2);
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
            (b.pb().state, b.pb().anchor.position, b.room.members.len()),
            (State::Paused, 12.0, 0)
        );
        assert!(!expired(&b.tick(EMPTY_TTL_MS - 1, |_| true)));
        assert!(expired(&b.tick(EMPTY_TTL_MS, |_| true)));
    }

    #[test]
    fn kick_removes_every_device_of_the_user() {
        let mut l = party();
        l.join(2, "bob", "d2b", "c2b", 0);
        let out = l.kick(2, "alice", 5).unwrap();
        assert!(
            matches!(&out[0], Effect::Closed { reason: CloseReason::Kicked, to } if to.len() == 2)
        );
        assert!(!l.room.has_user(2));
        assert_eq!(l.kick(1, "alice", 6).unwrap_err(), Error::Invalid("host"));
    }

    #[test]
    fn chat_and_reactions_are_rate_limited_per_member() {
        let mut l = party();
        for i in 0..5 {
            l.room.post_message(1, "d1", "hi", i).unwrap();
        }
        assert_eq!(
            l.room.post_message(1, "d1", "hi", 5).unwrap_err(),
            Error::RateLimited
        );
        assert!(l.room.post_message(2, "d2", "hi", 5).is_ok());
        assert!(l.room.post_message(1, "d1", "hi", RATE_WINDOW_MS).is_ok());
        for i in 0..10 {
            l.room.react(1, "d1", "🔥", i).unwrap();
        }
        assert_eq!(
            l.room.react(1, "d1", "🔥", 10).unwrap_err(),
            Error::RateLimited
        );
    }

    fn voice(l: &mut Live, user: i32, dev: &str, joined: bool) -> Result<Vec<Effect>, Error> {
        l.room.set_voice(user, dev, joined, false, 0)
    }

    #[test]
    fn voice_join_and_leave_bump_rev_and_write_a_system_message() {
        let mut l = party();
        let rev = l.room.rev;
        let out = voice(&mut l, 2, "d2", true).unwrap();
        assert_eq!(l.room.rev, rev + 1);
        assert_eq!(l.room.members[1].voice, Some(Voice { muted: false }));
        assert!(out.iter().any(|e| matches!(e, Effect::Message(m)
            if m.system.as_ref().is_some_and(|s| s.kind == "voice_joined"))));
        let out = l.room.set_voice(2, "d2", true, true, 1).unwrap();
        assert_eq!(l.room.members[1].voice, Some(Voice { muted: true }));
        assert!(!out.iter().any(|e| matches!(e, Effect::Message(_))));
        let out = voice(&mut l, 2, "d2", false).unwrap();
        assert_eq!(l.room.members[1].voice, None);
        assert!(out.iter().any(|e| matches!(e, Effect::Message(m)
            if m.system.as_ref().is_some_and(|s| s.kind == "voice_left"))));
        assert_eq!(voice(&mut l, 3, "d3", true), Err(Error::NotMember));
    }

    #[test]
    fn the_ninth_voice_member_is_refused_but_a_mute_change_is_not() {
        let mut l = started(0);
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
        l.room.set_voice(0, "d", true, true, 0).unwrap();
        voice(&mut l, 0, "d", false).unwrap();
        voice(&mut l, VOICE_MAX as i32, "d", true).unwrap();
    }

    #[test]
    fn voice_is_cleared_by_leave_kick_and_removal_and_kept_while_away() {
        let mut l = party();
        voice(&mut l, 1, "d1", true).unwrap();
        voice(&mut l, 2, "d2", true).unwrap();
        l.tick(1, |c| c != "c2");
        assert_eq!(l.room.members[1].status, MemberStatus::Away);
        assert!(l.room.members[1].voice.is_some());
        l.join(2, "bob", "d2", "c2b", 2);
        assert!(l.room.members[1].voice.is_some());
        l.kick(2, "alice", 3).unwrap();
        l.join(2, "bob", "d2", "c2", 4);
        assert_eq!(l.room.members[1].voice, None);
        voice(&mut l, 2, "d2", true).unwrap();
        l.leave(2, "d2", 5).unwrap();
        l.join(2, "bob", "d2", "c2", 6);
        assert_eq!(l.room.members[1].voice, None);
        voice(&mut l, 2, "d2", true).unwrap();
        l.tick(7, |c| c != "c2");
        l.tick(7 + AWAY_GRACE_MS, |c| c != "c2");
        assert_eq!(l.room.members.len(), 1);
    }

    #[test]
    fn signals_need_voice_on_both_sides_and_are_rate_limited() {
        let mut l = party();
        assert_eq!(
            l.room.signal_target(1, "d1", "d2", 0),
            Err(Error::VoiceNotJoined)
        );
        voice(&mut l, 1, "d1", true).unwrap();
        assert_eq!(
            l.room.signal_target(1, "d1", "d2", 0),
            Err(Error::VoiceNotJoined)
        );
        voice(&mut l, 2, "d2", true).unwrap();
        assert_eq!(l.room.signal_target(1, "d1", "d2", 0), Ok((2, "c2".into())));
        assert_eq!(
            l.room.signal_target(1, "d1", "nope", 0),
            Err(Error::VoiceNotJoined)
        );
        let rev = l.room.rev;
        for _ in 1..MAX_SIGNALS {
            l.room.signal_target(1, "d1", "d2", 1).unwrap();
        }
        assert_eq!(
            l.room.signal_target(1, "d1", "d2", 2),
            Err(Error::RateLimited)
        );
        assert!(
            l.room
                .signal_target(1, "d1", "d2", RATE_WINDOW_MS + 1)
                .is_ok()
        );
        assert_eq!(l.room.rev, rev);
    }

    #[test]
    fn every_mutation_bumps_rev_and_chat_is_a_ring() {
        let mut l = party();
        let r = l.room.rev;
        l.room
            .set_settings(Some("n".into()), Some(Policy::HostOnly), None, None, None);
        assert_eq!(l.room.rev, r + 1);
        for i in 0..250 {
            l.room
                .post_message(1, "d1", "m", i * RATE_WINDOW_MS)
                .unwrap();
        }
        assert_eq!(l.room.chat.len(), CHAT_CAP);
        assert_eq!(l.room.recent_messages().len(), SNAPSHOT_MESSAGES);
    }

    #[test]
    fn switched_off_chat_and_reactions_refuse_but_system_messages_flow() {
        let mut l = party();
        let r = l.room.rev;
        let e = l
            .room
            .set_settings(None, None, Some(false), Some(false), Some(false));
        assert!(matches!(
            e[0],
            Effect::Settings {
                reactions_enabled: false,
                chat_enabled: false,
                link_sharing: false,
                ..
            }
        ));
        assert_eq!(l.room.rev, r + 1);
        assert_eq!(l.room.react(1, "d1", "x", 0), Err(Error::ReactionsOff));
        assert_eq!(
            l.room.post_message(1, "d1", "m", 0).unwrap_err(),
            Error::ChatOff
        );
        let left = l.leave(2, "d2", 1).unwrap();
        assert!(left.iter().any(|e| matches!(e, Effect::Message(_))));
        l.room
            .set_settings(None, None, Some(true), Some(true), Some(true));
        assert!(l.room.react(1, "d1", "x", 0).is_ok());
        assert!(l.room.post_message(1, "d1", "m", 0).is_ok());
    }

    fn row(media: i32, episode: Option<i32>) -> Item {
        Item {
            media_id: media,
            media_file_id: None,
            episode_id: episode,
        }
    }

    #[test]
    fn candidates_follow_the_queue_order_from_the_current_row() {
        let q = [row(1, None), row(2, Some(7)), row(2, Some(8)), row(3, None)];
        assert_eq!(candidates(&q, &row(2, Some(7)), true), q[2..].to_vec());
        assert_eq!(
            candidates(&q, &row(2, Some(8)), false),
            vec![q[1].clone(), q[0].clone()]
        );
        assert!(candidates(&q, &row(3, None), true).is_empty());
        assert!(candidates(&q, &row(1, None), false).is_empty());
    }

    #[test]
    fn a_current_item_gone_from_the_queue_restarts_forward_and_stops_backward() {
        let q = [row(1, None), row(2, None)];
        assert_eq!(candidates(&q, &row(9, None), true), q.to_vec());
        assert!(candidates(&q, &row(9, None), false).is_empty());
    }

    #[test]
    fn set_item_names_the_new_item_in_its_system_message() {
        let mut l = party();
        let out = l
            .intent(
                1,
                "d1",
                Intent {
                    action: Action::SetItem,
                    position: None,
                    item: Some(row(2, Some(3))),
                    item_title: Some("Show S01E03".into()),
                    base_rev: l.room.rev,
                },
                0,
            )
            .unwrap()
            .1;
        let sys = out
            .iter()
            .find_map(|e| match e {
                Effect::Message(m) => m.system.clone(),
                _ => None,
            })
            .unwrap();
        assert_eq!(sys.kind, "item_changed");
        assert_eq!(sys.args, json!({ "title": "Show S01E03" }));
    }

    fn step(forward: bool, skipped: &[&str], next: Option<(Item, &str)>) -> Step {
        Step {
            forward,
            skipped: skipped.iter().map(|s| (*s).to_owned()).collect(),
            next: next.map(|(i, t)| (i, t.to_owned())),
        }
    }

    #[test]
    fn the_end_of_the_queue_idles_the_party_once() {
        let mut l = party();
        l.pb_mut().state = State::Playing;
        let rev = l.room.rev;
        let out = l
            .advance(1, "d1", rev, step(true, &["Show S01E02"], None), 5)
            .unwrap()
            .1;
        assert_eq!(l.pb().state, State::Idle);
        assert_eq!(state_of(&out).unwrap().0, State::Idle);
        assert_eq!(kinds(&out), ["item_skipped", "queue_ended"]);
        let (rev, chat) = (l.room.rev, l.room.chat.len());
        let out = l
            .advance(1, "d1", rev, step(true, &["Show S01E02"], None), 6)
            .unwrap()
            .1;
        assert!(out.is_empty());
        assert_eq!((l.room.rev, l.room.chat.len()), (rev, chat));
    }

    #[test]
    fn a_backward_step_with_nothing_found_changes_nothing() {
        let mut l = party();
        l.pb_mut().state = State::Playing;
        let (rev, chat) = (l.room.rev, l.room.chat.len());
        let out = l
            .advance(1, "d1", rev, step(false, &["Gap"], None), 5)
            .unwrap()
            .1;
        assert!(out.is_empty());
        assert_eq!(
            (l.pb().state, l.room.rev, l.room.chat.len()),
            (State::Playing, rev, chat)
        );
    }

    #[test]
    fn an_advance_skips_then_switches_and_a_refused_one_leaves_no_message() {
        let mut l = party();
        let rev = l.room.rev;
        let next = || step(true, &["Gap"], Some((row(3, None), "Film")));
        let out = l.advance(1, "d1", rev, next(), 0).unwrap().1;
        assert_eq!(kinds(&out), ["item_skipped", "item_changed"]);
        assert_eq!(l.pb().item, row(3, None));
        let chat = l.room.chat.len();
        assert_eq!(
            l.advance(1, "d1", rev, next(), 0).unwrap_err(),
            Error::Stale
        );
        l.room.policy = Policy::HostOnly;
        assert_eq!(
            l.advance(2, "d2", l.room.rev, step(true, &[], None), 0)
                .unwrap_err(),
            Error::HostOnly
        );
        assert_eq!(l.room.chat.len(), chat);
    }

    fn ended(l: &mut Live, user: i32, dev: &str, item: Option<Item>) -> Vec<Effect> {
        l.intent(
            user,
            dev,
            Intent {
                action: Action::Ended,
                position: None,
                item,
                item_title: None,
                base_rev: 0,
            },
            9,
        )
        .unwrap()
        .1
    }

    #[test]
    fn an_ended_counts_only_for_the_current_item_while_playing_or_paused() {
        let mut l = party();
        l.pb_mut().state = State::Playing;
        assert!(ended(&mut l, 1, "d1", Some(row(9, None))).is_empty());
        assert_eq!(l.pb().state, State::Playing);
        assert_eq!(
            state_of(&ended(&mut l, 1, "d1", Some(item()))).unwrap().0,
            State::Idle
        );
        // A second device's `ended` for the same item finds the party idle.
        assert!(ended(&mut l, 1, "d1", Some(item())).is_empty());
        l.pb_mut().state = State::Waiting;
        assert!(ended(&mut l, 1, "d1", None).is_empty());
    }

    #[test]
    fn a_member_ends_the_item_only_while_the_host_is_away_and_names_it() {
        let mut l = party();
        l.pb_mut().state = State::Playing;
        assert!(ended(&mut l, 2, "d2", Some(item())).is_empty());
        l.tick(0, |c| c != "c1");
        assert!(ended(&mut l, 2, "d2", None).is_empty());
        assert!(ended(&mut l, 2, "d2", Some(row(9, None))).is_empty());
        assert_eq!(l.pb().state, State::Playing);
        assert_eq!(
            state_of(&ended(&mut l, 2, "d2", Some(item()))).unwrap().0,
            State::Idle
        );
    }

    #[test]
    fn an_ended_advance_is_dropped_when_the_item_moved_on() {
        let mut l = party();
        l.pb_mut().state = State::Playing;
        let to = || step(true, &[], Some((row(3, None), "Film")));
        let out = l
            .advance_after_ended(1, "d1", None, &row(8, None), to(), 5)
            .unwrap()
            .1;
        assert!(out.is_empty());
        assert_eq!(
            (l.pb().state, l.pb().item.clone()),
            (State::Playing, item())
        );
        let out = l
            .advance_after_ended(1, "d1", Some(&item()), &item(), to(), 5)
            .unwrap()
            .1;
        assert_eq!(kinds(&out), ["item_changed"]);
        assert_eq!(l.pb().item, row(3, None));
        let out = l
            .advance_after_ended(1, "d1", Some(&item()), &item(), step(true, &[], None), 6)
            .unwrap()
            .1;
        assert!(out.is_empty());
    }

    #[test]
    fn the_end_of_the_queue_after_an_ended_says_so_once() {
        let mut l = party();
        l.pb_mut().state = State::Playing;
        let out = l
            .advance_after_ended(1, "d1", Some(&item()), &item(), step(true, &[], None), 5)
            .unwrap()
            .1;
        assert_eq!(state_of(&out).unwrap().0, State::Idle);
        assert_eq!(kinds(&out), ["queue_ended"]);
    }

    #[test]
    fn handover_is_decided_before_the_members_are_announced() {
        let mut l = party();
        let host_of = |out: &[Effect]| {
            out.iter().find_map(|e| match e {
                Effect::Members { host_id, .. } => Some(*host_id),
                _ => None,
            })
        };
        let out = l.leave(1, "d1", 5).unwrap();
        assert_eq!((l.room.host_id, host_of(&out)), (2, Some(2)));
        let mut l = party();
        l.tick(0, |c| c != "c1");
        let out = l.tick(AWAY_GRACE_MS, |c| c != "c1");
        assert_eq!((l.room.host_id, host_of(&out)), (2, Some(2)));
    }

    #[test]
    fn rev_and_message_ids_start_past_what_an_older_machine_issued() {
        let old = started(1_000);
        let mut new = started(5_000);
        assert!(new.room.rev > old.room.rev + 1_000);
        new.join(1, "alice", "d1", "c1", 5_000);
        assert!(new.room.chat[0].id >= 5_000);
    }

    #[test]
    fn away_members_do_not_fill_the_voice_channel() {
        let mut l = party();
        for u in 3..=9 {
            l.join(u, "x", "d", &format!("c{u}"), 0);
            voice(&mut l, u, "d", true).unwrap();
        }
        assert!(voice(&mut l, 1, "d1", true).is_ok());
        l.tick(0, |c| c != "c3");
        assert!(voice(&mut l, 2, "d2", true).is_ok());
    }

    #[test]
    fn a_left_member_keeps_a_running_rate_window_and_drops_a_finished_one() {
        let mut l = party();
        l.room.post_message(2, "d2", "m", 0).unwrap();
        l.leave(2, "d2", 1).unwrap();
        assert_eq!(l.room.limits.len(), 1);
        l.leave(1, "d1", RATE_WINDOW_MS + 1).unwrap();
        assert!(l.room.limits.is_empty());
    }

    fn kinds(out: &[Effect]) -> Vec<String> {
        out.iter()
            .filter_map(|e| match e {
                Effect::Message(m) => m.system.as_ref().map(|s| s.kind.clone()),
                _ => None,
            })
            .collect()
    }
}

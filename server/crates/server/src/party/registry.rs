//! The in-memory half of a party (`docs/spec/watch-party.md`): `Live` machines, effect delivery and
//! the 1 s tick that runs timeouts, away members, empty-party expiry and the scheduled lobby/expiry.
use super::{
    db::{self, Row},
    dto::{MemberDto, PartyItem, PlaybackDto, UserRef},
};
use crate::{events::SseEvent, http::AppError, images::upload, state::AppState, sync::MutexExt};
use chrono::{DateTime, Utc};
use fliks_domain::{
    js::now_ms,
    party::{
        CloseReason, EMPTY_TTL_MS, Effect, Item, LOBBY_OPEN_BEFORE_MS, Live, Member, Message,
        SCHEDULE_EXPIRY_MS,
    },
};
use serde_json::{Value, to_value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

/// `ensure_held` for a caller that does not hold the party's gate.
pub async fn ensure(st: &AppState, row: &Row) -> sqlx::Result<bool> {
    if st.parties.has(row.id) {
        return Ok(true);
    }
    let _held = hold(st, row.id).await;
    ensure_held(st, row).await
}

/// Creates the machine of an open party that has none, from its row as stored now and with its
/// stored chat; false for an ended party. The caller holds the party's gate.
pub async fn ensure_held(st: &AppState, row: &Row) -> sqlx::Result<bool> {
    if st.parties.has(row.id) {
        return Ok(true);
    }
    let Some(row) = db::get(&st.db, row.id)
        .await?
        .filter(|r| r.status != "ended")
    else {
        st.parties.forget(row.id);
        return Ok(false);
    };
    let chat = db::load_chat(&st.db, row.id).await?;
    st.parties.insert(&row, chat);
    Ok(true)
}

/// Effects of one mutation plus the members present when it ended.
pub struct Delivery {
    pub effects: Vec<Effect>,
    pub audience: Vec<(i32, String)>,
}

#[derive(Default)]
struct Inner {
    live: HashMap<i32, Live>,
    /// ponytail: lost on restart, so a restart inside the lobby window repeats `party.starting` once.
    notified: HashSet<i32>,
    /// When a freed `scheduled` room last emptied, for the schedule expiry.
    emptied: HashMap<i32, i64>,
    /// Held across a mutation and its delivery, so one party's events leave in `rev` order.
    gates: HashMap<i32, Arc<tokio::sync::Mutex<()>>>,
    /// Proposal times (ms) per user, for the rate limit.
    proposed: HashMap<i32, std::collections::VecDeque<i64>>,
}

#[derive(Clone, Default)]
pub struct Parties(Arc<Mutex<Inner>>);

/// A copy of what a snapshot needs.
pub struct View {
    pub rev: u64,
    pub playback: Option<PlaybackDto>,
    /// The playing item; none before the start.
    pub item: Option<Item>,
    pub host_id: i32,
    pub members: Vec<Member>,
    pub messages: Vec<fliks_domain::party::Message>,
}

/// What a summary needs of a machine.
pub struct Brief {
    pub host_id: i32,
    pub item: Option<Item>,
    pub member_count: usize,
}

fn item_of(l: &Live) -> Option<Item> {
    l.playback.as_ref().map(|p| p.item.clone())
}

impl Parties {
    /// Records a proposal by `user`; false when they made `max` within `window` ms.
    pub fn proposal_ok(&self, user: i32, now: i64, window: i64, max: usize) -> bool {
        let mut inner = self.inner();
        let q = inner.proposed.entry(user).or_default();
        while q.front().is_some_and(|t| now - t >= window) {
            q.pop_front();
        }
        if q.len() >= max {
            return false;
        }
        q.push_back(now);
        true
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock_clean()
    }

    fn has(&self, id: i32) -> bool {
        self.inner().live.contains_key(&id)
    }

    /// Creates the machine for a row that has none: a `live` row boots paused (rule 10), else a
    /// room with nothing playing; `chat` is the history it reopens with.
    fn insert(&self, row: &Row, chat: Vec<Message>) {
        let args = (row.name.clone(), row.policy, row.host(), now_ms());
        self.inner().live.entry(row.id).or_insert_with(|| {
            let (n, p, h, now) = args;
            let mut l = match row.item() {
                Some(item) if row.status == "live" => Live::boot(n, p, h, item, row.position, now),
                _ => Live::new(n, p, h, now),
            };
            l.room.reactions_enabled = row.reactions_enabled;
            l.room.chat_enabled = row.chat_enabled;
            l.room.link_sharing = row.link_sharing;
            l.room.public = row.public;
            l.room.restore_chat(chat);
            l
        });
    }

    /// Frees the machine; the lobby notice stays, a still `scheduled` row must not repeat it.
    pub fn remove(&self, id: i32) {
        let mut g = self.inner();
        if let Some(t) = g.live.remove(&id).and_then(|l| l.room.empty_since()) {
            g.emptied.insert(id, t);
        }
    }

    /// Whether the machine has had no present member for `EMPTY_TTL_MS`.
    fn empty_for(&self, id: i32, now: i64) -> bool {
        self.inner()
            .live
            .get(&id)
            .and_then(|l| l.room.empty_since())
            .is_some_and(|t| now - t >= EMPTY_TTL_MS)
    }

    /// Rule 11: `None` while the room has a present member, else when it emptied (0: never joined).
    fn empty_since(&self, id: i32) -> Option<i64> {
        let g = self.inner();
        match g.live.get(&id) {
            Some(l) => l.room.empty_since(),
            None => Some(g.emptied.get(&id).copied().unwrap_or(0)),
        }
    }

    fn forget(&self, id: i32) {
        let mut g = self.inner();
        g.live.remove(&id);
        g.gates.remove(&id);
        g.notified.remove(&id);
        g.emptied.remove(&id);
    }

    pub fn forget_notice(&self, id: i32) {
        self.inner().notified.remove(&id);
    }

    pub fn ids(&self) -> Vec<i32> {
        self.inner().live.keys().copied().collect()
    }

    pub fn view(&self, id: i32) -> Option<View> {
        let g = self.inner();
        let l = g.live.get(&id)?;
        Some(View {
            rev: l.room.rev,
            playback: l.playback.as_ref().map(|p| PlaybackDto {
                state: p.state,
                anchor: p.anchor,
            }),
            item: item_of(l),
            host_id: l.room.host_id,
            members: l.room.members.clone(),
            messages: l.room.recent_messages(),
        })
    }

    pub fn brief(&self, id: i32) -> Option<Brief> {
        let g = self.inner();
        let l = g.live.get(&id)?;
        Some(Brief {
            host_id: l.room.host_id,
            item: item_of(l),
            member_count: l.room.members.len(),
        })
    }

    pub fn has_user(&self, id: i32, user: i32) -> bool {
        self.inner()
            .live
            .get(&id)
            .is_some_and(|l| l.room.has_user(user))
    }

    /// Whether an `ended` from this device would take effect right now.
    pub fn can_end(&self, id: i32, user: i32, device: &str, item: Option<&Item>) -> bool {
        self.inner()
            .live
            .get(&id)
            .is_some_and(|l| l.can_end(user, device, item))
    }

    fn gate(&self, id: i32) -> Arc<tokio::sync::Mutex<()>> {
        self.inner().gates.entry(id).or_default().clone()
    }

    /// Runs `f` on the machine under the lock; `None` when the party has no machine.
    pub fn act<R>(
        &self,
        id: i32,
        f: impl FnOnce(&mut Live) -> (R, Vec<Effect>),
    ) -> Option<(R, Delivery)> {
        let mut g = self.inner();
        let l = g.live.get_mut(&id)?;
        let (r, effects) = f(l);
        Some((
            r,
            Delivery {
                effects,
                audience: l.room.audience(),
            },
        ))
    }
}

impl Brief {
    pub fn of(v: &View) -> Self {
        Self {
            host_id: v.host_id,
            item: v.item.clone(),
            member_count: v.members.len(),
        }
    }
}

pub fn item_dto_of(info: Option<db::ItemInfo>, item: &Item) -> PartyItem {
    let i = info.unwrap_or(db::ItemInfo {
        title: String::new(),
        poster_url: None,
        fanart_url: None,
        additional_fanart_urls: vec![],
        still_url: None,
        series_title: None,
        season_number: None,
        episode_number: None,
        episode_title: None,
    });
    PartyItem {
        media_id: item.media_id,
        media_file_id: item.media_file_id,
        episode_id: item.episode_id,
        title: i.title,
        poster_url: i.poster_url,
        fanart_url: i.fanart_url,
        additional_fanart_urls: i.additional_fanart_urls,
        still_url: i.still_url,
        series_title: i.series_title,
        season_number: i.season_number,
        episode_number: i.episode_number,
        episode_title: i.episode_title,
        hidden: false,
    }
}

/// The items that exist, resolved in one query; `None` stays `None`.
pub async fn opt_item_dtos(
    st: &AppState,
    items: &[Option<Item>],
) -> sqlx::Result<Vec<Option<PartyItem>>> {
    let present: Vec<Item> = items.iter().flatten().cloned().collect();
    let mut dtos = item_dtos(st, &present).await?.into_iter();
    Ok(items
        .iter()
        .map(|i| i.as_ref().and_then(|_| dtos.next()))
        .collect())
}

pub async fn item_dto(st: &AppState, item: &Item) -> sqlx::Result<PartyItem> {
    Ok(item_dtos(st, std::slice::from_ref(item)).await?.remove(0))
}

/// One query for all the items, in the order given.
pub async fn item_dtos(st: &AppState, items: &[Item]) -> sqlx::Result<Vec<PartyItem>> {
    let keys: Vec<_> = items.iter().map(|i| (i.media_id, i.episode_id)).collect();
    let infos = db::item_infos(&st.db, &keys).await?;
    Ok(items
        .iter()
        .map(|i| item_dto_of(infos.get(&(i.media_id, i.episode_id)).cloned(), i))
        .collect())
}

pub fn member_dtos(st: &AppState, host_id: i32, members: &[Member]) -> Vec<MemberDto> {
    let mut devices: HashMap<i32, Vec<crate::events::Target>> = HashMap::new();
    members
        .iter()
        .map(|m| {
            let targets = devices
                .entry(m.user_id)
                .or_insert_with(|| st.hub.list_for_user(m.user_id));
            let id = targets.iter().find(|t| t.connection_id == m.connection_id);
            MemberDto {
                user_id: m.user_id,
                username: m.username.clone(),
                device_id: m.device_id.clone(),
                role: if m.user_id == host_id {
                    fliks_domain::party::Role::Host
                } else {
                    fliks_domain::party::Role::Member
                },
                status: m.status,
                device_name: id.and_then(|t| t.identity.device_name.clone()),
                form_factor: id.and_then(|t| t.identity.form_factor.clone()),
                voice: m.voice,
            }
        })
        .collect()
}

fn json(v: impl serde::Serialize) -> Value {
    to_value(v).expect("typed dto")
}

/// The party's gate: whoever holds it is the only one writing the party (programme, start, end)
/// or delivering its events.
pub async fn hold(st: &AppState, id: i32) -> tokio::sync::OwnedMutexGuard<()> {
    st.parties.gate(id).lock_owned().await
}

/// Runs `f` on the machine and delivers its effects, serialized per party so events leave in the
/// order the machine produced them; `None` when the party has no machine.
pub async fn mutate<R>(
    st: &AppState,
    id: i32,
    f: impl FnOnce(&mut Live) -> (R, Vec<Effect>),
) -> Option<R> {
    let _held = hold(st, id).await;
    mutate_held(st, id, f).await
}

/// `mutate` for a caller that already holds the gate.
pub async fn mutate_held<R>(
    st: &AppState,
    id: i32,
    f: impl FnOnce(&mut Live) -> (R, Vec<Effect>),
) -> Option<R> {
    let (r, d) = st.parties.act(id, f)?;
    deliver(st, id, d).await;
    Some(r)
}

/// Posts a system message in the party's chat, creating the machine of a scheduled party that has
/// none so the message is kept.
pub async fn note(st: &AppState, row: &Row, kind: &str, by: &str, args: Value) -> sqlx::Result<()> {
    let _held = hold(st, row.id).await;
    note_held(st, row, kind, by, args).await
}

/// `note` for a caller that holds the gate.
pub async fn note_held(
    st: &AppState,
    row: &Row,
    kind: &str,
    by: &str,
    args: Value,
) -> sqlx::Result<()> {
    if ensure_held(st, row).await? {
        mutate_held(st, row.id, |l| ((), l.room.note(kind, by, args, now_ms()))).await;
    }
    Ok(())
}

const ITEM_KINDS: [&str; 5] = [
    "item_changed",
    "item_skipped",
    "proposed",
    "voted",
    "proposal_chosen",
];

fn is_item_message(m: &Message) -> bool {
    m.system
        .as_ref()
        .is_some_and(|s| ITEM_KINDS.contains(&s.kind.as_str()))
}

fn item_key(m: &Message) -> Option<(i32, Option<i32>)> {
    let args = &m.system.as_ref().filter(|_| is_item_message(m))?.args;
    let media = i32::try_from(args.get("mediaId")?.as_i64()?).ok()?;
    let episode = args
        .get("episodeId")
        .and_then(Value::as_i64)
        .and_then(|e| i32::try_from(e).ok());
    Some((media, episode))
}

/// What titling item messages needs that does not depend on who reads them.
#[derive(Default)]
pub struct Titles {
    loaded: bool,
    infos: HashMap<(i32, Option<i32>), db::ItemInfo>,
    libraries: HashMap<i32, i32>,
}

impl Titles {
    pub async fn load(st: &AppState, messages: &[Message]) -> Result<Self, AppError> {
        let keys: Vec<_> = messages.iter().filter_map(item_key).collect();
        if keys.is_empty() {
            return Ok(Self::default());
        }
        let mut medias: Vec<i32> = keys.iter().map(|k| k.0).collect();
        medias.sort_unstable();
        medias.dedup();
        Ok(Self {
            loaded: true,
            infos: db::item_infos(&st.db, &keys).await?,
            libraries: db::media_libraries(&st.db, &medias).await?,
        })
    }

    /// Sets `args.title` of the item messages to what `viewer` may know: the title of a media they
    /// can open, else an empty one. Stored messages carry the row, never the title.
    pub async fn reveal(
        &self,
        st: &AppState,
        viewer: i32,
        messages: &mut [Message],
    ) -> Result<(), AppError> {
        let allowed = if self.loaded {
            super::routes::user_libraries(st, viewer)
                .await?
                .unwrap_or_default()
        } else {
            vec![]
        };
        for m in messages.iter_mut().filter(|m| is_item_message(m)) {
            let title = item_key(m)
                .filter(|k| db::can_open(&self.libraries, &allowed, k.0))
                .and_then(|k| self.infos.get(&k).map(|i| i.title.clone()))
                .unwrap_or_default();
            if let Some(args) = m.system.as_mut().and_then(|s| s.args.as_object_mut()) {
                args.insert("title".into(), Value::String(title));
            }
        }
        Ok(())
    }
}

/// `Titles::load` then `reveal` for one reader.
pub async fn reveal(st: &AppState, viewer: i32, messages: &mut [Message]) -> Result<(), AppError> {
    Titles::load(st, messages)
        .await?
        .reveal(st, viewer, messages)
        .await
}

/// Persists and emits what a mutation produced; a failed write is logged, never fails the action.
pub async fn deliver(st: &AppState, party: i32, d: Delivery) {
    let pid = i64::from(party);
    let emit = |ev: SseEvent| {
        for (user, conn) in &d.audience {
            st.hub.emit_to_connection(*user, conn, ev.clone());
        }
    };
    let mut moved = false;
    for e in d.effects {
        match e {
            Effect::Persist { position, item } => {
                if let Err(err) = db::persist(&st.db, party, position, &item).await {
                    tracing::warn!(error = %err, party, "party position not saved");
                }
            }
            Effect::State {
                rev,
                state,
                item,
                anchor,
                when_ms,
                by,
                action,
            } => {
                moved = true;
                let dto = item_dto(st, &item)
                    .await
                    .unwrap_or_else(|_| item_dto_of(None, &item));
                emit(SseEvent::PartyState {
                    party_id: pid,
                    rev: rev as i64,
                    state: json(state).as_str().unwrap_or_default().to_owned(),
                    item: json(dto),
                    anchor: json(anchor),
                    when_ms,
                    by: by.map(|b| {
                        json(UserRef {
                            user_id: b.user_id,
                            username: b.username,
                        })
                    }),
                    action: action.map(Into::into),
                });
            }
            Effect::Programme { rev, item } => {
                let dto = match item {
                    Some(item) => Some(
                        item_dto(st, &item)
                            .await
                            .unwrap_or_else(|_| item_dto_of(None, &item)),
                    ),
                    None => None,
                };
                emit(SseEvent::PartyProgramme {
                    party_id: pid,
                    rev: rev as i64,
                    item: json(dto),
                });
            }
            Effect::Members {
                rev,
                host_id,
                members,
            } => emit(SseEvent::PartyMembers {
                party_id: pid,
                rev: rev as i64,
                members: json(member_dtos(st, host_id, &members)),
            }),
            Effect::Settings {
                rev,
                name,
                policy,
                reactions_enabled,
                chat_enabled,
                link_sharing,
                public,
            } => emit(SseEvent::PartySettings {
                party_id: pid,
                rev: rev as i64,
                name,
                policy: json(policy).as_str().unwrap_or_default().to_owned(),
                reactions_enabled,
                chat_enabled,
                link_sharing,
                public,
            }),
            Effect::Message(m) => {
                if let Err(err) = db::save_message(&st.db, party, &m).await {
                    tracing::warn!(error = %err, party, "party message not saved");
                }
                let titles = match Titles::load(st, std::slice::from_ref(&m)).await {
                    Ok(t) => t,
                    Err(err) => {
                        tracing::warn!(error = %err, party, "party message titles not resolved");
                        continue;
                    }
                };
                for (user, conn) in &d.audience {
                    let mut mine = [m.clone()];
                    if let Err(err) = titles.reveal(st, *user, &mut mine).await {
                        tracing::warn!(error = %err, party, "party message titles not resolved");
                        continue;
                    }
                    let [message] = mine;
                    st.hub.emit_to_connection(
                        *user,
                        conn,
                        SseEvent::PartyMessage {
                            party_id: pid,
                            message: json(message),
                        },
                    );
                }
            }
            Effect::Reaction {
                user_id,
                username,
                emoji,
            } => emit(SseEvent::PartyReaction {
                party_id: pid,
                user_id: user_id.into(),
                username,
                emoji,
            }),
            Effect::Closed { reason, by, to } => {
                let reason = json(reason).as_str().unwrap_or_default().to_owned();
                for (user, conn) in to {
                    st.hub.emit_to_connection(
                        user,
                        &conn,
                        SseEvent::PartyClosed {
                            party_id: pid,
                            reason: reason.clone(),
                            by: by.clone(),
                        },
                    );
                }
            }
        }
    }
    // The party page and the home rail outside the room follow the playback through a refetch.
    if moved {
        let row = db::get(&st.db, party).await;
        if let Err(err) = match row {
            Ok(Some(row)) => notify_updated(st, &row).await,
            Ok(None) => Ok(()),
            Err(e) => Err(e),
        } {
            tracing::warn!(error = %err, party, "party update not announced");
        }
    }
}

/// Owner and every guest, or everyone for a public party, for the home rail.
pub async fn notify_updated(st: &AppState, row: &Row) -> sqlx::Result<()> {
    let ev = SseEvent::PartyUpdated {
        party_id: row.id.into(),
    };
    if row.public {
        st.hub.emit(ev);
        return Ok(());
    }
    let mut users = db::guest_ids(&st.db, row.id).await?;
    users.push(row.owner_id);
    st.hub.emit_to_users(&users, ev);
    Ok(())
}

/// Sets `ended`, tells the members, drops the machine, the proposals and the chat, and refreshes
/// the rail. Under the gate, so a start or an edit in flight finishes first or sees the end.
pub async fn end(
    st: &AppState,
    id: i32,
    reason: CloseReason,
    by: Option<String>,
) -> sqlx::Result<()> {
    let _held = hold(st, id).await;
    end_held(st, id, reason, by).await
}

/// `end` for a caller that holds the gate; a party already ended is left alone.
async fn end_held(
    st: &AppState,
    id: i32,
    reason: CloseReason,
    by: Option<String>,
) -> sqlx::Result<()> {
    let Some(row) = db::get(&st.db, id).await?.filter(|r| r.status != "ended") else {
        return Ok(());
    };
    db::set_ended(&st.db, id).await?;
    if let Some(stem) = row.cover.as_deref().and_then(|c| c.upload_stem(id)) {
        upload::remove(super::cover::DIR, stem).await;
    }
    super::proposals::clear(&st.db, id).await?;
    mutate_held(st, id, |l| ((), vec![l.room.close(reason, by)])).await;
    st.parties.forget(id);
    db::clear_chat(&st.db, id).await?;
    notify_updated(st, &row).await
}

/// Ends every open party playing `media`, before the delete that would cascade its row away.
pub async fn end_playing(st: &AppState, media: i32) -> sqlx::Result<()> {
    for id in db::open_ids_playing(&st.db, media).await? {
        end(st, id, CloseReason::HostEnded, None).await?;
    }
    Ok(())
}

/// Ends every open party `owner` owns, before their account (and so the rows) goes.
pub async fn end_owned(st: &AppState, owner: i32) -> sqlx::Result<()> {
    for id in db::open_ids_owned(&st.db, owner).await? {
        end(st, id, CloseReason::HostEnded, None).await?;
    }
    Ok(())
}

/// Rule 10: every `live` row gets a machine, which starts its empty countdown.
pub async fn boot(st: &AppState) -> sqlx::Result<()> {
    for row in db::live_rows(&st.db).await? {
        ensure(st, &row).await?;
    }
    Ok(())
}

pub fn spawn(st: &AppState) {
    let st = st.clone();
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(1));
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut n = 0u64;
        loop {
            every.tick().await;
            tick(&st).await;
            n += 1;
            if n.is_multiple_of(10)
                && let Err(e) = sweep(&st, Utc::now()).await
            {
                tracing::warn!(error = %e, "party schedule sweep failed");
            }
        }
    });
}

pub async fn tick(st: &AppState) {
    let now = now_ms();
    for id in st.parties.ids() {
        let Some(expired) = mutate(st, id, |l| {
            let effects = l.tick(now, |c| st.hub.has_connection(c));
            let expired = effects.iter().any(|e| {
                matches!(
                    e,
                    Effect::Closed {
                        reason: CloseReason::Expired,
                        ..
                    }
                )
            });
            (expired, effects)
        })
        .await
        else {
            continue;
        };
        if !expired {
            continue;
        }
        let _held = hold(st, id).await;
        if !st.parties.empty_for(id, now_ms()) {
            continue;
        }
        match db::get(&st.db, id).await {
            Ok(Some(row)) if row.status == "live" => {
                if let Err(e) = end_held(st, id, CloseReason::Expired, None).await {
                    tracing::warn!(error = %e, party = id, "party expiry failed");
                }
            }
            // An empty lobby just frees its machine; the schedule decides the row's fate.
            Ok(_) => st.parties.remove(id),
            // The machine stays and its expiry is judged again at the next tick.
            Err(e) => tracing::warn!(error = %e, party = id, "party expiry not checked"),
        }
    }
}

/// Rule 11: start reminder once, and expiry of a `scheduled` row never started.
pub async fn sweep(st: &AppState, now: DateTime<Utc>) -> sqlx::Result<()> {
    let now_ms = now.timestamp_millis();
    for row in db::scheduled_rows(&st.db).await? {
        let Some(at) = row.scheduled_at.map(|t| t.timestamp_millis()) else {
            continue;
        };
        if schedule_expired(st, at, row.id, now_ms) {
            let _held = hold(st, row.id).await;
            // Judged again under the gate: a join or a reschedule may have come in.
            let current = db::get(&st.db, row.id)
                .await?
                .filter(|r| r.status == "scheduled")
                .and_then(|r| r.scheduled_at);
            if current.is_some_and(|t| schedule_expired(st, t.timestamp_millis(), row.id, now_ms)) {
                end_held(st, row.id, CloseReason::Expired, None).await?;
            }
        } else if now_ms >= at - LOBBY_OPEN_BEFORE_MS {
            announce_lobby(st, &row).await?;
        }
    }
    Ok(())
}

fn schedule_expired(st: &AppState, at: i64, id: i32, now: i64) -> bool {
    st.parties
        .empty_since(id)
        .is_some_and(|e| now >= at.max(e) + SCHEDULE_EXPIRY_MS)
}

/// Tells the guests the party is about to start, once per schedule: the sweep at `scheduledAt - 15
/// min`, a creation or reschedule already due at once.
pub async fn announce_lobby(st: &AppState, row: &Row) -> sqlx::Result<()> {
    if !st.parties.inner().notified.insert(row.id) {
        return Ok(());
    }
    let guests = db::guest_ids(&st.db, row.id).await?;
    st.hub.emit_to_users(
        &guests,
        SseEvent::PartyStarting {
            party_id: row.id.into(),
            name: row.name.clone(),
        },
    );
    Ok(())
}

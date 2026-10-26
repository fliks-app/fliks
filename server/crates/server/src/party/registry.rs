//! The in-memory half of a party (`docs/spec/watch-party.md`): `Live` machines, effect delivery and
//! the 1 s tick that runs timeouts, away members, empty-party expiry and the scheduled lobby/expiry.
use super::{
    db::{self, Row},
    dto::{MemberDto, PartyItem, PlaybackDto, UserRef},
};
use crate::{events::SseEvent, state::AppState, sync::MutexExt};
use chrono::{DateTime, Utc};
use fliks_domain::{
    js::now_ms,
    party::{
        CloseReason, Effect, Item, LOBBY_OPEN_BEFORE_MS, Live, Member, Message, SCHEDULE_EXPIRY_MS,
    },
};
use serde_json::{Value, to_value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

/// Creates the machine of a party that has none, with its stored chat.
pub async fn ensure(st: &AppState, row: &Row, fresh: bool) -> sqlx::Result<()> {
    if !st.parties.has(row.id) {
        let chat = db::load_chat(&st.db, row.id).await?;
        st.parties.insert(row, fresh, chat);
    }
    Ok(())
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
    /// Held across a mutation and its delivery, so one party's events leave in `rev` order.
    gates: HashMap<i32, Arc<tokio::sync::Mutex<()>>>,
}

#[derive(Clone, Default)]
pub struct Parties(Arc<Mutex<Inner>>);

/// A copy of what a snapshot needs.
pub struct View {
    pub rev: u64,
    pub playback: Option<PlaybackDto>,
    /// The playing item, else the selection.
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
    l.playback
        .as_ref()
        .map(|p| p.item.clone())
        .or_else(|| l.room.selection.clone())
}

impl Parties {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock_clean()
    }

    fn has(&self, id: i32) -> bool {
        self.inner().live.contains_key(&id)
    }

    /// Creates the machine for a row that has none: a `live` row boots paused (rule 10), else a
    /// room holding the chosen film, with nothing playing; `chat` is the history it reopens with.
    fn insert(&self, row: &Row, fresh: bool, chat: Vec<Message>) {
        let args = (row.name.clone(), row.policy, row.owner_id, now_ms());
        self.inner().live.entry(row.id).or_insert_with(|| {
            let (n, p, h, now) = args;
            let mut l = match row.item() {
                Some(item) if row.status == "live" && !fresh => {
                    Live::boot(n, p, h, item, row.position, now)
                }
                item => Live::new(n, p, h, item, now),
            };
            l.room.reactions_enabled = row.reactions_enabled;
            l.room.chat_enabled = row.chat_enabled;
            l.room.link_sharing = row.link_sharing;
            l.room.restore_chat(chat);
            l
        });
    }

    /// Frees the machine; the lobby notice stays, a still `scheduled` row must not repeat it.
    pub fn remove(&self, id: i32) {
        let mut g = self.inner();
        g.live.remove(&id);
        g.gates.remove(&id);
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

    fn gate(&self, id: i32) -> Option<Arc<tokio::sync::Mutex<()>>> {
        let mut g = self.inner();
        g.live
            .contains_key(&id)
            .then(|| g.gates.entry(id).or_default().clone())
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
    let (title, poster_url, fanart_url, additional_fanart_urls) = match info {
        Some(i) => (
            i.title,
            i.poster_url,
            i.fanart_url,
            i.additional_fanart_urls,
        ),
        None => Default::default(),
    };
    PartyItem {
        media_id: item.media_id,
        media_file_id: item.media_file_id,
        episode_id: item.episode_id,
        title,
        poster_url,
        fanart_url,
        additional_fanart_urls,
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

/// Runs `f` on the machine and delivers its effects, serialized per party so events leave in the
/// order the machine produced them; `None` when the party has no machine.
pub async fn mutate<R>(
    st: &AppState,
    id: i32,
    f: impl FnOnce(&mut Live) -> (R, Vec<Effect>),
) -> Option<R> {
    let gate = st.parties.gate(id)?;
    let _held = gate.lock().await;
    let (r, d) = st.parties.act(id, f)?;
    deliver(st, id, d).await;
    Some(r)
}

/// Persists and emits what a mutation produced; a failed write is logged, never fails the action.
pub async fn deliver(st: &AppState, party: i32, d: Delivery) {
    let pid = i64::from(party);
    let emit = |ev: SseEvent| {
        for (user, conn) in &d.audience {
            st.hub.emit_to_connection(*user, conn, ev.clone());
        }
    };
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
            Effect::Selection { rev, item } => {
                let dto = item_dto(st, &item)
                    .await
                    .unwrap_or_else(|_| item_dto_of(None, &item));
                emit(SseEvent::PartySelection {
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
            } => emit(SseEvent::PartySettings {
                party_id: pid,
                rev: rev as i64,
                name,
                policy: json(policy).as_str().unwrap_or_default().to_owned(),
                reactions_enabled,
                chat_enabled,
                link_sharing,
            }),
            Effect::Message(m) => {
                if let Err(err) = db::save_message(&st.db, party, &m).await {
                    tracing::warn!(error = %err, party, "party message not saved");
                }
                emit(SseEvent::PartyMessage {
                    party_id: pid,
                    message: json(m),
                });
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
            Effect::Closed { reason, to } => {
                let reason = json(reason).as_str().unwrap_or_default().to_owned();
                for (user, conn) in to {
                    st.hub.emit_to_connection(
                        user,
                        &conn,
                        SseEvent::PartyClosed {
                            party_id: pid,
                            reason: reason.clone(),
                        },
                    );
                }
            }
        }
    }
}

/// Owner and every guest, for the home rail.
pub async fn notify_updated(st: &AppState, row: &Row) -> sqlx::Result<()> {
    let mut users = db::guest_ids(&st.db, row.id).await?;
    users.push(row.owner_id);
    st.hub.emit_to_users(
        &users,
        SseEvent::PartyUpdated {
            party_id: row.id.into(),
        },
    );
    Ok(())
}

/// Sets `ended`, tells the members, drops the machine and refreshes the rail.
pub async fn end(st: &AppState, row: &Row, reason: CloseReason) -> sqlx::Result<()> {
    db::set_ended(&st.db, row.id).await?;
    mutate(st, row.id, |l| ((), vec![l.room.close(reason)])).await;
    st.parties.remove(row.id);
    st.parties.forget_notice(row.id);
    notify_updated(st, row).await
}

/// Rule 10: every `live` row gets a machine, which starts its empty countdown.
pub async fn boot(st: &AppState) -> sqlx::Result<()> {
    for row in db::live_rows(&st.db).await? {
        ensure(st, &row, false).await?;
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

async fn tick(st: &AppState) {
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
        match db::get(&st.db, id).await {
            Ok(Some(row)) if row.status == "live" => {
                if let Err(e) = end(st, &row, CloseReason::Expired).await {
                    tracing::warn!(error = %e, party = id, "party expiry failed");
                }
            }
            // An empty lobby just frees its machine; the schedule decides the row's fate.
            _ => st.parties.remove(id),
        }
    }
}

/// Rule 11: lobby reminder once, and expiry of a `scheduled` row never started.
pub async fn sweep(st: &AppState, now: DateTime<Utc>) -> sqlx::Result<()> {
    let now_ms = now.timestamp_millis();
    for row in db::scheduled_rows(&st.db).await? {
        let Some(at) = row.scheduled_at.map(|t| t.timestamp_millis()) else {
            continue;
        };
        if now_ms >= at + SCHEDULE_EXPIRY_MS {
            end(st, &row, CloseReason::Expired).await?;
        } else if now_ms >= at - LOBBY_OPEN_BEFORE_MS {
            announce_lobby(st, &row).await?;
        }
    }
    Ok(())
}

/// Tells the guests their lobby is open, once per schedule.
async fn announce_lobby(st: &AppState, row: &Row) -> sqlx::Result<()> {
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

/// Opens a lobby now instead of at the next sweep: its machine exists and the guests are told.
pub async fn open_lobby(st: &AppState, row: &Row) -> sqlx::Result<()> {
    ensure(st, row, false).await?;
    announce_lobby(st, row).await
}

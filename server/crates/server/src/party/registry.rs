//! The in-memory half of a party (`docs/spec/watch-party.md`): `Live` machines, effect delivery and
//! the 1 s tick that runs timeouts, away members, empty-party expiry and the scheduled lobby/expiry.
use super::{
    db::{self, Row},
    dto::{MemberDto, PartyItem, UserRef},
};
use crate::{events::SseEvent, state::AppState, sync::MutexExt};
use chrono::{DateTime, Utc};
use fliks_domain::{
    js::now_ms,
    party::{
        CloseReason, Effect, Item, LOBBY_OPEN_BEFORE_MS, Live, Member, Policy, SCHEDULE_EXPIRY_MS,
    },
};
use serde_json::{Value, to_value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

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
}

#[derive(Clone, Default)]
pub struct Parties(Arc<Mutex<Inner>>);

/// A copy of what a snapshot needs.
pub struct View {
    pub rev: u64,
    pub state: fliks_domain::party::State,
    pub anchor: fliks_domain::party::Anchor,
    pub item: Item,
    pub host_id: i32,
    pub members: Vec<Member>,
    pub messages: Vec<fliks_domain::party::Message>,
    pub blocked: Vec<i32>,
}

impl Parties {
    fn inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock_clean()
    }

    /// Creates the machine for a row that has none: a `live` row boots paused (rule 10), else idle.
    pub fn ensure(&self, row: &Row, fresh: bool) {
        let policy = if row.policy == "host_only" {
            Policy::HostOnly
        } else {
            Policy::Everyone
        };
        let args = (
            row.name.clone(),
            policy,
            row.owner_id,
            row.item(),
            row.position,
            now_ms(),
        );
        self.inner().live.entry(row.id).or_insert_with(|| {
            let (n, p, h, i, pos, now) = args;
            if row.status == "live" && !fresh {
                Live::boot(n, p, h, i, pos, now)
            } else {
                let mut l = Live::new(n, p, h, i, pos, now);
                l.lobby = row.status == "scheduled";
                l
            }
        });
    }

    pub fn remove(&self, id: i32) {
        let mut g = self.inner();
        g.live.remove(&id);
        g.notified.remove(&id);
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
            rev: l.rev,
            state: l.state,
            anchor: l.anchor,
            item: l.item.clone(),
            host_id: l.host_id,
            members: l.members.clone(),
            messages: l.recent_messages(),
            blocked: l.blocked.clone(),
        })
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
                audience: l.audience(),
            },
        ))
    }
}

pub fn item_dto_of(info: Option<(String, Option<String>)>, item: &Item) -> PartyItem {
    let (title, poster_url) = info.unwrap_or_default();
    PartyItem {
        media_id: item.media_id,
        media_file_id: item.media_file_id,
        episode_id: item.episode_id,
        title,
        poster_url,
    }
}

pub async fn item_dto(st: &AppState, item: &Item) -> sqlx::Result<PartyItem> {
    let info = db::item_info(&st.db, item.media_id, item.episode_id).await?;
    Ok(item_dto_of(info, item))
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
            Effect::Members {
                rev,
                host_id,
                members,
            } => emit(SseEvent::PartyMembers {
                party_id: pid,
                rev: rev as i64,
                members: json(member_dtos(st, host_id, &members)),
            }),
            Effect::Settings { rev, name, policy } => emit(SseEvent::PartySettings {
                party_id: pid,
                rev: rev as i64,
                name,
                policy: json(policy).as_str().unwrap_or_default().to_owned(),
            }),
            Effect::Message(m) => emit(SseEvent::PartyMessage {
                party_id: pid,
                message: json(m),
            }),
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

/// Owner and invitees, for the home rail.
pub async fn notify_updated(st: &AppState, row: &Row) -> sqlx::Result<()> {
    let mut users = db::invitees(&st.db, row.id).await?;
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
    if let Some((_, d)) = st.parties.act(row.id, |l| ((), vec![l.close(reason)])) {
        deliver(st, row.id, d).await;
    }
    st.parties.remove(row.id);
    notify_updated(st, row).await
}

/// Rule 10: every `live` row gets a machine, which starts its empty countdown.
pub async fn boot(st: &AppState) -> sqlx::Result<()> {
    for row in db::live_rows(&st.db).await? {
        st.parties.ensure(&row, false);
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
        let Some((_, d)) = st
            .parties
            .act(id, |l| ((), l.tick(now, |c| st.hub.has_connection(c))))
        else {
            continue;
        };
        let expired = d.effects.iter().any(|e| {
            matches!(
                e,
                Effect::Closed {
                    reason: CloseReason::Expired,
                    ..
                }
            )
        });
        deliver(st, id, d).await;
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
        } else if now_ms >= at - LOBBY_OPEN_BEFORE_MS && st.parties.inner().notified.insert(row.id)
        {
            let invitees = db::invitees(&st.db, row.id).await?;
            st.hub.emit_to_users(
                &invitees,
                SseEvent::PartyStarting {
                    party_id: row.id.into(),
                    name: row.name.clone(),
                },
            );
        }
    }
    Ok(())
}

//! The queue side of a party (`docs/spec/watch-party.md`, Followed queue): which row plays next.
use super::{db, registry::item_dto, routes::user_media_ok};
use crate::{http::AppError, state::AppState};
use fliks_domain::party::{Action, Effect, Error, Intent, Item, Live, candidates};
use std::collections::HashMap;

/// The titles passed over and the row that plays (`None`: nothing playable is left).
pub struct Step {
    pub skipped: Vec<String>,
    pub next: Option<(Item, String)>,
}

async fn title(st: &AppState, item: &Item) -> sqlx::Result<String> {
    Ok(item_dto(st, item).await?.title)
}

/// The first row after (before) `current` that has a file and that every user in `users` can access.
pub async fn step(
    st: &AppState,
    rows: Vec<db::QueueRow>,
    current: &Item,
    forward: bool,
    users: &[i32],
) -> Result<Step, AppError> {
    let queue: Vec<Item> = rows.iter().map(|r| r.item.clone()).collect();
    // A media's access is the same for every row of it (episodes of one series).
    let mut shared: HashMap<i32, bool> = HashMap::new();
    let mut skipped = vec![];
    for cand in candidates(&queue, current, forward) {
        let playable = rows.iter().any(|r| r.item == cand && r.playable);
        let mut open = playable;
        if open {
            open = match shared.get(&cand.media_id) {
                Some(all) => *all,
                None => {
                    let mut all = true;
                    for u in users {
                        all &= user_media_ok(st, *u, cand.media_id).await?;
                    }
                    shared.insert(cand.media_id, all);
                    all
                }
            };
        }
        let label = title(st, &cand).await?;
        if open {
            return Ok(Step {
                skipped,
                next: Some((cand, label)),
            });
        }
        skipped.push(label);
    }
    Ok(Step {
        skipped,
        next: None,
    })
}

/// Runs a step on the machine; after a host `ended` it first lets that `ended` idle the party.
pub fn apply(
    l: &mut Live,
    user: i32,
    device: &str,
    after_ended: bool,
    base_rev: u64,
    step: Step,
    now: i64,
) -> Result<(u64, Vec<Effect>), Error> {
    let mut out = vec![];
    let mut base_rev = base_rev;
    if after_ended {
        let ended = Intent {
            action: Action::Ended,
            position: None,
            item: None,
            item_title: None,
            base_rev: l.rev,
        };
        out = l.intent(user, device, ended, now)?.1;
        base_rev = l.rev;
    }
    let (rev, effects) = l.advance(user, device, base_rev, &step.skipped, step.next, now)?;
    out.extend(effects);
    Ok((rev, out))
}

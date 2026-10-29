//! The queue side of a party (`docs/spec/watch-party.md`, Programme): which row plays next.
use super::{
    db::{self, can_open},
    routes::user_libraries,
};
use crate::{http::AppError, state::AppState};
use fliks_domain::party::{Item, Step, candidates};

/// The first row after (before) `current` that has a file and that every user in `users` can access.
pub async fn step(
    st: &AppState,
    rows: Vec<db::QueueRow>,
    current: &Item,
    forward: bool,
    users: &[i32],
) -> Result<Step, AppError> {
    let queue: Vec<Item> = rows.iter().map(|r| r.item.clone()).collect();
    let cands = candidates(&queue, current, forward);
    let mut medias: Vec<i32> = cands.iter().map(|c| c.media_id).collect();
    medias.sort_unstable();
    medias.dedup();
    let libraries = db::media_libraries(&st.db, &medias).await?;
    // `None`: a user who can open nothing (disabled or deleted).
    let mut allowed = Vec::with_capacity(users.len());
    for u in users {
        allowed.push(user_libraries(st, *u).await?);
    }
    let mut skipped = vec![];
    for cand in cands {
        let open = rows.iter().any(|r| r.item == cand && r.playable)
            && allowed.iter().all(|a| {
                a.as_ref()
                    .is_some_and(|ids| can_open(&libraries, ids, cand.media_id))
            });
        if open {
            return Ok(Step {
                forward,
                skipped,
                next: Some(cand),
            });
        }
        skipped.push(cand);
    }
    Ok(Step {
        forward,
        skipped,
        next: None,
    })
}

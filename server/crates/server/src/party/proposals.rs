//! Proposals and votes of a party, and the karaoke singer queue they make up (`docs/spec/watch-party.md`,
//! Proposals; `docs/spec/karaoke.md` rule 37).
use super::{
    db,
    dto::{NextIn, PartyDto, PartyItem, ProposalDto, ProposalIn, ProposalsIn, VoteIn},
    registry::{hold, item_dtos, note, note_held},
    routes::{
        Edit, PartyError, R, advance_held, conceal_items, edit_held, fail, host_of, member_row,
        not_found, require_host, require_open,
    },
};
use crate::{
    events::SseEvent,
    http::{
        AppError,
        auth::{Authed, SessionAuthed},
        validate::{PathParams, ValidJson},
    },
    libraries::acl::{accessible_library_ids, assert_media_accessible},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{delete, post},
};
use fliks_domain::{
    js::now_ms,
    party::{Item, State as PlayState, same_row},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashMap;

const MAX_PROPOSALS: i64 = 30;
const RATE_WINDOW_MS: i64 = 10_000;
const MAX_PER_WINDOW: usize = 10;
const DEFAULT_QUEUE_CAP: i64 = 2;

pub(super) fn proposal_router() -> Router<AppState> {
    Router::new()
        .route("/api/parties/{id}/proposals", post(propose))
        .route("/api/parties/{id}/proposals/batch", post(propose_batch))
        .route("/api/parties/{id}/proposals/{pid}", delete(unpropose))
        .route(
            "/api/parties/{id}/proposals/{pid}/vote",
            delete(unvote).put(vote),
        )
        .route("/api/parties/{id}/proposals/next", post(next_singer))
        .route("/api/parties/{id}/proposals/{pid}/choose", post(choose))
}

type Raw = (i32, i32, Option<i32>, Option<i32>, i32, Vec<i32>, Vec<i32>);

async fn raw(db: &PgPool, party: i32) -> sqlx::Result<Vec<Raw>> {
    sqlx::query_as(
        r#"SELECT p.id, it."mediaId", CASE WHEN it."groupId" IS NOT NULL THEN it.id END,
                  CASE WHEN m.type = 'album' THEN it.id END, p."proposedBy",
                  COALESCE(array_agg(v."userId" ORDER BY v."userId") FILTER (WHERE v."value" = 1), '{}'),
                  COALESCE(array_agg(v."userId" ORDER BY v."userId") FILTER (WHERE v."value" = -1), '{}')
           FROM watch_party_proposals p
           JOIN items it ON it.id = p."itemId" JOIN media m ON m.id = it."mediaId"
           LEFT JOIN watch_party_votes v ON v."proposalId" = p.id
           WHERE p."partyId" = $1 AND p."chosenAt" IS NULL
           GROUP BY p.id, it.id, m.type ORDER BY p."createdAt", p.id"#,
    )
    .bind(party)
    .fetch_all(db)
    .await
}

/// Proposals as `viewer` may see them, oldest first.
pub(super) async fn snapshot(
    st: &AppState,
    party: i32,
    viewer: i32,
) -> Result<Vec<ProposalDto>, AppError> {
    let mut out = resolve(st, party).await?;
    conceal(st, viewer, &mut out).await?;
    Ok(out)
}

async fn resolve(st: &AppState, party: i32) -> Result<Vec<ProposalDto>, AppError> {
    let rows = raw(&st.db, party).await?;
    let items: Vec<Item> = rows
        .iter()
        .map(|r| Item {
            media_id: r.1,
            media_file_id: None,
            item_id: r.3,
            episode_id: r.2,
        })
        .collect();
    let items = item_dtos(st, &items).await?;
    let positions: HashMap<i32, i32> = queue(&st.db, party).await?.into_iter().zip(1..).collect();
    Ok(rows
        .into_iter()
        .zip(items)
        .map(
            |((id, _, _, _, proposed_by, upvoter_ids, downvoter_ids), item)| ProposalDto {
                id,
                item,
                proposed_by,
                upvoter_ids,
                downvoter_ids,
                queue_position: positions.get(&id).copied(),
            },
        )
        .collect())
}

/// Round-robin over `(proposal, singer)` entries, oldest first: every singer's n-th song before
/// anyone's (n+1)-th; inside a round the singer whose last song (`last`, ms) is oldest, then the
/// one whose first entry is oldest.
fn round_robin(entries: &[(i32, i32)], last: &HashMap<i32, i64>) -> Vec<i32> {
    let mut seen: HashMap<i32, (usize, usize)> = HashMap::new();
    let mut keyed: Vec<_> = entries
        .iter()
        .enumerate()
        .map(|(i, &(id, singer))| {
            let (n, first) = seen.entry(singer).or_insert((0, i));
            let key = (
                *n,
                last.get(&singer).copied().unwrap_or(i64::MIN),
                *first,
                i,
            );
            *n += 1;
            (key, id)
        })
        .collect();
    keyed.sort();
    keyed.into_iter().map(|(_, id)| id).collect()
}

/// The pending track proposals of a party in singing order.
async fn queue(db: &PgPool, party: i32) -> sqlx::Result<Vec<i32>> {
    let rows: Vec<(i32, i32, Option<i64>)> = sqlx::query_as(
        r#"SELECT p.id, p."proposedBy", (extract(epoch FROM p."chosenAt") * 1000)::bigint
           FROM watch_party_proposals p JOIN items it ON it.id = p."itemId"
           JOIN media m ON m.id = it."mediaId" AND m.type = 'album'
           WHERE p."partyId" = $1 ORDER BY p."createdAt", p.id"#,
    )
    .bind(party)
    .fetch_all(db)
    .await?;
    let mut last: HashMap<i32, i64> = HashMap::new();
    for &(_, singer, at) in &rows {
        if let Some(at) = at {
            let e = last.entry(singer).or_insert(at);
            *e = (*e).max(at);
        }
    }
    let pending: Vec<_> = rows
        .iter()
        .filter(|r| r.2.is_none())
        .map(|r| (r.0, r.1))
        .collect();
    Ok(round_robin(&pending, &last))
}

async fn conceal(st: &AppState, viewer: i32, all: &mut [ProposalDto]) -> Result<(), AppError> {
    let mut items: Vec<&mut PartyItem> = all.iter_mut().map(|p| &mut p.item).collect();
    conceal_items(st, viewer, &mut items).await
}

/// Sends every owner and guest their own view of the proposals.
async fn announce(st: &AppState, row: &db::Row) -> Result<(), AppError> {
    let all = resolve(st, row.id).await?;
    let mut users = db::guest_ids(&st.db, row.id).await?;
    users.push(row.owner_id);
    for user in users {
        let mut mine = all.clone();
        conceal(st, user, &mut mine).await?;
        st.hub.emit_to_users(
            &[user],
            SseEvent::PartyProposals {
                party_id: row.id.into(),
                proposals: serde_json::to_value(mine).expect("typed dto"),
            },
        );
    }
    Ok(())
}

/// The film proposal the start takes (a track is a singer's song, not a vote): the most upvotes, then the fewest downvotes; a tie on both is a
/// 409 the host settles by accepting one.
pub(super) async fn top(db: &PgPool, party: i32) -> R<Option<Item>> {
    let rows: Vec<(i32, Option<i32>, i32, i64, i64)> = sqlx::query_as(
        r#"SELECT it."mediaId", CASE WHEN it."groupId" IS NOT NULL THEN it.id END, it.id,
                  count(*) FILTER (WHERE v."value" = 1), count(*) FILTER (WHERE v."value" = -1)
           FROM watch_party_proposals p JOIN items it ON it.id = p."itemId"
           JOIN media m ON m.id = it."mediaId" AND m.type <> 'album'
           LEFT JOIN watch_party_votes v ON v."proposalId" = p.id
           WHERE p."partyId" = $1 AND p."chosenAt" IS NULL GROUP BY p.id, it.id
           ORDER BY 4 DESC, 5 ASC LIMIT 2"#,
    )
    .bind(party)
    .fetch_all(db)
    .await?;
    if let [a, b] = rows.as_slice()
        && (a.3, a.4) == (b.3, b.4)
    {
        return Err(fail(StatusCode::CONFLICT, "party.error_vote_tie"));
    }
    Ok(rows
        .first()
        .map(|&(media_id, episode_id, item_id, ..)| Item {
            media_id,
            media_file_id: None,
            item_id: Some(item_id),
            episode_id,
        }))
}

/// Drops the votes and the proposals of users who left the party (kicked, quit, revoked): they
/// no longer count in `top`. The others are told when something went.
pub(super) async fn forget_users(
    st: &AppState,
    row: &db::Row,
    users: &[i32],
) -> Result<(), AppError> {
    let votes = sqlx::query(
        r#"DELETE FROM watch_party_votes v USING watch_party_proposals p
           WHERE v."proposalId" = p.id AND p."partyId" = $1 AND v."userId" = ANY($2)"#,
    )
    .bind(row.id)
    .bind(users)
    .execute(&st.db)
    .await?;
    let proposals = sqlx::query(
        r#"DELETE FROM watch_party_proposals WHERE "partyId" = $1 AND "proposedBy" = ANY($2)"#,
    )
    .bind(row.id)
    .bind(users)
    .execute(&st.db)
    .await?;
    if votes.rows_affected() + proposals.rows_affected() > 0 {
        announce(st, row).await?;
    }
    Ok(())
}

pub(super) async fn clear(db: &PgPool, party: i32) -> sqlx::Result<()> {
    sqlx::query(r#"DELETE FROM watch_party_proposals WHERE "partyId" = $1"#)
        .bind(party)
        .execute(db)
        .await?;
    Ok(())
}

/// The row of a party a member may still propose on (`live` only for tracks, checked by the
/// caller); the machine of a lobby is not needed.
async fn open_row(st: &AppState, id: i32, me: i32) -> R<db::Row> {
    let row = member_row(st, id, me).await?;
    require_open(&row)?;
    Ok(row)
}

async fn queue_cap(st: &AppState) -> i64 {
    crate::settings::setting_value(&st.db, "karaoke.queue_cap")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_QUEUE_CAP)
        .clamp(1, 20)
}

/// Adds the proposal, or only the caller's vote when the title is already proposed.
#[utoipa::path(post, path = "/api/parties/{id}/proposals", responses((status = 201), (status = 200)))]
pub async fn propose(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<ProposalIn>,
) -> R<(StatusCode, Json<Vec<ProposalDto>>)> {
    add_proposals(&st, &a, id, vec![b]).await
}

/// [`propose`] for several titles at once, in order: one request against the rate limit.
#[utoipa::path(post, path = "/api/parties/{id}/proposals/batch", responses((status = 201), (status = 200)))]
pub async fn propose_batch(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<ProposalsIn>,
) -> R<(StatusCode, Json<Vec<ProposalDto>>)> {
    if b.items.is_empty() || b.items.len() > MAX_PROPOSALS as usize {
        return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid_item"));
    }
    add_proposals(&st, &a, id, b.items).await
}

async fn add_proposals(
    st: &AppState,
    a: &Authed,
    id: i32,
    items: Vec<ProposalIn>,
) -> R<(StatusCode, Json<Vec<ProposalDto>>)> {
    let me = a.user.id;
    let row = open_row(st, id, me).await?;
    if !st
        .parties
        .proposal_ok(me, now_ms(), RATE_WINDOW_MS, MAX_PER_WINDOW)
    {
        return Err(fail(
            StatusCode::TOO_MANY_REQUESTS,
            "party.error_rate_limited",
        ));
    }
    let ids = accessible_library_ids(&st.db, a).await?;
    let items: Vec<Item> = items
        .into_iter()
        .map(|b| Item {
            media_id: b.media_id,
            media_file_id: None,
            item_id: b.item_id,
            episode_id: b.episode_id,
        })
        .collect();
    let mut targets = Vec::with_capacity(items.len());
    for item in &items {
        assert_media_accessible(&st.db, item.media_id, &ids).await?;
        super::routes::check_item(st, item, &ids).await?;
        let (target, track): (i32, bool) = sqlx::query_as(
            r#"SELECT t.id, m.type = 'album' FROM items t JOIN media m ON m.id = t."mediaId"
               WHERE t.id = COALESCE($1, item_of($2, $3))"#,
        )
        .bind(item.item_id)
        .bind(item.media_id)
        .bind(item.episode_id)
        .fetch_one(&st.db)
        .await?;
        if row.status != "scheduled" && !track {
            return Err(fail(StatusCode::CONFLICT, "party.error_not_scheduled"));
        }
        targets.push((target, track));
    }
    let cap = queue_cap(st).await;
    let mut tx = st.db.begin().await?;
    // The party row lock serializes the counts and the insert.
    sqlx::query(
        r#"SELECT 1 FROM watch_parties WHERE id = $1 AND status IN ('scheduled', 'live') FOR UPDATE"#,
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| fail(StatusCode::CONFLICT, "party.error_not_scheduled"))?;
    let mut added = 0;
    for &(target, track) in &targets {
        let existing: Option<i32> = sqlx::query_scalar(
            r#"SELECT id FROM watch_party_proposals
               WHERE "partyId" = $1 AND "itemId" = $2 AND "chosenAt" IS NULL"#,
        )
        .bind(id)
        .bind(target)
        .fetch_optional(&mut *tx)
        .await?;
        let pid = match existing {
            Some(pid) => pid,
            None => {
                if track {
                    let queued: bool = sqlx::query_scalar(
                        r#"SELECT EXISTS (SELECT 1 FROM watch_party_items i JOIN watch_parties p ON p.id = i."partyId"
                           WHERE i."partyId" = $1 AND i."itemId" = $2
                             AND (p.status = 'scheduled' OR i."itemId" IS NOT DISTINCT FROM p."itemId"
                                  OR i.position > COALESCE((SELECT c.position FROM watch_party_items c
                                                            WHERE c."partyId" = $1 AND c."itemId" = p."itemId"), -1)))"#,
                    )
                    .bind(id)
                    .bind(target)
                    .fetch_one(&mut *tx)
                    .await?;
                    if queued {
                        return Err(fail(StatusCode::CONFLICT, "party.error_in_programme"));
                    }
                    let mine: i64 = sqlx::query_scalar(
                        r#"SELECT count(*) FROM watch_party_proposals p
                           JOIN items it ON it.id = p."itemId"
                           JOIN media m ON m.id = it."mediaId" AND m.type = 'album'
                           WHERE p."partyId" = $1 AND p."proposedBy" = $2 AND p."chosenAt" IS NULL"#,
                    )
                    .bind(id)
                    .bind(me)
                    .fetch_one(&mut *tx)
                    .await?;
                    if mine >= cap {
                        return Err(fail(StatusCode::CONFLICT, "party.error_queue_full"));
                    }
                }
                let count: i64 = sqlx::query_scalar(
                    r#"SELECT count(*) FROM watch_party_proposals
                       WHERE "partyId" = $1 AND "chosenAt" IS NULL"#,
                )
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
                if count >= MAX_PROPOSALS {
                    return Err(fail(StatusCode::CONFLICT, "party.error_proposals_full"));
                }
                added += 1;
                sqlx::query_scalar(
                    r#"INSERT INTO watch_party_proposals ("partyId", "itemId", "proposedBy")
                       VALUES ($1, $2, $3) RETURNING id"#,
                )
                .bind(id)
                .bind(target)
                .bind(me)
                .fetch_one(&mut *tx)
                .await?
            }
        };
        sqlx::query(
            r#"INSERT INTO watch_party_votes ("proposalId", "userId") VALUES ($1, $2)
               ON CONFLICT ("proposalId", "userId") DO UPDATE SET "value" = 1"#,
        )
        .bind(pid)
        .bind(me)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    announce(st, &row).await?;
    if added > 0 {
        let by = &a.user.username;
        note(
            st,
            &row,
            "proposed",
            by,
            item_args(&items[0], json!({ "count": added })),
        )
        .await?;
    }
    let status = if added > 0 {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(snapshot(st, id, me).await?)))
}

/// `args` of a system message about `item`, plus `extra`.
fn item_args(item: &Item, mut extra: Value) -> Value {
    extra["mediaId"] = item.media_id.into();
    extra["episodeId"] = item.episode_id.into();
    extra
}

/// Who proposed `pid` of party `id` and its title, 404 when it is not one of its proposals.
async fn proposal(st: &AppState, id: i32, pid: i32) -> R<(i32, Item)> {
    let (by, media_id, episode_id, item_id): (i32, i32, Option<i32>, Option<i32>) = sqlx::query_as(
        r#"SELECT p."proposedBy", it."mediaId", CASE WHEN it."groupId" IS NOT NULL THEN it.id END,
                  CASE WHEN m.type = 'album' THEN it.id END
           FROM watch_party_proposals p JOIN items it ON it.id = p."itemId"
           JOIN media m ON m.id = it."mediaId"
           WHERE p.id = $1 AND p."partyId" = $2 AND p."chosenAt" IS NULL"#,
    )
    .bind(pid)
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(not_found)?;
    let item = Item {
        media_id,
        media_file_id: None,
        item_id,
        episode_id,
    };
    Ok((by, item))
}

#[utoipa::path(delete, path = "/api/parties/{id}/proposals/{pid}", responses((status = 204)))]
pub async fn unpropose(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, pid)): PathParams<(i32, i32)>,
) -> R<StatusCode> {
    let me = a.user.id;
    let row = open_row(&st, id, me).await?;
    // The gate orders a cancel against a `choose` of the same proposal.
    let _held = hold(&st, id).await;
    if proposal(&st, id, pid).await?.0 != me && host_of(&st, &row) != me {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_not_author"));
    }
    sqlx::query("DELETE FROM watch_party_proposals WHERE id = $1")
        .bind(pid)
        .execute(&st.db)
        .await?;
    announce(&st, &row).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_vote(
    st: &AppState,
    a: &Authed,
    id: i32,
    pid: i32,
    value: Option<i16>,
) -> R<StatusCode> {
    let me = a.user.id;
    let row = open_row(st, id, me).await?;
    let (_, item) = proposal(st, id, pid).await?;
    if !st
        .parties
        .proposal_ok(me, now_ms(), RATE_WINDOW_MS, MAX_PER_WINDOW)
    {
        return Err(fail(
            StatusCode::TOO_MANY_REQUESTS,
            "party.error_rate_limited",
        ));
    }
    let done = match value {
        Some(value) => sqlx::query(
            r#"INSERT INTO watch_party_votes ("proposalId", "userId", "value") VALUES ($1, $2, $3)
                   ON CONFLICT ("proposalId", "userId") DO UPDATE SET "value" = $3
                   WHERE watch_party_votes."value" <> $3"#,
        )
        .bind(pid)
        .bind(me)
        .bind(value)
        .execute(&st.db)
        .await?,
        None => {
            sqlx::query(
                r#"DELETE FROM watch_party_votes WHERE "proposalId" = $1 AND "userId" = $2"#,
            )
            .bind(pid)
            .bind(me)
            .execute(&st.db)
            .await?
        }
    };
    if done.rows_affected() == 0 {
        return Ok(StatusCode::NO_CONTENT);
    }
    announce(st, &row).await?;
    if let Some(value) = value {
        note(
            st,
            &row,
            "voted",
            &a.user.username,
            item_args(&item, json!({ "value": value })),
        )
        .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(put, path = "/api/parties/{id}/proposals/{pid}/vote", responses((status = 204)))]
pub async fn vote(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, pid)): PathParams<(i32, i32)>,
    ValidJson(b): ValidJson<VoteIn>,
) -> R<StatusCode> {
    set_vote(&st, &a, id, pid, Some(b.value)).await
}

#[utoipa::path(delete, path = "/api/parties/{id}/proposals/{pid}/vote", responses((status = 204)))]
pub async fn unvote(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, pid)): PathParams<(i32, i32)>,
) -> R<StatusCode> {
    set_vote(&st, &a, id, pid, None).await
}

/// The host picks a proposal: it joins the end of the programme (the head when it is empty).
#[utoipa::path(post, path = "/api/parties/{id}/proposals/{pid}/choose", responses((status = 200)))]
pub async fn choose(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, pid)): PathParams<(i32, i32)>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    let mut row = open_row(&st, id, me).await?;
    require_host(&st, &row, me)?;
    let _held = hold(&st, id).await;
    take(&st, &a, &mut row, pid).await?;
    Ok(Json(super::routes::dto(&st, &row, me, true).await?))
}

/// The host plays the head of the singer queue (`karaoke.md` rule 37).
#[utoipa::path(post, path = "/api/parties/{id}/proposals/next", responses((status = 200)))]
pub async fn next_singer(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<NextIn>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    let mut row = open_row(&st, id, me).await?;
    require_host(&st, &row, me)?;
    let advance = match (b.from, b.device_id) {
        (Some(from), Some(device)) => Some((Item::from(from), device)),
        (None, _) => None,
        (Some(_), None) => return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid")),
    };
    let _held = hold(&st, id).await;
    if let Some((from, _)) = &advance {
        let idle_on_from = st.parties.view(id).is_some_and(|v| {
            v.item.as_ref().is_some_and(|i| same_row(i, from))
                && v.playback.is_some_and(|p| p.state == PlayState::Idle)
        });
        if !idle_on_from {
            return Ok(Json(super::routes::dto(&st, &row, me, true).await?));
        }
    }
    let queue = queue(&st.db, id).await?;
    if queue.is_empty() {
        return Err(fail(StatusCode::CONFLICT, "party.error_queue_empty"));
    }
    // A head some member cannot open is passed over, not left to block the queue.
    let mut passed = vec![];
    let mut refused = None;
    let mut taken = false;
    for pid in queue {
        match take(&st, &a, &mut row, pid).await {
            Ok(()) => {
                taken = true;
                break;
            }
            Err(e @ PartyError::Extra(_, "party.error_member_no_access", ..)) => {
                passed.push(proposal(&st, id, pid).await?.1);
                refused.get_or_insert(e);
            }
            Err(e) => return Err(e),
        }
    }
    if !taken {
        return Err(refused.expect("a non-empty queue"));
    }
    for item in &passed {
        note_held(
            &st,
            &row,
            "item_skipped",
            &a.user.username,
            item_args(item, json!({})),
        )
        .await?;
    }
    if let Some((_, device)) = advance {
        advance_held(&st, &row, me, &device).await?;
    }
    Ok(Json(super::routes::dto(&st, &row, me, true).await?))
}

/// Appends proposal `pid`'s item to the programme; a track proposal leaves the queue but keeps
/// its singer's turn. The caller holds the party's gate.
async fn take(st: &AppState, a: &Authed, row: &mut db::Row, pid: i32) -> R<()> {
    let (_, item) = proposal(st, row.id, pid).await?;
    let track = item.item_id.is_some();
    let edit = if track {
        Edit::Requeue(item.clone())
    } else {
        Edit::Append(item.clone())
    };
    edit_held(st, a, row, edit).await?;
    if track {
        sqlx::query(r#"UPDATE watch_party_proposals SET "chosenAt" = now() WHERE id = $1"#)
            .bind(pid)
            .execute(&st.db)
            .await?;
        announce(st, row).await?;
    }
    note_held(
        st,
        row,
        "proposal_chosen",
        &a.user.username,
        item_args(&item, json!({})),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_go_singer_by_singer_the_least_recent_first() {
        // a: 1 2 3, b: 4, c: 5 6; c sang last night, a never, b earlier.
        let all = [(1, 10), (2, 10), (3, 10), (4, 20), (5, 30), (6, 30)];
        let last = HashMap::from([(30, 900), (20, 100)]);
        assert_eq!(round_robin(&all, &last), [1, 4, 5, 2, 6, 3]);
        assert_eq!(round_robin(&all, &HashMap::new()), [1, 4, 5, 2, 6, 3]);
        assert!(round_robin(&[], &last).is_empty());
    }
}

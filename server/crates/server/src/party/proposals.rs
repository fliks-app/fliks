//! Film proposals and votes of a `scheduled` party (`docs/spec/watch-party.md`, Proposals).
use super::{
    db,
    dto::{PartyDto, PartyItem, ProposalDto, ProposalIn},
    registry::item_dtos,
    routes::{
        R, conceal_items, fail, host_of, member_row, not_found, require_host, require_open,
        select_item,
    },
};
use crate::{
    events::SseEvent,
    http::{
        AppError,
        auth::SessionAuthed,
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
use fliks_domain::{js::now_ms, party::Item};
use sqlx::PgPool;

const MAX_PROPOSALS: i64 = 30;
const RATE_WINDOW_MS: i64 = 10_000;
const MAX_PER_WINDOW: usize = 10;

pub(super) fn proposal_router() -> Router<AppState> {
    Router::new()
        .route("/api/parties/{id}/proposals", post(propose))
        .route("/api/parties/{id}/proposals/{pid}", delete(unpropose))
        .route(
            "/api/parties/{id}/proposals/{pid}/vote",
            delete(unvote).put(vote),
        )
        .route("/api/parties/{id}/proposals/{pid}/choose", post(choose))
}

type Raw = (i32, i32, Option<i32>, i32, Vec<i32>);

async fn raw(db: &PgPool, party: i32) -> sqlx::Result<Vec<Raw>> {
    sqlx::query_as(
        r#"SELECT p.id, p."mediaId", p."episodeId", p."proposedBy",
                  COALESCE(array_agg(v."userId" ORDER BY v."userId") FILTER (WHERE v."userId" IS NOT NULL), '{}')
           FROM watch_party_proposals p
           LEFT JOIN watch_party_votes v ON v."proposalId" = p.id
           WHERE p."partyId" = $1
           GROUP BY p.id ORDER BY p."createdAt", p.id"#,
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
    let mut out = resolve(st, raw(&st.db, party).await?).await?;
    conceal(st, viewer, &mut out).await?;
    Ok(out)
}

async fn resolve(st: &AppState, rows: Vec<Raw>) -> Result<Vec<ProposalDto>, AppError> {
    let items: Vec<Item> = rows
        .iter()
        .map(|r| Item {
            media_id: r.1,
            media_file_id: None,
            episode_id: r.2,
        })
        .collect();
    let items = item_dtos(st, &items).await?;
    Ok(rows
        .into_iter()
        .zip(items)
        .map(|((id, _, _, proposed_by, voter_ids), item)| ProposalDto {
            id,
            item,
            proposed_by,
            voter_ids,
        })
        .collect())
}

async fn conceal(st: &AppState, viewer: i32, all: &mut [ProposalDto]) -> Result<(), AppError> {
    let mut items: Vec<&mut PartyItem> = all.iter_mut().map(|p| &mut p.item).collect();
    conceal_items(st, viewer, &mut items).await
}

/// Sends every owner and guest their own view of the proposals.
async fn announce(st: &AppState, row: &db::Row) -> Result<(), AppError> {
    let all = resolve(st, raw(&st.db, row.id).await?).await?;
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

/// The proposal the start takes: most votes, then the oldest.
pub(super) async fn top(db: &PgPool, party: i32) -> sqlx::Result<Option<Item>> {
    let row: Option<(i32, Option<i32>)> = sqlx::query_as(
        r#"SELECT p."mediaId", p."episodeId" FROM watch_party_proposals p
           WHERE p."partyId" = $1
           ORDER BY (SELECT count(*) FROM watch_party_votes v WHERE v."proposalId" = p.id) DESC,
                    p."createdAt", p.id
           LIMIT 1"#,
    )
    .bind(party)
    .fetch_optional(db)
    .await?;
    Ok(row.map(|(media_id, episode_id)| Item {
        media_id,
        media_file_id: None,
        episode_id,
    }))
}

pub(super) async fn clear(db: &PgPool, party: i32) -> sqlx::Result<()> {
    sqlx::query(r#"DELETE FROM watch_party_proposals WHERE "partyId" = $1"#)
        .bind(party)
        .execute(db)
        .await?;
    Ok(())
}

/// The row of a party a member may still propose on; the machine of a lobby is not needed.
async fn open_row(st: &AppState, id: i32, me: i32) -> R<db::Row> {
    let row = member_row(st, id, me).await?;
    require_open(&row)?;
    if row.status != "scheduled" {
        return Err(fail(StatusCode::CONFLICT, "party.error_not_scheduled"));
    }
    Ok(row)
}

/// Adds the proposal, or only the caller's vote when the title is already proposed.
#[utoipa::path(post, path = "/api/parties/{id}/proposals", responses((status = 201), (status = 200)))]
pub async fn propose(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<ProposalIn>,
) -> R<(StatusCode, Json<Vec<ProposalDto>>)> {
    let me = a.user.id;
    let row = open_row(&st, id, me).await?;
    if !st
        .parties
        .proposal_ok(me, now_ms(), RATE_WINDOW_MS, MAX_PER_WINDOW)
    {
        return Err(fail(
            StatusCode::TOO_MANY_REQUESTS,
            "party.error_rate_limited",
        ));
    }
    let item = Item {
        media_id: b.media_id,
        media_file_id: None,
        episode_id: b.episode_id,
    };
    if !db::item_valid(&st.db, &item).await? {
        return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid_item"));
    }
    let ids = accessible_library_ids(&st.db, &a).await?;
    assert_media_accessible(&st.db, item.media_id, &ids).await?;
    let mut tx = st.db.begin().await?;
    // The party row lock serializes the count and the insert.
    sqlx::query(r#"SELECT 1 FROM watch_parties WHERE id = $1 AND status = 'scheduled' FOR UPDATE"#)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| fail(StatusCode::CONFLICT, "party.error_not_scheduled"))?;
    let existing: Option<i32> = sqlx::query_scalar(
        r#"SELECT id FROM watch_party_proposals
           WHERE "partyId" = $1 AND "mediaId" = $2 AND COALESCE("episodeId", 0) = COALESCE($3, 0)"#,
    )
    .bind(id)
    .bind(item.media_id)
    .bind(item.episode_id)
    .fetch_optional(&mut *tx)
    .await?;
    let created = existing.is_none();
    let pid = match existing {
        Some(pid) => pid,
        None => {
            let count: i64 = sqlx::query_scalar(
                r#"SELECT count(*) FROM watch_party_proposals WHERE "partyId" = $1"#,
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            if count >= MAX_PROPOSALS {
                return Err(fail(StatusCode::CONFLICT, "party.error_proposals_full"));
            }
            sqlx::query_scalar(
                r#"INSERT INTO watch_party_proposals ("partyId", "mediaId", "episodeId", "proposedBy")
                   VALUES ($1, $2, $3, $4) RETURNING id"#,
            )
            .bind(id)
            .bind(item.media_id)
            .bind(item.episode_id)
            .bind(me)
            .fetch_one(&mut *tx)
            .await?
        }
    };
    sqlx::query(
        r#"INSERT INTO watch_party_votes ("proposalId", "userId") VALUES ($1, $2) ON CONFLICT DO NOTHING"#,
    )
    .bind(pid)
    .bind(me)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    announce(&st, &row).await?;
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(snapshot(&st, id, me).await?)))
}

/// Who proposed `pid` of party `id`, 404 when it is not one of its proposals.
async fn author(st: &AppState, id: i32, pid: i32) -> R<i32> {
    sqlx::query_scalar(
        r#"SELECT "proposedBy" FROM watch_party_proposals WHERE id = $1 AND "partyId" = $2"#,
    )
    .bind(pid)
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(not_found)
}

#[utoipa::path(delete, path = "/api/parties/{id}/proposals/{pid}", responses((status = 204)))]
pub async fn unpropose(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, pid)): PathParams<(i32, i32)>,
) -> R<StatusCode> {
    let me = a.user.id;
    let row = open_row(&st, id, me).await?;
    if author(&st, id, pid).await? != me && host_of(&st, &row) != me {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_not_author"));
    }
    sqlx::query("DELETE FROM watch_party_proposals WHERE id = $1")
        .bind(pid)
        .execute(&st.db)
        .await?;
    announce(&st, &row).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_vote(st: &AppState, id: i32, pid: i32, me: i32, on: bool) -> R<StatusCode> {
    let row = open_row(st, id, me).await?;
    author(st, id, pid).await?;
    let sql = if on {
        r#"INSERT INTO watch_party_votes ("proposalId", "userId") VALUES ($1, $2) ON CONFLICT DO NOTHING"#
    } else {
        r#"DELETE FROM watch_party_votes WHERE "proposalId" = $1 AND "userId" = $2"#
    };
    sqlx::query(sql).bind(pid).bind(me).execute(&st.db).await?;
    announce(st, &row).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(put, path = "/api/parties/{id}/proposals/{pid}/vote", responses((status = 204)))]
pub async fn vote(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, pid)): PathParams<(i32, i32)>,
) -> R<StatusCode> {
    set_vote(&st, id, pid, a.user.id, true).await
}

#[utoipa::path(delete, path = "/api/parties/{id}/proposals/{pid}/vote", responses((status = 204)))]
pub async fn unvote(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, pid)): PathParams<(i32, i32)>,
) -> R<StatusCode> {
    set_vote(&st, id, pid, a.user.id, false).await
}

/// The host picks a proposal: the same path as `select`.
#[utoipa::path(post, path = "/api/parties/{id}/proposals/{pid}/choose", responses((status = 200)))]
pub async fn choose(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, pid)): PathParams<(i32, i32)>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    let mut row = open_row(&st, id, me).await?;
    require_host(&st, &row, me)?;
    let (media_id, episode_id): (i32, Option<i32>) = sqlx::query_as(
        r#"SELECT "mediaId", "episodeId" FROM watch_party_proposals WHERE id = $1 AND "partyId" = $2"#,
    )
    .bind(pid)
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(not_found)?;
    let item = Item {
        media_id,
        media_file_id: None,
        episode_id,
    };
    select_item(&st, &a, &mut row, item).await?;
    Ok(Json(super::routes::dto(&st, &row, me, true).await?))
}

//! Adding to and removing from the programme, the party's one queue (`docs/spec/watch-party.md`,
//! Programme; `docs/spec/karaoke.md` rule 37).
use super::{
    db,
    dto::{AddIn, MAX_PROGRAMME, PartyDto},
    registry::hold,
    routes::{Edit, R, dto, edit_held, fail, host_of, member_row, not_found, require_open, row_of},
};
use crate::{
    http::{
        auth::SessionAuthed,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{delete, post},
};
use fliks_domain::party::{Item, Policy, Rule, same_row};

const DEFAULT_QUEUE_CAP: usize = 2;

pub(super) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/parties/{id}/programme/items", post(add_items))
        .route(
            "/api/parties/{id}/programme/items/{itemId}",
            delete(remove_item),
        )
}

async fn queue_cap(st: &AppState) -> usize {
    crate::settings::setting_value(&st.db, "karaoke.queue_cap")
        .await
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_QUEUE_CAP)
        .clamp(1, 20)
}

/// Adds rows right after the playing one or at the end; a member of a party that takes turns has
/// them placed by turn, within `karaoke.queue_cap` upcoming rows.
#[utoipa::path(post, path = "/api/parties/{id}/programme/items", responses((status = 200)))]
pub async fn add_items(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams(id): PathParams<i32>,
    ValidJson(b): ValidJson<AddIn>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    if b.items.is_empty() || b.items.len() > MAX_PROGRAMME {
        return Err(fail(StatusCode::BAD_REQUEST, "party.error_invalid_item"));
    }
    let mut row = member_row(&st, id, me).await?;
    require_open(&row)?;
    let _held = hold(&st, id).await;
    row = row_of(&st, id).await?;
    let host = host_of(&st, &row) == me;
    if !host && row.policy != Policy::Everyone {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_host_only"));
    }
    let rule = if !host && row.rotation {
        Rule::Turns {
            cap: queue_cap(&st).await,
        }
    } else {
        Rule::At(b.place)
    };
    let items = b.items.into_iter().map(Item::from).collect();
    edit_held(&st, &a, &mut row, Edit::Add(items, rule)).await?;
    Ok(Json(dto(&st, &row, me, true).await?))
}

/// The host removes any row but the playing one; a member removes the upcoming rows they added.
#[utoipa::path(delete, path = "/api/parties/{id}/programme/items/{itemId}", responses((status = 200)))]
pub async fn remove_item(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    PathParams((id, item_id)): PathParams<(i32, i32)>,
) -> R<Json<PartyDto>> {
    let me = a.user.id;
    let mut row = member_row(&st, id, me).await?;
    require_open(&row)?;
    let _held = hold(&st, id).await;
    row = row_of(&st, id).await?;
    let rows = db::programme_rows(&st.db, id).await?;
    let at = rows
        .iter()
        .position(|r| r.item.item_id == Some(item_id))
        .ok_or_else(not_found)?;
    let playing = (row.status == "live")
        .then(|| row.item())
        .flatten()
        .and_then(|c| rows.iter().position(|r| same_row(&r.item, &c)));
    if playing == Some(at) {
        return Err(fail(StatusCode::CONFLICT, "party.error_item_playing"));
    }
    if host_of(&st, &row) != me
        && (rows[at].added_by != Some(me) || playing.is_some_and(|p| at < p))
    {
        return Err(fail(StatusCode::FORBIDDEN, "party.error_not_author"));
    }
    let item = rows[at].item.clone();
    edit_held(&st, &a, &mut row, Edit::Remove(item)).await?;
    Ok(Json(dto(&st, &row, me, true).await?))
}

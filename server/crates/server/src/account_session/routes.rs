//! `GET`/`DELETE /api/session` (`docs/spec/session.md`).
use super::{QueueState, Row, State, store};
use crate::{
    events::{Num, event::Queue},
    http::{AppError, auth::SessionAuthed, json::iso_ms, validate::ValidJson},
    remote::{authorize_target, dto::Command, send},
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State as AxumState,
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use fliks_domain::media::kind::MediaKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/session", get(show).delete(dismiss))
        .route("/api/session/transfer", post(transfer))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDto {
    id: i32,
    media_id: i32,
    episode_id: Option<i32>,
    media_file_id: Option<i32>,
    kind: MediaKind,
    family: Option<String>,
    title: Option<String>,
    subtitle: Option<String>,
    poster_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerDto {
    target_id: Option<String>,
    device_name: Option<String>,
    form_factor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSessionDto {
    epoch: i64,
    item: ItemDto,
    owner: OwnerDto,
    state: &'static str,
    position_seconds: f64,
    #[serde(with = "iso_ms")]
    position_at: DateTime<Utc>,
    playing: bool,
    duration_seconds: Option<f64>,
    queue: Option<QueueState>,
}

fn dto(r: Row, shown: store::Shown) -> AccountSessionDto {
    AccountSessionDto {
        epoch: r.epoch,
        item: ItemDto {
            id: r.item_id,
            media_id: shown.media_id,
            episode_id: shown.episode_id,
            media_file_id: r.media_file_id,
            kind: r.kind,
            family: shown.family,
            title: shown.title,
            subtitle: shown.subtitle,
            poster_url: shown.poster_url,
        },
        owner: OwnerDto {
            target_id: r.owner.target_id,
            device_name: r.owner.device_name,
            form_factor: r.owner.form_factor,
        },
        state: r.state.as_str(),
        position_seconds: r.position,
        position_at: r.updated_at,
        playing: r.state == State::Playing,
        duration_seconds: r.duration,
        queue: r.queue,
    }
}

#[utoipa::path(get, path = "/api/session", responses((status = 200)))]
pub async fn show(
    AxumState(st): AxumState<AppState>,
    SessionAuthed(a): SessionAuthed,
) -> Result<Json<Option<AccountSessionDto>>, AppError> {
    let Some(row) = st.account_sessions.get(&st, a.user.id).await else {
        return Ok(Json(None));
    };
    let Some(shown) = store::shown(&st.db, row.item_id).await? else {
        st.account_sessions.forget(a.user.id).await;
        return Ok(Json(None));
    };
    Ok(Json(Some(dto(row, shown))))
}

#[utoipa::path(delete, path = "/api/session", responses((status = 204), (status = 409)))]
pub async fn dismiss(
    AxumState(st): AxumState<AppState>,
    SessionAuthed(a): SessionAuthed,
) -> Result<StatusCode, AppError> {
    st.account_sessions.dismiss(&st, a.user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Transfer {
    to_target_id: String,
}

/// `session.md` rule 18: the position the owner is at now, extrapolated while it plays.
fn position_now(r: &Row) -> f64 {
    let elapsed = if r.state == State::Playing {
        (Utc::now() - r.updated_at).num_milliseconds().max(0) as f64 / 1000.0
    } else {
        0.0
    };
    let at = r.position + elapsed;
    r.duration.map_or(at, |d| at.min(d))
}

#[utoipa::path(post, path = "/api/session/transfer", responses((status = 202), (status = 400), (status = 403), (status = 404)))]
pub async fn transfer(
    AxumState(st): AxumState<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(body): ValidJson<Transfer>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let no_session = || AppError::not_found("session.error_no_session");
    let row = st
        .account_sessions
        .get(&st, a.user.id)
        .await
        .ok_or_else(no_session)?;
    let (owner, conn) = authorize_target(&st, &a, &body.to_target_id).await?;
    let held = row.state != State::Parked;
    if held && row.owner.target_id.as_deref() == Some(&body.to_target_id) {
        return Err(AppError::bad_request("remote.error_self_target"));
    }
    let shown = store::shown(&st.db, row.item_id)
        .await?
        .ok_or_else(no_session)?;
    if matches!(shown.family.as_deref(), Some("text" | "image")) {
        return Err(AppError::bad_request("session.error_not_transferable"));
    }
    let queue = row.queue.as_ref();
    let cmd = Command {
        action: crate::events::event::RemoteAction::Load,
        media_id: Some(i64::from(shown.media_id)),
        media_type: None,
        media_file_id: row.media_file_id.map(i64::from),
        episode_id: shown.episode_id.map(i64::from),
        item_id: Some(i64::from(row.item_id)),
        position_seconds: Some(Num(position_now(&row))),
        level: None,
        muted: None,
        track_id: None,
        subtitle_id: None,
        quality_id: None,
        paused: Some(matches!(row.state, State::Paused | State::Parked)),
        by_target_id: None,
        queue: queue.map(|q| Queue {
            item_ids: q.item_ids.clone(),
            index: q.index,
        }),
        shuffle: queue.map(|q| q.shuffle),
        repeat: queue.map(|q| q.repeat),
        kind: Some(row.kind),
    };
    send(&st, &a, &body.to_target_id, owner, &conn, cmd)
}

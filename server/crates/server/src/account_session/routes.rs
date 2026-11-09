//! `GET`/`DELETE /api/session` (`docs/spec/session.md`).
use super::{QueueState, Row, State, store};
use crate::{
    http::{AppError, auth::SessionAuthed, json::iso_ms},
    state::AppState,
};
use axum::{Json, Router, extract::State as AxumState, http::StatusCode, routing::get};
use chrono::{DateTime, Utc};
use fliks_domain::media::kind::MediaKind;
use serde::Serialize;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/session", get(show).delete(dismiss))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDto {
    id: i32,
    media_file_id: Option<i32>,
    kind: MediaKind,
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
            media_file_id: r.media_file_id,
            kind: r.kind,
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

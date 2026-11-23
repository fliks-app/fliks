//! `POST /api/media/:id/move` (rule 101); the move itself is `media::service::relocate`.
use super::gate;
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    media::service::{body::Body, start},
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::acl::Action;
use serde_json::{Value, json};

#[utoipa::path(post, path = "/api/media/{id}/move", responses((status = 202)))]
pub async fn move_media(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    ValidJson(v): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    let id = gate(&st, &a, Action::Update, id).await?;
    let b = Body::new(v, &["folderId"])?;
    let folder = b.required(b.id("folderId")?, "folderId", "must be an integer number")?;
    start(&st, &a, id, folder).await?;
    Ok((StatusCode::ACCEPTED, Json(json!({"ok": true}))))
}

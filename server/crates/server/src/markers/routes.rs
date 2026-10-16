use super::{db, detect};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, from_value, int_param},
    },
    jobs::{Command, Trigger},
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use fliks_domain::acl::{Action, Subject};
use serde::Deserialize;
use serde_json::Value;

type Res<T> = Result<T, AppError>;

const TYPES: [&str; 3] = ["intro", "outro", "recap"];
const ORDER: &str = "endSeconds must be > startSeconds";

fn id_of(PathParams(raw): PathParams<String>) -> Res<i32> {
    int_param(&raw)
}

fn read(a: &Authed) -> Res<()> {
    a.require(Action::Read, Subject::Media)
}

/// `Manage Media`: held only by admins and `manage:all`.
fn manage(a: &Authed) -> Res<()> {
    a.require(Action::Manage, Subject::Media)
}

/// Absent and `null` both read as `None` (`@IsOptional` or a missing required field).
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawDto {
    episode_id: Option<Value>,
    r#type: Option<Value>,
    start_seconds: Option<Value>,
    end_seconds: Option<Value>,
}

/// `@IsNumber() @Min(0)`: class-validator lists `Min` first.
fn seconds(key: &str, v: Option<&Value>, optional: bool, msgs: &mut Vec<String>) -> Option<f64> {
    match v {
        None if optional => None,
        Some(Value::Number(n)) if n.as_f64().is_some_and(|f| f >= 0.0) => n.as_f64(),
        Some(Value::Number(_)) => {
            msgs.push(format!("{key} must not be less than 0"));
            None
        }
        _ => {
            msgs.push(format!("{key} must not be less than 0"));
            msgs.push(format!(
                "{key} must be a number conforming to the specified constraints"
            ));
            None
        }
    }
}

struct Create {
    episode_id: i64,
    kind: String,
    start: f64,
    end: f64,
}

fn parse_create(body: Value) -> Res<Create> {
    let raw: RawDto = from_value(body)?;
    let mut msgs = vec![];
    let episode_id = match &raw.episode_id {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
        _ => None,
    };
    if episode_id.is_none() {
        msgs.push("episodeId must be an integer number".to_owned());
    }
    let kind = raw
        .r#type
        .as_ref()
        .and_then(Value::as_str)
        .filter(|t| TYPES.contains(t));
    if kind.is_none() {
        msgs.push("type must be one of the following values: intro, outro, recap".into());
    }
    let start = seconds("startSeconds", raw.start_seconds.as_ref(), false, &mut msgs);
    let end = seconds("endSeconds", raw.end_seconds.as_ref(), false, &mut msgs);
    let (Some(episode_id), Some(kind), Some(start), Some(end)) = (episode_id, kind, start, end)
    else {
        return Err(AppError::bad_request(msgs));
    };
    Ok(Create {
        episode_id,
        kind: kind.to_owned(),
        start,
        end,
    })
}

/// F43: an unknown, library-less or inaccessible episode / season is 404.
async fn reachable(
    st: &AppState,
    a: &Authed,
    library: Option<Option<i32>>,
    what: &str,
    id: i32,
) -> Res<()> {
    let ids = accessible_library_ids(&st.db, a).await?;
    match library {
        Some(Some(l)) if ids.contains(&l) => Ok(()),
        _ => Err(AppError::not_found(format!("{what} #{id} not found"))),
    }
}

#[utoipa::path(get, path = "/api/markers/episode/{episodeId}", responses((status = 200)))]
pub(crate) async fn list_episode(
    State(st): State<AppState>,
    a: Authed,
    raw: PathParams<String>,
) -> Res<Json<Vec<db::Marker>>> {
    read(&a)?;
    let id = id_of(raw)?;
    let library = db::episode_library(&st.db, id).await?;
    reachable(&st, &a, library, "Episode", id).await?;
    Ok(Json(db::for_episode(&st.db, id).await?))
}

#[utoipa::path(get, path = "/api/markers/season/{seasonId}", responses((status = 200)))]
pub(crate) async fn list_season(
    State(st): State<AppState>,
    a: Authed,
    raw: PathParams<String>,
) -> Res<Json<Vec<db::Marker>>> {
    read(&a)?;
    let id = id_of(raw)?;
    let library = db::season_library(&st.db, id).await?;
    reachable(&st, &a, library, "Season", id).await?;
    Ok(Json(db::for_season(&st.db, id).await?))
}

#[utoipa::path(post, path = "/api/markers/season/{seasonId}/detect", responses((status = 201)))]
pub(crate) async fn detect_season(
    State(st): State<AppState>,
    a: Authed,
    raw: PathParams<String>,
) -> Res<(StatusCode, Json<Command>)> {
    manage(&a)?;
    let id = id_of(raw)?;
    let cmd = detect::detect_season(&st, id, Trigger::Manual).await?;
    Ok((StatusCode::CREATED, Json(cmd)))
}

#[utoipa::path(post, path = "/api/markers/series/{mediaId}/detect-all", responses((status = 201)))]
pub(crate) async fn detect_all(
    State(st): State<AppState>,
    a: Authed,
    raw: PathParams<String>,
) -> Res<(StatusCode, Json<Vec<Command>>)> {
    manage(&a)?;
    let id = id_of(raw)?;
    if !db::media_exists(&st.db, id).await? {
        return Err(AppError::not_found(format!("Media #{id} not found")));
    }
    let cmds = detect::detect_series(&st, id, Trigger::Manual).await?;
    Ok((StatusCode::CREATED, Json(cmds)))
}

#[utoipa::path(post, path = "/api/markers", responses((status = 201)))]
pub(crate) async fn create(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Res<(StatusCode, Json<db::Marker>)> {
    manage(&a)?;
    let dto = parse_create(body)?;
    if dto.end <= dto.start {
        return Err(AppError::bad_request(ORDER));
    }
    let episode = i32::try_from(dto.episode_id).ok().filter(|id| *id >= 1);
    let Some(episode) = episode else {
        return Err(episode_missing(dto.episode_id));
    };
    if !db::episode_exists(&st.db, episode).await? {
        return Err(episode_missing(dto.episode_id));
    }
    let m = db::upsert_manual(&st.db, episode, &dto.kind, dto.start, dto.end).await?;
    Ok((StatusCode::CREATED, Json(m)))
}

fn episode_missing(id: i64) -> AppError {
    AppError::not_found(format!("Episode #{id} not found"))
}

fn marker_missing(id: i32) -> AppError {
    AppError::not_found(format!("Marker #{id} not found"))
}

#[utoipa::path(put, path = "/api/markers/{id}", responses((status = 200)))]
pub(crate) async fn update(
    State(st): State<AppState>,
    a: Authed,
    raw: PathParams<String>,
    ValidJson(body): ValidJson<Value>,
) -> Res<Json<db::Marker>> {
    manage(&a)?;
    let id = id_of(raw)?;
    // A present key is forbidden even when null, one message each.
    let mut msgs: Vec<String> = ["episodeId", "type"]
        .into_iter()
        .filter(|k| body.get(k).is_some())
        .map(|k| format!("property {k} should not exist"))
        .collect();
    let raw: RawDto = from_value(body)?;
    let start = seconds("startSeconds", raw.start_seconds.as_ref(), true, &mut msgs);
    let end = seconds("endSeconds", raw.end_seconds.as_ref(), true, &mut msgs);
    if !msgs.is_empty() {
        return Err(AppError::bad_request(msgs));
    }
    let m = db::find(&st.db, id)
        .await?
        .ok_or_else(|| marker_missing(id))?;
    let (start, end) = (
        start.unwrap_or(m.start_seconds),
        end.unwrap_or(m.end_seconds),
    );
    if end <= start {
        return Err(AppError::bad_request(ORDER));
    }
    // TypeORM wrote only changed columns: an unchanged manual marker keeps its `updatedAt`.
    if m.manual && m.confidence == 1.0 && (start, end) == (m.start_seconds, m.end_seconds) {
        return Ok(Json(m));
    }
    db::set_range(&st.db, id, start, end).await?;
    Ok(Json(
        db::find(&st.db, id)
            .await?
            .ok_or_else(|| marker_missing(id))?,
    ))
}

#[utoipa::path(delete, path = "/api/markers/{id}", responses((status = 200)))]
pub(crate) async fn remove(
    State(st): State<AppState>,
    a: Authed,
    raw: PathParams<String>,
) -> Res<StatusCode> {
    manage(&a)?;
    let id = id_of(raw)?;
    if !db::delete(&st.db, id).await? {
        return Err(marker_missing(id));
    }
    Ok(StatusCode::OK)
}

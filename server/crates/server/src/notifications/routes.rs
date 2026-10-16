use super::{
    db::{self, Connection, Write},
    send::{dispatch, send},
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, int_param},
    },
    state::AppState,
};
use axum::{
    Json,
    body::Bytes,
    extract::{FromRequest, Request, State},
    http::{HeaderMap, StatusCode},
};
use fliks_domain::{
    acl::{Action, Subject},
    notifications::{self as dom, EVENTS},
};
use serde_json::{Map, Value, json};

type Res<T> = Result<T, AppError>;

fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Notification connection #{id} not found"))
}

fn id_of(PathParams(raw): PathParams<String>) -> Res<i32> {
    int_param(&raw)
}

/// Body read after the policy check, as Nest's guards run before its pipes.
async fn body(req: Request) -> Res<Value> {
    Ok(ValidJson::<Value>::from_request(req, &()).await?.0)
}

fn settings_of(body: &Value) -> Map<String, Value> {
    body["settings"].as_object().cloned().unwrap_or_default()
}

/// A validated body as a row write; `stored` carries the secrets over when the type is unchanged.
fn write(body: &Value, stored: Option<&Connection>) -> Res<Write> {
    let typ = body["type"].as_str().unwrap_or_default().to_owned();
    let existing = stored.filter(|c| c.typ == typ).map(|c| &c.settings.0);
    let settings = dom::normalize_settings(&typ, &settings_of(body), existing)
        .map_err(AppError::bad_request)?;
    Ok(Write {
        name: body["name"].as_str().unwrap_or_default().to_owned(),
        typ,
        settings,
        events: body["events"].as_array().map(|a| {
            a.iter()
                .filter_map(|e| e.as_str().map(String::from))
                .collect()
        }),
        enabled: body["enabled"].as_bool(),
    })
}

fn invalid(msgs: Vec<String>) -> Res<()> {
    if msgs.is_empty() {
        Ok(())
    } else {
        Err(AppError::bad_request(msgs))
    }
}

#[utoipa::path(post, path = "/api/notifications", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let body = body(req).await?;
    invalid(dom::validate(&body, None))?;
    let conn = db::insert(&st.db, write(&body, None)?).await?;
    Ok((StatusCode::CREATED, Json(conn.json())))
}

#[utoipa::path(get, path = "/api/notifications", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Value>>> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(
        db::list(&st.db)
            .await?
            .iter()
            .map(Connection::json)
            .collect(),
    ))
}

#[utoipa::path(get, path = "/api/notifications/events", responses((status = 200)))]
pub async fn events(a: Authed) -> Res<Json<Vec<&'static str>>> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(dom::subscribable().collect()))
}

#[utoipa::path(get, path = "/api/notifications/{id}", responses((status = 200)))]
pub async fn get_one(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Res<Json<Value>> {
    a.require(Action::Read, Subject::Settings)?;
    let id = id_of(id)?;
    let conn = db::find(&st.db, id).await?.ok_or_else(|| not_found(id))?;
    Ok(Json(conn.json()))
}

#[utoipa::path(put, path = "/api/notifications/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    req: Request,
) -> Res<Json<Value>> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = id_of(id)?;
    let body = body(req).await?;
    let stored = db::find(&st.db, id).await?;
    let same_type = stored.as_ref().filter(|c| body["type"] == c.typ.as_str());
    let mut msgs = dom::validate(&body, same_type.map(|c| &c.settings.0));
    // C1: Nest stores these nulls and answers 500.
    if body["events"].is_null() && body.get("events").is_some() {
        msgs.push("events must be an array".into());
    }
    if body["enabled"].is_null() && body.get("enabled").is_some() {
        msgs.push("enabled must be a boolean value".into());
    }
    invalid(msgs)?;
    let stored = stored.ok_or_else(|| not_found(id))?;
    let conn = db::update(&st.db, id, write(&body, Some(&stored))?)
        .await?
        .ok_or_else(|| not_found(id))?;
    Ok(Json(conn.json()))
}

#[utoipa::path(delete, path = "/api/notifications/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Res<StatusCode> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = id_of(id)?;
    if db::delete(&st.db, id).await? {
        Ok(StatusCode::OK)
    } else {
        Err(not_found(id))
    }
}

#[utoipa::path(post, path = "/api/notifications/{id}/test", responses((status = 201)))]
pub async fn test(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = id_of(id)?;
    let conn = db::find(&st.db, id).await?.ok_or_else(|| not_found(id))?;
    let payload = json!({"test": true, "message": "Test notification from Fliks"});
    let payload = payload.as_object().cloned().unwrap_or_default();
    let out = match send(&conn, "health.issue", &payload).await {
        Ok(()) => json!({"ok": true, "message": "Test notification sent"}),
        Err(message) => json!({"ok": false, "message": message}),
    };
    Ok((StatusCode::CREATED, Json(out)))
}

/// Nest's `NotificationsService.dispatch`: 204 once every sender settled; the event must be in the
/// vocabulary (C17).
pub async fn internal_dispatch(
    State(st): State<AppState>,
    headers: HeaderMap,
    raw: Bytes,
) -> Res<StatusCode> {
    st.bridge.check(&headers)?;
    let body: Value =
        serde_json::from_slice(&raw).map_err(|e| AppError::bad_request(e.to_string()))?;
    let obj = body.as_object().cloned().unwrap_or_default();
    let mut msgs: Vec<String> = obj
        .keys()
        .filter(|k| !["event", "payload"].contains(&k.as_str()))
        .map(|k| format!("property {k} should not exist"))
        .collect();
    let event = obj
        .get("event")
        .and_then(Value::as_str)
        .filter(|e| dom::is_event(e));
    if event.is_none() {
        msgs.push(format!(
            "event must be one of the following values: {}",
            EVENTS.join(", ")
        ));
    }
    let payload = obj.get("payload").and_then(Value::as_object);
    if payload.is_none() {
        msgs.push("payload must be an object".into());
    }
    invalid(msgs)?;
    if let (Some(event), Some(payload)) = (event, payload) {
        dispatch(&st.db, event, payload).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

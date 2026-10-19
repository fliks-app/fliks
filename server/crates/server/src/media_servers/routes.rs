use super::{
    db::{self, Server, Write, not_found},
    emby, import,
};
use crate::{
    events::SseEvent,
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, from_value, int_param},
    },
    jobs::{Trigger, run_audited},
    state::AppState,
};
use axum::{
    Json,
    extract::{FromRequest, Request, State},
    http::StatusCode,
};
use fliks_domain::acl::{Action, Subject};
use serde::Deserialize;
use serde_json::{Value, json};

type Res<T> = Result<T, AppError>;

const TYPES: [&str; 4] = ["local", "jellyfin", "emby", "plex"];

/// Raw JSON per field (`null` kept as `Some(Null)`): class-validator's messages are built in `Dto::parse`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RawDto {
    #[serde(default, deserialize_with = "present")]
    name: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    r#type: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    url: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    api_key: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    events: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    enabled: Option<Value>,
}

fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(d).map(Some)
}

/// `CreateMediaServerDto`, also the body of PUT; `None` is absent, `Some(None)` an explicit `null`.
struct Dto {
    name: String,
    r#type: String,
    url: String,
    api_key: Option<Option<String>>,
    events: Option<Option<Vec<String>>>,
    enabled: Option<Option<bool>>,
}

fn string(v: Option<Value>, field: &str, msgs: &mut Vec<String>) -> String {
    match v {
        Some(Value::String(s)) => s,
        _ => {
            msgs.push(format!("{field} must be a string"));
            String::new()
        }
    }
}

impl Dto {
    fn parse(body: Value) -> Res<Self> {
        let raw: RawDto = from_value(body)?;
        let mut msgs = vec![];
        let name = string(raw.name, "name", &mut msgs);
        let r#type = match raw.r#type {
            Some(Value::String(s)) if TYPES.contains(&s.as_str()) => s,
            _ => {
                msgs.push(format!(
                    "type must be one of the following values: {}",
                    TYPES.join(", ")
                ));
                String::new()
            }
        };
        let url = string(raw.url, "url", &mut msgs);
        let api_key = match raw.api_key {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(s)) => Some(Some(s)),
            _ => {
                msgs.push("apiKey must be a string".into());
                None
            }
        };
        let events = match raw.events {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::Array(a)) if a.iter().all(Value::is_string) => Some(Some(
                a.into_iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect(),
            )),
            other => {
                if !matches!(other, Some(Value::String(_))) {
                    msgs.push("each value in events must be a string".into());
                }
                if !matches!(other, Some(Value::Array(_))) {
                    msgs.push("events must be an array".into());
                }
                None
            }
        };
        let enabled = match raw.enabled {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::Bool(b)) => Some(Some(b)),
            _ => {
                msgs.push("enabled must be a boolean value".into());
                None
            }
        };
        if !msgs.is_empty() {
            return Err(AppError::bad_request(msgs));
        }
        Ok(Self {
            name,
            r#type,
            url,
            api_key,
            events,
            enabled,
        })
    }

    /// C1: a `null` for a NOT NULL column is a 400 instead of Nest's 500.
    fn reject_nulls(&self) -> Res<()> {
        let mut msgs = vec![];
        if matches!(self.events, Some(None)) {
            msgs.push("each value in events must be a string");
            msgs.push("events must be an array");
        }
        if matches!(self.enabled, Some(None)) {
            msgs.push("enabled must be a boolean value");
        }
        if msgs.is_empty() {
            Ok(())
        } else {
            Err(AppError::bad_request(msgs))
        }
    }
}

/// C169: checks only what the write changes, so a stored row re-sent by a 4.x toggle passes.
fn validate(dto: &Dto, cur: Option<&Server>) -> Res<()> {
    let mut msgs = vec![];
    if cur.is_none_or(|c| c.url != dto.url)
        && !reqwest::Url::parse(&dto.url)
            .is_ok_and(|u| matches!(u.scheme(), "http" | "https") && u.has_host())
    {
        msgs.push("url must be a URL address".to_owned());
    }
    let events: &[String] = match (&dto.events, cur) {
        (Some(Some(e)), _) => e,
        (_, Some(c)) => &c.events.0,
        _ => &[],
    };
    if cur.is_none_or(|c| c.r#type != dto.r#type || c.events.0 != events) {
        let supported: &[&str] = if dto.r#type == emby::TYPE {
            &emby::EVENTS
        } else {
            &[]
        };
        if events.iter().any(|e| !supported.contains(&e.as_str())) {
            msgs.push(if supported.is_empty() {
                format!("type {} supports no events", dto.r#type)
            } else {
                format!(
                    "each value in events must be one of the following values: {}",
                    supported.join(", ")
                )
            });
        }
    }
    if msgs.is_empty() {
        Ok(())
    } else {
        Err(AppError::bad_request(msgs))
    }
}

/// Body parsing after the policy check, as Nest's guards run before its pipes.
async fn body(req: Request) -> Res<Value> {
    let ValidJson(v) = ValidJson::<Value>::from_request(req, &()).await?;
    Ok(v)
}

fn id_of(PathParams(raw): PathParams<String>) -> Res<i32> {
    int_param(&raw)
}

async fn one(st: &AppState, id: i32) -> Res<Server> {
    db::find(&st.db, id).await?.ok_or_else(|| not_found(id))
}

#[utoipa::path(get, path = "/api/media-servers/types", responses((status = 200)))]
pub async fn types(a: Authed) -> Res<Json<Value>> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(json!([{
        "type": emby::TYPE, "label": emby::LABEL, "supportedEvents": emby::EVENTS
    }])))
}

#[utoipa::path(post, path = "/api/media-servers", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Res<(StatusCode, Json<Server>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let dto = Dto::parse(body(req).await?)?;
    validate(&dto, None)?;
    let events = dto.events.flatten().unwrap_or_default();
    let id = db::insert(
        &st.db,
        &Write {
            name: &dto.name,
            r#type: &dto.r#type,
            url: &dto.url,
            api_key: Some(dto.api_key.flatten().as_deref().unwrap_or_default()),
            events: &events,
            enabled: dto.enabled.flatten().unwrap_or(true),
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(one(&st, id).await?)))
}

#[utoipa::path(get, path = "/api/media-servers", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Server>>> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(db::list(&st.db).await?))
}

#[utoipa::path(get, path = "/api/media-servers/{id}", responses((status = 200)))]
pub async fn get_one(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Res<Json<Server>> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(one(&st, id_of(id)?).await?))
}

#[utoipa::path(put, path = "/api/media-servers/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    req: Request,
) -> Res<Json<Server>> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = id_of(id)?;
    let dto = Dto::parse(body(req).await?)?;
    dto.reject_nulls()?;
    let cur = one(&st, id).await?;
    validate(&dto, Some(&cur))?;
    // F79: absent or "" keeps the stored key, null clears it.
    let api_key = match dto.api_key.as_ref() {
        Some(None) => None,
        Some(Some(k)) if !k.is_empty() => Some(k.as_str()),
        _ => cur.api_key.as_deref(),
    };
    let events = dto.events.flatten().unwrap_or(cur.events.0);
    db::update(
        &st.db,
        id,
        &Write {
            name: &dto.name,
            r#type: &dto.r#type,
            url: &dto.url,
            api_key,
            events: &events,
            enabled: dto.enabled.flatten().unwrap_or(cur.enabled),
        },
    )
    .await?;
    Ok(Json(one(&st, id).await?))
}

#[utoipa::path(delete, path = "/api/media-servers/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Res<StatusCode> {
    a.require(Action::Manage, Subject::Settings)?;
    let id = id_of(id)?;
    one(&st, id).await?;
    db::delete(&st.db, id).await?;
    Ok(StatusCode::OK)
}

#[utoipa::path(post, path = "/api/media-servers/{id}/test", responses((status = 201)))]
pub async fn test(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let s = one(&st, id_of(id)?).await?;
    let (ok, message) = if s.r#type == emby::TYPE {
        emby::Conn::new(&s.url, s.api_key.as_deref()).test().await
    } else {
        (false, format!("Type \"{}\" non supporte", s.r#type))
    };
    Ok((
        StatusCode::CREATED,
        Json(json!({"ok": ok, "message": message})),
    ))
}

#[utoipa::path(post, path = "/api/media-servers/{id}/import-watch-history", responses((status = 201)))]
pub async fn import_watch_history(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Res<(StatusCode, Json<Value>)> {
    a.require(Action::Manage, Subject::Settings)?;
    let server = one(&st, id_of(id)?).await?;
    if server.r#type != emby::TYPE {
        return Err(AppError::not_found(
            "Watch-history import is only supported for Emby servers",
        ));
    }
    let claim = st
        .busy
        .watch_history
        .claim(server.id)
        .ok_or_else(|| AppError::conflict("Import already running"))?;
    let (server_id, server_name) = (i64::from(server.id), server.name.clone());
    st.hub.emit(SseEvent::WatchHistoryImportStarted {
        server_id,
        server_name: server_name.clone(),
    });
    tokio::spawn(async move {
        let _claim = claim;
        let (job_state, job_name) = (st.clone(), server_name.clone());
        let ran = run_audited(&st, "ImportWatchHistory", Trigger::Manual, async move {
            match import::import_server(&job_state.db, &server).await {
                Ok(s) => {
                    job_state.hub.emit(SseEvent::WatchHistoryImportCompleted {
                        server_id,
                        server_name: job_name,
                        users: s.users,
                        users_created: s.users_created,
                        imported: s.imported,
                        skipped: s.skipped,
                    });
                    Ok(())
                }
                Err(error) => {
                    tracing::error!("Watch-history import failed: {error}");
                    job_state.hub.emit(SseEvent::WatchHistoryImportFailed {
                        server_id,
                        server_name: job_name,
                        error: error.clone(),
                    });
                    Err(error)
                }
            }
        })
        .await;
        if !ran {
            st.hub.emit(SseEvent::WatchHistoryImportFailed {
                server_id,
                server_name,
                error: String::new(),
            });
        }
    });
    Ok((StatusCode::CREATED, Json(json!({"ok": true}))))
}

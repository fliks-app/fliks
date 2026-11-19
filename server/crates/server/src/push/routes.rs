//! `/api/push/*` (`push.md` routes table).
use super::{
    USER_CAP, Unready,
    act::{self, ACTIONS},
    crypto::Recipient,
    db::{self, Upsert},
    identity, webpush,
};
use crate::{
    http::{
        AppError,
        auth::{Authed, SessionAuthed},
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{delete, get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use fliks_domain::{
    acl::{Action, Subject},
    push::locale,
};
use serde::Deserialize;
use serde_json::{Value, json};

type Res<T> = Result<T, AppError>;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/push/config", get(config))
        .route("/api/push/subscriptions", post(subscribe))
        .route("/api/push/subscriptions/current", delete(unsubscribe))
        .route("/api/push/test", post(test))
        .route("/api/push/act", post(act))
        .route("/api/push/status", get(status))
        .route("/api/push/pending/{relay}", delete(pending_drop))
}

#[utoipa::path(get, path = "/api/push/config", responses((status = 200)))]
pub async fn config(
    State(st): State<AppState>,
    SessionAuthed(_): SessionAuthed,
) -> Res<Json<Value>> {
    Ok(Json(json!({
        "mobile": db::relay_enabled(&st.db).await?,
        "vapidPublicKey": st.push.vapid_public_key(),
        "plugins": db::notifying_plugins(&st.db).await?.into_iter()
            .filter_map(|id| st.plugins.registry.get(&id).map(|r| json!({"id": id, "name": r.manifest["name"]})))
            .collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Subscribe {
    platform: String,
    p256dh: String,
    auth: String,
    locale: String,
    endpoint: Option<String>,
}

#[utoipa::path(post, path = "/api/push/subscriptions", responses((status = 201)))]
pub async fn subscribe(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(dto): ValidJson<Subscribe>,
) -> Res<(StatusCode, Json<Value>)> {
    if !matches!(dto.platform.as_str(), "apns" | "fcm" | "web") {
        return Err(AppError::bad_request(
            "platform must be one of the following values: apns, fcm, web",
        ));
    }
    if Recipient::parse(&dto.p256dh, &dto.auth).is_none() {
        return Err(AppError::bad_request(
            "p256dh and auth must be a P-256 public key and a 16-byte secret",
        ));
    }
    let web = dto.platform == "web";
    let endpoint = match (&dto.endpoint, web) {
        (Some(e), true) if webpush::endpoint(e).is_some() => Some(e.as_str()),
        (_, true) => {
            return Err(AppError::bad_request(
                "endpoint must be an https URL of a known push service",
            ));
        }
        _ => None,
    };
    let relay = if web {
        None
    } else {
        Some(st.push.ready(&st).await.map_err(|e| match e {
            Unready::Disabled => AppError::conflict("push.error_disabled"),
            Unready::Unavailable => AppError::plain(
                StatusCode::SERVICE_UNAVAILABLE,
                "push.error_relay_unavailable",
            ),
        })?)
    };
    let (id, sub, replaced) = db::upsert(
        &st.db,
        a.user.id,
        USER_CAP,
        Upsert {
            session: a.session()?,
            platform: &dto.platform,
            sub: (!web)
                .then(|| B64.encode(identity::random::<16>()))
                .as_deref(),
            endpoint,
            p256dh: &dto.p256dh,
            auth: &dto.auth,
            locale: locale(&dto.locale),
        },
    )
    .await?;
    if let Some(old) = replaced {
        st.push.forget_at_relay(&old).await;
    }
    let body = match (relay, sub) {
        (Some(relay), Some(sub)) => {
            let ticket = relay.ticket(&sub).await.map_err(|_| {
                AppError::plain(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "push.error_relay_unavailable",
                )
            })?;
            json!({"sub": sub, "ticket": ticket})
        }
        _ => json!({"id": id}),
    };
    Ok((StatusCode::CREATED, Json(body)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Platform {
    platform: String,
}

#[utoipa::path(delete, path = "/api/push/subscriptions/current", responses((status = 204)))]
pub async fn unsubscribe(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(dto): ValidJson<Platform>,
) -> Res<StatusCode> {
    if !matches!(dto.platform.as_str(), "apns" | "fcm" | "web") {
        return Err(AppError::bad_request(
            "platform must be one of the following values: apns, fcm, web",
        ));
    }
    if let Some(row) = db::of_session(&st.db, a.session()?, &dto.platform).await?
        && !st.push.remove_rows(&st, vec![row]).await
    {
        // The row stays until the relay answers, so the device keeps its pending deletion and retries.
        return Err(AppError::plain(
            StatusCode::SERVICE_UNAVAILABLE,
            "push.error_relay_unavailable",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/push/test", responses((status = 200)))]
pub async fn test(State(st): State<AppState>, SessionAuthed(a): SessionAuthed) -> Res<Json<Value>> {
    Ok(Json(
        json!({"results": st.push.test(&st, a.user.id).await?}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActDto {
    token: String,
}

#[utoipa::path(post, path = "/api/push/act", responses((status = 204)))]
pub async fn act(
    State(st): State<AppState>,
    SessionAuthed(a): SessionAuthed,
    ValidJson(dto): ValidJson<ActDto>,
) -> Res<StatusCode> {
    if !dto.token.starts_with(act::PREFIX) {
        return Err(AppError::bad_request("token is malformed"));
    }
    let forbidden = || AppError::forbidden("Forbidden resource");
    let g = act::parse(&st.grant_key, &dto.token).ok_or_else(forbidden)?;
    if g.user != a.user.id || g.exp <= chrono::Utc::now().timestamp() {
        return Err(forbidden());
    }
    run(&st, &a, &g).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn run(st: &AppState, a: &Authed, g: &act::Grant) -> Res<()> {
    use crate::{requests::flow, social};
    match g.action.as_str() {
        "request.approve" => flow::approve(st, a, g.target, false).await.map(drop),
        "request.decline" => flow::decline(st, a, g.target, None).await.map(drop),
        "follow.accept" => social::accept_request(st, a, g.target).await.map(drop),
        "follow.decline" => social::reject_request(st, a, g.target).await.map(drop),
        _ => Err(AppError::bad_request(format!(
            "unknown action, one of: {}",
            ACTIONS.join(", ")
        ))),
    }
}

#[utoipa::path(get, path = "/api/push/status", responses((status = 200)))]
pub async fn status(State(st): State<AppState>, a: Authed) -> Res<Json<Value>> {
    a.require(Action::Manage, Subject::Settings)?;
    Ok(Json(st.push.status(&st).await?))
}

#[utoipa::path(delete, path = "/api/push/pending/{relay}", responses((status = 204)))]
pub async fn pending_drop(
    State(st): State<AppState>,
    a: Authed,
    PathParams(relay): PathParams<String>,
) -> Res<StatusCode> {
    a.require(Action::Manage, Subject::Settings)?;
    if st.push.drop_pending(&relay) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::not_found(format!(
            "No pending deletion for {relay}"
        )))
    }
}

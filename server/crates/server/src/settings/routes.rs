use super::{
    db::{self, Setting},
    secrets::{Incoming, Secrets, Write},
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{ValidJson, from_value},
    },
    state::AppState,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use fliks_domain::acl::{Action, Subject};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};

/// Keys with their own write path (`settings.md` rule 9) and that path's text.
const PROTECTED: [(&str, &str); 6] = [
    (
        "livetv_restricted_groups",
        "PUT /livetv/admin/access/restricted-groups",
    ),
    (
        "livetv_restricted_groups_exempt",
        "PUT /livetv/admin/access/restricted-groups",
    ),
    (
        "livetv_restricted_groups_vanished",
        "PUT /livetv/admin/access/restricted-groups",
    ),
    ("engine_url", "PUT /engine/remote"),
    ("engine_token", "PUT /engine/remote"),
    ("engine_path_mappings", "PUT /engine/remote"),
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetSetting {
    #[serde(default, deserialize_with = "present")]
    value: Option<Option<String>>,
}

/// Distinguishes an absent `value` (`None`) from an explicit `null` (`Some(None)`).
fn present<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetBulk {
    #[serde(default)]
    data: Value,
}

fn db_err(e: sqlx::Error) -> AppError {
    tracing::error!(error = %e, "settings query");
    AppError::plain(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn refuse_protected(key: &str) -> Result<(), AppError> {
    match PROTECTED.iter().find(|(k, _)| *k == key) {
        Some((_, path)) => Err(AppError::bad_request(format!(
            "\"{key}\" is managed by its own endpoint: {path}"
        ))),
        None => Ok(()),
    }
}

pub(crate) async fn notify(st: &AppState, keys: &[String], origin: Option<&str>) {
    if keys.is_empty() {
        return;
    }
    st.plugins.settings_changed(keys, origin);
    st.metadata.lang.settings_changed(keys);
    tokio::join!(
        st.engine.settings_changed(keys),
        st.qoe.settings_changed(keys)
    );
    for key in keys {
        st.hub
            .emit_domain(crate::events::DomainEvent::SettingsChanged { key: key.clone() });
    }
}

/// Values the engine would reject with its whole config.
fn validate(key: &str, value: &str) -> Result<(), AppError> {
    if key == "users_public_mode" && !["everyone", "lan", "hidden"].contains(&value) {
        return Err(AppError::bad_request(vec![
            "users_public_mode must be one of the following values: everyone, lan, hidden",
        ]));
    }
    crate::engine::validate_streaming_setting(key, Some(value))
        .map_err(|m| AppError::bad_request(vec![m]))
}

#[utoipa::path(get, path = "/api/settings", responses((status = 200)))]
pub(crate) async fn list(
    State(st): State<AppState>,
    authed: Authed,
) -> Result<Json<Value>, AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    let rows = db::list(&st.db).await.map_err(db_err)?;
    let secrets = Secrets::load(&st.db, rows.iter().map(|(k, _)| k.as_str()))
        .await
        .map_err(db_err)?;
    Ok(Json(secrets.redact_all(rows)))
}

#[utoipa::path(get, path = "/api/settings/{key}", responses((status = 200)))]
pub(crate) async fn get_one(
    State(st): State<AppState>,
    authed: Authed,
    Path(key): Path<String>,
) -> Result<Json<Value>, AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    let row = db::get(&st.db, &key).await.map_err(db_err)?;
    let secrets = Secrets::load(&st.db, [key.as_str()])
        .await
        .map_err(db_err)?;
    let value = row.as_ref().and_then(|r| r.value.as_deref());
    Ok(Json(secrets.redact_one(&key, value)))
}

#[utoipa::path(put, path = "/api/settings/{key}", responses((status = 200)))]
pub(crate) async fn put_one(
    State(st): State<AppState>,
    authed: Authed,
    Path(key): Path<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Setting>, AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    let dto: SetSetting = from_value(body)?;
    refuse_protected(&key)?;
    if let Some(Some(v)) = &dto.value {
        validate(&key, v)?;
    }
    let incoming = match dto.value {
        None => Incoming::Absent,
        Some(None) => Incoming::Null,
        Some(Some(v)) => Incoming::Text(v),
    };
    let secrets = Secrets::load(&st.db, [key.as_str()])
        .await
        .map_err(db_err)?;
    let mut tx = st.db.begin().await.map_err(db_err)?;
    let stored = db::get(&st.db, &key).await.map_err(db_err)?;
    let mut saved = match (secrets.merge(&key, incoming), stored) {
        (Write::Keep, Some(row)) => row,
        (Write::Keep, None) => db::set(&mut tx, &key, None).await.map_err(db_err)?,
        (Write::Set(v), _) => db::set(&mut tx, &key, v.as_deref()).await.map_err(db_err)?,
    };
    tx.commit().await.map_err(db_err)?;
    // Every PUT notifies, even when a secret kept its stored value (spec rule 8).
    notify(&st, std::slice::from_ref(&key), None).await;
    if secrets.is_secret(&key) {
        saved.value = None;
    }
    Ok(Json(saved))
}

#[utoipa::path(put, path = "/api/settings", responses((status = 200)))]
pub(crate) async fn put_bulk(
    State(st): State<AppState>,
    authed: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    authed.require(Action::Manage, Subject::Settings)?;
    let SetBulk { data } = from_value(body)?;
    let Value::Object(data) = data else {
        return Err(AppError::bad_request(vec!["data must be an object"]));
    };
    for (key, value) in &data {
        refuse_protected(key)?;
        if !value.is_null() {
            validate(key, &db::pg_text(value))?;
        }
    }
    let secrets = Secrets::load(&st.db, data.keys().map(String::as_str))
        .await
        .map_err(db_err)?;
    let mut tx = st.db.begin().await.map_err(db_err)?;
    let mut keys = Vec::new();
    for (key, value) in data {
        let incoming = match value {
            Value::Null => Incoming::Null,
            v => Incoming::Text(db::pg_text(&v)),
        };
        if let Write::Set(v) = secrets.merge(&key, incoming) {
            db::set(&mut tx, &key, v.as_deref()).await.map_err(db_err)?;
        }
        keys.push(key);
    }
    tx.commit().await.map_err(db_err)?;
    notify(&st, &keys, None).await;
    Ok(Json(json!({"ok": true})))
}

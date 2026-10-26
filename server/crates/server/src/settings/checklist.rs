//! `/api/setup-checklist` (`docs/spec/setup-checklist.md`): the seven core items and their dismissal.
use crate::http::{AppError, auth::Authed};
use crate::state::AppState;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use fliks_domain::acl::{Action, Subject};
use serde_json::{Value, json};

const KEY: &str = "setup_checklist_dismissed_keys";

/// Rule 3, in response order: key, severity, route tail, `done` query.
const ITEMS: [(&str, &str, &str, &str); 7] = [
    (
        "library",
        "required",
        "libraries",
        "SELECT EXISTS(SELECT 1 FROM libraries)",
    ),
    (
        "quality-profile",
        "required",
        "quality-profiles",
        "SELECT EXISTS(SELECT 1 FROM quality_profiles)",
    ),
    (
        "language-profile",
        "required",
        "language-profiles",
        "SELECT EXISTS(SELECT 1 FROM language_profiles)",
    ),
    (
        "subtitle-provider",
        "recommended",
        "subtitle-providers",
        "SELECT EXISTS(SELECT 1 FROM subtitle_providers WHERE enabled)",
    ),
    (
        "notification",
        "recommended",
        "notifications",
        "SELECT EXISTS(SELECT 1 FROM notification_connections)",
    ),
    (
        "non-admin-user",
        "recommended",
        "users",
        r#"SELECT EXISTS(SELECT 1 FROM users WHERE "isAdmin" <> true)"#,
    ),
    (
        "auto-approval-rule",
        "recommended",
        "auto-approval",
        "SELECT EXISTS(SELECT 1 FROM auto_approval_rules)",
    ),
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/setup-checklist", get(list))
        .route(
            "/api/setup-checklist/{key}/dismiss",
            post(dismiss).delete(undismiss),
        )
}

/// Rule 9: anything but a JSON array of known keys reads as those known keys, else empty.
fn dismissed(raw: Option<&str>) -> Vec<String> {
    let v: Value = raw
        .and_then(|r| serde_json::from_str(r).ok())
        .unwrap_or(Value::Null);
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|k| ITEMS.iter().any(|i| i.0 == *k))
        .map(str::to_owned)
        .collect()
}

#[utoipa::path(get, path = "/api/setup-checklist", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let checks = ITEMS.iter().map(|(key, _, _, sql)| {
        let db = st.db.clone();
        async move {
            sqlx::query_scalar::<_, bool>(*sql)
                .fetch_one(&db)
                .await
                .unwrap_or_else(|e| {
                    tracing::warn!("Checklist item \"{key}\" check failed: {e}");
                    false
                })
        }
    });
    let done = futures_util::future::join_all(checks).await;
    let gone = dismissed(super::setting_value(&st.db, KEY).await?.as_deref());
    let items: Vec<Value> = ITEMS
        .iter()
        .zip(done)
        .map(|((key, severity, tail, _), done)| {
            json!({"key": key, "severity": severity, "done": done, "dismissed": gone.iter().any(|g| g == key),
                "route": ["/admin", "settings", tail]})
        })
        .collect();
    Ok(Json(Value::Array(items)))
}

/// Rules 14-16: one transaction behind an advisory lock; no write when nothing changes.
async fn change(st: &AppState, a: &Authed, key: &str, add: bool) -> Result<Json<Value>, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    if !ITEMS.iter().any(|i| i.0 == key) {
        return Err(AppError::bad_request(format!(
            "Unknown checklist key: {key}"
        )));
    }
    let mut tx = st.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(KEY)
        .execute(&mut *tx)
        .await?;
    let raw: Option<Option<String>> =
        sqlx::query_scalar(r#"SELECT value FROM app_settings WHERE key = $1 FOR UPDATE"#)
            .bind(KEY)
            .fetch_optional(&mut *tx)
            .await?;
    let mut set = dismissed(raw.flatten().as_deref());
    if set.iter().any(|k| k == key) == add {
        return Ok(Json(json!({"ok": true})));
    }
    if add {
        set.push(key.to_owned());
    } else {
        set.retain(|k| k != key);
    }
    super::db::set(
        &mut tx,
        KEY,
        Some(&serde_json::to_string(&set).expect("strings")),
    )
    .await?;
    tx.commit().await?;
    super::routes::notify(st, &[KEY.to_owned()], None).await;
    Ok(Json(json!({"ok": true})))
}

#[utoipa::path(post, path = "/api/setup-checklist/{key}/dismiss", responses((status = 201)))]
pub async fn dismiss(
    State(st): State<AppState>,
    a: Authed,
    Path(key): Path<String>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    Ok((StatusCode::CREATED, change(&st, &a, &key, true).await?))
}

#[utoipa::path(delete, path = "/api/setup-checklist/{key}/dismiss", responses((status = 200)))]
pub async fn undismiss(
    State(st): State<AppState>,
    a: Authed,
    Path(key): Path<String>,
) -> Result<Json<Value>, AppError> {
    change(&st, &a, &key, false).await
}

//! `/api/subtitles/translation-providers/*` (`translation.md` routes and rules 35-41).
use super::{secrets, translation as engines};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, Utc};
use fliks_domain::{
    acl::{Action, Subject},
    translation::Request,
};
use serde_json::{Value, json};
use sqlx::{FromRow, PgConnection};

type Res<T> = Result<T, AppError>;
type Id = Result<PathParams<i32>, AppError>;

const SECRET_KEYS: [&str; 1] = ["apiKey"];

#[derive(Debug, Clone, FromRow)]
pub struct Row {
    pub id: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub name: String,
    pub engine: String,
    pub enabled: bool,
    pub is_default: bool,
    pub settings: Value,
}

const COLS: &str = r#"id, "createdAt" AS created_at, "updatedAt" AS updated_at, name, engine::text AS engine,
  enabled, "isDefault" AS is_default, settings"#;

fn view(r: &Row) -> Value {
    json!({
        "id": r.id, "createdAt": super::model::iso(r.created_at), "updatedAt": super::model::iso(r.updated_at),
        "name": r.name, "engine": r.engine, "enabled": r.enabled, "isDefault": r.is_default,
        "settings": secrets::redact(&r.settings, &SECRET_KEYS),
    })
}

pub async fn find(st: &AppState, id: i32) -> Res<Row> {
    sqlx::query_as::<_, Row>(&format!(
        "SELECT {COLS} FROM translation_providers WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("TranslationProvider #{id} not found")))
}

/// The enabled default, else the first enabled one (`findDefault`).
pub async fn find_default(st: &AppState) -> Res<Option<Row>> {
    Ok(sqlx::query_as::<_, Row>(&format!(
        r#"SELECT {COLS} FROM translation_providers WHERE enabled = true ORDER BY "isDefault" DESC, id ASC LIMIT 1"#
    ))
    .fetch_optional(&st.db)
    .await?)
}

fn endpoint(engine: &str) -> Option<&'static str> {
    match engine {
        "openai" => Some("baseUrl"),
        "libretranslate" => Some("url"),
        _ => None,
    }
}

/// C74: same engine and, for the engines with one, the same endpoint (trimmed, no trailing `/`).
fn same_endpoint(stored_engine: &str, stored: &Value, engine: &str, settings: &Value) -> bool {
    if engine != stored_engine {
        return false;
    }
    let norm = |v: &Value, k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .map(|s| s.trim().trim_end_matches('/').to_owned())
    };
    endpoint(engine).is_none_or(|k| norm(settings, k) == norm(stored, k))
}

struct Body {
    name: Option<String>,
    engine: Option<String>,
    settings: Option<Value>,
    enabled: Option<bool>,
    is_default: Option<bool>,
}

fn validate(v: Value, create: bool) -> Res<Body> {
    let obj = v.as_object().cloned().unwrap_or_default();
    let present = |k: &str| obj.get(k).filter(|x| !x.is_null());
    let mut msgs: Vec<String> = vec![];
    let name = match present("name") {
        Some(Value::String(s)) => Some(s.clone()),
        None if !create => None,
        _ => {
            msgs.push("name must be a string".into());
            None
        }
    };
    let engine = match present("engine") {
        Some(Value::String(s)) if engines::ENGINES.contains(&s.as_str()) => Some(s.clone()),
        None if !create => None,
        _ => {
            msgs.push(format!(
                "engine must be one of the following values: {}",
                engines::ENGINES.join(", ")
            ));
            None
        }
    };
    let settings = match present("settings") {
        Some(s @ Value::Object(_)) => Some(s.clone()),
        None => None,
        _ => {
            msgs.push("settings must be an object".into());
            None
        }
    };
    let flag = |k: &str, msgs: &mut Vec<String>| match present(k) {
        Some(Value::Bool(b)) => Some(*b),
        None => None,
        _ => {
            msgs.push(format!("{k} must be a boolean value"));
            None
        }
    };
    let enabled = flag("enabled", &mut msgs);
    let is_default = flag("isDefault", &mut msgs);
    if !msgs.is_empty() {
        return Err(AppError::bad_request(msgs));
    }
    Ok(Body {
        name,
        engine,
        settings,
        enabled,
        is_default,
    })
}

fn policy(a: &Authed, action: Action) -> Res<()> {
    a.require(action, Subject::TranslationProvider)
}

/// C73: one default at a time, decided under the row locks.
async fn clear_other_defaults(tx: &mut PgConnection, keep: i32) -> sqlx::Result<()> {
    sqlx::query(r#"UPDATE translation_providers SET "isDefault" = false WHERE id <> $1 AND "isDefault" = true"#)
        .bind(keep)
        .execute(tx)
        .await
        .map(drop)
}

#[utoipa::path(get, path = "/api/subtitles/translation-providers/available", responses((status = 200)))]
pub async fn available(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Value>>> {
    a.require(Action::Create, Subject::SubtitleFile)?;
    let rows: Vec<Row> = sqlx::query_as(&format!(
        r#"SELECT {COLS} FROM translation_providers WHERE enabled = true ORDER BY "isDefault" DESC, id ASC"#
    ))
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows.iter().map(|r| json!({"id": r.id, "name": r.name, "engine": r.engine, "isDefault": r.is_default})).collect()))
}

struct Probe {
    engine: String,
    settings: Value,
}

/// The test and models body: `engine`, `settings?`, `id?`, the stored key resolved when the endpoint matches.
async fn probe_body(st: &AppState, v: Value) -> Res<Probe> {
    let obj = v.as_object().cloned().unwrap_or_default();
    let mut msgs = vec![];
    let engine = obj
        .get("engine")
        .and_then(Value::as_str)
        .filter(|e| engines::ENGINES.contains(e))
        .map(str::to_owned);
    if engine.is_none() {
        msgs.push(format!(
            "engine must be one of the following values: {}",
            engines::ENGINES.join(", ")
        ));
    }
    let settings = match obj.get("settings") {
        None | Some(Value::Null) => json!({}),
        Some(s @ Value::Object(_)) => s.clone(),
        _ => {
            msgs.push("settings must be an object".into());
            json!({})
        }
    };
    let id = match obj.get("id") {
        None | Some(Value::Null) => None,
        Some(n) if n.as_i64().is_some() => n.as_i64().and_then(|i| i32::try_from(i).ok()),
        _ => {
            msgs.push("id must be an integer number".into());
            None
        }
    };
    let Some(engine) = engine.filter(|_| msgs.is_empty()) else {
        return Err(AppError::bad_request(msgs));
    };
    let stored = match id {
        Some(i) => {
            sqlx::query_as::<_, Row>(&format!(
                "SELECT {COLS} FROM translation_providers WHERE id = $1"
            ))
            .bind(i)
            .fetch_optional(&st.db)
            .await?
        }
        None => None,
    };
    let keep = stored
        .as_ref()
        .filter(|s| same_endpoint(&s.engine, &s.settings, &engine, &settings))
        .map(|s| &s.settings);
    Ok(Probe {
        settings: secrets::merge(keep, &settings, &SECRET_KEYS),
        engine,
    })
}

/// `testConnection`: a config error or a failed call is `ok: false`, never a 4xx.
pub async fn run_test(st: &AppState, engine: &str, settings: &Value) -> Value {
    let attempt = async {
        engines::validate_config(engine, settings).map_err(|e| e.text())?;
        let req = Request {
            source_language: "en".into(),
            target_language: "fr".into(),
            ..Request::default()
        };
        let texts = vec!["Hello.".to_owned(), "Good morning.".to_owned()];
        engines::translate(&st.subtitles, engine, &texts, req, settings, &mut |_, _| {})
            .await
            .map_err(|e| e.to_string())
    };
    match attempt.await {
        Ok(out) if out.is_empty() => json!({"ok": false, "error": "Empty translation response"}),
        Ok(_) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[utoipa::path(post, path = "/api/subtitles/translation-providers/test-connection", responses((status = 201)))]
pub async fn test_connection(
    State(st): State<AppState>,
    a: Authed,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Read)?;
    let p = probe_body(&st, body.0).await?;
    Ok((
        StatusCode::CREATED,
        Json(run_test(&st, &p.engine, &p.settings).await),
    ))
}

#[utoipa::path(post, path = "/api/subtitles/translation-providers/models", responses((status = 201)))]
pub async fn models(
    State(st): State<AppState>,
    a: Authed,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Read)?;
    let p = probe_body(&st, body.0).await?;
    match engines::list_models(&st.subtitles, &p.engine, &p.settings).await {
        Ok(models) => Ok((StatusCode::CREATED, Json(json!({"models": models})))),
        Err(engines::ListError::Bad(e)) => Err(e),
        Err(engines::ListError::Gateway(m)) => Err(engines::gateway(m)),
    }
}

#[utoipa::path(post, path = "/api/subtitles/translation-providers", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let b = validate(body.0, true)?;
    let settings = secrets::merge(None, &b.settings.unwrap_or_else(|| json!({})), &SECRET_KEYS);
    let engine = b.engine.unwrap_or_default();
    engines::validate_url_fields(&engine, &settings)?;
    let mut tx = st.db.begin().await?;
    let row: Row = sqlx::query_as(&format!(
        r#"INSERT INTO translation_providers (name, engine, enabled, "isDefault", settings)
           VALUES ($1, $2::text::translation_providers_engine_enum, $3, $4, $5) RETURNING {COLS}"#
    ))
    .bind(b.name.unwrap_or_default())
    .bind(&engine)
    .bind(b.enabled.unwrap_or(true))
    .bind(b.is_default.unwrap_or(false))
    .bind(&settings)
    .fetch_one(&mut *tx)
    .await?;
    if row.is_default {
        clear_other_defaults(&mut tx, row.id).await?;
    }
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(view(&row))))
}

#[utoipa::path(get, path = "/api/subtitles/translation-providers", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Value>>> {
    policy(&a, Action::Read)?;
    let rows: Vec<Row> = sqlx::query_as(&format!(
        r#"SELECT {COLS} FROM translation_providers ORDER BY "isDefault" DESC, name ASC, id ASC"#
    ))
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows.iter().map(view).collect()))
}

#[utoipa::path(get, path = "/api/subtitles/translation-providers/{id}", responses((status = 200)))]
pub async fn get_one(State(st): State<AppState>, a: Authed, id: Id) -> Res<Json<Value>> {
    policy(&a, Action::Read)?;
    let PathParams(id) = id?;
    Ok(Json(view(&find(&st, id).await?)))
}

#[utoipa::path(put, path = "/api/subtitles/translation-providers/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    id: Id,
    body: ValidJson<Value>,
) -> Res<Json<Value>> {
    policy(&a, Action::Update)?;
    let PathParams(id) = id?;
    let b = validate(body.0, false)?;
    let mut tx = st.db.begin().await?;
    let cur: Row = sqlx::query_as(&format!(
        "SELECT {COLS} FROM translation_providers WHERE id = $1 FOR UPDATE"
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found(format!("TranslationProvider #{id} not found")))?;
    let engine = b.engine.clone().unwrap_or_else(|| cur.engine.clone());
    // C74: a changed engine or endpoint never inherits the stored key.
    let settings = match &b.settings {
        Some(s) => {
            let keep =
                same_endpoint(&cur.engine, &cur.settings, &engine, s).then_some(&cur.settings);
            secrets::merge(keep, s, &SECRET_KEYS)
        }
        None if engine != cur.engine => Value::Object(
            cur.settings
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(k, _)| !SECRET_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ),
        None => cur.settings.clone(),
    };
    engines::validate_url_fields(&engine, &settings)?;
    let row: Row = sqlx::query_as(&format!(
        r#"UPDATE translation_providers SET name = $2, engine = $3::text::translation_providers_engine_enum, enabled = $4,
             "isDefault" = $5, settings = $6, "updatedAt" = now() WHERE id = $1 RETURNING {COLS}"#
    ))
    .bind(id)
    .bind(b.name.unwrap_or(cur.name))
    .bind(&engine)
    .bind(b.enabled.unwrap_or(cur.enabled))
    .bind(b.is_default.unwrap_or(cur.is_default))
    .bind(&settings)
    .fetch_one(&mut *tx)
    .await?;
    if b.is_default == Some(true) {
        clear_other_defaults(&mut tx, id).await?;
    }
    tx.commit().await?;
    Ok(Json(view(&row)))
}

#[utoipa::path(delete, path = "/api/subtitles/translation-providers/{id}", responses((status = 200)))]
pub async fn remove(State(st): State<AppState>, a: Authed, id: Id) -> Res<StatusCode> {
    policy(&a, Action::Delete)?;
    let PathParams(id) = id?;
    let mut tx = st.db.begin().await?;
    let cur: Row = sqlx::query_as(&format!(
        "SELECT {COLS} FROM translation_providers WHERE id = $1 FOR UPDATE"
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::not_found(format!("TranslationProvider #{id} not found")))?;
    sqlx::query("DELETE FROM translation_providers WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if cur.is_default {
        sqlx::query(r#"UPDATE translation_providers SET "isDefault" = true WHERE id = (SELECT id FROM translation_providers WHERE enabled = true ORDER BY id ASC LIMIT 1)"#)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::OK)
}

#[utoipa::path(post, path = "/api/subtitles/translation-providers/{id}/test", responses((status = 201)))]
pub async fn test(State(st): State<AppState>, a: Authed, id: Id) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Read)?;
    let PathParams(id) = id?;
    let p = find(&st, id).await?;
    Ok((
        StatusCode::CREATED,
        Json(run_test(&st, &p.engine, &p.settings).await),
    ))
}

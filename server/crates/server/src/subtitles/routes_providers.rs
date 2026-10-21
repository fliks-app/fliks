//! `/api/subtitles/providers/*` (`subtitle-providers.md` routes).
use super::{
    providers::{Provider, limiter::CooldownInfo},
    secrets,
    service::{PROVIDER_COLS, ProviderRow},
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    state::AppState,
};
use axum::{Json, extract::State, http::StatusCode};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use fliks_domain::acl::{Action, Subject};
use fliks_domain::js::iso;
use serde_json::{Map, Value, json};
use sqlx::FromRow;

type Res<T> = Result<T, AppError>;
type Id = Result<PathParams<i32>, AppError>;

const SECRET_KEYS: [&str; 2] = ["password", "apiKey"];
const ENUM: [&str; 15] = [
    "opensubtitles",
    "subscene",
    "sous_titres_eu",
    "subdl",
    "subsynchro",
    "supersubtitles",
    "whisper",
    "yify",
    "gestdown",
    "embedded",
    "radarr",
    "sonarr",
    "disk",
    "ocr",
    "translated",
];

fn policy(a: &Authed, action: Action) -> Res<()> {
    a.require(action, Subject::SubtitleProvider)
}

fn view(p: &ProviderRow) -> Value {
    json!({
        "id": p.id,
        "createdAt": super::model::iso(p.created_at),
        "updatedAt": super::model::iso(p.updated_at),
        "name": p.name,
        "type": p.kind,
        "enabled": p.enabled,
        "settings": secrets::redact(&p.settings, &SECRET_KEYS),
        "priority": p.priority,
    })
}

/// Validation messages for the fields of a provider body.
struct Body {
    name: Option<String>,
    kind: Option<String>,
    settings: Option<Value>,
    enabled: Option<bool>,
    priority: Option<i32>,
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
    let kind = match present("type") {
        Some(Value::String(s)) if ENUM.contains(&s.as_str()) => Some(s.clone()),
        None if !create => None,
        _ => {
            msgs.push(format!(
                "type must be one of the following values: {}",
                ENUM.join(", ")
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
    let enabled = match present("enabled") {
        Some(Value::Bool(b)) => Some(*b),
        None => None,
        _ => {
            msgs.push("enabled must be a boolean value".into());
            None
        }
    };
    let priority = match present("priority") {
        Some(Value::Number(n)) => match int32(n) {
            Some(i) if i >= 0 => Some(i),
            Some(_) => {
                msgs.push("priority must not be less than 0".into());
                None
            }
            None => {
                msgs.push("priority must be an integer number".into());
                None
            }
        },
        None => None,
        _ => {
            msgs.push("priority must not be less than 0".into());
            msgs.push("priority must be a number conforming to the specified constraints".into());
            None
        }
    };
    if !msgs.is_empty() {
        return Err(AppError::bad_request(msgs));
    }
    Ok(Body {
        name,
        kind,
        settings,
        enabled,
        priority,
    })
}

/// A JSON number that is integral (`1.0` counts) and fits an int32.
pub(super) fn int32(n: &serde_json::Number) -> Option<i32> {
    let f = n.as_f64()?;
    (f.fract() == 0.0 && f >= f64::from(i32::MIN) && f <= f64::from(i32::MAX)).then_some(f as i32)
}

async fn find(st: &AppState, id: i32) -> Res<ProviderRow> {
    sqlx::query_as::<_, ProviderRow>(&format!(
        "SELECT {PROVIDER_COLS} FROM subtitle_providers WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(|| AppError::not_found(format!("SubtitleProvider #{id} not found")))
}

#[utoipa::path(get, path = "/api/subtitles/providers/rate-limits", responses((status = 200)))]
pub async fn rate_limits(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<CooldownInfo>>> {
    policy(&a, Action::Read)?;
    Ok(Json(st.subtitles.limiter.all()))
}

/// A probe never errors: a thrown message is `{ok: false, detail}`.
async fn probe(st: &AppState, kind: &str, settings: &Value) -> Value {
    let r = match Provider::new(kind, settings, &st.subtitles) {
        Ok(p) => p.test().await,
        Err(e) => super::providers::TestResult::fail(e),
    };
    match r.detail {
        Some(d) => json!({"ok": r.ok, "detail": d}),
        None => json!({"ok": r.ok}),
    }
}

#[utoipa::path(post, path = "/api/subtitles/providers/test-connection", responses((status = 201)))]
pub async fn test_connection(
    State(st): State<AppState>,
    a: Authed,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Update)?;
    let obj = body.0.as_object().cloned().unwrap_or_default();
    let mut msgs = vec![];
    let kind = obj
        .get("type")
        .and_then(Value::as_str)
        .filter(|t| ENUM.contains(t));
    if kind.is_none() {
        msgs.push(format!(
            "type must be one of the following values: {}",
            ENUM.join(", ")
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
        Some(Value::Number(n)) if int32(n).is_some() => int32(n),
        _ => {
            msgs.push("id must be an integer number".into());
            None
        }
    };
    let Some(kind) = kind.filter(|_| msgs.is_empty()) else {
        return Err(AppError::bad_request(msgs));
    };
    let stored = match id {
        Some(i) => {
            sqlx::query_as::<_, ProviderRow>(&format!(
                "SELECT {PROVIDER_COLS} FROM subtitle_providers WHERE id = $1"
            ))
            .bind(i)
            .fetch_optional(&st.db)
            .await?
        }
        None => None,
    };
    // Stored secrets resolve only for the same provider type.
    let keep = stored
        .as_ref()
        .filter(|s| s.kind == kind)
        .map(|s| &s.settings);
    let settings = secrets::merge(keep, &settings, &SECRET_KEYS);
    Ok((StatusCode::CREATED, Json(probe(&st, kind, &settings).await)))
}

#[utoipa::path(post, path = "/api/subtitles/providers", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let b = validate(body.0, true)?;
    let settings = secrets::merge(None, &b.settings.unwrap_or_else(|| json!({})), &SECRET_KEYS);
    let row: ProviderRow = sqlx::query_as(&format!(
        r#"INSERT INTO subtitle_providers (name, "type", enabled, settings, priority)
           VALUES ($1, $2::text::subtitle_providers_type_enum, $3, $4, $5) RETURNING {PROVIDER_COLS}"#
    ))
    .bind(b.name.unwrap_or_default())
    .bind(b.kind.unwrap_or_default())
    .bind(b.enabled.unwrap_or(true))
    .bind(&settings)
    .bind(b.priority.unwrap_or(25))
    .fetch_one(&st.db)
    .await?;
    Ok((StatusCode::CREATED, Json(view(&row))))
}

#[utoipa::path(get, path = "/api/subtitles/providers", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed) -> Res<Json<Vec<Value>>> {
    policy(&a, Action::Read)?;
    let rows: Vec<ProviderRow> = sqlx::query_as(&format!(
        "SELECT {PROVIDER_COLS} FROM subtitle_providers ORDER BY priority ASC, name ASC, id ASC"
    ))
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows.iter().map(view).collect()))
}

#[utoipa::path(get, path = "/api/subtitles/providers/{id}", responses((status = 200)))]
pub async fn get_one(State(st): State<AppState>, a: Authed, id: Id) -> Res<Json<Value>> {
    policy(&a, Action::Read)?;
    let PathParams(id) = id?;
    Ok(Json(view(&find(&st, id).await?)))
}

#[utoipa::path(put, path = "/api/subtitles/providers/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    id: Id,
    body: ValidJson<Value>,
) -> Res<Json<Value>> {
    policy(&a, Action::Update)?;
    let PathParams(id) = id?;
    let b = validate(body.0, false)?;
    let cur = find(&st, id).await?;
    let kind = b.kind.unwrap_or_else(|| cur.kind.clone());
    // A changed type never inherits the stored credentials.
    let keep = (kind == cur.kind).then_some(&cur.settings);
    let settings = match &b.settings {
        Some(s) => secrets::merge(keep, s, &SECRET_KEYS),
        None if kind != cur.kind => Value::Object(
            cur.settings
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(k, _)| !SECRET_KEYS.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<Map<_, _>>(),
        ),
        None => cur.settings.clone(),
    };
    let row: ProviderRow = sqlx::query_as(&format!(
        r#"UPDATE subtitle_providers SET name = $2, "type" = $3::text::subtitle_providers_type_enum, enabled = $4,
             settings = $5, priority = $6, "updatedAt" = now() WHERE id = $1 RETURNING {PROVIDER_COLS}"#
    ))
    .bind(id)
    .bind(b.name.unwrap_or(cur.name))
    .bind(&kind)
    .bind(b.enabled.unwrap_or(cur.enabled))
    .bind(&settings)
    .bind(b.priority.unwrap_or(cur.priority))
    .fetch_one(&st.db)
    .await?;
    Ok(Json(view(&row)))
}

#[utoipa::path(delete, path = "/api/subtitles/providers/{id}", responses((status = 200)))]
pub async fn remove(State(st): State<AppState>, a: Authed, id: Id) -> Res<StatusCode> {
    policy(&a, Action::Delete)?;
    let PathParams(id) = id?;
    find(&st, id).await?;
    sqlx::query("DELETE FROM subtitle_providers WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::OK)
}

#[utoipa::path(post, path = "/api/subtitles/providers/{id}/test", responses((status = 201)))]
pub async fn test(State(st): State<AppState>, a: Authed, id: Id) -> Res<(StatusCode, Json<Value>)> {
    // The stored credentials are used, so the route needs `settings.access`.
    policy(&a, Action::Update)?;
    let PathParams(id) = id?;
    let p = find(&st, id).await?;
    Ok((
        StatusCode::CREATED,
        Json(probe(&st, &p.kind, &p.settings).await),
    ))
}

#[derive(FromRow)]
struct StatRow {
    date: NaiveDate,
    queries: i64,
    avg: Option<i32>,
    total: Option<i32>,
    errors: Option<i32>,
}

#[utoipa::path(get, path = "/api/subtitles/providers/{id}/stats", responses((status = 200)))]
pub async fn stats(State(st): State<AppState>, a: Authed, id: Id) -> Res<Json<Vec<Value>>> {
    policy(&a, Action::Read)?;
    let PathParams(id) = id?;
    let tz = crate::jobs::server_tz();
    let since = window_start(tz, Utc::now());
    let rows: Vec<StatRow> = sqlx::query_as(
        r#"SELECT DATE(s."queryDate") AS date, COUNT(*) AS queries, AVG(s."responseTimeMs")::int AS avg,
                  SUM(s."resultCount")::int AS total,
                  SUM(CASE WHEN s."errorMessage" IS NOT NULL THEN 1 ELSE 0 END)::int AS errors
           FROM subtitle_provider_stats s WHERE s."providerId" = $1 AND s."queryDate" >= $2
           GROUP BY DATE(s."queryDate") ORDER BY date DESC"#,
    )
    .bind(id)
    .bind(since)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.iter()
            .map(|r| {
                json!({"date": iso(local_midnight(tz, r.date)), "queries": r.queries.to_string(), "avgResponseMs": r.avg,
                    "totalResults": r.total, "errors": r.errors})
            })
            .collect(),
    ))
}

/// `setDate(-30)`: 30 calendar days at the same local time, not 720 hours across a DST change.
fn window_start(tz: chrono_tz::Tz, now: DateTime<Utc>) -> DateTime<Utc> {
    let local = now.with_timezone(&tz).naive_local() - chrono::Days::new(30);
    tz.from_local_datetime(&local).earliest().map_or_else(
        || now - chrono::Duration::days(30),
        |t| t.with_timezone(&Utc),
    )
}

/// The pg `date` read as local midnight of the server zone.
fn local_midnight(tz: chrono_tz::Tz, d: NaiveDate) -> DateTime<Utc> {
    let midnight = d.and_hms_opt(0, 0, 0).unwrap_or_default();
    tz.from_local_datetime(&midnight).earliest().map_or_else(
        || Utc.from_utc_datetime(&midnight),
        |t| t.with_timezone(&Utc),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats_dates_are_local_midnights_and_the_window_is_30_calendar_days() {
        let paris: chrono_tz::Tz = "Europe/Paris".parse().unwrap();
        let day = NaiveDate::from_ymd_opt(2026, 7, 1).unwrap();
        assert_eq!(iso(local_midnight(paris, day)), "2026-06-30T22:00:00.000Z");
        let now = Utc.with_ymd_and_hms(2026, 11, 2, 12, 0, 0).unwrap();
        // 30 days back crosses the end of DST: the local time of day is kept (13:00 CET -> 12:00 CEST).
        assert_eq!(
            window_start(paris, now),
            Utc.with_ymd_and_hms(2026, 10, 3, 11, 0, 0).unwrap()
        );
    }
}

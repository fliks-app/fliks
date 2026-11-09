//! `/api/acquisition/queue` and `/api/acquisition/history` (`plugins.md` rules 73-74).
use crate::http::{AppError, auth::Authed, validate::PathParams};
use crate::state::AppState;
use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use chrono::{DateTime, SecondsFormat, Utc};
use fliks_domain::acl::{Action, Subject};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::FromRow;

#[derive(utoipa::OpenApi)]
#[openapi(paths(
    queue_list,
    history_list,
    history_delete,
    history_clear,
    queue_pause,
    queue_resume,
    queue_retry_import,
    queue_remove
))]
pub struct Doc;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/acquisition/queue", get(queue_list))
        .route("/api/acquisition/queue/{id}", delete(queue_remove))
        .route("/api/acquisition/queue/{id}/pause", post(queue_pause))
        .route("/api/acquisition/queue/{id}/resume", post(queue_resume))
        .route(
            "/api/acquisition/queue/{id}/retry-import",
            post(queue_retry_import),
        )
        .route(
            "/api/acquisition/history",
            get(history_list).delete(history_clear),
        )
        .route("/api/acquisition/history/{id}", delete(history_delete))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    page: Option<i64>,
    page_size: Option<i64>,
    q: Option<String>,
    state: Option<String>,
    blocklist: Option<bool>,
}

impl Page {
    fn window(&self) -> (i64, i64) {
        let size = self.page_size.unwrap_or(25).clamp(1, 100);
        (self.page.unwrap_or(1).max(1), size)
    }
}

#[derive(FromRow)]
struct Row {
    id: i32,
    #[sqlx(rename = "pluginId")]
    plugin_id: String,
    r#ref: String,
    #[sqlx(rename = "mediaId")]
    media_id: i32,
    #[sqlx(rename = "mediaType")]
    media_type: String,
    #[sqlx(rename = "mediaTitle")]
    media_title: String,
    season: Option<i32>,
    episode: Option<i32>,
    #[sqlx(rename = "sourceName")]
    source_name: String,
    title: String,
    quality: String,
    method: String,
    #[sqlx(rename = "infoUrl")]
    info_url: Option<String>,
    state: String,
    progress: f64,
    size: Option<i64>,
    #[sqlx(rename = "bytesPerSecond")]
    bytes_per_second: Option<f64>,
    eta: Option<f64>,
    error: Option<String>,
    #[sqlx(rename = "createdAt")]
    created_at: DateTime<Utc>,
    #[sqlx(rename = "finishedAt")]
    finished_at: Option<DateTime<Utc>>,
}

const SELECT: &str = r#"SELECT q.id, q."pluginId", q."ref", q."mediaId", m.type AS "mediaType", m.title AS "mediaTitle",
    q.season, q.episode, q."sourceName", q.title, q.quality, q.method, q."infoUrl", q.state, q.progress, q.size,
    q."bytesPerSecond", q.eta, q.error, q."createdAt", q."finishedAt"
  FROM acquisition_queue q JOIN media m ON m.id = q."mediaId""#;

/// A media's title, or `<title> - S01E02` for a unit.
fn label(r: &Row) -> String {
    match (r.season, r.episode) {
        (None, _) => r.media_title.clone(),
        (Some(s), None) => format!("{} - S{s:02}", r.media_title),
        (Some(s), Some(e)) => format!("{} - S{s:02}E{e:02}", r.media_title),
    }
}

fn date(d: DateTime<Utc>) -> String {
    d.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn wire(r: Row) -> Value {
    json!({
        "id": r.id,
        "pluginId": r.plugin_id,
        "ref": r.r#ref,
        "mediaId": r.media_id,
        "mediaType": r.media_type,
        "title": label(&r),
        "sourceTitle": r.title,
        "quality": r.quality,
        "source": r.source_name,
        "method": r.method,
        "infoUrl": r.info_url,
        "state": r.state,
        "progress": r.progress * 100.0,
        "size": r.size.filter(|s| *s > 0),
        "bytesPerSecond": r.bytes_per_second,
        "eta": r.eta,
        "statusMessage": r.error,
        "date": date(r.created_at),
        "finishedAt": r.finished_at.map(date),
    })
}

/// `%`, `_` and `\` match themselves in a `LIKE`.
fn like(q: &str) -> String {
    let mut out = String::from("%");
    for c in q.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('%');
    out
}

async fn list(st: &AppState, a: &Authed, p: &Page, open: bool) -> Result<Json<Value>, AppError> {
    a.require(Action::Grab, Subject::Media)?;
    let (page, size) = p.window();
    let (q, state) = if open {
        (None, None)
    } else {
        let state = p.state.as_deref().filter(|s| !s.is_empty());
        if state.is_some_and(|s| !matches!(s, "imported" | "failed" | "removed")) {
            return Err(AppError::bad_request(
                "state must be imported, failed or removed",
            ));
        }
        (
            p.q.as_deref().map(str::trim).filter(|q| !q.is_empty()),
            state,
        )
    };
    let closed = if open { "IS NULL" } else { "IS NOT NULL" };
    let filter = format!(
        r#" WHERE q."finishedAt" {closed}
            AND ($1::text IS NULL OR q.title ILIKE $1 OR m.title ILIKE $1)
            AND ($2::text IS NULL OR q.state = $2)"#
    );
    let like = q.map(like);
    let order = if open {
        "q.id DESC"
    } else {
        r#"q."finishedAt" DESC, q.id DESC"#
    };
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT count(*) FROM acquisition_queue q JOIN media m ON m.id = q."mediaId"{filter}"#
    )))
    .bind(&like)
    .bind(state)
    .fetch_one(&st.db)
    .await?;
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{SELECT}{filter} ORDER BY {order} LIMIT $3 OFFSET $4"
    )))
    .bind(&like)
    .bind(state)
    .bind(size)
    .bind((page - 1) * size)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(json!({
        "data": rows.into_iter().map(wire).collect::<Vec<_>>(),
        "total": total,
        "page": page,
        "pageSize": size,
    })))
}

#[utoipa::path(get, path = "/api/acquisition/queue", responses((status = 200)))]
pub async fn queue_list(
    State(st): State<AppState>,
    a: Authed,
    Query(p): Query<Page>,
) -> Result<Json<Value>, AppError> {
    list(&st, &a, &p, true).await
}

#[utoipa::path(get, path = "/api/acquisition/history", responses((status = 200)))]
pub async fn history_list(
    State(st): State<AppState>,
    a: Authed,
    Query(p): Query<Page>,
) -> Result<Json<Value>, AppError> {
    list(&st, &a, &p, false).await
}

#[utoipa::path(delete, path = "/api/acquisition/history/{id}", responses((status = 204)))]
pub async fn history_delete(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Grab, Subject::Media)?;
    let done =
        sqlx::query(r#"DELETE FROM acquisition_queue WHERE id = $1 AND "finishedAt" IS NOT NULL"#)
            .bind(id?.0)
            .execute(&st.db)
            .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::not_found("History entry not found"));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(delete, path = "/api/acquisition/history", responses((status = 204)))]
pub async fn history_clear(State(st): State<AppState>, a: Authed) -> Result<StatusCode, AppError> {
    a.require(Action::Grab, Subject::Media)?;
    sqlx::query(r#"DELETE FROM acquisition_queue WHERE "finishedAt" IS NOT NULL"#)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// The states an action applies to, and the manifest key of its route.
fn action(name: &str) -> (&'static [&'static str], &'static str) {
    match name {
        "pause" => (&["queued", "active", "stalled"], "pause"),
        "resume" => (&["paused"], "resume"),
        "retry-import" => (&["import_failed"], "retryImport"),
        _ => (
            &[
                "queued",
                "active",
                "stalled",
                "paused",
                "importing",
                "import_failed",
            ],
            "remove",
        ),
    }
}

/// Calls the owning provider's route for `name` (rule 74); the row changes through its next `queue.set`.
async fn act(
    st: &AppState,
    a: &Authed,
    id: i32,
    name: &str,
    blocklist: Option<bool>,
) -> Result<StatusCode, AppError> {
    a.require(Action::Grab, Subject::Media)?;
    let (states, key) = action(name);
    let row: Option<(String, String, String)> = sqlx::query_as(
        r#"SELECT "pluginId", "ref", state FROM acquisition_queue WHERE id = $1 AND "finishedAt" IS NULL"#,
    )
    .bind(id)
    .fetch_optional(&st.db)
    .await?;
    let (plugin, r#ref, state) = row.ok_or_else(|| AppError::not_found("Queue entry not found"))?;
    if !states.contains(&state.as_str()) {
        return Err(AppError::conflict(format!("Cannot {name} a {state} entry")));
    }
    let route = st
        .plugins
        .registry
        .queue_action_of(&plugin, key)
        .ok_or_else(|| AppError::conflict(format!("The provider offers no {name} action")))?;
    let mut body = json!({"ref": r#ref});
    if let Some(b) = blocklist {
        body["blocklist"] = json!(b);
    }
    st.plugins
        .call_route(&plugin, "POST", route, vec![], body)
        .await
        .map_err(|e| match e {
            crate::plugins::sweep::RouteError::Unavailable => {
                AppError::plain(StatusCode::SERVICE_UNAVAILABLE, "PLUGIN_UNAVAILABLE")
            }
            crate::plugins::sweep::RouteError::Failed(m) => {
                AppError::with_message(StatusCode::BAD_GATEWAY, m)
            }
        })?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/acquisition/queue/{id}/pause", responses((status = 204)))]
pub async fn queue_pause(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<StatusCode, AppError> {
    act(&st, &a, id?.0, "pause", None).await
}

#[utoipa::path(post, path = "/api/acquisition/queue/{id}/resume", responses((status = 204)))]
pub async fn queue_resume(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<StatusCode, AppError> {
    act(&st, &a, id?.0, "resume", None).await
}

#[utoipa::path(post, path = "/api/acquisition/queue/{id}/retry-import", responses((status = 204)))]
pub async fn queue_retry_import(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Result<StatusCode, AppError> {
    act(&st, &a, id?.0, "retry-import", None).await
}

#[utoipa::path(delete, path = "/api/acquisition/queue/{id}", responses((status = 204)))]
pub async fn queue_remove(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
    Query(p): Query<Page>,
) -> Result<StatusCode, AppError> {
    act(&st, &a, id?.0, "remove", Some(p.blocklist.unwrap_or(false))).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_escapes_its_wildcards() {
        assert_eq!(like("50%_a\\"), "%50\\%\\_a\\\\%");
    }

    #[test]
    fn an_action_names_its_states_and_route() {
        assert_eq!(
            action("retry-import"),
            (&["import_failed"][..], "retryImport")
        );
        assert!(action("remove").0.contains(&"importing"));
        assert!(!action("pause").0.contains(&"paused"));
    }
}

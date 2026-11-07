//! Queue control for the tracking page: pause, priority, batch cancellation, the completion estimate,
//! the library-wide queueing and the restore.
use super::{enqueue, estimate, recover, settings, store};
use crate::{
    events::SseEvent,
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson},
    },
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use fliks_domain::acl::{Action, Subject};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::BTreeMap;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/optimize/queue", get(status))
        .route("/api/optimize/queue/pause", post(pause))
        .route("/api/optimize/queue/resume", post(resume))
        .route("/api/optimize/jobs/priority", post(prioritize))
        .route("/api/optimize/jobs/cancel", post(cancel_many))
        .route("/api/optimize/jobs/{id}/restore", post(restore))
        .route("/api/libraries/{id}/optimize/queue", post(queue_library))
}

fn manage(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::Library)
}

fn db(e: sqlx::Error) -> AppError {
    e.into()
}

/// The libraries the caller reads, `None` for everyone (admin).
pub(super) async fn scope(st: &AppState, a: &Authed) -> Result<Option<Vec<i32>>, AppError> {
    if a.user.is_admin || a.perms.can(Action::Manage, &Subject::All) {
        return Ok(None);
    }
    Ok(Some(accessible_library_ids(&st.db, a).await?))
}

/// The ids of `files` that sit in a readable library.
pub(super) async fn readable_files(
    st: &AppState,
    a: &Authed,
    files: &[i32],
) -> Result<Vec<i32>, AppError> {
    let Some(libs) = scope(st, a).await? else {
        return Ok(files.to_vec());
    };
    sqlx::query_scalar(
        r#"SELECT f.id FROM media_files f JOIN media m ON m.id = f."mediaId"
           WHERE f.id = ANY($1) AND m."libraryId" = ANY($2)"#,
    )
    .bind(files)
    .bind(libs)
    .fetch_all(&st.db)
    .await
    .map_err(db)
}

/// The ids of `jobs` whose file sits in a readable library.
pub(super) async fn readable_jobs(
    st: &AppState,
    a: &Authed,
    jobs: &[i64],
) -> Result<Vec<i64>, AppError> {
    let Some(libs) = scope(st, a).await? else {
        return Ok(jobs.to_vec());
    };
    sqlx::query_scalar(
        r#"SELECT j.id FROM jobs j JOIN media_files f ON f.id = j."mediaFileId"
           JOIN media m ON m.id = f."mediaId"
           WHERE j.id = ANY($1) AND m."libraryId" = ANY($2)"#,
    )
    .bind(jobs)
    .bind(libs)
    .fetch_all(&st.db)
    .await
    .map_err(db)
}

pub(super) async fn require_job(st: &AppState, a: &Authed, id: i64) -> Result<(), AppError> {
    if readable_jobs(st, a, &[id]).await?.is_empty() {
        return Err(AppError::not_found(format!("Job #{id} not found")));
    }
    Ok(())
}

pub(super) async fn require_files(st: &AppState, a: &Authed, ids: &[i32]) -> Result<(), AppError> {
    if readable_files(st, a, ids).await?.len()
        != ids.iter().collect::<std::collections::HashSet<_>>().len()
    {
        return Err(AppError::not_found("File not found"));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    paused: bool,
    /// Inside the time window (or no window): new leases may start.
    open: bool,
    counts: BTreeMap<String, i64>,
    estimate: estimate::Estimate,
}

#[utoipa::path(get, path = "/api/optimize/queue", responses((status = 200)))]
pub async fn status(State(st): State<AppState>, a: Authed) -> Result<Json<Status>, AppError> {
    manage(&a)?;
    let conf = settings::load(&st.db).await.map_err(db)?;
    let counts = sqlx::query("SELECT state, count(*) AS n FROM jobs GROUP BY state")
        .fetch_all(&st.db)
        .await
        .map_err(db)?
        .iter()
        .map(|r| (r.get("state"), r.get("n")))
        .collect();
    Ok(Json(Status {
        paused: conf.paused,
        open: conf.open_now(),
        counts,
        estimate: estimate::remaining(&st).await.map_err(db)?,
    }))
}

async fn set_paused(st: &AppState, paused: bool) -> Result<Json<Value>, AppError> {
    let mut conf = settings::load(&st.db).await.map_err(db)?;
    conf.paused = paused;
    settings::save(&st.db, &conf).await.map_err(db)?;
    st.queue.wake.notify_waiters();
    super::emit_managers(st, SseEvent::OptimizeQueueChanged {}).await;
    Ok(Json(json!({ "paused": paused })))
}

/// No new lease; running jobs finish.
#[utoipa::path(post, path = "/api/optimize/queue/pause", responses((status = 200)))]
pub async fn pause(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    manage(&a)?;
    set_paused(&st, true).await
}

#[utoipa::path(post, path = "/api/optimize/queue/resume", responses((status = 200)))]
pub async fn resume(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    manage(&a)?;
    set_paused(&st, false).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ids {
    ids: Vec<i64>,
}

fn checked(ids: &[i64]) -> Result<(), AppError> {
    if ids.is_empty() || ids.len() > 5000 {
        return Err(AppError::bad_request("ids must hold 1 to 5000 jobs"));
    }
    Ok(())
}

/// Moves queued jobs to the front, in the order given.
#[utoipa::path(post, path = "/api/optimize/jobs/priority", responses((status = 200)))]
pub async fn prioritize(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Ids>,
) -> Result<Json<Value>, AppError> {
    manage(&a)?;
    checked(&body.ids)?;
    let ids = readable_jobs(&st, &a, &body.ids).await?;
    let ids: Vec<i64> = body
        .ids
        .iter()
        .copied()
        .filter(|i| ids.contains(i))
        .collect();
    let moved = sqlx::query(
        r#"WITH top AS (SELECT COALESCE(max(priority), 0) AS p FROM jobs WHERE state = 'queued'),
                u AS (SELECT id, n FROM unnest($1::bigint[]) WITH ORDINALITY AS t(id, n))
           UPDATE jobs SET priority = top.p + 1 + (cardinality($1::bigint[]) - u.n)::int, "updatedAt" = now()
           FROM top, u WHERE jobs.id = u.id AND jobs.state = 'queued' RETURNING jobs.id"#,
    )
    .bind(&ids)
    .fetch_all(&st.db)
    .await
    .map_err(db)?
    .len();
    st.queue.wake.notify_waiters();
    super::emit_managers(&st, SseEvent::OptimizeQueueChanged {}).await;
    Ok(Json(json!({ "moved": moved })))
}

#[derive(Serialize)]
pub struct Cancelled {
    cancelled: Vec<i64>,
}

/// Cancels the jobs that still can be; a `committing` or finished one is left alone.
#[utoipa::path(post, path = "/api/optimize/jobs/cancel", responses((status = 200)))]
pub async fn cancel_many(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Ids>,
) -> Result<Json<Cancelled>, AppError> {
    manage(&a)?;
    checked(&body.ids)?;
    let allowed = readable_jobs(&st, &a, &body.ids).await?;
    let mut done = vec![];
    for id in body.ids.into_iter().filter(|i| allowed.contains(i)) {
        if store::cancel(&st.db, id).await.map_err(db)? {
            done.push(id);
        }
    }
    st.queue.wake.notify_waiters();
    super::emit_managers(&st, SseEvent::OptimizeQueueChanged {}).await;
    Ok(Json(Cancelled { cancelled: done }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LibraryQueue {
    #[serde(default)]
    priority: i32,
}

/// Queues every file of the library that differs from its profile; the queueing continues in the background.
#[utoipa::path(post, path = "/api/libraries/{id}/optimize/queue", responses((status = 202)))]
pub async fn queue_library(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i32>,
    ValidJson(body): ValidJson<LibraryQueue>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    manage(&a)?;
    if !accessible_library_ids(&st.db, &a).await?.contains(&id) {
        return Err(AppError::not_found(format!("Library #{id} not found")));
    }
    let has: Option<i32> =
        sqlx::query_scalar(r#"SELECT "optimizeProfileId" FROM libraries WHERE id = $1"#)
            .bind(id)
            .fetch_one(&st.db)
            .await
            .map_err(db)?;
    if has.is_none() {
        return Err(AppError::bad_request("the library has no optimize profile"));
    }
    let files = enqueue::queue_library(&st, id, body.priority)
        .await
        .map_err(db)?;
    Ok((StatusCode::ACCEPTED, Json(json!({ "files": files }))))
}

/// Brings the original back; the optimized file takes its place in the trash or `.orig`.
#[utoipa::path(post, path = "/api/optimize/jobs/{id}/restore", responses((status = 200), (status = 409)))]
pub async fn restore(
    State(st): State<AppState>,
    a: Authed,
    PathParams(id): PathParams<i64>,
) -> Result<Json<Value>, AppError> {
    manage(&a)?;
    require_job(&st, &a, id).await?;
    recover::restore(&st, id)
        .await
        .map_err(AppError::conflict)?;
    super::emit_managers(&st, SseEvent::OptimizeQueueChanged {}).await;
    Ok(Json(json!({})))
}

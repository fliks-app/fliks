//! `/api/commands*` (`scheduler.md` rules 10-21).
use super::{audit, cron, names, runner};
use crate::{
    bridge::BridgedJob,
    http::{
        AppError,
        auth::Authed,
        json::iso_ms,
        validate::{ValidJson, int_query},
    },
    state::AppState,
};
use axum::{
    Json, Router,
    extract::{FromRequest, Query, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get},
};
use chrono::{DateTime, Utc};
use fliks_domain::acl::{Action, Subject};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/commands/schedulers", get(schedulers))
        .route("/api/commands", get(list).post(trigger))
        .route("/api/commands/history", delete(clear_history))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerJob {
    name: String,
    cron: String,
    triggerable: bool,
    label_key: String,
    #[serde(with = "iso_ms::opt")]
    last_run: Option<DateTime<Utc>>,
    last_status: Option<String>,
    #[serde(with = "iso_ms")]
    next_run: DateTime<Utc>,
    plugin_id: Option<String>,
}

#[utoipa::path(get, path = "/api/commands/schedulers", responses((status = 200)))]
pub async fn schedulers(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<SchedulerJob>>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let held = st.bridge.jobs().await.unwrap_or_default();
    let core = names::CORE
        .iter()
        .chain(names::LIVETV.iter())
        .map(|(n, c, l)| BridgedJob {
            name: (*n).into(),
            cron: (*c).into(),
            triggerable: true,
            label_key: (*l).into(),
            plugin_id: None,
        });
    let all: Vec<BridgedJob> = core.chain(held).collect();
    let tracked: Vec<String> = all
        .iter()
        .filter(|j| j.plugin_id.is_none())
        .map(|j| j.name.clone())
        .collect();
    let last = audit::last_runs(&st.db, &tracked).await?;
    let (tz, now) = (cron::server_tz(), Utc::now());
    let mut out = vec![];
    for j in all {
        let next = cron::parse(&j.cron)
            .ok()
            .and_then(|c| cron::next_after(&c, tz, now));
        let Some(next_run) = next else {
            tracing::warn!("job \"{}\" has no next run for \"{}\"", j.name, j.cron);
            continue;
        };
        let (last_run, last_status) = match last.get(&j.name) {
            Some((at, status)) => (*at, Some(status.clone())),
            None => (None, None),
        };
        out.push(SchedulerJob {
            name: j.name,
            cron: j.cron,
            triggerable: j.triggerable,
            label_key: j.label_key,
            last_run,
            last_status,
            next_run,
            plugin_id: j.plugin_id,
        });
    }
    Ok(Json(out))
}

#[utoipa::path(get, path = "/api/commands", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let (page, limit) = (int_query(q.get("page"))?, int_query(q.get("limit"))?);
    let page = page.filter(|p| *p != 0).map_or(1, |p| p.max(1));
    let limit = limit.filter(|l| *l != 0).map_or(25, |l| l.clamp(1, 100));
    let (data, total) = audit::page(&st.db, (page - 1).saturating_mul(limit), limit).await?;
    Ok(Json(json!({"data": data, "total": total})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Dto {
    name: Option<String>,
}

#[derive(PartialEq)]
enum Kind {
    Rust,
    Held,
    Plugin,
}

/// Rule 15: where the name runs, or the 400 listing every valid one.
fn classify(name: &str, held: &[BridgedJob]) -> Result<Kind, AppError> {
    if names::is_core(name) {
        return Ok(Kind::Rust);
    }
    match held.iter().find(|j| j.name == name) {
        Some(j) if j.plugin_id.is_some() => Ok(Kind::Plugin),
        Some(j) if j.triggerable => Ok(Kind::Held),
        _ => {
            let valid: Vec<&str> = names::CORE
                .iter()
                .chain(names::LIVETV.iter())
                .map(|(n, ..)| *n)
                .chain(
                    held.iter()
                        .filter(|j| j.plugin_id.is_none() && j.triggerable)
                        .map(|j| j.name.as_str()),
                )
                .chain(names::TRIGGER_ONLY)
                .collect();
            Err(AppError::bad_request(format!(
                "Unknown command: {name}. Valid: {}",
                valid.join(", ")
            )))
        }
    }
}

#[utoipa::path(post, path = "/api/commands", responses((status = 201)))]
pub async fn trigger(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Result<Response, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let ValidJson(Dto { name }) = ValidJson::<Dto>::from_request(req, &()).await?;
    let name = name.ok_or_else(|| AppError::bad_request(vec!["name must be a string"]))?;
    let held = if names::is_core(&name) {
        vec![]
    } else {
        st.bridge.jobs().await.unwrap_or_default()
    };
    if classify(&name, &held)? == Kind::Plugin {
        return plugin_job(&st, &name).await;
    }
    let claim = st
        .jobs
        .claim(&name)
        .ok_or_else(|| AppError::conflict(format!("Command \"{name}\" is already running")))?;
    let queued = audit::insert_queued(&st.db, &name).await?;
    tokio::spawn(runner::run_manual(st, queued.id, name, claim));
    Ok((StatusCode::CREATED, Json(queued)).into_response())
}

/// Rule 18: a plugin job has no `commands` row; Nest answers at once.
async fn plugin_job(st: &AppState, name: &str) -> Result<Response, AppError> {
    let (status, message) = st
        .bridge
        .run_job(name)
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    match status.as_u16() {
        202 => Ok((StatusCode::CREATED, Json(json!({"ok": true}))).into_response()),
        409 => Err(AppError::conflict(format!(
            "Job \"{name}\" is already running"
        ))),
        400 => {
            let reason = message.unwrap_or_default().replace('-', " ");
            Err(AppError::bad_request(format!("Job \"{name}\" is {reason}")))
        }
        s => Err(AppError::internal(format!("jobs/run answered {s}"))),
    }
}

#[utoipa::path(delete, path = "/api/commands/history", responses((status = 200)))]
pub async fn clear_history(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    Ok(Json(
        json!({"deleted": audit::clear_history(&st.db).await?}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_names_list_the_valid_ones_in_order() {
        let held = [BridgedJob {
            name: "NestHeld".into(),
            cron: "0 * * * *".into(),
            triggerable: true,
            label_key: "k".into(),
            plugin_id: None,
        }];
        let Err(e) = classify("nope", &held) else {
            panic!()
        };
        let body = format!("{e:?}");
        assert!(body.contains(
            "Unknown command: nope. Valid: Backup, RefreshMetadata, RefreshPluginSources, SubtitleSearch, SubtitleUpgrade, LiveTvSourceRefresh, LiveTvGuideRefresh, LiveTvGuidePrune, NestHeld, RescanAll, RefreshMissingMetadata"
        ));
        assert!(classify("Backup", &[]).unwrap() == Kind::Rust);
        assert!(classify("NestHeld", &held).unwrap() == Kind::Held);
        assert!(classify("LiveTvGuidePrune", &[]).unwrap() == Kind::Rust);
        assert!(classify("backup", &[]).is_err());
        assert!(classify("IntroDetection", &[]).is_err());
    }
}

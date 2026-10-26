use super::{backup, logs, supervisor, update::UpdateStatus};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{ValidJson, int_query},
    },
    libraries,
    state::AppState,
};
use axum::{
    Json,
    body::Body,
    extract::{FromRequest, Path, Query, Request, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use fliks_domain::acl::{Action, Subject};
use serde::Serialize;
use serde_json::{Value, json};
use std::{collections::HashMap, time::Duration};
use tower::ServiceExt;
use tower_http::services::ServeFile;

/// A dump holds every secret, so the backup routes need `manage:all`.
fn manage_all(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::All)
}

#[derive(Serialize)]
pub struct Database {
    name: &'static str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    version: &'static str,
    uptime_seconds: u64,
    database: Database,
    installed_plugins: i64,
    running_plugins: i64,
    restart_supervisor: Option<&'static str>,
}

#[utoipa::path(get, path = "/api/system/health", responses((status = 200)))]
pub async fn health(State(st): State<AppState>, a: Authed) -> Result<Json<Health>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let probe = sqlx::query("SELECT 1").execute(&st.db).await;
    let ok = probe.is_ok();
    let db = &st.db;
    let count = |sql: &'static str| async move {
        if ok {
            sqlx::query_scalar(sql).fetch_one(db).await.unwrap_or(0)
        } else {
            0
        }
    };
    Ok(Json(Health {
        version: env!("CARGO_PKG_VERSION"),
        uptime_seconds: st.system.started.elapsed().as_secs(),
        database: Database {
            name: "PostgreSQL",
            ok,
            message: probe.err().map(|e| e.to_string()),
        },
        installed_plugins: count("SELECT count(*) FROM plugin_packages").await,
        running_plugins: count("SELECT count(*) FROM plugin_packages WHERE enabled = true").await,
        restart_supervisor: supervisor::current(),
    }))
}

/// Rule 8: respond, then shut down through the normal path and exit non-zero so the supervisor restarts us.
#[utoipa::path(post, path = "/api/system/restart", responses((status = 201)))]
pub async fn restart(State(st): State<AppState>, a: Authed) -> Result<Response, AppError> {
    a.require(Action::Manage, Subject::Settings)?;
    let Some(sup) = supervisor::current() else {
        return Err(AppError::bad_request("No process supervisor detected"));
    };
    tracing::warn!("Restart requested (supervisor: {sup})");
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        st.system
            .restarting
            .store(true, std::sync::atomic::Ordering::SeqCst);
        interrupt();
    });
    Ok((
        StatusCode::CREATED,
        Json(json!({"ok": true, "supervisor": sup})),
    )
        .into_response())
}

#[cfg(unix)]
fn interrupt() {
    // SAFETY: raising SIGTERM on ourselves runs the handlers `shutdown_signal` installed.
    unsafe { libc::raise(libc::SIGTERM) };
}

#[cfg(not(unix))]
fn interrupt() {
    std::process::exit(1);
}

#[utoipa::path(get, path = "/api/system/version", responses((status = 200)))]
pub async fn version(_: Authed) -> Json<Value> {
    // Clients open every feature gate on a `-dev` server: the dev stack runs a debug build.
    let v = env!("CARGO_PKG_VERSION");
    let version = if cfg!(debug_assertions) {
        format!("{v}-dev")
    } else {
        v.to_owned()
    };
    Json(json!({"version": version}))
}

#[utoipa::path(get, path = "/api/system/update", responses((status = 200)))]
pub async fn update(State(st): State<AppState>, a: Authed) -> Result<Json<UpdateStatus>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    Ok(Json(st.system.update.check().await))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    path: String,
    label: String,
    free_space: i64,
    total_space: i64,
}

#[utoipa::path(get, path = "/api/system/stats", responses((status = 200)))]
pub async fn stats(State(st): State<AppState>, a: Authed) -> Result<Json<Value>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let count = |sql: &'static str| sqlx::query_scalar::<_, i32>(sql).fetch_one(&st.db);
    let movies = count("SELECT count(*)::int FROM media WHERE type = 'movie'").await?;
    let series = count("SELECT count(*)::int FROM media WHERE type = 'series'").await?;
    let pending = count("SELECT count(*)::int FROM requests WHERE status = 'pending'").await?;
    let libs: Vec<(i32, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, name, label, path FROM libraries WHERE path IS NOT NULL AND path <> '' ORDER BY name ASC, id ASC",
    )
    .fetch_all(&st.db)
    .await?;
    let mut disk_space = vec![];
    for (_, name, label, path) in libs {
        let d = libraries::disk(&path).await;
        disk_space.push(DiskSpace {
            label: label.unwrap_or(name),
            path,
            free_space: d.free_space,
            total_space: d.total_space,
        });
    }
    Ok(Json(
        json!({"movies": movies, "series": series, "pendingRequests": pending, "diskSpace": disk_space}),
    ))
}

#[utoipa::path(post, path = "/api/system/backup", responses((status = 201)))]
pub async fn backup_create(State(st): State<AppState>, a: Authed) -> Result<Response, AppError> {
    manage_all(&a)?;
    let made = detached(async move { backup::create(&st.cfg, &backup::dir()).await }).await?;
    Ok((StatusCode::CREATED, Json(made)).into_response())
}

#[utoipa::path(get, path = "/api/system/backups", responses((status = 200)))]
pub async fn backup_list(a: Authed) -> Result<Json<Vec<backup::Entry>>, AppError> {
    manage_all(&a)?;
    Ok(Json(backup::list(&backup::dir()).await))
}

#[utoipa::path(post, path = "/api/system/restore", responses((status = 201)))]
pub async fn backup_restore(
    State(st): State<AppState>,
    a: Authed,
    req: Request,
) -> Result<StatusCode, AppError> {
    manage_all(&a)?;
    let ValidJson(body) = ValidJson::<Value>::from_request(req, &()).await?;
    let name = backup::js_string(body.get("filename"));
    if !body.get("filename").is_some_and(Value::is_string) {
        return Err(AppError::bad_request(format!(
            "Invalid backup name \"{name}\""
        )));
    }
    let path = backup::locate(&backup::dir(), &name).await?;
    detached(
        async move { backup::restore(&st.cfg, &st.db, &st.jobs, &st.plugins, &path, &name).await },
    )
    .await?;
    Ok(StatusCode::CREATED)
}

/// A client that goes away must not kill `pg_dump` / `psql` halfway (a dropped handler would).
async fn detached<T: Send + 'static>(
    work: impl Future<Output = Result<T, AppError>> + Send + 'static,
) -> Result<T, AppError> {
    tokio::spawn(work)
        .await
        .map_err(|e| AppError::internal(e.to_string()))?
}

/// A download: `send`'s Range, `Last-Modified` and length, plus a weak ETag and the attachment name.
#[utoipa::path(get, path = "/api/system/backups/{name}", responses((status = 200)))]
pub async fn backup_download(
    a: Authed,
    Path(name): Path<String>,
    req: Request,
) -> Result<Response, AppError> {
    manage_all(&a)?;
    let path = backup::locate(&backup::dir(), &name).await?;
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    let mime = "application/sql".parse().expect("mime");
    let mut res = ServeFile::new_with_mime(&path, &mime)
        .oneshot(req)
        .await
        .map_or_else(|e| match e {}, |r| r.map(Body::new));
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis());
    let h = res.headers_mut();
    let put = |h: &mut axum::http::HeaderMap, k, v: String| {
        if let Ok(v) = HeaderValue::from_str(&v) {
            h.insert(k, v);
        }
    };
    put(
        h,
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{name}\""),
    );
    put(h, header::ETAG, format!("W/\"{:x}-{mtime:x}\"", meta.len()));
    put(h, header::CACHE_CONTROL, "public, max-age=0".into());
    Ok(res)
}

#[utoipa::path(delete, path = "/api/system/backups/{name}", responses((status = 200)))]
pub async fn backup_delete(a: Authed, Path(name): Path<String>) -> Result<Json<Value>, AppError> {
    manage_all(&a)?;
    backup::delete(&backup::dir(), &name).await?;
    Ok(Json(json!({"ok": true})))
}

#[utoipa::path(get, path = "/api/system/logs", responses((status = 200)))]
pub async fn log_list(
    a: Authed,
    Query(q): Query<HashMap<String, String>>,
) -> Result<Json<Vec<logs::Entry>>, AppError> {
    a.require(Action::Read, Subject::Settings)?;
    let limit = int_query(q.get("limit"))?;
    let get = |k: &str| q.get(k).map_or("", String::as_str);
    Ok(Json(logs::query(get("level"), get("q"), limit)))
}

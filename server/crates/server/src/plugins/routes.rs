//! `/api/plugins/*` (`plugins.md` Routes). A path under `/api/plugins/<id>/` that a concrete route
//! does not answer for a method falls through to the proxy.
use super::install::{InstallError, ie};
use super::packages;
use super::runtime::{CallError, State as RtState};
use super::{HttpRequest, Principal};
use crate::http::{AppError, auth::Authed, validate::int_param};
use crate::state::AppState;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Multipart, Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{MethodRouter, any, delete, get, post, put},
};
use fliks_domain::acl::{Action, Subject};
use fliks_domain::plugins::{
    ObjectGuard, parse_object_guard, positive_int, response_header, route::ParamValue,
};
use serde_json::{Value, json};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(paths(
    list,
    metrics,
    ui,
    import_inspect,
    import_confirm,
    import_discard,
    sources_list,
    sources_create,
    sources_update,
    sources_delete,
    sources_catalog,
    sources_refresh,
    sources_inspect,
    enable,
    disable,
    restart,
    events_test,
    uninstall,
    logo,
    export,
    import,
    proxy
))]
pub struct Doc;

fn with_proxy(m: MethodRouter<AppState>) -> MethodRouter<AppState> {
    m.fallback(proxy)
}

pub fn router() -> Router<AppState> {
    let upload = super::archive::MAX_ARCHIVE_BYTES + (64 << 10);
    Router::new()
        .route("/api/plugins", get(list))
        .route(
            "/api/plugins/metrics",
            get(metrics).delete(uninstall_literal),
        )
        .route("/api/plugins/ui", get(ui).delete(uninstall_literal))
        .route(
            "/api/plugins/import/inspect",
            with_proxy(post(import_inspect)).layer(DefaultBodyLimit::max(upload)),
        )
        .route(
            "/api/plugins/import/confirm",
            with_proxy(post(import_confirm)),
        )
        .route(
            "/api/plugins/import/{stagingId}",
            with_proxy(delete(import_discard)),
        )
        .route(
            "/api/plugins/sources",
            get(sources_list)
                .post(sources_create)
                .delete(uninstall_literal),
        )
        .route(
            "/api/plugins/sources/{id}",
            with_proxy(put(sources_update).delete(sources_delete)),
        )
        .route(
            "/api/plugins/sources/{id}/catalog",
            with_proxy(get(sources_catalog)),
        )
        .route(
            "/api/plugins/sources/{id}/refresh",
            with_proxy(post(sources_refresh)),
        )
        .route(
            "/api/plugins/sources/{id}/inspect",
            with_proxy(post(sources_inspect)),
        )
        .route("/api/plugins/{pluginId}", delete(uninstall))
        .route("/api/plugins/{pluginId}/enable", with_proxy(post(enable)))
        .route("/api/plugins/{pluginId}/disable", with_proxy(post(disable)))
        .route("/api/plugins/{pluginId}/restart", with_proxy(post(restart)))
        .route(
            "/api/plugins/{pluginId}/events/test",
            with_proxy(post(events_test)),
        )
        .route("/api/plugins/{pluginId}/logo", with_proxy(get(logo)))
        .route("/api/plugins/{pluginId}/export", with_proxy(get(export)))
        .route("/api/plugins/{pluginId}/import", with_proxy(post(import)))
        .route("/api/plugins/{pluginId}/{*splat}", any(proxy))
}

/// Rule 54: an export document carries whole tables.
const IMPORT_LIMIT: usize = 64 << 20;

/// Paths whose handler reads and bounds its own body after authenticating (the global JSON cap skips them).
pub fn reads_own_body(path: &str) -> bool {
    path.strip_prefix("/api/plugins/")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(id, tail)| !id.is_empty() && tail == "import")
}

type Res = Result<Response, Bail>;

/// An error answer, boxed: a bare `Response` makes every handler's `Err` 128 bytes.
pub struct Bail(Box<Response>);

impl IntoResponse for Bail {
    fn into_response(self) -> Response {
        *self.0
    }
}

impl From<Response> for Bail {
    fn from(r: Response) -> Self {
        Bail(Box::new(r))
    }
}

fn app(e: AppError) -> Bail {
    e.into_response().into()
}

fn inst(e: InstallError) -> Bail {
    e.into_response().into()
}

fn db(e: sqlx::Error) -> Bail {
    app(AppError::from(e))
}

fn need(a: &Authed, action: Action) -> Result<(), Bail> {
    a.require(action, Subject::Settings).map_err(app)
}

#[utoipa::path(get, path = "/api/plugins", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed) -> Res {
    need(&a, Action::Read)?;
    let rows = packages::all(&st.db).await.map_err(db)?;
    let out: Vec<_> = rows.iter().map(|p| st.plugins.summary(p)).collect();
    Ok(Json(out).into_response())
}

#[utoipa::path(get, path = "/api/plugins/metrics", responses((status = 200)))]
pub async fn metrics(State(st): State<AppState>, a: Authed) -> Res {
    need(&a, Action::Read)?;
    let rows = packages::all(&st.db).await.map_err(db)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|p| {
            let m = p.is_process().then(|| st.plugins.rt(&p.plugin_id)).flatten().map(|rt| {
                json!({
                    "hostCallCount": rt.sh.stats.count.load(std::sync::atomic::Ordering::Relaxed),
                    "hostCallFailureCount": rt.sh.stats.failures.load(std::sync::atomic::Ordering::Relaxed),
                    "hostCallP95Ms": rt.sh.stats.p95(),
                    "restartCount": rt.restarts.load(std::sync::atomic::Ordering::Relaxed),
                    "eventDropCount": rt.event_drops.load(std::sync::atomic::Ordering::Relaxed),
                    "residentSetSizeBytes": rt.memory(),
                })
            });
            json!({"pluginId": p.plugin_id, "kind": p.manifest["kind"], "metrics": m})
        })
        .collect();
    Ok(Json(out).into_response())
}

#[utoipa::path(get, path = "/api/plugins/ui", responses((status = 200)))]
pub async fn ui(State(st): State<AppState>, a: Authed) -> Res {
    Ok(Json(st.plugins.ui(&a.perms)).into_response())
}

fn multer(e: axum::extract::multipart::MultipartError) -> Bail {
    if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
        app(AppError::payload_too_large("File too large"))
    } else {
        app(AppError::bad_request(e.body_text()))
    }
}

#[utoipa::path(post, path = "/api/plugins/import/inspect", responses((status = 201)))]
pub async fn import_inspect(
    State(st): State<AppState>,
    a: Authed,
    m: Result<Multipart, axum::extract::multipart::MultipartRejection>,
) -> Res {
    need(&a, Action::Manage)?;
    let mut file: Option<Vec<u8>> = None;
    if let Ok(mut m) = m {
        let mut parts = 0;
        while let Some(mut field) = m.next_field().await.map_err(multer)? {
            parts += 1;
            if parts > 2 {
                return Err(app(AppError::bad_request("Too many parts")));
            }
            if field.file_name().is_none() {
                return Err(app(AppError::bad_request("Too many fields")));
            }
            if field.name() != Some("file") || file.is_some() {
                return Err(app(AppError::bad_request("Unexpected field")));
            }
            let mut b = vec![];
            while let Some(c) = field.chunk().await.map_err(multer)? {
                b.extend_from_slice(&c);
                if b.len() > super::archive::MAX_ARCHIVE_BYTES {
                    return Err(app(AppError::payload_too_large("File too large")));
                }
            }
            file = Some(b);
        }
    }
    let bytes = file.ok_or_else(|| app(AppError::bad_request("No file uploaded")))?;
    let report = st
        .plugins
        .inspect_and_stage(&bytes, "manual")
        .await
        .map_err(inst)?;
    Ok((StatusCode::CREATED, Json(report)).into_response())
}

fn matches_hex(v: &Value, len: usize) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

/// `ConfirmImportDto`: two `@Matches`, unknown keys refused.
fn confirm_dto(body: &Value) -> Result<(String, String), Bail> {
    let mut errs = vec![];
    if let Some(o) = body.as_object() {
        for k in o.keys().filter(|k| *k != "stagingId" && *k != "sha256") {
            errs.push(format!("property {k} should not exist"));
        }
    }
    if !matches_hex(&body["stagingId"], 32) {
        errs.push("stagingId must match /^[0-9a-f]{32}$/ regular expression".into());
    }
    if !matches_hex(&body["sha256"], 64) {
        errs.push("sha256 must match /^[0-9a-f]{64}$/ regular expression".into());
    }
    if !errs.is_empty() {
        return Err(app(AppError::bad_request(errs)));
    }
    Ok((
        body["stagingId"].as_str().unwrap_or_default().into(),
        body["sha256"].as_str().unwrap_or_default().into(),
    ))
}

async fn json_body(headers: &HeaderMap, body: &Bytes) -> Result<Value, Bail> {
    let json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|c| {
            c.split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
    if !json || body.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(body)
        .map_err(|e| app(AppError::plain(StatusCode::BAD_REQUEST, e.to_string())))
}

#[utoipa::path(post, path = "/api/plugins/import/confirm", responses((status = 201)))]
pub async fn import_confirm(
    State(st): State<AppState>,
    a: Authed,
    headers: HeaderMap,
    body: Bytes,
) -> Res {
    need(&a, Action::Manage)?;
    let v = json_body(&headers, &body).await?;
    let (sid, sha) = confirm_dto(&v)?;
    let r = st.plugins.confirm(&sid, &sha).await.map_err(inst)?;
    Ok((StatusCode::CREATED, Json(r)).into_response())
}

#[utoipa::path(delete, path = "/api/plugins/import/{stagingId}", responses((status = 204)))]
pub async fn import_discard(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    if !matches_hex(&Value::String(id.clone()), 32) {
        return Err(app(AppError::bad_request(
            "stagingId must match /^[0-9a-f]{32}$/ regular expression",
        )));
    }
    if !st.plugins.staging.discard(&id).await {
        return Err(inst(ie(
            StatusCode::NOT_FOUND,
            "PLUGIN_STAGING_NOT_FOUND",
            format!("no staged upload \"{id}\""),
        )));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[utoipa::path(post, path = "/api/plugins/{pluginId}/enable", responses((status = 201)))]
pub async fn enable(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    let s = st.plugins.enable(&id).await.map_err(inst)?;
    Ok((StatusCode::CREATED, Json(s)).into_response())
}

#[utoipa::path(post, path = "/api/plugins/{pluginId}/disable", responses((status = 201)))]
pub async fn disable(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    let s = st.plugins.disable(&id).await.map_err(inst)?;
    Ok((StatusCode::CREATED, Json(s)).into_response())
}

#[utoipa::path(post, path = "/api/plugins/{pluginId}/restart", responses((status = 204)))]
pub async fn restart(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    st.plugins.restart(&id).await.map_err(inst)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[utoipa::path(post, path = "/api/plugins/{pluginId}/events/test", responses((status = 201)))]
pub async fn events_test(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    st.plugins.find_installed(&id).await.map_err(inst)?;
    let r = super::webhooks::send_test(&st, &id).await;
    Ok((StatusCode::CREATED, Json(r)).into_response())
}

#[utoipa::path(delete, path = "/api/plugins/{pluginId}", responses((status = 204)))]
pub async fn uninstall(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    st.plugins.uninstall(&id).await.map_err(db)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `DELETE /api/plugins/{ui,metrics,sources}`: 4.x routed these to `:pluginId`.
async fn uninstall_literal(State(st): State<AppState>, a: Authed, req: Request) -> Res {
    need(&a, Action::Manage)?;
    let id = req
        .uri()
        .path()
        .trim_start_matches("/api/plugins/")
        .to_owned();
    st.plugins.uninstall(&id).await.map_err(db)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[utoipa::path(get, path = "/api/plugins/{pluginId}/logo", responses((status = 200)))]
pub async fn logo(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Read)?;
    let r = st
        .plugins
        .registry
        .get(&id)
        .ok_or_else(|| app(AppError::bare(StatusCode::NOT_FOUND)))?;
    let (ct, bytes) = super::archive::verified_logo(&r.archive)
        .ok_or_else(|| app(AppError::bare(StatusCode::NOT_FOUND)))?;
    Ok((
        [
            (header::CONTENT_TYPE, ct),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CONTENT_SECURITY_POLICY, "sandbox"),
        ],
        bytes,
    )
        .into_response())
}

#[utoipa::path(get, path = "/api/plugins/{pluginId}/export", responses((status = 200)))]
pub async fn export(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Read)?;
    let body = st.plugins.export(&id).await.map_err(inst)?;
    Ok(([(header::CONTENT_TYPE, "application/json")], body).into_response())
}

#[utoipa::path(post, path = "/api/plugins/{pluginId}/import", responses((status = 201)))]
pub async fn import(
    State(st): State<AppState>,
    a: Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Body,
) -> Res {
    need(&a, Action::Manage)?;
    let body = axum::body::to_bytes(body, IMPORT_LIMIT)
        .await
        .map_err(|_| app(AppError::payload_too_large("request entity too large")))?;
    let v = json_body(&headers, &body).await?;
    let r = st.plugins.import(&id, &v).await.map_err(inst)?;
    Ok((StatusCode::CREATED, Json(r)).into_response())
}

/// The raw (still percent-encoded) sub-path after `/plugins/<id>`.
fn sub_path(path: &str) -> String {
    let Some(i) = path.find("/plugins/") else {
        return String::new();
    };
    let after = &path[i + "/plugins/".len()..];
    after
        .find('/')
        .map_or_else(String::new, |j| after[j..].to_owned())
}

fn forbidden() -> Bail {
    app(AppError::forbidden("Forbidden resource"))
}

async fn guard_ok(st: &AppState, a: &Authed, g: ObjectGuard, raw: &str) -> bool {
    let Some(id) = positive_int(raw).and_then(|n| i32::try_from(n).ok()) else {
        return false;
    };
    let Ok(ids) = crate::libraries::acl::accessible_library_ids(&st.db, a).await else {
        return false;
    };
    match g {
        ObjectGuard::LibraryAccessible => ids.contains(&id),
        ObjectGuard::MediaAccessible => {
            crate::libraries::acl::assert_media_accessible(&st.db, id, &ids)
                .await
                .is_ok()
        }
    }
}

/// Rules 36-39: route, policy, object guard, live check, then the guest's `http` export.
#[utoipa::path(get, post, put, patch, delete, head, options, path = "/api/plugins/{pluginId}/{*splat}", responses((status = 200)))]
pub async fn proxy(State(st): State<AppState>, a: Authed, req: Request) -> Res {
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_owned();
    let id = path
        .strip_prefix("/api/plugins/")
        .and_then(|r| r.split('/').next())
        .map(|s| {
            fliks_domain::plugins::route::decode_uri_component(s).unwrap_or_else(|| s.to_owned())
        })
        .unwrap_or_default();
    let sub = sub_path(&path);
    let resolved = st
        .plugins
        .registry
        .resolve(&id, parts.method.as_str(), &sub)
        .ok_or_else(forbidden)?;
    if !st
        .plugins
        .registry
        .allows(&id, &resolved.route.policy, &a.perms)
    {
        return Err(forbidden());
    }
    if let Some(g) = &resolved.route.object_guard {
        let Some((guard, param)) = parse_object_guard(g) else {
            return Err(forbidden());
        };
        let value = resolved
            .params
            .iter()
            .find(|(n, _)| n == param)
            .map(|(_, v)| v);
        let Some(ParamValue::One(raw)) = value else {
            return Err(forbidden());
        };
        if !guard_ok(&st, &a, guard, raw).await {
            return Err(forbidden());
        }
    }
    let rt = st.plugins.rt(&id).filter(|r| r.state() == RtState::Ready);
    let Some(rt) = rt else {
        let state = st.plugins.state_of(&id).map(|s| s.as_str().to_owned());
        let why = Some(st.plugins.status_message(&id))
            .filter(|m| !m.is_empty())
            .or(state)
            .unwrap_or_else(|| "not running".into());
        return Err(inst(ie(
            StatusCode::SERVICE_UNAVAILABLE,
            "PLUGIN_UNAVAILABLE",
            format!("plugin \"{id}\" is unavailable ({why})"),
        )));
    };
    let bytes = axum::body::to_bytes(body, crate::app::BODY_LIMIT_BYTES)
        .await
        .map_err(|_| {
            app(AppError::plain(
                StatusCode::PAYLOAD_TOO_LARGE,
                "request entity too large",
            ))
        })?;
    let json = json_body(&parts.headers, &bytes).await?;
    let query: Vec<(String, String)> = parts
        .uri
        .query()
        .map(|q| {
            url::form_urlencoded::parse(q.as_bytes())
                .into_owned()
                .collect()
        })
        .unwrap_or_default();
    let req = HttpRequest {
        method: parts.method.as_str().to_owned(),
        path: sub.clone(),
        query,
        body: serde_json::to_vec(&json).unwrap_or_default(),
        principal: Principal::Delegated(a.user.id as u32),
    };
    let res = match rt.http(req, false).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("plugin \"{id}\" {} {sub}: {e:?}", parts.method);
            return Err(inst(match e {
                CallError::Timeout => ie(
                    StatusCode::GATEWAY_TIMEOUT,
                    "PLUGIN_TIMEOUT",
                    "errors.plugin_timeout",
                ),
                _ => ie(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "PLUGIN_UNAVAILABLE",
                    "errors.plugin_unavailable",
                ),
            }));
        }
    };
    let status = StatusCode::from_u16(res.status)
        .ok()
        .filter(|s| (100..=599).contains(&s.as_u16()))
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out = Response::builder().status(status);
    let h = out.headers_mut().expect("fresh builder");
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    let mut typed = false;
    for (name, value) in &res.headers {
        let Some(bytes) = response_header(name, value) else {
            continue;
        };
        let (Ok(n), Ok(v)) = (
            header::HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_bytes(&bytes),
        ) else {
            continue;
        };
        typed |= n == header::CONTENT_TYPE;
        h.insert(n, v);
    }
    if !typed {
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
    }
    let body = if parts.method == Method::HEAD {
        vec![]
    } else {
        res.body
    };
    Ok(out
        .body(axum::body::Body::from(body))
        .expect("valid response"))
}

mod sources;
pub use sources::*;

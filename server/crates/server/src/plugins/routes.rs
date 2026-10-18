//! `/api/plugins/*` (`plugins.md` Routes). A path under `/api/plugins/<id>/` that a concrete route
//! does not answer for a method falls through to the proxy, as Express did.
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

fn source_summary(s: &packages::Source) -> Value {
    json!({
        "id": s.id,
        "url": s.url,
        "enabled": s.enabled,
        "hasPinnedKey": s.public_key.is_some(),
        "lastRefreshedAt": s.last_refreshed_at.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        "lastRefreshError": s.last_refresh_error,
        "pluginCount": s.cached_catalog.as_ref().and_then(|c| c["plugins"].as_array()).map_or(0, Vec::len),
    })
}

fn https_or_400(url: &str) -> Result<(), Bail> {
    match reqwest::Url::parse(url) {
        Err(_) => Err(inst(ie(
            StatusCode::BAD_REQUEST,
            "PLUGIN_SOURCE_INSECURE_URL",
            format!("\"{url}\" is not a valid URL"),
        ))),
        Ok(u) if u.scheme() != "https" => Err(inst(ie(
            StatusCode::BAD_REQUEST,
            "PLUGIN_SOURCE_INSECURE_URL",
            format!("source url \"{url}\" must be https"),
        ))),
        Ok(_) => Ok(()),
    }
}

async fn unique_or_409(st: &AppState, url: &str, except: Option<i32>) -> Result<(), Bail> {
    if let Some(e) = packages::source_by_url(&st.db, url).await.map_err(db)?
        && Some(e.id) != except
    {
        return Err(inst(ie(
            StatusCode::CONFLICT,
            "PLUGIN_SOURCE_DUPLICATE_URL",
            format!("a source for \"{url}\" already exists"),
        )));
    }
    Ok(())
}

fn public_key(v: &Value) -> Result<Option<Vec<u8>>, Bail> {
    let Some(s) = v.as_str() else { return Ok(None) };
    let key = base64_lenient(s);
    if key.len() != 32 {
        return Err(inst(ie(
            StatusCode::BAD_REQUEST,
            "PLUGIN_SOURCE_BAD_KEY",
            format!(
                "publicKey must be base64-encoded and decode to exactly 32 bytes, got {}",
                key.len()
            ),
        )));
    }
    Ok(Some(key))
}

/// `Buffer.from(s, 'base64')`: characters outside the alphabet are skipped, padding optional.
fn base64_lenient(s: &str) -> Vec<u8> {
    use base64::Engine;
    let clean: String = s
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .take_while(|c| *c != '=')
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/')
        .collect();
    let usable = clean.len() - clean.len() % 4
        + if clean.len() % 4 > 1 {
            clean.len() % 4
        } else {
            0
        };
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(&clean[..usable])
        .unwrap_or_default()
}

/// The DTO checks of `Create/UpdatePluginSourceDto` (`IsOptional` lets `null` through).
fn source_dto(v: &Value, create: bool) -> Result<(), Bail> {
    let mut errs: Vec<String> = vec![];
    if let Some(o) = v.as_object() {
        for k in o
            .keys()
            .filter(|k| !["url", "publicKey", "enabled"].contains(&k.as_str()))
        {
            errs.push(format!("property {k} should not exist"));
        }
    }
    let url = &v["url"];
    if create || !url.is_null() {
        if url.as_str().is_none_or(str::is_empty) {
            errs.push("url should not be empty".into());
        }
        if !url.is_string() {
            errs.push("url must be a string".into());
        }
    }
    if !v["publicKey"].is_null() && !v["publicKey"].is_string() {
        errs.push("publicKey must be a string".into());
    }
    if !v["enabled"].is_null() && !v["enabled"].is_boolean() {
        errs.push("enabled must be a boolean value".into());
    }
    if errs.is_empty() {
        Ok(())
    } else {
        Err(app(AppError::bad_request(errs)))
    }
}

#[utoipa::path(get, path = "/api/plugins/sources", responses((status = 200)))]
pub async fn sources_list(State(st): State<AppState>, a: Authed) -> Res {
    need(&a, Action::Read)?;
    let s = packages::sources(&st.db, false).await.map_err(db)?;
    Ok(Json(s.iter().map(source_summary).collect::<Vec<_>>()).into_response())
}

#[utoipa::path(post, path = "/api/plugins/sources", responses((status = 201)))]
pub async fn sources_create(
    State(st): State<AppState>,
    a: Authed,
    headers: HeaderMap,
    body: Bytes,
) -> Res {
    need(&a, Action::Manage)?;
    let v = json_body(&headers, &body).await?;
    source_dto(&v, true)?;
    let url = v["url"].as_str().unwrap_or_default();
    https_or_400(url)?;
    unique_or_409(&st, url, None).await?;
    let key = public_key(&v["publicKey"])?;
    let id: i32 = sqlx::query_scalar(r#"INSERT INTO plugin_sources (url, enabled, "publicKey") VALUES ($1, $2, $3) RETURNING id"#)
        .bind(url)
        .bind(v["enabled"].as_bool().unwrap_or(true))
        .bind(key)
        .fetch_one(&st.db)
        .await
        .map_err(db)?;
    let s = packages::source(&st.db, id)
        .await
        .map_err(db)?
        .expect("inserted");
    Ok((StatusCode::CREATED, Json(source_summary(&s))).into_response())
}

async fn source_or_404(st: &AppState, id: i32) -> Result<packages::Source, Bail> {
    packages::source(&st.db, id)
        .await
        .map_err(db)?
        .ok_or_else(|| {
            app(AppError::not_found(format!(
                "Plugin source #{id} not found"
            )))
        })
}

#[utoipa::path(put, path = "/api/plugins/sources/{id}", responses((status = 200)))]
pub async fn sources_update(
    State(st): State<AppState>,
    a: Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Res {
    need(&a, Action::Manage)?;
    let id = int_param(&id).map_err(app)?;
    let v = json_body(&headers, &body).await?;
    source_dto(&v, false)?;
    let mut s = source_or_404(&st, id).await?;
    let mut clear = false;
    if let Some(url) = v.get("url")
        && url.as_str() != Some(&s.url)
    {
        let url = url
            .as_str()
            .map_or_else(|| "null".to_owned(), str::to_owned);
        https_or_400(&url)?;
        unique_or_409(&st, &url, Some(id)).await?;
        s.url = url;
        clear = true;
    }
    if let Some(k) = v.get("publicKey") {
        let key = public_key(k)?;
        clear |= key != s.public_key;
        s.public_key = key;
    }
    if let Some(e) = v["enabled"].as_bool() {
        s.enabled = e;
    }
    sqlx::query(
        r#"UPDATE plugin_sources SET url = $2, "publicKey" = $3, enabled = $4, "updatedAt" = now(),
             "cachedCatalog" = CASE WHEN $5 THEN NULL ELSE "cachedCatalog" END,
             "lastRefreshedAt" = CASE WHEN $5 THEN NULL ELSE "lastRefreshedAt" END,
             "lastRefreshError" = CASE WHEN $5 THEN NULL ELSE "lastRefreshError" END
           WHERE id = $1"#,
    )
    .bind(id)
    .bind(&s.url)
    .bind(&s.public_key)
    .bind(s.enabled)
    .bind(clear)
    .execute(&st.db)
    .await
    .map_err(db)?;
    let s = source_or_404(&st, id).await?;
    Ok(Json(source_summary(&s)).into_response())
}

#[utoipa::path(delete, path = "/api/plugins/sources/{id}", responses((status = 204)))]
pub async fn sources_delete(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    let id = int_param(&id).map_err(app)?;
    source_or_404(&st, id).await?;
    sqlx::query("DELETE FROM plugin_sources WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await
        .map_err(db)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[utoipa::path(get, path = "/api/plugins/sources/{id}/catalog", responses((status = 200)))]
pub async fn sources_catalog(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Read)?;
    let id = int_param(&id).map_err(app)?;
    let s = source_or_404(&st, id).await?;
    Ok(Json(json!({
        "cachedCatalog": s.cached_catalog,
        "lastRefreshedAt": s.last_refreshed_at.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        "lastRefreshError": s.last_refresh_error,
    }))
    .into_response())
}

#[utoipa::path(post, path = "/api/plugins/sources/{id}/refresh", responses((status = 201)))]
pub async fn sources_refresh(State(st): State<AppState>, a: Authed, Path(id): Path<String>) -> Res {
    need(&a, Action::Manage)?;
    let id = int_param(&id).map_err(app)?;
    let s = source_or_404(&st, id).await?;
    let r = st.plugins.refresh_source(&s).await.map_err(db)?;
    Ok((StatusCode::CREATED, Json(r)).into_response())
}

#[utoipa::path(post, path = "/api/plugins/sources/{id}/inspect", responses((status = 201)))]
pub async fn sources_inspect(
    State(st): State<AppState>,
    a: Authed,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Res {
    need(&a, Action::Manage)?;
    let id = int_param(&id).map_err(app)?;
    let v = json_body(&headers, &body).await?;
    let mut errs: Vec<String> = vec![];
    if let Some(o) = v.as_object() {
        for k in o.keys().filter(|k| *k != "pluginId" && *k != "version") {
            errs.push(format!("property {k} should not exist"));
        }
    }
    for k in ["pluginId", "version"] {
        if v[k].as_str().is_none_or(str::is_empty) {
            errs.push(format!("{k} should not be empty"));
        }
        if !v[k].is_string() {
            errs.push(format!("{k} must be a string"));
        }
    }
    if !errs.is_empty() {
        return Err(app(AppError::bad_request(errs)));
    }
    let s = source_or_404(&st, id).await?;
    let r = st
        .plugins
        .inspect_from_catalog(
            &s,
            v["pluginId"].as_str().unwrap_or_default(),
            v["version"].as_str().unwrap_or_default(),
        )
        .await
        .map_err(inst)?;
    Ok((StatusCode::CREATED, Json(r)).into_response())
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

/// `DELETE /api/plugins/{ui,metrics,sources}`: Express routed these to `:pluginId` (C104 ids).
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
    Ok(Json(st.plugins.export(&id).await.map_err(inst)?).into_response())
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

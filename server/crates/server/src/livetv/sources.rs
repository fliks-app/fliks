//! Source routes (`livetv-sources.md` Routes and rules 1-14): CRUD, the test probe, the playlist upload
//! and the manual sync.
use super::{
    dto::{Body, Opt},
    lineup::{self, Conn, Fetched},
    model::{SOURCE_COLS, Source},
    net::Validators,
    playlist_file::{self, Upload},
    sync::{self, SyncError},
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, int_param},
    },
    state::AppState,
};
use axum::{
    Json,
    extract::{DefaultBodyLimit, Multipart, State, multipart::MultipartRejection},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::SecondsFormat;
use fliks_domain::{
    acl::{Action, Subject},
    livetv::{
        sync::{GroupPattern, PatternField, classify_entries},
        xtream::{self, Credentials},
    },
};
use serde_json::{Value, json};
use sqlx::PgPool;

/// A real subscription playlist runs to tens of megabytes of text.
pub const MAX_PLAYLIST_BYTES: u64 = 128 * 1024 * 1024;
const I32: std::ops::RangeInclusive<i64> = i32::MIN as i64..=i32::MAX as i64;

pub fn upload_limit() -> DefaultBodyLimit {
    DefaultBodyLimit::max(MAX_PLAYLIST_BYTES as usize + 64 * 1024)
}

fn admin(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::Settings)
}

fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Live TV source #{id} not found"))
}

/// `@IsPlaylistLocation()`: a managed upload passes, anything else must be an http(s) URL (C125).
fn location(s: &str) -> bool {
    playlist_file::is_managed_upload(s) || lineup::is_fetchable_url(s)
}

/// `<field> is not a valid regular expression: <message>`.
fn compile(pattern: &Option<String>, field: &str) -> Result<Option<GroupPattern>, String> {
    match pattern.as_deref().filter(|p| !p.is_empty()) {
        None => Ok(None),
        Some(p) => GroupPattern::compile(p)
            .map(Some)
            .map_err(|m| format!("{field} is not a valid regular expression: {m}")),
    }
}

#[utoipa::path(get, path = "/api/livetv/admin/sources", responses((status = 200)))]
pub async fn list(State(st): State<AppState>, a: Authed) -> Result<Json<Vec<Source>>, AppError> {
    admin(&a)?;
    Ok(Json(
        sqlx::query_as(&format!(
            "SELECT {SOURCE_COLS} FROM livetv_sources ORDER BY priority, name, id"
        ))
        .fetch_all(&st.db)
        .await?,
    ))
}

const FIELDS: [&str; 12] = [
    "name",
    "kind",
    "url",
    "username",
    "password",
    "userAgent",
    "referer",
    "maxStreams",
    "refreshIntervalHours",
    "enabled",
    "priority",
    "includeGroupsPattern",
];

/// The checks shared by create and update; `optional` is the update's `IsOptional` on `name`, `kind` and `url`.
struct Fields {
    name: Opt<String>,
    kind: Opt<String>,
    url: Opt<String>,
    username: Opt<String>,
    password: Opt<String>,
    user_agent: Opt<String>,
    referer: Opt<String>,
    max_streams: Opt<i64>,
    refresh: Opt<i64>,
    enabled: Opt<bool>,
    priority: Opt<i64>,
    include: Opt<String>,
    exclude: Opt<String>,
}

fn read_fields(body: &Value, update: bool) -> Result<Fields, AppError> {
    let mut known = FIELDS.to_vec();
    known.push("excludeGroupsPattern");
    let mut b = Body::new(body, &known);
    let required = |o: Option<String>| o.map_or(Opt::Absent, Opt::Val);
    let (name, kind, url) = if update {
        (
            b.opt_string("name"),
            b.opt_one_of("kind", &["m3u", "xtream"]),
            b.opt_url("url", location),
        )
    } else {
        (
            required(b.string("name")),
            required(b.one_of("kind", &["m3u", "xtream"])),
            required(b.url("url", location)),
        )
    };
    let f = Fields {
        name,
        kind,
        url,
        username: b.opt_string("username"),
        password: b.opt_string("password"),
        user_agent: b.opt_string("userAgent"),
        referer: b.opt_string("referer"),
        max_streams: b.opt_int("maxStreams", Some(0)),
        refresh: b.opt_int("refreshIntervalHours", Some(1)),
        enabled: b.opt_bool("enabled"),
        priority: b.opt_int("priority", None),
        include: b.opt_string("includeGroupsPattern"),
        exclude: b.opt_string("excludeGroupsPattern"),
    };
    // C1: a null on a NOT NULL column, and an integer the column cannot hold.
    for (key, null) in [
        ("name", f.name == Opt::Null),
        ("kind", f.kind == Opt::Null),
        ("url", f.url == Opt::Null),
        ("enabled", f.enabled == Opt::Null),
    ] {
        if null {
            b.reject(format!("{key} must not be null"));
        }
    }
    for (key, v) in [
        ("maxStreams", &f.max_streams),
        ("refreshIntervalHours", &f.refresh),
        ("priority", &f.priority),
    ] {
        match v {
            Opt::Null => b.reject(format!("{key} must not be null")),
            Opt::Val(n) if !I32.contains(n) => b.reject(format!("{key} must be a 32-bit integer")),
            _ => {}
        }
    }
    b.finish()?;
    Ok(f)
}

fn text(o: &Opt<String>) -> Option<String> {
    o.clone().val()
}

#[utoipa::path(post, path = "/api/livetv/admin/sources", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<(StatusCode, Json<Source>), AppError> {
    admin(&a)?;
    let f = read_fields(&body, false)?;
    compile(&text(&f.include), "includeGroupsPattern").map_err(AppError::bad_request)?;
    compile(&text(&f.exclude), "excludeGroupsPattern").map_err(AppError::bad_request)?;
    let row: Source = sqlx::query_as(&format!(
        r#"INSERT INTO livetv_sources (name, kind, url, username, password, "userAgent", referer, "maxStreams", "maxStreamsIsManual",
             "refreshIntervalHours", enabled, priority, "includeGroupsPattern", "excludeGroupsPattern")
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 0), $8 IS NOT NULL, COALESCE($9, 12), COALESCE($10, true),
                   COALESCE($11, 0), $12, $13)
           RETURNING {SOURCE_COLS}"#
    ))
    .bind(text(&f.name))
    .bind(text(&f.kind))
    .bind(text(&f.url))
    .bind(text(&f.username))
    .bind(text(&f.password))
    .bind(text(&f.user_agent))
    .bind(text(&f.referer))
    .bind(f.max_streams.clone().val().map(|n| n as i32))
    .bind(f.refresh.val().map(|n| n as i32))
    .bind(f.enabled.val())
    .bind(f.priority.val().map(|n| n as i32))
    .bind(text(&f.include))
    .bind(text(&f.exclude))
    .fetch_one(&st.db)
    .await?;
    Ok((StatusCode::CREATED, Json(row)))
}

/// Empty and absent are the same text for the change check (the web form resends every field).
fn same(new: &Opt<String>, stored: &Option<String>) -> bool {
    let norm = |s: &Option<String>| s.clone().filter(|v| !v.is_empty());
    match new {
        Opt::Absent => true,
        Opt::Null => norm(stored).is_none(),
        Opt::Val(v) => norm(&Some(v.clone())) == norm(stored),
    }
}

#[utoipa::path(patch, path = "/api/livetv/admin/sources/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Source>, AppError> {
    admin(&a)?;
    let id = int_param(&id.0)?;
    let f = read_fields(&body, true)?;
    let stored = sync::find_source(&st.db, id)
        .await?
        .ok_or_else(|| not_found(id))?;
    let merged = |new: &Opt<String>, old: &Option<String>| new.clone().val().or(old.clone());
    compile(
        &merged(&f.include, &stored.include_groups_pattern),
        "includeGroupsPattern",
    )
    .map_err(AppError::bad_request)?;
    compile(
        &merged(&f.exclude, &stored.exclude_groups_pattern),
        "excludeGroupsPattern",
    )
    .map_err(AppError::bad_request)?;
    // C122: a value that really changes invalidates what the last sync learned.
    let changed = !same(&f.url, &Some(stored.url.clone()))
        || !same(&f.kind, &Some(stored.kind.clone()))
        || !same(&f.username, &stored.username)
        || !same(&f.password, &stored.password)
        || !same(&f.user_agent, &stored.user_agent)
        || !same(&f.referer, &stored.referer)
        || !same(&f.include, &stored.include_groups_pattern)
        || !same(&f.exclude, &stored.exclude_groups_pattern);
    // F5/F71: blank or absent keeps the password, null clears.
    let password_set =
        matches!(f.password, Opt::Null) || matches!(&f.password, Opt::Val(v) if !v.is_empty());
    let row: Source = sqlx::query_as(&format!(
        r#"UPDATE livetv_sources SET name = COALESCE($2, name), kind = COALESCE($3, kind), url = COALESCE($4, url),
             username = CASE WHEN $5 THEN $6 ELSE username END, password = CASE WHEN $7 THEN $8 ELSE password END,
             "userAgent" = CASE WHEN $9 THEN $10 ELSE "userAgent" END, referer = CASE WHEN $11 THEN $12 ELSE referer END,
             "maxStreams" = COALESCE($13, "maxStreams"), "maxStreamsIsManual" = "maxStreamsIsManual" OR $13 IS NOT NULL,
             "refreshIntervalHours" = COALESCE($14, "refreshIntervalHours"), enabled = COALESCE($15, enabled),
             priority = COALESCE($16, priority),
             "includeGroupsPattern" = CASE WHEN $17 THEN $18 ELSE "includeGroupsPattern" END,
             "excludeGroupsPattern" = CASE WHEN $19 THEN $20 ELSE "excludeGroupsPattern" END,
             "playlistEtag" = CASE WHEN $21 THEN NULL ELSE "playlistEtag" END,
             "playlistLastModified" = CASE WHEN $21 THEN NULL ELSE "playlistLastModified" END,
             "channelCount" = CASE WHEN $21 THEN 0 ELSE "channelCount" END
           WHERE id = $1 RETURNING {SOURCE_COLS}"#
    ))
    .bind(id)
    .bind(text(&f.name))
    .bind(text(&f.kind))
    .bind(text(&f.url))
    .bind(f.username.present())
    .bind(text(&f.username))
    .bind(password_set)
    .bind(text(&f.password))
    .bind(f.user_agent.present())
    .bind(text(&f.user_agent))
    .bind(f.referer.present())
    .bind(text(&f.referer))
    .bind(f.max_streams.val().map(|n| n as i32))
    .bind(f.refresh.val().map(|n| n as i32))
    .bind(f.enabled.val())
    .bind(f.priority.val().map(|n| n as i32))
    .bind(f.include.present())
    .bind(text(&f.include))
    .bind(f.exclude.present())
    .bind(text(&f.exclude))
    .bind(changed)
    .fetch_one(&st.db)
    .await?;
    Ok(Json(row))
}

#[utoipa::path(delete, path = "/api/livetv/admin/sources/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Result<StatusCode, AppError> {
    admin(&a)?;
    let id = int_param(&id.0)?;
    let source = sync::find_source(&st.db, id)
        .await?
        .ok_or_else(|| not_found(id))?;
    let mut tx = st.db.begin().await?;
    let candidates: Vec<i32> = sqlx::query_scalar(r#"SELECT DISTINCT "channelId" FROM livetv_channel_streams WHERE "sourceId" = $1 AND "channelId" IS NOT NULL"#)
        .bind(id)
        .fetch_all(&mut *tx)
        .await?;
    // C1: a source deleted by a concurrent request.
    let gone = sqlx::query("DELETE FROM livetv_sources WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if gone.rows_affected() == 0 {
        return Err(not_found(id));
    }
    sync::delete_orphans(&mut tx, &candidates).await?;
    tx.commit().await?;
    playlist_file::remove(&source.url).await;
    Ok(StatusCode::OK)
}

// ---- test -----------------------------------------------------------------------------------

fn failure(kind: &str, suggestion: Option<&Credentials>, error: String) -> Value {
    let mut v = json!({
        "ok": false, "kind": kind, "channelCount": 0, "onDemandCount": 0, "groups": [],
        "guideUrl": null, "guideUrls": [], "maxConnections": null, "expiresAt": null, "accountStatus": null,
        "error": error,
    });
    if let Some(s) = suggestion {
        v["suggestion"] = suggestion_json(s);
    }
    v
}

fn suggestion_json(c: &Credentials) -> Value {
    json!({"suggestedKind": "xtream", "baseUrl": c.base_url, "username": c.username, "password": c.password})
}

/// The stored password stands in for the blank of the edit form while `id` still names this kind and url (rule 8).
pub(super) async fn test_password(
    db: &PgPool,
    id: Option<i64>,
    kind: &str,
    url: &str,
    given: &Option<String>,
) -> sqlx::Result<Option<String>> {
    if given.as_deref().is_some_and(|p| !p.is_empty()) {
        return Ok(given.clone());
    }
    let Some(id) = id.and_then(|i| i32::try_from(i).ok()) else {
        return Ok(given.clone());
    };
    let row: Option<(String, String, Option<String>)> =
        sqlx::query_as("SELECT kind, url, password FROM livetv_sources WHERE id = $1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    Ok(match row {
        Some((k, u, p)) if k == kind && u == url => p,
        _ => given.clone(),
    })
}

#[utoipa::path(post, path = "/api/livetv/admin/sources/test", responses((status = 201)))]
pub async fn test(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    admin(&a)?;
    let mut b = Body::new(
        &body,
        &[
            "id",
            "kind",
            "url",
            "username",
            "password",
            "userAgent",
            "referer",
            "includeGroupsPattern",
            "excludeGroupsPattern",
        ],
    );
    let id = b.opt_int("id", Some(1));
    let kind = b.one_of("kind", &["m3u", "xtream"]);
    let url = b.url("url", location);
    let username = b.opt_string("username");
    let password = b.opt_string("password");
    let user_agent = b.opt_string("userAgent");
    let referer = b.opt_string("referer");
    let include = b.opt_string("includeGroupsPattern");
    let exclude = b.opt_string("excludeGroupsPattern");
    b.finish()?;
    let (Some(kind), Some(url)) = (kind, url) else {
        unreachable!("validated")
    };
    // The panel link a pasted "m3u" url may really be, kept even when the probe fails.
    let mut suggestion = (kind == "m3u")
        .then(|| xtream::detect_from_url(&url))
        .flatten();
    let outcome = probe(
        &st,
        &kind,
        &url,
        (
            id.val(),
            text(&username),
            password.val(),
            text(&user_agent),
            text(&referer),
        ),
        (text(&include), text(&exclude)),
        &mut suggestion,
        true,
    )
    .await;
    Ok((
        StatusCode::CREATED,
        Json(outcome.unwrap_or_else(|e| failure(&kind, suggestion.as_ref(), e))),
    ))
}

pub(super) type Who = (
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

pub(super) async fn probe(
    st: &AppState,
    kind: &str,
    url: &str,
    (id, username, password, user_agent, referer): Who,
    (include, exclude): (Option<String>, Option<String>),
    suggestion: &mut Option<Credentials>,
    vetted: bool,
) -> Result<Value, String> {
    let include = compile(&include, "includeGroupsPattern")?;
    let exclude = compile(&exclude, "excludeGroupsPattern")?;
    let password = test_password(&st.db, id, kind, url, &password)
        .await
        .map_err(|e| e.to_string())?;
    let conn = Conn {
        kind: kind.to_owned(),
        url: url.to_owned(),
        username,
        password,
        user_agent,
        referer,
    };
    let Fetched::Lineup(lineup) = lineup::fetch(&conn, &Validators::default(), vetted).await?
    else {
        return Err("unexpected not-modified response".into());
    };
    let c = classify_entries(lineup.entries, include.as_ref(), exclude.as_ref()).map_err(
        |(field, m)| {
            let name = if field == PatternField::Include {
                "includeGroupsPattern"
            } else {
                "excludeGroupsPattern"
            };
            format!("{name} could not be evaluated: {m}")
        },
    )?;
    // An uploaded file never refreshes itself: its entries may carry the panel credentials that do.
    if suggestion.is_none() && kind == "m3u" && !playlist_file::is_http_source(url) {
        *suggestion = c
            .live
            .first()
            .and_then(|e| xtream::detect_from_stream_url(&e.url));
    }
    let mut v = json!({
        "ok": true,
        "kind": kind,
        "channelCount": c.live.len(),
        "onDemandCount": c.on_demand_count,
        "groups": c.groups,
        "playlistUrlFromFile": suggestion.as_ref().map(xtream::playlist_url),
        "guideUrl": lineup.guide_urls.first(),
        "guideUrls": lineup.guide_urls,
        "maxConnections": lineup.max_connections,
        "expiresAt": lineup.expires_at.map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true)),
        "accountStatus": lineup.account_status,
    });
    if let Some(s) = suggestion.as_ref() {
        v["suggestion"] = suggestion_json(s);
    }
    Ok(v)
}

// ---- upload ---------------------------------------------------------------------------------

fn upload_error(e: impl std::fmt::Display) -> AppError {
    tracing::warn!(error = %e, "playlist upload failed");
    AppError::bad_request("No playlist uploaded")
}

#[utoipa::path(post, path = "/api/livetv/admin/sources/playlist", responses((status = 201)))]
pub async fn upload(
    State(_st): State<AppState>,
    a: Authed,
    multipart: Result<Multipart, MultipartRejection>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    admin(&a)?;
    let mut multipart = multipart.map_err(upload_error)?;
    let mut stored: Option<(Upload, String)> = None;
    while let Some(mut field) = multipart.next_field().await.map_err(upload_error)? {
        let name = field.name().unwrap_or_default().to_owned();
        if name != "file" || field.file_name().is_none() || stored.is_some() {
            return Err(AppError::bad_request(format!("Unexpected field - {name}")));
        }
        let original = field.file_name().unwrap_or("playlist").to_owned();
        let mut up = Upload::create(&original)
            .await
            .map_err(|e| AppError::internal(e.to_string()))?;
        while let Some(chunk) = field.chunk().await.map_err(upload_error)? {
            if up.written + chunk.len() as u64 > MAX_PLAYLIST_BYTES {
                return Err(AppError::payload_too_large("File too large"));
            }
            up.write(&chunk)
                .await
                .map_err(|e| AppError::internal(e.to_string()))?;
        }
        stored = Some((up, original));
    }
    let Some((up, _)) = stored.filter(|(u, _)| u.written > 0) else {
        return Err(AppError::bad_request("No playlist uploaded"));
    };
    if !playlist_file::looks_like_m3u(&up.head) {
        return Err(AppError::bad_request(
            "That file is not an extended M3U playlist",
        ));
    }
    let path = up
        .finish()
        .await
        .map_err(|e| AppError::internal(e.to_string()))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"location": path.to_string_lossy()})),
    ))
}

#[utoipa::path(post, path = "/api/livetv/admin/sources/{id}/sync", responses((status = 201), (status = 202), (status = 409)))]
pub async fn sync_route(
    State(st): State<AppState>,
    a: Authed,
    headers: HeaderMap,
    id: PathParams<String>,
) -> Result<Response, AppError> {
    admin(&a)?;
    let id = int_param(&id.0)?;
    let done = if sync::wants_async(&headers) {
        sync::start(&st, id).await.map(sync::accepted)
    } else {
        sync::sync(&st, id)
            .await
            .map(|r| (StatusCode::CREATED, Json(r)).into_response())
    };
    done.map_err(|e| match e {
        SyncError::Running => AppError::conflict("errors.already_running"),
        SyncError::NotFound(id) => not_found(id),
        SyncError::Db(e) => e.into(),
    })
}

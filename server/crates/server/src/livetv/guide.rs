//! The guide (`livetv-guide.md`): guide source CRUD, the streamed XMLTV sync, the match report and the
//! user reads (`on-now`, `guide`, `programs/:id`, `search`).
use super::{
    channels::{Visible, denied_for, like_pattern, text_filter},
    dto::{Body, Opt, Query as Q, query_flag, query_int},
    feed::{self, Item},
    lineup,
    model::{GUIDE_SOURCE_COLS, GuideSource, PROGRAM_COLS, Program, SOURCE_COLS, Source},
    net::{self, Identity, Opts, Validators},
    sync::{Flight, SyncError, accepted, detach, find_source, outcome, setting_int, wants_async},
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, ValidJson, int_param},
    },
    jobs::Command,
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Duration, Utc};
use fliks_domain::{
    acl::{Action, Subject},
    livetv::{
        guide::{self as matching, Candidate, Matchable, pick_highest_priority},
        xmltv::Options as XmltvOptions,
    },
};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

/// A programme without a `stop` is assumed to fill a half-hour slot.
const DEFAULT_PROGRAMME_MINUTES: i64 = 30;
const PAGE_SIZE: i64 = 50;
const CHUNK: usize = 1000;
const I32: std::ops::RangeInclusive<i64> = i32::MIN as i64..=i32::MAX as i64;

fn admin(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Manage, Subject::Settings)
}

fn read(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Read, Subject::LiveTvChannel)
}

fn not_found(id: i32) -> AppError {
    AppError::not_found(format!("Guide source #{id} not found"))
}

async fn find(db: &PgPool, id: i32) -> sqlx::Result<Option<GuideSource>> {
    sqlx::query_as(&format!(
        "SELECT {GUIDE_SOURCE_COLS} FROM livetv_guide_sources WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(db)
    .await
}

#[utoipa::path(get, path = "/api/livetv/admin/guide-sources", responses((status = 200)))]
pub async fn list(
    State(st): State<AppState>,
    a: Authed,
) -> Result<Json<Vec<GuideSource>>, AppError> {
    admin(&a)?;
    Ok(Json(
        sqlx::query_as(&format!(
            "SELECT {GUIDE_SOURCE_COLS} FROM livetv_guide_sources ORDER BY name, id"
        ))
        .fetch_all(&st.db)
        .await?,
    ))
}

fn http_url(s: &str) -> bool {
    lineup::is_fetchable_url(s)
}

/// C131: what the merged row of a create or an update must satisfy.
fn row_errors(
    url: &Option<String>,
    interval: i64,
    offset: i64,
    language: &Option<String>,
    priority: i64,
) -> Vec<String> {
    let mut out = vec![];
    if url
        .as_deref()
        .is_some_and(|u| !u.is_empty() && !http_url(u))
    {
        out.push("url must be a URL address".to_owned());
    }
    if interval < 1 {
        out.push("refreshIntervalHours must not be less than 1".into());
    }
    if !(-1440..=1440).contains(&offset) {
        out.push("timezoneOffsetMinutes must be between -1440 and 1440".into());
    }
    if language.as_deref().is_some_and(|l| l.chars().count() > 16) {
        out.push("language must be shorter than or equal to 16 characters".into());
    }
    for (key, n) in [("refreshIntervalHours", interval), ("priority", priority)] {
        if !I32.contains(&n) {
            out.push(format!("{key} must be a 32-bit integer"));
        }
    }
    out
}

/// C165: what `kind` needs, reported only for the fields the payload sets (a stored row is never re-judged).
fn link_errors(
    kind: Option<&str>,
    url: Option<&str>,
    source_id: Option<i64>,
    sets: [bool; 3],
) -> Vec<String> {
    let [kind_set, url_set, source_set] = sets;
    let mut out = vec![];
    if kind == Some("xmltv") && (kind_set || url_set) && url.is_none_or(|u| u.trim().is_empty()) {
        out.push("url must be set when kind is xmltv".to_owned());
    }
    if kind == Some("source") && (kind_set || source_set) && source_id.is_none() {
        out.push("sourceId must be set when kind is source".to_owned());
    }
    out
}

async fn source_exists(db: &PgPool, id: i64) -> sqlx::Result<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM livetv_sources WHERE id = $1)")
        .bind(i32::try_from(id).unwrap_or(-1))
        .fetch_one(db)
        .await
}

#[utoipa::path(post, path = "/api/livetv/admin/guide-sources", responses((status = 201)))]
pub async fn create(
    State(st): State<AppState>,
    a: Authed,
    ValidJson(body): ValidJson<Value>,
) -> Result<(StatusCode, Json<Value>), AppError> {
    admin(&a)?;
    let mut b = Body::new(
        &body,
        &[
            "name",
            "kind",
            "url",
            "sourceId",
            "refreshIntervalHours",
            "timezoneOffsetMinutes",
            "language",
            "priority",
            "enabled",
        ],
    );
    let name = b.string("name");
    let kind = b.one_of("kind", &["xmltv", "source"]);
    let url = b.opt_url("url", http_url);
    let source_id = b.opt_int("sourceId", None);
    let interval = b.opt_int("refreshIntervalHours", None);
    let offset = b.opt_int("timezoneOffsetMinutes", None);
    let language = b.opt_string("language");
    let priority = b.opt_int("priority", None);
    let enabled = b.opt_bool("enabled");
    let merged = row_errors(
        &url.clone().val(),
        interval.clone().val().unwrap_or(12),
        offset.clone().val().unwrap_or(0),
        &language.clone().val(),
        priority.clone().val().unwrap_or(0),
    );
    b.errors.extend(merged);
    b.errors.extend(link_errors(
        kind.as_deref(),
        url.clone().val().as_deref(),
        source_id.clone().val(),
        [true; 3],
    ));
    if let Some(id) = source_id.clone().val()
        && !source_exists(&st.db, id).await?
    {
        b.reject("sourceId must belong to an existing live TV source");
    }
    reject_nulls(
        &mut b,
        &[
            ("refreshIntervalHours", &interval),
            ("timezoneOffsetMinutes", &offset),
            ("priority", &priority),
        ],
    );
    if enabled == Opt::Null {
        b.reject("enabled must be a boolean value");
    }
    b.finish()?;
    let row: GuideSource = sqlx::query_as(&format!(
        r#"INSERT INTO livetv_guide_sources (name, kind, url, "sourceId", "refreshIntervalHours", "timezoneOffsetMinutes", language, priority, enabled)
           VALUES ($1, $2, $3, $4, COALESCE($5, 12), COALESCE($6, 0), $7, COALESCE($8, 0), COALESCE($9, true))
           RETURNING {GUIDE_SOURCE_COLS}"#
    ))
    .bind(name)
    .bind(kind)
    .bind(url.val())
    .bind(source_id.clone().val().map(|n| n as i32))
    .bind(interval.val().map(|n| n as i32))
    .bind(offset.val().map(|n| n as i32))
    .bind(language.val())
    .bind(priority.val().map(|n| n as i32))
    .bind(enabled.val())
    .fetch_one(&st.db)
    .await?;
    let mut v = serde_json::to_value(&row).expect("guide source");
    v["source"] = source_id.val().map_or(Value::Null, |id| json!({"id": id}));
    Ok((StatusCode::CREATED, Json(v)))
}

fn reject_nulls(b: &mut Body, fields: &[(&str, &Opt<i64>)]) {
    for (key, v) in fields {
        if **v == Opt::Null {
            b.reject(format!("{key} must be an integer number"));
        }
    }
}

#[utoipa::path(patch, path = "/api/livetv/admin/guide-sources/{id}", responses((status = 200)))]
pub async fn update(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Json<Value>, AppError> {
    admin(&a)?;
    let id = int_param(&id.0)?;
    let mut b = Body::new(
        &body,
        &[
            "name",
            "kind",
            "url",
            "sourceId",
            "refreshIntervalHours",
            "timezoneOffsetMinutes",
            "language",
            "priority",
            "enabled",
        ],
    );
    let name = b.opt_string("name");
    let kind = b.opt_one_of("kind", &["xmltv", "source"]);
    let url = b.opt_string("url");
    let source_id = b.opt_int("sourceId", None);
    let interval = b.opt_int("refreshIntervalHours", None);
    let offset = b.opt_int("timezoneOffsetMinutes", None);
    let language = b.opt_string("language");
    let priority = b.opt_int("priority", None);
    let enabled = b.opt_bool("enabled");
    // C1: a null on a NOT NULL column.
    for (key, null) in [
        ("name", name == Opt::Null),
        ("kind", kind == Opt::Null),
        ("enabled", enabled == Opt::Null),
    ] {
        if null {
            b.reject(format!("{key} must not be null"));
        }
    }
    reject_nulls(
        &mut b,
        &[
            ("refreshIntervalHours", &interval),
            ("timezoneOffsetMinutes", &offset),
            ("priority", &priority),
        ],
    );
    b.finish()?;
    let stored = find(&st.db, id).await?.ok_or_else(|| not_found(id))?;
    let mut errors = row_errors(
        &url.clone().val().or(stored.url.clone()),
        interval
            .clone()
            .val()
            .unwrap_or(i64::from(stored.refresh_interval_hours)),
        offset
            .clone()
            .val()
            .unwrap_or(i64::from(stored.timezone_offset_minutes)),
        &language.clone().val().or(stored.language.clone()),
        priority.clone().val().unwrap_or(i64::from(stored.priority)),
    );
    let kind_now = kind.clone().val().unwrap_or(stored.kind.clone());
    let url_now = if url.present() {
        url.clone().val()
    } else {
        stored.url.clone()
    };
    let source_now = if source_id.present() {
        source_id.clone().val()
    } else {
        stored.source_id.map(i64::from)
    };
    errors.extend(link_errors(
        Some(&kind_now),
        url_now.as_deref(),
        source_now,
        [kind.present(), url.present(), source_id.present()],
    ));
    if let Some(sid) = source_id.clone().val()
        && !source_exists(&st.db, sid).await?
    {
        errors.push("sourceId must belong to an existing live TV source".into());
    }
    if !errors.is_empty() {
        return Err(AppError::bad_request(errors));
    }
    // Loaded before the save: the answer's nested source is the parent as it was.
    let parent: Option<Source> = match stored.source_id {
        Some(pid) => {
            sqlx::query_as(&format!(
                "SELECT {SOURCE_COLS} FROM livetv_sources WHERE id = $1"
            ))
            .bind(pid)
            .fetch_optional(&st.db)
            .await?
        }
        None => None,
    };
    let saved: GuideSource = sqlx::query_as(&format!(
        r#"UPDATE livetv_guide_sources SET name = COALESCE($2, name), kind = COALESCE($3, kind),
             url = CASE WHEN $4 THEN $5 ELSE url END, "sourceId" = CASE WHEN $6 THEN $7 ELSE "sourceId" END,
             "refreshIntervalHours" = COALESCE($8, "refreshIntervalHours"),
             "timezoneOffsetMinutes" = COALESCE($9, "timezoneOffsetMinutes"),
             language = CASE WHEN $10 THEN $11 ELSE language END, priority = COALESCE($12, priority),
             enabled = COALESCE($13, enabled)
           WHERE id = $1 RETURNING {GUIDE_SOURCE_COLS}"#
    ))
    .bind(id)
    .bind(name.val())
    .bind(kind.val())
    .bind(url.present())
    .bind(url.val())
    .bind(source_id.present())
    .bind(source_id.clone().val().map(|n| n as i32))
    .bind(interval.val().map(|n| n as i32))
    .bind(offset.val().map(|n| n as i32))
    .bind(language.present())
    .bind(language.val())
    .bind(priority.val().map(|n| n as i32))
    .bind(enabled.val())
    .fetch_one(&st.db)
    .await?;
    let mut v = serde_json::to_value(&saved).expect("guide source");
    v["source"] = if source_id.present() {
        source_id.val().map_or(Value::Null, |n| json!({"id": n}))
    } else {
        parent.map_or(Value::Null, |p| serde_json::to_value(p).expect("source"))
    };
    Ok(Json(v))
}

#[utoipa::path(delete, path = "/api/livetv/admin/guide-sources/{id}", responses((status = 200)))]
pub async fn remove(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Result<StatusCode, AppError> {
    admin(&a)?;
    let id = int_param(&id.0)?;
    let done = sqlx::query("DELETE FROM livetv_guide_sources WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(not_found(id));
    }
    Ok(StatusCode::OK)
}

// ---- sync ---------------------------------------------------------------------------------

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GuideSyncResult {
    pub ok: bool,
    pub program_count: usize,
    pub channels_touched: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn sync(st: &AppState, id: i32) -> Result<GuideSyncResult, SyncError> {
    let Some(_flight) = Flight::claim(st, "LiveTvGuideSync", id) else {
        return Err(SyncError::Running);
    };
    run_claimed(st, id).await
}

/// The async twin of `sync` (C164): the queued row of a sync that runs on.
pub async fn start(st: &AppState, id: i32) -> Result<Command, SyncError> {
    let Some(flight) = Flight::claim(st, "LiveTvGuideSync", id) else {
        return Err(SyncError::Running);
    };
    find(&st.db, id).await?.ok_or(SyncError::NotFound(id))?;
    let work = move |st: AppState| async move {
        outcome(run_claimed(&st, id).await.map(|r| (r.ok, r.error)))
    };
    Ok(detach(
        st,
        flight,
        "LiveTvGuideSync",
        json!({"guideSourceId": id}),
        work,
    )
    .await?)
}

async fn run_claimed(st: &AppState, id: i32) -> Result<GuideSyncResult, SyncError> {
    let source = find(&st.db, id).await?.ok_or(SyncError::NotFound(id))?;
    match run(st, &source).await {
        Ok(r) => Ok(r),
        Err(message) => {
            sqlx::query(r#"UPDATE livetv_guide_sources SET "lastSyncAt" = now(), "lastSyncStatus" = 'error', "lastSyncError" = $2 WHERE id = $1"#)
                .bind(id)
                .bind(&message)
                .execute(&st.db)
                .await?;
            tracing::warn!("Guide sync #{id} failed: {message}");
            Ok(GuideSyncResult {
                ok: false,
                program_count: 0,
                channels_touched: 0,
                error: Some(message),
            })
        }
    }
}

#[utoipa::path(post, path = "/api/livetv/admin/guide-sources/{id}/sync", responses((status = 201), (status = 202), (status = 409)))]
pub async fn sync_route(
    State(st): State<AppState>,
    a: Authed,
    headers: HeaderMap,
    id: PathParams<String>,
) -> Result<Response, AppError> {
    admin(&a)?;
    let id = int_param(&id.0)?;
    let done = if wants_async(&headers) {
        start(&st, id).await.map(accepted)
    } else {
        sync(&st, id)
            .await
            .map(|r| (StatusCode::CREATED, Json(r)).into_response())
    };
    done.map_err(|e| match e {
        SyncError::Running => AppError::conflict("errors.already_running"),
        SyncError::NotFound(id) => not_found(id),
        SyncError::Db(e) => e.into(),
    })
}

/// The feed url of a guide source: its own, or its parent source's guide (rule 9).
async fn feed_url(db: &PgPool, g: &GuideSource) -> Result<(String, Option<Source>), String> {
    if g.kind == "xmltv" {
        let url = g
            .url
            .clone()
            .filter(|u| !u.is_empty())
            .ok_or("Guide source has no URL")?;
        return Ok((url, None));
    }
    let sid = g
        .source_id
        .ok_or("Guide source has no parent Live TV source")?;
    let parent = find_source(db, sid)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Live TV source #{sid} not found"))?;
    Ok((lineup::guide_url(&parent).await?, Some(parent)))
}

#[derive(sqlx::FromRow)]
struct ChannelMatchRow {
    id: i32,
    name: String,
    enabled: bool,
    #[sqlx(rename = "guideChannelId")]
    guide_channel_id: Option<String>,
    #[sqlx(rename = "guideMatchKind")]
    guide_match_kind: Option<String>,
    #[sqlx(rename = "guideShiftMinutes")]
    guide_shift_minutes: i32,
}

/// Persists the feed's channels, matches the lineup against them and answers which guide ids are wanted
/// (enabled channels only) with their shifts (rule 33).
async fn match_pass(
    db: &PgPool,
    guide_source_id: i32,
    feed: &[fliks_domain::livetv::xmltv::Channel],
) -> Result<HashMap<String, i32>, String> {
    let e = |e: sqlx::Error| e.to_string();
    let mut tx = db.begin().await.map_err(e)?;
    sqlx::query(r#"DELETE FROM livetv_guide_channels WHERE "guideSourceId" = $1"#)
        .bind(guide_source_id)
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    if !feed.is_empty() {
        sqlx::query(
            r#"INSERT INTO livetv_guide_channels ("guideSourceId", "channelId", "displayNames", "iconUrl")
               SELECT $1, t.id, t.names, t.icon FROM UNNEST($2::text[], $3::jsonb[], $4::text[]) AS t(id, names, icon)"#,
        )
        .bind(guide_source_id)
        .bind(feed.iter().map(|c| c.id.clone()).collect::<Vec<_>>())
        .bind(feed.iter().map(|c| json!(c.display_names)).collect::<Vec<_>>())
        .bind(feed.iter().map(|c| c.icon_url.clone()).collect::<Vec<_>>())
        .execute(&mut *tx)
        .await
        .map_err(e)?;
    }
    tx.commit().await.map_err(e)?;
    let channels: Vec<ChannelMatchRow> = sqlx::query_as(
        r#"SELECT id, name, enabled, "guideChannelId", "guideMatchKind", "guideShiftMinutes" FROM livetv_channels ORDER BY id"#,
    )
    .fetch_all(db)
    .await
    .map_err(e)?;
    let matchable: Vec<Matchable> = channels
        .iter()
        .map(|c| Matchable {
            id: c.id,
            name: c.name.clone(),
            guide_channel_id: c.guide_channel_id.clone(),
            guide_match_kind: c.guide_match_kind.clone(),
        })
        .collect();
    let candidates: Vec<Candidate> = feed
        .iter()
        .map(|c| Candidate {
            id: c.id.clone(),
            display_names: c.display_names.clone(),
        })
        .collect();
    let report = matching::match_guide_channels(&matchable, &candidates);
    let mut groups: Vec<((String, matching::Kind), Vec<i32>)> = vec![];
    for a in &report.assignments {
        let key = (a.guide_channel_id.clone(), a.kind);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, ids)) => ids.push(a.channel_id),
            None => groups.push((key, vec![a.channel_id])),
        }
    }
    for ((guide, kind), ids) in &groups {
        sqlx::query(r#"UPDATE livetv_channels SET "guideChannelId" = $1, "guideMatchKind" = $2 WHERE id = ANY($3)"#)
            .bind(guide)
            .bind(kind.as_str())
            .bind(ids)
            .execute(db)
            .await
            .map_err(e)?;
    }
    let assigned: HashMap<i32, &str> = report
        .assignments
        .iter()
        .map(|a| (a.channel_id, a.guide_channel_id.as_str()))
        .collect();
    let mut shift: HashMap<String, i32> = HashMap::new();
    for c in channels.iter().filter(|c| c.enabled) {
        let guide = assigned
            .get(&c.id)
            .map(|g| (*g).to_owned())
            .or(c.guide_channel_id.clone());
        if let Some(g) = guide.filter(|g| !g.is_empty()) {
            shift.entry(g).or_insert(c.guide_shift_minutes);
        }
    }
    Ok(shift)
}

type Row = Box<fliks_domain::livetv::xmltv::Programme>;
/// An accepted programme with its shifted start and end.
type Accepted = (Row, DateTime<Utc>, DateTime<Utc>);

/// Inserts one chunk of accepted programmes (`INSERT ... SELECT FROM UNNEST`).
async fn insert_chunk(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    guide_source_id: i32,
    rows: &[Accepted],
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO livetv_programs ("guideSourceId", "guideChannelId", "startsAt", "endsAt", title, subtitle, description,
             categories, "iconUrl", "seasonNumber", "episodeNumber", "seriesId", "isNew", "isLive", rating, year)
           SELECT $1, t.channel, t.starts, t.ends, t.title, t.subtitle, t.descr, t.categories, t.icon, t.season, t.episode,
                  t.series, t.is_new, t.is_live, t.rating, t.year
           FROM UNNEST($2::text[], $3::timestamptz[], $4::timestamptz[], $5::text[], $6::text[], $7::text[], $8::jsonb[],
                       $9::text[], $10::int[], $11::int[], $12::text[], $13::bool[], $14::bool[], $15::text[], $16::int[])
                AS t(channel, starts, ends, title, subtitle, descr, categories, icon, season, episode, series, is_new, is_live, rating, year)"#,
    )
    .bind(guide_source_id)
    .bind(rows.iter().map(|r| r.0.channel_id.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.1).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.2).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.title.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.subtitle.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.description.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| json!(r.0.categories)).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.icon_url.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.season_number).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.episode_number).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.series_id.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.is_new).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.is_live).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.rating.clone()).collect::<Vec<_>>())
    .bind(rows.iter().map(|r| r.0.year).collect::<Vec<_>>())
    .execute(&mut **tx)
    .await
    .map(drop)
}

async fn run(st: &AppState, g: &GuideSource) -> Result<GuideSyncResult, String> {
    let db = &st.db;
    let dberr = |e: sqlx::Error| e.to_string();
    let (url, parent) = feed_url(db, g).await?;
    let past = setting_int(db, "livetv_guide_days_past", 2)
        .await
        .map_err(dberr)?;
    let future = setting_int(db, "livetv_guide_days_future", 7)
        .await
        .map_err(dberr)?;
    let now = Utc::now();
    let (window_start, window_end) = (now - Duration::days(past), now + Duration::days(future));
    let identity = Identity {
        user_agent: parent.as_ref().and_then(|p| p.user_agent.as_deref()),
        referer: parent.as_ref().and_then(|p| p.referer.as_deref()),
    };
    let validators = Validators {
        etag: g.etag.as_deref(),
        last_modified: g.last_modified.as_deref(),
    };
    let reply = net::get(&url, &identity, &validators, Opts::GUIDE).await?;
    if reply.not_modified() {
        sqlx::query(r#"UPDATE livetv_guide_sources SET "lastSyncAt" = now(), "lastSyncStatus" = 'ok', "lastSyncError" = NULL WHERE id = $1"#)
            .bind(g.id)
            .execute(db)
            .await
            .map_err(dberr)?;
        tracing::info!("Guide sync \"{}\": not modified, nothing to do", g.name);
        return Ok(GuideSyncResult {
            ok: true,
            program_count: g.program_count as usize,
            channels_touched: 0,
            error: None,
        });
    }
    let (etag, last_modified) = reply.validators();
    let opts = XmltvOptions {
        offset_minutes: g.timezone_offset_minutes,
        language: g.language.clone().filter(|l| !l.is_empty()),
        ..XmltvOptions::default()
    };
    let idle = Opts::GUIDE.idle;
    let target = net::target_of(reply.response.url());
    let (mut items, reader) = feed::start(reply.response, opts, net::MAX_BODY, move |e| {
        net::describe(e, idle, &target)
    });
    let mut channels: Vec<fliks_domain::livetv::xmltv::Channel> = vec![];
    let mut shift: HashMap<String, i32> = HashMap::new();
    let mut touched: HashSet<String> = HashSet::new();
    let (mut accepted, mut chunk): (usize, Vec<Accepted>) = (0, vec![]);
    let mut tx: Option<(sqlx::Transaction<'_, sqlx::Postgres>, i32)> = None;
    while let Some(item) = items.recv().await {
        match item {
            Item::Channel(c) => {
                // C129: a repeated channel id keeps its first occurrence.
                if !channels.iter().any(|x| x.id == c.id) {
                    channels.push(c);
                }
            }
            Item::ChannelsDone {
                programmes_follow,
                wanted,
            } => {
                if channels.is_empty() && !programmes_follow {
                    return Err("empty guide feed".into());
                }
                shift = match_pass(db, g.id, &channels).await?;
                let _ = wanted.send(std::sync::Arc::new(shift.keys().cloned().collect()));
            }
            Item::Programme(p) => {
                let ends = p
                    .ends_at
                    .unwrap_or(p.starts_at + Duration::minutes(DEFAULT_PROGRAMME_MINUTES));
                if p.starts_at >= window_end || ends <= window_start {
                    continue;
                }
                let by =
                    Duration::minutes(i64::from(shift.get(&p.channel_id).copied().unwrap_or(0)));
                touched.insert(p.channel_id.clone());
                accepted += 1;
                let starts = p.starts_at + by;
                chunk.push((p, starts, ends + by));
                if chunk.len() >= CHUNK {
                    flush(db, &mut tx, g.id, &mut chunk).await?;
                }
            }
        }
    }
    reader
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    flush(db, &mut tx, g.id, &mut chunk).await?;
    if let Some((mut t, high_id)) = tx {
        let ids: Vec<String> = touched.iter().cloned().collect();
        sqlx::query(
            r#"DELETE FROM livetv_programs WHERE "guideSourceId" = $1 AND "guideChannelId" = ANY($2)
               AND "startsAt" < $3 AND "endsAt" > $4 AND id <= $5"#,
        )
        .bind(g.id)
        .bind(&ids)
        .bind(window_end)
        .bind(window_start)
        .bind(high_id)
        .execute(&mut *t)
        .await
        .map_err(dberr)?;
        t.commit().await.map_err(dberr)?;
    }
    sqlx::query(
        r#"UPDATE livetv_guide_sources SET "lastSyncAt" = now(), "lastSyncStatus" = 'ok', "lastSyncError" = NULL,
           "programCount" = $2, etag = $3, "lastModified" = $4 WHERE id = $1"#,
    )
    .bind(g.id)
    .bind(accepted as i32)
    .bind(etag)
    .bind(last_modified)
    .execute(db)
    .await
    .map_err(dberr)?;
    tracing::info!(
        "Guide sync \"{}\": {accepted} program(s) across {} channel(s)",
        g.name,
        touched.len()
    );
    Ok(GuideSyncResult {
        ok: true,
        program_count: accepted,
        channels_touched: touched.len(),
        error: None,
    })
}

/// Writes the chunk, opening the transaction (and noting the highest id of its tail delete) at the first one.
async fn flush<'a>(
    db: &'a PgPool,
    tx: &mut Option<(sqlx::Transaction<'a, sqlx::Postgres>, i32)>,
    guide_source_id: i32,
    chunk: &mut Vec<Accepted>,
) -> Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }
    let dberr = |e: sqlx::Error| e.to_string();
    if tx.is_none() {
        let mut t = db.begin().await.map_err(dberr)?;
        let high: i32 = sqlx::query_scalar("SELECT coalesce(max(id), 0) FROM livetv_programs")
            .fetch_one(&mut *t)
            .await
            .map_err(dberr)?;
        *tx = Some((t, high));
    }
    let (t, _) = tx.as_mut().expect("opened");
    insert_chunk(t, guide_source_id, chunk)
        .await
        .map_err(dberr)?;
    chunk.clear();
    Ok(())
}

// ---- match report ------------------------------------------------------------------------

#[utoipa::path(get, path = "/api/livetv/admin/guide/match-report", responses((status = 200)))]
pub async fn match_report(
    State(st): State<AppState>,
    a: Authed,
    Query(raw): Query<Vec<(String, String)>>,
) -> Result<Json<Value>, AppError> {
    admin(&a)?;
    let q = Q(&raw);
    let mut errors = q.known(&["guideSourceId"]);
    let source = query_int(
        &mut errors,
        "guideSourceId",
        q.get("guideSourceId"),
        Some(1),
        None,
    );
    if !errors.is_empty() {
        return Err(AppError::bad_request(errors));
    }
    let channels: Vec<(i32, String, Option<String>)> =
        sqlx::query_as(r#"SELECT id, name, "guideMatchKind" FROM livetv_channels ORDER BY id"#)
            .fetch_all(&st.db)
            .await?;
    let mut by_kind = json!({"id": 0, "name": 0, "fuzzy": 0, "manual": 0});
    let mut unmatched = vec![];
    for (id, name, kind) in &channels {
        match kind.as_deref().filter(|k| !k.is_empty()) {
            Some(k) => {
                if let Some(n) = by_kind.get_mut(k) {
                    *n = json!(n.as_i64().unwrap_or(0) + 1);
                }
            }
            None => unmatched.push(json!({"channelId": id, "name": name})),
        }
    }
    let rows: Vec<(String, Value, Option<i32>)> = sqlx::query_as(
        r#"SELECT "channelId", "displayNames", "guideSourceId" FROM livetv_guide_channels
           WHERE ($1::bigint IS NULL OR "guideSourceId" = $1) ORDER BY "channelId" COLLATE "C", id"#,
    )
    .bind(source)
    .fetch_all(&st.db)
    .await?;
    let candidates: Vec<Value> = rows
        .into_iter()
        .map(|(id, names, source)| {
            let first = names
                .get(0)
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_owned();
            json!({"id": id, "displayName": first, "guideSourceId": source})
        })
        .collect();
    Ok(Json(
        json!({"total": channels.len(), "byKind": by_kind, "unmatched": unmatched, "candidates": candidates}),
    ))
}

// ---- reads --------------------------------------------------------------------------------

/// Programmes of the guide ids in `[from, to)`, in start order; a channel id two guide sources define keeps the winner's rows.
async fn ranked(
    db: &PgPool,
    ids: &[String],
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> sqlx::Result<Vec<Program>> {
    let rows: Vec<Program> = sqlx::query_as(&format!(
        r#"SELECT {PROGRAM_COLS} FROM livetv_programs p WHERE p."guideChannelId" = ANY($1) AND p."startsAt" < $3 AND p."endsAt" > $2
           ORDER BY p."startsAt", p.id"#
    ))
    .bind(ids)
    .bind(from)
    .bind(to)
    .fetch_all(db)
    .await?;
    if rows.len() < 2 {
        return Ok(rows);
    }
    let prio: Vec<(i32, i32)> = sqlx::query_as("SELECT id, priority FROM livetv_guide_sources")
        .fetch_all(db)
        .await?;
    let prio: HashMap<i32, i32> = prio.into_iter().collect();
    let keep: HashSet<*const Program> = pick_highest_priority(
        &rows,
        |r| (r.guide_channel_id.as_str(), r.guide_source_id.unwrap_or(0)),
        &prio,
    )
    .into_iter()
    .map(|r| r as *const Program)
    .collect();
    Ok(rows
        .iter()
        .filter(|r| keep.contains(&(*r as *const Program)))
        .cloned()
        .collect())
}

fn guide_ids(items: &[super::model::ChannelItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|c| c.guide_channel_id.clone())
        .collect()
}

fn iso_param(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .map(|d| d.to_utc())
        .ok()
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|d| d.and_utc())
        })
}

#[utoipa::path(get, path = "/api/livetv/channels/on-now", responses((status = 200)))]
pub async fn on_now(
    State(st): State<AppState>,
    a: Authed,
    Query(raw): Query<Vec<(String, String)>>,
) -> Result<Json<Value>, AppError> {
    read(&a)?;
    let q = Q(&raw);
    let mut errors = q.known(&["group", "query", "page", "pageSize"]);
    let group = text_filter(&q, &mut errors, "group", Some(200));
    let query = text_filter(&q, &mut errors, "query", Some(200));
    let page = query_int(&mut errors, "page", q.get("page"), Some(1), None).unwrap_or(1);
    let size = query_int(
        &mut errors,
        "pageSize",
        q.get("pageSize"),
        Some(1),
        Some(PAGE_SIZE),
    );
    if !errors.is_empty() {
        return Err(AppError::bad_request(errors));
    }
    let size = size.unwrap_or(PAGE_SIZE).min(PAGE_SIZE);
    let denied = denied_for(&st, &a).await?;
    let v = Visible {
        group: group.as_deref(),
        query: query.as_deref(),
        ..Visible::new(a.user.id, &denied)
    };
    let (items, total) = v.list(&st.db, Some((page, size))).await?;
    let ids = guide_ids(&items);
    let now = Utc::now();
    let rows = if ids.is_empty() {
        vec![]
    } else {
        ranked(&st.db, &ids, now, now + Duration::hours(12)).await?
    };
    let entries: Vec<Value> = items
        .iter()
        .map(|c| {
            let mine: Vec<&Program> = c
                .guide_channel_id
                .as_deref()
                .map(|g| rows.iter().filter(|p| p.guide_channel_id == g).collect())
                .unwrap_or_default();
            let current = mine.iter().find(|p| p.starts_at <= now && now < p.ends_at);
            let next = mine.iter().find(|p| p.starts_at > now);
            json!({"channel": c, "now": current, "next": next})
        })
        .collect();
    Ok(Json(
        json!({"entries": entries, "page": page, "pageSize": size, "total": total}),
    ))
}

#[utoipa::path(get, path = "/api/livetv/guide", responses((status = 200)))]
pub async fn window(
    State(st): State<AppState>,
    a: Authed,
    Query(raw): Query<Vec<(String, String)>>,
) -> Result<Json<Value>, AppError> {
    read(&a)?;
    let q = Q(&raw);
    let mut errors = q.known(&["from", "to", "group", "favoritesOnly", "page", "pageSize"]);
    let date = |errors: &mut Vec<String>, key: &str| {
        let d = q.get(key).and_then(iso_param);
        if d.is_none() {
            errors.push(format!("{key} must be a valid ISO 8601 date string"));
        }
        d
    };
    let (from, to) = (date(&mut errors, "from"), date(&mut errors, "to"));
    let group = text_filter(&q, &mut errors, "group", None);
    let page = query_int(&mut errors, "page", q.get("page"), Some(1), None).unwrap_or(1);
    let size = query_int(&mut errors, "pageSize", q.get("pageSize"), Some(1), None)
        .unwrap_or(PAGE_SIZE)
        .min(PAGE_SIZE);
    if !errors.is_empty() {
        return Err(AppError::bad_request(errors));
    }
    let (Some(from), Some(to)) = (from, to) else {
        return Err(AppError::bad_request(Vec::<String>::new()));
    };
    let denied = denied_for(&st, &a).await?;
    let v = Visible {
        group: group.as_deref(),
        favorites_only: query_flag(q.get("favoritesOnly")),
        ..Visible::new(a.user.id, &denied)
    };
    let (items, total) = v.list(&st.db, Some((page, size))).await?;
    let ids = guide_ids(&items);
    let mut programs = serde_json::Map::new();
    if !ids.is_empty() {
        for row in ranked(&st.db, &ids, from, to).await? {
            programs
                .entry(row.guide_channel_id.clone())
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .expect("array")
                .push(serde_json::to_value(&row).expect("program"));
        }
    }
    Ok(Json(
        json!({"channels": items, "programs": programs, "page": page, "pageSize": size, "total": total}),
    ))
}

#[utoipa::path(get, path = "/api/livetv/programs/{id}", responses((status = 200), (status = 404)))]
pub async fn program(
    State(st): State<AppState>,
    a: Authed,
    id: PathParams<String>,
) -> Result<Json<Program>, AppError> {
    read(&a)?;
    let id = int_param(&id.0)?;
    let missing = || AppError::not_found(format!("Program #{id} not found"));
    let p: Program = sqlx::query_as(&format!(
        "SELECT {PROGRAM_COLS} FROM livetv_programs p WHERE p.id = $1"
    ))
    .bind(id)
    .fetch_optional(&st.db)
    .await?
    .ok_or_else(missing)?;
    let denied = denied_for(&st, &a).await?;
    let visible = Visible {
        guide_channel_id: Some(&p.guide_channel_id),
        ..Visible::new(a.user.id, &denied)
    }
    .count(&st.db)
    .await?
        > 0;
    if !visible {
        return Err(missing());
    }
    Ok(Json(p))
}

#[utoipa::path(get, path = "/api/livetv/search", responses((status = 200)))]
pub async fn search(
    State(st): State<AppState>,
    a: Authed,
    Query(raw): Query<Vec<(String, String)>>,
) -> Result<Json<Value>, AppError> {
    read(&a)?;
    let q = Q(&raw);
    let mut errors = q.known(&["q"]);
    let text = text_filter(&q, &mut errors, "q", Some(200));
    if !errors.is_empty() {
        return Err(AppError::bad_request(errors));
    }
    let text = text.unwrap_or_default();
    let denied = denied_for(&st, &a).await?;
    let v = Visible {
        query: Some(&text),
        ..Visible::new(a.user.id, &denied)
    };
    let (channels, _) = v.list(&st.db, Some((1, PAGE_SIZE))).await?;
    let past = setting_int(&st.db, "livetv_guide_days_past", 2).await?;
    let future = setting_int(&st.db, "livetv_guide_days_future", 7).await?;
    let now = Utc::now();
    let programs: Vec<Program> = sqlx::query_as(&format!(
        r#"SELECT {PROGRAM_COLS} FROM livetv_programs p
           WHERE p.title ILIKE $1 ESCAPE '\' AND p."startsAt" < $3 AND p."endsAt" > $2
             AND EXISTS (SELECT 1 FROM livetv_channels c
                         LEFT JOIN livetv_user_channel_prefs pref ON pref."channelId" = c.id AND pref."userId" = $4
                         WHERE c."guideChannelId" = p."guideChannelId" AND c.enabled AND (pref.hidden IS NULL OR pref.hidden = false)
                           AND (cardinality($5::text[]) = 0 OR c."groupName" IS NULL
                                OR lower(btrim(c."groupName")) <> ALL (SELECT lower(btrim(x)) FROM unnest($5::text[]) AS x)))
           ORDER BY p."startsAt", p.id LIMIT 50"#
    ))
    .bind(like_pattern(&text))
    .bind(now - Duration::days(past))
    .bind(now + Duration::days(future))
    .bind(a.user.id)
    .bind(&denied)
    .fetch_all(&st.db)
    .await?;
    Ok(Json(json!({"channels": channels, "programs": programs})))
}

/// `LiveTvGuidePrune`: both sides of the window are bounded; the count removed.
pub async fn prune(db: &PgPool) -> sqlx::Result<u64> {
    let past = setting_int(db, "livetv_guide_days_past", 2).await?;
    let future = setting_int(db, "livetv_guide_days_future", 7).await?;
    let now = Utc::now();
    let done = sqlx::query(r#"DELETE FROM livetv_programs WHERE "endsAt" < $1 OR "startsAt" > $2"#)
        .bind(now - Duration::days(past))
        .bind(now + Duration::days(future))
        .execute(db)
        .await?;
    Ok(done.rows_affected())
}

//! `/api/subtitles/{history,stats,health,missing,blacklist}` (`subtitles.md` routes 1-8, rules 20-29).
use super::{providers::Provider, routes_media::policy, service};
use crate::{
    http::{
        AppError,
        auth::Authed,
        json::iso_ms,
        validate::{PathParams, ValidJson, from_value},
    },
    libraries::accessible_library_ids,
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use fliks_domain::{
    acl::{Action, Subject},
    subtitle_flags::IMAGE_BASED_CODECS,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;
use std::collections::HashMap;

type Res<T> = Result<T, AppError>;

/// `Number(x) || default`; with a clamp the page floors at 1 and the limit is clamped, without one a
/// negative or fractional value is 400.
fn page_limit(
    q: &HashMap<String, String>,
    default_limit: f64,
    clamp: Option<(f64, f64)>,
) -> Res<(i64, i64)> {
    let num = |k: &str, d: f64| -> f64 {
        q.get(k)
            .map(|v| v.trim())
            .and_then(|v| {
                if v.is_empty() {
                    Some(0.0)
                } else {
                    v.parse::<f64>().ok()
                }
            })
            .filter(|n| n.is_finite() && *n != 0.0)
            .unwrap_or(d)
    };
    let (page, limit) = (num("page", 1.0), num("limit", default_limit));
    match clamp {
        Some((lo, hi)) => Ok((
            page.floor().max(1.0) as i64,
            limit.floor().clamp(lo, hi) as i64,
        )),
        None if page < 1.0 || limit < 1.0 || page.fract() != 0.0 || limit.fract() != 0.0 => Err(
            AppError::bad_request("page and limit must be positive integers"),
        ),
        None => Ok((page as i64, limit as i64)),
    }
}

/// Accessible-library filter: `None` means every media.
async fn visible_media(st: &AppState, a: &Authed) -> Res<Option<Vec<i32>>> {
    if a.user.is_admin || a.perms.can(Action::Manage, &Subject::All) {
        return Ok(None);
    }
    Ok(Some(accessible_library_ids(&st.db, a).await?))
}

#[derive(FromRow)]
struct ItemRow {
    id: i32,
    media_id: Option<i32>,
    media_title: Option<String>,
    media_type: Option<String>,
    episode_id: Option<i32>,
    season_number: Option<i32>,
    episode_number: Option<i32>,
    episode_title: Option<String>,
    language: String,
    provider_type: String,
    score: i32,
    status: String,
    forced: bool,
    hearing_impaired: bool,
    synced: bool,
    sync_failed: bool,
    error_message: Option<String>,
    created_at: DateTime<Utc>,
}

const ITEM_SELECT: &str = r#"SELECT sf.id, sf."mediaId" AS media_id, m.title AS media_title, m."type" AS media_type,
  COALESCE(sf."episodeId", fe.id) AS episode_id, COALESCE(es."number", fs."number") AS season_number,
  COALESCE(e."number", fe."number") AS episode_number, COALESCE(e.title, fe.title) AS episode_title,
  sf.language, sf."providerType"::text AS provider_type, sf.score, sf.status::text AS status, sf.forced,
  sf."hearingImpaired" AS hearing_impaired, sf.synced, sf."syncFailed" AS sync_failed,
  sf."errorMessage" AS error_message, sf."createdAt" AS created_at
  FROM subtitle_files sf
  LEFT JOIN media m ON m.id = sf."mediaId"
  LEFT JOIN items e ON e.id = sf."episodeId" LEFT JOIN item_groups es ON es.id = e."groupId"
  LEFT JOIN media_files mf ON mf.id = sf."mediaFileId"
  LEFT JOIN items fe ON fe.id = mf."episodeId" LEFT JOIN item_groups fs ON fs.id = fe."groupId""#;

impl ItemRow {
    fn json(&self, full: bool) -> Value {
        let mut v = json!({
            "id": self.id,
            "mediaId": self.media_id,
            "mediaTitle": self.media_title.clone().unwrap_or_else(|| "?".into()),
            "mediaType": self.media_type,
            "episodeId": self.episode_id,
            "seasonNumber": self.season_number,
            "episodeNumber": self.episode_number,
            "episodeTitle": self.episode_title,
            "language": self.language,
            "providerType": self.provider_type,
            "score": self.score,
            "status": self.status,
            "createdAt": super::model::iso(self.created_at),
        });
        if full {
            v["forced"] = json!(self.forced);
            v["hearingImpaired"] = json!(self.hearing_impaired);
            v["synced"] = json!(self.synced);
            v["syncFailed"] = json!(self.sync_failed);
            v["errorMessage"] = json!(self.error_message);
        }
        v
    }
}

const STATUSES: [&str; 7] = [
    "missing",
    "downloaded",
    "upgraded",
    "synced",
    "failed",
    "embedded",
    "processing",
];
const PROVIDER_TYPES: [&str; 15] = [
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

#[utoipa::path(get, path = "/api/subtitles/history", responses((status = 200)))]
pub async fn history(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<HashMap<String, String>>,
) -> Res<Json<Value>> {
    policy(&a, Action::Read)?;
    let (page, limit) = page_limit(&q, 25.0, Some((1.0, 100.0)))?;
    let status = q.get("status").filter(|s| !s.is_empty());
    let ptype = q.get("providerType").filter(|s| !s.is_empty());
    if status.is_some_and(|s| !STATUSES.contains(&s.as_str())) {
        return Err(AppError::bad_request("status must be a valid enum value"));
    }
    if ptype.is_some_and(|s| !PROVIDER_TYPES.contains(&s.as_str())) {
        return Err(AppError::bad_request(
            "providerType must be a valid enum value",
        ));
    }
    let visible = visible_media(&st, &a).await?;
    let filter = r#" WHERE ($1::bool IS NOT TRUE OR sf."providerType"::text <> 'embedded')
      AND ($2::text IS NULL OR sf.status::text = $2) AND ($3::text IS NULL OR sf.language = $3)
      AND ($4::text IS NULL OR sf."providerType"::text = $4)
      AND ($5::int[] IS NULL OR m."libraryId" = ANY($5))"#;
    let exclude = q.get("excludeEmbedded").is_some_and(|v| v == "true");
    let language = q.get("language").filter(|s| !s.is_empty());
    let rows: Vec<ItemRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "{ITEM_SELECT}{filter} ORDER BY sf.\"createdAt\" DESC, sf.id ASC LIMIT {limit} OFFSET {}",
        (page - 1) * limit
    )))
    .bind(exclude)
    .bind(status)
    .bind(language)
    .bind(ptype)
    .bind(&visible)
    .fetch_all(&st.db)
    .await?;
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"SELECT count(*) FROM subtitle_files sf LEFT JOIN media m ON m.id = sf."mediaId"{filter}"#
    )))
    .bind(exclude)
    .bind(status)
    .bind(language)
    .bind(ptype)
    .bind(&visible)
    .fetch_one(&st.db)
    .await?;
    Ok(Json(
        json!({"data": rows.iter().map(|r| r.json(true)).collect::<Vec<_>>(), "total": total, "page": page, "limit": limit}),
    ))
}

#[utoipa::path(get, path = "/api/subtitles/stats", responses((status = 200)))]
pub async fn stats(State(st): State<AppState>, a: Authed) -> Res<Json<Value>> {
    policy(&a, Action::Read)?;
    let visible = visible_media(&st, &a).await?;
    let scope = r#" FROM subtitle_files sf LEFT JOIN media m ON m.id = sf."mediaId"
      WHERE sf."providerType"::text <> 'embedded' AND ($1::int[] IS NULL OR m."libraryId" = ANY($1))"#;
    let total: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT count(*){scope}")))
        .bind(&visible)
        .fetch_one(&st.db)
        .await?;
    let group =
        |col: &'static str| format!("SELECT {col}::text, COUNT(*)::int{scope} GROUP BY {col}");
    let by_status: Vec<(String, i32)> = sqlx::query_as(sqlx::AssertSqlSafe(group("sf.status")))
        .bind(&visible)
        .fetch_all(&st.db)
        .await?;
    let by_provider: Vec<(String, i32)> =
        sqlx::query_as(sqlx::AssertSqlSafe(group("sf.\"providerType\"")))
            .bind(&visible)
            .fetch_all(&st.db)
            .await?;
    let recent: Vec<ItemRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{ITEM_SELECT} WHERE sf."providerType"::text <> 'embedded' AND ($1::int[] IS NULL OR m."libraryId" = ANY($1))
           ORDER BY sf."createdAt" DESC, sf.id ASC LIMIT 10"#
    )))
    .bind(&visible)
    .fetch_all(&st.db)
    .await?;
    let map =
        |v: Vec<(String, i32)>| Value::Object(v.into_iter().map(|(k, n)| (k, json!(n))).collect());
    Ok(Json(
        json!({"total": total, "byStatus": map(by_status), "byProvider": map(by_provider),
        "recent": recent.iter().map(|r| r.json(false)).collect::<Vec<_>>()}),
    ))
}

#[utoipa::path(get, path = "/api/subtitles/health", responses((status = 200)))]
pub async fn health(State(st): State<AppState>, a: Authed) -> Res<Json<Value>> {
    // The stored credentials are used, so the route needs `subtitles.manage`.
    policy(&a, Action::Create)?;
    let mut out = vec![];
    for p in service::enabled_providers(&st.db).await? {
        let r = match Provider::new(&p.kind, &p.settings, &st.subtitles) {
            Ok(imp) => imp.test().await,
            Err(e) => super::providers::TestResult::fail(e),
        };
        out.push(
            json!({"id": p.id, "name": p.name, "type": p.kind, "ok": r.ok, "error": r.detail}),
        );
    }
    Ok(Json(Value::Array(out)))
}

#[utoipa::path(get, path = "/api/subtitles/missing", responses((status = 200)))]
pub async fn missing(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<HashMap<String, String>>,
) -> Res<Json<Value>> {
    policy(&a, Action::Read)?;
    let (page, limit) = page_limit(&q, 50.0, Some((1.0, 500.0)))?;
    let burn_in = service::flag_on(&st, "subtitle_burn_in_covers_language").await?;
    let codecs: Vec<String> = if burn_in {
        vec![]
    } else {
        IMAGE_BASED_CODECS.iter().map(|c| (*c).to_owned()).collect()
    };
    let visible = visible_media(&st, &a).await?;
    #[derive(FromRow)]
    struct M {
        media_id: i32,
        media_title: String,
        media_type: String,
        language: String,
        forced: bool,
        file_id: i32,
        file_path: String,
        episode_id: Option<i32>,
        season_number: Option<i32>,
        episode_number: Option<i32>,
        total: i64,
    }
    // The HI mode never decides what is missing; items without an isoCode are skipped.
    let rows: Vec<M> = sqlx::query_as(
        r#"WITH required AS (
             SELECT m.id AS media_id, m.title AS media_title, m.type AS media_type,
                    lang->>'isoCode' AS language, COALESCE((lang->>'forced')::boolean, false) AS forced
             FROM media m
             JOIN language_profiles lp ON lp.id = m."languageProfileId"
             CROSS JOIN LATERAL jsonb_array_elements(lp."subtitleLanguages") AS lang
             WHERE m.monitored = true AND lang->>'isoCode' IS NOT NULL
               AND ($4::int[] IS NULL OR m."libraryId" = ANY($4))
           )
           SELECT r.media_id, r.media_title, r.media_type, r.language, r.forced, f.id AS file_id,
                  f."relativePath" AS file_path, f."episodeId" AS episode_id, s."number" AS season_number,
                  e."number" AS episode_number, COUNT(*) OVER () AS total
           FROM required r
           JOIN media_files f ON f."mediaId" = r.media_id
           LEFT JOIN items e ON e.id = f."episodeId"
           LEFT JOIN item_groups s ON s.id = e."groupId"
           WHERE NOT EXISTS (
             SELECT 1 FROM subtitle_files sf
             WHERE sf."mediaFileId" = f.id AND sf.language = r.language AND sf.forced = r.forced
               AND COALESCE(sf.codec, '') <> ALL ($1::text[])
               AND COALESCE(sf.status::text, '') <> 'failed')
           ORDER BY lower(r.media_title), r.media_id, f.id, r.language, r.forced
           LIMIT $2 OFFSET $3"#,
    )
    .bind(&codecs)
    .bind(limit)
    .bind((page - 1) * limit)
    .bind(&visible)
    .fetch_all(&st.db)
    .await?;
    let total = rows.first().map_or(0, |r| r.total);
    let data: Vec<Value> = rows
        .iter()
        .map(|r| {
            let label = match (r.season_number, r.episode_number) {
                (Some(s), Some(e)) => Some(format!("S{s:02}E{e:02}")),
                _ => None,
            };
            json!({"mediaId": r.media_id, "mediaTitle": r.media_title, "mediaType": r.media_type, "fileId": r.file_id,
                "fileName": r.file_path.rsplit('/').next().unwrap_or(&r.file_path), "episodeId": r.episode_id,
                "episodeLabel": label, "language": r.language, "forced": r.forced})
        })
        .collect();
    Ok(Json(json!({"total": total, "data": data})))
}

#[derive(FromRow, Serialize)]
#[serde(rename_all = "camelCase")]
struct BlacklistRow {
    id: i32,
    #[serde(with = "iso_ms")]
    created_at: DateTime<Utc>,
    #[serde(with = "iso_ms")]
    updated_at: DateTime<Utc>,
    provider_type: String,
    provider_file_id: String,
    media_id: Option<i32>,
    language: Option<String>,
    source_title: Option<String>,
    reason: Option<String>,
}

const BL_COLS: &str = r#"id, "createdAt" AS created_at, "updatedAt" AS updated_at, "providerType" AS provider_type,
  "providerFileId" AS provider_file_id, "mediaId" AS media_id, language, "sourceTitle" AS source_title, reason"#;

#[utoipa::path(get, path = "/api/subtitles/blacklist", responses((status = 200)))]
pub async fn blacklist_list(
    State(st): State<AppState>,
    a: Authed,
    Query(q): Query<HashMap<String, String>>,
) -> Res<Json<Value>> {
    policy(&a, Action::Read)?;
    let (page, limit) = page_limit(&q, 25.0, None)?;
    let rows: Vec<BlacklistRow> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {BL_COLS} FROM subtitle_blacklist ORDER BY "createdAt" DESC, id ASC LIMIT $1 OFFSET $2"#
    )))
    .bind(limit)
    .bind((page - 1) * limit)
    .fetch_all(&st.db)
    .await?;
    let total: i64 = sqlx::query_scalar("SELECT count(*) FROM subtitle_blacklist")
        .fetch_one(&st.db)
        .await?;
    Ok(Json(json!({"data": rows, "total": total})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlacklistBody {
    #[serde(default)]
    provider_type: Option<String>,
    #[serde(default)]
    provider_file_id: Option<String>,
    #[serde(default)]
    media_id: Option<i32>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    source_title: Option<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[utoipa::path(post, path = "/api/subtitles/blacklist", responses((status = 201)))]
pub async fn blacklist_add(
    State(st): State<AppState>,
    a: Authed,
    body: ValidJson<Value>,
) -> Res<(StatusCode, Json<Value>)> {
    policy(&a, Action::Create)?;
    let b: BlacklistBody = from_value(body.0)?;
    let (Some(ptype), Some(file_id)) = (
        b.provider_type.filter(|v| !v.is_empty()),
        b.provider_file_id.filter(|v| !v.is_empty()),
    ) else {
        return Err(AppError::bad_request(
            "Only a provider download can be blacklisted",
        ));
    };
    if let Some(m) = b.media_id {
        // The media is kept; an unknown one is 404.
        let found: Option<i32> = sqlx::query_scalar("SELECT id FROM media WHERE id = $1")
            .bind(m)
            .fetch_optional(&st.db)
            .await?;
        if found.is_none() {
            return Err(AppError::not_found(format!("Media #{m} not found")));
        }
    }
    let row: BlacklistRow = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"INSERT INTO subtitle_blacklist ("providerType", "providerFileId", language, "sourceTitle", reason, "mediaId")
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING {BL_COLS}"#
    )))
    .bind(&ptype)
    .bind(&file_id)
    .bind(&b.language)
    .bind(&b.source_title)
    .bind(&b.reason)
    .bind(b.media_id)
    .fetch_one(&st.db)
    .await?;
    // The body never carries `mediaId`, and optional columns only when sent.
    let mut v = json!({"id": row.id, "createdAt": super::model::iso(row.created_at), "updatedAt": super::model::iso(row.updated_at),
        "providerType": ptype, "providerFileId": file_id});
    for (k, x) in [
        ("language", &b.language),
        ("sourceTitle", &b.source_title),
        ("reason", &b.reason),
    ] {
        if let Some(x) = x {
            v[k] = json!(x);
        }
    }
    Ok((StatusCode::CREATED, Json(v)))
}

#[utoipa::path(delete, path = "/api/subtitles/blacklist/{id}", responses((status = 200)))]
pub async fn blacklist_remove(
    State(st): State<AppState>,
    a: Authed,
    id: Result<PathParams<i32>, AppError>,
) -> Res<StatusCode> {
    policy(&a, Action::Delete)?;
    let PathParams(id) = id?;
    let done = sqlx::query("DELETE FROM subtitle_blacklist WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    if done.rows_affected() == 0 {
        return Err(AppError::not_found(format!(
            "Blacklist entry #{id} not found"
        )));
    }
    Ok(StatusCode::OK)
}

#[utoipa::path(delete, path = "/api/subtitles/blacklist", responses((status = 200)))]
pub async fn blacklist_clear(State(st): State<AppState>, a: Authed) -> Res<Json<Value>> {
    policy(&a, Action::Delete)?;
    let done = sqlx::query("DELETE FROM subtitle_blacklist")
        .execute(&st.db)
        .await?;
    Ok(Json(json!({"deleted": done.rows_affected()})))
}

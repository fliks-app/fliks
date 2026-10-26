//! The user reads of the guide (`livetv-guide.md`): the match report, `on-now`, `guide`, `programs/:id`, `search` and the prune.
use super::{
    admin,
    channels::{Visible, denied_for, like_pattern, text_filter},
    dto::{Query as Q, query_flag, query_int},
    model::{PROGRAM_COLS, Program},
    sync::setting_int,
};
use crate::{
    http::{
        AppError,
        auth::Authed,
        validate::{PathParams, int_param},
    },
    state::AppState,
};
use axum::{
    Json,
    extract::{Query, State},
};
use chrono::{DateTime, Duration, Utc};
use fliks_domain::{
    acl::{Action, Subject},
    livetv::guide::pick_highest_priority,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

const PAGE_SIZE: i64 = 50;

fn read(a: &Authed) -> Result<(), AppError> {
    a.require(Action::Read, Subject::LiveTvChannel)
}

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
    let rows: Vec<Program> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {PROGRAM_COLS} FROM livetv_programs p WHERE p."guideChannelId" = ANY($1) AND p."startsAt" < $3 AND p."endsAt" > $2
           ORDER BY p."startsAt", p.id"#
    )))
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
    let p: Program = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        "SELECT {PROGRAM_COLS} FROM livetv_programs p WHERE p.id = $1"
    )))
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
    let programs: Vec<Program> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"SELECT {PROGRAM_COLS} FROM livetv_programs p
           WHERE p.title ILIKE $1 ESCAPE '\' AND p."startsAt" < $3 AND p."endsAt" > $2
             AND EXISTS (SELECT 1 FROM livetv_channels c
                         LEFT JOIN livetv_user_channel_prefs pref ON pref."channelId" = c.id AND pref."userId" = $4
                         WHERE c."guideChannelId" = p."guideChannelId" AND c.enabled AND (pref.hidden IS NULL OR pref.hidden = false)
                           AND (cardinality($5::text[]) = 0 OR c."groupName" IS NULL
                                OR lower(btrim(c."groupName")) <> ALL (SELECT lower(btrim(x)) FROM unnest($5::text[]) AS x)))
           ORDER BY p."startsAt", p.id LIMIT 50"#
    )))
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

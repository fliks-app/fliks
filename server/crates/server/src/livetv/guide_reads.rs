//! The user reads of the guide (`livetv-guide.md`): the match report, `on-now`, `guide`, `programs/:id`, `search` and the prune.
use super::{
    admin,
    channels::{Visible, denied_for, text_filter},
    dto::{Query as Q, query_flag, query_int},
    model::{ChannelItem, PROGRAM_COLS, Program},
    sync::setting_int,
};
use crate::{
    http::{AppError, auth::Authed},
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

fn guide_ids(items: &[ChannelItem]) -> Vec<String> {
    items
        .iter()
        .filter_map(|c| c.guide_channel_id.clone())
        .collect()
}

/// The widest per-channel shift of the page: the programme query reaches that far each side.
fn widest_shift(items: &[ChannelItem]) -> Duration {
    let m = items.iter().map(|c| c.guide_shift_minutes.unsigned_abs());
    Duration::minutes(i64::from(m.max().unwrap_or(0)))
}

/// The programmes of the channel's guide id with the channel's own `guideShiftMinutes` applied (rule 36).
fn shifted(rows: &[Program], c: &ChannelItem) -> Vec<Program> {
    let by = Duration::minutes(i64::from(c.guide_shift_minutes));
    rows.iter()
        .filter(|p| Some(p.guide_channel_id.as_str()) == c.guide_channel_id.as_deref())
        .map(|p| Program {
            starts_at: p.starts_at + by,
            ends_at: p.ends_at + by,
            ..p.clone()
        })
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
        let reach = widest_shift(&items);
        ranked(&st.db, &ids, now - reach, now + Duration::hours(12) + reach).await?
    };
    let entries: Vec<Value> = items
        .iter()
        .map(|c| {
            let mine = shifted(&rows, c);
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
        let reach = widest_shift(&items);
        let rows = ranked(&st.db, &ids, from - reach, to + reach).await?;
        for c in &items {
            let mine: Vec<Program> = shifted(&rows, c)
                .into_iter()
                .filter(|p| p.starts_at < to && p.ends_at > from)
                .collect();
            if !mine.is_empty() {
                programs.insert(
                    c.id.to_string(),
                    serde_json::to_value(mine).expect("programs"),
                );
            }
        }
    }
    Ok(Json(
        json!({"channels": items, "programs": programs, "page": page, "pageSize": size, "total": total}),
    ))
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

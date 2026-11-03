//! Reading state (`kobo.md` rules 18-21): the playback state of a book as a Kobo `ReadingState`, both ways.
use super::{
    BOOK_PREFIX, Kobo,
    books::{self, not_found},
    iso, json_response, uuid,
};
use crate::{
    http::{AppError, validate::ValidJson},
    playback::{Watch, finish_context, record_watch},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Response,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashMap;

const MAX_STATE: usize = 16 * 1024;

/// A book's playback state and the state this token's device last wrote.
#[derive(sqlx::FromRow)]
struct Row {
    id: i32,
    progression: Option<f64>,
    completed: Option<bool>,
    updated: Option<DateTime<Utc>>,
    state: Option<Value>,
}

/// The `ReadingState` of each `(item, created)` for the token's owner.
pub async fn read(
    db: &PgPool,
    user: i32,
    token: i32,
    items: &[(i32, DateTime<Utc>)],
) -> Result<HashMap<i32, Value>, sqlx::Error> {
    let ids: Vec<i32> = items.iter().map(|i| i.0).collect();
    let rows: Vec<Row> = sqlx::query_as(
        r#"SELECT u.id, ps.progression, ps.completed, ps."updatedAt" AS updated, k.state
           FROM unnest($3::int[]) AS u(id)
           LEFT JOIN playback_states ps ON ps."userId" = $1 AND ps."itemId" = u.id
           LEFT JOIN kobo_sync_items k ON k."tokenId" = $2 AND k.kind = 'item' AND k."refId" = u.id"#,
    )
    .bind(user)
    .bind(token)
    .bind(&ids)
    .fetch_all(db)
    .await?;
    let created: HashMap<i32, DateTime<Utc>> = items.iter().copied().collect();
    Ok(rows
        .into_iter()
        .map(|r| (r.id, build(&r, created[&r.id])))
        .collect())
}

fn build(r: &Row, created: DateTime<Utc>) -> Value {
    let modified = r.updated.unwrap_or(created);
    let at = iso(modified);
    let id = uuid(BOOK_PREFIX, r.id);
    let mut out = json!({
        "EntitlementId": id, "Created": iso(created), "LastModified": at, "PriorityTimestamp": at,
    });
    let own = r.state.as_ref().filter(|s| {
        r.updated
            .is_none_or(|u| s["at"].as_i64().is_some_and(|a| a >= u.timestamp_micros()))
    });
    let o = out.as_object_mut().expect("object");
    if let Some(s) = own {
        for k in ["StatusInfo", "Statistics", "CurrentBookmark"] {
            if !s[k].is_null() {
                o.insert(k.into(), s[k].clone());
            }
        }
        return out;
    }
    let p = r.progression.unwrap_or(0.0);
    let status = if r.completed == Some(true) {
        "Finished"
    } else if p > 0.0 {
        "Reading"
    } else {
        "ReadyToRead"
    };
    o.insert(
        "StatusInfo".into(),
        json!({"LastModified": at, "Status": status, "TimesStartedReading": 0}),
    );
    o.insert(
        "Statistics".into(),
        json!({"LastModified": at, "SpentReadingMinutes": 0, "RemainingTimeMinutes": 0}),
    );
    o.insert(
        "CurrentBookmark".into(),
        json!({"LastModified": at, "ProgressPercent": p * 100.0, "ContentSourceProgressPercent": p * 100.0}),
    );
    out
}

pub async fn get(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let Some(b) = books::find(&st.db, &k, &id).await? else {
        return Ok(not_found());
    };
    let s = read(&st.db, k.a.user.id, k.token_id, &[(b.item, b.created)]).await?;
    Ok(json_response(StatusCode::OK, json!([s[&b.item]])))
}

fn invalid() -> Response {
    json_response(
        StatusCode::BAD_REQUEST,
        json!({"message": "Invalid request"}),
    )
}

pub async fn put(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, id)): Path<(String, String)>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Response, AppError> {
    let Some(b) = books::find(&st.db, &k, &id).await? else {
        return Ok(not_found());
    };
    let want = uuid(BOOK_PREFIX, b.item);
    let Some(s) = body["ReadingStates"].as_array().and_then(|a| {
        a.iter()
            .find(|s| s["EntitlementId"].as_str() == Some(&want))
    }) else {
        return Ok(invalid());
    };
    let percent = s["CurrentBookmark"]["ProgressPercent"]
        .as_f64()
        .filter(|p| p.is_finite());
    let progression = match s["StatusInfo"]["Status"].as_str() {
        Some("Finished") => Some(1.0),
        _ => percent.map(|p| (p / 100.0).clamp(0.0, 1.0)),
    };
    let user = k.a.user.id;
    let mut at = None;
    if let Some(p) = progression {
        let (family, last_chapter_start) = finish_context(&st.db, b.item, b.file).await?;
        let watch = Watch {
            position: 0.0,
            duration: 0.0,
            file: b.file,
            item: b.item,
            episode: None,
            client_played_at: None,
            family,
            last_chapter_start,
            progression: Some(p),
            locator: None,
            clear_locator: true,
        };
        record_watch(&st.db, user, b.media, &watch).await?;
        at = sqlx::query_scalar::<_, DateTime<Utc>>(
            r#"SELECT "updatedAt" FROM playback_states WHERE "userId" = $1 AND "itemId" = $2"#,
        )
        .bind(user)
        .bind(b.item)
        .fetch_optional(&st.db)
        .await?;
    }
    if let Some(at) = at {
        let kept = json!({
            "at": at.timestamp_micros(), "StatusInfo": s["StatusInfo"],
            "Statistics": s["Statistics"], "CurrentBookmark": s["CurrentBookmark"],
        });
        if kept.to_string().len() <= MAX_STATE {
            sqlx::query(
                r#"INSERT INTO kobo_sync_items ("tokenId", kind, "refId", "syncedAt", "stateAt", "state")
                   VALUES ($1, 'item', $2, 'epoch', $3, $4)
                   ON CONFLICT ("tokenId", kind, "refId") DO UPDATE SET "stateAt" = $3, "state" = $4"#,
            )
            .bind(k.token_id)
            .bind(b.item)
            .bind(at)
            .bind(kept)
            .execute(&st.db)
            .await?;
        }
    }
    let ok = json!({"Result": "Success"});
    Ok(json_response(
        StatusCode::OK,
        json!({"RequestResult": "Success", "UpdateResults": [{
            "EntitlementId": want, "CurrentBookmarkResult": ok,
            "StatisticsResult": ok, "StatusInfoResult": ok}]}),
    ))
}

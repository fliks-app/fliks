//! Library sync and archive (`kobo.md` rules 10-17): what the device was sent lives in `kobo_sync_items`.
use super::{
    Kobo,
    books::{self, Book},
    json_response, state,
};
use crate::{http::AppError, state::AppState};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{BTreeMap, HashMap, HashSet};

const LIMIT: usize = 100;

/// What the previous answer sent (`b` books, `g` removals, `s` shelves, `sg` shelf removals) and when it read the library.
#[derive(Serialize, Deserialize, Default)]
struct Token {
    v: u8,
    t: i64,
    #[serde(default)]
    b: Vec<i32>,
    #[serde(default)]
    g: Vec<i32>,
    #[serde(default)]
    s: Vec<i32>,
    #[serde(default)]
    sg: Vec<i32>,
}

fn parse_token(v: &HeaderValue) -> Option<Token> {
    let raw = STANDARD.decode(v.as_bytes()).ok()?;
    serde_json::from_slice::<Token>(&raw)
        .ok()
        .filter(|t| t.v == 1)
}

async fn ack_kind(
    db: &PgPool,
    token: i32,
    kind: &str,
    sent: &[i32],
    gone: &[i32],
    t: DateTime<Utc>,
) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO kobo_sync_items ("tokenId", kind, "refId", "syncedAt", "stateAt")
           SELECT $1, $2, u, $4, $4 FROM unnest($3::int[]) u
           ON CONFLICT ("tokenId", kind, "refId") DO UPDATE SET
             "syncedAt" = GREATEST(kobo_sync_items."syncedAt", EXCLUDED."syncedAt"),
             "stateAt" = GREATEST(kobo_sync_items."stateAt", EXCLUDED."stateAt")"#,
    )
    .bind(token)
    .bind(kind)
    .bind(sent)
    .bind(t)
    .execute(db)
    .await?;
    forget(db, token, kind, gone).await
}

async fn forget(db: &PgPool, token: i32, kind: &str, ids: &[i32]) -> sqlx::Result<()> {
    sqlx::query(
        r#"DELETE FROM kobo_sync_items WHERE "tokenId" = $1 AND kind = $2 AND "refId" = ANY($3)"#,
    )
    .bind(token)
    .bind(kind)
    .bind(ids)
    .execute(db)
    .await
    .map(drop)
}

type Rows = BTreeMap<i32, (DateTime<Utc>, DateTime<Utc>, bool)>;

async fn rows(db: &PgPool, token: i32, kind: &str) -> sqlx::Result<Rows> {
    let r: Vec<(i32, DateTime<Utc>, DateTime<Utc>, bool)> = sqlx::query_as(
        r#"SELECT "refId", "syncedAt", "stateAt", archived FROM kobo_sync_items WHERE "tokenId" = $1 AND kind = $2"#,
    )
    .bind(token)
    .bind(kind)
    .fetch_all(db)
    .await?;
    Ok(r.into_iter().map(|(i, s, a, x)| (i, (s, a, x))).collect())
}

enum Change {
    New,
    Changed,
    State,
}

pub async fn library_sync(
    State(st): State<AppState>,
    k: Kobo,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let (db, tid, user) = (&st.db, k.token_id, k.a.user.id);
    match headers.get("x-kobo-synctoken").and_then(parse_token) {
        Some(p) => {
            let t = DateTime::from_timestamp_micros(p.t).unwrap_or_default();
            ack_kind(db, tid, "item", &p.b, &p.g, t).await?;
            ack_kind(db, tid, "shelf", &p.s, &p.sg, t).await?;
        }
        None => {
            sqlx::query(r#"DELETE FROM kobo_sync_items WHERE "tokenId" = $1"#)
                .bind(tid)
                .execute(db)
                .await?;
        }
    }
    let now: DateTime<Utc> = sqlx::query_scalar("SELECT now()").fetch_one(db).await?;
    let mut tok = Token {
        v: 1,
        t: now.timestamp_micros(),
        ..Token::default()
    };
    let mut out: Vec<Value> = vec![];
    let mut more = false;

    // ponytail: the whole readable library is read per call; a cursor if libraries pass tens of thousands.
    let books = books::fetch(db, &k.acl, None).await?;
    let visible: HashSet<i32> = books.iter().map(|b| b.item).collect();
    let have = rows(db, tid, "item").await?;

    let mut purge = vec![];
    for (id, (synced, _, archived)) in &have {
        if visible.contains(id) {
            continue;
        }
        if *archived {
            purge.push(*id);
        } else if out.len() < LIMIT {
            let e = books::entitlement(*id, *synced, now, true);
            out.push(json!({"ChangedEntitlement": {"BookEntitlement": e}}));
            tok.g.push(*id);
        } else {
            more = true;
        }
    }
    forget(db, tid, "item", &purge).await?;

    let ids: Vec<i32> = books.iter().map(|b| b.item).collect();
    let touched: HashMap<i32, DateTime<Utc>> = sqlx::query_as::<_, (i32, DateTime<Utc>)>(
        r#"SELECT "itemId", "updatedAt" FROM playback_states WHERE "userId" = $1 AND "itemId" = ANY($2)"#,
    )
    .bind(user)
    .bind(&ids)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();
    let mut page: Vec<(&Book, Change)> = vec![];
    for b in &books {
        let change = match have.get(&b.item) {
            None => Change::New,
            Some((_, _, true)) => continue,
            Some((synced, _, _)) if *synced < b.updated => Change::Changed,
            Some((_, known, _)) if touched.get(&b.item).is_some_and(|t| t > known) => Change::State,
            Some(_) => continue,
        };
        if out.len() + page.len() < LIMIT {
            page.push((b, change));
        } else {
            more = true;
        }
    }
    let wanted: Vec<_> = page.iter().map(|(b, _)| (b.item, b.created)).collect();
    let states = state::read(db, user, tid, &wanted).await?;
    for (b, change) in page {
        let rs = states[&b.item].clone();
        out.push(match change {
            Change::State => json!({"ChangedReadingState": {"ReadingState": rs}}),
            c => {
                let key = if matches!(c, Change::New) {
                    "NewEntitlement"
                } else {
                    "ChangedEntitlement"
                };
                json!({key: {"BookEntitlement": books::book_entitlement(b),
                    "BookMetadata": books::book_metadata(&k, b), "ReadingState": rs}})
            }
        });
        tok.b.push(b.item);
    }

    more |= super::shelves::sync(
        db,
        &k,
        &visible,
        now,
        &mut out,
        &mut tok.s,
        &mut tok.sg,
        LIMIT,
    )
    .await?;

    let mut res = json_response(StatusCode::OK, Value::Array(out));
    let h = res.headers_mut();
    let enc = STANDARD.encode(serde_json::to_vec(&tok).expect("token"));
    h.insert(
        "x-kobo-synctoken",
        HeaderValue::from_str(&enc).expect("base64"),
    );
    if more {
        h.insert("x-kobo-sync", HeaderValue::from_static("continue"));
    }
    Ok(res)
}

pub async fn archive(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let Some(b) = books::find(&st.db, &k, &id).await? else {
        return Ok(books::not_found());
    };
    sqlx::query(
        r#"INSERT INTO kobo_sync_items ("tokenId", kind, "refId", "syncedAt", "stateAt", archived)
           VALUES ($1, 'item', $2, now(), now(), true)
           ON CONFLICT ("tokenId", kind, "refId") DO UPDATE SET archived = true"#,
    )
    .bind(k.token_id)
    .bind(b.item)
    .execute(&st.db)
    .await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

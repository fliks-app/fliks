//! Shelves (`kobo.md` rules 22-24): the playlists a user owns, as Kobo tags.
use super::{BOOK_PREFIX, Kobo, SHELF_PREFIX, books, iso, json_response, parse_uuid, uuid};
use crate::{
    http::{AppError, validate::ValidJson},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};

type Playlist = (i32, String, DateTime<Utc>, DateTime<Utc>);

async fn owned(db: &PgPool, user: i32) -> sqlx::Result<Vec<Playlist>> {
    sqlx::query_as(
        r#"SELECT id, name, "createdAt", "updatedAt" FROM playlists WHERE "ownerId" = $1 ORDER BY id"#,
    )
    .bind(user)
    .fetch_all(db)
    .await
}

/// The readable books of each playlist, in position order.
async fn contents(
    db: &PgPool,
    ids: &[i32],
    visible: &HashSet<i32>,
) -> sqlx::Result<HashMap<i32, Vec<i32>>> {
    let rows: Vec<(i32, i32)> = sqlx::query_as(
        r#"SELECT "playlistId", "itemId" FROM playlist_items WHERE "playlistId" = ANY($1)
           ORDER BY "playlistId", position, id"#,
    )
    .bind(ids)
    .fetch_all(db)
    .await?;
    let mut m: HashMap<i32, Vec<i32>> = HashMap::new();
    for (p, i) in rows.into_iter().filter(|(_, i)| visible.contains(i)) {
        m.entry(p).or_default().push(i);
    }
    Ok(m)
}

fn tag(p: &Playlist, items: &[i32]) -> Value {
    json!({
        "Created": iso(p.2), "Id": uuid(SHELF_PREFIX, p.0), "LastModified": iso(p.3), "Name": p.1,
        "Type": "UserTag",
        "Items": items.iter().map(|i| json!({"RevisionId": uuid(BOOK_PREFIX, *i), "Type": "ProductRevisionTagItem"})).collect::<Vec<_>>(),
    })
}

async fn visible(db: &PgPool, k: &Kobo) -> sqlx::Result<HashSet<i32>> {
    Ok(books::fetch(db, &k.acl, None)
        .await?
        .into_iter()
        .map(|b| b.item)
        .collect())
}

/// Appends the tag entries that fit under `limit`; whether some did not.
#[allow(clippy::too_many_arguments)]
pub async fn sync(
    db: &PgPool,
    k: &Kobo,
    visible: &HashSet<i32>,
    now: DateTime<Utc>,
    out: &mut Vec<Value>,
    sent: &mut Vec<i32>,
    gone: &mut Vec<i32>,
    limit: usize,
) -> sqlx::Result<bool> {
    let lists = owned(db, k.a.user.id).await?;
    let have: HashMap<i32, DateTime<Utc>> = sqlx::query_as::<_, (i32, DateTime<Utc>)>(
        r#"SELECT "refId", "syncedAt" FROM kobo_sync_items WHERE "tokenId" = $1 AND kind = 'shelf'"#,
    )
    .bind(k.token_id)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();
    let mut more = false;
    let live: HashSet<i32> = lists.iter().map(|p| p.0).collect();
    let mut dead: Vec<_> = have
        .iter()
        .filter(|(id, _)| !live.contains(id))
        .map(|(id, s)| (*id, *s))
        .collect();
    dead.sort_unstable();
    for (id, _) in dead {
        if out.len() < limit {
            out.push(json!({"DeletedTag": {"Tag": {"Id": uuid(SHELF_PREFIX, id), "LastModified": iso(now)}}}));
            gone.push(id);
        } else {
            more = true;
        }
    }
    let due: Vec<&Playlist> = lists
        .iter()
        .filter(|p| have.get(&p.0).is_none_or(|s| *s < p.3))
        .collect();
    let ids: Vec<i32> = due.iter().map(|p| p.0).collect();
    let items = contents(db, &ids, visible).await?;
    for p in due {
        if out.len() >= limit {
            more = true;
            continue;
        }
        let key = if have.contains_key(&p.0) {
            "ChangedTag"
        } else {
            "NewTag"
        };
        out.push(json!({key: {"Tag": tag(p, items.get(&p.0).map_or(&[][..], Vec::as_slice))}}));
        sent.push(p.0);
    }
    Ok(more)
}

pub async fn list(State(st): State<AppState>, k: Kobo) -> Result<Response, AppError> {
    let lists = owned(&st.db, k.a.user.id).await?;
    let ids: Vec<i32> = lists.iter().map(|p| p.0).collect();
    let items = contents(&st.db, &ids, &visible(&st.db, &k).await?).await?;
    let tags: Vec<Value> = lists
        .iter()
        .map(|p| tag(p, items.get(&p.0).map_or(&[][..], Vec::as_slice)))
        .collect();
    Ok(json_response(StatusCode::OK, Value::Array(tags)))
}

fn name_of(body: &Value) -> Option<String> {
    let n = body["Name"].as_str()?.trim();
    (!n.is_empty() && n.chars().count() <= 255).then(|| n.to_owned())
}

fn revisions(body: &Value) -> Vec<i32> {
    body["Items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|i| parse_uuid(BOOK_PREFIX, i["RevisionId"].as_str()?))
        .collect()
}

/// Adds the readable books among `wanted`, then stamps the playlist and tells the token it knows the change.
async fn touch(
    db: &PgPool,
    k: &Kobo,
    id: i32,
    add: &[i32],
    remove: &[i32],
) -> Result<(), AppError> {
    let readable: Vec<i32> = books::fetch(db, &k.acl, Some(add))
        .await?
        .into_iter()
        .map(|b| b.item)
        .collect();
    sqlx::query(
        r#"INSERT INTO playlist_items ("playlistId", "itemId", position, "addedById")
           SELECT $1, u.id, COALESCE((SELECT max(position) FROM playlist_items WHERE "playlistId" = $1), -1)
                  + row_number() OVER (ORDER BY u.ord)::int, $3
           FROM unnest($2::int[]) WITH ORDINALITY AS u(id, ord)
           ON CONFLICT ("playlistId", "itemId") DO NOTHING"#,
    )
    .bind(id)
    .bind(&readable)
    .bind(k.a.user.id)
    .execute(db)
    .await?;
    sqlx::query(r#"DELETE FROM playlist_items WHERE "playlistId" = $1 AND "itemId" = ANY($2)"#)
        .bind(id)
        .bind(remove)
        .execute(db)
        .await?;
    let at: DateTime<Utc> = sqlx::query_scalar(
        r#"UPDATE playlists SET "updatedAt" = now() WHERE id = $1 RETURNING "updatedAt""#,
    )
    .bind(id)
    .fetch_one(db)
    .await?;
    known(db, k, id, at).await
}

async fn known(db: &PgPool, k: &Kobo, id: i32, at: DateTime<Utc>) -> Result<(), AppError> {
    sqlx::query(
        r#"INSERT INTO kobo_sync_items ("tokenId", kind, "refId", "syncedAt", "stateAt") VALUES ($1, 'shelf', $2, $3, $3)
           ON CONFLICT ("tokenId", kind, "refId") DO UPDATE SET "syncedAt" = EXCLUDED."syncedAt""#,
    )
    .bind(k.token_id)
    .bind(id)
    .bind(at)
    .execute(db)
    .await?;
    Ok(())
}

async fn mine(db: &PgPool, k: &Kobo, tag: &str) -> Result<Option<i32>, sqlx::Error> {
    let Some(id) = parse_uuid(SHELF_PREFIX, tag) else {
        return Ok(None);
    };
    sqlx::query_scalar(r#"SELECT id FROM playlists WHERE id = $1 AND "ownerId" = $2"#)
        .bind(id)
        .bind(k.a.user.id)
        .fetch_optional(db)
        .await
}

fn bad() -> Response {
    json_response(
        StatusCode::BAD_REQUEST,
        json!({"message": "Invalid request"}),
    )
}

pub async fn create(
    State(st): State<AppState>,
    k: Kobo,
    ValidJson(body): ValidJson<Value>,
) -> Result<Response, AppError> {
    let Some(name) = name_of(&body) else {
        return Ok(bad());
    };
    let db = &st.db;
    let found: Option<i32> = sqlx::query_scalar(
        r#"SELECT id FROM playlists WHERE "ownerId" = $1 AND name = $2 ORDER BY id LIMIT 1"#,
    )
    .bind(k.a.user.id)
    .bind(&name)
    .fetch_optional(db)
    .await?;
    let id = match found {
        Some(id) => id,
        None => {
            sqlx::query_scalar(
                r#"INSERT INTO playlists (name, "ownerId") VALUES ($1, $2) RETURNING id"#,
            )
            .bind(&name)
            .bind(k.a.user.id)
            .fetch_one(db)
            .await?
        }
    };
    touch(db, &k, id, &revisions(&body), &[]).await?;
    Ok(json_response(
        StatusCode::CREATED,
        json!(uuid(SHELF_PREFIX, id)),
    ))
}

pub async fn rename(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, tag)): Path<(String, String)>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Response, AppError> {
    let Some(id) = mine(&st.db, &k, &tag).await? else {
        return Ok(books::not_found());
    };
    let Some(name) = name_of(&body) else {
        return Ok(bad());
    };
    sqlx::query("UPDATE playlists SET name = $2 WHERE id = $1")
        .bind(id)
        .bind(name)
        .execute(&st.db)
        .await?;
    touch(&st.db, &k, id, &[], &[]).await?;
    Ok(StatusCode::OK.into_response())
}

pub async fn remove(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, tag)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let Some(id) = mine(&st.db, &k, &tag).await? else {
        return Ok(books::not_found());
    };
    sqlx::query("DELETE FROM playlists WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    sqlx::query(
        r#"DELETE FROM kobo_sync_items WHERE "tokenId" = $1 AND kind = 'shelf' AND "refId" = $2"#,
    )
    .bind(k.token_id)
    .bind(id)
    .execute(&st.db)
    .await?;
    Ok(StatusCode::OK.into_response())
}

pub async fn add_items(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, tag)): Path<(String, String)>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Response, AppError> {
    let Some(id) = mine(&st.db, &k, &tag).await? else {
        return Ok(books::not_found());
    };
    touch(&st.db, &k, id, &revisions(&body), &[]).await?;
    Ok(StatusCode::CREATED.into_response())
}

pub async fn remove_items(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, tag)): Path<(String, String)>,
    ValidJson(body): ValidJson<Value>,
) -> Result<Response, AppError> {
    let Some(id) = mine(&st.db, &k, &tag).await? else {
        return Ok(books::not_found());
    };
    touch(&st.db, &k, id, &[], &revisions(&body)).await?;
    Ok(StatusCode::OK.into_response())
}

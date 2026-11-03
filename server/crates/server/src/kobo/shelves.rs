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
use sqlx::{PgConnection, PgPool};
use std::collections::{HashMap, HashSet};

type Playlist = (i32, String, DateTime<Utc>, DateTime<Utc>);

/// The shelves of the owner: playlists holding a readable book, or already known to this token.
async fn owned(db: &PgPool, k: &Kobo, visible: &[i32]) -> sqlx::Result<Vec<Playlist>> {
    sqlx::query_as(
        r#"SELECT p.id, p.name, p."createdAt", p."updatedAt" FROM playlists p
           WHERE p."ownerId" = $1
             AND (EXISTS (SELECT 1 FROM playlist_items pi WHERE pi."playlistId" = p.id AND pi."itemId" = ANY($2))
               OR EXISTS (SELECT 1 FROM kobo_sync_items s
                          WHERE s."tokenId" = $3 AND s.kind = 'shelf' AND s."refId" = p.id))
           ORDER BY p.id"#,
    )
    .bind(k.a.user.id)
    .bind(visible)
    .bind(k.token_id)
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

async fn visible(db: &PgPool, k: &Kobo) -> sqlx::Result<Vec<i32>> {
    Ok(books::index(db, &k.acl, None)
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
    let lists = owned(db, k, &visible.iter().copied().collect::<Vec<_>>()).await?;
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
    let visible = visible(&st.db, &k).await?;
    let lists = owned(&st.db, &k, &visible).await?;
    let ids: Vec<i32> = lists.iter().map(|p| p.0).collect();
    let items = contents(&st.db, &ids, &visible.into_iter().collect()).await?;
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

enum Edit<'a> {
    Add(&'a [i32]),
    Remove(&'a [i32]),
    Rename(&'a str),
}

/// A playlist that holds anything but books this token may read is not only a shelf.
async fn mixed(db: &PgPool, k: &Kobo, id: i32) -> sqlx::Result<bool> {
    let held: Vec<i32> =
        sqlx::query_scalar(r#"SELECT "itemId" FROM playlist_items WHERE "playlistId" = $1"#)
            .bind(id)
            .fetch_all(db)
            .await?;
    Ok(books::index(db, &k.acl, Some(&held)).await?.len() != held.len())
}

/// One edit of a shelf in one transaction on the locked playlist; `false` when a rename is refused.
async fn edit(db: &PgPool, k: &Kobo, id: i32, e: Edit<'_>) -> Result<bool, AppError> {
    if matches!(e, Edit::Rename(_)) && mixed(db, k, id).await? {
        return Ok(false);
    }
    let readable: Vec<i32> = match e {
        Edit::Add(w) => books::index(db, &k.acl, Some(w))
            .await?
            .into_iter()
            .map(|b| b.item)
            .collect(),
        _ => vec![],
    };
    let mut tx = db.begin().await?;
    let before: (DateTime<Utc>, Option<DateTime<Utc>>) = sqlx::query_as(
        r#"SELECT p."updatedAt", (SELECT s."syncedAt" FROM kobo_sync_items s
                                  WHERE s."tokenId" = $3 AND s.kind = 'shelf' AND s."refId" = p.id)
           FROM playlists p WHERE p.id = $1 AND p."ownerId" = $2 FOR UPDATE"#,
    )
    .bind(id)
    .bind(k.a.user.id)
    .bind(k.token_id)
    .fetch_one(&mut *tx)
    .await?;
    match e {
        Edit::Add(_) => add(&mut tx, id, k.a.user.id, &readable).await?,
        Edit::Remove(w) => {
            sqlx::query(
                r#"DELETE FROM playlist_items WHERE "playlistId" = $1 AND "itemId" = ANY($2)"#,
            )
            .bind(id)
            .bind(w)
            .execute(&mut *tx)
            .await?;
        }
        Edit::Rename(n) => {
            sqlx::query("UPDATE playlists SET name = $2 WHERE id = $1")
                .bind(id)
                .bind(n)
                .execute(&mut *tx)
                .await?;
        }
    }
    let at: DateTime<Utc> = sqlx::query_scalar(
        r#"UPDATE playlists SET "updatedAt" = now() WHERE id = $1 RETURNING "updatedAt""#,
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    // The device knows its own change only when it was up to date before it.
    if before.1.is_some_and(|synced| synced >= before.0) {
        known(&mut tx, k.token_id, id, at).await?;
    }
    tx.commit().await?;
    Ok(true)
}

async fn add(tx: &mut PgConnection, id: i32, user: i32, items: &[i32]) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO playlist_items ("playlistId", "itemId", position, "addedById")
           SELECT $1, u.id, COALESCE((SELECT max(position) FROM playlist_items WHERE "playlistId" = $1), -1)
                  + row_number() OVER (ORDER BY u.ord)::int, $3
           FROM unnest($2::int[]) WITH ORDINALITY AS u(id, ord)
           ON CONFLICT ("playlistId", "itemId") DO NOTHING"#,
    )
    .bind(id)
    .bind(items)
    .bind(user)
    .execute(tx)
    .await
    .map(drop)
}

async fn known(tx: &mut PgConnection, token: i32, id: i32, at: DateTime<Utc>) -> sqlx::Result<()> {
    sqlx::query(
        r#"INSERT INTO kobo_sync_items ("tokenId", kind, "refId", "syncedAt", "stateAt") VALUES ($1, 'shelf', $2, $3, $3)
           ON CONFLICT ("tokenId", kind, "refId") DO UPDATE SET "syncedAt" = EXCLUDED."syncedAt""#,
    )
    .bind(token)
    .bind(id)
    .bind(at)
    .execute(tx)
    .await
    .map(drop)
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
    let wanted = revisions(&body);
    let readable: Vec<i32> = books::index(&st.db, &k.acl, Some(&wanted))
        .await?
        .into_iter()
        .map(|b| b.item)
        .collect();
    let mut tx = st.db.begin().await?;
    // One create at a time per user, so two requests for one name make one shelf.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('kobo-shelf'), $1)")
        .bind(k.a.user.id)
        .execute(&mut *tx)
        .await?;
    let found: Option<i32> = sqlx::query_scalar(
        r#"SELECT p.id FROM playlists p WHERE p."ownerId" = $1 AND p.name = $2
             AND NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi."playlistId" = p.id AND pi."itemId" <> ALL($3))
           ORDER BY p.id LIMIT 1"#,
    )
    .bind(k.a.user.id)
    .bind(&name)
    .bind(&visible(&st.db, &k).await?)
    .fetch_optional(&mut *tx)
    .await?;
    let id = match found {
        Some(id) => id,
        None => {
            sqlx::query_scalar(
                r#"INSERT INTO playlists (name, "ownerId") VALUES ($1, $2) RETURNING id"#,
            )
            .bind(&name)
            .bind(k.a.user.id)
            .fetch_one(&mut *tx)
            .await?
        }
    };
    add(&mut tx, id, k.a.user.id, &readable).await?;
    let at: DateTime<Utc> = sqlx::query_scalar(
        r#"UPDATE playlists SET "updatedAt" = now() WHERE id = $1 RETURNING "updatedAt""#,
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    known(&mut tx, k.token_id, id, at).await?;
    tx.commit().await?;
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
    if !edit(&st.db, &k, id, Edit::Rename(&name)).await? {
        return Ok(json_response(
            StatusCode::CONFLICT,
            json!({"message": "The shelf holds more than books"}),
        ));
    }
    Ok(StatusCode::OK.into_response())
}

/// Deletes the playlist, or only its books when it holds anything else.
pub async fn remove(
    State(st): State<AppState>,
    k: Kobo,
    Path((_, tag)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let Some(id) = mine(&st.db, &k, &tag).await? else {
        return Ok(books::not_found());
    };
    if mixed(&st.db, &k, id).await? {
        let books: Vec<i32> = visible(&st.db, &k).await?;
        sqlx::query(r#"DELETE FROM playlist_items WHERE "playlistId" = $1 AND "itemId" = ANY($2)"#)
            .bind(id)
            .bind(&books)
            .execute(&st.db)
            .await?;
        sqlx::query(r#"UPDATE playlists SET "updatedAt" = now() WHERE id = $1"#)
            .bind(id)
            .execute(&st.db)
            .await?;
    } else {
        sqlx::query("DELETE FROM playlists WHERE id = $1")
            .bind(id)
            .execute(&st.db)
            .await?;
    }
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
    edit(&st.db, &k, id, Edit::Add(&revisions(&body))).await?;
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
    edit(&st.db, &k, id, Edit::Remove(&revisions(&body))).await?;
    Ok(StatusCode::OK.into_response())
}

//! Plain playlists (`opensubsonic.md` rule 27), over `playlists` and `playlist_items`.
use super::{
    Caller, Params,
    catalog::{self, Filter, SongOrder},
    ids::{self, Id},
    render::{Answer, Obj, SubError},
};
use crate::{
    playlists::{Role, assert_role},
    state::AppState,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;
use std::collections::HashMap;

const MAX_NAME: usize = 255;
const ALL: i64 = 100_000;

fn one(key: &str, v: impl Into<Value>) -> Answer {
    let mut o = Obj::new();
    o.insert(key.into(), v.into());
    Ok(o)
}

fn playlist_id(p: &Params, name: &str) -> Result<i32, SubError> {
    match Id::parse(p.required(name)?) {
        Some(Id::Playlist(n)) => Ok(n),
        _ => Err(SubError::not_found()),
    }
}

fn track_ids(raw: &[&str]) -> Result<Vec<i32>, SubError> {
    raw.iter()
        .map(|s| match Id::parse(s) {
            Some(Id::Track(n)) => Ok(n),
            _ => Err(SubError::not_found()),
        })
        .collect()
}

/// The item ids of a playlist in order, whatever they are.
async fn item_ids(db: impl sqlx::PgExecutor<'_>, id: i32) -> Result<Vec<i32>, sqlx::Error> {
    sqlx::query_scalar(
        r#"SELECT "itemId" FROM playlist_items WHERE "playlistId" = $1 ORDER BY position, id"#,
    )
    .bind(id)
    .fetch_all(db)
    .await
}

/// The visible tracks of a playlist, in playlist order.
async fn entries(st: &AppState, c: &Caller, id: i32) -> Result<Vec<Value>, SubError> {
    let order = item_ids(&st.db, id).await?;
    let f = Filter {
        ids: Some(order.clone()),
        limit: ALL,
        ..Default::default()
    };
    let rows = catalog::songs(&st.db, c.user(), &c.libraries, &f, SongOrder::Album).await?;
    let songs = catalog::song_values(&st.db, &rows).await?;
    let mut by_item: HashMap<i32, Value> = rows.iter().map(|r| r.item_id).zip(songs).collect();
    Ok(order.iter().filter_map(|i| by_item.remove(i)).collect())
}

/// `id`, name, owner's username, visibility, created and changed of a `playlists` row.
type Row = (i32, String, String, String, DateTime<Utc>, DateTime<Utc>);

fn header((id, name, owner, visibility, created, changed): &Row, entries: &[Value]) -> Obj {
    let duration: i64 = entries.iter().filter_map(|e| e["duration"].as_i64()).sum();
    let mut o = Obj::new();
    o.insert("id".into(), ids::playlist(*id).into());
    o.insert("name".into(), name.clone().into());
    o.insert("owner".into(), owner.clone().into());
    o.insert("public".into(), (visibility == "public").into());
    o.insert("songCount".into(), entries.len().into());
    o.insert("duration".into(), duration.into());
    o.insert("created".into(), catalog::iso(*created).into());
    o.insert("changed".into(), catalog::iso(*changed).into());
    o
}

const ROW: &str = r#"SELECT p.id, p.name, u.username, p.visibility::text, p."createdAt", p."updatedAt"
   FROM playlists p JOIN users u ON u.id = p."ownerId""#;

pub async fn list(st: &AppState, c: &Caller) -> Answer {
    let rows: Vec<Row> = sqlx::query_as(sqlx::AssertSqlSafe(format!(
        r#"{ROW} WHERE p."ownerId" = $1 OR EXISTS (SELECT 1 FROM playlist_shares s WHERE s."playlistId" = p.id AND s."userId" = $1)
           ORDER BY lower(p.name), p.id"#
    )))
    .bind(c.user())
    .fetch_all(&st.db)
    .await?;
    let mut out = vec![];
    for row in &rows {
        out.push(Value::Object(header(row, &entries(st, c, row.0).await?)));
    }
    one("playlists", json!({"playlist": out}))
}

async fn full(st: &AppState, c: &Caller, id: i32, min: Role) -> Result<Obj, SubError> {
    assert_role(&st.db, c.user(), id, min).await?;
    let row: Row = sqlx::query_as(sqlx::AssertSqlSafe(format!("{ROW} WHERE p.id = $1")))
        .bind(id)
        .fetch_one(&st.db)
        .await?;
    let e = entries(st, c, id).await?;
    let mut o = header(&row, &e);
    o.insert("entry".into(), e.into());
    Ok(o)
}

pub async fn get(st: &AppState, c: &Caller, p: &Params) -> Answer {
    one(
        "playlist",
        full(st, c, playlist_id(p, "id")?, Role::Viewer).await?,
    )
}

async fn check_tracks(st: &AppState, c: &Caller, items: &[i32]) -> Result<(), SubError> {
    let mut unique = items.to_vec();
    unique.sort_unstable();
    unique.dedup();
    if catalog::visible_tracks(&st.db, &c.libraries, &unique)
        .await?
        .len()
        != unique.len()
    {
        return Err(SubError::not_found());
    }
    Ok(())
}

/// Appends the tracks the playlist does not hold yet, in order.
async fn append(
    tx: &mut PgConnection,
    playlist: i32,
    user: i32,
    items: &[i32],
) -> Result<(), sqlx::Error> {
    for item in items {
        sqlx::query(
            r#"INSERT INTO playlist_items ("playlistId", "itemId", position, "addedById")
               SELECT $1, $2, COALESCE(max(position) + 1, 0), $3 FROM playlist_items WHERE "playlistId" = $1
               ON CONFLICT ("playlistId", "itemId") DO NOTHING"#,
        )
        .bind(playlist)
        .bind(item)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(r#"UPDATE playlists SET "updatedAt" = now() WHERE id = $1"#)
        .bind(playlist)
        .execute(tx)
        .await?;
    Ok(())
}

async fn lock(tx: &mut PgConnection, id: i32) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT id FROM playlists WHERE id = $1 FOR UPDATE")
        .bind(id)
        .fetch_optional(tx)
        .await
        .map(drop)
}

fn clean_name(raw: &str) -> String {
    raw.trim().chars().take(MAX_NAME).collect()
}

pub async fn create(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let items = track_ids(&p.all("songId"))?;
    check_tracks(st, c, &items).await?;
    let id = if p.get("playlistId").is_some() {
        let id = playlist_id(p, "playlistId")?;
        let min = if p.get("name").is_some() {
            Role::Administrator
        } else {
            Role::Editor
        };
        assert_role(&st.db, c.user(), id, min).await?;
        let mut tx = st.db.begin().await?;
        lock(&mut tx, id).await?;
        sqlx::query(r#"DELETE FROM playlist_items WHERE "playlistId" = $1"#)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if let Some(name) = p.get("name") {
            sqlx::query("UPDATE playlists SET name = $2 WHERE id = $1")
                .bind(id)
                .bind(clean_name(name))
                .execute(&mut *tx)
                .await?;
        }
        append(&mut tx, id, c.user(), &items).await?;
        tx.commit().await?;
        id
    } else {
        let name = clean_name(p.required("name")?);
        let mut tx = st.db.begin().await?;
        let id: i32 = sqlx::query_scalar(
            r#"INSERT INTO playlists (name, "ownerId") VALUES ($1, $2) RETURNING id"#,
        )
        .bind(name)
        .bind(c.user())
        .fetch_one(&mut *tx)
        .await?;
        append(&mut tx, id, c.user(), &items).await?;
        tx.commit().await?;
        id
    };
    one("playlist", full(st, c, id, Role::Viewer).await?)
}

pub async fn update(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let id = playlist_id(p, "playlistId")?;
    let add = track_ids(&p.all("songIdToAdd"))?;
    check_tracks(st, c, &add).await?;
    let renames = p.get("name").is_some() || p.get("public").is_some();
    assert_role(
        &st.db,
        c.user(),
        id,
        if renames {
            Role::Administrator
        } else {
            Role::Editor
        },
    )
    .await?;
    let public = p.get("public").map(|v| v == "true");
    if public == Some(true) && c.a.user.share_disabled {
        return Err(SubError::new(50, "Sharing is disabled for this user"));
    }
    let entries = entries(st, c, id).await?;
    let order = item_ids(&st.db, id).await?;
    let mut remove = vec![];
    for raw in p.all("songIndexToRemove") {
        let at = raw
            .trim()
            .parse::<usize>()
            .ok()
            .and_then(|i| entries.get(i))
            .ok_or_else(SubError::not_found)?;
        if let Some(Id::Track(n)) = at["id"].as_str().and_then(Id::parse) {
            remove.push(n);
        }
    }
    debug_assert!(remove.iter().all(|r| order.contains(r)));
    let mut tx = st.db.begin().await?;
    lock(&mut tx, id).await?;
    if let Some(name) = p.get("name") {
        sqlx::query("UPDATE playlists SET name = $2 WHERE id = $1")
            .bind(id)
            .bind(clean_name(name))
            .execute(&mut *tx)
            .await?;
    }
    if let Some(public) = public {
        sqlx::query(
            "UPDATE playlists SET visibility = $2::text::playlists_visibility_enum WHERE id = $1",
        )
        .bind(id)
        .bind(if public { "public" } else { "private" })
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query(r#"DELETE FROM playlist_items WHERE "playlistId" = $1 AND "itemId" = ANY($2)"#)
        .bind(id)
        .bind(&remove)
        .execute(&mut *tx)
        .await?;
    append(&mut tx, id, c.user(), &add).await?;
    tx.commit().await?;
    Ok(Default::default())
}

pub async fn delete(st: &AppState, c: &Caller, p: &Params) -> Answer {
    let id = playlist_id(p, "id")?;
    assert_role(&st.db, c.user(), id, Role::Owner).await?;
    sqlx::query("DELETE FROM playlists WHERE id = $1")
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(Default::default())
}
